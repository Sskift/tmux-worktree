import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  TerminalControlLease,
  TerminalControlOwner,
} from "../../terminalControl/protocol.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import type { RelayV2JsonValue } from "./strictJson.js";

export const RELAY_V2_TERMINAL_STREAM_RING_BYTES = 4 * 1024 * 1024;
export const RELAY_V2_TERMINAL_HOST_RING_BYTES = 64 * 1024 * 1024;
export const RELAY_V2_TERMINAL_MAX_UNACKED_BYTES = 512 * 1024;
export const RELAY_V2_TERMINAL_DETACHED_LEASE_MS = 120_000;
export const RELAY_V2_TERMINAL_CONTROL_RETENTION_MS = 600_000;
export const RELAY_V2_TERMINAL_MAX_FRAME_BYTES = 64 * 1024;
export const RELAY_V2_TERMINAL_INPUT_DEDUPE_ENTRIES = 512;
export const RELAY_V2_TERMINAL_RESIZE_DEDUPE_ENTRIES = 256;
export const RELAY_V2_TERMINAL_MAX_STREAMS = 256;
export const RELAY_V2_TERMINAL_MAX_CONTROL_RECORDS = 4_096;

const MAX_COUNTER = 18_446_744_073_709_551_615n;

export interface RelayV2TerminalLimits {
  streamRingBytes: number;
  hostRingBytes: number;
  maxUnackedBytes: number;
  detachedLeaseMs: number;
  controlRetentionMs: number;
  maxFrameBytes: number;
  inputDedupeEntries: number;
  resizeDedupeEntries: number;
  maxStreams: number;
  maxControlRecords: number;
}

export const RELAY_V2_TERMINAL_LIMITS: Readonly<RelayV2TerminalLimits> = Object.freeze({
  streamRingBytes: RELAY_V2_TERMINAL_STREAM_RING_BYTES,
  hostRingBytes: RELAY_V2_TERMINAL_HOST_RING_BYTES,
  maxUnackedBytes: RELAY_V2_TERMINAL_MAX_UNACKED_BYTES,
  detachedLeaseMs: RELAY_V2_TERMINAL_DETACHED_LEASE_MS,
  controlRetentionMs: RELAY_V2_TERMINAL_CONTROL_RETENTION_MS,
  maxFrameBytes: RELAY_V2_TERMINAL_MAX_FRAME_BYTES,
  inputDedupeEntries: RELAY_V2_TERMINAL_INPUT_DEDUPE_ENTRIES,
  resizeDedupeEntries: RELAY_V2_TERMINAL_RESIZE_DEDUPE_ENTRIES,
  maxStreams: RELAY_V2_TERMINAL_MAX_STREAMS,
  maxControlRecords: RELAY_V2_TERMINAL_MAX_CONTROL_RECORDS,
});

export type RelayV2TerminalErrorCode =
  | "BUSY"
  | "HOST_EPOCH_MISMATCH"
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "TERMINAL_STREAM_NOT_FOUND"
  | "TERMINAL_STREAM_CONFLICT"
  | "TERMINAL_OPEN_CONFLICT"
  | "TERMINAL_CLOSE_CONFLICT"
  | "TERMINAL_ROUTE_STALE"
  | "TERMINAL_GENERATION_STALE"
  | "TERMINAL_OFFSET_EXPIRED"
  | "TERMINAL_INVALID_ACK"
  | "TERMINAL_INPUT_GAP"
  | "TERMINAL_INPUT_CONFLICT"
  | "TERMINAL_RESIZE_GAP"
  | "TERMINAL_RESIZE_CONFLICT"
  | "INTERNAL";

const RELAY_V2_TERMINAL_MANAGER_ERROR = Symbol.for(
  "tmux-worktree.relay-v2.terminal-manager-error",
);

export class RelayV2TerminalManagerError extends Error {
  readonly [RELAY_V2_TERMINAL_MANAGER_ERROR] = true;

  constructor(
    readonly code: RelayV2TerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelayV2TerminalManagerError";
  }
}

export function isRelayV2TerminalManagerError(
  error: unknown,
): error is RelayV2TerminalManagerError {
  return !!error
    && typeof error === "object"
    && (error as Record<PropertyKey, unknown>)[RELAY_V2_TERMINAL_MANAGER_ERROR] === true;
}

export interface RelayV2TerminalAuthContext {
  principalId: string;
  clientInstanceId: string;
}

/** Frozen public route lineage. This is the only route shape allowed durably. */
export interface RelayV2TerminalRoute {
  connectorId: string;
  routeId: string;
  routeFence: string;
}

declare const RELAY_V2_TERMINAL_RUNTIME_BINDING_TOKEN: unique symbol;

export type RelayV2TerminalRuntimeBindingToken = string & {
  readonly [RELAY_V2_TERMINAL_RUNTIME_BINDING_TOKEN]: true;
};

/** Process-local runtime↔H3 envelope. Never persisted or put on the wire. */
export interface RelayV2TerminalRuntimeBinding extends RelayV2TerminalRoute {
  runtimeBindingToken: RelayV2TerminalRuntimeBindingToken;
}

export function createRelayV2TerminalRuntimeBinding(
  route: RelayV2TerminalRoute,
  runtimeBindingToken: string,
): RelayV2TerminalRuntimeBinding {
  if (!isOpaqueId(route.connectorId)
    || !isOpaqueId(route.routeId)
    || !isOpaqueId(route.routeFence)
    || !isOpaqueId(runtimeBindingToken)) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal runtime binding is invalid");
  }
  return Object.freeze({
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
    runtimeBindingToken: runtimeBindingToken as RelayV2TerminalRuntimeBindingToken,
  });
}

export interface RelayV2TerminalWireTarget {
  hostId: string;
  scopeId: string;
  sessionId: string;
}

export interface RelayV2TerminalResolvedTarget extends RelayV2TerminalWireTarget {
  pane: number;
  /** Opaque H2 lifecycle identity. It is never part of a wire fingerprint. */
  canonicalTargetId: string;
  /** Opaque terminal-control identity, supplied only by the canonical resolver. */
  controlTargetId: string;
}

export interface RelayV2TerminalCanonicalResolver {
  resolve(input: {
    auth: RelayV2TerminalAuthContext;
    hostEpoch: string;
    target: RelayV2TerminalWireTarget;
    pane: number;
  }): Promise<RelayV2TerminalResolvedTarget>;
}

export interface RelayV2TerminalRequestContext {
  auth: RelayV2TerminalAuthContext;
  route: RelayV2TerminalRuntimeBinding;
  requestId: string;
  expectedHostEpoch: string;
  target: RelayV2TerminalWireTarget;
  streamId: string;
}

export interface RelayV2TerminalResume {
  generation: string;
  nextOffset: string;
  resumeToken: string;
}

export interface RelayV2TerminalOpenRequest extends RelayV2TerminalRequestContext {
  openId: string;
  pane: number;
  cols: number;
  rows: number;
  mode: "new" | "resume" | "reset";
  resume?: RelayV2TerminalResume;
}

/**
 * Process-local H3 callback evidence for an origin=open reset response. The
 * durable winner may contain a generation/offset that did not exist in the
 * original mode=new/reset request. This evidence is never wire or durable
 * state; the runtime consumes it only to arm its exact pending correlation.
 */
export interface RelayV2TerminalOpenResponseLineage {
  owner: "terminal.open";
  requestId: string;
  openId: string;
  mode: "new" | "resume" | "reset";
  generation: string | null;
  requestedOffset: string | null;
}

export interface RelayV2TerminalReplayRequest extends RelayV2TerminalRequestContext {
  generation: string;
  fromOffset: string;
}

export interface RelayV2TerminalCloseRequest extends RelayV2TerminalRequestContext {
  closeId: string;
  generation: string;
  resumeToken: string;
}

export interface RelayV2TerminalStreamContext {
  auth: RelayV2TerminalAuthContext;
  route: RelayV2TerminalRuntimeBinding;
  streamId: string;
  generation: string;
}

export interface RelayV2TerminalOutputAck extends RelayV2TerminalStreamContext {
  nextOffset: string;
}

export interface RelayV2TerminalInput extends RelayV2TerminalStreamContext {
  inputSeq: string;
  data: Uint8Array;
}

export interface RelayV2TerminalResize extends RelayV2TerminalStreamContext {
  resizeSeq: string;
  cols: number;
  rows: number;
}

export type RelayV2TerminalCloseReason =
  | "client_closed"
  | "backend_exit"
  | "backend_error";

export type RelayV2TerminalResetReason =
  | "generation_stale"
  | "offset_expired"
  | "stream_lost"
  | "slow_consumer"
  | "host_buffer_pressure";

export interface RelayV2TerminalBackendClose {
  reason: "backend_exit" | "backend_error";
  exitCode: number | null;
}

export interface RelayV2TerminalBackendObserver {
  /**
   * The backend must await every callback in source order and deliver onClosed
   * only after the final onBytes callback has completed. Each callback must be
   * no larger than maxChunkBytes passed to open; oversize is a hard backend
   * protocol failure and is rejected before the manager copies it.
   */
  onBytes(data: Uint8Array): Promise<void>;
  onClosed(result: RelayV2TerminalBackendClose): Promise<void>;
}

export interface RelayV2TerminalByteHandle {
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Attachment-local display hint only; it must never resize the shared target. */
  setDisplaySizeHint(size: { cols: number; rows: number }): Promise<void>;
  /**
   * Closes only this observation attachment; it does not mutate the canonical
   * terminal target.
   * It must not wait for an observer callback, because callbacks re-enter the
   * manager serializer after the generation has already been fenced.
   */
  close(): Promise<void>;
}

export interface RelayV2TerminalByteBackend {
  /**
   * Opens a raw-byte observation attachment. Implementations must return the
   * handle before awaiting an observer callback, so terminal.opened remains the
   * first frame for the generation.
   */
  open(
    target: RelayV2TerminalResolvedTarget,
    options: {
      maxChunkBytes: number;
      displaySizeHint: { cols: number; rows: number };
    },
    observer: RelayV2TerminalBackendObserver,
  ): Promise<RelayV2TerminalByteHandle>;
}

export interface RelayV2TerminalStructuredError {
  code:
    | "PERMISSION_DENIED"
    | "BUSY"
    | "SLOW_CONSUMER"
    | "SCOPE_NOT_FOUND"
    | "SCOPE_UNREACHABLE"
    | "SESSION_NOT_FOUND"
    | "PANE_NOT_FOUND"
    | "TERMINAL_INPUT_GAP"
    | "TERMINAL_INPUT_CONFLICT"
    | "TERMINAL_RESIZE_GAP"
    | "TERMINAL_RESIZE_CONFLICT"
    | "COMMAND_IN_DOUBT"
    | "INTERNAL";
  message: string;
  retryable: boolean;
  details?: RelayV2JsonValue;
  commandDisposition?: "not_applicable" | "in_doubt";
}

export type RelayV2TerminalAuthorityResult =
  | { accepted: true }
  | {
      accepted: false;
      uncertain: boolean;
      error: RelayV2TerminalStructuredError;
    };

export type RelayV2TerminalLeaseResult =
  | { status: "accepted"; lease: RelayV2TerminalProducerLease }
  | { status: "rejected"; error: RelayV2TerminalStructuredError }
  | { status: "uncertain"; error: RelayV2TerminalStructuredError };

export interface RelayV2TerminalAuthorityInput {
  target: RelayV2TerminalResolvedTarget;
  auth: RelayV2TerminalAuthContext;
  owner: TerminalControlOwner;
  lease: RelayV2TerminalProducerLease;
  operationId: string;
  data: Uint8Array;
}

export interface RelayV2TerminalAuthorityResize {
  target: RelayV2TerminalResolvedTarget;
  auth: RelayV2TerminalAuthContext;
  owner: TerminalControlOwner;
  lease: RelayV2TerminalProducerLease;
  operationId: string;
  cols: number;
  rows: number;
}

export type RelayV2TerminalProducerLease = TerminalControlLease;

export interface RelayV2TerminalControlAuthority {
  acquire(input: {
    target: RelayV2TerminalResolvedTarget;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
  }): Promise<RelayV2TerminalLeaseResult>;
  renew(input: {
    target: RelayV2TerminalResolvedTarget;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
    lease: RelayV2TerminalProducerLease;
  }): Promise<RelayV2TerminalLeaseResult>;
  release(input: {
    target: RelayV2TerminalResolvedTarget;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
    lease: RelayV2TerminalProducerLease;
  }): Promise<void>;
  hasContinuity(input: {
    target: RelayV2TerminalResolvedTarget;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
    lease: RelayV2TerminalProducerLease;
  }): Promise<boolean>;
  writeInput(input: RelayV2TerminalAuthorityInput): Promise<RelayV2TerminalAuthorityResult>;
  resize(input: RelayV2TerminalAuthorityResize): Promise<RelayV2TerminalAuthorityResult>;
}

export interface RelayV2TerminalDurableOpenClaim {
  key: string;
  streamKey: string;
  fingerprint: string;
  hostInstanceId: string;
  mode: "new" | "resume" | "reset";
  previousGeneration: string | null;
  /** Non-sensitive recovery evidence for pending resume/reset claims. */
  requestedOffset: string | null;
  expiresAtMs: number;
}

export type RelayV2TerminalDurableOpenOutcome =
  | {
      kind: "opened";
      generation: string;
      /** One-way evidence only. Durable implementations must never retain the token. */
      resumeTokenHash: string;
      disposition: "new" | "resumed" | "reset";
      replayFromOffset: string;
    }
  | {
      kind: "reset";
      generation: string | null;
      reason: RelayV2TerminalResetReason;
      requestedOffset: string | null;
      bufferStartOffset: string | null;
      tailOffset: string | null;
    }
  | {
      kind: "error";
      code: "BUSY" | "TERMINAL_STREAM_CONFLICT";
      message: string;
    };

export type RelayV2TerminalDurableOpenClaimResult =
  | { status: "claimed"; claimToken: string; fence: string }
  | {
      status: "replay";
      outcome: RelayV2TerminalDurableOpenOutcome;
    }
  | { status: "conflict"; reason: "open_conflict" | "stream_conflict" };

export interface RelayV2TerminalDurableOpenClaimAuthority {
  claimToken: string;
  fence: string;
}

export type RelayV2TerminalDurableOpenCommitResult =
  | { status: "committed"; outcome: RelayV2TerminalDurableOpenOutcome }
  | { status: "replay"; outcome: RelayV2TerminalDurableOpenOutcome };

export interface RelayV2TerminalDurableCloseTombstone {
  key: string;
  streamKey: string;
  fingerprint: string;
  hostInstanceId: string;
  target: RelayV2TerminalWireTarget;
  streamId: string;
  closeId: string;
  requestId: string;
  requestRoute: RelayV2TerminalRoute;
  generation: string;
  finalOffset: string;
  reason: RelayV2TerminalCloseReason;
  exitCode: number | null;
  expiresAtMs: number;
}

export interface RelayV2TerminalDurableCloseIntent
  extends RelayV2TerminalDurableCloseTombstone {}

export type RelayV2TerminalDurableCloseClaimResult =
  | { status: "claimed"; intent: RelayV2TerminalDurableCloseIntent }
  | { status: "existing_intent"; intent: RelayV2TerminalDurableCloseIntent }
  | { status: "final"; tombstone: RelayV2TerminalDurableCloseTombstone }
  | { status: "not_found" }
  | { status: "close_conflict" };

/**
 * H0 owns the atomic, bounded durable implementation. The process-scoped core
 * requires this seam so a host process restart can never interpret an exact
 * mode=new retry as permission to allocate a second backend. Implementations
 * must atomically enforce the frozen retention and control-record quotas;
 * exhaustion is a hard BUSY failure, never permission to use volatile state.
 * claimOpen covers every new/resume/reset logical open before target resolution
 * or backend mutation. Only the returned claimToken/fence winner may complete
 * or fail that claim; both transitions are compare-and-swap and a late caller
 * receives the retained outcome without replacing it. Durable opened outcomes
 * contain only a token hash, never the plaintext resume token. claimClose persists the immutable
 * close winner and original connector route before lease/backend cleanup;
 * finalizeClose atomically advances only that intent to a final tombstone.
 * None of these methods may be implemented as a racy get followed by void put.
 */
export interface RelayV2TerminalDurableLineage {
  claimOpen(
    claim: RelayV2TerminalDurableOpenClaim,
  ): Promise<RelayV2TerminalDurableOpenClaimResult>;
  completeOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
  }): Promise<RelayV2TerminalDurableOpenCommitResult>;
  failOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    outcome: Exclude<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
  }): Promise<RelayV2TerminalDurableOpenCommitResult>;
  claimClose(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    intent?: RelayV2TerminalDurableCloseIntent;
  }): Promise<RelayV2TerminalDurableCloseClaimResult>;
  finalizeClose(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
  }): Promise<RelayV2TerminalDurableCloseTombstone>;
}

export interface RelayV2TerminalManagerOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  resolver: RelayV2TerminalCanonicalResolver;
  lineage: RelayV2TerminalDurableLineage;
  backend: RelayV2TerminalByteBackend;
  terminalControl: RelayV2TerminalControlAuthority;
  send(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    lineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
  now?: () => number;
  issueId?: () => string;
  issueToken?: () => string;
  /** Stricter limits for bounded simulators; values may never exceed the contract. */
  limits?: Partial<RelayV2TerminalLimits>;
}

export interface RelayV2TerminalManagerStats {
  liveOrDetachedStreams: number;
  retainedStreams: number;
  controlRecords: number;
  reservedCloseRecords: number;
  controlSlots: number;
  ringBytes: number;
  pausedBackends: number;
}

type StreamStatus = "live" | "detached" | "closed" | "lost";
type BindingPhase = "replay" | "live";

interface TerminalBinding {
  route: RelayV2TerminalRuntimeBinding;
  ackedOffset: bigint;
  sentThroughOffset: bigint;
  phase: BindingPhase;
  replayBoundary: bigint;
  closeNotification: "event" | null;
  closeNotified: boolean;
}

interface SequenceHashRecord {
  hash: string;
}

interface ResizeRecord {
  cols: number;
  rows: number;
}

interface PendingSequence {
  seq: bigint;
  fingerprint: string;
  state: "ready" | "in_doubt";
  error?: RelayV2TerminalStructuredError;
}

interface TerminalCondition {
  finalOffset: bigint;
  reason: RelayV2TerminalCloseReason;
  exitCode: number | null;
  closedAt: number;
  ringExpiresAt: number;
}

interface PendingCloseResponse {
  requestId: string;
  route: RelayV2TerminalRuntimeBinding;
  closeRecordKey: string;
  deduplicated: boolean;
}

type ProducerReleaseResult =
  | { status: "released" }
  | { status: "rejected"; error: RelayV2TerminalStructuredError }
  | {
      status: "uncertain";
      error: RelayV2TerminalStructuredError;
      lease: RelayV2TerminalProducerLease;
    };

interface TerminalStream {
  key: string;
  auth: RelayV2TerminalAuthContext;
  target: RelayV2TerminalWireTarget;
  resolvedTarget: RelayV2TerminalResolvedTarget;
  streamId: string;
  generation: string;
  resumeToken: string;
  resumeTokenHash: string;
  status: StreamStatus;
  ring: ByteRing;
  ringRetained: boolean;
  backend?: RelayV2TerminalByteHandle;
  backendPaused: boolean;
  pauseFailed: boolean;
  producerOwner: TerminalControlOwner;
  producerLease?: RelayV2TerminalProducerLease;
  /** Old authority identity retained only to settle an uncertain release. */
  retiringLease?: RelayV2TerminalProducerLease;
  renewLeaseAfter?: number;
  binding?: TerminalBinding;
  detachedUntil?: number;
  retainedUntil: number;
  close?: TerminalCondition;
  pendingCloseResponses: Map<string, PendingCloseResponse>;
  closeId?: string;
  reservedCloseRecord: boolean;
  inputAcked: bigint;
  inputFloor: bigint;
  inputHashes: Map<string, SequenceHashRecord>;
  pendingInput?: PendingSequence;
  resizeAcked: bigint;
  resizeFloor: bigint;
  resizes: Map<string, ResizeRecord>;
  pendingResize?: PendingSequence;
  controlInDoubt?: RelayV2TerminalStructuredError;
  lastUsedAt: number;
}

type OpenRecordOutcome =
  | {
      kind: "opened";
      generation: string;
      disposition: "new" | "resumed" | "reset";
      replayFromOffset: bigint;
    }
  | {
      kind: "reset";
      generation: string | null;
      reason: ResetReason;
      requestedOffset: bigint | null;
      bufferStartOffset: bigint | null;
      tailOffset: bigint | null;
    }
  | {
      kind: "error";
      code: "BUSY" | "TERMINAL_STREAM_CONFLICT";
      message: string;
    };

interface OpenRecord {
  key: string;
  streamKey: string;
  fingerprint: string;
  expiresAt: number;
  outcome: OpenRecordOutcome;
  /** Volatile exact-replay material. Never passed to durable lineage. */
  resumeToken?: string;
}

interface OpenCommitResult {
  outcome: OpenRecordOutcome;
  committed: boolean;
}

interface ProvisionalGeneration {
  key: string;
  openRecordKey: string;
  stream: TerminalStream;
}

interface CloseRecord {
  key: string;
  streamKey: string;
  fingerprint: string;
  hostInstanceId: string;
  target: RelayV2TerminalWireTarget;
  streamId: string;
  closeId: string;
  requestId: string;
  requestRoute: RelayV2TerminalRoute;
  generation: string;
  finalOffset: bigint;
  reason: RelayV2TerminalCloseReason;
  exitCode: number | null;
  expiresAt: number;
}

type ResetReason = RelayV2TerminalResetReason;

class ByteRing {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private start = 0n;
  private tail = 0n;

  constructor(private readonly limit: number) {}

  get length(): number {
    return this.byteLength;
  }

  get startOffset(): bigint {
    return this.start;
  }

  get tailOffset(): bigint {
    return this.tail;
  }

  predictedStartAfter(byteCount: number): bigint {
    const futureTail = this.tail + BigInt(byteCount);
    return futureTail - BigInt(Math.min(this.limit, this.byteLength + byteCount));
  }

  append(input: Uint8Array): number {
    const data = Buffer.from(input);
    if (data.byteLength === 0) return 0;
    if (data.byteLength >= this.limit) {
      const previous = this.byteLength;
      const kept = Buffer.from(data.subarray(data.byteLength - this.limit));
      this.tail += BigInt(data.byteLength);
      this.start = this.tail - BigInt(kept.byteLength);
      this.chunks.splice(0, this.chunks.length, kept);
      this.byteLength = kept.byteLength;
      return previous + data.byteLength - kept.byteLength;
    }
    const last = this.chunks.at(-1);
    if (last && last.byteLength < 64 * 1024) {
      const joinedBytes = Math.min(data.byteLength, 64 * 1024 - last.byteLength);
      if (joinedBytes > 0) {
        this.chunks[this.chunks.length - 1] = Buffer.concat(
          [last, data.subarray(0, joinedBytes)],
          last.byteLength + joinedBytes,
        );
        if (joinedBytes < data.byteLength) {
          this.chunks.push(Buffer.from(data.subarray(joinedBytes)));
        }
      } else {
        this.chunks.push(data);
      }
    } else {
      this.chunks.push(data);
    }
    this.byteLength += data.byteLength;
    this.tail += BigInt(data.byteLength);
    const overflow = Math.max(0, this.byteLength - this.limit);
    if (overflow > 0) this.discardPrefixBytes(overflow);
    return overflow;
  }

  clear(): number {
    const removed = this.byteLength;
    this.chunks.length = 0;
    this.byteLength = 0;
    this.start = this.tail;
    return removed;
  }

  discardBefore(offset: bigint): number {
    if (offset <= this.start) return 0;
    const through = offset > this.tail ? this.tail : offset;
    const removed = Number(through - this.start);
    if (removed > 0) this.discardPrefixBytes(removed);
    return removed;
  }

  hasRange(from: bigint, through: bigint): boolean {
    return from >= this.start && from <= through && through <= this.tail;
  }

  read(from: bigint, maxBytes: number, through = this.tail): Buffer {
    if (!this.hasRange(from, through) || from === through || maxBytes <= 0) {
      return Buffer.alloc(0);
    }
    const wanted = Number(
      (through - from) < BigInt(maxBytes) ? through - from : BigInt(maxBytes),
    );
    let skip = Number(from - this.start);
    const parts: Buffer[] = [];
    let remaining = wanted;
    for (const chunk of this.chunks) {
      if (skip >= chunk.byteLength) {
        skip -= chunk.byteLength;
        continue;
      }
      const take = Math.min(remaining, chunk.byteLength - skip);
      parts.push(chunk.subarray(skip, skip + take));
      remaining -= take;
      skip = 0;
      if (remaining === 0) break;
    }
    return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, wanted - remaining);
  }

  private discardPrefixBytes(byteCount: number): void {
    let remaining = byteCount;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (!first) throw new Error("Relay v2 terminal ring accounting underflow");
      if (remaining >= first.byteLength) {
        remaining -= first.byteLength;
        this.chunks.shift();
      } else {
        this.chunks[0] = Buffer.from(first.subarray(remaining));
        remaining = 0;
      }
    }
    this.byteLength -= byteCount;
    this.start += BigInt(byteCount);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Relay v2 terminal ${label} must be a positive safe integer`);
  }
  return value;
}

function resolveLimits(overrides: Partial<RelayV2TerminalLimits> = {}): RelayV2TerminalLimits {
  const limits = { ...RELAY_V2_TERMINAL_LIMITS, ...overrides };
  for (const [key, ceiling] of Object.entries(RELAY_V2_TERMINAL_LIMITS)) {
    const value = positiveInteger(limits[key as keyof RelayV2TerminalLimits], key);
    if (value > ceiling) {
      throw new Error(`Relay v2 terminal ${key} exceeds the frozen limit`);
    }
  }
  if (limits.hostRingBytes < limits.streamRingBytes) {
    throw new Error("Relay v2 terminal host ring must cover at least one stream ring");
  }
  if (limits.maxUnackedBytes > limits.streamRingBytes) {
    throw new Error("Relay v2 terminal output credit cannot exceed the stream ring");
  }
  if (limits.maxFrameBytes > limits.maxUnackedBytes) {
    throw new Error("Relay v2 terminal frame limit cannot exceed output credit");
  }
  return limits;
}

function parseCounter(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", `${label} is not canonical`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", `${label} is invalid`);
  }
  if (parsed > MAX_COUNTER) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", `${label} exceeds the counter limit`);
  }
  return parsed;
}

function parsePositiveCounter(value: string, label: string): bigint {
  const parsed = parseCounter(value, label);
  if (parsed === 0n) {
    throw new RelayV2TerminalManagerError(
      "INVALID_ARGUMENT",
      `${label} must start at 1`,
    );
  }
  return parsed;
}

function validateSize(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols)
    || !Number.isSafeInteger(rows)
    || cols < 1
    || cols > 1_000
    || rows < 1
    || rows > 500
  ) {
    throw new RelayV2TerminalManagerError(
      "INVALID_ARGUMENT",
      "terminal size is outside the frozen bounds",
    );
  }
}

function fingerprint(parts: readonly (string | number | null)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = part === null ? "<null>" : String(part);
    hash.update(String(Buffer.byteLength(value, "utf8")), "ascii");
    hash.update(":", "ascii");
    hash.update(value, "utf8");
    hash.update(";", "ascii");
  }
  return hash.digest("hex");
}

function payloadHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function tokenHash(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal resume token is invalid");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && !value.includes("\0")
    && value.trim() === value;
}

function hasExactOwnKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function sameRuntimeBinding(
  left: RelayV2TerminalRuntimeBinding,
  right: RelayV2TerminalRuntimeBinding,
): boolean {
  return sameDurableRoute(left, right)
    && left.runtimeBindingToken === right.runtimeBindingToken;
}

function sameDurableRoute(
  left: RelayV2TerminalRoute,
  right: RelayV2TerminalRoute,
): boolean {
  return left.connectorId === right.connectorId
    && left.routeId === right.routeId
    && left.routeFence === right.routeFence;
}

function cloneRuntimeBinding(
  binding: RelayV2TerminalRuntimeBinding,
): RelayV2TerminalRuntimeBinding {
  return createRelayV2TerminalRuntimeBinding(binding, binding.runtimeBindingToken);
}

function durableRoute(route: RelayV2TerminalRoute): RelayV2TerminalRoute {
  return {
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
  };
}

function routeRequestKey(route: RelayV2TerminalRuntimeBinding, requestId: string): string {
  return JSON.stringify([
    route.connectorId,
    route.routeId,
    route.routeFence,
    route.runtimeBindingToken,
    requestId,
  ]);
}

function sameAuth(left: RelayV2TerminalAuthContext, right: RelayV2TerminalAuthContext): boolean {
  return left.principalId === right.principalId
    && left.clientInstanceId === right.clientInstanceId;
}

function sameTarget(
  left: RelayV2TerminalWireTarget,
  right: RelayV2TerminalWireTarget,
): boolean {
  return left.hostId === right.hostId
    && left.scopeId === right.scopeId
    && left.sessionId === right.sessionId;
}

function sameDurableOpenOutcome(
  left: RelayV2TerminalDurableOpenOutcome,
  right: RelayV2TerminalDurableOpenOutcome,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "opened" && right.kind === "opened") {
    return left.generation === right.generation
      && left.resumeTokenHash === right.resumeTokenHash
      && left.disposition === right.disposition
      && left.replayFromOffset === right.replayFromOffset;
  }
  if (left.kind === "reset" && right.kind === "reset") {
    return left.generation === right.generation
      && left.reason === right.reason
      && left.requestedOffset === right.requestedOffset
      && left.bufferStartOffset === right.bufferStartOffset
      && left.tailOffset === right.tailOffset;
  }
  return left.kind === "error"
    && right.kind === "error"
    && left.code === right.code
    && left.message === right.message;
}

function sameDurableClose(
  left: RelayV2TerminalDurableCloseTombstone,
  right: RelayV2TerminalDurableCloseTombstone,
): boolean {
  return left.key === right.key
    && left.streamKey === right.streamKey
    && left.fingerprint === right.fingerprint
    && left.hostInstanceId === right.hostInstanceId
    && sameTarget(left.target, right.target)
    && left.streamId === right.streamId
    && left.closeId === right.closeId
    && left.requestId === right.requestId
    && sameDurableRoute(left.requestRoute, right.requestRoute)
    && left.generation === right.generation
    && left.finalOffset === right.finalOffset
    && left.reason === right.reason
    && left.exitCode === right.exitCode
    && left.expiresAtMs === right.expiresAtMs;
}

function asJson(frame: Record<string, unknown>): RelayV2JsonObject {
  return frame as unknown as RelayV2JsonObject;
}

const AUTHORITY_ERROR_CODES = new Set<RelayV2TerminalStructuredError["code"]>([
  "PERMISSION_DENIED",
  "BUSY",
  "SLOW_CONSUMER",
  "SCOPE_NOT_FOUND",
  "SCOPE_UNREACHABLE",
  "SESSION_NOT_FOUND",
  "PANE_NOT_FOUND",
  "TERMINAL_INPUT_GAP",
  "TERMINAL_INPUT_CONFLICT",
  "TERMINAL_RESIZE_GAP",
  "TERMINAL_RESIZE_CONFLICT",
  "COMMAND_IN_DOUBT",
  "INTERNAL",
]);

function validateAuthorityResult(
  value: unknown,
  kind: "input" | "resize",
): RelayV2TerminalAuthorityResult {
  if (!value || typeof value !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (result.accepted === true) return { accepted: true };
  if (result.accepted !== false || typeof result.uncertain !== "boolean") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid result");
  }
  const rawError = result.error;
  if (!rawError || typeof rawError !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid error");
  }
  const error = rawError as Record<string, unknown>;
  const domainCodes = kind === "input"
    ? new Set(["TERMINAL_INPUT_GAP", "TERMINAL_INPUT_CONFLICT"])
    : new Set(["TERMINAL_RESIZE_GAP", "TERMINAL_RESIZE_CONFLICT"]);
  const commonCodes = new Set([
    "PERMISSION_DENIED",
    "BUSY",
    "SLOW_CONSUMER",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNREACHABLE",
    "SESSION_NOT_FOUND",
    "PANE_NOT_FOUND",
    "COMMAND_IN_DOUBT",
    "INTERNAL",
  ]);
  const commandDisposition = error.code === "COMMAND_IN_DOUBT"
    ? "in_doubt"
    : "not_applicable";
  if (
    typeof error.code !== "string"
    || !AUTHORITY_ERROR_CODES.has(error.code as RelayV2TerminalStructuredError["code"])
    || (!commonCodes.has(error.code) && !domainCodes.has(error.code))
    || typeof error.message !== "string"
    || error.message.length === 0
    || error.message.includes("\0")
    || Buffer.byteLength(error.message, "utf8") > 4_096
    || typeof error.retryable !== "boolean"
    || (error.code === "COMMAND_IN_DOUBT" && result.uncertain !== true)
    || (error.details !== undefined && error.details !== null)
  ) {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control error is outside the v2 allowlist");
  }
  return {
    accepted: false,
    uncertain: result.uncertain,
    error: result.uncertain
      ? {
          code: "COMMAND_IN_DOUBT",
          message: error.message,
          retryable: false,
          details: null,
          commandDisposition: "in_doubt",
        }
      : {
          code: error.code as RelayV2TerminalStructuredError["code"],
          message: error.message,
          retryable: error.retryable,
          details: null,
          commandDisposition,
        },
  };
}

function controlFailure(error: unknown): {
  status: "rejected" | "uncertain";
  error: RelayV2TerminalStructuredError;
} {
  const raw = error && typeof error === "object"
    ? error as Record<string, unknown>
    : undefined;
  const message = typeof raw?.message === "string"
    && raw.message.length > 0
    && !raw.message.includes("\0")
    && Buffer.byteLength(raw.message, "utf8") <= 4_096
    ? raw.message
    : "terminal-control operation could not be confirmed";
  if (raw?.code === "PERMISSION_DENIED") {
    return {
      status: "rejected",
      error: {
        code: "PERMISSION_DENIED",
        message,
        retryable: raw.retryable === true,
        details: null,
        commandDisposition: "not_applicable",
      },
    };
  }
  if (raw?.code === "HANDOFF_PENDING" || raw?.code === "RECOVERY_REQUIRED") {
    return {
      status: "rejected",
      error: {
        code: "PERMISSION_DENIED",
        message,
        retryable: true,
        details: null,
        commandDisposition: "not_applicable",
      },
    };
  }
  if (raw?.code === "RESOURCE_EXHAUSTED") {
    return {
      status: "rejected",
      error: {
        code: "BUSY",
        message,
        retryable: true,
        details: null,
        commandDisposition: "not_applicable",
      },
    };
  }
  return {
    status: "uncertain",
    error: {
      code: "COMMAND_IN_DOUBT",
      message,
      retryable: false,
      details: null,
      commandDisposition: "in_doubt",
    },
  };
}

function validateLeaseResult(
  value: unknown,
  target: RelayV2TerminalResolvedTarget,
  owner: TerminalControlOwner,
  now: number,
  current?: RelayV2TerminalProducerLease,
): RelayV2TerminalLeaseResult {
  if (!value || typeof value !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease result");
  }
  const result = value as Record<string, unknown>;
  if (result.status === "accepted") {
    const lease = validateProducerLease(result.lease, target, owner, now);
    if (current && (
      lease.controlTargetId !== current.controlTargetId
      || lease.controlEpoch !== current.controlEpoch
      || lease.leaseId !== current.leaseId
      || lease.fence !== current.fence
      || lease.owner.kind !== current.owner.kind
      || lease.owner.instanceId !== current.owner.instanceId
    )) {
      return {
        status: "rejected",
        error: {
          code: "PERMISSION_DENIED",
          message: "terminal-control lease identity changed during renewal",
          retryable: false,
          details: null,
          commandDisposition: "not_applicable",
        },
      };
    }
    return { status: "accepted", lease };
  }
  if (result.status !== "rejected" && result.status !== "uncertain") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease result");
  }
  const validated = validateAuthorityResult({
    accepted: false,
    uncertain: result.status === "uncertain",
    error: result.error,
  }, "input");
  if (validated.accepted) {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease failure");
  }
  return { status: result.status, error: validated.error };
}

function validateProducerLease(
  value: unknown,
  target: RelayV2TerminalResolvedTarget,
  expectedOwner: TerminalControlOwner,
  now: number,
): RelayV2TerminalProducerLease {
  if (!value || typeof value !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease");
  }
  const lease = value as Record<string, unknown>;
  for (const field of ["controlTargetId", "controlEpoch", "leaseId", "fence", "expiresAt"] as const) {
    if (typeof lease[field] !== "string" || lease[field].length === 0 || lease[field].length > 4_096) {
      throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease");
    }
  }
  const owner = lease.owner as Record<string, unknown> | undefined;
  const expiresAtMs = typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
  if (
    lease.controlTargetId !== target.controlTargetId
    || !owner
    || owner.kind !== expectedOwner.kind
    || owner.instanceId !== expectedOwner.instanceId
    || !Number.isSafeInteger(expiresAtMs)
    || new Date(expiresAtMs).toISOString() !== lease.expiresAt
    || expiresAtMs <= now
  ) {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control lease is stale or mismatched");
  }
  return {
    controlTargetId: lease.controlTargetId as string,
    controlEpoch: lease.controlEpoch as string,
    leaseId: lease.leaseId as string,
    fence: lease.fence as string,
    owner: {
      kind: owner.kind as TerminalControlOwner["kind"],
      instanceId: owner.instanceId as string,
    },
    expiresAt: lease.expiresAt as string,
  };
}

function normalizeBackendClose(value: unknown): RelayV2TerminalBackendClose {
  if (!value || typeof value !== "object") return { reason: "backend_error", exitCode: null };
  const close = value as Record<string, unknown>;
  const exitCode = close.exitCode;
  const validExitCode = Number.isInteger(exitCode)
    && (exitCode as number) >= -2_147_483_648
    && (exitCode as number) <= 2_147_483_647;
  if (close.reason === "backend_exit" && validExitCode) {
    return { reason: "backend_exit", exitCode: exitCode as number };
  }
  if (close.reason === "backend_error" && (exitCode === null || validExitCode)) {
    return { reason: "backend_error", exitCode: exitCode as number | null };
  }
  return { reason: "backend_error", exitCode: null };
}

export class RelayV2TerminalManager {
  readonly limits: Readonly<RelayV2TerminalLimits>;

  private readonly streams = new Map<string, TerminalStream>();
  private readonly openRecords = new Map<string, OpenRecord>();
  private readonly closeRecords = new Map<string, CloseRecord>();
  private serialized: Promise<void> = Promise.resolve();
  private ringBytes = 0;
  private hostPressure = false;
  private stopping = false;

  private readonly hostId: string;
  private readonly hostEpoch: string;
  private readonly hostInstanceId: string;
  private readonly resolver: RelayV2TerminalCanonicalResolver;
  private readonly lineage: RelayV2TerminalDurableLineage;
  private readonly backend: RelayV2TerminalByteBackend;
  private readonly terminalControl: RelayV2TerminalControlAuthority;
  private readonly sendFrame: RelayV2TerminalManagerOptions["send"];
  private readonly now: () => number;
  private readonly issueId: () => string;
  private readonly issueToken: () => string;

  constructor(options: RelayV2TerminalManagerOptions) {
    this.hostId = options.hostId;
    this.hostEpoch = options.hostEpoch;
    this.hostInstanceId = options.hostInstanceId;
    this.resolver = options.resolver;
    this.lineage = options.lineage;
    this.backend = options.backend;
    this.terminalControl = options.terminalControl;
    this.sendFrame = options.send;
    this.now = options.now ?? Date.now;
    this.issueId = options.issueId ?? randomUUID;
    this.issueToken = options.issueToken
      ?? (() => randomBytes(32).toString("base64url"));
    this.limits = Object.freeze(resolveLimits(options.limits));
  }

  open(request: RelayV2TerminalOpenRequest): Promise<void> {
    return this.enqueue(() => this.openInternal(request));
  }

  requestReplay(request: RelayV2TerminalReplayRequest): Promise<void> {
    return this.enqueue(() => this.replayInternal(request));
  }

  acknowledgeOutput(ack: RelayV2TerminalOutputAck): Promise<void> {
    return this.enqueue(() => this.outputAckInternal(ack));
  }

  input(input: RelayV2TerminalInput): Promise<void> {
    if (input.data.byteLength > this.limits.maxFrameBytes) {
      return Promise.reject(new RelayV2TerminalManagerError(
        "INVALID_ARGUMENT",
        "terminal input exceeds 64 KiB",
      ));
    }
    const copy = { ...input, data: Buffer.from(input.data) };
    return this.enqueue(() => this.inputInternal(copy));
  }

  resize(resize: RelayV2TerminalResize): Promise<void> {
    return this.enqueue(() => this.resizeInternal(resize));
  }

  close(request: RelayV2TerminalCloseRequest): Promise<void> {
    return this.enqueue(() => this.closeInternal(request));
  }

  unbind(auth: RelayV2TerminalAuthContext, route: RelayV2TerminalRuntimeBinding): Promise<void> {
    return this.enqueue(async () => {
      await this.sweepInternal();
      for (const stream of this.streams.values()) {
        if (!sameAuth(stream.auth, auth) || !stream.binding) continue;
        if (!sameRuntimeBinding(stream.binding.route, route)) continue;
        stream.binding = undefined;
        if (stream.status === "live") {
          await this.endRouteControl(stream);
          stream.status = "detached";
          stream.detachedUntil = this.now() + this.limits.detachedLeaseMs;
          stream.lastUsedAt = this.now();
        }
      }
      await this.refreshBackpressure();
    });
  }

  sweep(): Promise<void> {
    return this.enqueue(() => this.sweepInternal(true));
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      this.stopping = true;
      for (const stream of this.streams.values()) {
        stream.binding = undefined;
        await this.releaseProducerLease(stream);
        this.clearControlWindows(stream);
        await this.disposeBackend(stream);
      }
    });
  }

  stats(): RelayV2TerminalManagerStats {
    let liveOrDetachedStreams = 0;
    let reservedCloseRecords = 0;
    let pausedBackends = 0;
    for (const stream of this.streams.values()) {
      if (stream.status === "live" || stream.status === "detached") {
        liveOrDetachedStreams += 1;
      }
      if (stream.reservedCloseRecord) reservedCloseRecords += 1;
      if (stream.backendPaused) pausedBackends += 1;
    }
    const controlRecords = this.openRecords.size + this.closeRecords.size;
    return {
      liveOrDetachedStreams,
      retainedStreams: this.streams.size,
      controlRecords,
      reservedCloseRecords,
      controlSlots: controlRecords + reservedCloseRecords,
      ringBytes: this.ringBytes,
      pausedBackends,
    };
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.serialized.then(operation, operation);
    this.serialized = run.then(() => undefined, () => undefined);
    return run;
  }

  private streamKey(auth: RelayV2TerminalAuthContext, streamId: string): string {
    return JSON.stringify([
      auth.principalId,
      auth.clientInstanceId,
      this.hostEpoch,
      streamId,
    ]);
  }

  private openRecordKey(request: RelayV2TerminalOpenRequest): string {
    return JSON.stringify([this.streamKey(request.auth, request.streamId), request.openId]);
  }

  private closeRecordKey(request: RelayV2TerminalCloseRequest): string {
    return JSON.stringify([this.streamKey(request.auth, request.streamId), request.closeId]);
  }

  private openFingerprint(request: RelayV2TerminalOpenRequest): string {
    return fingerprint([
      request.target.hostId,
      request.target.scopeId,
      request.target.sessionId,
      request.pane,
      request.cols,
      request.rows,
      request.mode,
      request.resume?.generation ?? null,
      request.resume?.nextOffset ?? null,
      request.resume ? tokenHash(request.resume.resumeToken) : null,
    ]);
  }

  private closeFingerprint(request: RelayV2TerminalCloseRequest): string {
    return fingerprint([
      request.target.hostId,
      request.target.scopeId,
      request.target.sessionId,
      request.generation,
      tokenHash(request.resumeToken),
    ]);
  }

  private assertHost(request: {
    expectedHostEpoch: string;
    target: RelayV2TerminalWireTarget;
  }): void {
    if (request.target.hostId !== this.hostId) {
      throw new RelayV2TerminalManagerError("PERMISSION_DENIED", "terminal host is not authorized");
    }
    if (
      !isOpaqueId(request.target.scopeId)
      || !isOpaqueId(request.target.sessionId)
    ) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal target identity is invalid");
    }
    if (request.expectedHostEpoch !== this.hostEpoch) {
      throw new RelayV2TerminalManagerError(
        "HOST_EPOCH_MISMATCH",
        "terminal request targets a stale host lineage",
      );
    }
  }

  private assertRunning(): void {
    if (this.stopping) {
      throw new RelayV2TerminalManagerError("BUSY", "terminal manager is stopping");
    }
  }

  private controlSlots(): number {
    let reservations = 0;
    for (const stream of this.streams.values()) {
      if (stream.reservedCloseRecord) reservations += 1;
    }
    return this.openRecords.size + this.closeRecords.size + reservations;
  }

  private requireControlSlots(additional: number): void {
    if (this.controlSlots() + additional > this.limits.maxControlRecords) {
      throw new RelayV2TerminalManagerError(
        "BUSY",
        "Relay v2 terminal control record quota is full",
      );
    }
  }

  private cacheOpenRecord(record: OpenRecord): void {
    if (
      this.openRecords.has(record.key)
      || this.controlSlots() < this.limits.maxControlRecords
    ) {
      this.openRecords.set(record.key, record);
    }
  }

  private cacheCloseRecord(record: CloseRecord, stream?: TerminalStream): void {
    if (
      this.closeRecords.has(record.key)
      || this.controlSlots() < this.limits.maxControlRecords
      || stream?.reservedCloseRecord === true
    ) {
      this.closeRecords.set(record.key, record);
    }
  }

  private liveOrDetachedCount(): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      if (stream.status === "live" || stream.status === "detached") count += 1;
    }
    return count;
  }

  private async openInternal(request: RelayV2TerminalOpenRequest): Promise<void> {
    this.assertRunning();
    this.assertHost(request);
    await this.sweepInternal();
    validateSize(request.cols, request.rows);
    if (!Number.isSafeInteger(request.pane) || request.pane < 0 || request.pane > 65_535) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal pane is outside the frozen bounds");
    }
    this.validateOpenMode(request);

    const key = this.streamKey(request.auth, request.streamId);
    const recordKey = this.openRecordKey(request);
    const requestFingerprint = this.openFingerprint(request);
    const retained = this.openRecords.get(recordKey);
    if (retained) {
      if (retained.fingerprint !== requestFingerprint) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_OPEN_CONFLICT",
          "terminal openId was reused with a different request",
        );
      }
      await this.replayOpenRecord(request, retained);
      return;
    }

    const existing = this.streams.get(key);
    const claim = await this.lineage.claimOpen({
      key: recordKey,
      streamKey: key,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      mode: request.mode,
      previousGeneration: request.resume?.generation ?? null,
      requestedOffset: request.resume?.nextOffset ?? null,
      expiresAtMs: this.now() + this.limits.controlRetentionMs,
    });
    if (!claim || typeof claim !== "object" || typeof claim.status !== "string") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid open claim");
    }
    if (claim.status === "conflict") {
      if (claim.reason === "open_conflict") {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_OPEN_CONFLICT",
          "terminal openId was durably retained with a different request",
        );
      }
      if (claim.reason === "stream_conflict") {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_STREAM_CONFLICT",
          "terminal streamId is already retained",
        );
      }
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid conflict");
    }
    if (claim.status === "replay") {
      await this.replayDurableOpen(request, key, recordKey, requestFingerprint, claim);
      return;
    }
    if (claim.status !== "claimed") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an unknown open claim");
    }
    const claimAuthority = this.openClaimAuthority(claim);
    if (request.mode === "new" && existing) {
      const outcome = await this.completeOpenRecord(request, key, recordKey, requestFingerprint, {
        kind: "error",
        code: "TERMINAL_STREAM_CONFLICT",
        message: "terminal streamId is already retained",
      }, claimAuthority);
      this.throwOpenError(outcome);
      return;
    }
    try {
      this.requireControlSlots(
        request.mode === "new" || (request.mode === "reset" && !existing) ? 2 : 1,
      );
    } catch (error) {
      if (!(error instanceof RelayV2TerminalManagerError) || error.code !== "BUSY") throw error;
      const outcome = await this.completeOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        { kind: "error", code: "BUSY", message: error.message },
        claimAuthority,
        undefined,
        false,
      );
      this.throwOpenError(outcome);
      return;
    }
    if (request.mode === "new") {
      if (this.liveOrDetachedCount() >= this.limits.maxStreams) {
        const outcome = await this.completeOpenRecord(request, key, recordKey, requestFingerprint, {
          kind: "error",
          code: "BUSY",
          message: "Relay v2 terminal stream quota is full",
        }, claimAuthority);
        this.throwOpenError(outcome);
        return;
      }
      await this.createGeneration(request, key, recordKey, requestFingerprint, "new", claimAuthority);
      return;
    }

    if (request.mode === "resume") {
      await this.resumeGeneration(request, existing, key, recordKey, requestFingerprint, claimAuthority);
      return;
    }

    await this.resetGeneration(request, existing, key, recordKey, requestFingerprint, claimAuthority);
  }

  private openClaimAuthority(
    claim: Extract<RelayV2TerminalDurableOpenClaimResult, { status: "claimed" }>,
  ): RelayV2TerminalDurableOpenClaimAuthority {
    if (!isOpaqueId(claim.claimToken) || !isOpaqueId(claim.fence)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid open claim authority");
    }
    return { claimToken: claim.claimToken, fence: claim.fence };
  }

  private validateOpenMode(request: RelayV2TerminalOpenRequest): void {
    if (!(["new", "resume", "reset"] as const).includes(request.mode)) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal open mode is invalid");
    }
    if (request.mode === "new" && request.resume !== undefined) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "mode=new forbids resume fields");
    }
    if (request.mode === "resume" && request.resume === undefined) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "mode=resume requires resume fields");
    }
    if (request.resume) parseCounter(request.resume.nextOffset, "nextOffset");
  }

  private durableOpenOutcome(
    outcome: OpenRecordOutcome,
    stream?: TerminalStream,
  ): RelayV2TerminalDurableOpenOutcome {
    if (outcome.kind === "opened") {
      if (!stream || stream.generation !== outcome.generation) {
        throw new RelayV2TerminalManagerError("INTERNAL", "opened outcome has no matching terminal stream");
      }
      return {
        kind: "opened",
        generation: outcome.generation,
        resumeTokenHash: stream.resumeTokenHash,
        disposition: outcome.disposition,
        replayFromOffset: outcome.replayFromOffset.toString(10),
      };
    }
    if (outcome.kind === "reset") {
      return {
        kind: "reset",
        generation: outcome.generation,
        reason: outcome.reason,
        requestedOffset: outcome.requestedOffset?.toString(10) ?? null,
        bufferStartOffset: outcome.bufferStartOffset?.toString(10) ?? null,
        tailOffset: outcome.tailOffset?.toString(10) ?? null,
      };
    }
    return { ...outcome };
  }

  private localOpenOutcome(value: unknown): OpenRecordOutcome {
    if (!value || typeof value !== "object") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open outcome is invalid");
    }
    const outcome = value as Record<string, unknown>;
    if (outcome.kind === "opened") {
      if (
        !isOpaqueId(outcome.generation)
        || typeof outcome.resumeTokenHash !== "string"
        || !/^[0-9a-f]{64}$/.test(outcome.resumeTokenHash)
        || !(outcome.disposition === "new" || outcome.disposition === "resumed" || outcome.disposition === "reset")
        || typeof outcome.replayFromOffset !== "string"
      ) {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal opened outcome is invalid");
      }
      let replayFromOffset: bigint;
      try {
        replayFromOffset = parseCounter(outcome.replayFromOffset, "durable replayFromOffset");
      } catch {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal opened outcome is invalid");
      }
      return {
        kind: "opened",
        generation: outcome.generation,
        disposition: outcome.disposition,
        replayFromOffset,
      };
    }
    if (outcome.kind === "reset") {
      const reason = outcome.reason;
      if (
        !(outcome.generation === null || isOpaqueId(outcome.generation))
        || !(reason === "generation_stale" || reason === "offset_expired" || reason === "stream_lost"
          || reason === "slow_consumer" || reason === "host_buffer_pressure")
      ) {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal reset outcome is invalid");
      }
      const counterOrNull = (field: "requestedOffset" | "bufferStartOffset" | "tailOffset") => {
        const raw = outcome[field];
        if (raw === null) return null;
        if (typeof raw !== "string") {
          throw new RelayV2TerminalManagerError("INTERNAL", `durable ${field} is invalid`);
        }
        try {
          return parseCounter(raw, `durable ${field}`);
        } catch {
          throw new RelayV2TerminalManagerError("INTERNAL", `durable ${field} is invalid`);
        }
      };
      return {
        kind: "reset",
        generation: outcome.generation,
        reason,
        requestedOffset: counterOrNull("requestedOffset"),
        bufferStartOffset: counterOrNull("bufferStartOffset"),
        tailOffset: counterOrNull("tailOffset"),
      };
    }
    if (
      outcome.kind === "error"
      && (outcome.code === "BUSY" || outcome.code === "TERMINAL_STREAM_CONFLICT")
      && typeof outcome.message === "string"
      && outcome.message.length > 0
      && !outcome.message.includes("\0")
      && Buffer.byteLength(outcome.message, "utf8") <= 4_096
    ) {
      return {
        kind: "error",
        code: outcome.code,
        message: outcome.message,
      };
    }
    throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open outcome is invalid");
  }

  private streamLostFromDurableOpened(
    outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>,
  ): Extract<OpenRecordOutcome, { kind: "reset" }> {
    return {
      kind: "reset",
      generation: outcome.generation,
      reason: "stream_lost",
      requestedOffset: parseCounter(outcome.replayFromOffset, "durable replayFromOffset"),
      bufferStartOffset: null,
      tailOffset: null,
    };
  }

  private async commitOpenRecord(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    proposed: OpenRecordOutcome,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    stream?: TerminalStream,
    retainLocal = true,
  ): Promise<OpenCommitResult> {
    const durableProposed = this.durableOpenOutcome(proposed, stream);
    const input = {
      key: recordKey,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      claimToken: claimAuthority.claimToken,
      fence: claimAuthority.fence,
      outcome: durableProposed,
    };
    const result = durableProposed.kind === "opened"
      ? await this.lineage.completeOpen({
          ...input,
          outcome: durableProposed,
        })
      : await this.lineage.failOpen({
          ...input,
          outcome: durableProposed,
        });
    if (
      !result
      || typeof result !== "object"
      || !(result.status === "committed" || result.status === "replay")
    ) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open commit result is invalid");
    }
    let outcome = this.localOpenOutcome(result.outcome);
    if (result.status === "committed" && !sameDurableOpenOutcome(result.outcome, durableProposed)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open commit changed the claimed winner");
    }
    if (result.outcome.kind === "opened") {
      const hasVolatileToken = result.status === "committed"
        && stream !== undefined
        && stream.generation === result.outcome.generation
        && safeHashEqual(stream.resumeTokenHash, result.outcome.resumeTokenHash);
      if (!hasVolatileToken) {
        outcome = this.streamLostFromDurableOpened(result.outcome);
      }
    }
    if (retainLocal) {
      this.cacheOpenRecord({
        key: recordKey,
        streamKey: key,
        fingerprint: requestFingerprint,
        expiresAt: this.now() + this.limits.controlRetentionMs,
        outcome,
        resumeToken: outcome.kind === "opened" ? stream?.resumeToken : undefined,
      });
    }
    return { outcome, committed: result.status === "committed" };
  }

  private async completeOpenRecord(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    proposed: OpenRecordOutcome,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    stream?: TerminalStream,
    retainLocal = true,
  ): Promise<OpenRecordOutcome> {
    return (await this.commitOpenRecord(
      request,
      key,
      recordKey,
      requestFingerprint,
      proposed,
      claimAuthority,
      stream,
      retainLocal,
    )).outcome;
  }

  private recoverOpenRecord(
    record: OpenRecord,
    proposed: Extract<OpenRecordOutcome, { kind: "reset" }>,
  ): Extract<OpenRecordOutcome, { kind: "reset" }> {
    record.outcome = proposed;
    record.resumeToken = undefined;
    record.expiresAt = this.now() + this.limits.controlRetentionMs;
    return proposed;
  }

  private async replayDurableOpen(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claim: Extract<RelayV2TerminalDurableOpenClaimResult, { status: "replay" }>,
  ): Promise<void> {
    const durable = this.localOpenOutcome(claim.outcome);
    const recovered = claim.outcome.kind === "opened"
      ? this.streamLostFromDurableOpened(claim.outcome)
      : durable;
    this.cacheOpenRecord({
      key: recordKey,
      streamKey: key,
      fingerprint: requestFingerprint,
      expiresAt: this.now() + this.limits.controlRetentionMs,
      outcome: recovered,
    });
    if (recovered.kind === "error") {
      this.throwOpenError(recovered);
      return;
    }
    if (recovered.kind === "reset") {
      await this.sendResetResponse(request, recovered, "open");
      return;
    }
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "durable terminal opened replay cannot recover a plaintext resume token",
    );
  }

  private throwOpenError(
    outcome: OpenRecordOutcome,
  ): asserts outcome is Exclude<OpenRecordOutcome, { kind: "error" }> {
    if (outcome.kind === "error") {
      throw new RelayV2TerminalManagerError(outcome.code, outcome.message);
    }
  }

  private async replayOpenRecord(
    request: RelayV2TerminalOpenRequest,
    record: OpenRecord,
  ): Promise<void> {
    if (record.outcome.kind === "error") {
      this.throwOpenError(record.outcome);
      return;
    }
    if (record.outcome.kind === "reset") {
      await this.sendResetResponse(request, record.outcome, "open");
      return;
    }
    const stream = this.streams.get(record.streamKey);
    if (
      !stream
      || stream.status === "lost"
      || stream.generation !== record.outcome.generation
      || !record.resumeToken
      || !this.validResumeToken(stream, record.resumeToken)
    ) {
      const outcome = this.recoverOpenRecord(record, {
        kind: "reset",
        generation: record.outcome.generation,
        reason: "stream_lost",
        requestedOffset: record.outcome.replayFromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      });
      await this.sendResetResponse(request, outcome, "open");
      return;
    }
    const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
    if (!this.canReplay(stream, record.outcome.replayFromOffset, through)) {
      const outcome = this.recoverOpenRecord(record, {
        kind: "reset",
        generation: stream.generation,
        reason: "stream_lost",
        requestedOffset: record.outcome.replayFromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      });
      await this.sendResetResponse(request, outcome, "open");
      return;
    }
    if (!stream.close) {
      await this.setAttachmentDisplaySizeHint(stream, request.cols, request.rows);
    }
    await this.bindOpened(
      request,
      stream,
      record.outcome.disposition,
      record.outcome.replayFromOffset,
      true,
    );
  }

  private async createGeneration(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    disposition: "new" | "reset",
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
  ): Promise<void> {
    const generation = this.issueId();
    const resumeToken = this.issueToken();
    if (!isOpaqueId(generation)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "terminal generation issuer returned an invalid ID");
    }
    tokenHash(resumeToken);
    let stream: TerminalStream | undefined;
    try {
      const resolvedTarget = await this.resolveTarget(request);
      stream = this.newStream(request, resolvedTarget, key, generation, resumeToken);
      stream.backend = await this.backend.open(
        stream.resolvedTarget,
        {
          maxChunkBytes: this.limits.maxFrameBytes,
          displaySizeHint: { cols: request.cols, rows: request.rows },
        },
        {
          onBytes: async (data) => {
            if (
              !Number.isSafeInteger(data.byteLength)
              || data.byteLength < 0
              || data.byteLength > this.limits.maxFrameBytes
            ) {
              await this.enqueue(() => this.rejectBackendChunk(key, generation));
              return;
            }
            const copy = Buffer.from(data);
            await this.enqueue(() => this.backendOutput(key, generation, copy));
          },
          onClosed: async (result) => {
            await this.enqueue(() => this.backendClosed(
              key,
              generation,
              normalizeBackendClose(result),
            ));
          },
        },
      );
    } catch (error) {
      if (stream) {
        await this.releaseProducerLease(stream);
        await this.disposeBackend(stream);
      }
      const outcome: OpenRecordOutcome = {
        kind: "reset",
        generation,
        reason: "stream_lost",
        requestedOffset: request.resume
          ? parseCounter(request.resume.nextOffset, "nextOffset")
          : null,
        bufferStartOffset: null,
        tailOffset: null,
      };
      const completed = await this.completeOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
      );
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    if (!stream) throw new Error("Relay v2 terminal stream was not initialized");
    const provisional: ProvisionalGeneration = {
      key,
      openRecordKey: recordKey,
      stream,
    };
    const outcome: OpenRecordOutcome = {
      kind: "opened",
      generation,
      disposition,
      replayFromOffset: 0n,
    };
    let completion: OpenCommitResult;
    try {
      completion = await this.commitOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
        stream,
        false,
      );
    } catch (error) {
      await this.discardProvisionalGeneration(provisional);
      throw error;
    }
    const completed = completion.outcome;
    if (!completion.committed) {
      await this.discardProvisionalGeneration(provisional);
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    if (completed.kind !== "opened") {
      await this.discardProvisionalGeneration(provisional);
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    this.streams.set(key, stream);
    this.cacheOpenRecord({
      key: recordKey,
      streamKey: key,
      fingerprint: requestFingerprint,
      expiresAt: this.now() + this.limits.controlRetentionMs,
      outcome: completed,
      resumeToken: stream.resumeToken,
    });
    await this.bindOpened(request, stream, completed.disposition, completed.replayFromOffset, false);
  }

  private async discardProvisionalGeneration(
    provisional: ProvisionalGeneration,
  ): Promise<void> {
    const { stream, key, openRecordKey } = provisional;
    stream.status = "lost";
    stream.binding = undefined;
    stream.detachedUntil = undefined;
    stream.pendingCloseResponses.clear();
    stream.reservedCloseRecord = false;
    if (this.streams.get(key) === stream) this.streams.delete(key);
    this.openRecords.delete(openRecordKey);
    this.removeRing(stream, false);
    await this.releaseProducerLease(stream);
    this.clearControlWindows(stream);
    await this.disposeBackend(stream);
  }

  private async resumeGeneration(
    request: RelayV2TerminalOpenRequest,
    stream: TerminalStream | undefined,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
  ): Promise<void> {
    const resume = request.resume!;
    const requestedOffset = parseCounter(resume.nextOffset, "nextOffset");
    let outcome: OpenRecordOutcome;
    if (!stream || stream.status === "lost" || !sameTarget(stream.target, request.target)) {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "stream_lost",
        requestedOffset,
        bufferStartOffset: null,
        tailOffset: null,
      };
    } else if (stream.generation !== resume.generation) {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "generation_stale",
        requestedOffset,
        bufferStartOffset: stream.ringRetained ? stream.ring.startOffset : null,
        tailOffset: stream.close?.finalOffset ?? stream.ring.tailOffset,
      };
    } else if (!this.validResumeToken(stream, resume.resumeToken)) {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "stream_lost",
        requestedOffset,
        bufferStartOffset: null,
        tailOffset: null,
      };
    } else {
      const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
      if (requestedOffset > through) {
        throw new RelayV2TerminalManagerError(
          "INVALID_ARGUMENT",
          "terminal resume offset is beyond the known tail",
        );
      }
      if (!this.canReplay(stream, requestedOffset, through)) {
        outcome = {
          kind: "reset",
          generation: stream.generation,
          reason: "offset_expired",
          requestedOffset,
          bufferStartOffset: stream.ringRetained ? stream.ring.startOffset : null,
          tailOffset: through,
        };
      } else {
        outcome = {
          kind: "opened",
          generation: stream.generation,
          disposition: "resumed",
          replayFromOffset: requestedOffset,
        };
      }
    }
    if (outcome.kind === "reset") {
      const completed = await this.completeOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
      );
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    if (!stream!.close) {
      await this.setAttachmentDisplaySizeHint(stream!, request.cols, request.rows);
    }
    const completed = await this.completeOpenRecord(
      request,
      key,
      recordKey,
      requestFingerprint,
      outcome,
      claimAuthority,
      stream,
    );
    this.throwOpenError(completed);
    if (completed.kind === "reset") {
      await this.sendResetResponse(request, completed, "open");
      return;
    }
    await this.bindOpened(request, stream!, completed.disposition, completed.replayFromOffset, false);
  }

  private async resetGeneration(
    request: RelayV2TerminalOpenRequest,
    existing: TerminalStream | undefined,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
  ): Promise<void> {
    if (existing) {
      if (
        existing.status === "closed"
        || existing.status === "lost"
        || !request.resume
        || request.resume.generation !== existing.generation
        || !sameTarget(existing.target, request.target)
        || !this.validResumeToken(existing, request.resume.resumeToken)
      ) {
        const outcome: OpenRecordOutcome = {
          kind: "reset",
          generation: request.resume?.generation ?? null,
          reason: "stream_lost",
          requestedOffset: request.resume
            ? parseCounter(request.resume.nextOffset, "nextOffset")
            : null,
          bufferStartOffset: null,
          tailOffset: null,
        };
        const completed = await this.completeOpenRecord(
          request,
          key,
          recordKey,
          requestFingerprint,
          outcome,
          claimAuthority,
        );
        this.throwOpenError(completed);
        if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
        return;
      }
      existing.binding = undefined;
      existing.status = "lost";
      await this.releaseProducerLease(existing);
      this.clearControlWindows(existing);
      this.removeRing(existing, false);
      await this.disposeBackend(existing);
    } else if (this.liveOrDetachedCount() >= this.limits.maxStreams) {
      const outcome = await this.completeOpenRecord(request, key, recordKey, requestFingerprint, {
        kind: "error",
        code: "BUSY",
        message: "Relay v2 terminal stream quota is full",
      }, claimAuthority);
      this.throwOpenError(outcome);
      return;
    }
    await this.createGeneration(
      request,
      key,
      recordKey,
      requestFingerprint,
      "reset",
      claimAuthority,
    );
  }

  private newStream(
    request: RelayV2TerminalOpenRequest,
    resolvedTarget: RelayV2TerminalResolvedTarget,
    key: string,
    generation: string,
    resumeToken: string,
  ): TerminalStream {
    return {
      key,
      auth: { ...request.auth },
      target: { ...request.target },
      resolvedTarget: { ...resolvedTarget },
      streamId: request.streamId,
      generation,
      resumeToken,
      resumeTokenHash: tokenHash(resumeToken),
      status: "live",
      ring: new ByteRing(this.limits.streamRingBytes),
      ringRetained: true,
      backendPaused: false,
      pauseFailed: false,
      producerOwner: {
        kind: "relay-v2",
        instanceId: `relay-v2:${fingerprint([
          this.hostInstanceId,
          request.auth.principalId,
          request.auth.clientInstanceId,
          request.streamId,
          generation,
        ])}`,
      },
      retainedUntil: this.now() + this.limits.controlRetentionMs,
      pendingCloseResponses: new Map(),
      reservedCloseRecord: true,
      inputAcked: 0n,
      inputFloor: 0n,
      inputHashes: new Map(),
      resizeAcked: 0n,
      resizeFloor: 0n,
      resizes: new Map(),
      lastUsedAt: this.now(),
    };
  }

  private async resolveTarget(
    request: RelayV2TerminalOpenRequest,
  ): Promise<RelayV2TerminalResolvedTarget> {
    const resolved = await this.resolver.resolve({
      auth: { ...request.auth },
      hostEpoch: this.hostEpoch,
      target: { ...request.target },
      pane: request.pane,
    });
    if (
      !resolved
      || !sameTarget(resolved, request.target)
      || resolved.pane !== request.pane
      || typeof resolved.canonicalTargetId !== "string"
      || resolved.canonicalTargetId.length === 0
      || typeof resolved.controlTargetId !== "string"
      || resolved.controlTargetId.length === 0
    ) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "canonical terminal resolver returned a mismatched target",
      );
    }
    return { ...resolved };
  }

  private async setAttachmentDisplaySizeHint(
    stream: TerminalStream,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (!stream.backend) return;
    await stream.backend.setDisplaySizeHint({ cols, rows });
  }

  private setProducerLease(
    stream: TerminalStream,
    lease: RelayV2TerminalProducerLease,
  ): RelayV2TerminalProducerLease {
    const now = this.now();
    const expiresAtMs = Date.parse(lease.expiresAt);
    stream.producerLease = {
      ...lease,
      owner: { ...lease.owner },
    };
    stream.renewLeaseAfter = now + Math.max(1, Math.floor((expiresAtMs - now) / 2));
    return lease;
  }

  private async acquireProducerLease(stream: TerminalStream): Promise<RelayV2TerminalLeaseResult> {
    try {
      const result = validateLeaseResult(
        await this.terminalControl.acquire({
          target: { ...stream.resolvedTarget },
          auth: { ...stream.auth },
          owner: { ...stream.producerOwner },
        }),
        stream.resolvedTarget,
        stream.producerOwner,
        this.now(),
      );
      if (result.status === "accepted") this.setProducerLease(stream, result.lease);
      if (result.status === "uncertain") stream.controlInDoubt = result.error;
      return result;
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") stream.controlInDoubt = failure.error;
      return failure;
    }
  }

  private async ensureProducerLease(stream: TerminalStream): Promise<RelayV2TerminalLeaseResult> {
    if (!stream.producerLease) {
      return this.acquireProducerLease(stream);
    }
    const lease = stream.producerLease;
    if (Date.parse(lease.expiresAt) <= this.now()) {
      const released = await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      if (released.status === "uncertain") {
        stream.controlInDoubt = released.error;
        return { status: "uncertain", error: released.error };
      }
      return this.acquireProducerLease(stream);
    }
    let continuous: boolean;
    try {
      continuous = await this.terminalControl.hasContinuity({
        target: { ...stream.resolvedTarget },
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...lease, owner: { ...lease.owner } },
      });
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") {
        this.dropProducerLease(stream);
        stream.controlInDoubt = failure.error;
      }
      return failure;
    }
    if (continuous !== true) {
      const released = await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      if (released.status === "uncertain") {
        stream.controlInDoubt = released.error;
        return { status: "uncertain", error: released.error };
      }
      return {
        status: "rejected",
        error: {
          code: "PERMISSION_DENIED",
          message: "terminal-control producer lease continuity was lost",
          retryable: false,
          details: null,
          commandDisposition: "not_applicable",
        },
      };
    }
    if (this.now() < (stream.renewLeaseAfter ?? 0)) {
      return { status: "accepted", lease: { ...lease, owner: { ...lease.owner } } };
    }
    try {
      const renewed = validateLeaseResult(
        await this.terminalControl.renew({
          target: { ...stream.resolvedTarget },
          auth: { ...stream.auth },
          owner: { ...stream.producerOwner },
          lease: { ...lease, owner: { ...lease.owner } },
        }),
        stream.resolvedTarget,
        stream.producerOwner,
        this.now(),
        lease,
      );
      if (renewed.status === "accepted") {
        this.setProducerLease(stream, renewed.lease);
        return renewed;
      }
      if (renewed.status === "uncertain") {
        this.dropProducerLease(stream);
        stream.controlInDoubt = renewed.error;
        return renewed;
      }
      const released = await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      if (released.status === "uncertain") {
        stream.controlInDoubt = released.error;
        return { status: "uncertain", error: released.error };
      }
      return renewed;
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") {
        this.dropProducerLease(stream);
        stream.controlInDoubt = failure.error;
      } else {
        const released = await this.releaseProducerLease(stream);
        this.clearControlWindows(stream);
        if (released.status === "uncertain") {
          stream.controlInDoubt = released.error;
          return { status: "uncertain", error: released.error };
        }
      }
      return failure;
    }
  }

  private dropProducerLease(stream: TerminalStream): void {
    stream.producerLease = undefined;
    stream.renewLeaseAfter = undefined;
  }

  private async releaseProducerLease(stream: TerminalStream): Promise<ProducerReleaseResult> {
    const lease = stream.producerLease;
    stream.producerLease = undefined;
    stream.renewLeaseAfter = undefined;
    if (!lease) {
      if (stream.retiringLease) {
        return {
          status: "uncertain",
          error: stream.controlInDoubt ?? {
            code: "COMMAND_IN_DOUBT",
            message: "terminal-control release has not converged",
            retryable: false,
            details: null,
            commandDisposition: "in_doubt",
          },
          lease: { ...stream.retiringLease, owner: { ...stream.retiringLease.owner } },
        };
      }
      return { status: "released" };
    }
    try {
      await this.terminalControl.release({
        target: { ...stream.resolvedTarget },
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...lease, owner: { ...lease.owner } },
      });
      stream.retiringLease = undefined;
      return { status: "released" };
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") {
        stream.retiringLease = { ...lease, owner: { ...lease.owner } };
        return { status: "uncertain", error: failure.error, lease };
      }
      stream.retiringLease = undefined;
      return { status: "rejected", error: failure.error };
    }
  }

  private async endRouteControl(stream: TerminalStream): Promise<void> {
    const result = await this.releaseProducerLease(stream);
    this.clearControlWindows(stream);
    if (result.status === "uncertain") {
      stream.controlInDoubt = result.error;
    }
  }

  private async reconcileRetiringLease(stream: TerminalStream): Promise<void> {
    const lease = stream.retiringLease;
    if (!lease) return;
    try {
      const continuous = await this.terminalControl.hasContinuity({
        target: { ...stream.resolvedTarget },
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...lease, owner: { ...lease.owner } },
      });
      if (continuous !== true && continuous !== false) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "terminal-control returned an invalid release continuity result",
        );
      }
      if (continuous === true) {
        await this.terminalControl.release({
          target: { ...stream.resolvedTarget },
          auth: { ...stream.auth },
          owner: { ...stream.producerOwner },
          lease: { ...lease, owner: { ...lease.owner } },
        });
      }
      stream.retiringLease = undefined;
      stream.controlInDoubt = undefined;
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "rejected") {
        stream.retiringLease = undefined;
        stream.controlInDoubt = undefined;
        return;
      }
      stream.controlInDoubt = failure.error;
    }
  }

  private clearControlWindows(stream: TerminalStream): void {
    stream.inputHashes.clear();
    stream.inputFloor = stream.inputAcked;
    stream.pendingInput = undefined;
    stream.resizes.clear();
    stream.resizeFloor = stream.resizeAcked;
    stream.pendingResize = undefined;
    stream.controlInDoubt = undefined;
  }

  private validResumeToken(stream: TerminalStream, token: string): boolean {
    return safeHashEqual(
      stream.resumeTokenHash,
      tokenHash(token),
    );
  }

  private canReplay(stream: TerminalStream, from: bigint, through: bigint): boolean {
    return stream.ringRetained && stream.ring.hasRange(from, through);
  }

  private prepareClosedNotification(
    stream: TerminalStream,
    route: RelayV2TerminalRuntimeBinding,
  ): "event" | null {
    if (!stream.close) return null;
    const record = [...this.closeRecords.values()].find((candidate) => (
      candidate.streamKey === stream.key
      && candidate.generation === stream.generation
      && (stream.closeId === undefined || candidate.closeId === stream.closeId)
    ));
    if (record) return null;
    if (stream.close.reason === "client_closed") {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "explicit terminal close is missing its correlated tombstone",
      );
    }
    return "event";
  }

  private queueCloseResponse(
    stream: TerminalStream,
    route: RelayV2TerminalRuntimeBinding,
    requestId: string,
    closeRecordKey: string,
    deduplicated: boolean,
  ): void {
    const key = routeRequestKey(route, requestId);
    if (!stream.pendingCloseResponses.has(key) && stream.pendingCloseResponses.size >= 64) {
      throw new RelayV2TerminalManagerError("BUSY", "terminal close response queue is full");
    }
    stream.pendingCloseResponses.set(key, {
      requestId,
      route: cloneRuntimeBinding(route),
      closeRecordKey,
      deduplicated,
    });
  }

  private async fenceChangedBinding(
    stream: TerminalStream,
    nextRoute: RelayV2TerminalRuntimeBinding,
  ): Promise<void> {
    if (!stream.binding || sameRuntimeBinding(stream.binding.route, nextRoute)) return;
    await this.endRouteControl(stream);
    for (const [key, pending] of stream.pendingCloseResponses) {
      if (!sameRuntimeBinding(pending.route, nextRoute)) stream.pendingCloseResponses.delete(key);
    }
  }

  private async bindOpened(
    request: RelayV2TerminalOpenRequest,
    stream: TerminalStream,
    disposition: "new" | "resumed" | "reset",
    replayFromOffset: bigint,
    deduplicated: boolean,
  ): Promise<void> {
    const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
    await this.fenceChangedBinding(stream, request.route);
    stream.status = stream.close ? "closed" : "live";
    stream.detachedUntil = undefined;
    stream.binding = {
      route: cloneRuntimeBinding(request.route),
      ackedOffset: replayFromOffset,
      sentThroughOffset: replayFromOffset,
      phase: "replay",
      replayBoundary: through,
      closeNotification: this.prepareClosedNotification(stream, request.route),
      closeNotified: false,
    };
    stream.lastUsedAt = this.now();
    await this.sendFrame(request.route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.opened",
      requestId: request.requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: stream.target.scopeId,
      sessionId: stream.target.sessionId,
      streamId: stream.streamId,
      hostInstanceId: this.hostInstanceId,
      payload: {
        openId: request.openId,
        deduplicated,
        generation: stream.generation,
        resumeToken: stream.resumeToken,
        disposition,
        replayFromOffset: replayFromOffset.toString(10),
        bufferStartOffset: stream.ring.startOffset.toString(10),
        tailOffset: through.toString(10),
        maxUnackedBytes: this.limits.maxUnackedBytes,
        resetReason: null,
      },
    }));
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private async sendResetResponse(
    request: RelayV2TerminalRequestContext,
    outcome: Extract<OpenRecordOutcome, { kind: "reset" }>,
    origin: "open" | "replay",
  ): Promise<void> {
    let lineage: RelayV2TerminalOpenResponseLineage | undefined;
    if (origin === "open") {
      if (!("openId" in request)
        || !("mode" in request)
        || !isOpaqueId(request.openId)
        || !(request.mode === "new" || request.mode === "resume" || request.mode === "reset")) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "terminal open reset lost its process-local request lineage",
        );
      }
      lineage = Object.freeze({
        owner: "terminal.open",
        requestId: request.requestId,
        openId: request.openId,
        mode: request.mode,
        generation: outcome.generation,
        requestedOffset: outcome.requestedOffset?.toString(10) ?? null,
      });
    }
    await this.sendFrame(request.route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.reset_required",
      requestId: request.requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: request.target.scopeId,
      sessionId: request.target.sessionId,
      streamId: request.streamId,
      payload: {
        origin,
        generation: outcome.generation,
        reason: outcome.reason,
        requestedOffset: outcome.requestedOffset?.toString(10) ?? null,
        bufferStartOffset: outcome.bufferStartOffset?.toString(10) ?? null,
        tailOffset: outcome.tailOffset?.toString(10) ?? null,
      },
    }), lineage);
  }

  private async replayInternal(request: RelayV2TerminalReplayRequest): Promise<void> {
    this.assertHost(request);
    await this.sweepInternal();
    const fromOffset = parseCounter(request.fromOffset, "fromOffset");
    const stream = this.streams.get(this.streamKey(request.auth, request.streamId));
    if (!stream || stream.status === "lost") {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: request.generation,
        reason: "stream_lost",
        requestedOffset: fromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      }, "replay");
      return;
    }
    if (!stream.binding || !sameRuntimeBinding(stream.binding.route, request.route)) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_ROUTE_STALE",
        "terminal route binding is stale",
      );
    }
    if (!sameTarget(stream.target, request.target)) {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: request.generation,
        reason: "stream_lost",
        requestedOffset: fromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      }, "replay");
      return;
    }
    const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
    if (stream.generation !== request.generation) {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: request.generation,
        reason: "generation_stale",
        requestedOffset: fromOffset,
        bufferStartOffset: stream.ringRetained ? stream.ring.startOffset : null,
        tailOffset: through,
      }, "replay");
      return;
    }
    if (fromOffset > through) {
      throw new RelayV2TerminalManagerError(
        "INVALID_ARGUMENT",
        "terminal replay offset is beyond the known tail",
      );
    }
    if (!this.canReplay(stream, fromOffset, through)) {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: stream.generation,
        reason: "offset_expired",
        requestedOffset: fromOffset,
        bufferStartOffset: stream.ringRetained ? stream.ring.startOffset : null,
        tailOffset: through,
      }, "replay");
      return;
    }
    await this.fenceChangedBinding(stream, request.route);
    stream.binding = {
      route: cloneRuntimeBinding(request.route),
      ackedOffset: fromOffset,
      sentThroughOffset: fromOffset,
      phase: "replay",
      replayBoundary: through,
      closeNotification: this.prepareClosedNotification(stream, request.route),
      closeNotified: false,
    };
    await this.sendFrame(request.route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.replay_started",
      requestId: request.requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: stream.target.scopeId,
      sessionId: stream.target.sessionId,
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        fromOffset: fromOffset.toString(10),
        tailOffsetAtStart: through.toString(10),
      },
    }));
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private requireBoundStream(context: RelayV2TerminalStreamContext): TerminalStream;
  private requireBoundStream(context: RelayV2TerminalRequestContext): TerminalStream;
  private requireBoundStream(
    context: RelayV2TerminalStreamContext | RelayV2TerminalRequestContext,
  ): TerminalStream {
    const stream = this.streams.get(this.streamKey(context.auth, context.streamId));
    if (!stream || stream.status === "lost") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is not retained",
      );
    }
    if (!stream.binding || !sameRuntimeBinding(stream.binding.route, context.route)) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_ROUTE_STALE",
        "terminal route binding is stale",
      );
    }
    if ("generation" in context && context.generation !== stream.generation) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_GENERATION_STALE",
        "terminal generation is stale",
      );
    }
    if ("target" in context && !sameTarget(stream.target, context.target)) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_CONFLICT",
        "terminal target does not match the retained stream",
      );
    }
    return stream;
  }

  private async outputAckInternal(ack: RelayV2TerminalOutputAck): Promise<void> {
    await this.sweepInternal();
    const stream = this.requireBoundStream(ack);
    const binding = stream.binding!;
    const nextOffset = parseCounter(ack.nextOffset, "nextOffset");
    if (nextOffset > binding.sentThroughOffset) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_INVALID_ACK",
        "terminal ACK exceeds bytes sent on the current binding",
      );
    }
    if (nextOffset <= binding.ackedOffset) return;
    binding.ackedOffset = nextOffset;
    this.ringBytes -= stream.ring.discardBefore(nextOffset);
    if (this.ringBytes < 0) throw new Error("Relay v2 terminal ring accounting underflow");
    stream.lastUsedAt = this.now();
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private async inputInternal(input: RelayV2TerminalInput): Promise<void> {
    await this.sweepInternal();
    const stream = this.requireBoundStream(input);
    if (stream.status === "closed") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is already closed",
      );
    }
    if (input.data.byteLength > this.limits.maxFrameBytes) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal input exceeds 64 KiB");
    }
    const seq = parsePositiveCounter(input.inputSeq, "inputSeq");
    const hash = payloadHash(input.data);
    if (seq <= stream.inputFloor) {
      await this.sendInputAck(stream);
      return;
    }
    if (seq <= stream.inputAcked) {
      const retained = stream.inputHashes.get(seq.toString(10));
      if (!retained || retained.hash !== hash) {
        await this.sendInputError(stream, seq, "TERMINAL_INPUT_CONFLICT", false);
        return;
      }
      await this.sendInputAck(stream);
      return;
    }
    await this.reconcileRetiringLease(stream);
    if (stream.controlInDoubt) {
      await this.sendAuthorityError(stream, "input", seq, stream.controlInDoubt);
      return;
    }
    const expected = stream.inputAcked + 1n;
    if (seq !== expected) {
      await this.sendInputError(stream, seq, "TERMINAL_INPUT_GAP", true);
      return;
    }
    if (
      stream.pendingInput
      && (stream.pendingInput.seq !== seq || stream.pendingInput.fingerprint !== hash)
    ) {
      await this.sendInputError(stream, seq, "TERMINAL_INPUT_CONFLICT", false);
      return;
    }
    if (stream.pendingInput?.state === "in_doubt") {
      await this.sendAuthorityError(stream, "input", seq, stream.pendingInput.error!);
      return;
    }
    stream.pendingInput = { seq, fingerprint: hash, state: "ready" };
    const leaseResult = await this.ensureProducerLease(stream);
    if (leaseResult.status !== "accepted") {
      if (leaseResult.status === "uncertain") {
        stream.controlInDoubt = leaseResult.error;
        stream.pendingInput = {
          seq,
          fingerprint: hash,
          state: "in_doubt",
          error: leaseResult.error,
        };
      } else if (stream.pendingInput?.seq === seq) {
        stream.pendingInput = undefined;
      }
      await this.sendAuthorityError(stream, "input", seq, leaseResult.error);
      return;
    }
    let result: RelayV2TerminalAuthorityResult;
    try {
      result = validateAuthorityResult(await this.terminalControl.writeInput({
        target: { ...stream.resolvedTarget },
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...leaseResult.lease, owner: { ...leaseResult.lease.owner } },
        operationId: this.operationId(stream, "input", seq),
        data: Buffer.from(input.data),
      }), "input");
    } catch (error) {
      const failure = controlFailure(error);
      result = {
        accepted: false,
        uncertain: failure.status === "uncertain",
        error: failure.error,
      };
    }
    if (result.accepted === false) {
      if (result.uncertain) {
        this.dropProducerLease(stream);
        stream.controlInDoubt = result.error;
        stream.pendingInput = {
          seq,
          fingerprint: hash,
          state: "in_doubt",
          error: result.error,
        };
      } else {
        if (result.error.code === "PERMISSION_DENIED") {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
        }
        if (stream.pendingInput?.seq === seq) stream.pendingInput = undefined;
      }
      await this.sendAuthorityError(stream, "input", seq, result.error);
      return;
    }
    stream.inputAcked = seq;
    stream.inputHashes.set(seq.toString(10), { hash });
    stream.pendingInput = undefined;
    this.trimInputWindow(stream);
    await this.sendInputAck(stream);
  }

  private async resizeInternal(resize: RelayV2TerminalResize): Promise<void> {
    await this.sweepInternal();
    const stream = this.requireBoundStream(resize);
    if (stream.status === "closed") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is already closed",
      );
    }
    validateSize(resize.cols, resize.rows);
    const seq = parsePositiveCounter(resize.resizeSeq, "resizeSeq");
    const sizeFingerprint = `${resize.cols}x${resize.rows}`;
    if (seq <= stream.resizeFloor) {
      await this.sendResizeAck(stream);
      return;
    }
    if (seq <= stream.resizeAcked) {
      const retained = stream.resizes.get(seq.toString(10));
      if (!retained || retained.cols !== resize.cols || retained.rows !== resize.rows) {
        await this.sendResizeError(stream, seq, "TERMINAL_RESIZE_CONFLICT", false);
        return;
      }
      await this.sendResizeAck(stream);
      return;
    }
    await this.reconcileRetiringLease(stream);
    if (stream.controlInDoubt) {
      await this.sendAuthorityError(stream, "resize", seq, stream.controlInDoubt);
      return;
    }
    const expected = stream.resizeAcked + 1n;
    if (seq !== expected) {
      await this.sendResizeError(stream, seq, "TERMINAL_RESIZE_GAP", true);
      return;
    }
    if (
      stream.pendingResize
      && (
        stream.pendingResize.seq !== seq
        || stream.pendingResize.fingerprint !== sizeFingerprint
      )
    ) {
      await this.sendResizeError(stream, seq, "TERMINAL_RESIZE_CONFLICT", false);
      return;
    }
    if (stream.pendingResize?.state === "in_doubt") {
      await this.sendAuthorityError(stream, "resize", seq, stream.pendingResize.error!);
      return;
    }
    stream.pendingResize = { seq, fingerprint: sizeFingerprint, state: "ready" };
    const leaseResult = await this.ensureProducerLease(stream);
    if (leaseResult.status !== "accepted") {
      if (leaseResult.status === "uncertain") {
        stream.controlInDoubt = leaseResult.error;
        stream.pendingResize = {
          seq,
          fingerprint: sizeFingerprint,
          state: "in_doubt",
          error: leaseResult.error,
        };
      } else if (stream.pendingResize?.seq === seq) {
        stream.pendingResize = undefined;
      }
      await this.sendAuthorityError(stream, "resize", seq, leaseResult.error);
      return;
    }
    let result: RelayV2TerminalAuthorityResult;
    try {
      result = validateAuthorityResult(await this.terminalControl.resize({
        target: { ...stream.resolvedTarget },
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...leaseResult.lease, owner: { ...leaseResult.lease.owner } },
        operationId: this.operationId(stream, "resize", seq),
        cols: resize.cols,
        rows: resize.rows,
      }), "resize");
    } catch (error) {
      const failure = controlFailure(error);
      result = {
        accepted: false,
        uncertain: failure.status === "uncertain",
        error: failure.error,
      };
    }
    if (result.accepted === false) {
      if (result.uncertain) {
        this.dropProducerLease(stream);
        stream.controlInDoubt = result.error;
        stream.pendingResize = {
          seq,
          fingerprint: sizeFingerprint,
          state: "in_doubt",
          error: result.error,
        };
      } else {
        if (result.error.code === "PERMISSION_DENIED") {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
        }
        if (stream.pendingResize?.seq === seq) stream.pendingResize = undefined;
      }
      await this.sendAuthorityError(stream, "resize", seq, result.error);
      return;
    }
    stream.resizeAcked = seq;
    stream.resizes.set(seq.toString(10), { cols: resize.cols, rows: resize.rows });
    stream.pendingResize = undefined;
    this.trimResizeWindow(stream);
    await this.sendResizeAck(stream);
  }

  private operationId(
    stream: TerminalStream,
    kind: "input" | "resize",
    seq: bigint,
  ): string {
    return [
      "relay-v2",
      this.hostInstanceId,
      stream.streamId,
      stream.generation,
      kind,
      seq.toString(10),
    ].join(":");
  }

  private trimInputWindow(stream: TerminalStream): void {
    while (stream.inputHashes.size > this.limits.inputDedupeEntries) {
      const next = stream.inputFloor + 1n;
      stream.inputHashes.delete(next.toString(10));
      stream.inputFloor = next;
    }
  }

  private trimResizeWindow(stream: TerminalStream): void {
    while (stream.resizes.size > this.limits.resizeDedupeEntries) {
      const next = stream.resizeFloor + 1n;
      stream.resizes.delete(next.toString(10));
      stream.resizeFloor = next;
    }
  }

  private async sendInputAck(stream: TerminalStream): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.input_ack",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        ackedThroughInputSeq: stream.inputAcked.toString(10),
      },
    }));
  }

  private async sendResizeAck(stream: TerminalStream): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.resize_ack",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        ackedThroughResizeSeq: stream.resizeAcked.toString(10),
      },
    }));
  }

  private async sendInputError(
    stream: TerminalStream,
    seq: bigint,
    code: "TERMINAL_INPUT_GAP" | "TERMINAL_INPUT_CONFLICT",
    retryable: boolean,
  ): Promise<void> {
    const expected = stream.inputAcked + 1n;
    await this.sendAuthorityError(stream, "input", seq, {
      code,
      message: code === "TERMINAL_INPUT_GAP"
        ? `Expected inputSeq ${expected.toString(10)}`
        : "inputSeq payload conflicts with the retained hash",
      retryable,
      details: null,
    });
  }

  private async sendResizeError(
    stream: TerminalStream,
    seq: bigint,
    code: "TERMINAL_RESIZE_GAP" | "TERMINAL_RESIZE_CONFLICT",
    retryable: boolean,
  ): Promise<void> {
    const expected = stream.resizeAcked + 1n;
    await this.sendAuthorityError(stream, "resize", seq, {
      code,
      message: code === "TERMINAL_RESIZE_GAP"
        ? `Expected resizeSeq ${expected.toString(10)}`
        : "resizeSeq dimensions conflict with the retained value",
      retryable,
      details: null,
    });
  }

  private async sendAuthorityError(
    stream: TerminalStream,
    kind: "input" | "resize",
    seq: bigint,
    error: RelayV2TerminalStructuredError,
  ): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    const sequenceField = kind === "input" ? "inputSeq" : "resizeSeq";
    const ackField = kind === "input" ? "ackedThroughInputSeq" : "ackedThroughResizeSeq";
    const ack = kind === "input" ? stream.inputAcked : stream.resizeAcked;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: kind === "input" ? "terminal.input_error" : "terminal.resize_error",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        [sequenceField]: seq.toString(10),
        [ackField]: ack.toString(10),
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          commandDisposition: error.commandDisposition
            ?? (error.code === "COMMAND_IN_DOUBT" ? "in_doubt" : "not_applicable"),
          details: error.details ?? null,
        },
      },
    }));
  }

  private async closeInternal(request: RelayV2TerminalCloseRequest): Promise<void> {
    this.assertHost(request);
    await this.sweepInternal();
    const key = this.streamKey(request.auth, request.streamId);
    const recordKey = this.closeRecordKey(request);
    const requestFingerprint = this.closeFingerprint(request);
    const retained = this.closeRecords.get(recordKey);
    if (retained) {
      if (retained.fingerprint !== requestFingerprint) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_CLOSE_CONFLICT",
          "terminal closeId was reused with a different request",
        );
      }
      const stream = this.streams.get(retained.streamKey);
      await this.deliverCloseResponse(request, retained, stream, true);
      return;
    }

    const stream = this.streams.get(key);
    let proposed: RelayV2TerminalDurableCloseIntent | undefined;
    if (stream && stream.status !== "lost" && sameTarget(stream.target, request.target)) {
      if (stream.generation !== request.generation) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_GENERATION_STALE",
          "terminal close targets a stale generation",
        );
      }
      if (!this.validResumeToken(stream, request.resumeToken)) {
        throw new RelayV2TerminalManagerError(
          "PERMISSION_DENIED",
          "terminal close capability is invalid",
        );
      }
      if (stream.closeId && stream.closeId !== request.closeId) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_CLOSE_CONFLICT",
          "terminal generation already has a different closeId",
        );
      }
      if (stream.status !== "closed"
        && (!stream.binding || !sameRuntimeBinding(stream.binding.route, request.route))) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_ROUTE_STALE",
          "only the current connector route may close a live terminal stream",
        );
      }
      if (!stream.close && !stream.reservedCloseRecord) this.requireControlSlots(1);
      const winner = stream.close ?? {
        finalOffset: stream.ring.tailOffset,
        reason: "client_closed" as const,
        exitCode: null,
      };
      proposed = {
        key: recordKey,
        streamKey: key,
        fingerprint: requestFingerprint,
        hostInstanceId: this.hostInstanceId,
        target: { ...stream.target },
        streamId: stream.streamId,
        closeId: request.closeId,
        requestId: request.requestId,
        requestRoute: durableRoute(request.route),
        generation: stream.generation,
        finalOffset: winner.finalOffset.toString(10),
        reason: winner.reason,
        exitCode: winner.exitCode,
        expiresAtMs: this.now() + this.limits.controlRetentionMs,
      };
    }

    const claim = await this.lineage.claimClose({
      key: recordKey,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      ...(proposed ? { intent: proposed } : {}),
    });
    if (!claim || typeof claim !== "object" || typeof claim.status !== "string") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid close claim");
    }
    if (claim.status === "close_conflict") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_CLOSE_CONFLICT",
        "terminal closeId was durably retained with a different request",
      );
    }
    if (claim.status === "not_found") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is not retained",
      );
    }
    if (claim.status === "final") {
      const record = this.closeRecordFromDurable(claim.tombstone, recordKey, request);
      this.cacheCloseRecord(record, stream);
      await this.deliverCloseResponse(request, record, stream, true);
      return;
    }
    if (claim.status !== "claimed" && claim.status !== "existing_intent") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an unknown close claim");
    }
    if (claim.status === "claimed" && !proposed) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage claimed a close without an intent");
    }
    const intent = this.closeRecordFromDurable(claim.intent, recordKey, request);
    if (claim.status === "claimed" && proposed && !sameDurableClose(claim.intent, proposed)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal close claim changed the proposed winner");
    }
    if (
      stream
      && stream.status !== "lost"
      && stream.generation === intent.generation
      && sameTarget(stream.target, intent.target)
    ) {
      if (!stream.close) this.commitTerminalCondition(stream, intent.reason, intent.exitCode);
      if (
        !stream.close
        || stream.close.finalOffset !== intent.finalOffset
        || stream.close.reason !== intent.reason
        || stream.close.exitCode !== intent.exitCode
      ) {
        throw new RelayV2TerminalManagerError("INTERNAL", "terminal close winner diverged from its durable intent");
      }
      await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      await this.disposeBackend(stream);
    }
    const final = await this.lineage.finalizeClose({
      key: recordKey,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
    });
    const record = this.closeRecordFromDurable(final, recordKey, request);
    if (!sameDurableClose(final, claim.intent)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal close finalization changed its winner");
    }
    this.cacheCloseRecord(record, stream);
    if (stream && stream.generation === record.generation) {
      stream.closeId = record.closeId;
      stream.reservedCloseRecord = false;
    }
    await this.deliverCloseResponse(request, record, stream, claim.status !== "claimed");
  }

  private async deliverCloseResponse(
    request: RelayV2TerminalCloseRequest,
    record: CloseRecord,
    stream: TerminalStream | undefined,
    deduplicated: boolean,
  ): Promise<void> {
    if (
      stream?.binding
      && stream.generation === record.generation
      && sameRuntimeBinding(stream.binding.route, request.route)
    ) {
      this.queueCloseResponse(
        stream,
        request.route,
        request.requestId,
        record.key,
        deduplicated,
      );
      await this.pump(stream);
      return;
    }
    await this.sendCloseResponse(request.route, request.requestId, record, stream, deduplicated);
  }

  private closeRecordToDurable(record: CloseRecord): RelayV2TerminalDurableCloseTombstone {
    return {
      key: record.key,
      streamKey: record.streamKey,
      fingerprint: record.fingerprint,
      hostInstanceId: record.hostInstanceId,
      target: { ...record.target },
      streamId: record.streamId,
      closeId: record.closeId,
      requestId: record.requestId,
      requestRoute: durableRoute(record.requestRoute),
      generation: record.generation,
      finalOffset: record.finalOffset.toString(10),
      reason: record.reason,
      exitCode: record.exitCode,
      expiresAtMs: record.expiresAt,
    };
  }

  private closeRecordFromDurable(
    rawValue: unknown,
    expectedKey: string,
    request: RelayV2TerminalCloseRequest,
  ): CloseRecord {
    if (!rawValue || typeof rawValue !== "object") {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal close tombstone failed validation",
      );
    }
    const value = rawValue as RelayV2TerminalDurableCloseTombstone;
    let finalOffset: bigint;
    try {
      finalOffset = parseCounter(value.finalOffset, "durable finalOffset");
    } catch {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal close tombstone failed validation",
      );
    }
    const reason = value.reason;
    const exitCode = value.exitCode;
    const valid = value.key === expectedKey
      && value.streamKey === this.streamKey(request.auth, request.streamId)
      && typeof value.fingerprint === "string"
      && /^[0-9a-f]{64}$/.test(value.fingerprint)
      && value.fingerprint === this.closeFingerprint(request)
      && isOpaqueId(value.hostInstanceId)
      && value.target?.hostId === this.hostId
      && sameTarget(value.target, request.target)
      && value.streamId === request.streamId
      && value.closeId === request.closeId
      && isOpaqueId(value.requestId)
      && isOpaqueId(value.requestRoute?.connectorId)
      && isOpaqueId(value.requestRoute?.routeId)
      && isOpaqueId(value.requestRoute?.routeFence)
      && hasExactOwnKeys(value.requestRoute, ["connectorId", "routeId", "routeFence"])
      && isOpaqueId(value.generation)
      && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > this.now()
      && value.expiresAtMs <= this.now() + this.limits.controlRetentionMs
      && (
        (reason === "client_closed" && exitCode === null)
        || (reason === "backend_exit" && Number.isInteger(exitCode))
        || (reason === "backend_error" && (exitCode === null || Number.isInteger(exitCode)))
      )
      && (
        exitCode === null
        || (exitCode >= -2_147_483_648 && exitCode <= 2_147_483_647)
      );
    if (!valid) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal close tombstone failed validation",
      );
    }
    return {
      key: value.key,
      streamKey: value.streamKey,
      fingerprint: value.fingerprint,
      hostInstanceId: value.hostInstanceId,
      target: { ...value.target },
      streamId: value.streamId,
      closeId: value.closeId,
      requestId: value.requestId,
      requestRoute: durableRoute(value.requestRoute),
      generation: value.generation,
      finalOffset,
      reason,
      exitCode,
      expiresAt: value.expiresAtMs,
    };
  }

  private commitTerminalCondition(
    stream: TerminalStream,
    reason: RelayV2TerminalCloseReason,
    exitCode: number | null,
  ): void {
    if (stream.close) return;
    const now = this.now();
    stream.close = {
      finalOffset: stream.ring.tailOffset,
      reason,
      exitCode,
      closedAt: now,
      ringExpiresAt: now + this.limits.detachedLeaseMs,
    };
    stream.status = "closed";
    stream.detachedUntil = undefined;
    stream.retainedUntil = now + this.limits.controlRetentionMs;
    for (const record of this.openRecords.values()) {
      if (record.streamKey === stream.key) {
        record.expiresAt = Math.max(record.expiresAt, stream.retainedUntil);
      }
    }
  }

  private async sendCloseResponse(
    route: RelayV2TerminalRuntimeBinding,
    requestId: string,
    record: CloseRecord,
    stream: TerminalStream | undefined,
    deduplicated: boolean,
  ): Promise<void> {
    const replayAvailable = !!stream
      && stream.generation === record.generation
      && stream.ringRetained
      && stream.ring.hasRange(stream.ring.startOffset, record.finalOffset);
    await this.sendFrame(route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.closed",
      requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      hostInstanceId: this.hostInstanceId,
      scopeId: record.target.scopeId,
      sessionId: record.target.sessionId,
      streamId: record.streamId,
      payload: {
        closeId: record.closeId,
        generation: record.generation,
        finalOffset: record.finalOffset.toString(10),
        replayAvailable,
        bufferStartOffset: replayAvailable ? stream!.ring.startOffset.toString(10) : null,
        reason: record.reason,
        exitCode: record.exitCode,
        deduplicated,
      },
    }));
  }

  private async backendOutput(
    key: string,
    generation: string,
    data: Uint8Array,
  ): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream || stream.generation !== generation || stream.status === "closed" || stream.status === "lost") {
      return;
    }
    let offset = 0;
    while (offset < data.byteLength) {
      const end = Math.min(data.byteLength, offset + this.limits.maxFrameBytes);
      const part = data.subarray(offset, end);
      const accepted = await this.appendOutput(stream, part);
      if (!accepted) return;
      offset = end;
    }
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private async rejectBackendChunk(key: string, generation: string): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream || stream.generation !== generation || stream.status === "lost") return;
    await this.loseStream(stream, "stream_lost", true);
  }

  private async appendOutput(stream: TerminalStream, data: Uint8Array): Promise<boolean> {
    if (stream.ring.tailOffset + BigInt(data.byteLength) > MAX_COUNTER) {
      await this.loseStream(stream, "host_buffer_pressure", true);
      return false;
    }
    const binding = stream.binding;
    const predictedStart = stream.ring.predictedStartAfter(data.byteLength);
    if (binding && predictedStart > binding.ackedOffset) {
      await this.loseStream(stream, "slow_consumer", true);
      return false;
    }
    const additionalBytes = Math.min(
      data.byteLength,
      this.limits.streamRingBytes - stream.ring.length,
    );
    await this.reclaimHostRing(additionalBytes, stream);
    if (this.ringBytes + additionalBytes > this.limits.hostRingBytes) {
      await this.loseStream(stream, "host_buffer_pressure", true);
      return false;
    }
    const before = stream.ring.length;
    stream.ring.append(data);
    this.ringBytes += stream.ring.length - before;
    stream.ringRetained = true;
    stream.lastUsedAt = this.now();
    if (this.ringBytes > this.limits.hostRingBytes) {
      throw new Error("Relay v2 terminal host ring exceeded its hard limit");
    }
    return true;
  }

  private async reclaimHostRing(requiredBytes: number, current: TerminalStream): Promise<void> {
    if (this.ringBytes + requiredBytes <= this.limits.hostRingBytes) return;
    const candidates = [...this.streams.values()]
      .filter((stream) => stream !== current && stream.ring.length > 0)
      .sort((left, right) => {
        const rank = (stream: TerminalStream) => stream.status === "closed"
          ? 0
          : stream.status === "detached"
            ? 1
            : 2;
        return rank(left) - rank(right) || left.lastUsedAt - right.lastUsedAt;
      });
    for (const candidate of candidates) {
      if (candidate.status !== "closed" && candidate.status !== "detached") break;
      this.removeRing(candidate, candidate.status !== "closed");
      if (this.ringBytes + requiredBytes <= this.limits.hostRingBytes) break;
    }
  }

  private removeRing(stream: TerminalStream, retainEmptyTimeline: boolean): void {
    this.ringBytes -= stream.ring.clear();
    stream.ringRetained = retainEmptyTimeline;
    if (this.ringBytes < 0) throw new Error("Relay v2 terminal ring accounting underflow");
  }

  private async backendClosed(
    key: string,
    generation: string,
    result: RelayV2TerminalBackendClose,
  ): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream || stream.generation !== generation || stream.close || stream.status === "lost") {
      return;
    }
    const exitCodeValid = result.exitCode === null
      || (
        Number.isInteger(result.exitCode)
        && result.exitCode >= -2_147_483_648
        && result.exitCode <= 2_147_483_647
      );
    if (!exitCodeValid || (result.reason === "backend_exit" && result.exitCode === null)) {
      result = { reason: "backend_error", exitCode: null };
    }
    stream.backend = undefined;
    stream.backendPaused = false;
    await this.releaseProducerLease(stream);
    this.clearControlWindows(stream);
    this.commitTerminalCondition(stream, result.reason, result.exitCode);
    if (stream.binding) {
      stream.binding.closeNotification = "event";
      stream.binding.closeNotified = false;
      await this.pump(stream);
    }
    await this.refreshBackpressure();
  }

  private async pump(stream: TerminalStream): Promise<void> {
    let binding = stream.binding;
    while (binding && stream.binding === binding) {
      if (binding.phase === "replay" && binding.sentThroughOffset >= binding.replayBoundary) {
        binding.phase = "live";
      }
      const through = binding.phase === "replay"
        ? binding.replayBoundary
        : stream.close?.finalOffset ?? stream.ring.tailOffset;
      if (binding.sentThroughOffset >= through) break;
      if (binding.sentThroughOffset < stream.ring.startOffset || !stream.ringRetained) {
        await this.sendAsyncReset(stream, "slow_consumer");
        return;
      }
      const unacked = binding.sentThroughOffset - binding.ackedOffset;
      const credit = BigInt(this.limits.maxUnackedBytes) - unacked;
      if (credit <= 0n) break;
      const maxBytes = Number(
        credit < BigInt(this.limits.maxFrameBytes)
          ? credit
          : BigInt(this.limits.maxFrameBytes),
      );
      const data = stream.ring.read(binding.sentThroughOffset, maxBytes, through);
      if (data.byteLength === 0) {
        await this.sendAsyncReset(stream, "slow_consumer");
        return;
      }
      const offset = binding.sentThroughOffset;
      await this.sendFrame(binding.route, asJson({
        protocolVersion: 2,
        kind: "event",
        type: "terminal.output",
        streamId: stream.streamId,
        payload: {
          generation: stream.generation,
          offset: offset.toString(10),
          encoding: "base64",
          data: data.toString("base64"),
        },
      }));
      if (stream.binding !== binding) return;
      binding.sentThroughOffset += BigInt(data.byteLength);
      stream.lastUsedAt = this.now();
    }
    binding = stream.binding;
    if (
      !binding
      || stream.binding !== binding
      || !stream.close
      || binding.sentThroughOffset !== stream.close.finalOffset
    ) {
      return;
    }
    for (const [key, pending] of stream.pendingCloseResponses) {
      if (!sameRuntimeBinding(pending.route, binding.route)) continue;
      const record = this.closeRecords.get(pending.closeRecordKey);
      if (!record) continue;
      await this.sendCloseResponse(
        pending.route,
        pending.requestId,
        record,
        stream,
        pending.deduplicated,
      );
      stream.pendingCloseResponses.delete(key);
      if (stream.binding !== binding) return;
    }
    if (binding.closeNotification === "event" && !binding.closeNotified) {
      await this.sendFrame(binding.route, asJson({
        protocolVersion: 2,
        kind: "event",
        type: "terminal.closed",
        streamId: stream.streamId,
        payload: {
          generation: stream.generation,
          finalOffset: stream.close.finalOffset.toString(10),
          replayAvailable: stream.ringRetained,
          bufferStartOffset: stream.ringRetained
            ? stream.ring.startOffset.toString(10)
            : null,
          reason: stream.close.reason,
          exitCode: stream.close.exitCode,
        },
      }));
      binding.closeNotified = true;
    }
  }

  private async sendAsyncReset(stream: TerminalStream, reason: ResetReason): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    stream.binding = undefined;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.reset_required",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        reason,
        requestedOffset: null,
        bufferStartOffset: stream.ringRetained
          ? stream.ring.startOffset.toString(10)
          : null,
        tailOffset: stream.ring.tailOffset.toString(10),
      },
    }));
  }

  private async loseStream(
    stream: TerminalStream,
    reason: "slow_consumer" | "host_buffer_pressure" | "stream_lost",
    notify: boolean,
  ): Promise<void> {
    let sendError: unknown;
    if (notify) {
      try {
        await this.sendAsyncReset(stream, reason);
      } catch (error) {
        sendError = error;
      }
    }
    try {
      stream.status = "lost";
      stream.detachedUntil = undefined;
      stream.retainedUntil = this.now() + this.limits.controlRetentionMs;
      stream.inputHashes.clear();
      stream.resizes.clear();
      stream.pendingInput = undefined;
      stream.pendingResize = undefined;
      this.removeRing(stream, false);
      await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      for (const record of this.openRecords.values()) {
        if (record.streamKey === stream.key) {
          record.expiresAt = Math.max(record.expiresAt, stream.retainedUntil);
        }
      }
      await this.disposeBackend(stream);
    } finally {
      if (sendError) throw sendError;
    }
  }

  private async refreshBackpressure(): Promise<void> {
    const hostLowWater = Math.floor(this.limits.hostRingBytes * 3 / 4);
    if (!this.hostPressure && this.ringBytes >= this.limits.hostRingBytes) {
      this.hostPressure = true;
    } else if (this.hostPressure && this.ringBytes <= hostLowWater) {
      this.hostPressure = false;
    }
    const streamLowWater = Math.floor(this.limits.streamRingBytes * 3 / 4);
    for (const stream of this.streams.values()) {
      if (!stream.backend || stream.status === "closed" || stream.status === "lost") continue;
      const streamPressure = stream.backendPaused
        ? stream.ring.length > streamLowWater
        : stream.ring.length >= this.limits.streamRingBytes;
      const shouldPause = this.hostPressure || streamPressure;
      if (shouldPause === stream.backendPaused) continue;
      if (shouldPause) {
        try {
          await stream.backend.pause();
          stream.backendPaused = true;
        } catch {
          stream.pauseFailed = true;
        }
      } else {
        try {
          await stream.backend.resume();
          stream.backendPaused = false;
          stream.pauseFailed = false;
        } catch {
          stream.pauseFailed = true;
        }
      }
    }
  }

  private async disposeBackend(stream: TerminalStream): Promise<void> {
    const handle = stream.backend;
    if (!handle) return;
    stream.backend = undefined;
    stream.backendPaused = false;
    try {
      await handle.close();
    } catch {
      // The stream/generation is fenced before attachment cleanup. Never open
      // a fallback backend or let a late callback mutate the replacement.
    }
  }

  private async sweepInternal(maintainProducerLeases = false): Promise<void> {
    const now = this.now();
    for (const stream of this.streams.values()) {
      if (maintainProducerLeases && stream.status === "live" && stream.producerLease) {
        if (Date.parse(stream.producerLease.expiresAt) <= now) {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
          continue;
        }
        try {
          await this.ensureProducerLease(stream);
        } catch {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
          continue;
        }
      }
      if (
        stream.status === "detached"
        && stream.detachedUntil !== undefined
        && stream.detachedUntil <= now
      ) {
        stream.status = "lost";
        stream.retainedUntil = now + this.limits.controlRetentionMs;
        await this.releaseProducerLease(stream);
        this.clearControlWindows(stream);
        this.removeRing(stream, false);
        await this.disposeBackend(stream);
      }
      if (
        stream.status === "closed"
        && stream.close
        && stream.close.ringExpiresAt <= now
        && stream.ringRetained
      ) {
        this.removeRing(stream, false);
      }
    }

    for (const [key, record] of this.openRecords) {
      const stream = this.streams.get(record.streamKey);
      const currentLiveGeneration = record.outcome.kind === "opened"
        && stream
        && (stream.status === "live" || stream.status === "detached")
        && stream.generation === record.outcome.generation;
      if (record.expiresAt <= now && !currentLiveGeneration) this.openRecords.delete(key);
    }
    for (const [key, record] of this.closeRecords) {
      if (record.expiresAt <= now) this.closeRecords.delete(key);
    }
    for (const [key, stream] of this.streams) {
      if (
        (stream.status === "closed" || stream.status === "lost")
        && stream.retainedUntil <= now
        && ![...this.openRecords.values()].some((record) => record.streamKey === key)
        && ![...this.closeRecords.values()].some((record) => record.streamKey === key)
      ) {
        stream.reservedCloseRecord = false;
        this.removeRing(stream, false);
        this.streams.delete(key);
      }
    }
    await this.refreshBackpressure();
  }
}
