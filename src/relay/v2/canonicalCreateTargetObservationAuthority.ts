import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  parseCreateTargetObservationV1Request,
  parseCreateTargetObservationV1Response,
  type CreateTargetObservationV1Response,
} from "../../createTargetObservationV1.js";
import type {
  RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
  RelayV2CanonicalCreateTargetAuthorityInputV1,
  RelayV2CanonicalCreateTargetAuthorityPortV1,
} from "./canonicalCommandTargetAuthorityAdapter.js";
import type {
  RelayV2CanonicalStructuredProcessTargetLookupPort,
} from "./canonicalStructuredProcessAdapter.js";
import type {
  RelayV2CanonicalStructuredProcessInvocation,
  RelayV2CanonicalTwRpcQueryProcessHandle,
  RelayV2CanonicalTwRpcQueryProcessRunner,
} from "./canonicalTwRpcQueryTransportAdapter.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
} from "./strictJson.js";

export const RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_STDOUT_BYTES = 65_536;
export const RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_STDERR_BYTES = 65_536;
export const RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_PENDING = 64;
export const RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_TIMEOUT_MS = 600_000;
export const RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_DEFAULT_TIMEOUT_MS = 30_000;

const AUTHORITY_TOKEN_PREFIX = "twobs1.";
const AUTHORITY_TOKEN_DOMAIN = "tmux-worktree.relay-v2.create-target-observation.authority-token\0";
const MAX_INVOCATION_ARGV_ITEMS = 64;
const MAX_INVOCATION_ARGV_BYTES = 1_179_648;
const SNAPSHOT_MAX_DEPTH = 24;
const SNAPSHOT_MAX_NODES = 4_096;
const SNAPSHOT_MAX_KEYS = 1_024;
const SNAPSHOT_MAX_BYTES = 1_048_576;
const RESPONSE_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 64,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
});

export type RelayV2CanonicalCreateTargetObservationErrorCode =
  | "INVALID_REQUEST"
  | "TARGET_UNAVAILABLE"
  | "OBSERVATION_STALE"
  | "OBSERVATION_CONSUMED";

export class RelayV2CanonicalCreateTargetObservationError extends Error {
  constructor(readonly code: RelayV2CanonicalCreateTargetObservationErrorCode) {
    super(`canonical create target observation authority failed: ${code}`);
    this.name = "RelayV2CanonicalCreateTargetObservationError";
  }
}

/**
 * Narrow read of the fenced-evidence store the admission adapter consumes.
 * Rows are keyed by the opaque authority token and each is consumed exactly
 * once by presenting the exact evidence identity (operation, arguments,
 * closed execution, and the reservation correlation carrying the fenced
 * command fingerprint); concurrent evidences over an identical execution
 * occupy independent rows and never overwrite each other.
 */
export interface RelayV2CanonicalCreateTargetAdmissionLookupPortV1 {
  consumeAdmittedCatalogRevision(binding: unknown): string;
}

export interface RelayV2CanonicalCreateTargetObservationAuthorityOptions {
  targets: RelayV2CanonicalStructuredProcessTargetLookupPort;
  runner: RelayV2CanonicalTwRpcQueryProcessRunner;
  timeoutMs?: number;
  now?: () => number;
}

interface CreateTargetCommandIdentity {
  commandId: string;
  principalId: string;
  hostId: string;
  hostEpoch: string;
  requestFingerprint: Record<string, unknown>;
}

interface NormalizedObservationInput {
  operation: "create_worktree" | "create_terminal";
  kind: "local" | "ssh";
  targetId: string;
  command: CreateTargetCommandIdentity;
}

interface PendingObservationRecord {
  input: unknown;
  evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1;
  targetKey: string;
  catalogRevision: string;
  command: CreateTargetCommandIdentity;
}

interface AdmittedObservationRecord {
  operation: "create_worktree" | "create_terminal";
  arguments: unknown;
  execution: unknown;
  catalogRevision: string;
  command: CreateTargetCommandIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Boundary hardening: untrusted records must be plain, non-Proxy objects
 * whose own keys are exactly the expected string keys (no extra symbol or
 * non-enumerable own keys, no accessors, no lazy Proxy traps at read time).
 * Values are read exactly once, here, into a private normalized shape.
 */
export function dataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value) || nodeTypes.isProxy(value)) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  if (Reflect.ownKeys(value).length !== expected.length) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  const out: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    out[key] = descriptor.value;
  }
  return out;
}

interface SnapshotBudget {
  nodes: number;
  keys: number;
  bytes: number;
}

function snapshotFail(): never {
  throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
}

/**
 * One-time bounded deep own-data snapshot of a foreign value into private
 * plain data; the per-record schema (exact keys, value bounds) is enforced by
 * the dataRecord/normalize* checks at each use site, this walk enforces the
 * structural budgets: depth, total nodes (every container, every primitive,
 * and every array element counts), total keys (every own key and every array
 * index counts), and total UTF-8 bytes (string values and property names).
 * Proxies, accessors, cycles, symbol keys/values, functions, explicit
 * undefined values, thenables (an own `then` key, detected from its
 * descriptor without ever reading a foreign `.then`), and non-finite numbers
 * all fail closed; oversized arrays and keys fail before any copy. After
 * this snapshot no code path re-reads the foreign object.
 */
export function ownDataSnapshot(value: unknown): unknown {
  return snapshotValue(value, { nodes: 0, keys: 0, bytes: 0 }, 0, new Set());
}

function snapshotValue(
  value: unknown,
  budget: SnapshotBudget,
  depth: number,
  seen: Set<object>,
): unknown {
  // Every visited value — container or primitive — counts one node.
  budget.nodes += 1;
  if (budget.nodes > SNAPSHOT_MAX_NODES || depth >= SNAPSHOT_MAX_DEPTH) snapshotFail();
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string") {
    budget.bytes += Buffer.byteLength(value as string, "utf8");
    if (budget.bytes > SNAPSHOT_MAX_BYTES) snapshotFail();
    return value;
  }
  if (kind === "boolean") return value;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) snapshotFail();
    return value;
  }
  if (kind !== "object") snapshotFail();
  if (nodeTypes.isProxy(value) || seen.has(value as object)) snapshotFail();
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) {
        snapshotFail();
      }
      // Every array index counts one key, charged up front so an oversized
      // dense array fails before any copy; each element then counts exactly
      // one node when it is visited below.
      budget.keys += value.length;
      if (budget.keys > SNAPSHOT_MAX_KEYS) {
        snapshotFail();
      }
      const out: unknown[] = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        budget.bytes += Buffer.byteLength(String(index), "utf8");
        if (budget.bytes > SNAPSHOT_MAX_BYTES) snapshotFail();
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) snapshotFail();
        out[index] = snapshotValue(descriptor.value, budget, depth + 1, seen);
      }
      return out;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) snapshotFail();
    const keys = Reflect.ownKeys(value as object);
    budget.keys += keys.length;
    if (budget.keys > SNAPSHOT_MAX_KEYS) snapshotFail();
    // Every own key counts one key and its property-name UTF-8 bytes count
    // toward total bytes; every key-level failure closes before any value is
    // copied out of the foreign object.
    for (const key of keys) {
      if (typeof key === "symbol" || key === "then") snapshotFail();
      budget.bytes += Buffer.byteLength(key, "utf8");
      if (budget.bytes > SNAPSHOT_MAX_BYTES) snapshotFail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
        snapshotFail();
      }
    }
    const out: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      out[key] = snapshotValue(
        (Object.getOwnPropertyDescriptor(value, key) as { value: unknown }).value,
        budget,
        depth + 1,
        seen,
      );
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

/** Dense, non-Proxy, own-data string array (e.g. an invocation argv). */
export function ownDataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  const out: string[] = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    out[index] = descriptor.value;
  }
  return out;
}

export function bounded(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  return value;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Captures a foreign stream's async-iterator callable exactly once (a single
 * prototype-chain descriptor walk, no property re-reads afterwards) and
 * returns a private single-claim iterable whose iteration applies the
 * captured callable to the original receiver. A Proxy at any prototype-chain
 * level fails closed before any descriptor read, so no Proxy trap ever runs.
 */
function captureAsyncStream(value: unknown): AsyncIterable<Uint8Array> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  let holder: object | null = value as object;
  let callable: unknown;
  for (;;) {
    if (holder === null) break;
    if (nodeTypes.isProxy(holder)) {
      throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
    }
    const descriptor = Object.getOwnPropertyDescriptor(holder, Symbol.asyncIterator);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
      }
      callable = descriptor.value;
      break;
    }
    holder = Object.getPrototypeOf(holder);
  }
  if (typeof callable !== "function" || nodeTypes.isProxy(callable)) {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  const receiver = value;
  const iterator = callable as (this: unknown) => AsyncIterator<Uint8Array>;
  let claimed = false;
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (claimed) {
        throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
      }
      claimed = true;
      return Reflect.apply(iterator, receiver, []);
    },
  });
}

function normalizeRequestFingerprint(value: unknown): Record<string, unknown> {
  const fingerprint = dataRecord(value, ["schemaVersion", "algorithm", "digest"]);
  if (fingerprint.schemaVersion !== 1) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  return {
    schemaVersion: 1,
    algorithm: bounded(fingerprint.algorithm),
    digest: bounded(fingerprint.digest),
  };
}

function normalizeInput(value: unknown): NormalizedObservationInput {
  const input = dataRecord(value, ["schemaVersion", "request", "resourceTarget"]);
  if (input.schemaVersion !== 1) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  const request = dataRecord(input.request, [
    "fingerprintSchemaVersion", "commandId", "requestFingerprint", "authority", "operation",
    "principalId", "hostId", "hostEpoch", "scopeId", "sessionId", "arguments",
  ]);
  if ((request.operation !== "create_worktree" && request.operation !== "create_terminal")
    || request.sessionId !== null
    || !isRecord(request.arguments)) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  const resourceTarget = dataRecord(input.resourceTarget, [
    "authorization", "hostEpoch", "discoveryGeneration", "scopeId", "processTarget",
    "capabilities",
  ]);
  const processTarget = dataRecord(resourceTarget.processTarget, ["kind", "targetId"]);
  if ((processTarget.kind !== "local" && processTarget.kind !== "ssh")) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  return {
    operation: request.operation,
    kind: processTarget.kind,
    targetId: bounded(processTarget.targetId),
    command: {
      commandId: bounded(request.commandId),
      principalId: bounded(request.principalId),
      hostId: bounded(request.hostId),
      hostEpoch: bounded(request.hostEpoch),
      requestFingerprint: normalizeRequestFingerprint(request.requestFingerprint),
    },
  };
}

function normalizeEvidence(
  value: unknown,
  operation: "create_worktree" | "create_terminal",
): string {
  const evidence = dataRecord(value, [
    "schemaVersion", "authorityToken", "operation", "arguments", "execution",
    "catalogRevision", "publicDisplayName", "prospectiveSession",
  ]);
  if (evidence.schemaVersion !== 1
    || evidence.operation !== operation
    || !isRecord(evidence.arguments)
    || !isRecord(evidence.execution)
    || !isRecord(evidence.prospectiveSession)) {
    throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
  }
  bounded(evidence.catalogRevision);
  return bounded(evidence.authorityToken);
}

export function normalizeInvocation(value: unknown): RelayV2CanonicalStructuredProcessInvocation {
  let invocation: Record<string, unknown>;
  let argv: string[];
  try {
    invocation = dataRecord(value, ["executable", "argv"]);
    argv = ownDataStringArray(invocation.argv);
  } catch {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  if (argv.length < 1
    || argv.length > MAX_INVOCATION_ARGV_ITEMS
    || argv.some((item) => item.includes("\0") || Buffer.byteLength(item, "utf8") > 1_048_576)) {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  let executable: string;
  try {
    executable = bounded(invocation.executable, 4_096);
  } catch {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  if (argv.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0)
    > MAX_INVOCATION_ARGV_BYTES) {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  return Object.freeze({ executable, argv: Object.freeze(argv) });
}

/**
 * Own-data validation of the spawned handle; the returned kill invokes the
 * validated function through Reflect.apply with the original handle as
 * receiver, so no method is ever re-bound to a copied receiver. Streams have
 * their async-iterator callables captured exactly once against their original
 * receivers; Proxies are refused outright, and `exited` must be a genuine
 * same-realm Promise — a Proxy-wrapped or otherwise foreign thenable fails
 * closed here and is never assimilated by the collector.
 */
export function normalizeProcessHandle(value: unknown): RelayV2CanonicalTwRpcQueryProcessHandle {
  let handle: Record<string, unknown>;
  let stdout: AsyncIterable<Uint8Array>;
  let stderr: AsyncIterable<Uint8Array>;
  try {
    handle = dataRecord(value, ["stdout", "stderr", "exited", "kill"]);
    stdout = captureAsyncStream(handle.stdout);
    stderr = captureAsyncStream(handle.stderr);
  } catch {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  if (nodeTypes.isProxy(handle.exited)
    || !(handle.exited instanceof Promise)
    || Object.getPrototypeOf(handle.exited) !== Promise.prototype
    || typeof handle.kill !== "function"
    || nodeTypes.isProxy(handle.kill)) {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  const original = value as object;
  const kill = handle.kill as (signal: string) => void;
  return Object.freeze({
    stdout,
    stderr,
    exited: handle.exited,
    kill: (signal: string) => {
      Reflect.apply(kill, original, [signal]);
    },
  }) as unknown as RelayV2CanonicalTwRpcQueryProcessHandle;
}

/**
 * Bounded read; the first overflowing chunk kills the child and is never
 * returned, and the reader keeps discarding until EOF so the caller's drain
 * barrier stays authoritative.
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
      throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
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
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function asObservationFailure(error: unknown): RelayV2CanonicalCreateTargetObservationError {
  return error instanceof RelayV2CanonicalCreateTargetObservationError
    ? error
    : new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
}

export interface RelayV2CanonicalCreateTargetObservationProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Exact own-data validation of the process exit record. */
function normalizeExitRecord(exit: unknown): { exitCode: number | null; signal: string | null } {
  let record: Record<string, unknown>;
  try {
    record = dataRecord(exit, ["exitCode", "signal"]);
  } catch {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  if ((record.exitCode !== null && !Number.isSafeInteger(record.exitCode))
    || (record.signal !== null && typeof record.signal !== "string")) {
    throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
  }
  return {
    exitCode: record.exitCode as number | null,
    signal: record.signal as string | null,
  };
}

/**
 * One bounded spawn/kill/drain cycle. Any exit/stream failure or the timeout
 * still awaits the full `Promise.allSettled([exited, stdout, stderr])` drain
 * barrier before throwing: after kill() the drain is authoritative and
 * truncated bytes are never returned, matching the structured mutation lane.
 */
export async function collectRelayV2CanonicalObservationProcess(
  handle: RelayV2CanonicalTwRpcQueryProcessHandle,
  timeoutMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
): Promise<RelayV2CanonicalCreateTargetObservationProcessResult> {
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
  }, timeoutMs);
  try {
    // The handle boundary already proved `exited` a genuine Promise; the
    // collector chains it directly and never assimilates a foreign thenable.
    const exited = handle.exited.then(normalizeExitRecord);
    const stdout = readBounded(handle.stdout, maxStdoutBytes, requestKill);
    const stderr = readBounded(handle.stderr, maxStderrBytes, requestKill);
    const completed = Promise.all([exited, stdout, stderr]);
    const outcome = await Promise.race([
      completed.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      timeoutStarted.then(() => ({ kind: "timed_out" as const })),
    ]);
    if (outcome.kind === "timed_out" || timedOut) {
      await Promise.allSettled([exited, stdout, stderr]);
      throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
    }
    if (outcome.kind === "failed") {
      requestKill();
      await Promise.allSettled([exited, stdout, stderr]);
      throw asObservationFailure(outcome.error);
    }
    const [exit, stdoutBytes, stderrBytes] = outcome.value;
    if (exit.exitCode !== 0 || exit.signal !== null) {
      throw new RelayV2CanonicalCreateTargetObservationError("TARGET_UNAVAILABLE");
    }
    return { exitCode: exit.exitCode, stdout: stdoutBytes, stderr: stderrBytes };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default-off RelayV2CanonicalCreateTargetAuthorityPortV1 observation store.
 * The execution-pair issuer in the create target admission module constructs
 * exactly one instance per pair, over the bundled live targets lookup and
 * captured runner of one canonical query transport owner. Each resolve spawns
 * exactly one `tw create-target-observation-v1` companion process on the
 * exact H2 process target and freezes the target-authoritative catalog
 * observation under a one-shot authority token keyed to the observed catalog
 * revision. Catalog drift revokes every pending token for that target; the
 * admission fence is fully synchronous, consumes its token exactly once,
 * exact-compares the evidence (catalogRevision included), and hands the
 * fenced observation to an admitted store keyed by that opaque token.
 * Exactly one companion admit consumes one row, and only by presenting the
 * exact evidence identity — operation, arguments, closed execution, and a
 * reservation correlation carrying the fenced command fingerprint. Any
 * replay, foreign, stale, or mismatched admission fails closed. It never
 * retries, never falls back to v1 or direct SSH/git/tmux mutation, and
 * advertises no capability.
 */
export class RelayV2CanonicalCreateTargetObservationAuthority
implements RelayV2CanonicalCreateTargetAuthorityPortV1,
  RelayV2CanonicalCreateTargetAdmissionLookupPortV1 {
  private readonly targets: RelayV2CanonicalStructuredProcessTargetLookupPort;

  private readonly runner: RelayV2CanonicalTwRpcQueryProcessRunner;

  private readonly timeoutMs: number;

  private readonly now: () => number;

  private readonly pending = new Map<string, PendingObservationRecord>();

  private readonly admitted = new Map<string, AdmittedObservationRecord>();

  private readonly latestRevision = new Map<string, string>();

  /**
   * Process-local per-instance ordinal, fed only into the authority-token
   * digest input so concurrently live instances never mint colliding tokens.
   * It is not a verifiable prefix or an ownership proof: cross-instance
   * isolation comes from this instance's private pending/admitted
   * registries, which only ever hold rows this instance fenced itself.
   */
  private readonly instanceOrdinal: number;

  private counter = 0;

  constructor(options: RelayV2CanonicalCreateTargetObservationAuthorityOptions) {
    if (!isRecord(options)
      || !hasExactKeys(options, ["targets", "runner"], ["timeoutMs", "now"])
      || !isRecord(options.targets)
      || typeof options.targets.structuredProcessInvocation !== "function"
      || !isRecord(options.runner)
      || typeof options.runner.spawn !== "function") {
      throw new TypeError("invalid canonical create target observation authority options");
    }
    if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs)
        || options.timeoutMs < 1
        || options.timeoutMs > RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_TIMEOUT_MS)) {
      throw new TypeError("invalid canonical create target observation timeout");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("invalid canonical create target observation clock");
    }
    this.targets = options.targets;
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs
      ?? RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    authorityInstanceCounter += 1;
    this.instanceOrdinal = authorityInstanceCounter;
  }

  private async observe(
    input: NormalizedObservationInput,
    requestJson: string,
  ): Promise<CreateTargetObservationV1Response> {
    let invocation: RelayV2CanonicalStructuredProcessInvocation;
    try {
      invocation = normalizeInvocation(this.targets.structuredProcessInvocation(
        input.kind,
        input.targetId,
        ["create-target-observation-v1", "--request-json", requestJson],
        this.timeoutMs,
      ));
    } catch (error) {
      throw asObservationFailure(error);
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
    } catch (error) {
      throw asObservationFailure(error);
    }
    const result = await collectRelayV2CanonicalObservationProcess(
      handle,
      this.timeoutMs,
      RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_STDOUT_BYTES,
      RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_STDERR_BYTES,
    );
    const text = decodeRelayV2StrictUtf8(result.stdout);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    try {
      return parseCreateTargetObservationV1Response(
        parseRelayV2JsonObject(text.slice(0, -1), RESPONSE_JSON_LIMITS),
      );
    } catch {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
  }

  async resolveCreateTarget(
    rawInput: RelayV2CanonicalCreateTargetAuthorityInputV1,
  ): Promise<RelayV2CanonicalCreateTargetAuthorityEvidenceV1> {
    // One deep own-data snapshot; every later read (before and after the
    // await below) touches only this private copy, never the foreign input.
    const inputSnapshot = ownDataSnapshot(rawInput);
    const input = normalizeInput(inputSnapshot);
    let companionRequest: ReturnType<typeof parseCreateTargetObservationV1Request>;
    try {
      companionRequest = parseCreateTargetObservationV1Request({
        schemaVersion: 1,
        mode: "observe",
        operation: input.operation,
        arguments: (inputSnapshot as RelayV2CanonicalCreateTargetAuthorityInputV1).request.arguments,
      });
    } catch {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    const response = await this.observe(input, JSON.stringify(companionRequest));
    if (response.observation.operation !== input.operation
      || !same(response.observation.arguments, companionRequest.arguments)) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }

    const targetKey = `${input.kind} ${input.targetId}`;
    if (this.latestRevision.get(targetKey) !== response.catalogRevision) {
      // Catalog drift: every earlier observation of this target fails closed.
      for (const [token, record] of this.pending) {
        if (record.targetKey === targetKey) this.pending.delete(token);
      }
      this.latestRevision.set(targetKey, response.catalogRevision);
    }

    this.counter += 1;
    const authorityToken = `${AUTHORITY_TOKEN_PREFIX}${createHash("sha256")
      .update(AUTHORITY_TOKEN_DOMAIN, "utf8")
      .update(canonicalJson({
        instance: this.instanceOrdinal,
        input: inputSnapshot,
        response,
        counter: this.counter,
      }), "utf8")
      .digest("base64url")}`;
    const observedAtMs = this.now();
    const observation = response.observation;
    const evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1 = observation.operation === "create_worktree"
      ? {
        schemaVersion: 1,
        authorityToken,
        operation: "create_worktree",
        arguments: clone(observation.arguments),
        execution: clone(observation.execution),
        catalogRevision: response.catalogRevision,
        publicDisplayName: observation.execution.publicDisplayName,
        prospectiveSession: {
          kind: "worktree",
          displayName: observation.execution.publicDisplayName,
          state: "running",
          project: observation.execution.effectiveProject,
          label: null,
          cwd: observation.execution.worktreePath,
          attached: false,
          windowCount: 1,
          createdAtMs: observedAtMs,
          activityAtMs: observedAtMs,
        },
      }
      : {
        schemaVersion: 1,
        authorityToken,
        operation: "create_terminal",
        arguments: clone(observation.arguments),
        execution: clone(observation.execution),
        catalogRevision: response.catalogRevision,
        publicDisplayName: observation.execution.publicDisplayName,
        prospectiveSession: {
          kind: "terminal",
          displayName: observation.execution.publicDisplayName,
          state: "running",
          project: null,
          label: observation.execution.publicDisplayName,
          cwd: observation.execution.canonicalCwd,
          attached: false,
          windowCount: 1,
          createdAtMs: observedAtMs,
          activityAtMs: observedAtMs,
        },
      };

    if (this.pending.size >= RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value as string);
    }
    this.pending.set(authorityToken, {
      input: inputSnapshot,
      evidence: clone(evidence),
      targetKey,
      catalogRevision: response.catalogRevision,
      command: input.command,
    });
    return evidence;
  }

  fenceCreateTargetForAdmission(
    rawInput: RelayV2CanonicalCreateTargetAuthorityInputV1,
    rawEvidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
  ): void {
    const inputSnapshot = ownDataSnapshot(rawInput);
    const evidenceSnapshot = ownDataSnapshot(rawEvidence);
    const input = normalizeInput(inputSnapshot);
    const authorityToken = normalizeEvidence(evidenceSnapshot, input.operation);
    const record = this.pending.get(authorityToken);
    if (record === undefined) {
      throw new RelayV2CanonicalCreateTargetObservationError("OBSERVATION_CONSUMED");
    }
    if (!same(record.input, inputSnapshot) || !same(record.evidence, evidenceSnapshot)) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    if (this.latestRevision.get(record.targetKey) !== record.catalogRevision) {
      this.pending.delete(authorityToken);
      throw new RelayV2CanonicalCreateTargetObservationError("OBSERVATION_STALE");
    }
    this.pending.delete(authorityToken);
    // Exactly one companion admit may be built from this fenced observation;
    // the row is keyed by its opaque authority token so concurrent evidences
    // over an identical execution never overwrite each other. The terminal
    // row stores the exact canonical arguments the executor presents at
    // mutation time (canonical cwd + derived label), so observation,
    // admitted store, and executor share one exact argument form.
    const row: AdmittedObservationRecord = {
      operation: record.evidence.operation,
      arguments: record.evidence.operation === "create_terminal"
        ? {
          cwd: record.evidence.execution.canonicalCwd,
          label: record.evidence.execution.publicDisplayName,
        }
        : clone(record.evidence.arguments),
      execution: clone(record.evidence.execution),
      catalogRevision: record.catalogRevision,
      command: record.command,
    };
    if (this.admitted.size >= RELAY_V2_CANONICAL_CREATE_TARGET_OBSERVATION_MAX_PENDING) {
      this.admitted.delete(this.admitted.keys().next().value as string);
    }
    this.admitted.set(authorityToken, row);
  }

  private normalizeAdmittedBinding(binding: unknown): NormalizedAdmittedBinding {
    const snapshot = ownDataSnapshot(binding);
    const normalized = dataRecord(snapshot, [
      "operation", "arguments", "execution", "reservationCorrelation",
    ]);
    if ((normalized.operation !== "create_worktree" && normalized.operation !== "create_terminal")
      || !isRecord(normalized.arguments)
      || !isRecord(normalized.execution)) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    const correlation = dataRecord(normalized.reservationCorrelation, [
      "schemaVersion", "reservationId", "hostEpoch", "principalId", "hostId", "commandId",
      "requestFingerprint",
    ]);
    if (correlation.schemaVersion !== 1) {
      throw new RelayV2CanonicalCreateTargetObservationError("INVALID_REQUEST");
    }
    bounded(correlation.reservationId);
    return {
      operation: normalized.operation,
      arguments: normalized.arguments,
      execution: normalized.execution,
      command: {
        commandId: bounded(correlation.commandId),
        principalId: bounded(correlation.principalId),
        hostId: bounded(correlation.hostId),
        hostEpoch: bounded(correlation.hostEpoch),
        requestFingerprint: normalizeRequestFingerprint(correlation.requestFingerprint),
      },
    };
  }

  /**
   * Synchronously consumes the one admitted row matching the exact evidence
   * identity — operation, arguments, closed execution, and a reservation
   * correlation whose commandId, principal, host, epoch, and request
   * fingerprint equal the fenced command's — and returns its catalog
   * revision. Unknown, replayed, ambiguous, or malformed bindings fail
   * closed; each row is consumed at most once.
   */
  consumeAdmittedCatalogRevision(binding: unknown): string {
    const normalized = this.normalizeAdmittedBinding(binding);
    const command = normalized.command;
    for (const [token, row] of this.admitted) {
      if (row.operation !== normalized.operation
        || !same(row.arguments, normalized.arguments)
        || !same(row.execution, normalized.execution)
        || row.command.commandId !== command.commandId
        || row.command.principalId !== command.principalId
        || row.command.hostId !== command.hostId
        || row.command.hostEpoch !== command.hostEpoch
        || !same(row.command.requestFingerprint, command.requestFingerprint)) {
        continue;
      }
      this.admitted.delete(token);
      return row.catalogRevision;
    }
    throw new RelayV2CanonicalCreateTargetObservationError("OBSERVATION_CONSUMED");
  }
}

let authorityInstanceCounter = 0;

interface NormalizedAdmittedBinding {
  operation: "create_worktree" | "create_terminal";
  arguments: unknown;
  execution: unknown;
  command: CreateTargetCommandIdentity;
}
