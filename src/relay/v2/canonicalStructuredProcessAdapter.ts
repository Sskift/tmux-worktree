import { performance } from "node:perf_hooks";

import type {
  RelayV2StructuredProcessPort,
  RelayV2StructuredProcessRequest,
  RelayV2StructuredProcessResult,
} from "./canonicalCommandExecutorAdapter.js";
import type {
  RelayV2CanonicalStructuredProcessInvocation,
  RelayV2CanonicalTwRpcQueryProcessHandle,
  RelayV2CanonicalTwRpcQueryProcessRunner,
} from "./canonicalTwRpcQueryTransportAdapter.js";

export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_TIMEOUT_MS = 600_000;
export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_ARGV_ITEMS = 16;
export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_ARGUMENT_BYTES = 1_048_576;
export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDOUT_BYTES = 1_048_576;
export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDERR_BYTES = 65_536;
export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_INVOCATION_ARGV_ITEMS = 64;
export const RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_INVOCATION_ARGV_BYTES = 1_179_648;

export type RelayV2CanonicalStructuredProcessErrorCode =
  | "INVALID_REQUEST"
  | "OUTPUT_LIMIT"
  | "PROCESS_FAILED"
  | "TARGET_UNAVAILABLE";

export class RelayV2CanonicalStructuredProcessError extends Error {
  constructor(readonly code: RelayV2CanonicalStructuredProcessErrorCode) {
    super(`canonical TW RPC v2 structured process failed: ${code}`);
    this.name = "RelayV2CanonicalStructuredProcessError";
  }
}

/**
 * Narrow live lookup of the fixed local/SSH process-target authority. The
 * production implementation is RelayV2CanonicalTwRpcQueryTransportAdapter.
 * It receives the caller's canonical `tw rpc-v2` argv and returns the exact
 * complete invocation, with SSH arguments already POSIX-encoded by the
 * target authority owner. The lookup is re-evaluated on every execute so
 * retired target generations fail closed instead of invoking stale bindings.
 */
export interface RelayV2CanonicalStructuredProcessTargetLookupPort {
  structuredProcessInvocation(
    kind: "local" | "ssh",
    targetId: string,
    argv: readonly string[],
    timeoutMs: number,
  ): RelayV2CanonicalStructuredProcessInvocation;
}

export interface RelayV2CanonicalStructuredProcessAdapterOptions {
  targets: RelayV2CanonicalStructuredProcessTargetLookupPort;
  runner: RelayV2CanonicalTwRpcQueryProcessRunner;
}

interface NormalizedStructuredProcessRequest {
  target: { kind: "local" | "ssh"; scopeId: string; targetId: string };
  argv: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxResponseFrameBytes: number;
}

interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
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

function boundedId(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new RelayV2CanonicalStructuredProcessError("INVALID_REQUEST");
  }
  return value;
}

function boundedArgument(value: unknown): value is string {
  return typeof value === "string"
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8")
      <= RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_ARGUMENT_BYTES;
}

function boundedLimit(value: unknown, maxBytes: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= maxBytes;
}

function normalizeRequest(value: unknown): NormalizedStructuredProcessRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "target", "executable", "argv", "stdin", "timeoutMs",
      "maxStdoutBytes", "maxStderrBytes", "maxResponseFrameBytes",
    ])
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ["kind", "scopeId", "targetId"])
    || (value.target.kind !== "local" && value.target.kind !== "ssh")
    || value.executable !== "tw"
    || value.stdin !== null
    || !Array.isArray(value.argv)
    || value.argv.length < 2
    || value.argv.length > RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_ARGV_ITEMS
    || value.argv[0] !== "rpc-v2"
    || value.argv.some((item) => !boundedArgument(item))
    || !boundedLimit(value.timeoutMs, RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_TIMEOUT_MS)
    || !boundedLimit(value.maxStdoutBytes, RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDOUT_BYTES)
    || !boundedLimit(value.maxStderrBytes, RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDERR_BYTES)
    || !boundedLimit(
      value.maxResponseFrameBytes,
      RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_STDOUT_BYTES,
    )) {
    throw new RelayV2CanonicalStructuredProcessError("INVALID_REQUEST");
  }
  return {
    target: {
      kind: value.target.kind,
      scopeId: boundedId(value.target.scopeId),
      targetId: boundedId(value.target.targetId),
    },
    argv: Object.freeze([...(value.argv as string[])]),
    timeoutMs: value.timeoutMs as number,
    maxStdoutBytes: value.maxStdoutBytes as number,
    maxStderrBytes: value.maxStderrBytes as number,
    maxResponseFrameBytes: value.maxResponseFrameBytes as number,
  };
}

function normalizeInvocation(value: unknown): RelayV2CanonicalStructuredProcessInvocation {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ["executable", "argv"])
      || !Array.isArray(value.argv)
      || value.argv.length < 1
      || value.argv.length > RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_INVOCATION_ARGV_ITEMS
      || value.argv.some((item) => !boundedArgument(item))) {
      throw new RelayV2CanonicalStructuredProcessError("TARGET_UNAVAILABLE");
    }
    return Object.freeze({
      executable: boundedId(value.executable, 4_096),
      argv: Object.freeze([...(value.argv as string[])]),
    });
  } catch (error) {
    if (error instanceof RelayV2CanonicalStructuredProcessError) throw error;
    throw new RelayV2CanonicalStructuredProcessError("TARGET_UNAVAILABLE");
  }
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
    throw new RelayV2CanonicalStructuredProcessError("PROCESS_FAILED");
  }
  return value as unknown as RelayV2CanonicalTwRpcQueryProcessHandle;
}

function normalizeExit(value: unknown): ProcessExit {
  if (!isRecord(value)
    || !hasExactKeys(value, ["exitCode", "signal"])
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || (value.signal !== null && typeof value.signal !== "string")) {
    throw new RelayV2CanonicalStructuredProcessError("PROCESS_FAILED");
  }
  return {
    exitCode: value.exitCode as number | null,
    signal: value.signal as string | null,
  };
}

/**
 * Reads one stream to EOF inside its hard byte bound. The first overflowing
 * chunk immediately triggers the caller's kill hook, after which the reader
 * keeps discarding until EOF so the overflow failure only propagates once the
 * stream is genuinely drained; truncated bytes are never returned.
 */
async function readBounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  for await (const chunk of source) {
    if (overflowed) continue;
    if (!(chunk instanceof Uint8Array)) {
      throw new RelayV2CanonicalStructuredProcessError("PROCESS_FAILED");
    }
    total += chunk.byteLength;
    if (total > maxBytes) {
      overflowed = true;
      onOverflow();
      continue;
    }
    chunks.push(Uint8Array.from(chunk));
  }
  if (overflowed) {
    throw new RelayV2CanonicalStructuredProcessError("OUTPUT_LIMIT");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function asStructuredFailure(error: unknown): RelayV2CanonicalStructuredProcessError {
  return error instanceof RelayV2CanonicalStructuredProcessError
    ? error
    : new RelayV2CanonicalStructuredProcessError("PROCESS_FAILED");
}

async function collectStructuredProcess(
  handle: RelayV2CanonicalTwRpcQueryProcessHandle,
  request: NormalizedStructuredProcessRequest,
  elapsed: () => number,
): Promise<RelayV2StructuredProcessResult> {
  let killRequested = false;
  let timedOut = false;
  let signalTimeout: (() => void) | undefined;
  const timeoutStarted = new Promise<void>((resolve) => { signalTimeout = resolve; });
  const requestKill = (): void => {
    if (killRequested) return;
    killRequested = true;
    try {
      handle.kill("SIGKILL");
    } catch {
      // The drain below remains authoritative even if kill reports a race.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    requestKill();
    signalTimeout?.();
  }, request.timeoutMs);
  // A well-formed response is exactly one JSON line, so stdout can never
  // honestly exceed maxResponseFrameBytes plus its single trailing LF.
  const maxStdoutFrameBytes = Math.min(
    request.maxStdoutBytes,
    request.maxResponseFrameBytes + 1,
  );
  const exited = Promise.resolve(handle.exited).then(normalizeExit);
  const stdout = readBounded(handle.stdout, maxStdoutFrameBytes, requestKill);
  const stderr = readBounded(handle.stderr, request.maxStderrBytes, requestKill);
  const completed = Promise.all([exited, stdout, stderr]);
  try {
    const outcome = await Promise.race([
      completed.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      timeoutStarted.then(() => ({ kind: "timed_out" as const })),
    ]);
    if (outcome.kind === "timed_out" || timedOut) {
      const [exitSettled, stdoutSettled, stderrSettled] = await Promise.allSettled([
        exited, stdout, stderr,
      ]);
      // Timed-out bytes are returned only when both streams settled inside
      // their bounds; an overflow or broken barrier can never be reported as
      // a bounded capture.
      if (stdoutSettled.status === "rejected") throw asStructuredFailure(stdoutSettled.reason);
      if (stderrSettled.status === "rejected") throw asStructuredFailure(stderrSettled.reason);
      if (exitSettled.status === "rejected") throw asStructuredFailure(exitSettled.reason);
      return {
        kind: "timed_out",
        stdout: stdoutSettled.value,
        stderr: stderrSettled.value,
        elapsedMs: elapsed(),
      };
    }
    if (outcome.kind === "failed") {
      requestKill();
      const [exitSettled, stdoutSettled, stderrSettled] = await Promise.allSettled([
        exited, stdout, stderr,
      ]);
      if (stdoutSettled.status === "rejected") throw asStructuredFailure(stdoutSettled.reason);
      if (stderrSettled.status === "rejected") throw asStructuredFailure(stderrSettled.reason);
      if (exitSettled.status === "rejected"
        && exitSettled.reason instanceof RelayV2CanonicalStructuredProcessError) {
        throw exitSettled.reason;
      }
      // The child error barrier rejected without a bounded-stream failure:
      // the process never reached a clean exit, which is a spawn failure.
      return {
        kind: "spawn_failed",
        stdout: stdoutSettled.value,
        stderr: stderrSettled.value,
        elapsedMs: elapsed(),
      };
    }
    const [exit, stdoutBytes, stderrBytes] = outcome.value;
    if (exit.exitCode === null) {
      throw new RelayV2CanonicalStructuredProcessError("PROCESS_FAILED");
    }
    return {
      kind: "exited",
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout: stdoutBytes,
      stderr: stderrBytes,
      elapsedMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default-off, injectable production RelayV2StructuredProcessPort for
 * canonical `tw rpc-v2` mutations. Every request is resolved against the live
 * fixed local/SSH process-target authority, then invoked exactly once through
 * the injected child-process runner: the configured executable, structured
 * argv with no shell, ignored stdin, bounded stdout/stderr, and a timeout
 * enforced by SIGKILL followed by a full exit/stdout/stderr drain. Unknown or
 * retired targets, byte-limit overflow, and transport failures fail closed
 * instead of truncating into a normal result; there is no retry, no v1 path,
 * and no direct tmux fallback.
 */
export class RelayV2CanonicalStructuredProcessAdapter implements RelayV2StructuredProcessPort {
  private readonly targets: RelayV2CanonicalStructuredProcessTargetLookupPort;

  private readonly runner: RelayV2CanonicalTwRpcQueryProcessRunner;

  constructor(options: RelayV2CanonicalStructuredProcessAdapterOptions) {
    if (!isRecord(options)
      || !hasExactKeys(options, ["targets", "runner"])
      || !isRecord(options.targets)
      || typeof options.targets.structuredProcessInvocation !== "function"
      || !isRecord(options.runner)
      || typeof options.runner.spawn !== "function") {
      throw new TypeError("invalid canonical TW RPC v2 structured process options");
    }
    this.targets = options.targets;
    this.runner = options.runner;
  }

  async execute(
    rawRequest: RelayV2StructuredProcessRequest,
  ): Promise<RelayV2StructuredProcessResult> {
    const startedAt = performance.now();
    const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));
    const request = normalizeRequest(rawRequest);
    let invocation: RelayV2CanonicalStructuredProcessInvocation;
    try {
      invocation = normalizeInvocation(this.targets.structuredProcessInvocation(
        request.target.kind,
        request.target.targetId,
        request.argv,
        request.timeoutMs,
      ));
    } catch (error) {
      if (error instanceof RelayV2CanonicalStructuredProcessError) throw error;
      throw new RelayV2CanonicalStructuredProcessError("TARGET_UNAVAILABLE");
    }
    // The returned invocation is the final argv and is spawned verbatim; it
    // must fit its hard byte cap as a whole, quoting expansion included.
    if (invocation.argv.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0)
      > RELAY_V2_CANONICAL_STRUCTURED_PROCESS_MAX_INVOCATION_ARGV_BYTES) {
      throw new RelayV2CanonicalStructuredProcessError("INVALID_REQUEST");
    }
    let handle: RelayV2CanonicalTwRpcQueryProcessHandle;
    try {
      handle = normalizeProcessHandle(this.runner.spawn(Object.freeze({
        executable: invocation.executable,
        argv: invocation.argv,
        shell: false as const,
        stdin: "ignore" as const,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
      })));
    } catch {
      return {
        kind: "spawn_failed",
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        elapsedMs: elapsed(),
      };
    }
    return collectStructuredProcess(handle, request, elapsed);
  }
}
