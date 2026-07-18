import { isAbsolute } from "node:path";
import type {
  RelayV2CanonicalTwRpcDiscoveryQuery,
  RelayV2CanonicalTwRpcDiscoveryQueryPort,
} from "./canonicalTwRpcDiscovery.js";
import {
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES,
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SESSIONS_PER_SCOPE,
  RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_QUERY_TIMEOUT_MS,
} from "./canonicalTwRpcDiscovery.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  type RelayV2JsonValue,
} from "./strictJson.js";

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
  user?: string;
  port?: number;
  identityFile?: string;
  /** Must be the literal `tw` lookup or one absolute, shell-safe remote path. */
  twExecutable?: string;
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

export interface RelayV2CanonicalTwRpcQueryTransportAdapterOptions {
  targets: readonly RelayV2CanonicalTwRpcQueryTargetDescriptor[];
  runner: RelayV2CanonicalTwRpcQueryProcessRunner;
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
      user?: string;
      port?: number;
      identityFile?: string;
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
  const executable = boundedString(value ?? "tw");
  if (executable !== "tw"
    && (!executable.startsWith("/") || !/^\/[A-Za-z0-9._+@%=/:-]+$/.test(executable))) {
    throw new TypeError("invalid canonical remote tw executable");
  }
  return executable;
}

function normalizeSshTarget(
  value: Record<string, unknown>,
): Extract<NormalizedTarget, { kind: "ssh" }> {
  if (!hasExactKeys(
    value,
    ["kind", "targetId", "host", "knownHostsFile"],
    ["sshExecutable", "user", "port", "identityFile", "twExecutable"],
  )) {
    throw new TypeError("invalid canonical TW RPC v2 SSH query target");
  }
  const host = boundedString(value.host, 255);
  if (host.startsWith("-") || !/^[A-Za-z0-9._:[\]-]+$/.test(host)) {
    throw new TypeError("invalid canonical TW RPC v2 SSH host");
  }
  const user = value.user === undefined ? undefined : boundedString(value.user, 128);
  if (user !== undefined && !/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new TypeError("invalid canonical TW RPC v2 SSH user");
  }
  const port = value.port;
  if (port !== undefined
    && (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535)) {
    throw new TypeError("invalid canonical TW RPC v2 SSH port");
  }
  return Object.freeze({
    kind: "ssh",
    targetId: boundedString(value.targetId, 128),
    host,
    knownHostsFile: absolutePath(value.knownHostsFile),
    sshExecutable: boundedString(value.sshExecutable ?? "ssh"),
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port: port as number }),
    ...(value.identityFile === undefined
      ? {}
      : { identityFile: absolutePath(value.identityFile) }),
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
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(request.timeoutMs / 1_000))}`,
    ...(target.identityFile === undefined
      ? []
      : ["-o", "IdentitiesOnly=yes", "-i", target.identityFile]),
    ...(target.port === undefined ? [] : ["-p", String(target.port)]),
    ...(target.user === undefined ? [] : ["-l", target.user]),
    "--",
    target.host,
    target.twExecutable,
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

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return value !== null
    && typeof value === "object"
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
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
implements RelayV2CanonicalTwRpcDiscoveryQueryPort {
  private readonly targets: ReadonlyMap<string, NormalizedTarget>;

  private readonly runner: RelayV2CanonicalTwRpcQueryProcessRunner;

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
}
