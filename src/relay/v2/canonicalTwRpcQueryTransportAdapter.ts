import { spawn as spawnChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { types as nodeTypes } from "node:util";
import { loadConfigFile, type Config } from "../../config.js";
import {
  RelayV2CanonicalStructuredProcessAdapter,
} from "./canonicalStructuredProcessAdapter.js";
import type {
  RelayV2CanonicalTwRpcDiscoveryQuery,
  RelayV2CanonicalTwRpcDiscoveryQueryPort,
} from "./canonicalTwRpcDiscovery.js";
import {
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES,
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SESSIONS_PER_SCOPE,
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_QUERY_TIMEOUT_MS,
  RelayV2CanonicalTwRpcDiscoveryAdapter,
} from "./canonicalTwRpcDiscovery.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  type RelayV2JsonValue,
} from "./strictJson.js";
import {
  RELAY_V2_REMOTE_EXACT_COMPOUND_ENTRYPOINT,
  RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES,
  type RelayV2ExactCompoundProcessTargetV1,
  type RelayV2RemoteExactCompoundChannelFactoryV1,
  type RelayV2RemoteExactCompoundChannelV1,
} from "./remoteExactTerminalControlCompoundV1.js";

export const RELAY_V2_CANONICAL_TW_RPC_QUERY_STDOUT_MAX_BYTES = 1_048_576;
export const RELAY_V2_CANONICAL_TW_RPC_QUERY_STDERR_MAX_BYTES = 65_536;
export const RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_BYTES = 1_048_575;
export const RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_KEYS = 65_536;
export const RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_NODES = 131_072;

const QUERY_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_KEYS,
  maxNodes: RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_NODES,
});

const MAX_ARGUMENT_BYTES = 4_096;
const MAX_LOCAL_ARGV_PREFIX = 16;
const MAX_STRUCTURED_PROCESS_ARGV_ITEMS = 64;
const MAX_STRUCTURED_PROCESS_ARGUMENT_BYTES = 1_048_576;
const MAX_STRUCTURED_PROCESS_INVOCATION_BYTES = 1_179_648;

export interface RelayV2CanonicalTwRpcLocalQueryTargetDescriptor {
  kind: "local";
  targetId: string;
  /** Executable that enters the caller-selected canonical tw CLI. */
  executable: string;
  /** Optional structured prefix, for example an absolute bundled cli.cjs path. */
  argvPrefix?: readonly string[];
}

export interface RelayV2CanonicalTwRpcSshQueryTargetDescriptor {
  kind: "ssh";
  targetId: string;
  host: string;
  knownHostsFile: string;
  sshExecutable?: string;
  user: string;
  port: number;
  identityFile: string;
  /** Absolute, shell-safe remote path to the caller-selected canonical tw CLI. */
  twExecutable: string;
}

export type RelayV2CanonicalTwRpcQueryTargetDescriptor =
  | RelayV2CanonicalTwRpcLocalQueryTargetDescriptor
  | RelayV2CanonicalTwRpcSshQueryTargetDescriptor;

export interface RelayV2CanonicalTwRpcQueryProcessRequest {
  executable: string;
  argv: readonly string[];
  shell: false;
  stdin: "ignore";
  stdout: "pipe";
  stderr: "pipe";
}

export interface RelayV2CanonicalTwRpcQueryProcessExit {
  exitCode: number | null;
  signal: string | null;
}

/**
 * `exited` is the child exit barrier. A runner must close both byte streams
 * when that barrier settles, including after kill().
 */
export interface RelayV2CanonicalTwRpcQueryProcessHandle {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<RelayV2CanonicalTwRpcQueryProcessExit>;
  kill(signal: "SIGKILL"): void;
}

export interface RelayV2CanonicalTwRpcQueryProcessRunner {
  spawn(
    request: RelayV2CanonicalTwRpcQueryProcessRequest,
  ): RelayV2CanonicalTwRpcQueryProcessHandle;
}

export interface RelayV2CanonicalTwRpcCompoundProcessRequest {
  executable: string;
  argv: readonly string[];
  shell: false;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}

export interface RelayV2CanonicalTwRpcCompoundProcessHandle {
  stdin: {
    write(frame: Uint8Array): Promise<void>;
    end(): void;
  };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<RelayV2CanonicalTwRpcQueryProcessExit>;
  kill(signal: "SIGKILL"): void;
}

export interface RelayV2CanonicalTwRpcCompoundProcessRunner {
  spawnCompound(
    request: RelayV2CanonicalTwRpcCompoundProcessRequest,
  ): RelayV2CanonicalTwRpcCompoundProcessHandle;
}

/**
 * Default-disabled Node child runner for a future relay-host composition root.
 * Constructing it has no side effects; only an injected discovery scan spawns.
 */
export class RelayV2CanonicalTwRpcChildProcessRunner
implements RelayV2CanonicalTwRpcQueryProcessRunner, RelayV2CanonicalTwRpcCompoundProcessRunner {
  spawn(
    request: RelayV2CanonicalTwRpcQueryProcessRequest,
  ): RelayV2CanonicalTwRpcQueryProcessHandle {
    const child = spawnChildProcess(request.executable, [...request.argv], {
      shell: request.shell,
      stdio: [request.stdin, request.stdout, request.stderr],
      windowsHide: true,
    });
    if (child.stdout === null || child.stderr === null) {
      try { child.kill("SIGKILL"); } catch {}
      throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
    }
    const exited = new Promise<RelayV2CanonicalTwRpcQueryProcessExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      kill: (signal) => { child.kill(signal); },
    };
  }

  spawnCompound(
    request: RelayV2CanonicalTwRpcCompoundProcessRequest,
  ): RelayV2CanonicalTwRpcCompoundProcessHandle {
    const child = spawnChildProcess(request.executable, [...request.argv], {
      shell: request.shell,
      stdio: [request.stdin, request.stdout, request.stderr],
      windowsHide: true,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      try { child.kill("SIGKILL"); } catch {}
      throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
    }
    const exited = new Promise<RelayV2CanonicalTwRpcQueryProcessExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return {
      stdin: {
        write: (frame) => new Promise<void>((resolve, reject) => {
          child.stdin!.write(frame, (error) => error ? reject(error) : resolve());
        }),
        end: () => { child.stdin!.end(); },
      },
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      kill: (signal) => { child.kill(signal); },
    };
  }
}

declare const processTargetClaimBrand: unique symbol;

/**
 * Opaque one-shot claim privately issued by the single config process-target
 * generation owner. It is bound to that owner, the generation live at issue,
 * and the exact kind+targetId; only the issuing owner can consume it, and a
 * retired/replaced generation, a foreign claim, or a replay all fail closed.
 */
export interface RelayV2CanonicalProcessTargetClaimV1 {
  readonly [processTargetClaimBrand]?: never;
}

interface ProcessTargetClaimRecord {
  generation: object;
  kind: "local" | "ssh";
  targetId: string;
  consumed: boolean;
}

export interface RelayV2CanonicalProcessTargetClaimPortV1 {
  issueProcessTargetClaim(
    kind: "local" | "ssh",
    targetId: string,
  ): RelayV2CanonicalProcessTargetClaimV1;
  consumeProcessTargetClaim(
    claim: RelayV2CanonicalProcessTargetClaimV1,
    kind: "local" | "ssh",
    targetId: string,
  ): void;
}

export interface RelayV2CanonicalTwRpcQueryTransportAdapterOptions {
  targets: readonly RelayV2CanonicalTwRpcQueryTargetDescriptor[];
  runner: RelayV2CanonicalTwRpcQueryProcessRunner;
}

export interface RelayV2CanonicalTwRpcConfigSnapshotFactoryOptions {
  configLoader?: () => Pick<Config, "hosts"> | null;
  localTarget: RelayV2CanonicalTwRpcLocalQueryTargetDescriptor;
  /** Explicit trust store selected by future composition; never inferred from SSH config. */
  knownHostsFile: string;
  sshExecutable: string;
  runner: RelayV2CanonicalTwRpcQueryProcessRunner;
  queryTimeoutMs?: number;
}

export interface RelayV2CanonicalTwRpcConfigSnapshotFoundation {
  readonly discovery: RelayV2CanonicalTwRpcDiscoveryAdapter;
  readonly queryPort: RelayV2CanonicalTwRpcQueryTransportAdapter;
  /**
   * Canonical structured mutation lane bound to the same live queryPort
   * target authority and runner. reconfigure() retires/installs descriptor
   * generations only through queryPort, and this adapter re-resolves that
   * live authority on every execute, so retired generations fail closed here
   * exactly as they do for discovery and query.
   */
  readonly structuredProcess: RelayV2CanonicalStructuredProcessAdapter;
  reconfigure(): Promise<void>;
}

export type RelayV2CanonicalTwRpcQueryTransportErrorCode =
  | "ABORTED"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "OUTPUT_LIMIT"
  | "PROCESS_FAILED"
  | "SPAWN_FAILED"
  | "TARGET_UNAVAILABLE"
  | "TIMED_OUT";

export class RelayV2CanonicalTwRpcQueryTransportError extends Error {
  constructor(readonly code: RelayV2CanonicalTwRpcQueryTransportErrorCode) {
    super(`canonical TW RPC v2 query transport failed: ${code}`);
    this.name = "RelayV2CanonicalTwRpcQueryTransportError";
  }
}

/**
 * Exact complete process invocation of one current configured target for the
 * canonical structured mutation lane: the concrete executable plus the final
 * argv. Caller-supplied arguments are already carried inside the fixed local
 * argv or encoded into the single quoted post-host remote command string, so
 * the consumer can spawn it directly without further assembly. It carries no
 * query, scan, compound-channel, or mutation authority of its own.
 */
export interface RelayV2CanonicalStructuredProcessInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
}

type NormalizedTarget =
  | Readonly<{
      kind: "local";
      targetId: string;
      executable: string;
      argvPrefix: readonly string[];
    }>
  | Readonly<{
      kind: "ssh";
      targetId: string;
      host: string;
      knownHostsFile: string;
      sshExecutable: string;
      user: string;
      port: number;
      identityFile: string;
      twExecutable: string;
    }>;

interface ProcessOutput {
  exit: RelayV2CanonicalTwRpcQueryProcessExit;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maxBytes = MAX_ARGUMENT_BYTES): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError("invalid canonical TW RPC v2 query transport string");
  }
  return value;
}

function absolutePath(value: unknown): string {
  const path = boundedString(value);
  if (!isAbsolute(path)) {
    throw new TypeError("invalid canonical TW RPC v2 query transport path");
  }
  return path;
}

function canonicalDescriptorJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDescriptorJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalDescriptorJson(record[key])}`
  )).join(",")}}`;
}

function effectiveTargetId(value: object): string {
  const canonical = canonicalDescriptorJson({
    domain: "tmux-worktree.relay-v2.configured-process-target.v1",
    descriptor: value,
  });
  return `twcfg2.${createHash("sha256").update(canonical, "utf8").digest("base64url")}`;
}

function targetDescriptorForHash(target: NormalizedTarget): object {
  return target.kind === "local"
    ? {
      kind: target.kind,
      executable: target.executable,
      argvPrefix: [...target.argvPrefix],
    }
    : {
      kind: target.kind,
      host: target.host,
      knownHostsFile: target.knownHostsFile,
      sshExecutable: target.sshExecutable,
      user: target.user,
      port: target.port,
      identityFile: target.identityFile,
      twExecutable: target.twExecutable,
    };
}

function normalizeContentAddressedTargets(
  value: readonly RelayV2CanonicalTwRpcQueryTargetDescriptor[],
): ReadonlyMap<string, NormalizedTarget> {
  const targets = normalizeTargets(value);
  for (const target of targets.values()) {
    if (target.targetId !== effectiveTargetId(targetDescriptorForHash(target))) {
      throw new TypeError("canonical TW RPC v2 target ID is not content-addressed");
    }
  }
  return targets;
}

function normalizeLocalTarget(
  value: Record<string, unknown>,
): Extract<NormalizedTarget, { kind: "local" }> {
  if (!hasExactKeys(value, ["kind", "targetId", "executable"], ["argvPrefix"])) {
    throw new TypeError("invalid canonical TW RPC v2 local query target");
  }
  const rawPrefix = value.argvPrefix ?? [];
  if (!Array.isArray(rawPrefix) || rawPrefix.length > MAX_LOCAL_ARGV_PREFIX) {
    throw new TypeError("invalid canonical TW RPC v2 local query argv prefix");
  }
  const argvPrefix = Object.freeze(rawPrefix.map((item) => boundedString(item)));
  return Object.freeze({
    kind: "local",
    targetId: boundedString(value.targetId, 128),
    executable: boundedString(value.executable),
    argvPrefix,
  });
}

function normalizeRemoteTwExecutable(value: unknown): string {
  const executable = boundedString(value);
  if (!executable.startsWith("/") || !/^\/[A-Za-z0-9._+@%=/:-]+$/.test(executable)) {
    throw new TypeError("invalid canonical remote tw executable");
  }
  return executable;
}

function normalizeSshTarget(
  value: Record<string, unknown>,
): Extract<NormalizedTarget, { kind: "ssh" }> {
  if (!hasExactKeys(
    value,
    [
      "kind", "targetId", "host", "knownHostsFile", "user", "port",
      "identityFile", "twExecutable",
    ],
    ["sshExecutable"],
  )) {
    throw new TypeError("invalid canonical TW RPC v2 SSH query target");
  }
  const host = boundedString(value.host, 255);
  if (host.startsWith("-") || !/^[A-Za-z0-9._:[\]-]+$/.test(host)) {
    throw new TypeError("invalid canonical TW RPC v2 SSH host");
  }
  const user = boundedString(value.user, 128);
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new TypeError("invalid canonical TW RPC v2 SSH user");
  }
  const port = value.port;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new TypeError("invalid canonical TW RPC v2 SSH port");
  }
  return Object.freeze({
    kind: "ssh",
    targetId: boundedString(value.targetId, 128),
    host,
    knownHostsFile: absolutePath(value.knownHostsFile),
    sshExecutable: boundedString(value.sshExecutable ?? "ssh"),
    user,
    port: port as number,
    identityFile: absolutePath(value.identityFile),
    twExecutable: normalizeRemoteTwExecutable(value.twExecutable),
  });
}

function normalizeTargets(value: unknown): Map<string, NormalizedTarget> {
  if (!Array.isArray(value)
    || value.length > RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES) {
    throw new TypeError("invalid canonical TW RPC v2 query targets");
  }
  const targets = new Map<string, NormalizedTarget>();
  for (const item of value) {
    if (!isRecord(item) || (item.kind !== "local" && item.kind !== "ssh")) {
      throw new TypeError("invalid canonical TW RPC v2 query target");
    }
    const target = item.kind === "local"
      ? normalizeLocalTarget(item)
      : normalizeSshTarget(item);
    const key = `${target.kind}\0${target.targetId}`;
    if (targets.has(key)) {
      throw new TypeError("duplicate canonical TW RPC v2 query target");
    }
    targets.set(key, target);
  }
  return targets;
}

function normalizeQuery(value: unknown): RelayV2CanonicalTwRpcDiscoveryQuery {
  if (!isRecord(value)
    || !isRecord(value.processTarget)
    || !hasExactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !(value.signal instanceof AbortSignal)
    || !Number.isSafeInteger(value.timeoutMs)
    || (value.timeoutMs as number) < 1
    || (value.timeoutMs as number) > RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_QUERY_TIMEOUT_MS) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
  }
  const processTarget = {
    kind: value.processTarget.kind,
    targetId: boundedString(value.processTarget.targetId, 128),
  } as const;
  if (value.command === "capabilities"
    && hasExactKeys(value, ["processTarget", "command", "timeoutMs", "signal"])) {
    return {
      processTarget,
      command: "capabilities",
      timeoutMs: value.timeoutMs as number,
      signal: value.signal,
    };
  }
  if (value.command === "list"
    && hasExactKeys(value, ["processTarget", "command", "maxSessions", "timeoutMs", "signal"])
    && Number.isSafeInteger(value.maxSessions)
    && (value.maxSessions as number) >= 0
    && (value.maxSessions as number)
      <= RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SESSIONS_PER_SCOPE) {
    return {
      processTarget,
      command: "list",
      maxSessions: value.maxSessions as number,
      timeoutMs: value.timeoutMs as number,
      signal: value.signal,
    };
  }
  throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
}

function sshInvocationOptions(
  target: Extract<NormalizedTarget, { kind: "ssh" }>,
  timeoutMs: number,
): string[] {
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1_000))}`,
    "-o", "IdentitiesOnly=yes",
    "-i", target.identityFile,
    "-p", String(target.port),
    "-l", target.user,
  ];
}

function sshInvocationPrefix(
  target: Extract<NormalizedTarget, { kind: "ssh" }>,
  timeoutMs: number,
): string[] {
  return [
    ...sshInvocationOptions(target, timeoutMs),
    "--",
    target.host,
    target.twExecutable,
  ];
}

/**
 * Strict POSIX single-quote encoding: every byte except `'` is literal inside
 * single quotes, and each `'` closes the quote, adds an escaped quote, and
 * reopens it. OpenSSH joins post-host arguments into one remote shell command,
 * so caller-controlled argv must never cross that boundary unencoded.
 */
function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function structuredProcessArgv(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_STRUCTURED_PROCESS_ARGV_ITEMS
    || value.some((item) => typeof item !== "string"
      || (item as string).includes("\0")
      || Buffer.byteLength(item as string, "utf8")
        > MAX_STRUCTURED_PROCESS_ARGUMENT_BYTES)) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
  }
  const argv = [...value] as string[];
  // Aggregate bytes are validated before any quoting or join so the public
  // lookup cannot be driven into amplified allocation by many large items.
  if (argv.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0)
    > MAX_STRUCTURED_PROCESS_INVOCATION_BYTES) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
  }
  return argv;
}

function boundedStructuredInvocation(
  executable: string,
  argv: readonly string[],
): RelayV2CanonicalStructuredProcessInvocation {
  // The final invocation, quoting expansion included, must fit the same hard
  // byte cap the structured process adapter enforces before spawn.
  if (argv.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0)
    > MAX_STRUCTURED_PROCESS_INVOCATION_BYTES) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
  }
  return Object.freeze({ executable, argv: Object.freeze(argv) });
}

function invocationFor(
  target: NormalizedTarget,
  request: RelayV2CanonicalTwRpcDiscoveryQuery,
): RelayV2CanonicalTwRpcQueryProcessRequest {
  if (target.kind === "local") {
    return Object.freeze({
      executable: target.executable,
      argv: Object.freeze([...target.argvPrefix, "rpc-v2", request.command]),
      shell: false as const,
      stdin: "ignore" as const,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    });
  }
  const argv = [
    ...sshInvocationPrefix(target, request.timeoutMs),
    "rpc-v2",
    request.command,
  ];
  return Object.freeze({
    executable: target.sshExecutable,
    argv: Object.freeze(argv),
    shell: false as const,
    stdin: "ignore" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  });
}

function compoundInvocationFor(
  target: Extract<NormalizedTarget, { kind: "ssh" }>,
): RelayV2CanonicalTwRpcCompoundProcessRequest {
  return Object.freeze({
    executable: target.sshExecutable,
    argv: Object.freeze([
      "-F", "/dev/null",
      "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "ClearAllForwardings=yes",
      "-o", "RequestTTY=no",
      "-o", "ConnectTimeout=10",
      "-o", "IdentitiesOnly=yes",
      "-i", target.identityFile,
      "-p", String(target.port),
      "-l", target.user,
      "--",
      target.host,
      target.twExecutable,
      RELAY_V2_REMOTE_EXACT_COMPOUND_ENTRYPOINT,
    ]),
    shell: false as const,
    stdin: "pipe" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  });
}

class CanonicalRemoteExactCompoundChannel
implements RelayV2RemoteExactCompoundChannelV1 {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly exited: Promise<RelayV2CanonicalTwRpcQueryProcessExit>;
  private readonly fatalSignal: Promise<void>;
  private resolveFatal: (() => void) | null = null;
  private fatalError: RelayV2CanonicalTwRpcQueryTransportError | null = null;
  private buffer = Buffer.alloc(0);
  private operation: Promise<void> = Promise.resolve();
  private closeBarrier: Promise<void> | null = null;
  private killed = false;

  constructor(
    private readonly handle: RelayV2CanonicalTwRpcCompoundProcessHandle,
    private readonly onClosed: () => void,
  ) {
    this.iterator = handle.stdout[Symbol.asyncIterator]();
    this.exited = Promise.resolve(handle.exited).then(normalizeExit);
    this.fatalSignal = new Promise<void>((resolve) => { this.resolveFatal = resolve; });
    void this.watchStderr();
  }

  private kill(): void {
    if (this.killed) return;
    this.killed = true;
    try { this.handle.kill("SIGKILL"); } catch {}
  }

  private fail(error: RelayV2CanonicalTwRpcQueryTransportError): void {
    if (this.fatalError !== null) return;
    this.fatalError = error;
    this.kill();
    this.resolveFatal?.();
  }

  private async watchStderr(): Promise<void> {
    let bytes = 0;
    try {
      for await (const chunk of this.handle.stderr) {
        if (!(chunk instanceof Uint8Array)) {
          this.fail(new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED"));
          return;
        }
        bytes += chunk.byteLength;
        if (bytes > 0) {
          this.fail(new RelayV2CanonicalTwRpcQueryTransportError(
            bytes > RELAY_V2_CANONICAL_TW_RPC_QUERY_STDERR_MAX_BYTES
              ? "OUTPUT_LIMIT"
              : "PROCESS_FAILED",
          ));
          return;
        }
      }
    } catch {
      this.fail(new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED"));
    }
  }

  private async nextFrame(): Promise<Record<string, unknown>> {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const frame = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (frame.byteLength === 0 || frame.includes(0x0d)) {
          throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_RESPONSE");
        }
        try {
          return parseRelayV2JsonObject(decodeRelayV2StrictUtf8(frame), QUERY_JSON_LIMITS);
        } catch {
          throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_RESPONSE");
        }
      }
      const next = await this.iterator.next();
      if (next.done) {
        const exit = await this.exited;
        throw new RelayV2CanonicalTwRpcQueryTransportError(
          exit.exitCode === 0 && exit.signal === null ? "INVALID_RESPONSE" : "PROCESS_FAILED",
        );
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED");
      }
      if (next.value.byteLength
        > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES - this.buffer.byteLength) {
        throw new RelayV2CanonicalTwRpcQueryTransportError("OUTPUT_LIMIT");
      }
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    }
  }

  private async requestOne(frame: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closeBarrier !== null || this.fatalError !== null) {
      throw this.fatalError ?? new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
    }
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (encoded.byteLength > RELAY_V2_REMOTE_EXACT_COMPOUND_MAX_FRAME_BYTES) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
    }
    await this.handle.stdin.write(encoded);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new RelayV2CanonicalTwRpcQueryTransportError("TIMED_OUT"));
      }, 30_000);
      timer.unref?.();
      this.operation.finally(() => clearTimeout(timer)).catch(() => undefined);
    });
    const fatal = this.fatalSignal.then(() => {
      throw this.fatalError ?? new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED");
    });
    return Promise.race([this.nextFrame(), fatal, timeout]);
  }

  request(frame: Readonly<Record<string, unknown>>): Promise<unknown> {
    const result = this.operation.then(() => this.requestOne(frame));
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  fence(): void {
    this.fail(new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE"));
  }

  async close(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.closeBarrier = (async () => {
      try { this.handle.stdin.end(); } catch {}
      const timer = setTimeout(() => this.kill(), 5_000);
      timer.unref?.();
      try {
        await this.exited.catch(() => undefined);
      } finally {
        clearTimeout(timer);
        this.onClosed();
      }
    })();
    return this.closeBarrier;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return value !== null
    && typeof value === "object"
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function closedOwnDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value) || nodeTypes.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some((key) => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !Object.hasOwn(descriptor, "value");
      })) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
  } catch {
    return null;
  }
}

function normalizeCompoundProcessHandle(
  value: unknown,
): RelayV2CanonicalTwRpcCompoundProcessHandle {
  try {
    const handle = closedOwnDataRecord(value, ["stdin", "stdout", "stderr", "exited", "kill"]);
    const stdinValue = handle?.stdin;
    const stdin = closedOwnDataRecord(stdinValue, ["write", "end"]);
    if (handle === null
      || stdin === null
      || typeof stdin.write !== "function"
      || typeof stdin.end !== "function"
      || nodeTypes.isProxy(handle.stdout)
      || nodeTypes.isProxy(handle.stderr)
      || !isAsyncIterable(handle.stdout)
      || !isAsyncIterable(handle.stderr)
      || !(handle.exited instanceof Promise)
      || typeof handle.kill !== "function") {
      throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
    }
    return Object.freeze({
      stdin: Object.freeze({
        write: (frame: Uint8Array) => Promise.resolve(
          Reflect.apply(stdin.write as (...args: unknown[]) => unknown, stdinValue, [frame]),
        ).then(() => undefined),
        end: () => {
          Reflect.apply(stdin.end as (...args: unknown[]) => unknown, stdinValue, []);
        },
      }),
      stdout: handle.stdout as AsyncIterable<Uint8Array>,
      stderr: handle.stderr as AsyncIterable<Uint8Array>,
      exited: handle.exited as Promise<RelayV2CanonicalTwRpcQueryProcessExit>,
      kill: (signal: "SIGKILL") => {
        Reflect.apply(handle.kill as (...args: unknown[]) => unknown, value, [signal]);
      },
    });
  } catch (error) {
    if (error instanceof RelayV2CanonicalTwRpcQueryTransportError) throw error;
    throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
  }
}

function normalizeProcessHandle(value: unknown): RelayV2CanonicalTwRpcQueryProcessHandle {
  if (!isRecord(value)
    || !isAsyncIterable(value.stdout)
    || !isAsyncIterable(value.stderr)
    || !(value.exited instanceof Promise)
    || typeof value.kill !== "function") {
    throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
  }
  return value as unknown as RelayV2CanonicalTwRpcQueryProcessHandle;
}

async function readBounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED");
    }
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("OUTPUT_LIMIT");
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function normalizeExit(value: unknown): RelayV2CanonicalTwRpcQueryProcessExit {
  if (!isRecord(value)
    || !hasExactKeys(value, ["exitCode", "signal"])
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || (value.signal !== null && typeof value.signal !== "string")) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED");
  }
  return {
    exitCode: value.exitCode as number | null,
    signal: value.signal as string | null,
  };
}

async function collectProcess(
  handle: RelayV2CanonicalTwRpcQueryProcessHandle,
  request: RelayV2CanonicalTwRpcDiscoveryQuery,
): Promise<ProcessOutput> {
  let killRequested = false;
  let cancellation: "ABORTED" | "TIMED_OUT" | undefined;
  let signalCancellation: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    signalCancellation = resolve;
  });
  const requestKill = (): void => {
    if (killRequested) return;
    killRequested = true;
    try {
      handle.kill("SIGKILL");
    } catch {
      // The exit barrier below remains authoritative even if kill reports a race.
    }
  };
  const cancel = (reason: "ABORTED" | "TIMED_OUT"): void => {
    if (cancellation !== undefined) return;
    cancellation = reason;
    requestKill();
    signalCancellation?.();
  };
  const onAbort = (): void => cancel("ABORTED");
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => cancel("TIMED_OUT"), request.timeoutMs);
  const stdout = readBounded(
    handle.stdout,
    RELAY_V2_CANONICAL_TW_RPC_QUERY_STDOUT_MAX_BYTES,
  );
  const stderr = readBounded(
    handle.stderr,
    RELAY_V2_CANONICAL_TW_RPC_QUERY_STDERR_MAX_BYTES,
  );
  const exited = Promise.resolve(handle.exited).then(normalizeExit);
  const completed = Promise.all([exited, stdout, stderr]);
  try {
    if (request.signal.aborted) cancel("ABORTED");
    const outcome = await Promise.race([
      completed.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      cancellationStarted.then(() => ({ kind: "cancelled" as const })),
    ]);
    if (outcome.kind === "cancelled" || cancellation !== undefined) {
      await Promise.allSettled([exited, stdout, stderr]);
      throw new RelayV2CanonicalTwRpcQueryTransportError(cancellation ?? "ABORTED");
    }
    if (outcome.kind === "failed") {
      requestKill();
      await Promise.allSettled([exited, stdout, stderr]);
      if (outcome.error instanceof RelayV2CanonicalTwRpcQueryTransportError) {
        throw outcome.error;
      }
      throw new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED");
    }
    const [exit, stdoutBytes, stderrBytes] = outcome.value;
    return { exit, stdout: stdoutBytes, stderr: stderrBytes };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}

function parseStdout(value: Uint8Array): { [key: string]: RelayV2JsonValue } {
  if (value.byteLength < 2
    || value.byteLength > RELAY_V2_CANONICAL_TW_RPC_QUERY_STDOUT_MAX_BYTES
    || value[value.byteLength - 1] !== 0x0a) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_RESPONSE");
  }
  const frame = value.subarray(0, value.byteLength - 1);
  if (frame.byteLength > RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_BYTES
    || frame.includes(0x0a)
    || frame.includes(0x0d)) {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_RESPONSE");
  }
  try {
    return parseRelayV2JsonObject(
      decodeRelayV2StrictUtf8(frame),
      QUERY_JSON_LIMITS,
    );
  } catch {
    throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_RESPONSE");
  }
}

/**
 * Unwired H2 transport boundary. It invokes only caller-configured local/SSH
 * targets and the frozen read-only `tw rpc-v2 capabilities|list` entrypoints.
 */
export class RelayV2CanonicalTwRpcQueryTransportAdapter
implements RelayV2CanonicalTwRpcDiscoveryQueryPort, RelayV2CanonicalProcessTargetClaimPortV1 {
  private targets: ReadonlyMap<string, NormalizedTarget>;

  private targetGeneration: object = {};

  private generationLive = true;

  private readonly targetClaims = new WeakMap<object, ProcessTargetClaimRecord>();

  private readonly runner: RelayV2CanonicalTwRpcQueryProcessRunner;

  private readonly activeCompoundChannels = new Set<CanonicalRemoteExactCompoundChannel>();

  constructor(options: RelayV2CanonicalTwRpcQueryTransportAdapterOptions) {
    if (!isRecord(options)
      || !hasExactKeys(options, ["targets", "runner"])
      || !isRecord(options.runner)
      || typeof options.runner.spawn !== "function") {
      throw new TypeError("invalid canonical TW RPC v2 query transport options");
    }
    this.targets = normalizeTargets(options.targets);
    this.runner = options.runner;
  }

  /** Exact opaque descriptor identity for discovery/evidence, not execution authority. */
  processTarget(
    kind: "local" | "ssh",
    targetId: string,
  ): { kind: "local" | "ssh"; targetId: string } {
    const normalizedId = boundedString(targetId, 128);
    const target = this.targets.get(`${kind}\0${normalizedId}`);
    if (target === undefined) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
    }
    return {
      kind: target.kind,
      targetId: target.targetId,
    };
  }

  /**
   * Narrow additive lookup for the canonical structured mutation process lane.
   * It resolves one current configured target and returns the exact complete
   * invocation for the caller's canonical `tw rpc-v2` argv: local targets
   * append it to the fixed argv prefix, while SSH targets encode the remote
   * tw executable and every caller argument with strict POSIX single quotes
   * into the single post-host remote command string. The lookup is
   * re-evaluated by the caller on every execute, so retired descriptor
   * generations fail closed instead of invoking stale bindings. It exposes no
   * query, scan, or compound-channel authority and never falls back to
   * another target.
   */
  structuredProcessInvocation(
    kind: "local" | "ssh",
    targetId: string,
    argv: readonly string[],
    timeoutMs: number,
  ): RelayV2CanonicalStructuredProcessInvocation {
    const normalizedId = boundedString(targetId, 128);
    const rpcArgv = structuredProcessArgv(argv);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("INVALID_REQUEST");
    }
    const target = this.targets.get(`${kind}\0${normalizedId}`);
    if (target === undefined) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
    }
    if (target.kind === "local") {
      return boundedStructuredInvocation(target.executable, [
        ...target.argvPrefix,
        ...rpcArgv,
      ]);
    }
    const remoteCommand = [target.twExecutable, ...rpcArgv]
      .map((item) => posixShellQuote(item))
      .join(" ");
    return boundedStructuredInvocation(target.sshExecutable, [
      ...sshInvocationOptions(target, timeoutMs),
      "--",
      target.host,
      remoteCommand,
    ]);
  }

  /** Synchronously withdraws every binding while a config generation retires. */
  beginContentAddressedTargetTransition(): void {
    this.targets = new Map();
    this.targetGeneration = {};
    this.generationLive = false;
    for (const channel of this.activeCompoundChannels) channel.fence();
  }

  /** Installs only descriptors whose opaque ID hashes their exact contents. */
  installContentAddressedTargets(
    targets: readonly RelayV2CanonicalTwRpcQueryTargetDescriptor[],
  ): void {
    this.targets = normalizeContentAddressedTargets(targets);
    this.targetGeneration = {};
    this.generationLive = true;
  }

  /**
   * Privately issues an opaque one-shot claim for one currently configured
   * target of the live generation. The claim carries no authority by itself;
   * only this owner's synchronous consume below can redeem it, and only once.
   */
  issueProcessTargetClaim(
    kind: "local" | "ssh",
    targetId: string,
  ): RelayV2CanonicalProcessTargetClaimV1 {
    const normalizedId = boundedString(targetId, 128);
    if (!this.generationLive || !this.targets.has(`${kind}\0${normalizedId}`)) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
    }
    const claim = Object.freeze({}) as RelayV2CanonicalProcessTargetClaimV1;
    this.targetClaims.set(claim as object, {
      generation: this.targetGeneration,
      kind,
      targetId: normalizedId,
      consumed: false,
    });
    return claim;
  }

  /**
   * Synchronously and atomically consumes a claim this owner issued. A claim
   * from another owner, an already-consumed claim, a claim from a retired or
   * replaced generation, or a kind/targetId mismatch all fail closed.
   */
  consumeProcessTargetClaim(
    claim: RelayV2CanonicalProcessTargetClaimV1,
    kind: "local" | "ssh",
    targetId: string,
  ): void {
    const normalizedId = boundedString(targetId, 128);
    const record = this.targetClaims.get(claim as object);
    if (record === undefined
      || record.consumed
      || !this.generationLive
      || record.generation !== this.targetGeneration
      || record.kind !== kind
      || record.targetId !== normalizedId
      || !this.targets.has(`${kind}\0${normalizedId}`)) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
    }
    record.consumed = true;
  }

  async query(rawRequest: RelayV2CanonicalTwRpcDiscoveryQuery): Promise<unknown> {
    const request = normalizeQuery(rawRequest);
    if (request.signal.aborted) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("ABORTED");
    }
    const target = this.targets.get(
      `${request.processTarget.kind}\0${request.processTarget.targetId}`,
    );
    if (!target) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
    }
    let handle: RelayV2CanonicalTwRpcQueryProcessHandle;
    try {
      handle = normalizeProcessHandle(this.runner.spawn(invocationFor(target, request)));
    } catch (error) {
      if (error instanceof RelayV2CanonicalTwRpcQueryTransportError) throw error;
      throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
    }
    const result = await collectProcess(handle, request);
    if (result.exit.exitCode !== 0
      || result.exit.signal !== null
      || result.stderr.byteLength !== 0) {
      throw new RelayV2CanonicalTwRpcQueryTransportError("PROCESS_FAILED");
    }
    return parseStdout(result.stdout);
  }

  /**
   * Captures the same configured-target owner for a versioned, long-lived SSH
   * child. Local targets are deliberately unavailable: they already use the
   * in-process exact authority and must never be a remote fallback.
   */
  captureRemoteExactCompoundChannelFactory(
    runner: RelayV2CanonicalTwRpcCompoundProcessRunner,
  ): RelayV2RemoteExactCompoundChannelFactoryV1 {
    if (!isRecord(runner) || typeof runner.spawnCompound !== "function") {
      throw new TypeError("canonical TW RPC remote compound runner is invalid");
    }
    return Object.freeze({
      open: async (rawTarget: RelayV2ExactCompoundProcessTargetV1) => {
        const targetId = boundedString(rawTarget?.targetId, 128);
        const target = this.targets.get(`ssh\0${targetId}`);
        if (target === undefined || target.kind !== "ssh" || rawTarget.kind !== "ssh") {
          throw new RelayV2CanonicalTwRpcQueryTransportError("TARGET_UNAVAILABLE");
        }
        let handle: RelayV2CanonicalTwRpcCompoundProcessHandle;
        try {
          handle = normalizeCompoundProcessHandle(
            runner.spawnCompound(compoundInvocationFor(target)),
          );
        } catch (error) {
          if (error instanceof RelayV2CanonicalTwRpcQueryTransportError) throw error;
          throw new RelayV2CanonicalTwRpcQueryTransportError("SPAWN_FAILED");
        }
        const channel = new CanonicalRemoteExactCompoundChannel(
          handle,
          () => this.activeCompoundChannels.delete(channel),
        );
        this.activeCompoundChannels.add(channel);
        return channel;
      },
    });
  }
}

interface DerivedConfigSnapshotTargets {
  descriptors: RelayV2CanonicalTwRpcQueryTargetDescriptor[];
  scopes: Array<{
    backendIdentity: string;
    displayName: string;
    kind: "local" | "ssh";
    targetId: string;
  }>;
}

function deriveExplicitConfigSnapshotTargets(
  configSnapshot: Pick<Config, "hosts"> | null,
  options: Pick<
    RelayV2CanonicalTwRpcConfigSnapshotFactoryOptions,
    "localTarget" | "knownHostsFile" | "sshExecutable"
  >,
): DerivedConfigSnapshotTargets {
  if (typeof options.localTarget?.executable !== "string"
    || !isAbsolute(options.localTarget.executable)
    || !Array.isArray(options.localTarget.argvPrefix ?? [])
    || (options.localTarget.argvPrefix ?? []).some((argument) => (
      typeof argument !== "string" || !isAbsolute(argument)
    ))
    || typeof options.knownHostsFile !== "string"
    || !isAbsolute(options.knownHostsFile)
    || typeof options.sshExecutable !== "string"
    || !isAbsolute(options.sshExecutable)) {
    throw new TypeError("canonical TW RPC v2 config factory requires explicit absolute paths");
  }
  if (configSnapshot !== null
    && (!isRecord(configSnapshot) || !Array.isArray(configSnapshot.hosts))) {
    throw new TypeError("canonical TW RPC v2 config snapshot is malformed");
  }
  const localDescriptor = {
    kind: "local" as const,
    executable: options.localTarget.executable,
    argvPrefix: [...(options.localTarget.argvPrefix ?? [])],
  };
  const localTargetId = effectiveTargetId(localDescriptor);
  const descriptors: RelayV2CanonicalTwRpcQueryTargetDescriptor[] = [{
    kind: "local",
    targetId: localTargetId,
    executable: localDescriptor.executable,
    argvPrefix: localDescriptor.argvPrefix,
  }];
  const scopes: DerivedConfigSnapshotTargets["scopes"] = [{
    backendIdentity: `local:${options.localTarget.targetId}`,
    displayName: "local",
    kind: "local",
    targetId: localTargetId,
  }];
  for (const host of configSnapshot?.hosts ?? []) {
    if (!isRecord(host)
      || typeof host.id !== "string"
      || typeof host.host !== "string"
      || typeof host.user !== "string"
      || !Number.isSafeInteger(host.port)
      || typeof host.identityFile !== "string"
      || !isAbsolute(host.identityFile)
      || typeof host.twPath !== "string"
      || !isAbsolute(host.twPath)) {
      throw new TypeError(
        "canonical TW RPC v2 configured Host lacks explicit user/port/key/absolute tw path",
      );
    }
    const sshDescriptor = {
      kind: "ssh",
      host: host.host,
      knownHostsFile: options.knownHostsFile,
      sshExecutable: options.sshExecutable,
      user: host.user,
      port: host.port as number,
      identityFile: host.identityFile,
      twExecutable: host.twPath,
    } as const;
    const targetId = effectiveTargetId(sshDescriptor);
    descriptors.push({ ...sshDescriptor, targetId });
    scopes.push({
      backendIdentity: `configured-host:${host.id}`,
      displayName: typeof host.label === "string" && host.label.length > 0
        ? host.label
        : host.id,
      kind: "ssh",
      targetId,
    });
  }
  return { descriptors, scopes };
}

/**
 * Default-off provenance factory for a future relay-host composition root.
 * The only remote scopes come from loadConfigFile() (or an injected test
 * loader). It does not read SSH config, start discovery, or wire H1/H3.
 * It is the single target-generation owner for discovery, query, and the
 * structured mutation process lane: one live queryPort holds the configured
 * targets, reconfigure() switches generations only through that port's
 * atomic retire/install transition, and the long-lived structuredProcess
 * adapter re-resolves the same live authority on every execute.
 */
export function createRelayV2CanonicalTwRpcConfigSnapshotFoundation(
  options: RelayV2CanonicalTwRpcConfigSnapshotFactoryOptions,
): RelayV2CanonicalTwRpcConfigSnapshotFoundation {
  if (!isRecord(options) || !isRecord(options.runner) || !isRecord(options.localTarget)) {
    throw new TypeError("invalid canonical TW RPC v2 config snapshot factory options");
  }
  const fixed = {
    localTarget: { ...options.localTarget, argvPrefix: [...(options.localTarget.argvPrefix ?? [])] },
    knownHostsFile: options.knownHostsFile,
    sshExecutable: options.sshExecutable,
  };
  const configLoader = options.configLoader ?? loadConfigFile;
  if (typeof configLoader !== "function") {
    throw new TypeError("canonical TW RPC v2 config loader is invalid");
  }
  const build = (snapshot: Pick<Config, "hosts"> | null) => {
    const derived = deriveExplicitConfigSnapshotTargets(snapshot, fixed);
    const validator = new RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: derived.descriptors,
      runner: options.runner,
    });
    validator.installContentAddressedTargets(derived.descriptors);
    const scopes = derived.scopes.map((scope) => ({
      backendIdentity: scope.backendIdentity,
      displayName: scope.displayName,
      kind: scope.kind,
      processTarget: validator.processTarget(scope.kind, scope.targetId),
    }));
    return { ...derived, scopes, validator };
  };
  const initial = build(configLoader());
  const queryPort = initial.validator;
  const structuredProcess = new RelayV2CanonicalStructuredProcessAdapter({
    targets: queryPort,
    runner: options.runner,
  });
  const discovery = new RelayV2CanonicalTwRpcDiscoveryAdapter({
    scopes: initial.scopes,
    queryPort,
    queryTimeoutMs: options.queryTimeoutMs,
  });
  return Object.freeze({
    discovery,
    queryPort,
    structuredProcess,
    async reconfigure(): Promise<void> {
      let next: ReturnType<typeof build>;
      try {
        next = build(configLoader());
        new RelayV2CanonicalTwRpcDiscoveryAdapter({
          scopes: next.scopes,
          queryPort: next.validator,
          queryTimeoutMs: options.queryTimeoutMs,
        });
      } catch (error) {
        queryPort.beginContentAddressedTargetTransition();
        await discovery.withdrawAfterRetirement();
        throw error;
      }
      queryPort.beginContentAddressedTargetTransition();
      await discovery.reconfigureAfterRetirement({
        scopes: next.scopes,
        queryPort,
        queryTimeoutMs: options.queryTimeoutMs,
      }, () => queryPort.installContentAddressedTargets(next.descriptors));
    },
  });
}
