import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lookup as systemDnsLookup, promises as dnsPromises, type LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
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
  RELAY_HOST_RETIRE_CAPABILITY,
  isValidHostId,
  parseJsonMessage,
  type RelayBrokerToHostMessage,
  type RelayClientMessage,
  type RelayScopeStatus,
  type RelaySession,
  type RelayToHostMessage,
} from "./relayProtocol.js";
import {
  requestTerminalControl,
  TERMINAL_CONTROL_RENEW_INTERVAL_MS,
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  TerminalControlProtocolError,
  type TerminalControlLease,
  type TerminalControlRequest,
  type TerminalControlRequestInput,
} from "./terminalControl/index.js";

type RelayHostOptions = {
  relay: string;
  hostId: string;
  displayName: string;
  secret: string;
  local: string;
  statusFile: string;
};

type RelayHostConnectionState = "connecting" | "connected" | "retrying" | "stopping" | "stopped";

type RelayDnsResolver = Pick<InstanceType<typeof dnsPromises.Resolver>, "resolve4" | "resolve6">
  & Partial<Pick<InstanceType<typeof dnsPromises.Resolver>, "cancel">>;

type RelayLookupDependencies = {
  lookup: LookupFunction;
  platform: NodeJS.Platform;
  dnsServers: () => string[];
  createResolver: (server?: string) => RelayDnsResolver;
  fetch: typeof fetch;
  fallbackTimeoutMs: number;
};

const QUICK_TUNNEL_DOH_ENDPOINT = "https://doh.pub/dns-query";
const QUICK_TUNNEL_DNS_FALLBACK_TIMEOUT_MS = 5_000;
const MAX_QUICK_TUNNEL_DOH_RESPONSE_BYTES = 64 * 1024;

function isQuickTunnelHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const label = normalized.slice(0, -".trycloudflare.com".length);
  return normalized.endsWith(".trycloudflare.com")
    && label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
}

function isRetryableSystemDnsError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOTFOUND" || error.code === "EAI_AGAIN";
}

async function fetchQuickTunnelDnsJson(
  url: URL,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTPS DNS returned ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_QUICK_TUNNEL_DOH_RESPONSE_BYTES) {
    throw new Error("HTTPS DNS response is too large");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_QUICK_TUNNEL_DOH_RESPONSE_BYTES) {
    throw new Error("HTTPS DNS response is too large");
  }
  return JSON.parse(body) as unknown;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function resolveQuickTunnelAddressesOverHttps(
  hostname: string,
  family: 4 | 6,
  signal: AbortSignal,
  dependencies: RelayLookupDependencies,
): Promise<string[]> {
  const url = new URL(QUICK_TUNNEL_DOH_ENDPOINT);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", family === 4 ? "A" : "AAAA");
  const payload = await fetchQuickTunnelDnsJson(
    url,
    signal,
    dependencies.fetch,
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("HTTPS DNS returned an invalid response");
  }
  const response = payload as { Status?: unknown; Answer?: unknown };
  if (response.Status !== 0) {
    throw new Error("HTTPS DNS lookup failed");
  }
  if (response.Answer === undefined) return [];
  if (!Array.isArray(response.Answer)) {
    throw new Error("HTTPS DNS returned invalid answers");
  }
  const recordType = family === 4 ? 1 : 28;
  return [...new Set(response.Answer.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const answer = record as { type?: unknown; data?: unknown };
    return answer.type === recordType
      && typeof answer.data === "string"
      && isIP(answer.data) === family
      ? [answer.data]
      : [];
  }))];
}

async function resolveQuickTunnelAddresses(
  hostname: string,
  family: LookupOptions["family"],
  dependencies: RelayLookupDependencies,
): Promise<Array<{ address: string; family: number }>> {
  const families: Array<4 | 6> = family === 4 || family === "IPv4"
    ? [4]
    : family === 6 || family === "IPv6"
      ? [6]
      : [4, 6];
  const configuredServers = [...new Set(dependencies.dnsServers())];
  const servers = configuredServers.length > 0 ? configuredServers : [undefined];
  const fallbackSignal = AbortSignal.timeout(dependencies.fallbackTimeoutMs);
  const settled = await Promise.allSettled(families.map(async (candidate) => {
    const resolvers: RelayDnsResolver[] = [];
    const fetchController = new AbortController();
    const familySignal = AbortSignal.any([fallbackSignal, fetchController.signal]);
    try {
      const direct = Promise.any(servers.map(async (server) => {
        const resolver = dependencies.createResolver(server);
        resolvers.push(resolver);
        const addresses = candidate === 4
          ? await resolver.resolve4(hostname)
          : await resolver.resolve6(hostname);
        if (addresses.length === 0) throw new Error("direct DNS returned no addresses");
        return addresses;
      }));
      const addresses = await withTimeout(
        Promise.any([
          direct,
          resolveQuickTunnelAddressesOverHttps(hostname, candidate, familySignal, dependencies),
        ]),
        dependencies.fallbackTimeoutMs,
        "Quick Tunnel DNS fallback timed out",
      );
      return { family: candidate, addresses };
    } finally {
      fetchController.abort();
      for (const resolver of resolvers) {
        try { resolver.cancel?.(); } catch {}
      }
    }
  }));
  return settled.flatMap((result) => result.status === "fulfilled"
    ? result.value.addresses.map((address) => ({ address, family: result.value.family }))
    : []);
}

export function createRelayLookup(
  overrides: Partial<RelayLookupDependencies> = {},
): LookupFunction {
  const dependencies: RelayLookupDependencies = {
    lookup: overrides.lookup ?? systemDnsLookup,
    platform: overrides.platform ?? process.platform,
    dnsServers: overrides.dnsServers ?? dnsPromises.getServers,
    createResolver: overrides.createResolver ?? ((server) => {
      const resolver = new dnsPromises.Resolver();
      if (server) resolver.setServers([server]);
      return resolver;
    }),
    fetch: overrides.fetch ?? globalThis.fetch,
    fallbackTimeoutMs: overrides.fallbackTimeoutMs ?? QUICK_TUNNEL_DNS_FALLBACK_TIMEOUT_MS,
  };
  return (hostname, options, callback) => {
    dependencies.lookup(hostname, options, (error, address, family) => {
      if (!error) {
        callback(null, address, family);
        return;
      }
      if (
        dependencies.platform !== "darwin"
        || !isQuickTunnelHostname(hostname)
        || !isRetryableSystemDnsError(error)
      ) {
        callback(error, address, family);
        return;
      }
      void resolveQuickTunnelAddresses(hostname, options.family, dependencies).then((addresses) => {
        if (addresses.length === 0) {
          callback(error, address, family);
          return;
        }
        if (options.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      }, () => callback(error, address, family));
    });
  };
}

const relayLookup = createRelayLookup();

type RelayStatusOwnership = {
  instanceId: string;
  claimed: boolean;
};

type RelayConnectionLease = {
  socket: WebSocket;
  active: boolean;
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

type StreamAdmissionLedger = {
  total: number;
  local: number;
  remote: number;
  byClient: Map<string, number>;
};

type StreamAdmissionReservation = {
  ledger: StreamAdmissionLedger;
  clientId: string;
  kind: AdminScope["kind"];
  released: boolean;
};

type CommandAdmissionLedger = {
  total: number;
  byClient: Map<string, number>;
};

type CommandAdmissionReservation = {
  ledger: CommandAdmissionLedger;
  clientId: string;
  released: boolean;
};

type RelayTaskLedger = {
  active: Set<Promise<void>>;
};

type CommandExecutionContext = {
  mutation?: boolean;
  signal?: AbortSignal;
};

type CommandExecOptions = {
  input?: string;
  transactionParent?: boolean;
  timeout?: number;
  signal?: AbortSignal;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

type CommandProcessError = Error & {
  code: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
};

type LocalStream = {
  clientId: string;
  streamId: string;
  lease: RelayConnectionLease;
  route: StreamRoute;
  socket?: WebSocket;
  process?: ChildProcessWithoutNullStreams;
  pending: string[];
  pendingBytes: number;
  inputBackpressured: boolean;
  reservation: StreamAdmissionReservation;
  openTaskActive: boolean;
  resourceActive: boolean;
  opening: boolean;
  closed: boolean;
  pendingResize?: { cols: number; rows: number };
  resize?: (cols: number, rows: number) => void;
  cleanup?: () => void;
  processGroupFile?: string;
  forceCloseTimer?: ReturnType<typeof setTimeout>;
};

type StreamRoute = {
  clientId: string;
  streamId: string;
  generation: number;
  scope: AdminScope;
  rawName: string;
  pane?: string | number;
};

type RelayControlLeaseRecord = {
  key: string;
  scope: AdminScope;
  rawName: string;
  clientId: string;
  lease: TerminalControlLease;
  renewing?: Promise<void>;
};

type PendingRelayRawInput = {
  targetKey: string;
  tailToken: symbol;
  chunks: Buffer[];
  byteLength: number;
  frameCount: number;
  started: boolean;
  task: Promise<void>;
};

type RelayTerminalControl = {
  connectorId: string;
  accepting: boolean;
  closedClients: Set<string>;
  leases: Map<string, RelayControlLeaseRecord>;
  lanes: Map<string, Promise<void>>;
  laneTailTokens: Map<string, symbol>;
  pendingRawInputs: Map<string, PendingRelayRawInput>;
  nextOperation: number;
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

export function assertRpcMutationCapabilities(
  stdout: string,
  requiredCapability: "create-worktree" | "create-terminal" | "kill-session",
  scopeId: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`remote tw rpc capabilities returned invalid JSON from ${scopeId}: ${errorDetail(error)}`);
  }
  if (
    !isRecord(parsed)
    || parsed.protocolVersion !== RPC_PROTOCOL_VERSION
    || parsed.app !== "tmux-worktree"
    || !Array.isArray(parsed.capabilities)
    || parsed.capabilities.some((value) => typeof value !== "string")
  ) {
    throw new Error(`remote tw rpc capabilities returned an unsupported response from ${scopeId}`);
  }
  const capabilities = new Set(parsed.capabilities as string[]);
  if (!capabilities.has(requiredCapability) || !capabilities.has("hard-timeout")) {
    throw new Error(
      `remote tw on ${scopeId} must advertise ${requiredCapability} and hard-timeout before mutation`,
    );
  }
}

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

const INTERNAL_SESSION_PREFIXES = ["tw-mobile-"];
const TERMINAL_SESSION_PREFIXES = ["tw-term-"];
const DEFAULT_REMOTE_WORKTREE_BASE = "~/.tmux-worktree/worktrees";
const LEGACY_DEFAULT_WORKTREE_BASE = "/private/tmp/tmux-worktree/projects";
const TERMINALS_REGISTRY = `${homedir()}/.tw-dashboard-terminals.json`;
const SESSION_NAME_MAX_LEN = 20;
const RPC_PROTOCOL_VERSION = 1;
const MANAGED_TERMINAL_NAME = /^tw-term-[A-Za-z0-9][A-Za-z0-9._-]{0,71}$/;
const REMOTE_RPC_STATUS_MARKER = "__TW_RPC_STATUS__";
const LOCAL_WS_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;
const MAX_RELAY_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_RELAY_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_INPUT_BYTES_PER_STREAM = 256 * 1024;
const MAX_RELAY_RAW_INPUT_BATCH_BYTES = 4 * 1024;
const MAX_RELAY_RAW_INPUT_BATCH_FRAMES = 64;
const MAX_REMOTE_STDIN_BUFFERED_BYTES = 256 * 1024;
const MAX_LOCAL_SOCKET_BUFFERED_BYTES = 1 * 1024 * 1024;
const MAX_ACTIVE_STREAMS_PER_CLIENT = 128;
const MAX_ACTIVE_STREAMS_TOTAL = 128;
const MAX_LOCAL_STREAMS_TOTAL = 8;
const MAX_REMOTE_STREAMS_TOTAL = 32;
const REMOTE_STREAM_KILL_GRACE_MS = 1_000;
const MAX_IN_FLIGHT_COMMANDS_TOTAL = 8;
const MAX_IN_FLIGHT_COMMANDS_PER_CLIENT = 4;
const MAX_SCOPE_QUERY_CONCURRENCY = 4;
const LOCAL_HTTP_TIMEOUT_MS = 5_000;
const COMMAND_TERMINATION_GRACE_MS = 1_000;
const RELAY_SOCKET_CLOSE_GRACE_MS = 1_000;
const RELAY_SHUTDOWN_FORCE_CLOSE_MS = 5 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 1 * 1024 * 1024;
const commandAbortContext = new AsyncLocalStorage<CommandExecutionContext>();

function commandExecOptions(timeout: number): CommandExecOptions {
  const context = commandAbortContext.getStore();
  // A mutation RPC parent owns rollback after each internally bounded git/tmux
  // primitive. Killing that parent at an outer deadline can orphan the current
  // primitive and skip rollback, so terminal shutdown drains it to normal exit.
  if (context?.mutation) return { transactionParent: true };
  return context?.signal
    ? { timeout, signal: context.signal }
    : { timeout };
}

function boundedCommandExecOptions(timeout: number): CommandExecOptions {
  const context = commandAbortContext.getStore();
  return context?.signal && !context.mutation
    ? { timeout, signal: context.signal }
    : { timeout };
}

function commandFetchSignal(timeout: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const commandSignal = commandAbortContext.getStore()?.signal;
  return commandSignal
    ? AbortSignal.any([timeoutSignal, commandSignal])
    : timeoutSignal;
}

function isSafeToAbortDuringShutdown(message: RelayToHostMessage): boolean {
  return message.type !== "create_worktree"
    && message.type !== "create_terminal"
    && message.type !== "send_agent_message"
    && message.type !== "kill_session";
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function execTerminationError(
  name: "AbortError" | "TimeoutError",
  code: "ABORT_ERR" | "ETIMEDOUT",
  message: string,
): Error & { code: string; killed: boolean } {
  const error = new Error(message) as Error & { code: string; killed: boolean };
  error.name = name;
  error.code = code;
  error.killed = true;
  return error;
}

function commandProcessError(
  message: string,
  code: string | number,
  fields: Pick<CommandProcessError, "killed" | "signal"> = {},
): CommandProcessError {
  const error = new Error(message) as CommandProcessError;
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function execFileTracked(
  file: string,
  args: string[],
  options: CommandExecOptions,
): Promise<CommandOutput> {
  if (options.signal?.aborted) {
    return Promise.reject(execTerminationError("AbortError", "ABORT_ERR", `command aborted: ${file}`));
  }
  return new Promise<CommandOutput>((resolve, reject) => {
    const detached = process.platform !== "win32"
      && Boolean(options.transactionParent || options.signal || options.timeout);
    let childClosed = false;
    let callbackError: CommandProcessError | null = null;
    let terminationError: CommandProcessError | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let physicalPollTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const child = spawn(file, args, {
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = child.pid;

    const signalPhysicalCommand = (signal: NodeJS.Signals) => {
      if (pid && detached) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {}
      }
      try { child.kill(signal); } catch {}
    };

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (physicalPollTimer) clearTimeout(physicalPollTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    function finishIfQuiescent(): void {
      if (settled || !childClosed) return;
      if (terminationError && pid && detached && processGroupExists(pid)) {
        if (!physicalPollTimer) {
          physicalPollTimer = setTimeout(() => {
            physicalPollTimer = undefined;
            finishIfQuiescent();
          }, 10);
        }
        return;
      }
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      const error = terminationError || callbackError;
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    }

    const beginTermination = (error: CommandProcessError) => {
      if (terminationError || settled) return;
      terminationError = error;
      signalPhysicalCommand("SIGTERM");
      forceTimer = setTimeout(() => {
        signalPhysicalCommand("SIGKILL");
        finishIfQuiescent();
      }, COMMAND_TERMINATION_GRACE_MS);
    };

    function onAbort(): void {
      beginTermination(execTerminationError("AbortError", "ABORT_ERR", `command aborted: ${file}`));
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
        const error = commandProcessError(
          `command stdout exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes: ${file}`,
          "ENOBUFS",
          { killed: !options.transactionParent },
        );
        if (options.transactionParent) {
          callbackError ||= error;
        } else {
          beginTermination(error);
        }
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
        const error = commandProcessError(
          `command stderr exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes: ${file}`,
          "ENOBUFS",
          { killed: !options.transactionParent },
        );
        if (options.transactionParent) {
          callbackError ||= error;
        } else {
          beginTermination(error);
        }
        return;
      }
      stderrBytes += chunk.byteLength;
      stderrChunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      callbackError ||= error as CommandProcessError;
    });
    child.stdin.on("error", (error) => {
      if ((options.input?.length ?? 0) > 0) {
        callbackError ||= error as CommandProcessError;
      }
    });
    child.stdin.end(options.input ?? "");
    child.once("close", (code, signal) => {
      childClosed = true;
      if (!terminationError && !callbackError && (code !== 0 || signal)) {
        callbackError = commandProcessError(
          `command failed (${signal || code}): ${file}`,
          code ?? 1,
          { killed: Boolean(signal), signal },
        );
      }
      if (!terminationError && pid && detached && processGroupExists(pid)) {
        beginTermination(commandProcessError(
          `command left descendant processes after exit: ${file}`,
          "ECHILD",
          { killed: true },
        ));
      }
      finishIfQuiescent();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeout && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        beginTermination(execTerminationError(
          "TimeoutError",
          "ETIMEDOUT",
          `command timed out after ${options.timeout}ms: ${file}`,
        ));
      }, options.timeout);
    }
    if (options.signal?.aborted) onAbort();
  });
}

function trackRelayTask(ledger: RelayTaskLedger, task: Promise<void>): void {
  ledger.active.add(task);
  const remove = () => ledger.active.delete(task);
  void task.then(remove, remove);
}

async function drainRelayWork(
  taskLedger: RelayTaskLedger,
  admissionLedger: StreamAdmissionLedger,
  commandAdmissionLedger: CommandAdmissionLedger,
): Promise<void> {
  while (
    taskLedger.active.size > 0
    || admissionLedger.total > 0
    || commandAdmissionLedger.total > 0
  ) {
    const tasks = [...taskLedger.active];
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, 25);
      if (tasks.length > 0) void Promise.allSettled(tasks).then(finish);
    });
  }
}

async function localTwOutput(args: string[], timeout: number): Promise<string> {
  const configuredCli = process.env.TW_DASHBOARD_CLI?.trim();
  if (configuredCli && existsSync(configuredCli)) {
    return (await execFileTracked(process.execPath, [configuredCli, ...args], commandExecOptions(timeout))).stdout;
  }
  const currentCli = process.argv[1];
  if (
    currentCli &&
    ["cli.cjs", "tw-cli.cjs"].includes(basename(currentCli)) &&
    existsSync(currentCli)
  ) {
    return (await execFileTracked(process.execPath, [currentCli, ...args], commandExecOptions(timeout))).stdout;
  }
  return (await execFileTracked("tw", args, commandExecOptions(timeout))).stdout;
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
  const configured = process.env.TW_TOKEN;
  if (configured) return configured;
  try {
    const token = readFileSync(`${homedir()}/.tw-serve-token`, "utf8").trim();
    if (token) return token;
  } catch {
  }
  return "";
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
  ownership: RelayStatusOwnership,
  state: RelayHostConnectionState,
  details: { error?: string; retryInMs?: number; connectedAt?: number } = {},
  claim = false,
): boolean {
  if (!opts.statusFile) return true;
  const status = {
    state,
    relayUrl: opts.relay,
    hostId: opts.hostId,
    ownerInstanceId: ownership.instanceId,
    updatedAt: Date.now(),
    ...(details.connectedAt ? { connectedAt: details.connectedAt } : {}),
    ...(details.retryInMs ? { retryInMs: details.retryInMs } : {}),
    ...(details.error ? { error: details.error } : {}),
  };
  const temp = `${opts.statusFile}.${process.pid}.tmp`;
  let lock: ReturnType<typeof acquireConfigFileLock> | undefined;
  try {
    mkdirSync(dirname(opts.statusFile), { recursive: true });
    lock = acquireConfigFileLock(`${opts.statusFile}.lock`);
    if (!claim) {
      let currentOwner: unknown;
      try {
        const current = JSON.parse(readFileSync(opts.statusFile, "utf8")) as unknown;
        currentOwner = isRecord(current) ? current.ownerInstanceId : undefined;
      } catch {
        currentOwner = undefined;
      }
      if (currentOwner !== ownership.instanceId) return false;
    }
    writeFileSync(temp, `${JSON.stringify(status)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, opts.statusFile);
    return true;
  } catch {
    try { unlinkSync(temp); } catch {}
    return false;
  } finally {
    if (lock) releaseConfigFileLock(lock);
  }
}

function localWsUrl(localBase: string, session: string, paneIndex: string): string {
  const url = new URL(localBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("session", session);
  url.searchParams.set("pane", paneIndex);
  return url.toString();
}

async function fetchJson<T>(localBase: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${localBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: commandFetchSignal(LOCAL_HTTP_TIMEOUT_MS),
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
  const { stdout } = await execFileTracked(localTmuxBin(scope), ["list-sessions", "-F", fmt], boundedCommandExecOptions(5000));
  return parseTmuxRows(stdout);
}

export function relaySshConnectionArgs(host: HostConfig): string[] {
  return [
    ...sshConnectionArgs(host, { controlMaster: "no", controlPersist: false }),
    "--",
    host.host,
  ];
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sshOutput(
  host: HostConfig,
  remoteCommand: string,
  timeout = 8000,
  execution: { transactionParent?: boolean; input?: string } = {},
): Promise<string> {
  const baseOptions = execution.transactionParent
    ? commandExecOptions(timeout)
    : boundedCommandExecOptions(timeout);
  const options = execution.input === undefined
    ? baseOptions
    : { ...baseOptions, input: execution.input };
  const { stdout } = await execFileTracked("ssh", [...relaySshConnectionArgs(host), remoteCommand], options);
  return stdout;
}

async function requireRemoteMutationCapability(
  scope: AdminScope,
  capability: "create-worktree" | "create-terminal" | "kill-session",
): Promise<void> {
  if (scope.kind !== "ssh" || !scope.host) return;
  const stdout = await sshOutput(
    scope.host,
    remoteTw(scope, ["rpc", "capabilities"]),
    8_000,
  );
  assertRpcMutationCapabilities(stdout, capability, scope.id);
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

async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function listAdminSessions(localBase: string, token: string): Promise<RelaySession[]> {
  const scopes = adminScopes();
  const results = await mapSettledWithConcurrency(
    scopes,
    MAX_SCOPE_QUERY_CONCURRENCY,
    (scope) => listScopeSessions(scope, localBase, token),
  );
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

async function listScopeStatuses(localBase: string, token: string): Promise<RelayScopeStatus[]> {
  const scopes = adminScopes();
  const results = await mapSettledWithConcurrency(
    scopes,
    MAX_SCOPE_QUERY_CONCURRENCY,
    async (scope): Promise<RelayScopeStatus> => {
      const sessions = await listScopeSessions(scope, localBase, token);
      return {
        scopeId: scope.id,
        scopeLabel: scope.label,
        kind: scope.kind,
        reachable: true,
        sessionCount: sessions.length,
      };
    },
  );
  return scopes.map((scope, index) => {
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
  await requireRemoteMutationCapability(scope, "create-worktree");
  const stdout = scope.kind === "local"
    ? await localTwOutput(args, 120_000)
    : await sshOutput(scope.host!, remoteTw(scope, args), 120_000, { transactionParent: true });
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
  await requireRemoteMutationCapability(scope, "create-terminal");
  const stdout = scope.kind === "local"
    ? await localTwOutput(args, 30_000)
    : await sshOutput(scope.host!, remoteTw(scope, args), 30_000, { transactionParent: true });
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

function isCurrentStream(
  streams: Map<string, LocalStream>,
  key: string,
  stream: LocalStream,
): boolean {
  return stream.lease.active && !stream.closed && streams.get(key) === stream;
}

function isCurrentRoute(
  routes: Map<string, StreamRoute>,
  key: string,
  route: StreamRoute,
  lease: RelayConnectionLease,
): boolean {
  return lease.active && routes.get(key) === route;
}

function createStreamAdmissionLedger(): StreamAdmissionLedger {
  return {
    total: 0,
    local: 0,
    remote: 0,
    byClient: new Map(),
  };
}

function createCommandAdmissionLedger(): CommandAdmissionLedger {
  return { total: 0, byClient: new Map() };
}

function reserveCommandAdmission(
  ledger: CommandAdmissionLedger,
  clientId: string,
): CommandAdmissionReservation | string {
  const clientTotal = ledger.byClient.get(clientId) ?? 0;
  if (clientTotal >= MAX_IN_FLIGHT_COMMANDS_PER_CLIENT) {
    return "too many in-flight relay commands for client";
  }
  if (ledger.total >= MAX_IN_FLIGHT_COMMANDS_TOTAL) {
    return "too many in-flight relay commands on host";
  }
  ledger.total += 1;
  ledger.byClient.set(clientId, clientTotal + 1);
  return { ledger, clientId, released: false };
}

function releaseCommandAdmission(reservation: CommandAdmissionReservation): void {
  if (reservation.released) return;
  reservation.released = true;
  const { ledger } = reservation;
  ledger.total -= 1;
  const clientTotal = (ledger.byClient.get(reservation.clientId) ?? 1) - 1;
  if (clientTotal > 0) ledger.byClient.set(reservation.clientId, clientTotal);
  else ledger.byClient.delete(reservation.clientId);
}

function requiresCommandAdmission(message: RelayToHostMessage): boolean {
  return message.type === "list_sessions"
    || message.type === "list_scope_statuses"
    || message.type === "create_worktree"
    || message.type === "create_terminal"
    || message.type === "send_agent_message"
    || message.type === "kill_session";
}

function reserveStreamAdmission(
  ledger: StreamAdmissionLedger,
  clientId: string,
  scope: AdminScope,
): StreamAdmissionReservation | string {
  const clientTotal = ledger.byClient.get(clientId) ?? 0;
  if (clientTotal >= MAX_ACTIVE_STREAMS_PER_CLIENT) {
    return "too many active terminal streams for client";
  }
  if (ledger.total >= MAX_ACTIVE_STREAMS_TOTAL) {
    return "too many active terminal streams on host";
  }
  if (scope.kind === "local" && ledger.local >= MAX_LOCAL_STREAMS_TOTAL) {
    return "too many active local terminal streams";
  }
  if (scope.kind === "ssh" && ledger.remote >= MAX_REMOTE_STREAMS_TOTAL) {
    return "too many active remote terminal streams";
  }

  ledger.total += 1;
  if (scope.kind === "local") ledger.local += 1;
  else ledger.remote += 1;
  ledger.byClient.set(clientId, clientTotal + 1);
  return {
    ledger,
    clientId,
    kind: scope.kind,
    released: false,
  };
}

function releaseStreamAdmission(reservation: StreamAdmissionReservation): void {
  if (reservation.released) return;
  reservation.released = true;
  const { ledger } = reservation;
  ledger.total -= 1;
  if (reservation.kind === "local") ledger.local -= 1;
  else ledger.remote -= 1;
  const clientTotal = (ledger.byClient.get(reservation.clientId) ?? 1) - 1;
  if (clientTotal > 0) ledger.byClient.set(reservation.clientId, clientTotal);
  else ledger.byClient.delete(reservation.clientId);
}

function releaseStreamAdmissionIfQuiescent(stream: LocalStream): void {
  if (stream.openTaskActive || stream.resourceActive) return;
  releaseStreamAdmission(stream.reservation);
}

function signalRemoteProcessGroup(
  stream: LocalStream,
  signal: NodeJS.Signals,
): void {
  if (!stream.processGroupFile) return;
  try {
    const groupId = Number.parseInt(readFileSync(stream.processGroupFile, "utf8").trim(), 10);
    if (!Number.isSafeInteger(groupId) || groupId <= 1) return;
    process.kill(-groupId, signal);
  } catch {}
}

function closeStream(stream: LocalStream): void {
  if (stream.closed) return;
  stream.closed = true;
  stream.opening = false;
  stream.pending.length = 0;
  stream.pendingBytes = 0;
  stream.inputBackpressured = false;
  stream.pendingResize = undefined;
  try { stream.socket?.terminate(); } catch {}
  const childProcess = stream.process;
  signalRemoteProcessGroup(stream, "SIGTERM");
  try { childProcess?.kill("SIGTERM"); } catch {}
  if (childProcess && stream.resourceActive && !stream.forceCloseTimer) {
    stream.forceCloseTimer = setTimeout(() => {
      if (!stream.resourceActive) return;
      signalRemoteProcessGroup(stream, "SIGKILL");
      stream.forceCloseTimer = setTimeout(() => {
        stream.forceCloseTimer = undefined;
        if (!stream.resourceActive) return;
        try { childProcess.kill("SIGKILL"); } catch {}
      }, REMOTE_STREAM_KILL_GRACE_MS);
      stream.forceCloseTimer.unref();
    }, REMOTE_STREAM_KILL_GRACE_MS);
    stream.forceCloseTimer.unref();
  }
  releaseStreamAdmissionIfQuiescent(stream);
}

function finalizeStream(
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  key: string,
  stream: LocalStream,
  code: number,
  options: { error?: string; closeResource?: boolean } = {},
): void {
  const isCurrent = isCurrentStream(streams, key, stream);
  if (isCurrent) {
    streams.delete(key);
    if (routes.get(key) === stream.route) routes.delete(key);
    if (options.error) {
      sendIfActive(stream.lease, {
        type: "error",
        clientId: stream.clientId,
        streamId: stream.streamId,
        message: options.error,
      });
    }
    sendIfActive(stream.lease, {
      type: "terminal_exit",
      clientId: stream.clientId,
      streamId: stream.streamId,
      code,
    });
  }

  if (options.closeResource) {
    closeStream(stream);
    return;
  }
  stream.closed = true;
  stream.opening = false;
  stream.pending.length = 0;
  stream.pendingBytes = 0;
  stream.inputBackpressured = false;
  stream.pendingResize = undefined;
  if (stream.forceCloseTimer) {
    clearTimeout(stream.forceCloseTimer);
    stream.forceCloseTimer = undefined;
  }
  try { stream.cleanup?.(); } catch {}
  releaseStreamAdmissionIfQuiescent(stream);
}

function closeClientStreams(streams: Map<string, LocalStream>, clientId: string): void {
  for (const [key, stream] of streams) {
    if (stream.clientId === clientId) {
      streams.delete(key);
      closeStream(stream);
    }
  }
}

function closeClientRoutes(routes: Map<string, StreamRoute>, clientId: string): void {
  for (const [key, route] of routes) {
    if (route.clientId === clientId) routes.delete(key);
  }
}

function openingStream(
  lease: RelayConnectionLease,
  route: StreamRoute,
  reservation: StreamAdmissionReservation,
  pending: string[] = [],
  pendingResize?: { cols: number; rows: number },
): LocalStream {
  return {
    clientId: route.clientId,
    streamId: route.streamId,
    lease,
    route,
    pending,
    pendingBytes: pending.reduce((total, payload) => total + Buffer.byteLength(payload, "utf8"), 0),
    inputBackpressured: false,
    reservation,
    openTaskActive: false,
    resourceActive: false,
    pendingResize,
    opening: true,
    closed: false,
  };
}

function finalizeSessionStreams(
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  session: string,
): void {
  const { scopeId, rawName } = splitSessionKey(session);
  for (const [key, route] of routes) {
    if (route.scope.id !== scopeId || route.rawName !== rawName) continue;
    routes.delete(key);
    const stream = streams.get(key);
    if (!stream) continue;
    streams.delete(key);
    sendIfActive(stream.lease, {
      type: "terminal_exit",
      clientId: stream.clientId,
      streamId: stream.streamId,
      code: 0,
    });
    closeStream(stream);
  }
}

function deactivateConnection(
  lease: RelayConnectionLease,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
): void {
  if (!lease.active) return;
  lease.active = false;
  closeConnectionStreams(streams, routes);
}

function closeConnectionStreams(
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
): void {
  routes.clear();
  for (const [key, stream] of streams) {
    streams.delete(key);
    closeStream(stream);
  }
}

function sendIfActive(lease: RelayConnectionLease, message: unknown): boolean {
  if (!lease.active || lease.socket.readyState !== WebSocket.OPEN) return false;
  try {
    const payload = JSON.stringify(message);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (
      payloadBytes > MAX_RELAY_FRAME_BYTES
      || lease.socket.bufferedAmount + payloadBytes > MAX_RELAY_SOCKET_BUFFERED_BYTES
    ) {
      lease.socket.terminate();
      return false;
    }
    lease.socket.send(payload, (error) => {
      if (error) {
        try { lease.socket.terminate(); } catch {}
      }
    });
    return true;
  } catch {
    try { lease.socket.terminate(); } catch {}
    return false;
  }
}

function queuePendingInput(stream: LocalStream, payload: string): boolean {
  if (!payload) return true;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (
    payloadBytes > MAX_TERMINAL_INPUT_BYTES
    || stream.pendingBytes + payloadBytes > MAX_PENDING_INPUT_BYTES_PER_STREAM
  ) {
    return false;
  }
  stream.pending.push(payload);
  stream.pendingBytes += payloadBytes;
  return true;
}

type StreamSendResult = "sent" | "queued" | "closed" | "overloaded";

function sendToStream(stream: LocalStream, payload: string): StreamSendResult {
  if (stream.closed || !stream.lease.active) return "closed";
  if (stream.opening) {
    return queuePendingInput(stream, payload) ? "queued" : "overloaded";
  }

  if (stream.socket) {
    if (stream.socket.readyState === WebSocket.OPEN) {
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      if (
        payloadBytes > MAX_TERMINAL_INPUT_BYTES
        || stream.socket.bufferedAmount + payloadBytes > MAX_LOCAL_SOCKET_BUFFERED_BYTES
      ) {
        try { stream.socket.terminate(); } catch {}
        return "overloaded";
      }
      try {
        stream.socket.send(payload);
        return "sent";
      } catch {
        return "closed";
      }
    }
    if (stream.socket.readyState === WebSocket.CONNECTING) {
      return queuePendingInput(stream, payload) ? "queued" : "overloaded";
    }
    return "closed";
  }

  if (
    stream.process
    && stream.process.exitCode === null
    && stream.process.signalCode === null
    && stream.process.stdin.writable
  ) {
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (
      payloadBytes > MAX_TERMINAL_INPUT_BYTES
      || stream.inputBackpressured
      || stream.process.stdin.writableLength + payloadBytes > MAX_REMOTE_STDIN_BUFFERED_BYTES
    ) {
      return "overloaded";
    }
    try {
      stream.inputBackpressured = !stream.process.stdin.write(payload);
      return "sent";
    } catch {
      return "closed";
    }
  }
  return "closed";
}

function failCurrentStream(
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  key: string,
  stream: LocalStream,
  message: string,
): void {
  finalizeStream(streams, routes, key, stream, 1, {
    error: message,
    closeResource: true,
  });
}

function relayRawInputRouteKey(route: StreamRoute): string {
  return `${route.clientId}\x1f${route.streamId}\x1f${route.generation}`;
}

function isBatchableRelayRawInput(data: string): boolean {
  return data.length > 0
    && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(data);
}

function writeControlledRawInput(
  control: RelayTerminalControl,
  route: StreamRoute,
  data: string,
): Promise<void> {
  const targetKey = relayControlLeaseKey(route.clientId, route.scope, route.rawName);
  const routeKey = relayRawInputRouteKey(route);
  const bytes = Buffer.from(data, "utf8");
  const batchable = isBatchableRelayRawInput(data)
    && bytes.byteLength <= MAX_RELAY_RAW_INPUT_BATCH_BYTES;
  const pending = batchable ? control.pendingRawInputs.get(routeKey) : undefined;
  if (
    pending
    && !pending.started
    && pending.targetKey === targetKey
    && control.laneTailTokens.get(targetKey) === pending.tailToken
    && pending.frameCount < MAX_RELAY_RAW_INPUT_BATCH_FRAMES
    && pending.byteLength + bytes.byteLength <= MAX_RELAY_RAW_INPUT_BATCH_BYTES
  ) {
    pending.chunks.push(bytes);
    pending.byteLength += bytes.byteLength;
    pending.frameCount += 1;
    // The first frame owns the batch error report. Followers still wait for
    // the same terminal-control boundary, but must not fan one ownership or
    // recovery failure out into dozens of identical Relay error frames.
    return pending.task.catch(() => undefined);
  }

  const tailToken = Symbol("relay-raw-input");
  const batch = {
    targetKey,
    tailToken,
    chunks: [bytes],
    byteLength: bytes.byteLength,
    frameCount: 1,
    started: false,
    task: Promise.resolve(),
  } satisfies PendingRelayRawInput;
  batch.task = runRelayControlLane(control, targetKey, async () => {
    batch.started = true;
    if (control.pendingRawInputs.get(routeKey) === batch) {
      control.pendingRawInputs.delete(routeKey);
    }
    const payload = batch.chunks.length === 1
      ? batch.chunks[0]!
      : Buffer.concat(batch.chunks, batch.byteLength);
    await executeControlledRelayInput(
      control,
      route.clientId,
      route.scope,
      route.rawName,
      (lease, operationId) => ({
        type: "input.raw",
        lease,
        operationId,
        pane: "0",
        dataBase64: payload.toString("base64"),
      }),
      `stream:${route.streamId}:input`,
    );
  }, tailToken);
  if (batchable) control.pendingRawInputs.set(routeKey, batch);
  return batch.task;
}

function sendRelayControlError(stream: LocalStream, error: unknown): void {
  sendIfActive(stream.lease, {
    type: "error",
    clientId: stream.clientId,
    streamId: stream.streamId,
    message: relayV1ErrorMessage(error),
  });
}

async function flushPendingInputs(
  control: RelayTerminalControl,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  key: string,
  stream: LocalStream,
): Promise<boolean> {
  const pending = stream.pending.splice(0);
  stream.pendingBytes = 0;
  for (const payload of pending) {
    if (!isCurrentStream(streams, key, stream) || !isCurrentRoute(routes, key, stream.route, stream.lease)) {
      return false;
    }
    try {
      await writeControlledRawInput(control, stream.route, payload);
    } catch (error) {
      sendRelayControlError(stream, error);
    }
  }
  return true;
}

function isBenignSshCloseNotice(data: string): boolean {
  return /^Connection to .+ closed\.\s*$/.test(data.trim());
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
    ? (await execFileTracked(localTmuxBin(scope), ["list-panes", "-t", `=${rawName}`, "-F", fmt], boundedCommandExecOptions(5000))).stdout
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

function relayControlLeaseKey(clientId: string, scope: AdminScope, rawName: string): string {
  return `${clientId}\x1f${scope.id}\x1f${rawName}`;
}

function runRelayControlLane<T>(
  control: RelayTerminalControl,
  key: string,
  operation: () => Promise<T>,
  tailToken = Symbol("relay-control-lane"),
): Promise<T> {
  const previous = control.lanes.get(key) ?? Promise.resolve();
  const running = previous.catch(() => undefined).then(operation);
  const settled = running.then(() => undefined, () => undefined);
  control.lanes.set(key, settled);
  control.laneTailTokens.set(key, tailToken);
  void settled.then(() => {
    if (control.lanes.get(key) !== settled) return;
    control.lanes.delete(key);
    if (control.laneTailTokens.get(key) === tailToken) {
      control.laneTailTokens.delete(key);
    }
  });
  return running;
}

function requestWithEnvelope(input: TerminalControlRequestInput): TerminalControlRequest {
  return {
    ...input,
    protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
    requestId: randomUUID(),
  } as TerminalControlRequest;
}

async function requestScopedTerminalControl<T>(
  scope: AdminScope,
  input: TerminalControlRequestInput,
): Promise<T> {
  if (scope.kind === "local") {
    return requestTerminalControl<T>(input);
  }
  const request = requestWithEnvelope(input);
  const command = `TW_TMUX=${shQuote(scope.tmuxPath || "tmux")} ${remoteTw(scope, ["terminal-control", "request"])}`;
  const stdout = await sshOutput(scope.host!, command, 15_000, {
    input: `${JSON.stringify(request)}\n`,
  });
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`remote terminal-control returned invalid JSON: ${errorDetail(error)}`);
  }
  if (!isRecord(response) || response.protocolVersion !== TERMINAL_CONTROL_PROTOCOL_VERSION || response.requestId !== request.requestId) {
    throw new Error("remote terminal-control returned an invalid response envelope");
  }
  if (response.ok === false && isRecord(response.error)) {
    throw new TerminalControlProtocolError(
      typeof response.error.code === "string" ? response.error.code as never : "INTERNAL",
      typeof response.error.message === "string" ? response.error.message : "remote terminal-control rejected the operation",
      response.error.retryable === true,
    );
  }
  if (response.ok !== true || !Object.hasOwn(response, "result")) {
    throw new Error("remote terminal-control returned an invalid result envelope");
  }
  return response.result as T;
}

async function relayControlLease(
  control: RelayTerminalControl,
  clientId: string,
  scope: AdminScope,
  rawName: string,
): Promise<TerminalControlLease> {
  const key = relayControlLeaseKey(clientId, scope, rawName);
  let cached = control.leases.get(key);
  if (cached?.renewing) {
    await cached.renewing;
    cached = control.leases.get(key);
  }
  if (cached && relayControlLeaseNeedsRenewal(cached.lease)) {
    await renewRelayControlRecord(control, cached);
    cached = control.leases.get(key);
  }
  if (cached) return cached.lease;
  const target = await requestScopedTerminalControl<{
    controlTargetId: string;
    controlEpoch: string;
  }>(scope, { type: "target.resolve", sessionName: rawName });
  const acquired = await requestScopedTerminalControl<{ lease: TerminalControlLease }>(scope, {
    type: "lease.acquire",
    controlTargetId: target.controlTargetId,
    owner: {
      kind: "relay-v1",
      instanceId: `relay-v1:${control.connectorId}:${clientId}:${target.controlTargetId}`,
    },
  });
  const record = { key, scope, rawName, clientId, lease: acquired.lease };
  control.leases.set(key, record);
  return record.lease;
}

function nextRelayControlOperation(
  control: RelayTerminalControl,
  clientId: string,
  lane: string,
): string {
  control.nextOperation += 1;
  return `relay-v1:${control.connectorId}:${clientId}:${lane}:${control.nextOperation}`;
}

function forgetRelayControlLease(
  control: RelayTerminalControl,
  clientId: string,
  scope: AdminScope,
  rawName: string,
): void {
  control.leases.delete(relayControlLeaseKey(clientId, scope, rawName));
}

function shouldForgetControlLease(error: unknown): boolean {
  if (!(error instanceof TerminalControlProtocolError)) return true;
  return error.code !== "INVALID_REQUEST" && error.code !== "RESOURCE_EXHAUSTED";
}

function relayControlLeaseNeedsRenewal(lease: TerminalControlLease): boolean {
  const expiresAt = Date.parse(lease.expiresAt);
  return !Number.isFinite(expiresAt)
    || expiresAt - Date.now() <= TERMINAL_CONTROL_RENEW_INTERVAL_MS;
}

function relayV1ErrorMessage(error: unknown): string {
  if (
    error instanceof TerminalControlProtocolError
    && (
      (error.code === "PERMISSION_DENIED" && error.message === "terminal input is owned by feishu")
      || error.code === "HANDOFF_PENDING"
      || error.code === "RECOVERY_REQUIRED"
    )
  ) {
    return `[input-ownership:${error.code}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function executeControlledRelayInput<T>(
  control: RelayTerminalControl,
  clientId: string,
  scope: AdminScope,
  rawName: string,
  input: (
    lease: TerminalControlLease,
    operationId: string,
  ) => TerminalControlRequestInput | Promise<TerminalControlRequestInput>,
  lane: string,
): Promise<T> {
  if (!control.accepting || control.closedClients.has(clientId)) {
    throw new Error("relay client closed before terminal input was accepted");
  }
  const operationId = nextRelayControlOperation(control, clientId, lane);
  const lease = await relayControlLease(control, clientId, scope, rawName);
  const request = await input(lease, operationId);
  if (!control.accepting || control.closedClients.has(clientId)) {
    throw new Error("relay client closed before terminal input was accepted");
  }
  try {
    return await requestScopedTerminalControl<T>(scope, request);
  } catch (error) {
    if (shouldForgetControlLease(error)) {
      forgetRelayControlLease(control, clientId, scope, rawName);
    }
    // Never replay a terminal mutation here. A stale lease is forgotten so
    // the next explicit input reacquires it, while every ambiguous response
    // remains visible to the caller.
    throw error;
  }
}

function controlledRelayInput<T>(
  control: RelayTerminalControl,
  clientId: string,
  scope: AdminScope,
  rawName: string,
  input: (
    lease: TerminalControlLease,
    operationId: string,
  ) => TerminalControlRequestInput | Promise<TerminalControlRequestInput>,
  lane: string,
): Promise<T> {
  const key = relayControlLeaseKey(clientId, scope, rawName);
  return runRelayControlLane(
    control,
    key,
    () => executeControlledRelayInput(control, clientId, scope, rawName, input, lane),
  );
}

async function sendControlledAgentMessage(
  control: RelayTerminalControl,
  clientId: string,
  session: string,
  message: string,
  submit: boolean,
): Promise<void> {
  const { scope, rawName } = scopeForSession(session);
  await controlledRelayInput(
    control,
    clientId,
    scope,
    rawName,
    (lease, operationId) => ({
      type: "input.agent-message",
      lease,
      operationId,
      pane: "0",
      message,
      submit,
    }),
    "agent-message",
  );
}

async function releaseRelayControlRecord(
  control: RelayTerminalControl,
  record: RelayControlLeaseRecord,
): Promise<void> {
  await runRelayControlLane(control, record.key, async () => {
    if (control.leases.get(record.key) !== record) return;
    control.leases.delete(record.key);
    await requestScopedTerminalControl(record.scope, {
      type: "lease.release",
      lease: record.lease,
    }).catch(() => undefined);
  });
}

async function releaseRelayControlForClient(
  control: RelayTerminalControl,
  clientId: string,
): Promise<void> {
  await Promise.all(
    [...control.leases.values()]
      .filter((record) => record.clientId === clientId)
      .map((record) => releaseRelayControlRecord(control, record)),
  );
}

async function releaseAllRelayControl(control: RelayTerminalControl): Promise<void> {
  await Promise.all(
    [...control.leases.values()].map((record) => releaseRelayControlRecord(control, record)),
  );
}

function renewRelayControlRecord(
  control: RelayTerminalControl,
  record: RelayControlLeaseRecord,
): Promise<void> {
  if (record.renewing) return record.renewing;
  const lease = record.lease;
  const renewal = requestScopedTerminalControl<{ lease: TerminalControlLease }>(record.scope, {
    type: "lease.renew",
    lease,
  }).then(
    (result) => {
      if (control.leases.get(record.key) === record && record.lease.leaseId === lease.leaseId) {
        record.lease = result.lease;
      }
    },
    () => {
      if (control.leases.get(record.key) === record && record.lease.leaseId === lease.leaseId) {
        control.leases.delete(record.key);
      }
    },
  ).finally(() => {
    if (record.renewing === renewal) record.renewing = undefined;
  });
  record.renewing = renewal;
  return renewal;
}

function renewRelayControlLeases(control: RelayTerminalControl): void {
  if (!control.accepting) return;
  for (const record of control.leases.values()) {
    void renewRelayControlRecord(control, record);
  }
}

async function drainRelayControlLanes(control: RelayTerminalControl): Promise<void> {
  while (control.lanes.size > 0) {
    await Promise.all([...control.lanes.values()]);
  }
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
  await requireRemoteMutationCapability(scope, "kill-session");
  const stdout = scope.kind === "local"
    ? await localTwOutput(args, 30_000)
    : await sshOutput(scope.host!, remoteTw(scope, args), 30_000, { transactionParent: true });
  parseRpcKillSessionResponse(stdout, rawName);
}

async function killLegacyTmuxSession(scope: AdminScope, rawName: string): Promise<void> {
  if (scope.kind === "local") {
    await execFileTracked(localTmuxBin(scope), ["kill-session", "-t", `=${rawName}`], boundedCommandExecOptions(5000));
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

async function killControlledSession(
  control: RelayTerminalControl,
  clientId: string,
  session: string,
  managedHint?: boolean,
): Promise<void> {
  const { scope, rawName } = scopeForSession(session);
  try {
    await controlledRelayInput(
      control,
      clientId,
      scope,
      rawName,
      (lease, operationId) => ({ type: "lifecycle.kill", lease, operationId }),
      "lifecycle-kill",
    );
    bestEffortUnregisterDashboardTerminal(scope, rawName);
  } catch (error) {
    if (
      managedHint !== true
      && error instanceof TerminalControlProtocolError
      && error.code === "TARGET_NOT_FOUND"
    ) {
      await killSession(session, managedHint);
      return;
    }
    throw error;
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
    `${tmux} attach-session -r -f ignore-size -t ${shQuote(target)}`,
    "status=$?",
    "exit $status",
  );
  return parts.join("; ");
}

function remotePtyPythonScript(): string {
  return `
import fcntl, os, pty, select, signal, struct, sys, termios

resize_file = sys.argv[1]
pid_file = sys.argv[2]
ssh_args = sys.argv[3:]
if not ssh_args:
    sys.exit(2)

blocked_signals = {signal.SIGTERM, signal.SIGINT}
try:
    signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
except AttributeError:
    pass

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    try:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, blocked_signals)
    except AttributeError:
        pass
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(ssh_args[0], ssh_args)

os.close(slave)
try:
    pid_fd = os.open(pid_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(pid_fd, str(pid).encode('ascii'))
    os.close(pid_fd)
except Exception:
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        os.killpg(pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    raise

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
        if stopping:
            return False
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
    try:
        os.killpg(pid, signal.SIGTERM)
    except Exception:
        pass

signal.signal(signal.SIGWINCH, on_winch)
signal.signal(signal.SIGTERM, on_stop)
signal.signal(signal.SIGINT, on_stop)
try:
    signal.pthread_sigmask(signal.SIG_UNBLOCK, blocked_signals)
except AttributeError:
    pass
apply_resize()

try:
    while not stopping:
        try:
            readable, _, _ = select.select([master, 0], [], [], 0.25)
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
except Exception:
    pass
finally:
    try:
        os.killpg(pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        os.close(master)
    except Exception:
        pass
    try:
        os.killpg(pid, signal.SIGKILL)
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
    try:
        os.unlink(pid_file)
    except Exception:
        pass
`;
}

async function openRemoteStream(
  control: RelayTerminalControl,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  stream: LocalStream,
): Promise<void> {
  const { route } = stream;
  const { clientId, streamId, scope, rawName, pane } = route;
  const key = streamKey(clientId, streamId);
  const paneIndex = await resolvePaneIndex(scope, rawName, pane);
  if (!isCurrentStream(streams, key, stream)) return;

  const sshArgs = ["ssh", "-tt", ...relaySshConnectionArgs(scope.host!), remoteAttachCommand(scope, rawName, paneIndex)];
  const controlDir = mkdtempSync(join(tmpdir(), "tw-relay-stream-"));
  const resizeFile = join(controlDir, "resize");
  const processGroupFile = join(controlDir, "process-group");
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("python3", ["-u", "-c", remotePtyPythonScript(), resizeFile, processGroupFile, ...sshArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (error) {
    rmSync(controlDir, { recursive: true, force: true });
    throw error;
  }
  stream.resourceActive = true;
  let lastResizeCols = 0;
  let lastResizeRows = 0;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(controlDir, { recursive: true, force: true });
  };
  stream.process = child;
  stream.processGroupFile = processGroupFile;
  stream.cleanup = cleanup;
  stream.resize = (cols, rows) => {
    const safeCols = Math.max(20, Math.min(300, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
    if (safeCols === lastResizeCols && safeRows === lastResizeRows) return;
    lastResizeCols = safeCols;
    lastResizeRows = safeRows;
    writeFileSync(resizeFile, `${safeCols},${safeRows}`);
    try { child.kill("SIGWINCH"); } catch {}
  };
  stream.opening = false;
  child.stdin.on("error", () => {});
  child.stdin.on("drain", () => {
    if (isCurrentStream(streams, key, stream)) stream.inputBackpressured = false;
  });
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.stdout.on("data", (data) => {
    if (!isCurrentStream(streams, key, stream)) return;
    sendIfActive(stream.lease, { type: "terminal_data", clientId, streamId, data: data.toString("utf8") });
  });
  child.stderr.on("data", (data) => {
    if (!isCurrentStream(streams, key, stream)) return;
    const text = data.toString("utf8");
    if (isBenignSshCloseNotice(text)) return;
    sendIfActive(stream.lease, { type: "terminal_data", clientId, streamId, data: text });
  });
  child.on("close", (code, signal) => {
    if (stream.forceCloseTimer) {
      clearTimeout(stream.forceCloseTimer);
      stream.forceCloseTimer = undefined;
    }
    if (signal !== null || (code ?? 1) !== 0) {
      signalRemoteProcessGroup(stream, "SIGKILL");
    }
    stream.resourceActive = false;
    finalizeStream(streams, routes, key, stream, code ?? 0);
  });
  child.on("error", (err) => {
    finalizeStream(streams, routes, key, stream, 1, { error: err.message, closeResource: true });
  });
  const pendingResize = stream.pendingResize;
  stream.pendingResize = undefined;
  if (pendingResize) {
    stream.resize(pendingResize.cols, pendingResize.rows);
  }
  await flushPendingInputs(control, streams, routes, key, stream);
}

async function openLocalStream(
  control: RelayTerminalControl,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  localBase: string,
  token: string,
  stream: LocalStream,
): Promise<void> {
  const { route } = stream;
  const { clientId, streamId, rawName, pane } = route;
  const key = streamKey(clientId, streamId);
  const paneIndex = await resolvePaneIndex({ id: "local", label: "local", kind: "local" }, rawName, pane);
  if (!isCurrentStream(streams, key, stream)) return;

  const localSocket = new WebSocket(localWsUrl(localBase, rawName, paneIndex), {
    headers: { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    maxPayload: LOCAL_WS_MAX_PAYLOAD_BYTES,
  });
  stream.resourceActive = true;
  stream.socket = localSocket;

  localSocket.on("open", () => {
    if (!isCurrentStream(streams, key, stream)) {
      try { localSocket.close(); } catch {}
      return;
    }
    stream.opening = false;
    const pendingResize = stream.pendingResize;
    stream.pendingResize = undefined;
    void (async () => {
      if (pendingResize) {
        const result = sendToStream(
          stream,
          JSON.stringify({ type: "attachment_resize", cols: pendingResize.cols, rows: pendingResize.rows }),
        );
        if (result !== "sent") {
          failCurrentStream(
            streams,
            routes,
            key,
            stream,
            result === "overloaded"
              ? "terminal input buffer limit reached"
              : "terminal stream closed while applying attachment resize",
          );
          return;
        }
      }
      await flushPendingInputs(control, streams, routes, key, stream);
    })();
  });
  localSocket.on("message", (chunk) => {
    if (!isCurrentStream(streams, key, stream)) return;
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    sendIfActive(stream.lease, { type: "terminal_data", clientId, streamId, data });
  });
  localSocket.on("close", () => {
    stream.resourceActive = false;
    finalizeStream(streams, routes, key, stream, 0);
  });
  localSocket.on("error", (err) => {
    finalizeStream(streams, routes, key, stream, 1, { error: err.message, closeResource: true });
  });
}

async function openRouteStream(
  control: RelayTerminalControl,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  opts: RelayHostOptions,
  stream: LocalStream,
): Promise<void> {
  stream.openTaskActive = true;
  try {
    const { route } = stream;
    if (route.scope.kind === "local") {
      await openLocalStream(
        control,
        streams,
        routes,
        opts.local,
        requireServeToken(),
        stream,
      );
      return;
    }
    await openRemoteStream(control, streams, routes, stream);
  } finally {
    stream.openTaskActive = false;
    releaseStreamAdmissionIfQuiescent(stream);
  }
}

async function reopenRoutedStream(
  control: RelayTerminalControl,
  admissionLedger: StreamAdmissionLedger,
  lease: RelayConnectionLease,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  opts: RelayHostOptions,
  route: StreamRoute,
  pendingInput?: string,
  pendingResize?: { cols: number; rows: number },
): Promise<void> {
  const key = streamKey(route.clientId, route.streamId);
  if (!isCurrentRoute(routes, key, route, lease)) return;

  const existing = streams.get(key);
  if (existing?.opening && existing.route === route && isCurrentStream(streams, key, existing)) {
    if (pendingInput && !queuePendingInput(existing, pendingInput)) {
      failCurrentStream(
        streams,
        routes,
        key,
        existing,
        "terminal input buffer limit reached",
      );
      return;
    }
    if (pendingResize) existing.pendingResize = pendingResize;
    return;
  }
  const reservation = reserveStreamAdmission(admissionLedger, route.clientId, route.scope);
  if (typeof reservation === "string") {
    rejectTerminalOpen(
      lease,
      streams,
      routes,
      key,
      route.clientId,
      route.streamId,
      reservation,
    );
    return;
  }
  if (existing) {
    streams.delete(key);
    closeStream(existing);
  }
  const stream = openingStream(lease, route, reservation, [], pendingResize);
  streams.set(key, stream);
  if (pendingInput && !queuePendingInput(stream, pendingInput)) {
    failCurrentStream(streams, routes, key, stream, "terminal input buffer limit reached");
    return;
  }
  try {
    await openRouteStream(control, streams, routes, opts, stream);
  } catch (error) {
    if (
      !isCurrentStream(streams, key, stream)
      || !isCurrentRoute(routes, key, route, lease)
    ) return;
    failCurrentStream(
      streams,
      routes,
      key,
      stream,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function rejectTerminalOpen(
  lease: RelayConnectionLease,
  streams: Map<string, LocalStream>,
  routes: Map<string, StreamRoute>,
  key: string,
  clientId: string,
  streamId: string,
  message: string,
): void {
  const route = routes.get(key);
  if (route?.clientId === clientId && route.streamId === streamId) {
    routes.delete(key);
  }
  const stream = streams.get(key);
  if (stream?.clientId === clientId && stream.streamId === streamId) {
    streams.delete(key);
    closeStream(stream);
  }
  sendIfActive(lease, { type: "error", clientId, streamId, message });
  sendIfActive(lease, { type: "terminal_exit", clientId, streamId, code: 1 });
}

async function runConnection(
  opts: RelayHostOptions,
  statusOwnership: RelayStatusOwnership,
  admissionLedger: StreamAdmissionLedger,
  commandAdmissionLedger: CommandAdmissionLedger,
  taskLedger: RelayTaskLedger,
  onSocket: (socket: WebSocket) => void,
  shutdownSignal: AbortSignal,
): Promise<{
  opened: boolean;
  closeCode: number;
  closeReason: string;
  superseded: boolean;
}> {
  requireServeToken();

  const relaySocket = new WebSocket(relayUrl(opts), {
    headers: { Authorization: `Bearer ${opts.secret}` },
    perMessageDeflate: false,
    maxPayload: MAX_RELAY_FRAME_BYTES,
    lookup: relayLookup,
  });
  onSocket(relaySocket);
  const streams = new Map<string, LocalStream>();
  const streamRoutes = new Map<string, StreamRoute>();
  const terminalControl: RelayTerminalControl = {
    connectorId: statusOwnership.instanceId,
    accepting: true,
    closedClients: new Set(),
    leases: new Map(),
    lanes: new Map(),
    laneTailTokens: new Map(),
    pendingRawInputs: new Map(),
    nextOperation: 0,
  };
  const terminalControlRenewal = setInterval(
    () => renewRelayControlLeases(terminalControl),
    TERMINAL_CONTROL_RENEW_INTERVAL_MS,
  );
  terminalControlRenewal.unref();
  const lease: RelayConnectionLease = { socket: relaySocket, active: true };
  const retireController = new AbortController();
  const connectionSignal = AbortSignal.any([shutdownSignal, retireController.signal]);
  let nextStreamGeneration = 1;
  let opened = false;
  let retiring = false;
  let shuttingDown = false;
  let drainPromise: Promise<void> | undefined;
  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownForceTimer: ReturnType<typeof setTimeout> | undefined;

  const drainConnection = (): Promise<void> => {
    terminalControl.accepting = false;
    closeConnectionStreams(streams, streamRoutes);
    retireController.abort();
    drainPromise ||= drainRelayWork(taskLedger, admissionLedger, commandAdmissionLedger);
    return drainPromise;
  };

  const closeAfterDrain = () => {
    if (!lease.active) return;
    if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
    shutdownForceTimer = undefined;
    if (relaySocket.readyState !== WebSocket.OPEN) {
      try { relaySocket.terminate(); } catch {}
      return;
    }
    try {
      relaySocket.close(1000, "host stopping");
    } catch {
      try { relaySocket.terminate(); } catch {}
      return;
    }
    forceCloseTimer = setTimeout(() => {
      forceCloseTimer = undefined;
      if (relaySocket.readyState !== WebSocket.CLOSED) {
        try { relaySocket.terminate(); } catch {}
      }
    }, RELAY_SOCKET_CLOSE_GRACE_MS);
    forceCloseTimer.unref();
  };

  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (relaySocket.readyState === WebSocket.CONNECTING) {
      try { relaySocket.terminate(); } catch {}
      return;
    }
    if (!lease.active) return;
    shutdownForceTimer = setTimeout(() => {
      shutdownForceTimer = undefined;
      if (relaySocket.readyState !== WebSocket.CLOSED) {
        try { relaySocket.terminate(); } catch {}
      }
    }, RELAY_SHUTDOWN_FORCE_CLOSE_MS);
    shutdownForceTimer.unref();
    void drainConnection().then(closeAfterDrain, closeAfterDrain);
  };

  const onShutdown = () => beginShutdown();
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    relaySocket.once("close", (code, reason) => {
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
      forceCloseTimer = undefined;
      shutdownForceTimer = undefined;
      shutdownSignal.removeEventListener("abort", onShutdown);
      terminalControl.accepting = false;
      deactivateConnection(lease, streams, streamRoutes);
      resolve({ code, reason: reason.toString("utf8") });
    });
  });

  shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  if (shutdownSignal.aborted) onShutdown();

  await new Promise<void>((resolve, reject) => {
    relaySocket.once("open", () => {
      opened = true;
      resolve();
    });
    relaySocket.once("error", reject);
  });
  console.log(`[relay-host] connected to ${opts.relay} as ${opts.hostId}`);
  writeRelayStatus(opts, statusOwnership, "connected", { connectedAt: Date.now() });
  sendIfActive(lease, {
    type: "host_ready",
    hostId: opts.hostId,
    displayName: opts.displayName,
    version: "admin-v1",
    capabilities: [RELAY_HOST_RETIRE_CAPABILITY],
  });

  const beginRetirement = () => {
    if (retiring || !lease.active) return;
    retiring = true;
    void drainConnection()
      .then(() => {
        if (!shuttingDown) sendIfActive(lease, { type: "host_drained" });
      });
  };

  relaySocket.on("message", (raw) => {
    if (!lease.active || connectionSignal.aborted) return;
    let message: RelayBrokerToHostMessage;
    try {
      message = parseJsonMessage(raw) as RelayBrokerToHostMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "host_retire") {
      beginRetirement();
      return;
    }
    const task = commandAbortContext.run({}, async () => {
      if (!lease.active || connectionSignal.aborted) return;

      if (message.type === "client_closed") {
        terminalControl.closedClients.add(message.clientId);
        closeClientRoutes(streamRoutes, message.clientId);
        closeClientStreams(streams, message.clientId);
        await releaseRelayControlForClient(terminalControl, message.clientId);
        return;
      }
      if (!("clientId" in message) || !message.clientId) return;
      const context = commandAbortContext.getStore();
      const safeToAbort = isSafeToAbortDuringShutdown(message);
      if (context) {
        context.mutation = !safeToAbort;
        if (safeToAbort) context.signal = connectionSignal;
      }

      const clientId = message.clientId;
      let commandReservation: CommandAdmissionReservation | undefined;
      try {
        if (requiresCommandAdmission(message)) {
          const reservation = reserveCommandAdmission(commandAdmissionLedger, clientId);
          if (typeof reservation === "string") {
            sendIfActive(lease, {
              type: "error",
              clientId,
              requestId: "requestId" in message ? message.requestId : undefined,
              message: reservation,
            });
            return;
          }
          commandReservation = reservation;
        }

        if (message.type === "list_sessions") {
          const sessions = await listAdminSessions(opts.local, requireServeToken());
          sendIfActive(lease, { type: "sessions", clientId, requestId: message.requestId, sessions });
          return;
        }

        if (message.type === "list_scope_statuses") {
          const scopes = await listScopeStatuses(opts.local, requireServeToken());
          sendIfActive(lease, { type: "scope_statuses", clientId, requestId: message.requestId, scopes });
          return;
        }

        if (message.type === "create_worktree") {
          const session = await createWorktreeSession(message);
          sendIfActive(lease, { type: "worktree_created", clientId, requestId: message.requestId, session });
          return;
        }

        if (message.type === "create_terminal") {
          const session = await createPlainTerminalSession(message);
          sendIfActive(lease, { type: "terminal_created", clientId, requestId: message.requestId, session });
          return;
        }

        if (message.type === "open_terminal") {
          const key = streamKey(clientId, message.streamId);
          let scope: AdminScope;
          let rawName: string;
          try {
            ({ scope, rawName } = scopeForSession(message.session));
          } catch (error) {
            rejectTerminalOpen(
              lease,
              streams,
              streamRoutes,
              key,
              clientId,
              message.streamId,
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          const reservation = reserveStreamAdmission(admissionLedger, clientId, scope);
          if (typeof reservation === "string") {
            rejectTerminalOpen(
              lease,
              streams,
              streamRoutes,
              key,
              clientId,
              message.streamId,
              reservation,
            );
            return;
          }
          const route: StreamRoute = {
            clientId,
            streamId: message.streamId,
            generation: nextStreamGeneration++,
            scope,
            rawName,
            pane: message.pane,
          };
          streamRoutes.set(key, route);
          const previous = streams.get(key);
          if (previous) {
            streams.delete(key);
            closeStream(previous);
          }
          const stream = openingStream(lease, route, reservation);
          streams.set(key, stream);
          try {
            await openRouteStream(terminalControl, streams, streamRoutes, opts, stream);
          } catch (error) {
            if (
              !isCurrentStream(streams, key, stream)
              || !isCurrentRoute(streamRoutes, key, route, lease)
            ) return;
            failCurrentStream(
              streams,
              streamRoutes,
              key,
              stream,
              error instanceof Error ? error.message : String(error),
            );
          }
          return;
        }

        if (message.type === "send_agent_message") {
          await sendControlledAgentMessage(
            terminalControl,
            clientId,
            message.session,
            message.message,
            message.submit !== false,
          );
          sendIfActive(lease, {
            type: "agent_message_sent",
            clientId,
            requestId: message.requestId,
            session: message.session,
            pane: message.pane,
          });
          return;
        }

        if (message.type === "kill_session") {
          const target = scopeForSession(message.session);
          await killControlledSession(terminalControl, clientId, message.session, message.managed);
          finalizeSessionStreams(streams, streamRoutes, message.session);
          forgetRelayControlLease(terminalControl, clientId, target.scope, target.rawName);
          sendIfActive(lease, {
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
        if (message.type === "close_terminal") {
          const route = streamRoutes.get(key);
          streamRoutes.delete(key);
          const stream = streams.get(key);
          if (stream) {
            streams.delete(key);
            closeStream(stream);
          }
          if (route) {
            const leaseKey = relayControlLeaseKey(clientId, route.scope, route.rawName);
            const record = terminalControl.leases.get(leaseKey);
            const routeStillUsesTarget = [...streamRoutes.values()].some((candidate) => (
              candidate.clientId === clientId
              && candidate.scope.id === route.scope.id
              && candidate.rawName === route.rawName
            ));
            if (record && !routeStillUsesTarget) {
              await releaseRelayControlRecord(terminalControl, record);
            }
          }
          return;
        }

        let stream = streams.get(key);
        if (stream && stream.route !== streamRoutes.get(key)) {
          streams.delete(key);
          closeStream(stream);
          stream = undefined;
        }
        if (!stream) {
          const route = streamRoutes.get(key);
          if (route && message.type === "terminal_input") {
            await reopenRoutedStream(terminalControl, admissionLedger, lease, streams, streamRoutes, opts, route, message.data);
            return;
          }
          if (route && message.type === "resize") {
            await reopenRoutedStream(terminalControl, admissionLedger, lease, streams, streamRoutes, opts, route, undefined, { cols: message.cols, rows: message.rows });
            return;
          }
          if (message.type === "resize") return;
          sendIfActive(lease, { type: "error", clientId, streamId: message.streamId, message: "terminal stream is not open" });
          return;
        }

        if (message.type === "terminal_input") {
          if (stream.opening) {
            if (!queuePendingInput(stream, message.data)) {
              failCurrentStream(
                streams,
                streamRoutes,
                key,
                stream,
                "terminal input buffer limit reached",
              );
            }
            return;
          }
          await writeControlledRawInput(terminalControl, stream.route, message.data);
        } else if (message.type === "resize") {
          if (stream.opening) {
            stream.pendingResize = { cols: message.cols, rows: message.rows };
            return;
          }
          if (stream.resize) {
            stream.resize(message.cols, message.rows);
          } else {
            const resize = JSON.stringify({ type: "attachment_resize", cols: message.cols, rows: message.rows });
            const result = sendToStream(stream, resize);
            if (result !== "sent") {
              failCurrentStream(
                streams,
                streamRoutes,
                key,
                stream,
                result === "overloaded"
                  ? "terminal input buffer limit reached"
                  : "terminal stream closed while applying attachment resize",
              );
            }
          }
        }
      } catch (err) {
        sendIfActive(lease, {
          type: "error",
          clientId,
          requestId: "requestId" in message ? message.requestId : undefined,
          streamId: "streamId" in message ? message.streamId : undefined,
          message: relayV1ErrorMessage(err),
        });
      } finally {
        if (commandReservation) releaseCommandAdmission(commandReservation);
      }
    });
    trackRelayTask(taskLedger, task);
  });

  const closeOutcome = await closed;
  clearInterval(terminalControlRenewal);
  await drainRelayControlLanes(terminalControl);
  await releaseAllRelayControl(terminalControl);
  console.log("[relay-host] disconnected");
  return {
    opened,
    closeCode: closeOutcome.code,
    closeReason: closeOutcome.reason,
    superseded: closeOutcome.code === 4002,
  };
}

export async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(3));
  const statusOwnership: RelayStatusOwnership = {
    instanceId: randomUUID(),
    claimed: false,
  };
  statusOwnership.claimed = writeRelayStatus(
    opts,
    statusOwnership,
    "connecting",
    {},
    true,
  );
  const admissionLedger = createStreamAdmissionLedger();
  const commandAdmissionLedger = createCommandAdmissionLedger();
  const taskLedger: RelayTaskLedger = { active: new Set() };
  let delay = 1000;
  let stopping = false;
  let stopError: string | undefined;
  let publishTerminalStatus = true;
  let activeSocket: WebSocket | undefined;
  const stopController = new AbortController();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    writeRelayStatus(opts, statusOwnership, "stopping");
    stopController.abort();
    if (activeSocket?.readyState === WebSocket.CONNECTING) {
      try { activeSocket.terminate(); } catch {}
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    let retryError = "Relay connection closed";
    writeRelayStatus(opts, statusOwnership, "connecting");
    try {
      const result = await runConnection(
        opts,
        statusOwnership,
        admissionLedger,
        commandAdmissionLedger,
        taskLedger,
        (socket) => {
          activeSocket = socket;
        },
        stopController.signal,
      );
      activeSocket = undefined;
      if (result.superseded) {
        stopError = result.closeReason || "host replaced";
        console.error(`[relay-host] stopping: ${stopError}`);
        stopping = true;
        publishTerminalStatus = false;
        stopController.abort();
        break;
      }
      if (stopping) break;
      retryError = result.closeReason || retryError;
      delay = result.opened ? 1000 : Math.min(delay * 2, 15_000);
    } catch (err) {
      activeSocket = undefined;
      if (stopping) break;
      retryError = err instanceof Error ? err.message : String(err);
      console.error(`[relay-host] ${retryError}`);
      delay = Math.min(delay * 2, 15_000);
    }
    writeRelayStatus(opts, statusOwnership, "retrying", { error: retryError, retryInMs: delay });
    await new Promise<void>((resolve) => {
      const onStop = () => {
        clearTimeout(timer);
        stopController.signal.removeEventListener("abort", onStop);
        resolve();
      };
      const timer = setTimeout(() => {
        stopController.signal.removeEventListener("abort", onStop);
        resolve();
      }, delay);
      stopController.signal.addEventListener("abort", onStop, { once: true });
      if (stopController.signal.aborted) onStop();
    });
  }
  await drainRelayWork(taskLedger, admissionLedger, commandAdmissionLedger);
  if (publishTerminalStatus) {
    writeRelayStatus(opts, statusOwnership, "stopped", stopError ? { error: stopError } : {});
  }
}
