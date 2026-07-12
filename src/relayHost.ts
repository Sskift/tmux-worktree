import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { loadConfigFile, type HostConfig } from "./config.js";
import {
  acquireConfigFileLock,
  normalizeHostConfig,
  releaseConfigFileLock,
  sshConnectionArgs,
} from "./hosts.js";
import { CliError, tmuxBin } from "./tmux.js";
import {
  isValidHostId,
  parseJsonMessage,
  sendJson,
  type RelayClientMessage,
  type RelayScopeStatus,
  type RelaySession,
  type RelayToHostMessage,
} from "./relayProtocol.js";

type RelayHostOptions = {
  relay: string;
  hostId: string;
  displayName: string;
  secret: string;
  local: string;
  statusFile: string;
};

type RelayHostConnectionState = "connecting" | "connected" | "retrying" | "stopped";

type AdminScope = {
  id: string;
  label: string;
  kind: "local" | "ssh";
  host?: HostConfig;
  worktreeBase?: string;
  tmuxPath?: string;
  twPath?: string;
};

type LocalStream = {
  clientId: string;
  streamId: string;
  socket?: WebSocket;
  process?: ChildProcessWithoutNullStreams;
  pending: string[];
  opening?: boolean;
  pendingResize?: { cols: number; rows: number };
  resize?: (cols: number, rows: number) => void;
  cleanup?: () => void;
};

type StreamRoute = {
  clientId: string;
  streamId: string;
  scope: AdminScope;
  rawName: string;
  pane?: string | number;
};

export type PlainTerminal = {
  id?: string;
  label?: string;
  cwd?: string;
  hostId?: string | null;
  rawName?: string;
  tmuxName?: string;
  managed?: boolean;
};

type RpcCreateWorktreeResponse = {
  protocolVersion: 1;
  kind: "worktree";
  session: string;
  worktreePath: string;
  branch?: string;
};

type RpcCreateTerminalResponse = {
  protocolVersion: 1;
  kind: "terminal";
  session: string;
  cwd: string;
};

type RpcKillSessionResponse = {
  protocolVersion: 1;
  kind: "session-killed";
  session: string;
  sessionKind: "worktree" | "terminal";
  killed: boolean;
};

type TmuxRow = {
  name: string;
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
  cwd: string;
};

type RpcSession = {
  name?: string;
  kind?: string;
  profile?: string;
  project?: string;
  worktreePath?: string;
  cwd?: string;
  attached?: boolean;
  windows?: number;
  created?: number;
  activity?: number;
};

type TerminalRegistryWriteOperations = {
  mkdir: (path: string) => void;
  write: (path: string, contents: string) => void;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
};

const execFileAsync = promisify(execFile);
const INTERNAL_SESSION_PREFIXES = ["tw-mobile-"];
const TERMINAL_SESSION_PREFIXES = ["tw-term-"];
const DEFAULT_REMOTE_WORKTREE_BASE = "~/.tmux-worktree/worktrees";
const LEGACY_DEFAULT_WORKTREE_BASE = "/private/tmp/tmux-worktree/projects";
const TERMINALS_REGISTRY = `${homedir()}/.tw-dashboard-terminals.json`;
const SESSION_NAME_MAX_LEN = 20;
const RPC_PROTOCOL_VERSION = 1;
const MANAGED_TERMINAL_NAME = /^tw-term-[A-Za-z0-9][A-Za-z0-9._-]{0,71}$/;
const REMOTE_RPC_STATUS_MARKER = "__TW_RPC_STATUS__";

async function localTwOutput(args: string[], timeout: number): Promise<string> {
  const currentCli = process.argv[1];
  if (currentCli && basename(currentCli) === "cli.js" && existsSync(currentCli)) {
    return (await execFileAsync(process.execPath, [currentCli, ...args], { timeout })).stdout;
  }
  return (await execFileAsync("tw", args, { timeout })).stdout;
}

function parseArgs(argv: string[]): RelayHostOptions {
  let relay = process.env.TW_RELAY_URL || "";
  let hostId = process.env.TW_RELAY_HOST_ID || "mac-admin";
  let displayName = process.env.TW_RELAY_DISPLAY_NAME || `${hostname()} admin`;
  let secret = process.env.TW_RELAY_SECRET || "";
  let local = process.env.TW_SERVE_URL || "http://127.0.0.1:8311";
  let statusFile = process.env.TW_RELAY_STATUS_FILE || "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--relay") {
      relay = argv[++i] || "";
    } else if (arg === "--host-id") {
      hostId = argv[++i] || "";
    } else if (arg === "--display-name") {
      displayName = argv[++i] || displayName;
    } else if (arg === "--secret") {
      secret = argv[++i] || "";
    } else if (arg === "--local") {
      local = argv[++i] || local;
    } else if (arg === "--status-file") {
      statusFile = argv[++i] || "";
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new CliError(`未知 relay-host 参数: ${arg}`);
    }
  }

  if (!relay) throw new CliError("relay-host 需要 --relay 或 TW_RELAY_URL");
  if (!hostId || !isValidHostId(hostId)) throw new CliError("relay-host 需要合法 --host-id（字母、数字、点、下划线）");
  if (!secret) throw new CliError("relay-host 需要 --secret 或 TW_RELAY_SECRET");

  return { relay, hostId, displayName, secret, local: local.replace(/\/+$/, ""), statusFile };
}

function printHelp(): void {
  console.log(`tw relay-host — Mac admin connector

用法:
  TW_RELAY_SECRET=<secret> tw relay-host --relay wss://relay.example.com --host-id mac-admin

说明:
  relay-server 可以跑在一台稳定可达的 broker 机器上；relay-host 应跑在 Mac Dashboard 所在机器上。
  它按 ~/.tmux-worktree.json 聚合 local 和配置的 SSH remote scope，让 Android 看到和 Mac admin
  Dashboard 一致的 WorkTrees / Terminals，并通过这台 Mac 的 SSH 权限接入远端 tmux。`);
}

function readServeToken(): string {
  try {
    const token = readFileSync(`${homedir()}/.tw-serve-token`, "utf8").trim();
    if (token) return token;
  } catch {
  }
  return process.env.TW_TOKEN || "";
}

function requireServeToken(): string {
  const token = readServeToken();
  if (!token) throw new CliError("找不到 tw serve token。请先启动 `tw serve`，或设置 TW_TOKEN。");
  return token;
}

function relayUrl(opts: RelayHostOptions): string {
  const base = new URL(opts.relay);
  base.pathname = "/host";
  base.searchParams.set("hostId", opts.hostId);
  return base.toString();
}

function writeRelayStatus(
  opts: RelayHostOptions,
  state: RelayHostConnectionState,
  details: { error?: string; retryInMs?: number; connectedAt?: number } = {},
): void {
  if (!opts.statusFile) return;
  const status = {
    state,
    relayUrl: opts.relay,
    hostId: opts.hostId,
    updatedAt: Date.now(),
    ...(details.connectedAt ? { connectedAt: details.connectedAt } : {}),
    ...(details.retryInMs ? { retryInMs: details.retryInMs } : {}),
    ...(details.error ? { error: details.error } : {}),
  };
  const temp = `${opts.statusFile}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(opts.statusFile), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(status)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, opts.statusFile);
  } catch {
    try { unlinkSync(temp); } catch {}
  }
}

function localWsUrl(localBase: string, session: string, paneIndex: string, token: string): string {
  const url = new URL(localBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("session", session);
  url.searchParams.set("pane", paneIndex);
  url.searchParams.set("token", token);
  return url.toString();
}

async function fetchJson<T>(localBase: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${localBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`local ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function adminScopes(): AdminScope[] {
  const config = loadConfigFile();
  return [
    {
      id: "local",
      label: "local",
      kind: "local",
      worktreeBase: config?.worktreeBase,
      tmuxPath: config?.tmuxPath,
    },
    ...(config?.hosts ?? []).map((configuredHost) => {
      const host = normalizeHostConfig(configuredHost);
      return {
        id: host.id,
        label: host.label || host.id,
        kind: "ssh" as const,
        host,
        worktreeBase: host.worktreeBase || DEFAULT_REMOTE_WORKTREE_BASE,
        tmuxPath: host.tmuxPath,
        twPath: host.twPath,
      };
    }),
  ];
}

function randomId(length = 5): string {
  return Math.floor(Math.random() * 16 ** length).toString(16).padStart(length, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseTerminalRegistry(contents: string): PlainTerminal[] {
  const parsed = JSON.parse(contents) as unknown;
  if (!Array.isArray(parsed)) throw new Error("registry root must be an array");
  const invalidIndex = parsed.findIndex((item) => !isRecord(item));
  if (invalidIndex >= 0) throw new Error(`registry item ${invalidIndex} must be an object`);
  return parsed as PlainTerminal[];
}

function readTerminalRegistryForMutation(path = TERMINALS_REGISTRY): PlainTerminal[] {
  if (!existsSync(path)) return [];
  try {
    return parseTerminalRegistry(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `refusing to mutate invalid terminal registry ${path}; original file preserved: ${errorDetail(error)}`,
    );
  }
}

export function writeTerminalRegistryAtomic(
  terminals: PlainTerminal[],
  path = TERMINALS_REGISTRY,
  operations: Partial<TerminalRegistryWriteOperations> = {},
): void {
  const mkdir = operations.mkdir ?? ((target) => mkdirSync(target, { recursive: true }));
  const write = operations.write ?? ((target, contents) => {
    writeFileSync(target, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  });
  const rename = operations.rename ?? renameSync;
  const unlink = operations.unlink ?? unlinkSync;
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomId(8)}`;
  let temporaryCreated = false;

  mkdir(dirname(path));
  try {
    write(temporaryPath, `${JSON.stringify(terminals, null, 2)}\n`);
    temporaryCreated = true;
    rename(temporaryPath, path);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      try { unlink(temporaryPath); } catch {}
    }
  }
}

function saveTerminalRegistry(terminals: PlainTerminal[], path = TERMINALS_REGISTRY): void {
  writeTerminalRegistryAtomic(terminals, path);
}

export function mutateTerminalRegistry(
  mutation: (terminals: PlainTerminal[]) => PlainTerminal[],
  path = TERMINALS_REGISTRY,
): void {
  const lock = acquireConfigFileLock(`${path}.lock`);
  try {
    saveTerminalRegistry(mutation(readTerminalRegistryForMutation(path)), path);
  } finally {
    releaseConfigFileLock(lock);
  }
}

export function dashboardTerminalRecord(
  scope: Pick<AdminScope, "id" | "kind">,
  name: string,
  cwd: string,
  label: string,
): PlainTerminal {
  return {
    id: `term-${Date.now()}-${randomId(4)}`,
    label: label || basename(cwd) || name,
    cwd,
    ...(scope.kind === "ssh" ? { hostId: scope.id } : {}),
    rawName: name,
    // Dashboard uses tmuxName as the attach/existence key. Remote entries
    // therefore retain their scope instead of being checked against local tmux.
    tmuxName: scope.kind === "ssh" ? `${scope.id}:${name}` : name,
    managed: true,
  };
}

function terminalMatchesScope(terminal: PlainTerminal, scope: AdminScope, name: string): boolean {
  const hostId = terminal.hostId || "local";
  const rawName = terminal.rawName || terminal.tmuxName;
  const scopedPrefix = `${scope.id}:`;
  const normalizedRawName = rawName?.startsWith(scopedPrefix) ? rawName.slice(scopedPrefix.length) : rawName;
  return hostId === scope.id && normalizedRawName === name;
}

function registerDashboardTerminal(scope: AdminScope, name: string, cwd: string, label: string): void {
  mutateTerminalRegistry((current) => [
    ...current.filter((terminal) => !terminalMatchesScope(terminal, scope, name)),
    dashboardTerminalRecord(scope, name, cwd, label),
  ]);
}

function unregisterDashboardTerminal(scope: AdminScope, name: string): void {
  mutateTerminalRegistry((current) => current.filter((terminal) => !terminalMatchesScope(terminal, scope, name)));
}

function bestEffortUnregisterDashboardTerminal(scope: AdminScope, name: string): void {
  try {
    unregisterDashboardTerminal(scope, name);
  } catch {
    // UI metadata is never authoritative. A corrupt/busy registry is preserved,
    // while the live-tmux gate below prevents stale entries from resurfacing.
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function persistCreatedTerminalMetadata(
  persist: () => void,
  killManagedSession: () => Promise<void>,
): Promise<void> {
  try {
    persist();
  } catch (registryError) {
    try {
      await killManagedSession();
    } catch (rollbackError) {
      throw new Error(
        `failed to persist terminal registry: ${errorDetail(registryError)}; `
        + `failed to roll back TW-managed session: ${errorDetail(rollbackError)}`,
      );
    }
    throw new Error(
      `failed to persist terminal registry; TW-managed session was rolled back: ${errorDetail(registryError)}`,
    );
  }
}

export function parseRpcCreateTerminalResponse(stdout: string): RpcCreateTerminalResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`tw rpc create-terminal returned invalid JSON: ${errorDetail(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("tw rpc create-terminal returned a non-object response");
  if (parsed.protocolVersion !== RPC_PROTOCOL_VERSION) {
    throw new Error(`unsupported tw rpc protocol version: ${String(parsed.protocolVersion)}`);
  }
  if (parsed.kind !== "terminal") {
    throw new Error(`tw rpc create-terminal returned unexpected kind: ${String(parsed.kind)}`);
  }
  if (typeof parsed.session !== "string" || !MANAGED_TERMINAL_NAME.test(parsed.session)) {
    throw new Error("tw rpc create-terminal returned an invalid tw-term-* session name");
  }
  if (typeof parsed.cwd !== "string" || !parsed.cwd.trim() || parsed.cwd.includes("\0")) {
    throw new Error("tw rpc create-terminal returned an invalid cwd");
  }
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "terminal",
    session: parsed.session,
    cwd: parsed.cwd,
  };
}

export function parseRpcCreateWorktreeResponse(stdout: string): RpcCreateWorktreeResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`tw rpc create-worktree returned invalid JSON: ${errorDetail(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("tw rpc create-worktree returned a non-object response");
  if (parsed.protocolVersion !== RPC_PROTOCOL_VERSION) {
    throw new Error(`unsupported tw rpc protocol version: ${String(parsed.protocolVersion)}`);
  }
  if (parsed.kind !== "worktree") {
    throw new Error(`tw rpc create-worktree returned unexpected kind: ${String(parsed.kind)}`);
  }
  if (
    typeof parsed.session !== "string"
    || !parsed.session.trim()
    || parsed.session.length > 80
    || /[:\0-\x1f\x7f]/.test(parsed.session)
  ) {
    throw new Error("tw rpc create-worktree returned an invalid session name");
  }
  if (
    typeof parsed.worktreePath !== "string"
    || !parsed.worktreePath.trim()
    || parsed.worktreePath.includes("\0")
  ) {
    throw new Error("tw rpc create-worktree returned an invalid worktree path");
  }
  if (parsed.branch !== undefined && typeof parsed.branch !== "string") {
    throw new Error("tw rpc create-worktree returned an invalid branch");
  }
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "worktree",
    session: parsed.session,
    worktreePath: parsed.worktreePath,
    ...(typeof parsed.branch === "string" ? { branch: parsed.branch } : {}),
  };
}

export function parseDashboardTerminalPayload(value: unknown): PlainTerminal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PlainTerminal[] => {
    if (!isRecord(item)) return [];
    const textField = (field: string): string | undefined => {
      const raw = item[field];
      return typeof raw === "string" ? raw : undefined;
    };
    const rawName = textField("rawName");
    const tmuxName = textField("tmuxName");
    if (!rawName?.trim() && !tmuxName?.trim()) return [];
    const hostIdValue = item.hostId;
    if (hostIdValue !== undefined && hostIdValue !== null && typeof hostIdValue !== "string") return [];
    return [{
      ...(textField("id") !== undefined ? { id: textField("id") } : {}),
      ...(textField("label") !== undefined ? { label: textField("label") } : {}),
      ...(textField("cwd") !== undefined ? { cwd: textField("cwd") } : {}),
      ...(typeof hostIdValue === "string" || hostIdValue === null ? { hostId: hostIdValue } : {}),
      ...(rawName !== undefined ? { rawName } : {}),
      ...(tmuxName !== undefined ? { tmuxName } : {}),
      ...(typeof item.managed === "boolean" ? { managed: item.managed } : {}),
    }];
  });
}

export function liveDashboardTerminalName(
  terminal: PlainTerminal,
  scopeId: string,
  seen: ReadonlySet<string>,
  liveNames: ReadonlySet<string>,
): string | null {
  const terminalHostId = terminal.hostId || "local";
  if (terminalHostId !== scopeId) return null;
  const rawName = (terminal.rawName || terminal.tmuxName)?.trim();
  const scopedPrefix = `${scopeId}:`;
  const normalizedRawName = rawName?.startsWith(scopedPrefix) ? rawName.slice(scopedPrefix.length) : rawName;
  if (!normalizedRawName || seen.has(normalizedRawName) || !liveNames.has(normalizedRawName)) return null;
  return isTerminalSession(normalizedRawName) ? normalizedRawName : null;
}

function splitSessionKey(key: string): { scopeId: string; rawName: string } {
  const index = key.indexOf(":");
  if (index <= 0) return { scopeId: "local", rawName: key };
  return { scopeId: key.slice(0, index), rawName: key.slice(index + 1) };
}

function sessionKey(scope: AdminScope, rawName: string): string {
  return `${scope.id}:${rawName}`;
}

function isInternalSession(name: string): boolean {
  return INTERNAL_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isTerminalSession(name: string): boolean {
  return TERMINAL_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function sessionNameFromTwWorktreeDir(dirname: string): string | null {
  if (dirname.length > 6 && dirname.at(-6) === "-") {
    const suffix = dirname.slice(-5);
    if (/^[0-9a-fA-F]{5}$/.test(suffix)) return dirname.slice(0, -6);
  }
  return null;
}

function firstPathSegment(value: string): string | undefined {
  return value.split("/").find((part) => part.trim().length > 0);
}

export function projectNameFromTwWorktreePath(cwd: string, worktreeBase?: string): string | undefined {
  const normalized = cwd.trim().replace(/\/+$/, "");
  if (!normalized) return undefined;
  const baseCandidates = [];
  const base = worktreeBase?.trim().replace(/\/+$/, "");
  if (base) {
    baseCandidates.push(base);
    if (base.startsWith("~/")) baseCandidates.push(base.slice(1));
  }

  for (const candidate of baseCandidates) {
    if (!candidate) continue;
    if (normalized.startsWith(`${candidate}/`)) {
      return firstPathSegment(normalized.slice(candidate.length + 1));
    }
    const index = normalized.indexOf(`${candidate}/`);
    if (index >= 0) {
      return firstPathSegment(normalized.slice(index + candidate.length + 1));
    }
  }

  const marker = "/.tmux-worktree/worktrees/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return firstPathSegment(normalized.slice(markerIndex + marker.length));
  }
  if (normalized.startsWith(`${LEGACY_DEFAULT_WORKTREE_BASE}/`)) {
    return firstPathSegment(normalized.slice(LEGACY_DEFAULT_WORKTREE_BASE.length + 1));
  }
  return undefined;
}

function isWorktreeCwd(cwd: string, scope: AdminScope): boolean {
  if (!cwd) return false;
  if (scope.worktreeBase) {
    const base = scope.worktreeBase.replace(/\/+$/, "");
    if (cwd === base || cwd.startsWith(`${base}/`)) return true;
    if (base.startsWith("~/") && cwd.includes(base.slice(1))) return true;
  }
  return cwd.includes("/.tmux-worktree/worktrees/")
    || cwd === LEGACY_DEFAULT_WORKTREE_BASE
    || cwd.startsWith(`${LEGACY_DEFAULT_WORKTREE_BASE}/`);
}

export function isManagedWorktreeRow(scope: AdminScope, row: TmuxRow): boolean {
  if (isTerminalSession(row.name)) return false;
  if (!isWorktreeCwd(row.cwd, scope)) return false;
  if (sessionNameFromTwWorktreeDir(basename(row.cwd)) !== row.name) return false;
  return scope.kind === "local" ? existsSync(`${row.cwd}/.git`) : true;
}

async function remotePathHasGitEntry(scope: AdminScope, cwd: string): Promise<boolean> {
  if (!scope.host || !cwd) return false;
  const stdout = await sshOutput(scope.host, `test -e ${shQuote(`${cwd}/.git`)} && printf yes || true`);
  return stdout.trim() === "yes";
}

function relaySession(
  scope: AdminScope,
  row: TmuxRow,
  kind: "worktree" | "terminal",
  label?: string,
  project?: string,
  managed?: boolean,
): RelaySession {
  const inferredProject = kind === "worktree"
    ? project?.trim() || projectNameFromTwWorktreePath(row.cwd, scope.worktreeBase)
    : undefined;
  return {
    name: sessionKey(scope, row.name),
    rawName: row.name,
    scopeId: scope.id,
    scopeLabel: scope.label,
    ...(managed === undefined ? {} : { managed }),
    kind,
    project: inferredProject,
    label: label || row.name,
    cwd: row.cwd,
    attached: row.attached,
    windows: row.windows,
    created: row.created,
    activity: row.activity,
  };
}

function parseTmuxRows(stdout: string): TmuxRow[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line): TmuxRow[] => {
      const [name, attached, windows, created, activity, cwd] = line.split("\x1f");
      if (!name || isInternalSession(name)) return [];
      return [{
        name,
        attached: attached === "1",
        windows: Number(windows) || 0,
        created: Number(created) || 0,
        activity: Number(activity) || 0,
        cwd: cwd || "",
      }];
    });
}

function localTmuxBin(scope: AdminScope): string {
  return scope.tmuxPath || tmuxBin();
}

function remotePathExpr(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME/${path.slice(2).replace(/["\\$`]/g, "\\$&")}"`;
  return shQuote(path);
}

function remoteTmux(scope: AdminScope): string {
  return remotePathExpr(scope.tmuxPath || "tmux");
}

function remoteTw(scope: AdminScope, args: string[]): string {
  const env = scope.tmuxPath ? `TW_TMUX=${remotePathExpr(scope.tmuxPath)} ` : "";
  return `${env}${[remotePathExpr(scope.twPath || "tw"), ...args.map(shQuote)].join(" ")}`;
}

async function localTmuxRows(scope: AdminScope): Promise<TmuxRow[]> {
  const fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
  const { stdout } = await execFileAsync(localTmuxBin(scope), ["list-sessions", "-F", fmt], { timeout: 5000 });
  return parseTmuxRows(stdout);
}

export function relaySshConnectionArgs(host: HostConfig): string[] {
  return [...sshConnectionArgs(host), "--", host.host];
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sshOutput(host: HostConfig, remoteCommand: string, timeout = 8000): Promise<string> {
  const { stdout } = await execFileAsync("ssh", [...relaySshConnectionArgs(host), remoteCommand], { timeout });
  return stdout;
}

async function remoteTmuxRows(scope: AdminScope): Promise<TmuxRow[]> {
  if (!scope.host) return [];
  const fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
  const stdout = await sshOutput(scope.host, `${remoteTmux(scope)} list-sessions -F ${shQuote(fmt)} 2>/dev/null || true`);
  return parseTmuxRows(stdout);
}

export function isRpcManagedWorktreeSession(
  session: RpcSession,
): session is RpcSession & { kind: "worktree"; name: string } {
  if (session.kind !== "worktree" || !session.name) return false;
  return !session.profile || session.profile === "dashboard" || session.profile === "cli";
}

export function isRpcManagedTerminalSession(
  session: RpcSession,
): session is RpcSession & { kind: "terminal"; name: string } {
  if (session.kind !== "terminal" || !session.name) return false;
  return !session.profile || session.profile === "dashboard" || session.profile === "cli";
}

function commandFailureText(error: unknown): string {
  if (!isRecord(error)) return errorDetail(error);
  return [error.stderr, error.stdout, error.message]
    .flatMap((value): string[] => {
      if (typeof value === "string") return [value];
      if (Buffer.isBuffer(value)) return [value.toString("utf8")];
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

function commandExitStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

export function isUnsupportedRpcListFailure(status: number | undefined, output: string): boolean {
  if (status === undefined || status === 0) return false;
  const normalized = output.toLowerCase();
  return /\b(?:unknown|unrecognized|unsupported|invalid)\s+(?:tw\s+)?(?:subcommand|command)\b[^\n]*\brpc\b/.test(normalized)
    || /\b(?:unknown|unrecognized|unsupported)\s+rpc(?:\s+(?:subcommand|command))?\b/.test(normalized)
    || /\brpc\b\s+(?:command\s+)?(?:is\s+)?(?:unknown|unrecognized|unsupported)\b/.test(normalized)
    || /未知(?:的)?(?:子)?命令[^\n]*rpc/i.test(output);
}

export function isLegacyKillRpcFailure(status: number | undefined, output: string): boolean {
  if (status === undefined || status === 0 || status === 255) return false;
  const normalized = output.toLowerCase();
  return /session is not tw-managed/.test(normalized)
    || isUnsupportedRpcListFailure(status, output)
    || /(?:unknown|unrecognized|unsupported|invalid)[^\n]*kill-session/.test(normalized)
    || /(?:tw[^\n]*not found|command not found[^\n]*tw)/.test(normalized);
}

async function localRpcListOutput(): Promise<string | null> {
  try {
    return await localTwOutput(["rpc", "list"], 5000);
  } catch (error) {
    const output = commandFailureText(error);
    if (isUnsupportedRpcListFailure(commandExitStatus(error), output)) return null;
    throw error;
  }
}

async function remoteRpcListOutput(scope: AdminScope): Promise<string | null> {
  const command = remoteTw(scope, ["rpc", "list"]);
  const wrapped = `set +e; output=$(${command} 2>&1); status=$?; `
    + `printf '${REMOTE_RPC_STATUS_MARKER}%s\\n' "$status"; printf '%s' "$output"`;
  const response = await sshOutput(scope.host!, wrapped);
  const markerIndex = response.indexOf(REMOTE_RPC_STATUS_MARKER);
  if (markerIndex < 0) throw new Error(`remote tw rpc list returned no status marker from ${scope.id}`);
  const statusStart = markerIndex + REMOTE_RPC_STATUS_MARKER.length;
  const statusEnd = response.indexOf("\n", statusStart);
  if (statusEnd < 0) throw new Error(`remote tw rpc list returned an invalid status marker from ${scope.id}`);
  const rawStatus = response.slice(statusStart, statusEnd);
  if (!/^\d+$/.test(rawStatus)) throw new Error(`remote tw rpc list returned an invalid status from ${scope.id}`);
  const status = Number(rawStatus);
  const output = response.slice(statusEnd + 1);
  if (status === 0) return output;
  if (isUnsupportedRpcListFailure(status, output)) return null;
  throw new Error(`remote tw rpc list failed on ${scope.id}: ${output.trim() || `exit ${status}`}`);
}

async function rpcSessions(scope: AdminScope): Promise<RelaySession[] | null> {
  const stdout = scope.kind === "local"
    ? await localRpcListOutput()
    : await remoteRpcListOutput(scope);
  if (stdout === null || !stdout.trim()) return null;
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || parsed.protocolVersion !== RPC_PROTOCOL_VERSION || !Array.isArray(parsed.sessions)) {
    throw new Error(`unsupported tw rpc list response from ${scope.id}`);
  }
  const sessions = parsed.sessions as RpcSession[];
  if (sessions.length === 0) return null;
  return sessions.flatMap((session): RelaySession[] => {
    if (!isRpcManagedWorktreeSession(session) && !isRpcManagedTerminalSession(session)) return [];
    const cwd = session.cwd || session.worktreePath || "";
    return [relaySession(scope, {
      name: session.name,
      attached: Boolean(session.attached),
      windows: Number(session.windows) || 1,
      created: Number(session.created) || 0,
      activity: Number(session.activity) || 0,
      cwd,
    }, session.kind === "terminal" ? "terminal" : "worktree", session.name, session.project, true)];
  });
}

async function dashboardTerminals(
  localBase: string,
  token: string,
  scope: AdminScope,
  seen: Set<string>,
  liveNames: ReadonlySet<string>,
): Promise<RelaySession[]> {
  let terminals: PlainTerminal[] = [];
  try {
    terminals = parseDashboardTerminalPayload(await fetchJson<unknown>(localBase, token, "/api/terminals"));
  } catch {
    terminals = [];
  }
  return terminals.flatMap((terminal): RelaySession[] => {
    const normalizedRawName = liveDashboardTerminalName(terminal, scope.id, seen, liveNames);
    if (!normalizedRawName) return [];
    const rawName = terminal.rawName || terminal.tmuxName || normalizedRawName;
    seen.add(normalizedRawName);
    return [relaySession(scope, {
      name: normalizedRawName,
      attached: false,
      windows: 1,
      created: 0,
      activity: 0,
      cwd: terminal.cwd || "",
    }, "terminal", terminal.label || rawName, undefined, terminal.managed === true ? true : undefined)];
  });
}

async function listScopeSessions(scope: AdminScope, localBase: string, token: string): Promise<RelaySession[]> {
  const rpc = await rpcSessions(scope).catch(() => null);
  let rows: TmuxRow[];
  try {
    rows = scope.kind === "local" ? await localTmuxRows(scope) : await remoteTmuxRows(scope);
  } catch (error) {
    // Managed RPC state is still useful if the compatibility tmux scan fails.
    // When RPC is unavailable too, preserve the original scope failure instead
    // of publishing an authoritative-looking empty catalog.
    if (!rpc) throw error;
    rows = [];
  }
  const seen = new Set<string>();
  const sessions = rpc ?? [];
  for (const session of sessions) {
    if (session.rawName) seen.add(session.rawName);
  }

  for (const row of rows) {
    if (seen.has(row.name)) continue;
    if (!isManagedWorktreeRow(scope, row)) continue;
    if (scope.kind === "ssh" && !(await remotePathHasGitEntry(scope, row.cwd).catch(() => false))) continue;
    seen.add(row.name);
    sessions.push(relaySession(scope, row, "worktree"));
  }

  const liveNames = new Set(rows.map((row) => row.name));
  sessions.push(...await dashboardTerminals(localBase, token, scope, seen, liveNames));

  return sessions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "worktree" ? -1 : 1;
    return (b.activity || 0) - (a.activity || 0);
  });
}

async function listAdminSessions(localBase: string, token: string): Promise<RelaySession[]> {
  const results = await Promise.allSettled(adminScopes().map((scope) => listScopeSessions(scope, localBase, token)));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

async function listScopeStatuses(localBase: string, token: string): Promise<RelayScopeStatus[]> {
  const results = await Promise.allSettled(adminScopes().map(async (scope): Promise<RelayScopeStatus> => {
    const sessions = await listScopeSessions(scope, localBase, token);
    return {
      scopeId: scope.id,
      scopeLabel: scope.label,
      kind: scope.kind,
      reachable: true,
      sessionCount: sessions.length,
    };
  }));
  return adminScopes().map((scope, index) => {
    const result = results[index];
    if (result?.status === "fulfilled") return result.value;
    const error = result?.status === "rejected" ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : "unknown";
    return {
      scopeId: scope.id,
      scopeLabel: scope.label,
      kind: scope.kind,
      reachable: false,
      sessionCount: 0,
      error,
    };
  });
}

function scopeById(scopeId: string | undefined): AdminScope {
  const scopes = adminScopes();
  if (!scopeId || !scopeId.trim()) return scopes[0]!;
  const scope = scopes.find((candidate) => candidate.id === scopeId.trim());
  if (!scope) throw new Error(`unknown scope: ${scopeId}`);
  return scope;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || value === "~" || value.startsWith(".");
}

function remoteExpandHome(path: string, remoteHome: string): string {
  if (path === "~") return remoteHome;
  if (path.startsWith("~/")) return `${remoteHome}/${path.slice(2)}`;
  return path;
}

function projectPathFromRawConfig(raw: unknown, projectName: string, remoteHome?: string): string | undefined {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const projects = config.projects ?? config.repositories ?? config.repos;
  let value: unknown;
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    value = (projects as Record<string, unknown>)[projectName];
  } else if (Array.isArray(projects)) {
    value = projects.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return [record.name, record.key, record.id, record.label].some((field) => field === projectName);
    });
  }

  let path: string | undefined;
  if (typeof value === "string") {
    path = value.trim();
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const field of ["path", "dir", "directory", "root", "repo", "repoPath", "repository", "repositoryPath"]) {
      const rawPath = record[field];
      if (typeof rawPath === "string" && rawPath.trim()) {
        path = rawPath.trim();
        break;
      }
    }
  }
  if (!path) return undefined;
  return remoteHome ? remoteExpandHome(path, remoteHome) : path;
}

async function resolveWorktreeTarget(scope: AdminScope, project: string | undefined, path: string | undefined): Promise<{ projectName: string; path: string }> {
  const rawPathOrProject = (path || project || "").trim();
  if (!rawPathOrProject) throw new Error("project or path required");
  if (path?.trim() || looksLikePath(rawPathOrProject)) {
    return { projectName: (project || basename(rawPathOrProject) || "project").trim(), path: rawPathOrProject };
  }

  if (scope.kind === "local") {
    const config = loadConfigFile();
    const configured = config?.projects[rawPathOrProject]?.path;
    if (!configured) throw new Error(`project not found in local config: ${rawPathOrProject}`);
    return { projectName: rawPathOrProject, path: configured };
  }

  const [remoteHome, configText] = await Promise.all([
    sshOutput(scope.host!, "printf %s \"$HOME\"").catch(() => ""),
    sshOutput(scope.host!, "cat ~/.tmux-worktree.json 2>/dev/null || true").catch(() => ""),
  ]);
  if (configText.trim()) {
    const configured = projectPathFromRawConfig(JSON.parse(configText), rawPathOrProject, remoteHome.trim());
    if (configured) return { projectName: rawPathOrProject, path: configured };
  }
  throw new Error(`project not found on ${scope.id}: ${rawPathOrProject}. Use an absolute repo path.`);
}

function rpcCreateWorktreeArgs(scope: AdminScope, target: { projectName: string; path: string }, aiCommand: string, name?: string, branch?: string): string[] {
  const args = [
    "rpc",
    "create-worktree",
    "--path",
    target.path,
    "--project",
    target.projectName,
    "--ai-command",
    aiCommand,
  ];
  if (name?.trim()) args.push("--name", name.trim().slice(0, SESSION_NAME_MAX_LEN));
  if (branch?.trim()) args.push("--branch", branch.trim());
  if (scope.worktreeBase?.trim() && (scope.kind === "local" || scope.worktreeBase.trim() !== DEFAULT_REMOTE_WORKTREE_BASE)) {
    args.push("--worktree-base", scope.worktreeBase.trim());
  }
  return args;
}

async function createWorktreeSession(message: Extract<RelayClientMessage, { type: "create_worktree" }>): Promise<RelaySession> {
  const scope = scopeById(message.scopeId);
  const aiCommand = (message.aiCommand || message.aiCmd || "").trim();
  if (!aiCommand) throw new Error("AI command required");
  const target = await resolveWorktreeTarget(scope, message.project, message.path);
  const args = rpcCreateWorktreeArgs(scope, target, aiCommand, message.name, message.branch);
  const stdout = scope.kind === "local"
    ? await localTwOutput(args, 120_000)
    : await sshOutput(scope.host!, remoteTw(scope, args), 120_000);
  const parsed = parseRpcCreateWorktreeResponse(stdout);
  return relaySession(scope, {
    name: parsed.session,
    attached: false,
    windows: 1,
    created: Math.floor(Date.now() / 1000),
    activity: Math.floor(Date.now() / 1000),
    cwd: parsed.worktreePath || target.path,
  }, "worktree", parsed.session, target.projectName, true);
}

async function createPlainTerminalSession(message: Extract<RelayClientMessage, { type: "create_terminal" }>): Promise<RelaySession> {
  const scope = scopeById(message.scopeId);
  const cwd = message.cwd.trim();
  if (!cwd) throw new Error("cwd required");
  const args = ["rpc", "create-terminal", "--cwd", cwd];
  const aiCommand = (message.aiCommand || message.aiCmd || "").trim();
  if (aiCommand) args.push("--ai-command", aiCommand);
  const stdout = scope.kind === "local"
    ? await localTwOutput(args, 30_000)
    : await sshOutput(scope.host!, remoteTw(scope, args), 30_000);
  const parsed = parseRpcCreateTerminalResponse(stdout);
  const name = parsed.session;
  const canonicalCwd = parsed.cwd;
  const label = message.label?.trim() || basename(canonicalCwd) || name;
  await persistCreatedTerminalMetadata(
    () => registerDashboardTerminal(scope, name, canonicalCwd, label),
    () => killManagedSession(scope, name),
  );
  return relaySession(scope, {
    name,
    attached: false,
    windows: 1,
    created: Math.floor(Date.now() / 1000),
    activity: Math.floor(Date.now() / 1000),
    cwd: canonicalCwd,
  }, "terminal", label, undefined, true);
}

function streamKey(clientId: string, streamId: string): string {
  return `${clientId}\x1f${streamId}`;
}

function closeStream(stream: LocalStream): void {
  try { stream.socket?.close(); } catch {}
  try { stream.process?.kill(); } catch {}
  try { stream.cleanup?.(); } catch {}
}

function closeClientStreams(streams: Map<string, LocalStream>, clientId: string): void {
  for (const [key, stream] of streams) {
    if (stream.clientId === clientId) {
      closeStream(stream);
      streams.delete(key);
    }
  }
}

function closeClientRoutes(routes: Map<string, StreamRoute>, clientId: string): void {
  for (const [key, route] of routes) {
    if (route.clientId === clientId) routes.delete(key);
  }
}

function sendToStream(stream: LocalStream, payload: string): "sent" | "queued" | "closed" {
  if (stream.opening) {
    stream.pending.push(payload);
    return "queued";
  }

  if (stream.socket) {
    if (stream.socket.readyState === WebSocket.OPEN) {
      stream.socket.send(payload);
      return "sent";
    }
    if (stream.socket.readyState === WebSocket.CONNECTING) {
      stream.pending.push(payload);
      return "queued";
    }
    return "closed";
  }

  if (stream.process && !stream.process.killed && stream.process.stdin.writable) {
    try {
      stream.process.stdin.write(payload);
      return "sent";
    } catch {
      return "closed";
    }
  }
  return "closed";
}

function isBenignSshCloseNotice(data: string): boolean {
  return /^Connection to .+ closed\.\s*$/.test(data.trim());
}

function normalizeAgentMessage(message: string): string {
  return message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function scopeForSession(key: string): { scope: AdminScope; rawName: string } {
  const { scopeId, rawName } = splitSessionKey(key);
  const scope = adminScopes().find((candidate) => candidate.id === scopeId);
  if (!scope) throw new Error(`unknown scope: ${scopeId}`);
  if (!rawName) throw new Error("session is required");
  return { scope, rawName };
}

async function resolvePaneIndex(scope: AdminScope, rawName: string, pane: string | number | undefined): Promise<string> {
  const requested = pane === undefined ? "" : String(pane);
  const fmt = "#{pane_index}\x1f#{pane_active}";
  const stdout = scope.kind === "local"
    ? (await execFileAsync(localTmuxBin(scope), ["list-panes", "-t", `=${rawName}`, "-F", fmt], { timeout: 5000 })).stdout
    : await sshOutput(scope.host!, `${remoteTmux(scope)} list-panes -t ${shQuote(`=${rawName}`)} -F ${shQuote(fmt)}`);
  const panes = stdout
    .split("\n")
    .map((line) => {
      const [index, active] = line.trim().split("\x1f");
      return { index, active: active === "1" };
    })
    .filter((item) => item.index);
  if (requested && panes.some((item) => item.index === requested)) return requested;
  return panes.find((item) => item.active)?.index || panes[0]?.index || requested || "0";
}

async function sendAgentMessage(session: string, pane: string | number | undefined, message: string, submit: boolean): Promise<void> {
  const { scope, rawName } = scopeForSession(session);
  const paneIndex = await resolvePaneIndex(scope, rawName, pane);
  const target = `=${rawName}:.${paneIndex}`;
  if (scope.kind === "local") {
    await execFileAsync(localTmuxBin(scope), ["send-keys", "-t", target, "-l", normalizeAgentMessage(message)], { timeout: 5000 });
    if (submit) await execFileAsync(localTmuxBin(scope), ["send-keys", "-t", target, "C-m"], { timeout: 5000 });
    return;
  }

  await sshOutput(scope.host!, `${remoteTmux(scope)} send-keys -t ${shQuote(target)} -l ${shQuote(normalizeAgentMessage(message))}`);
  if (submit) await sshOutput(scope.host!, `${remoteTmux(scope)} send-keys -t ${shQuote(target)} C-m`);
}

function parseRpcKillSessionResponse(stdout: string, expectedSession: string): RpcKillSessionResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`tw rpc kill-session returned invalid JSON: ${errorDetail(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("tw rpc kill-session returned a non-object response");
  if (parsed.protocolVersion !== RPC_PROTOCOL_VERSION || parsed.kind !== "session-killed") {
    throw new Error("tw rpc kill-session returned an unsupported response");
  }
  if (parsed.session !== expectedSession) {
    throw new Error(`tw rpc kill-session returned unexpected session: ${String(parsed.session)}`);
  }
  if (parsed.sessionKind !== "worktree" && parsed.sessionKind !== "terminal") {
    throw new Error(`tw rpc kill-session returned unexpected session kind: ${String(parsed.sessionKind)}`);
  }
  if (typeof parsed.killed !== "boolean") {
    throw new Error("tw rpc kill-session returned an invalid killed status");
  }
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "session-killed",
    session: expectedSession,
    sessionKind: parsed.sessionKind,
    killed: parsed.killed,
  };
}

async function killManagedSession(scope: AdminScope, rawName: string): Promise<void> {
  const args = ["rpc", "kill-session", "--name", rawName];
  const stdout = scope.kind === "local"
    ? await localTwOutput(args, 30_000)
    : await sshOutput(scope.host!, remoteTw(scope, args), 30_000);
  parseRpcKillSessionResponse(stdout, rawName);
}

async function killLegacyTmuxSession(scope: AdminScope, rawName: string): Promise<void> {
  if (scope.kind === "local") {
    await execFileAsync(localTmuxBin(scope), ["kill-session", "-t", `=${rawName}`], { timeout: 5000 });
    return;
  }
  await sshOutput(scope.host!, `${remoteTmux(scope)} kill-session -t ${shQuote(`=${rawName}`)}`);
}

async function killSession(session: string, managedHint?: boolean): Promise<void> {
  const { scope, rawName } = scopeForSession(session);
  if (rawName.startsWith("tw-mobile-")) throw new Error("refusing to kill internal mobile mirror session");

  // New clients assert managed ownership and therefore fail closed on every
  // RPC/state error. Older clients omit the hint: try the canonical mutation
  // first and fall back only when the target explicitly proves it is a legacy
  // session or does not implement this RPC command.
  if (managedHint === true) {
    await killManagedSession(scope, rawName);
    bestEffortUnregisterDashboardTerminal(scope, rawName);
    return;
  }
  try {
    await killManagedSession(scope, rawName);
    bestEffortUnregisterDashboardTerminal(scope, rawName);
  } catch (error) {
    const output = commandFailureText(error);
    if (!isLegacyKillRpcFailure(commandExitStatus(error), output)) throw error;
    await killLegacyTmuxSession(scope, rawName);
    bestEffortUnregisterDashboardTerminal(scope, rawName);
  }
}

export function remoteAttachCommand(scope: AdminScope, rawName: string, paneIndex: string): string {
  const tmux = remoteTmux(scope);
  const target = `=${rawName}`;
  const parts = [
    "set -e",
    "export TERM=xterm-256color",
    `${tmux} has-session -t ${shQuote(target)}`,
    `${tmux} set-option -g mouse on >/dev/null 2>&1 || true`,
  ];
  if (paneIndex !== "0") parts.push(`${tmux} select-pane -t ${shQuote(`${target}:.${paneIndex}`)} 2>/dev/null || true`);
  parts.push(
    "set +e",
    `${tmux} attach-session -t ${shQuote(target)}`,
    "status=$?",
    "exit $status",
  );
  return parts.join("; ");
}

function remotePtyPythonScript(): string {
  return `
import fcntl, os, pty, select, signal, struct, sys, termios

resize_file = sys.argv[1]
ssh_args = sys.argv[2:]
if not ssh_args:
    sys.exit(2)

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(ssh_args[0], ssh_args)

os.close(slave)
fcntl.fcntl(master, fcntl.F_SETFL, fcntl.fcntl(master, fcntl.F_GETFL) | os.O_NONBLOCK)
fcntl.fcntl(0, fcntl.F_SETFL, fcntl.fcntl(0, fcntl.F_GETFL) | os.O_NONBLOCK)
stopping = False

def read_chunk(fd):
    while True:
        try:
            data = os.read(fd, 65536)
            return data if data else None
        except InterruptedError:
            continue
        except BlockingIOError:
            return b''
        except OSError:
            return None

def wait_writable(fd):
    try:
        select.select([], [fd], [], 0.05)
    except InterruptedError:
        pass
    except OSError:
        pass

def write_all(fd, data):
    offset = 0
    while offset < len(data):
        try:
            written = os.write(fd, data[offset:])
            if written <= 0:
                return False
            offset += written
        except InterruptedError:
            continue
        except BlockingIOError:
            wait_writable(fd)
        except OSError:
            return False
    return True

def apply_resize():
    try:
        with open(resize_file, 'r') as f:
            parts = f.read().strip().split(',')
        cols, rows = int(parts[0]), int(parts[1])
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass

def on_winch(signum, frame):
    apply_resize()

def on_stop(signum, frame):
    global stopping
    stopping = True

signal.signal(signal.SIGWINCH, on_winch)
signal.signal(signal.SIGTERM, on_stop)
signal.signal(signal.SIGINT, on_stop)
apply_resize()

try:
    while not stopping:
        try:
            readable, _, _ = select.select([master, 0], [], [], 1)
        except InterruptedError:
            continue
        except OSError:
            break
        if 0 in readable:
            data = read_chunk(0)
            if data is None:
                break
            if data and not write_all(master, data):
                break
        if master in readable:
            data = read_chunk(master)
            if data is None:
                break
            if data and not write_all(1, data):
                break
        try:
            result = os.waitpid(pid, os.WNOHANG)
        except InterruptedError:
            continue
        except ChildProcessError:
            break
        if result[0] != 0:
            break
except Exception:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        os.close(master)
    except Exception:
        pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    try:
        os.unlink(resize_file)
    except Exception:
        pass
`;
}

async function openRemoteStream(
  relaySocket: WebSocket,
  streams: Map<string, LocalStream>,
  clientId: string,
  streamId: string,
  scope: AdminScope,
  rawName: string,
  pane: string | number | undefined,
): Promise<void> {
  const paneIndex = await resolvePaneIndex(scope, rawName, pane);
  const key = streamKey(clientId, streamId);
  const existing = streams.get(key);
  const pending = existing?.pending.splice(0) ?? [];
  const pendingResize = existing?.pendingResize;
  const resizeFile = `${tmpdir()}/tw-relay-resize-${clientId.replace(/[^a-zA-Z0-9_-]/g, "")}-${streamId.replace(/[^a-zA-Z0-9_-]/g, "")}-${randomId(6)}`;
  const sshArgs = ["ssh", "-tt", ...relaySshConnectionArgs(scope.host!), remoteAttachCommand(scope, rawName, paneIndex)];
  const child = spawn("python3", ["-u", "-c", remotePtyPythonScript(), resizeFile, ...sshArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  });
  let lastResizeCols = 0;
  let lastResizeRows = 0;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { unlinkSync(resizeFile); } catch {}
  };
  const stream: LocalStream = {
    clientId,
    streamId,
    process: child,
    pending: [],
    cleanup,
    resize: (cols, rows) => {
      const safeCols = Math.max(20, Math.min(300, Math.floor(cols)));
      const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
      if (safeCols === lastResizeCols && safeRows === lastResizeRows) return;
      lastResizeCols = safeCols;
      lastResizeRows = safeRows;
      writeFileSync(resizeFile, `${safeCols},${safeRows}`);
      try { child.kill("SIGWINCH"); } catch {}
    },
  };
  streams.set(key, stream);
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.stdout.on("data", (data) => {
    sendJson(relaySocket, { type: "terminal_data", clientId, streamId, data: data.toString("utf8") });
  });
  child.stderr.on("data", (data) => {
    const text = data.toString("utf8");
    if (isBenignSshCloseNotice(text)) return;
    sendJson(relaySocket, { type: "terminal_data", clientId, streamId, data: text });
  });
  child.on("close", (code) => {
    const isCurrent = streams.get(key) === stream;
    if (isCurrent) streams.delete(key);
    cleanup();
    if (isCurrent) sendJson(relaySocket, { type: "terminal_exit", clientId, streamId, code: code ?? 0 });
  });
  child.on("error", (err) => {
    const isCurrent = streams.get(key) === stream;
    if (isCurrent) streams.delete(key);
    cleanup();
    if (isCurrent) sendJson(relaySocket, { type: "error", clientId, streamId, message: err.message });
  });
  if (pendingResize) stream.resize?.(pendingResize.cols, pendingResize.rows);
  for (const payload of pending) sendToStream(stream, payload);
}

async function openLocalStream(
  relaySocket: WebSocket,
  streams: Map<string, LocalStream>,
  localBase: string,
  token: string,
  clientId: string,
  streamId: string,
  rawName: string,
  pane: string | number | undefined,
): Promise<void> {
  const paneIndex = await resolvePaneIndex({ id: "local", label: "local", kind: "local" }, rawName, pane);
  const key = streamKey(clientId, streamId);
  const existing = streams.get(key);
  const pending = existing?.pending.splice(0) ?? [];
  const pendingResize = existing?.pendingResize;
  const localSocket = new WebSocket(localWsUrl(localBase, rawName, paneIndex, token));
  const stream: LocalStream = { clientId, streamId, socket: localSocket, pending };
  streams.set(key, stream);

  localSocket.on("open", () => {
    if (pendingResize) {
      localSocket.send(JSON.stringify({ type: "resize", cols: pendingResize.cols, rows: pendingResize.rows }));
    }
    for (const payload of stream.pending.splice(0)) localSocket.send(payload);
  });
  localSocket.on("message", (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    sendJson(relaySocket, { type: "terminal_data", clientId, streamId, data });
  });
  localSocket.on("close", () => {
    const isCurrent = streams.get(key) === stream;
    if (isCurrent) streams.delete(key);
    if (isCurrent) sendJson(relaySocket, { type: "terminal_exit", clientId, streamId, code: 0 });
  });
  localSocket.on("error", (err) => {
    const isCurrent = streams.get(key) === stream;
    if (isCurrent) streams.delete(key);
    if (isCurrent) sendJson(relaySocket, { type: "error", clientId, streamId, message: err.message });
  });
}

async function openRouteStream(
  relaySocket: WebSocket,
  streams: Map<string, LocalStream>,
  opts: RelayHostOptions,
  route: StreamRoute,
): Promise<void> {
  if (route.scope.kind === "local") {
    await openLocalStream(
      relaySocket,
      streams,
      opts.local,
      requireServeToken(),
      route.clientId,
      route.streamId,
      route.rawName,
      route.pane,
    );
    return;
  }
  await openRemoteStream(relaySocket, streams, route.clientId, route.streamId, route.scope, route.rawName, route.pane);
}

async function reopenRoutedStream(
  relaySocket: WebSocket,
  streams: Map<string, LocalStream>,
  opts: RelayHostOptions,
  route: StreamRoute,
  pendingInput?: string,
  pendingResize?: { cols: number; rows: number },
): Promise<void> {
  const key = streamKey(route.clientId, route.streamId);
  const existing = streams.get(key);
  if (existing?.opening) {
    if (pendingInput) existing.pending.push(pendingInput);
    if (pendingResize) existing.pendingResize = pendingResize;
    return;
  }
  if (existing) {
    closeStream(existing);
    streams.delete(key);
  }
  streams.set(key, {
    clientId: route.clientId,
    streamId: route.streamId,
    pending: pendingInput ? [pendingInput] : [],
    pendingResize,
    opening: true,
  });
  await openRouteStream(relaySocket, streams, opts, route);
}

async function runConnection(opts: RelayHostOptions): Promise<boolean> {
  requireServeToken();
  writeRelayStatus(opts, "connecting");

  const relaySocket = new WebSocket(relayUrl(opts), {
    headers: { Authorization: `Bearer ${opts.secret}` },
  });
  const streams = new Map<string, LocalStream>();
  const streamRoutes = new Map<string, StreamRoute>();
  let opened = false;

  await new Promise<void>((resolve, reject) => {
    relaySocket.once("open", () => {
      opened = true;
      resolve();
    });
    relaySocket.once("error", reject);
  });
  console.log(`[relay-host] connected to ${opts.relay} as ${opts.hostId}`);
  writeRelayStatus(opts, "connected", { connectedAt: Date.now() });
  sendJson(relaySocket, { type: "host_ready", hostId: opts.hostId, displayName: opts.displayName, version: "admin-v1" });

  relaySocket.on("message", async (raw) => {
    let message: RelayToHostMessage | ({ type: "client_closed"; clientId: string });
    try {
      message = parseJsonMessage(raw) as RelayToHostMessage | ({ type: "client_closed"; clientId: string });
    } catch {
      return;
    }

    if (message.type === "client_closed") {
      closeClientStreams(streams, message.clientId);
      closeClientRoutes(streamRoutes, message.clientId);
      return;
    }
    if (!("clientId" in message) || !message.clientId) return;

    const clientId = message.clientId;
    try {
      if (message.type === "list_sessions") {
        const sessions = await listAdminSessions(opts.local, requireServeToken());
        sendJson(relaySocket, { type: "sessions", clientId, requestId: message.requestId, sessions });
        return;
      }

      if (message.type === "list_scope_statuses") {
        const scopes = await listScopeStatuses(opts.local, requireServeToken());
        sendJson(relaySocket, { type: "scope_statuses", clientId, requestId: message.requestId, scopes });
        return;
      }

      if (message.type === "create_worktree") {
        const session = await createWorktreeSession(message);
        sendJson(relaySocket, { type: "worktree_created", clientId, requestId: message.requestId, session });
        return;
      }

      if (message.type === "create_terminal") {
        const session = await createPlainTerminalSession(message);
        sendJson(relaySocket, { type: "terminal_created", clientId, requestId: message.requestId, session });
        return;
      }

      if (message.type === "open_terminal") {
        const key = streamKey(clientId, message.streamId);
        const previous = streams.get(key);
        if (previous) {
          closeStream(previous);
          streams.delete(key);
        }
        streams.set(key, { clientId, streamId: message.streamId, pending: [], opening: true });

        const { scope, rawName } = scopeForSession(message.session);
        streamRoutes.set(key, { clientId, streamId: message.streamId, scope, rawName, pane: message.pane });
        try {
          await openRouteStream(relaySocket, streams, opts, { clientId, streamId: message.streamId, scope, rawName, pane: message.pane });
        } catch (err) {
          streams.delete(key);
          throw err;
        }
        return;
      }

      if (message.type === "send_agent_message") {
        await sendAgentMessage(message.session, message.pane, message.message, message.submit !== false);
        sendJson(relaySocket, {
          type: "agent_message_sent",
          clientId,
          requestId: message.requestId,
          session: message.session,
          pane: message.pane,
        });
        return;
      }

      if (message.type === "kill_session") {
        await killSession(message.session, message.managed);
        sendJson(relaySocket, {
          type: "session_killed",
          clientId,
          requestId: message.requestId,
          session: message.session,
        });
        return;
      }

      if (
        message.type !== "terminal_input"
        && message.type !== "resize"
        && message.type !== "close_terminal"
      ) {
        return;
      }

      const key = streamKey(clientId, message.streamId);
      const stream = streams.get(key);
      if (!stream) {
        const route = streamRoutes.get(key);
        if (route && message.type === "terminal_input") {
          await reopenRoutedStream(relaySocket, streams, opts, route, message.data);
          return;
        }
        if (route && message.type === "resize") {
          await reopenRoutedStream(relaySocket, streams, opts, route, undefined, { cols: message.cols, rows: message.rows });
          return;
        }
        if (message.type === "resize" || message.type === "close_terminal") return;
        sendJson(relaySocket, { type: "error", clientId, streamId: message.streamId, message: "terminal stream is not open" });
        return;
      }

      if (message.type === "terminal_input") {
        if (sendToStream(stream, message.data) === "closed") {
          const route = streamRoutes.get(key);
          if (route) {
            await reopenRoutedStream(relaySocket, streams, opts, route, message.data);
            return;
          }
          sendJson(relaySocket, { type: "error", clientId, streamId: message.streamId, message: "terminal stream is not open" });
        }
      } else if (message.type === "resize") {
        if (stream.opening) {
          stream.pendingResize = { cols: message.cols, rows: message.rows };
          return;
        }
        if (stream.resize) {
          stream.resize(message.cols, message.rows);
          return;
        }
        const resize = JSON.stringify({ type: "resize", cols: message.cols, rows: message.rows });
        if (sendToStream(stream, resize) === "closed") {
          const route = streamRoutes.get(key);
          if (route) {
            await reopenRoutedStream(relaySocket, streams, opts, route, undefined, { cols: message.cols, rows: message.rows });
            return;
          }
          sendJson(relaySocket, { type: "error", clientId, streamId: message.streamId, message: "terminal stream is not open" });
        }
      } else if (message.type === "close_terminal") {
        streams.delete(key);
        streamRoutes.delete(key);
        closeStream(stream);
      }
    } catch (err) {
      sendJson(relaySocket, {
        type: "error",
        clientId,
        requestId: "requestId" in message ? message.requestId : undefined,
        streamId: "streamId" in message ? message.streamId : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve) => relaySocket.once("close", resolve));
  for (const stream of streams.values()) closeStream(stream);
  console.log("[relay-host] disconnected");
  return opened;
}

export async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(3));
  let delay = 1000;
  const stop = () => {
    writeRelayStatus(opts, "stopped");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (true) {
    let retryError = "Relay connection closed";
    try {
      const opened = await runConnection(opts);
      delay = opened ? 1000 : Math.min(delay * 2, 15_000);
    } catch (err) {
      retryError = err instanceof Error ? err.message : String(err);
      console.error(`[relay-host] ${retryError}`);
      delay = Math.min(delay * 2, 15_000);
    }
    writeRelayStatus(opts, "retrying", { error: retryError, retryInMs: delay });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
