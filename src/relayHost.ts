import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { loadConfigFile, type HostConfig } from "./config.js";
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
};

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

type PlainTerminal = {
  id?: string;
  label?: string;
  cwd?: string;
  hostId?: string | null;
  rawName?: string;
  tmuxName?: string;
};

type RpcCreateWorktreeResponse = {
  session?: string;
  worktreePath?: string;
  branch?: string;
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

type RpcList = {
  sessions?: RpcSession[];
};

const execFileAsync = promisify(execFile);
const INTERNAL_SESSION_PREFIXES = ["tw-mobile-"];
const TERMINAL_SESSION_PREFIXES = ["tw-term-"];
const DEFAULT_REMOTE_WORKTREE_BASE = "~/.tmux-worktree/worktrees";
const TERMINALS_REGISTRY = `${homedir()}/.tw-dashboard-terminals.json`;
const SESSION_NAME_MAX_LEN = 20;

function parseArgs(argv: string[]): RelayHostOptions {
  let relay = process.env.TW_RELAY_URL || "";
  let hostId = process.env.TW_RELAY_HOST_ID || "mac-admin";
  let displayName = process.env.TW_RELAY_DISPLAY_NAME || `${hostname()} admin`;
  let secret = process.env.TW_RELAY_SECRET || "";
  let local = process.env.TW_SERVE_URL || "http://127.0.0.1:8311";

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

  return { relay, hostId, displayName, secret, local: local.replace(/\/+$/, "") };
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
    ...(config?.hosts ?? []).map((host) => ({
      id: host.id,
      label: host.label || host.id,
      kind: "ssh" as const,
      host,
      worktreeBase: host.worktreeBase || DEFAULT_REMOTE_WORKTREE_BASE,
      tmuxPath: host.tmuxPath,
      twPath: host.twPath,
    })),
  ];
}

function randomId(length = 5): string {
  return Math.floor(Math.random() * 16 ** length).toString(16).padStart(length, "0");
}

function readTerminalRegistry(): PlainTerminal[] {
  try {
    const parsed = JSON.parse(readFileSync(TERMINALS_REGISTRY, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is PlainTerminal => !!item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function saveTerminalRegistry(terminals: PlainTerminal[]): void {
  mkdirSync(dirname(TERMINALS_REGISTRY), { recursive: true });
  writeFileSync(TERMINALS_REGISTRY, `${JSON.stringify(terminals, null, 2)}\n`);
}

function registerDashboardTerminal(scope: AdminScope, name: string, cwd: string, label: string): void {
  const terminals = readTerminalRegistry().filter((terminal) => {
    const hostId = terminal.hostId || "local";
    const rawName = terminal.rawName || terminal.tmuxName;
    return !(hostId === scope.id && rawName === name);
  });
  terminals.push({
    id: `term-${Date.now()}-${randomId(4)}`,
    label: label || basename(cwd) || name,
    cwd,
    hostId: scope.id,
    rawName: name,
    tmuxName: name,
  });
  saveTerminalRegistry(terminals);
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

function isWorktreeCwd(cwd: string, scope: AdminScope): boolean {
  if (!cwd) return false;
  if (scope.worktreeBase) {
    const base = scope.worktreeBase.replace(/\/+$/, "");
    if (cwd === base || cwd.startsWith(`${base}/`)) return true;
    if (base.startsWith("~/") && cwd.includes(base.slice(1))) return true;
  }
  return cwd.includes("/.tmux-worktree/worktrees/");
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

function relaySession(scope: AdminScope, row: TmuxRow, kind: "worktree" | "terminal", label?: string): RelaySession {
  return {
    name: sessionKey(scope, row.name),
    rawName: row.name,
    scopeId: scope.id,
    scopeLabel: scope.label,
    kind,
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

function sshTarget(host: HostConfig): string {
  return host.user ? `${host.user}@${host.host}` : host.host;
}

function sshBaseArgs(host: HostConfig): string[] {
  const args: string[] = [];
  if (host.port) args.push("-p", String(host.port));
  if (host.identityFile) args.push("-i", host.identityFile);
  args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshTarget(host));
  return args;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sshOutput(host: HostConfig, remoteCommand: string, timeout = 8000): Promise<string> {
  const { stdout } = await execFileAsync("ssh", [...sshBaseArgs(host), remoteCommand], { timeout });
  return stdout;
}

async function remoteTmuxRows(scope: AdminScope): Promise<TmuxRow[]> {
  if (!scope.host) return [];
  const fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
  const stdout = await sshOutput(scope.host, `${remoteTmux(scope)} list-sessions -F ${shQuote(fmt)} 2>/dev/null || true`);
  return parseTmuxRows(stdout);
}

export function isRpcManagedWorktreeSession(session: RpcSession): boolean {
  if (session.kind !== "worktree" || !session.name) return false;
  return !session.profile || session.profile === "dashboard" || session.profile === "cli";
}

async function rpcSessions(scope: AdminScope): Promise<RelaySession[] | null> {
  const stdout = scope.kind === "local"
    ? (await execFileAsync("tw", ["rpc", "list"], { timeout: 5000 })).stdout
    : await sshOutput(scope.host!, `${remoteTw(scope, ["rpc", "list"])} 2>/dev/null || true`);
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout) as RpcList;
  const sessions = parsed.sessions ?? [];
  if (sessions.length === 0) return null;
  return sessions.flatMap((session): RelaySession[] => {
    if (!isRpcManagedWorktreeSession(session)) return [];
    const cwd = session.cwd || session.worktreePath || "";
    return [relaySession(scope, {
      name: session.name,
      attached: Boolean(session.attached),
      windows: Number(session.windows) || 1,
      created: Number(session.created) || 0,
      activity: Number(session.activity) || 0,
      cwd,
    }, "worktree", session.name)];
  });
}

async function dashboardTerminals(localBase: string, token: string, scope: AdminScope, seen: Set<string>): Promise<RelaySession[]> {
  let terminals: PlainTerminal[] = [];
  try {
    terminals = await fetchJson<PlainTerminal[]>(localBase, token, "/api/terminals");
  } catch {
    terminals = [];
  }
  return terminals.flatMap((terminal): RelaySession[] => {
    const tmuxName = terminal.tmuxName?.trim();
    const terminalHostId = terminal.hostId || "local";
    if (terminalHostId !== scope.id) return [];
    const rawName = (terminal.rawName || terminal.tmuxName)?.trim();
    const scopedPrefix = `${scope.id}:`;
    const normalizedRawName = rawName?.startsWith(scopedPrefix) ? rawName.slice(scopedPrefix.length) : rawName;
    if (!normalizedRawName || seen.has(normalizedRawName)) return [];
    if (!normalizedRawName || !isTerminalSession(normalizedRawName)) return [];
    seen.add(normalizedRawName);
    return [relaySession(scope, {
      name: normalizedRawName,
      attached: false,
      windows: 1,
      created: 0,
      activity: 0,
      cwd: terminal.cwd || "",
    }, "terminal", terminal.label || rawName)];
  });
}

async function listScopeSessions(scope: AdminScope, localBase: string, token: string): Promise<RelaySession[]> {
  const rpc = await rpcSessions(scope).catch(() => null);
  const rows = rpc ? [] : (scope.kind === "local" ? await localTmuxRows(scope) : await remoteTmuxRows(scope));
  const seen = new Set<string>();
  const sessions = rpc ?? [];
  for (const session of sessions) {
    if (session.rawName) seen.add(session.rawName);
  }

  for (const row of rows) {
    if (!isManagedWorktreeRow(scope, row)) continue;
    if (scope.kind === "ssh" && !(await remotePathHasGitEntry(scope, row.cwd).catch(() => false))) continue;
    seen.add(row.name);
    sessions.push(relaySession(scope, row, "worktree"));
  }

  sessions.push(...await dashboardTerminals(localBase, token, scope, seen));

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
    ? (await execFileAsync("tw", args, { timeout: 120_000 })).stdout
    : await sshOutput(scope.host!, remoteTw(scope, args), 120_000);
  const parsed = JSON.parse(stdout) as RpcCreateWorktreeResponse;
  if (!parsed.session) throw new Error("tw rpc create-worktree returned no session");
  return relaySession(scope, {
    name: parsed.session,
    attached: false,
    windows: 1,
    created: Math.floor(Date.now() / 1000),
    activity: Math.floor(Date.now() / 1000),
    cwd: parsed.worktreePath || target.path,
  }, "worktree", parsed.session);
}

async function createPlainTerminalSession(message: Extract<RelayClientMessage, { type: "create_terminal" }>): Promise<RelaySession> {
  const scope = scopeById(message.scopeId);
  const cwd = message.cwd.trim();
  if (!cwd) throw new Error("cwd required");
  const name = `tw-term-${randomId()}`;
  if (scope.kind === "local") {
    await execFileAsync(localTmuxBin(scope), ["new-session", "-d", "-s", name, "-c", cwd], { timeout: 5000 });
  } else {
    await sshOutput(scope.host!, `${remoteTmux(scope)} new-session -d -s ${shQuote(name)} -c ${shQuote(cwd)}`);
  }
  const label = message.label?.trim() || basename(cwd) || name;
  registerDashboardTerminal(scope, name, cwd, label);
  return relaySession(scope, {
    name,
    attached: false,
    windows: 1,
    created: Math.floor(Date.now() / 1000),
    activity: Math.floor(Date.now() / 1000),
    cwd,
  }, "terminal", label);
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
    stream.process.stdin.write(payload);
    return "sent";
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

async function killSession(session: string): Promise<void> {
  const { scope, rawName } = scopeForSession(session);
  if (rawName.startsWith("tw-mobile-")) throw new Error("refusing to kill internal mobile mirror session");
  if (scope.kind === "local") {
    await execFileAsync(localTmuxBin(scope), ["kill-session", "-t", `=${rawName}`], { timeout: 5000 });
    return;
  }
  await sshOutput(scope.host!, `${remoteTmux(scope)} kill-session -t ${shQuote(`=${rawName}`)}`);
}

export function remoteAttachCommand(scope: AdminScope, rawName: string, paneIndex: string): string {
  const tmux = remoteTmux(scope);
  const target = `=${rawName}`;
  const parts = [
    "set -e",
    "export TERM=xterm-256color",
    `${tmux} has-session -t ${shQuote(target)}`,
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
stdout = os.fdopen(1, 'wb', 0)
stopping = False

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
        readable, _, _ = select.select([master, 0], [], [], 1)
        if 0 in readable:
            try:
                data = os.read(0, 65536)
                if not data:
                    break
                os.write(master, data)
            except OSError:
                break
        if master in readable:
            try:
                data = os.read(master, 65536)
                if not data:
                    break
                stdout.write(data)
            except OSError:
                break
        result = os.waitpid(pid, os.WNOHANG)
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
  const sshArgs = ["ssh", "-tt", ...sshBaseArgs(scope.host!), remoteAttachCommand(scope, rawName, paneIndex)];
  const child = spawn("python3", ["-u", "-c", remotePtyPythonScript(), resizeFile, ...sshArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  });
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
      writeFileSync(resizeFile, `${safeCols},${safeRows}`);
      try { child.kill("SIGWINCH"); } catch {}
    },
  };
  streams.set(key, stream);
  child.stdout.on("data", (data) => {
    sendJson(relaySocket, { type: "terminal_data", clientId, streamId, data: data.toString("utf8") });
  });
  child.stderr.on("data", (data) => {
    const text = data.toString("utf8");
    if (isBenignSshCloseNotice(text)) return;
    sendJson(relaySocket, { type: "terminal_data", clientId, streamId, data: text });
  });
  child.on("close", (code) => {
    streams.delete(key);
    cleanup();
    sendJson(relaySocket, { type: "terminal_exit", clientId, streamId, code: code ?? 0 });
  });
  child.on("error", (err) => {
    streams.delete(key);
    cleanup();
    sendJson(relaySocket, { type: "error", clientId, streamId, message: err.message });
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
      localSocket.send(JSON.stringify({ type: "resize", cols: pendingResize.cols, rows: pendingResize.rows } satisfies RelayClientMessage));
    }
    for (const payload of stream.pending.splice(0)) localSocket.send(payload);
  });
  localSocket.on("message", (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    sendJson(relaySocket, { type: "terminal_data", clientId, streamId, data });
  });
  localSocket.on("close", () => {
    streams.delete(key);
    sendJson(relaySocket, { type: "terminal_exit", clientId, streamId, code: 0 });
  });
  localSocket.on("error", (err) => {
    streams.delete(key);
    sendJson(relaySocket, { type: "error", clientId, streamId, message: err.message });
  });
}

async function runConnection(opts: RelayHostOptions): Promise<boolean> {
  requireServeToken();

  const relaySocket = new WebSocket(relayUrl(opts), {
    headers: { Authorization: `Bearer ${opts.secret}` },
  });
  const streams = new Map<string, LocalStream>();
  let opened = false;

  await new Promise<void>((resolve, reject) => {
    relaySocket.once("open", () => {
      opened = true;
      resolve();
    });
    relaySocket.once("error", reject);
  });
  console.log(`[relay-host] connected to ${opts.relay} as ${opts.hostId}`);
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
        try {
          if (scope.kind === "local") {
            await openLocalStream(relaySocket, streams, opts.local, requireServeToken(), clientId, message.streamId, rawName, message.pane);
          } else {
            await openRemoteStream(relaySocket, streams, clientId, message.streamId, scope, rawName, message.pane);
          }
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
        await killSession(message.session);
        sendJson(relaySocket, {
          type: "session_killed",
          clientId,
          requestId: message.requestId,
          session: message.session,
        });
        return;
      }

      const key = streamKey(clientId, message.streamId);
      const stream = streams.get(key);
      if (!stream) {
        if (message.type === "resize" || message.type === "close_terminal") return;
        sendJson(relaySocket, { type: "error", clientId, streamId: message.streamId, message: "terminal stream is not open" });
        return;
      }

      if (message.type === "terminal_input") {
        if (sendToStream(stream, message.data) === "closed") {
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
        const resize = JSON.stringify({ type: "resize", cols: message.cols, rows: message.rows } satisfies RelayClientMessage);
        if (sendToStream(stream, resize) === "closed") {
          sendJson(relaySocket, { type: "error", clientId, streamId: message.streamId, message: "terminal stream is not open" });
        }
      } else if (message.type === "close_terminal") {
        streams.delete(key);
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
  while (true) {
    try {
      const opened = await runConnection(opts);
      delay = opened ? 1000 : Math.min(delay * 2, 15_000);
    } catch (err) {
      console.error(`[relay-host] ${err instanceof Error ? err.message : String(err)}`);
      delay = Math.min(delay * 2, 15_000);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
