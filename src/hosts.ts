import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_PATH,
  expandHomePath,
  loadConfigFile,
  normalizeConfig,
  type HostConfig,
} from "./config";
import { CliError } from "./tmux";

const CONFIG_LOCK_PATH = `${CONFIG_PATH}.lock`;
const CONFIG_LOCK_OWNER_FILE = "owner.json";
const CONFIG_LOCK_STALE_MS = 60_000;
const SSH_CONNECT_TIMEOUT_SECONDS = 5;
const SSH_COMMAND_TIMEOUT_MS = 15_000;
const SSH_CONTROL_PERSIST_SECONDS = 600;

type JsonObject = Record<string, unknown>;

export interface HostProbeResult {
  protocolVersion: 1;
  kind: "host-probe";
  hostId: string;
  ssh: {
    reachable: boolean;
    latencyMs?: number;
    error?: string;
  };
  tmux: {
    available: boolean;
    version?: string;
    error?: string;
  };
  tw: {
    available: boolean;
    version?: string;
    protocolVersion?: number;
    capabilities: string[];
    compatible: boolean;
    error?: string;
  };
}

interface CommandResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ConfigFileLock {
  path: string;
  owner: string;
}

interface ConfigLockOwnerRecord {
  owner: string;
  createdAt: number;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sleepSync(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, CONFIG_LOCK_OWNER_FILE);
}

function readConfigLockOwner(lockPath: string): ConfigLockOwnerRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockOwnerPath(lockPath), "utf8")) as unknown;
    if (!isObject(parsed) || typeof parsed.owner !== "string" || typeof parsed.createdAt !== "number") {
      return undefined;
    }
    return { owner: parsed.owner, createdAt: parsed.createdAt };
  } catch {
    return undefined;
  }
}

function configLockIsStale(lockPath: string): boolean {
  const owner = readConfigLockOwner(lockPath);
  if (owner) return Date.now() - owner.createdAt > CONFIG_LOCK_STALE_MS;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > CONFIG_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export function acquireConfigFileLock(lockPath = CONFIG_LOCK_PATH): ConfigFileLock {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  const owner = `${process.pid}-${randomUUID()}`;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(
          lockOwnerPath(lockPath),
          `${JSON.stringify({ owner, createdAt: Date.now() } satisfies ConfigLockOwnerRecord)}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { path: lockPath, owner };
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      if (configLockIsStale(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError(`等待配置写锁超时: ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

export function releaseConfigFileLock(lock: ConfigFileLock): void {
  const current = readConfigLockOwner(lock.path);
  if (current?.owner !== lock.owner) return;
  rmSync(lock.path, { recursive: true, force: true });
}

function withConfigLock<T>(operation: () => T): T {
  const lock = acquireConfigFileLock();
  try {
    return operation();
  } finally {
    releaseConfigFileLock(lock);
  }
}

function readRawConfig(): JsonObject {
  if (!existsSync(CONFIG_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new CliError(`读取 ${CONFIG_PATH} 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new CliError(`${CONFIG_PATH} 的根节点必须是 JSON object`);
  return parsed;
}

function serializeHost(host: HostConfig): JsonObject {
  return Object.fromEntries(Object.entries({
    id: host.id,
    label: host.label || host.id,
    host: host.host,
    user: host.user,
    port: host.port,
    identityFile: host.identityFile,
    worktreeBase: host.worktreeBase,
    tmuxPath: host.tmuxPath,
    twPath: host.twPath,
  }).filter(([, value]) => value !== undefined && value !== ""));
}

function rawHostObjectsById(raw: JsonObject): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  const collection = ["hosts", "remotes", "remoteHosts"]
    .map((field) => raw[field])
    .find((value) => value !== undefined);
  const entries: Array<[string | undefined, unknown]> = Array.isArray(collection)
    ? collection.map((value) => [undefined, value])
    : isObject(collection)
      ? Object.entries(collection)
      : [];
  for (const [fallbackId, value] of entries) {
    if (!isObject(value)) continue;
    const wrapper = fallbackId
      ? { hosts: { [fallbackId]: value } }
      : { hosts: [value] };
    const host = normalizeConfig(wrapper).hosts[0];
    if (host) result.set(host.id, value);
  }
  return result;
}

const KNOWN_HOST_FIELDS = new Set([
  "id", "name", "key",
  "label", "displayName", "display_name",
  "host", "hostname", "address",
  "user", "username", "port",
  "identityFile", "identity_file", "keyFile", "key_file",
  "worktreeBase", "worktree_base", "worktreeDir", "worktreeRoot", "worktreesDir", "worktreesRoot",
  "tmuxPath", "tmux_path", "tmuxBin", "tmux_bin",
  "twPath", "tw_path", "twBin", "tw_bin",
]);

function unknownHostFields(value: JsonObject | undefined): JsonObject {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([field]) => !KNOWN_HOST_FIELDS.has(field)));
}

function writeRawConfig(config: JsonObject): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, CONFIG_PATH);
  } finally {
    rmSync(temp, { force: true });
  }
}

function configuredHosts(): HostConfig[] {
  // Validate at the config boundary so a reserved or otherwise unsafe ID can
  // never enter a Host command through a hand-edited/legacy config file.
  return (loadConfigFile()?.hosts ?? []).map(normalizeHostConfig);
}

export function validateHostId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
    throw new CliError("host id 只能包含字母、数字、点、下划线和短横线（最多 80 字符）");
  }
  if (id.toLowerCase() === "local") {
    throw new CliError("host id 'local' 是保留字，用于本机控制面");
  }
  return id;
}

function validateTarget(value: string): string {
  const host = value.trim();
  if (!host || host.startsWith("-") || host.includes("@") || /[\s\0\r\n]/.test(host)) {
    throw new CliError("host target 不能为空、不能以 '-' 开头、不能包含 user@ 前缀或空白/控制字符");
  }
  return host;
}

function validateUser(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const user = value.trim();
  if (!user) return undefined;
  if (user.startsWith("-") || /[@\s\0\r\n]/.test(user)) {
    throw new CliError("SSH user 格式无效");
  }
  return user;
}

function validatePort(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError("SSH port 必须在 1..65535");
  }
  return port;
}

function cleanPath(value: string | undefined, local: boolean, rejectLeadingDash = false): string | undefined {
  if (value === undefined) return undefined;
  const path = value.trim();
  if (!path) return undefined;
  if (/[\0\r\n]/.test(path)) throw new CliError("路径不能包含控制字符");
  if (rejectLeadingDash && path.startsWith("-")) throw new CliError("identity file 不能以 '-' 开头");
  return local ? expandHomePath(path) : path;
}

export function normalizeHostConfig(host: HostConfig): HostConfig {
  const id = validateHostId(host.id);
  return {
    id,
    label: host.label?.trim() || id,
    host: validateTarget(host.host),
    user: validateUser(host.user),
    port: validatePort(host.port),
    identityFile: cleanPath(host.identityFile, true, true),
    // These three paths are evaluated on the remote and retain `~`.
    worktreeBase: cleanPath(host.worktreeBase, false),
    tmuxPath: cleanPath(host.tmuxPath, false),
    twPath: cleanPath(host.twPath, false),
  };
}

function replaceHosts(mutator: (hosts: HostConfig[]) => HostConfig[]): HostConfig[] {
  return withConfigLock(() => {
    const raw = readRawConfig();
    // Normalize the exact snapshot protected by this lock. Re-reading through
    // loadConfigFile here could observe a different file and overwrite it
    // with mutations derived from stale raw data.
    const hosts = mutator(normalizeConfig(raw).hosts).map(normalizeHostConfig);
    const existing = rawHostObjectsById(raw);
    raw.hosts = hosts.map((host) => ({
      ...unknownHostFields(existing.get(host.id)),
      ...serializeHost(host),
    }));
    delete raw.remotes;
    delete raw.remoteHosts;
    writeRawConfig(raw);
    return hosts;
  });
}

function findHost(id: string): HostConfig {
  const normalized = validateHostId(id);
  const host = configuredHosts().find((candidate) => candidate.id === normalized);
  if (!host) throw new CliError(`未知 Host: ${normalized}`);
  return normalizeHostConfig(host);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remotePathExpression(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return '"$HOME"';
  if (trimmed.startsWith("~/")) {
    const rest = trimmed.slice(2)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("$", "\\$")
      .replaceAll("`", "\\`");
    return `"$HOME/${rest}"`;
  }
  return shellQuote(trimmed);
}

function sshControlDirectory(): string {
  const path = join(dirname(CONFIG_PATH), ".tmux-worktree", "ssh");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function sshConnectionArgs(
  host: HostConfig,
  options: {
    batch?: boolean;
    controlMaster?: "auto" | "yes" | "no";
    controlPersist?: number | false;
  } = {},
): string[] {
  const args = [
    "-o", `BatchMode=${options.batch === false ? "no" : "yes"}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", `ControlMaster=${options.controlMaster ?? "auto"}`,
    "-o", `ControlPersist=${options.controlPersist === false
      ? "no"
      : options.controlPersist ?? SSH_CONTROL_PERSIST_SECONDS}`,
    "-o", `ControlPath=${join(sshControlDirectory(), "%C")}`,
  ];
  if (host.port) args.push("-p", String(host.port));
  if (host.user) args.push("-l", host.user);
  if (host.identityFile) args.push("-i", host.identityFile);
  return args;
}

function runSsh(
  host: HostConfig,
  extraArgs: string[],
  options: {
    timeout?: number;
    batch?: boolean;
    controlMaster?: "auto" | "yes" | "no";
    controlPersist?: number | false;
  } = {},
): CommandResult {
  const result = spawnSync("ssh", [
    ...sshConnectionArgs(host, options),
    ...extraArgs,
  ], {
    encoding: "utf8",
    timeout: options.timeout ?? SSH_COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const error = result.error instanceof Error ? result.error.message : undefined;
  return {
    ok: result.status === 0 && !error,
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error,
  };
}

function remoteTwCommand(host: HostConfig, args: string[]): string {
  const prefix = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:$HOME/.kimi-code/bin"';
  const tw = remotePathExpression(host.twPath || "tw");
  const tmuxEnv = host.tmuxPath ? `TW_TMUX=${remotePathExpression(host.tmuxPath)} ` : "";
  return `${prefix}; ${tmuxEnv}${tw}${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
}

function remoteTmuxCommand(host: HostConfig, args: string[]): string {
  const prefix = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:$HOME/.kimi-code/bin"';
  const tmux = remotePathExpression(host.tmuxPath || "tmux");
  return `${prefix}; ${tmux}${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
}

function runRemoteCommand(host: HostConfig, command: string, timeout?: number): CommandResult {
  return runSsh(host, ["--", host.host, command], { timeout });
}

function resultError(result: CommandResult): string {
  return result.error || result.stderr || `ssh exited ${result.status}`;
}

export function probeHost(host: HostConfig): HostProbeResult {
  const started = Date.now();
  const ssh = runRemoteCommand(host, "true");
  const sshLatencyMs = Date.now() - started;
  if (!ssh.ok) {
    return {
      protocolVersion: 1,
      kind: "host-probe",
      hostId: host.id,
      ssh: { reachable: false, error: resultError(ssh) },
      tmux: { available: false, error: "SSH unavailable" },
      tw: { available: false, capabilities: [], compatible: false, error: "SSH unavailable" },
    };
  }

  const tmux = runRemoteCommand(host, remoteTmuxCommand(host, ["-V"]));
  const twVersion = runRemoteCommand(host, remoteTwCommand(host, ["version"]));
  const twCapabilities = twVersion.ok
    ? runRemoteCommand(host, remoteTwCommand(host, ["rpc", "capabilities"]))
    : undefined;
  let capabilities: string[] = [];
  let protocolVersion: number | undefined;
  let capabilityError: string | undefined;
  if (twCapabilities?.ok) {
    try {
      const parsed = JSON.parse(twCapabilities.stdout) as JsonObject;
      protocolVersion = typeof parsed.protocolVersion === "number" ? parsed.protocolVersion : undefined;
      capabilities = Array.isArray(parsed.capabilities)
        ? parsed.capabilities.filter((value): value is string => typeof value === "string")
        : [];
    } catch (error) {
      capabilityError = `invalid tw rpc capabilities: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (twCapabilities) {
    capabilityError = resultError(twCapabilities);
  }
  const compatible = protocolVersion === 1
    && capabilities.includes("list")
    && capabilities.includes("create-worktree")
    && capabilities.includes("create-terminal")
    && capabilities.includes("kill-session")
    && capabilities.includes("hard-timeout");
  if (!capabilityError && !compatible && twVersion.ok) {
    capabilityError = "remote tw is missing a required RPC capability";
  }
  return {
    protocolVersion: 1,
    kind: "host-probe",
    hostId: host.id,
    ssh: { reachable: true, latencyMs: sshLatencyMs },
    tmux: tmux.ok
      ? { available: true, version: tmux.stdout.split("\n")[0] }
      : { available: false, error: resultError(tmux) },
    tw: twVersion.ok
      ? {
          available: true,
          version: twVersion.stdout.split("\n")[0],
          protocolVersion,
          capabilities,
          compatible,
          ...(capabilityError ? { error: capabilityError } : {}),
        }
      : {
          available: false,
          capabilities: [],
          compatible: false,
          error: resultError(twVersion),
        },
  };
}

function optionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError(`缺少 ${args[index]} 的值`);
  }
  return value;
}

function parseHostOptions(args: string[]): { values: Record<string, string>; clears: Set<string> } {
  const values: Record<string, string> = {};
  const clears = new Set<string>();
  const names: Record<string, string> = {
    "--id": "id",
    "--label": "label",
    "--host": "host",
    "--user": "user",
    "--port": "port",
    "--identity-file": "identityFile",
    "--worktree-base": "worktreeBase",
    "--tmux-path": "tmuxPath",
    "--tw-path": "twPath",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--clear") {
      const field = optionValue(args, i);
      clears.add(names[`--${field}`] || field);
      i++;
      continue;
    }
    const name = names[arg];
    if (!name) throw new CliError(`未知 Host 选项: ${arg}`);
    values[name] = optionValue(args, i);
    i++;
  }
  return { values, clears };
}

function printHosts(hosts: HostConfig[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ protocolVersion: 1, kind: "host-catalog", hosts }));
    return;
  }
  if (hosts.length === 0) {
    console.log("未配置 SSH Host。");
    return;
  }
  for (const host of hosts) {
    const destination = `${host.user ? `${host.user}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
    console.log(`${host.id.padEnd(18)} ${String(host.label || host.id).padEnd(20)} ${destination}`);
  }
}

function printMutation(operation: string, changed: boolean, hosts: HostConfig[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ protocolVersion: 1, kind: "host-catalog", operation, changed, hosts }));
  } else {
    console.log(changed ? `Host ${operation} 完成。` : `Host ${operation} 未产生变化。`);
  }
}

function connectionOperation(host: HostConfig, operation: "connect" | "check" | "exit"): CommandResult {
  if (operation === "connect") {
    return runSsh(host, ["-M", "-N", "-f", "--", host.host], {
      controlMaster: "yes",
      timeout: SSH_COMMAND_TIMEOUT_MS,
    });
  }
  return runSsh(host, ["-O", operation, "--", host.host], {
    timeout: SSH_COMMAND_TIMEOUT_MS,
  });
}

function printConnection(host: HostConfig, state: "connected" | "disconnected", json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ protocolVersion: 1, kind: "ssh-control", hostId: host.id, state }));
  } else {
    console.log(`${host.id}: ${state}`);
  }
}

export async function hostCmd(args: string[]): Promise<void> {
  const sub = args[0] ?? "ls";
  const rest = args.slice(1);
  const json = rest.includes("--json");
  switch (sub) {
    case "ls":
    case "list":
      printHosts(configuredHosts(), json);
      return;
    case "add": {
      const { values } = parseHostOptions(rest);
      const id = validateHostId(values.id || "");
      const next = normalizeHostConfig({
        id,
        label: values.label || id,
        host: values.host || "",
        user: values.user,
        port: validatePort(values.port),
        identityFile: values.identityFile,
        worktreeBase: values.worktreeBase,
        tmuxPath: values.tmuxPath,
        twPath: values.twPath,
      });
      const hosts = replaceHosts((current) => {
        if (current.some((host) => host.id === id)) throw new CliError(`Host 已存在: ${id}`);
        return [...current, next];
      });
      printMutation("add", true, hosts, json);
      return;
    }
    case "update": {
      if (!rest[0] || rest[0].startsWith("--")) throw new CliError("用法: tw host update <id> [options]");
      const id = validateHostId(rest[0]);
      const optionArgs = rest.slice(1);
      const { values, clears } = parseHostOptions(optionArgs);
      const allowedClears = new Set(["label", "user", "port", "identityFile", "worktreeBase", "tmuxPath", "twPath"]);
      for (const field of clears) {
        if (!allowedClears.has(field)) throw new CliError(`不能清空 Host 字段: ${field}`);
      }
      let changed = false;
      const hosts = replaceHosts((current) => {
        const index = current.findIndex((host) => host.id === id);
        if (index < 0) throw new CliError(`未知 Host: ${id}`);
        const previous = normalizeHostConfig(current[index]);
        const draft: Record<string, unknown> = { ...previous };
        for (const [key, value] of Object.entries(values)) {
          if (key === "id") continue;
          draft[key] = key === "port" ? validatePort(value) : value;
        }
        for (const field of clears) draft[field] = undefined;
        const next = normalizeHostConfig(draft as unknown as HostConfig);
        changed = JSON.stringify(previous) !== JSON.stringify(next);
        const result = [...current];
        result[index] = next;
        return result;
      });
      printMutation("update", changed, hosts, json);
      return;
    }
    case "rm":
    case "remove": {
      if (!rest[0] || rest[0].startsWith("--")) throw new CliError(`用法: tw host ${sub} <id> [--json]`);
      const id = validateHostId(rest[0]);
      let changed = false;
      const hosts = replaceHosts((current) => {
        changed = current.some((host) => host.id === id);
        if (!changed) throw new CliError(`未知 Host: ${id}`);
        return current.filter((host) => host.id !== id);
      });
      printMutation("remove", changed, hosts, json);
      return;
    }
    case "probe": {
      const id = rest.find((arg) => !arg.startsWith("--"));
      const hosts = id ? [findHost(id)] : configuredHosts();
      const results = hosts.map(probeHost);
      if (json || results.length !== 1) console.log(JSON.stringify({ protocolVersion: 1, kind: "host-probes", results }));
      else console.log(JSON.stringify(results[0], null, 2));
      if (results.some((result) => !result.ssh.reachable || !result.tmux.available || !result.tw.compatible)) {
        process.exitCode = 1;
      }
      return;
    }
    case "connect":
    case "connection-status":
    case "disconnect": {
      const id = rest.find((arg) => !arg.startsWith("--"));
      if (!id) throw new CliError(`用法: tw host ${sub} <id> [--json]`);
      const host = findHost(id);
      const operation = sub === "connect" ? "connect" : sub === "disconnect" ? "exit" : "check";
      const existing = sub === "connect" ? connectionOperation(host, "check") : undefined;
      const result = existing?.ok ? existing : connectionOperation(host, operation);
      if (!result.ok) {
        if (sub === "connection-status") {
          printConnection(host, "disconnected", json);
          process.exitCode = 1;
          return;
        }
        if (sub === "disconnect" && /no such file|control socket connect|not found/i.test(resultError(result))) {
          printConnection(host, "disconnected", json);
          return;
        }
        throw new CliError(`${sub} ${host.id} 失败: ${resultError(result)}`);
      }
      printConnection(host, sub === "disconnect" ? "disconnected" : "connected", json);
      return;
    }
    case "rpc": {
      const id = rest[0];
      if (!id || rest.length < 2) throw new CliError("用法: tw host rpc <id> <rpc-command> [args...]");
      const host = findHost(id);
      const result = runRemoteCommand(host, remoteTwCommand(host, ["rpc", ...rest.slice(1)]), 120_000);
      if (!result.ok) throw new CliError(`remote tw rpc 失败: ${resultError(result)}`);
      console.log(result.stdout);
      return;
    }
    case "attach": {
      const allowedFlags = new Set(["--take-over", "--privileged-bypass"]);
      const unknownFlag = rest.find((arg) => arg.startsWith("-") && !allowedFlags.has(arg));
      if (unknownFlag) throw new CliError(`未知 host attach 选项: ${unknownFlag}`);
      const positional = rest.filter((arg) => !arg.startsWith("-"));
      const [id, session, extra] = positional;
      if (!id || !session || extra) {
        throw new CliError("用法: tw host attach <id> <session> [--take-over|--privileged-bypass]");
      }
      const host = findHost(id);
      const privilegedBypass = rest.includes("--privileged-bypass");
      const takeover = rest.includes("--take-over");
      if (privilegedBypass && takeover) {
        throw new CliError("--take-over 与 --privileged-bypass 不能同时使用");
      }

      let command: string;
      if (privilegedBypass) {
        console.error("警告: --privileged-bypass 直接连接远程 tmux，不受 TW input ownership lease 保护。");
        command = remoteTmuxCommand(host, ["attach-session", "-t", `=${session}`]);
      } else {
        const probe = probeHost(host);
        if (!probe.ssh.reachable) {
          throw new CliError(`远程 Host ${host.id} 不可达: ${probe.ssh.error || "SSH unavailable"}`);
        }
        if (!probe.tw.available || !probe.tw.compatible) {
          throw new CliError(
            `远程 Host ${host.id} 缺少兼容 tw，拒绝绕过 terminal-control attach: ${probe.tw.error || "upgrade remote tw"}`,
          );
        }
        const control = runRemoteCommand(
          host,
          remoteTwCommand(host, ["terminal-control", "resolve", session]),
        );
        if (!control.ok) {
          throw new CliError(
            `远程 Host ${host.id} 没有可用的 terminal-control authority，拒绝回退到 direct tmux: ${resultError(control)}`,
          );
        }
        command = remoteTwCommand(host, [
          "attach",
          session,
          ...(takeover ? ["--take-over"] : []),
        ]);
      }
      const result = spawnSync("ssh", [
        ...sshConnectionArgs(host, { batch: false }),
        "-tt",
        "--",
        host.host,
        command,
      ], { stdio: "inherit" });
      process.exitCode = result.status ?? 1;
      return;
    }
    default:
      throw new CliError(`未知 host 命令: ${sub}`);
  }
}
