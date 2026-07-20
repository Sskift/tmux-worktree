import { createHash, randomUUID } from "node:crypto";
import { issueRelayV2CanonicalBackendInstanceKey } from "./canonicalBackendIdentity.js";
import type {
  RelayV2HostJson,
  RelayV2HostStateCriticalSection,
  RelayV2HostStateSnapshot,
  RelayV2HostStateStore,
  RelayV2HostStateTransaction,
} from "./hostState.js";
import {
  RELAY_V2_TERMINAL_CONTROL_RETENTION_MS,
  RELAY_V2_TERMINAL_MAX_CONTROL_RECORDS,
  RELAY_V2_TERMINAL_MAX_STREAMS,
  captureRelayV2TerminalManagerRecoveryBinding,
  type RelayV2TerminalDurableCloseClaimResult,
  type RelayV2TerminalDurableCloseIntent,
  type RelayV2TerminalDurableCloseTombstone,
  type RelayV2TerminalDurableLineage,
  type RelayV2TerminalDurableOpenClaim,
  type RelayV2TerminalDurableOpenClaimResult,
  type RelayV2TerminalDurableOpenCommitResult,
  type RelayV2TerminalDurableOpenOutcome,
  type RelayV2TerminalDurableOpenPrepareResult,
  type RelayV2TerminalDurableOpenReplayResult,
  type RelayV2TerminalDurableStreamAuthority,
  type RelayV2TerminalDurableStreamClosedResult,
  type RelayV2TerminalDurableStreamReleaseResult,
  type RelayV2TerminalOpenFailureStreamEffect,
  type RelayV2TerminalManagerRecoveryBinding,
  type RelayV2TerminalCanonicalResolver,
  type RelayV2TerminalCanonicalResolution,
  type RelayV2TerminalCanonicalTargetBindingV1,
  type RelayV2TerminalRoute,
  type RelayV2TerminalWireTarget,
} from "./terminalManager.js";

const RELAY_V2_HOST_H3_RECOVERY_CANDIDATE_ISSUER = Symbol.for(
  "tmux-worktree.relay-v2.host-h3-recovery-candidate-issuer",
);

declare const RELAY_V2_HOST_H3_RECOVERY_CANDIDATE: unique symbol;

/** One-shot process capability issued only after durable H3 owner recovery. */
export type RelayV2HostH3RecoveryCandidate = Readonly<object> & {
  readonly [RELAY_V2_HOST_H3_RECOVERY_CANDIDATE]: true;
};

export interface RelayV2HostH3RecoveryCandidateSink {
  close(error?: unknown): void;
}

export interface RelayV2HostH3RecoveryCandidateAuthority {
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly ownerFence: string;
  consume(
    sink: RelayV2HostH3RecoveryCandidateSink,
  ): RelayV2TerminalManagerRecoveryBinding | null;
  release(sink: RelayV2HostH3RecoveryCandidateSink): boolean;
}

interface RelayV2HostH3RecoveryCandidateIssuer {
  capture(candidate: unknown): RelayV2HostH3RecoveryCandidateAuthority | null;
}

interface ActiveH3Candidate {
  retire(): void;
}

const activeH3Candidates = new Map<string, ActiveH3Candidate>();

/**
 * Captures the candidate's lexical issuer. Symbol discovery is not authority:
 * the issuer closure still compares the exact original candidate identity.
 */
export function captureRelayV2HostH3RecoveryCandidate(
  value: unknown,
): RelayV2HostH3RecoveryCandidateAuthority | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(
      value,
      RELAY_V2_HOST_H3_RECOVERY_CANDIDATE_ISSUER,
    );
  } catch {
    return null;
  }
  if (!descriptor
    || !Object.hasOwn(descriptor, "value")
    || descriptor.configurable !== false
    || descriptor.enumerable !== false
    || descriptor.writable !== false
    || !descriptor.value
    || typeof descriptor.value !== "object") return null;
  const issuer = descriptor.value as RelayV2HostH3RecoveryCandidateIssuer;
  const capture = Object.getOwnPropertyDescriptor(issuer, "capture");
  if (!capture
    || !Object.hasOwn(capture, "value")
    || typeof capture.value !== "function") return null;
  try {
    return Reflect.apply(capture.value, issuer, [value]);
  } catch {
    return null;
  }
}

function issueRelayV2HostH3RecoveryCandidate(
  binding: RelayV2TerminalManagerRecoveryBinding,
  ownerFence: string,
): RelayV2HostH3RecoveryCandidate {
  let status: "issued" | "consumed" | "retired" = "issued";
  let sink: RelayV2HostH3RecoveryCandidateSink | null = null;
  let fatalSink: ((error: unknown) => void) | null = null;
  let candidate: RelayV2HostH3RecoveryCandidate;

  const state: ActiveH3Candidate = Object.freeze({
    retire(): void {
      if (status === "retired") return;
      status = "retired";
      if (activeH3Candidates.get(binding.hostEpoch) === state) {
        activeH3Candidates.delete(binding.hostEpoch);
      }
      if (fatalSink !== null) binding.clearFatalSink(fatalSink);
      fatalSink = null;
      const observed = sink;
      sink = null;
      if (observed !== null) {
        try { observed.close(); } catch {}
      }
    },
  });

  const authority: RelayV2HostH3RecoveryCandidateAuthority = Object.freeze({
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    hostInstanceId: binding.hostInstanceId,
    ownerFence,
    consume(candidateSink): RelayV2TerminalManagerRecoveryBinding | null {
      if (!candidateSink
        || typeof candidateSink !== "object"
        || typeof candidateSink.close !== "function"
        || status !== "issued"
        || activeH3Candidates.get(binding.hostEpoch) !== state) return null;
      const managerFatalSink = (error: unknown) => candidateSink.close(error);
      if (!binding.installFatalSink(managerFatalSink)) return null;
      status = "consumed";
      sink = candidateSink;
      fatalSink = managerFatalSink;
      return binding;
    },
    release(candidateSink): boolean {
      if (status !== "consumed" || sink !== candidateSink) return false;
      sink = null;
      state.retire();
      return true;
    },
  });
  const issuer: RelayV2HostH3RecoveryCandidateIssuer = Object.freeze({
    capture(value): RelayV2HostH3RecoveryCandidateAuthority | null {
      return value === candidate ? authority : null;
    },
  });
  const issued = Object.create(null) as RelayV2HostH3RecoveryCandidate;
  Object.defineProperty(issued, RELAY_V2_HOST_H3_RECOVERY_CANDIDATE_ISSUER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: issuer,
  });
  candidate = Object.freeze(issued);

  activeH3Candidates.get(binding.hostEpoch)?.retire();
  activeH3Candidates.set(binding.hostEpoch, state);
  return candidate;
}

const TERMINAL_LINEAGE_KEY = "h3:terminal-durable-lineage:v1";
// Revision 3 adds the mandatory prepared exact H2/control binding. Revisions 1
// and 2 are deliberately not migrated: this foundation is not production
// wired, and accepting their weaker target identity would be unsafe.
const TERMINAL_LINEAGE_SCHEMA_VERSION = 3 as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

export interface RelayV2TerminalDurableLineageLimits {
  maxControlRecords: number;
  maxStreams: number;
}

export const RELAY_V2_TERMINAL_DURABLE_LINEAGE_LIMITS:
  Readonly<RelayV2TerminalDurableLineageLimits> = Object.freeze({
  maxControlRecords: RELAY_V2_TERMINAL_MAX_CONTROL_RECORDS,
  maxStreams: RELAY_V2_TERMINAL_MAX_STREAMS,
});

export type RelayV2TerminalDurableLineageErrorCode =
  | "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE"
  | "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT"
  | "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT"
  | "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT";

export class RelayV2TerminalDurableLineageError extends Error {
  constructor(
    readonly code: RelayV2TerminalDurableLineageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelayV2TerminalDurableLineageError";
  }
}

export interface RelayV2TerminalDurableLineageAuthorityOptions {
  store: Pick<RelayV2HostStateStore, "serialize" | "hostInstanceId">;
  now?: () => number;
  issueAuthorityId?: (kind: "claim" | "fence") => string;
  /**
   * Independent exact resolver fence. Omission keeps write admission
   * unreachable; it never falls back to terminal-control v1 target.resolve.
   */
  admissionFence?: Pick<RelayV2TerminalCanonicalResolver, "fenceSessionForAdmission">;
  /** Tests may only shrink the frozen authority bounds. */
  testLimits?: Partial<RelayV2TerminalDurableLineageLimits>;
}

interface PersistedStreamAuthority {
  status: "live" | "closed";
  streamKey: string;
  generation: string;
  hostInstanceId: string;
  target: RelayV2TerminalWireTarget;
  pane: number;
  resumeTokenHash: string;
  canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1;
  closeSlotReserved: boolean;
  closedExpiresAtMs: number | null;
}

interface PersistedLostAuthority {
  streamKey: string;
  generation: string;
  ownerHostInstanceId: string;
  target: RelayV2TerminalWireTarget;
  pane: number;
  resumeTokenHash: string;
  canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1;
  expiresAtMs: number;
}

type PersistedClaimStreamAuthority =
  | { status: "absent" }
  | {
      status: "live" | "closed" | "lost";
      generation: string;
      hostInstanceId: string;
      target: RelayV2TerminalWireTarget;
      pane: number;
      resumeTokenHash: string;
      canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1;
      requestedOffset: string | null;
    };

interface PersistedOpenRecord {
  status: "pending" | "final";
  key: string;
  streamKey: string;
  fingerprint: string;
  ownerHostInstanceId: string;
  claimToken: string;
  fence: string;
  target: RelayV2TerminalWireTarget;
  pane: number;
  resumeTokenHash: string | null;
  mode: "new" | "resume" | "reset";
  previousGeneration: string | null;
  requestedOffset: string | null;
  streamAuthority: PersistedClaimStreamAuthority;
  /** Exact digest of same-stream lost/close rows at the claim transaction cut. */
  retainedAuthorityDigest: string;
  reservesStreamSlot: boolean;
  issuedGeneration: string | null;
  preparedBinding: RelayV2TerminalCanonicalTargetBindingV1 | null;
  expiresAtMs: number;
  outcome: RelayV2TerminalDurableOpenOutcome | null;
}

interface PersistedCloseRecord {
  status: "intent" | "final";
  ownerHostInstanceId: string;
  ownerFence: string;
  value: RelayV2TerminalDurableCloseTombstone;
}

interface PersistedTerminalLineageState {
  schemaVersion: typeof TERMINAL_LINEAGE_SCHEMA_VERSION;
  authority: "relay_v2_terminal_durable_lineage";
  hostEpoch: string;
  activeHostInstanceId: string | null;
  ownerFence: string;
  generationHighWater: string;
  openRecords: PersistedOpenRecord[];
  streamAuthorities: PersistedStreamAuthority[];
  lostAuthorities: PersistedLostAuthority[];
  closeRecords: PersistedCloseRecord[];
}

function lineageError(
  code: RelayV2TerminalDurableLineageErrorCode,
  message: string,
): never {
  throw new RelayV2TerminalDurableLineageError(code, message);
}

function requireSynchronousAdmissionFence(value: unknown): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    void Promise.resolve(value).catch(() => undefined);
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE",
      "Relay v2 terminal admission fence exposed an unsafe asynchronous result",
    );
  }
  if (typeof then !== "function") return;
  void Promise.resolve(value).catch(() => undefined);
  return lineageError(
    "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE",
    "Relay v2 terminal admission fence must complete synchronously",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isOpaque(value: unknown, maxBytes = 128): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\0\r\n]/.test(value)
    && value.trim() === value;
}

function isDurableKey(value: unknown): value is string {
  return isOpaque(value, 2_048);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function retainedAuthorityDigest(
  state: Pick<PersistedTerminalLineageState, "lostAuthorities" | "closeRecords">,
  streamKey: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    lost: state.lostAuthorities.filter((candidate) => candidate.streamKey === streamKey),
    close: state.closeRecords.filter((candidate) => candidate.value.streamKey === streamKey),
  })).digest("hex");
}

function isCounter(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
}

function issuedGeneration(hostEpoch: string, highWater: string): string {
  return `terminal-gen-${hostEpoch}-${highWater}`;
}

function issuedGenerationCounter(value: string, hostEpoch: string): bigint | null {
  const prefix = `terminal-gen-${hostEpoch}-`;
  if (!value.startsWith(prefix)) return null;
  const counter = value.slice(prefix.length);
  return isCounter(counter) && counter !== "0" ? BigInt(counter) : null;
}

function nextCounter(value: string): string | null {
  const next = BigInt(value) + 1n;
  return next > MAX_UINT64 ? null : next.toString(10);
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseTarget(value: unknown): RelayV2TerminalWireTarget {
  if (!isRecord(value)
    || !exactKeys(value, ["hostId", "scopeId", "sessionId"])
    || !isOpaque(value.hostId)
    || !isOpaque(value.scopeId)
    || !isOpaque(value.sessionId)) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable target is malformed",
    );
  }
  return {
    hostId: value.hostId,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
  };
}

function parsePane(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 65_535) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable pane is malformed",
    );
  }
  return value as number;
}

function sameTarget(left: RelayV2TerminalWireTarget, right: RelayV2TerminalWireTarget): boolean {
  return left.hostId === right.hostId
    && left.scopeId === right.scopeId
    && left.sessionId === right.sessionId;
}

function cloneTarget(value: RelayV2TerminalWireTarget): RelayV2TerminalWireTarget {
  return { hostId: value.hostId, scopeId: value.scopeId, sessionId: value.sessionId };
}

function parseCanonicalBinding(
  value: unknown,
  code: RelayV2TerminalDurableLineageErrorCode =
    "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
): RelayV2TerminalCanonicalTargetBindingV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlIdentity",
    ])
    || value.schemaVersion !== 1
    || !isOpaque(value.hostId)
    || !isOpaque(value.scopeId)
    || !isOpaque(value.sessionId)
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !isOpaque(value.processTarget.targetId)
    || !isOpaque(value.backendInstanceKey)
    || !isRecord(value.managedTarget)
    || !exactKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || !isOpaque(value.managedTarget.name)
    || (value.managedTarget.kind !== "worktree" && value.managedTarget.kind !== "terminal")
    || !isOpaque(value.managedTarget.incarnation)
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(value.managedTarget.incarnation)
    || !isRecord(value.exactControlIdentity)
    || !exactKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || value.exactControlIdentity.schemaVersion !== 1
    || !isOpaque(value.exactControlIdentity.controlTargetId)
    || !isOpaque(value.exactControlIdentity.controlEpoch)
    || !isOpaque(value.exactControlIdentity.targetIncarnationProof)) {
    return lineageError(code, "Relay v2 terminal canonical binding is malformed");
  }
  const pane = (() => {
    if (!Number.isSafeInteger(value.pane)
      || (value.pane as number) < 0
      || (value.pane as number) > 65_535) {
      return lineageError(code, "Relay v2 terminal canonical binding pane is malformed");
    }
    return value.pane as number;
  })();
  let expectedBackendInstanceKey: string;
  try {
    expectedBackendInstanceKey = issueRelayV2CanonicalBackendInstanceKey({
      processTarget: {
        kind: value.processTarget.kind,
        targetId: value.processTarget.targetId,
      },
      incarnation: value.managedTarget.incarnation,
    });
  } catch {
    return lineageError(code, "Relay v2 terminal canonical backend identity is invalid");
  }
  if (value.backendInstanceKey !== expectedBackendInstanceKey) {
    return lineageError(code, "Relay v2 terminal canonical backend identity is mismatched");
  }
  return {
    schemaVersion: 1,
    hostId: value.hostId,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
    pane,
    processTarget: {
      kind: value.processTarget.kind,
      targetId: value.processTarget.targetId,
    },
    backendInstanceKey: value.backendInstanceKey,
    managedTarget: {
      name: value.managedTarget.name,
      kind: value.managedTarget.kind,
      incarnation: value.managedTarget.incarnation,
    },
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: value.exactControlIdentity.controlTargetId,
      controlEpoch: value.exactControlIdentity.controlEpoch,
      targetIncarnationProof: value.exactControlIdentity.targetIncarnationProof,
    },
  };
}

function cloneCanonicalBinding(
  value: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2TerminalCanonicalTargetBindingV1 {
  return {
    ...value,
    processTarget: { ...value.processTarget },
    managedTarget: { ...value.managedTarget },
    exactControlIdentity: { ...value.exactControlIdentity },
  };
}

function sameCanonicalBinding(
  left: RelayV2TerminalCanonicalTargetBindingV1,
  right: RelayV2TerminalCanonicalTargetBindingV1,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && sameTarget(left, right)
    && left.pane === right.pane
    && left.processTarget.kind === right.processTarget.kind
    && left.processTarget.targetId === right.processTarget.targetId
    && left.backendInstanceKey === right.backendInstanceKey
    && left.managedTarget.name === right.managedTarget.name
    && left.managedTarget.kind === right.managedTarget.kind
    && left.managedTarget.incarnation === right.managedTarget.incarnation
    && left.exactControlIdentity.schemaVersion === right.exactControlIdentity.schemaVersion
    && left.exactControlIdentity.controlTargetId === right.exactControlIdentity.controlTargetId
    && left.exactControlIdentity.controlEpoch === right.exactControlIdentity.controlEpoch
    && left.exactControlIdentity.targetIncarnationProof
      === right.exactControlIdentity.targetIncarnationProof;
}

function parseRoute(value: unknown): RelayV2TerminalRoute {
  if (!isRecord(value)
    || !exactKeys(value, ["connectorId", "routeId", "routeFence"])
    || !isOpaque(value.connectorId)
    || !isOpaque(value.routeId)
    || !isOpaque(value.routeFence)) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable close route is malformed",
    );
  }
  return {
    connectorId: value.connectorId,
    routeId: value.routeId,
    routeFence: value.routeFence,
  };
}

function parseOpenOutcome(value: unknown): RelayV2TerminalDurableOpenOutcome {
  if (!isRecord(value)) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable open outcome is malformed",
    );
  }
  if (value.kind === "opened") {
    if (!exactKeys(value, [
      "kind", "generation", "resumeTokenHash", "disposition", "replayFromOffset",
    ])
      || !isOpaque(value.generation)
      || !isFingerprint(value.resumeTokenHash)
      || (value.disposition !== "new"
        && value.disposition !== "resumed"
        && value.disposition !== "reset")
      || !isCounter(value.replayFromOffset)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal durable opened outcome is malformed",
      );
    }
    return {
      kind: "opened",
      generation: value.generation,
      resumeTokenHash: value.resumeTokenHash,
      disposition: value.disposition,
      replayFromOffset: value.replayFromOffset,
    };
  }
  if (value.kind === "reset") {
    const reasons = new Set([
      "generation_stale",
      "offset_expired",
      "stream_lost",
      "slow_consumer",
      "host_buffer_pressure",
    ]);
    if (!exactKeys(value, [
      "kind", "generation", "reason", "requestedOffset", "bufferStartOffset", "tailOffset",
    ])
      || !(value.generation === null || isOpaque(value.generation))
      || typeof value.reason !== "string"
      || !reasons.has(value.reason)
      || !(value.requestedOffset === null || isCounter(value.requestedOffset))
      || !(value.bufferStartOffset === null || isCounter(value.bufferStartOffset))
      || !(value.tailOffset === null || isCounter(value.tailOffset))) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal durable reset outcome is malformed",
      );
    }
    return {
      kind: "reset",
      generation: value.generation,
      reason: value.reason as Extract<RelayV2TerminalDurableOpenOutcome, { kind: "reset" }>["reason"],
      requestedOffset: value.requestedOffset,
      bufferStartOffset: value.bufferStartOffset,
      tailOffset: value.tailOffset,
    };
  }
  if (value.kind === "error") {
    if (!exactKeys(value, ["kind", "code", "message"])
      || (value.code !== "BUSY"
        && value.code !== "CAPABILITY_UNAVAILABLE"
        && value.code !== "TERMINAL_STREAM_CONFLICT")
      || typeof value.message !== "string"
      || value.message.length === 0
      || value.message.includes("\0")
      || Buffer.byteLength(value.message, "utf8") > 4_096) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal durable error outcome is malformed",
      );
    }
    return { kind: "error", code: value.code, message: value.message };
  }
  return lineageError(
    "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
    "Relay v2 terminal durable open outcome has an unsupported kind",
  );
}

function sameOutcome(
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

function parseClaimAuthority(value: unknown): PersistedClaimStreamAuthority {
  if (isRecord(value) && exactKeys(value, ["status"]) && value.status === "absent") {
    return { status: "absent" };
  }
  if (!isRecord(value)
    || !exactKeys(value, [
      "status", "generation", "hostInstanceId", "target", "pane", "resumeTokenHash",
      "requestedOffset", "canonicalBinding",
    ])
    || (value.status !== "live" && value.status !== "closed" && value.status !== "lost")
    || !isOpaque(value.generation)
    || !isOpaque(value.hostInstanceId)
    || !isFingerprint(value.resumeTokenHash)
    || !(value.requestedOffset === null || isCounter(value.requestedOffset))) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable claim authority is malformed",
    );
  }
  return {
    status: value.status,
    generation: value.generation,
    hostInstanceId: value.hostInstanceId,
    target: parseTarget(value.target),
    pane: parsePane(value.pane),
    resumeTokenHash: value.resumeTokenHash,
    requestedOffset: value.requestedOffset,
    canonicalBinding: parseCanonicalBinding(value.canonicalBinding),
  };
}

function parseLost(value: unknown): PersistedLostAuthority {
  if (!isRecord(value)
    || !exactKeys(value, [
      "streamKey", "generation", "ownerHostInstanceId", "target", "pane",
      "resumeTokenHash", "canonicalBinding", "expiresAtMs",
    ])
    || !isDurableKey(value.streamKey)
    || !isOpaque(value.generation)
    || !isOpaque(value.ownerHostInstanceId)
    || !isFingerprint(value.resumeTokenHash)
    || !isSafeTime(value.expiresAtMs)) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable lost authority is malformed",
    );
  }
  return {
    streamKey: value.streamKey,
    generation: value.generation,
    ownerHostInstanceId: value.ownerHostInstanceId,
    target: parseTarget(value.target),
    pane: parsePane(value.pane),
    resumeTokenHash: value.resumeTokenHash,
    canonicalBinding: parseCanonicalBinding(value.canonicalBinding),
    expiresAtMs: value.expiresAtMs,
  };
}

function parseStream(value: unknown): PersistedStreamAuthority {
  if (!isRecord(value)
    || !exactKeys(value, [
      "status",
      "streamKey",
      "generation",
      "hostInstanceId",
      "target",
      "pane",
      "resumeTokenHash",
      "canonicalBinding",
      "closeSlotReserved",
      "closedExpiresAtMs",
    ])
    || (value.status !== "live" && value.status !== "closed")
    || !isDurableKey(value.streamKey)
    || !isOpaque(value.generation)
    || !isOpaque(value.hostInstanceId)
    || !isFingerprint(value.resumeTokenHash)
    || typeof value.closeSlotReserved !== "boolean"
    || !(value.closedExpiresAtMs === null || isSafeTime(value.closedExpiresAtMs))
    || (value.status === "live" && value.closedExpiresAtMs !== null)
    || (value.status === "closed" && value.closedExpiresAtMs === null)) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable stream authority is malformed",
    );
  }
  return {
    status: value.status,
    streamKey: value.streamKey,
    generation: value.generation,
    hostInstanceId: value.hostInstanceId,
    target: parseTarget(value.target),
    pane: parsePane(value.pane),
    resumeTokenHash: value.resumeTokenHash,
    canonicalBinding: parseCanonicalBinding(value.canonicalBinding),
    closeSlotReserved: value.closeSlotReserved,
    closedExpiresAtMs: value.closedExpiresAtMs,
  };
}

function parseOpenRecord(value: unknown): PersistedOpenRecord {
  if (!isRecord(value)
    || !exactKeys(value, [
      "status",
      "key",
      "streamKey",
      "fingerprint",
      "ownerHostInstanceId",
      "claimToken",
      "fence",
      "target",
      "pane",
      "resumeTokenHash",
      "mode",
      "previousGeneration",
      "requestedOffset",
      "streamAuthority",
      "retainedAuthorityDigest",
      "reservesStreamSlot",
      "issuedGeneration",
      "preparedBinding",
      "expiresAtMs",
      "outcome",
    ])
    || (value.status !== "pending" && value.status !== "final")
    || !isDurableKey(value.key)
    || !isDurableKey(value.streamKey)
    || !isFingerprint(value.fingerprint)
    || !isOpaque(value.ownerHostInstanceId)
    || !isOpaque(value.claimToken)
    || !isOpaque(value.fence)
    || (value.mode !== "new" && value.mode !== "resume" && value.mode !== "reset")
    || !(value.resumeTokenHash === null || isFingerprint(value.resumeTokenHash))
    || !(value.previousGeneration === null || isOpaque(value.previousGeneration))
    || !(value.requestedOffset === null || isCounter(value.requestedOffset))
    || !isFingerprint(value.retainedAuthorityDigest)
    || typeof value.reservesStreamSlot !== "boolean"
    || !(value.issuedGeneration === null || isOpaque(value.issuedGeneration))
    || !(value.preparedBinding === null || isRecord(value.preparedBinding))
    || !isSafeTime(value.expiresAtMs)
    || (value.status === "pending" && value.outcome !== null)
    || (value.status === "final" && value.outcome === null)
    || (value.status === "final" && value.reservesStreamSlot)) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable open record is malformed",
    );
  }
  return {
    status: value.status,
    key: value.key,
    streamKey: value.streamKey,
    fingerprint: value.fingerprint,
    ownerHostInstanceId: value.ownerHostInstanceId,
    claimToken: value.claimToken,
    fence: value.fence,
    target: parseTarget(value.target),
    pane: parsePane(value.pane),
    resumeTokenHash: value.resumeTokenHash,
    mode: value.mode,
    previousGeneration: value.previousGeneration,
    requestedOffset: value.requestedOffset,
    streamAuthority: parseClaimAuthority(value.streamAuthority),
    retainedAuthorityDigest: value.retainedAuthorityDigest,
    reservesStreamSlot: value.reservesStreamSlot,
    issuedGeneration: value.issuedGeneration,
    preparedBinding: value.preparedBinding === null
      ? null
      : parseCanonicalBinding(value.preparedBinding),
    expiresAtMs: value.expiresAtMs,
    outcome: value.outcome === null ? null : parseOpenOutcome(value.outcome),
  };
}

function parseCloseTombstone(value: unknown): RelayV2TerminalDurableCloseTombstone {
  if (!isRecord(value)
    || !exactKeys(value, [
      "key",
      "streamKey",
      "fingerprint",
      "hostInstanceId",
      "target",
      "streamId",
      "closeId",
      "requestId",
      "requestRoute",
      "generation",
      "finalOffset",
      "reason",
      "exitCode",
      "expiresAtMs",
    ])
    || !isDurableKey(value.key)
    || !isDurableKey(value.streamKey)
    || !isFingerprint(value.fingerprint)
    || !isOpaque(value.hostInstanceId)
    || !isOpaque(value.streamId)
    || !isOpaque(value.closeId)
    || !isOpaque(value.requestId)
    || !isOpaque(value.generation)
    || !isCounter(value.finalOffset)
    || !isSafeTime(value.expiresAtMs)
    || (value.reason !== "client_closed"
      && value.reason !== "backend_exit"
      && value.reason !== "backend_error")
    || !(
      (value.reason === "client_closed" && value.exitCode === null)
      || (value.reason === "backend_exit" && Number.isInteger(value.exitCode))
      || (value.reason === "backend_error"
        && (value.exitCode === null || Number.isInteger(value.exitCode)))
    )
    || (value.exitCode !== null
      && ((value.exitCode as number) < -2_147_483_648
        || (value.exitCode as number) > 2_147_483_647))) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable close record is malformed",
    );
  }
  return {
    key: value.key,
    streamKey: value.streamKey,
    fingerprint: value.fingerprint,
    hostInstanceId: value.hostInstanceId,
    target: parseTarget(value.target),
    streamId: value.streamId,
    closeId: value.closeId,
    requestId: value.requestId,
    requestRoute: parseRoute(value.requestRoute),
    generation: value.generation,
    finalOffset: value.finalOffset,
    reason: value.reason,
    exitCode: value.exitCode as number | null,
    expiresAtMs: value.expiresAtMs,
  };
}

function parseCloseRecord(value: unknown): PersistedCloseRecord {
  if (!isRecord(value)
    || !exactKeys(value, ["status", "ownerHostInstanceId", "ownerFence", "value"])
    || (value.status !== "intent" && value.status !== "final")
    || !isOpaque(value.ownerHostInstanceId)
    || !isCounter(value.ownerFence)
    || value.ownerFence === "0") {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable close state is malformed",
    );
  }
  return {
    status: value.status,
    ownerHostInstanceId: value.ownerHostInstanceId,
    ownerFence: value.ownerFence,
    value: parseCloseTombstone(value.value),
  };
}

function controlSlots(state: PersistedTerminalLineageState): number {
  return state.openRecords.length
    + state.closeRecords.length
    + state.lostAuthorities.length
    + state.streamAuthorities.filter((stream) => stream.closeSlotReserved).length
    + state.openRecords.filter((record) => record.reservesStreamSlot).length;
}

function liveStreamSlots(
  state: PersistedTerminalLineageState,
  candidate?: Pick<RelayV2TerminalDurableOpenClaim, "mode" | "streamKey">,
): number {
  const liveStreamKeys = new Set(state.streamAuthorities
    .filter((stream) => stream.status === "live")
    .map((stream) => stream.streamKey));
  const pendingWillCreateLive = state.openRecords.filter((record) => (
    record.status === "pending"
    && record.mode !== "resume"
    && !liveStreamKeys.has(record.streamKey)
  )).length;
  const candidateWillCreateLive = candidate !== undefined
    && candidate.mode !== "resume"
    && !liveStreamKeys.has(candidate.streamKey);
  return liveStreamKeys.size
    + pendingWillCreateLive
    + (candidateWillCreateLive ? 1 : 0);
}

function parseState(
  value: unknown,
  hostEpoch: string,
  limits: RelayV2TerminalDurableLineageLimits,
): PersistedTerminalLineageState {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "authority",
      "hostEpoch",
      "activeHostInstanceId",
      "ownerFence",
      "generationHighWater",
      "openRecords",
      "streamAuthorities",
      "lostAuthorities",
      "closeRecords",
    ])
    || value.schemaVersion !== TERMINAL_LINEAGE_SCHEMA_VERSION
    || value.authority !== "relay_v2_terminal_durable_lineage"
    || value.hostEpoch !== hostEpoch
    || !(value.activeHostInstanceId === null || isOpaque(value.activeHostInstanceId))
    || !isCounter(value.ownerFence)
    || !isCounter(value.generationHighWater)
    || !Array.isArray(value.openRecords)
    || !Array.isArray(value.streamAuthorities)
    || !Array.isArray(value.lostAuthorities)
    || !Array.isArray(value.closeRecords)
    || value.openRecords.length > limits.maxControlRecords
    || value.streamAuthorities.length > limits.maxControlRecords
    || value.lostAuthorities.length > limits.maxControlRecords
    || value.closeRecords.length > limits.maxControlRecords) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable lineage schema is unsupported or malformed",
    );
  }
  const state: PersistedTerminalLineageState = {
    schemaVersion: TERMINAL_LINEAGE_SCHEMA_VERSION,
    authority: "relay_v2_terminal_durable_lineage",
    hostEpoch,
    activeHostInstanceId: value.activeHostInstanceId,
    ownerFence: value.ownerFence,
    generationHighWater: value.generationHighWater,
    openRecords: value.openRecords.map(parseOpenRecord),
    streamAuthorities: value.streamAuthorities.map(parseStream),
    lostAuthorities: value.lostAuthorities.map(parseLost),
    closeRecords: value.closeRecords.map(parseCloseRecord),
  };
  const unique = (items: readonly string[], label: string) => {
    if (new Set(items).size !== items.length) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        `Relay v2 terminal durable ${label} is not unique`,
      );
    }
  };
  unique(state.openRecords.map((record) => record.key), "open key");
  unique(state.openRecords.map((record) => record.claimToken), "open claim token");
  unique(state.openRecords.map((record) => record.fence), "open fence");
  unique(state.streamAuthorities.map((stream) => stream.streamKey), "stream key");
  unique(state.streamAuthorities.map((stream) => stream.generation), "stream generation");
  unique(state.lostAuthorities.map(
    (stream) => `${stream.streamKey}\0${stream.generation}`,
  ), "lost stream generation");
  unique(state.closeRecords.map((record) => record.value.key), "close key");
  unique([
    ...state.streamAuthorities.map((stream) => stream.generation),
    ...state.lostAuthorities.map((stream) => stream.generation),
  ], "executable/lost authority generation");
  unique(state.openRecords.flatMap((record) => (
    record.issuedGeneration === null ? [] : [record.issuedGeneration]
  )), "issued generation");
  unique(state.closeRecords.map(
    (record) => `${record.value.streamKey}\0${record.value.generation}`,
  ), "close binding");
  const highWater = BigInt(state.generationHighWater);
  const requireIssued = (generation: string, label: string) => {
    const counter = issuedGenerationCounter(generation, hostEpoch);
    if (counter === null || counter > highWater) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        `Relay v2 terminal durable ${label} was not issued by this host lineage`,
      );
    }
  };
  const generationLineages = new Map<string, {
    streamKey: string;
    target: RelayV2TerminalWireTarget;
    pane: number | null;
    resumeTokenHash: string | null;
    canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1 | null;
  }>();
  const bindGeneration = (
    generation: string,
    binding: {
      streamKey: string;
      target: RelayV2TerminalWireTarget;
      pane: number | null;
      resumeTokenHash: string | null;
      canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1 | null;
    },
    label: string,
  ) => {
    const existing = generationLineages.get(generation);
    if (existing !== undefined && (
      existing.streamKey !== binding.streamKey
      || !sameTarget(existing.target, binding.target)
      || (existing.pane !== null
        && binding.pane !== null
        && existing.pane !== binding.pane)
      || (existing.resumeTokenHash !== null
        && binding.resumeTokenHash !== null
        && existing.resumeTokenHash !== binding.resumeTokenHash)
      || (existing.canonicalBinding !== null
        && binding.canonicalBinding !== null
        && !sameCanonicalBinding(existing.canonicalBinding, binding.canonicalBinding))
    )) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        `Relay v2 terminal durable ${label} reused a generation across incompatible lineages`,
      );
    }
    generationLineages.set(generation, {
      streamKey: binding.streamKey,
      target: cloneTarget(binding.target),
      pane: existing?.pane ?? binding.pane,
      resumeTokenHash: existing?.resumeTokenHash ?? binding.resumeTokenHash,
      canonicalBinding: existing?.canonicalBinding
        ?? (binding.canonicalBinding === null
          ? null
          : cloneCanonicalBinding(binding.canonicalBinding)),
    });
  };
  if ((state.activeHostInstanceId === null) !== (state.ownerFence === "0")) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable process owner fence is malformed",
    );
  }
  for (const record of state.openRecords) {
    const pending = record.status === "pending";
    if ((!pending && record.reservesStreamSlot)
      || ((record.mode === "new" || record.mode === "reset")
        !== (record.issuedGeneration !== null))
      || (record.mode === "new" && (
        record.resumeTokenHash !== null
        || record.previousGeneration !== null
        || record.requestedOffset !== null
        || record.streamAuthority.status !== "absent"
      ))
      || (record.mode === "resume" && (
        record.resumeTokenHash === null
        || record.previousGeneration === null
        || record.requestedOffset === null
        || record.reservesStreamSlot
        || record.issuedGeneration !== null
      ))
      || (record.mode === "reset" && !(
        (record.resumeTokenHash === null
          && record.previousGeneration === null
          && record.requestedOffset === null)
        || (record.resumeTokenHash !== null
          && record.previousGeneration !== null
          && record.requestedOffset !== null)
      ))) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal durable open claim invariants are malformed",
      );
    }
    if (record.preparedBinding !== null && (
      !sameTarget(record.preparedBinding, record.target)
      || record.preparedBinding.pane !== record.pane
      || (record.streamAuthority.status !== "absent"
        && !sameCanonicalBinding(
          record.preparedBinding,
          record.streamAuthority.canonicalBinding,
        ))
    )) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal prepared binding lost its exact claim authority",
      );
    }
    if (pending && record.ownerHostInstanceId !== state.activeHostInstanceId) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal pending claim is owned by an inactive process",
      );
    }
    if (record.issuedGeneration !== null) {
      const openedWinner = record.status === "final" && record.outcome?.kind === "opened";
      const overlapsAuthority = state.streamAuthorities.some(
        (stream) => stream.generation === record.issuedGeneration,
      ) || state.lostAuthorities.some(
        (stream) => stream.generation === record.issuedGeneration,
      ) || state.closeRecords.some(
        (close) => close.value.generation === record.issuedGeneration,
      );
      if (!openedWinner && overlapsAuthority) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
          "Relay v2 terminal unused claimed generation overlaps executable or closed authority",
        );
      }
      requireIssued(record.issuedGeneration, "claimed generation");
      bindGeneration(record.issuedGeneration, {
        streamKey: record.streamKey,
        target: record.target,
        pane: record.pane,
        resumeTokenHash: record.outcome?.kind === "opened"
          ? record.outcome.resumeTokenHash
          : null,
        canonicalBinding: record.preparedBinding,
      }, "issued generation");
    }
    if (record.streamAuthority.status !== "absent") {
      if (!sameTarget(record.streamAuthority.canonicalBinding, record.streamAuthority.target)
        || record.streamAuthority.canonicalBinding.pane !== record.streamAuthority.pane) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
          "Relay v2 terminal captured canonical binding is mismatched",
        );
      }
      requireIssued(record.streamAuthority.generation, "captured generation");
      bindGeneration(record.streamAuthority.generation, {
        streamKey: record.streamKey,
        target: record.streamAuthority.target,
        pane: record.streamAuthority.pane,
        resumeTokenHash: record.streamAuthority.resumeTokenHash,
        canonicalBinding: record.streamAuthority.canonicalBinding,
      }, "captured authority");
      if (record.mode === "reset" && (
        record.previousGeneration !== record.streamAuthority.generation
        || record.resumeTokenHash !== record.streamAuthority.resumeTokenHash
        || !sameTarget(record.target, record.streamAuthority.target)
        || record.pane !== record.streamAuthority.pane
        || record.requestedOffset === null
        || record.requestedOffset !== record.streamAuthority.requestedOffset
      )) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
          "Relay v2 terminal reset claim lost its exact captured binding",
        );
      }
    }
    if (record.status === "final" && record.outcome?.kind === "opened") {
      const disposition = record.mode === "new"
        ? "new"
        : record.mode === "resume"
          ? "resumed"
          : "reset";
      if (record.preparedBinding === null
        || record.outcome.disposition !== disposition
        || (record.mode !== "resume" && record.outcome.generation !== record.issuedGeneration)
        || ((record.mode === "new" || record.mode === "reset")
          && record.outcome.replayFromOffset !== "0")
        || (record.mode === "reset" && record.streamAuthority.status !== "absent" && (
          record.previousGeneration !== record.streamAuthority.generation
          || record.resumeTokenHash !== record.streamAuthority.resumeTokenHash
          || !sameTarget(record.target, record.streamAuthority.target)
          || record.pane !== record.streamAuthority.pane
          || record.requestedOffset === null
          || record.requestedOffset !== record.streamAuthority.requestedOffset
        ))
        || (record.mode === "resume" && (
          record.streamAuthority.status === "absent"
          || record.previousGeneration !== record.streamAuthority.generation
          || !sameTarget(record.target, record.streamAuthority.target)
          || record.pane !== record.streamAuthority.pane
          || record.resumeTokenHash !== record.streamAuthority.resumeTokenHash
          || record.requestedOffset !== record.streamAuthority.requestedOffset
          || record.outcome.generation !== record.streamAuthority.generation
          || record.outcome.resumeTokenHash !== record.streamAuthority.resumeTokenHash
          || record.outcome.replayFromOffset !== record.requestedOffset
        ))) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
          "Relay v2 terminal durable opened outcome lost its claim lineage",
        );
      }
      requireIssued(record.outcome.generation, "opened outcome generation");
      bindGeneration(record.outcome.generation, {
        streamKey: record.streamKey,
        target: record.target,
        pane: record.pane,
        resumeTokenHash: record.outcome.resumeTokenHash,
        canonicalBinding: record.preparedBinding,
      }, "opened outcome");
    }
  }
  for (const stream of state.streamAuthorities) {
    if (!sameTarget(stream.canonicalBinding, stream.target)
      || stream.canonicalBinding.pane !== stream.pane) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal stream canonical binding is mismatched",
      );
    }
    requireIssued(stream.generation, "stream generation");
    bindGeneration(stream.generation, {
      streamKey: stream.streamKey,
      target: stream.target,
      pane: stream.pane,
      resumeTokenHash: stream.resumeTokenHash,
      canonicalBinding: stream.canonicalBinding,
    }, "stream authority");
    if (stream.hostInstanceId !== state.activeHostInstanceId) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal executable stream is owned by an inactive process",
      );
    }
    const exactClose = state.closeRecords.find((record) => (
      record.value.streamKey === stream.streamKey
      && record.value.generation === stream.generation
    ));
    if (exactClose && (
      stream.status !== "closed"
      || stream.closeSlotReserved
      || stream.closedExpiresAtMs === null
      || stream.closedExpiresAtMs < exactClose.value.expiresAtMs
      || exactClose.value.hostInstanceId !== stream.hostInstanceId
    )) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal close record contradicts its stream authority",
      );
    }
    if (!stream.closeSlotReserved && !exactClose) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal close slot has no exact close record",
      );
    }
  }
  for (const lost of state.lostAuthorities) {
    if (!sameTarget(lost.canonicalBinding, lost.target)
      || lost.canonicalBinding.pane !== lost.pane) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal lost canonical binding is mismatched",
      );
    }
    requireIssued(lost.generation, "lost generation");
    bindGeneration(lost.generation, {
      streamKey: lost.streamKey,
      target: lost.target,
      pane: lost.pane,
      resumeTokenHash: lost.resumeTokenHash,
      canonicalBinding: lost.canonicalBinding,
    }, "lost authority");
  }
  for (const close of state.closeRecords) {
    requireIssued(close.value.generation, "close generation");
    bindGeneration(close.value.generation, {
      streamKey: close.value.streamKey,
      target: close.value.target,
      pane: null,
      resumeTokenHash: null,
      canonicalBinding: null,
    }, "close binding");
    if (BigInt(close.ownerFence) > BigInt(state.ownerFence)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal close owner fence exceeds the process fence",
      );
    }
  }
  if (liveStreamSlots(state) > limits.maxStreams
    || controlSlots(state) > limits.maxControlRecords) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal durable lineage exceeds its frozen quota",
    );
  }
  return state;
}

function emptyState(hostEpoch: string): PersistedTerminalLineageState {
  return {
    schemaVersion: TERMINAL_LINEAGE_SCHEMA_VERSION,
    authority: "relay_v2_terminal_durable_lineage",
    hostEpoch,
    activeHostInstanceId: null,
    ownerFence: "0",
    generationHighWater: "0",
    openRecords: [],
    streamAuthorities: [],
    lostAuthorities: [],
    closeRecords: [],
  };
}

function cloneOutcome<T extends RelayV2TerminalDurableOpenOutcome>(outcome: T): T {
  return { ...outcome };
}

function replayOpenResult(record: PersistedOpenRecord): RelayV2TerminalDurableOpenReplayResult {
  if (record.status !== "final" || record.outcome === null) {
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
      "Relay v2 terminal replay record is not final",
    );
  }
  if (record.outcome.kind === "opened") {
    if (record.preparedBinding === null) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal opened replay lacks its exact preparation",
      );
    }
    return {
      status: "replay",
      outcome: cloneOutcome(record.outcome),
      preparedBinding: cloneCanonicalBinding(record.preparedBinding),
    };
  }
  return {
    status: "replay",
    outcome: cloneOutcome(record.outcome),
    preparedBinding: record.preparedBinding === null
      ? null
      : cloneCanonicalBinding(record.preparedBinding),
  };
}

function publicAuthority(
  authority: PersistedClaimStreamAuthority,
): RelayV2TerminalDurableStreamAuthority {
  if (authority.status === "absent" || authority.status === "lost") {
    return { status: "absent" };
  }
  return {
    status: authority.status,
    generation: authority.generation,
    target: cloneTarget(authority.target),
    pane: authority.pane,
    resumeTokenHash: authority.resumeTokenHash,
    canonicalBinding: cloneCanonicalBinding(authority.canonicalBinding),
  };
}

function claimAuthorityFromStream(
  stream: PersistedStreamAuthority | undefined,
  requestedOffset: string | null = null,
): PersistedClaimStreamAuthority {
  if (!stream) return { status: "absent" };
  return {
    status: stream.status,
    generation: stream.generation,
    hostInstanceId: stream.hostInstanceId,
    target: cloneTarget(stream.target),
    pane: stream.pane,
    resumeTokenHash: stream.resumeTokenHash,
    canonicalBinding: cloneCanonicalBinding(stream.canonicalBinding),
    requestedOffset,
  };
}

function claimAuthorityFromLost(
  stream: PersistedLostAuthority | undefined,
  requestedOffset: string | null = null,
): PersistedClaimStreamAuthority {
  if (!stream) return { status: "absent" };
  return {
    status: "lost",
    generation: stream.generation,
    hostInstanceId: stream.ownerHostInstanceId,
    target: cloneTarget(stream.target),
    pane: stream.pane,
    resumeTokenHash: stream.resumeTokenHash,
    canonicalBinding: cloneCanonicalBinding(stream.canonicalBinding),
    requestedOffset,
  };
}

function sameClaimAuthority(
  left: PersistedClaimStreamAuthority,
  right: PersistedClaimStreamAuthority,
): boolean {
  if (left.status === "absent" || right.status === "absent") {
    return left.status === right.status;
  }
  return left.status === right.status
    && left.generation === right.generation
    && left.hostInstanceId === right.hostInstanceId
    && sameTarget(left.target, right.target)
    && left.pane === right.pane
    && left.resumeTokenHash === right.resumeTokenHash
    && sameCanonicalBinding(left.canonicalBinding, right.canonicalBinding)
    && left.requestedOffset === right.requestedOffset;
}

function streamMatchesClaim(
  stream: PersistedStreamAuthority | undefined,
  authority: PersistedClaimStreamAuthority,
): stream is PersistedStreamAuthority {
  return !!stream && authority.status !== "absent" && authority.status !== "lost"
    && stream.status === authority.status
    && stream.generation === authority.generation
    && stream.hostInstanceId === authority.hostInstanceId
    && sameTarget(stream.target, authority.target)
    && stream.pane === authority.pane
    && stream.resumeTokenHash === authority.resumeTokenHash
    && sameCanonicalBinding(stream.canonicalBinding, authority.canonicalBinding);
}

function lostMatchesClaim(
  stream: PersistedLostAuthority | undefined,
  authority: PersistedClaimStreamAuthority,
): stream is PersistedLostAuthority {
  return !!stream && authority.status === "lost"
    && stream.generation === authority.generation
    && stream.ownerHostInstanceId === authority.hostInstanceId
    && sameTarget(stream.target, authority.target)
    && stream.pane === authority.pane
    && stream.resumeTokenHash === authority.resumeTokenHash
    && sameCanonicalBinding(stream.canonicalBinding, authority.canonicalBinding);
}

function cloneClose(
  value: RelayV2TerminalDurableCloseTombstone,
): RelayV2TerminalDurableCloseTombstone {
  return {
    ...value,
    target: cloneTarget(value.target),
    requestRoute: { ...value.requestRoute },
  };
}

function sameCloseBinding(
  left: RelayV2TerminalDurableCloseTombstone,
  right: RelayV2TerminalDurableCloseTombstone,
): boolean {
  return left.key === right.key
    && left.streamKey === right.streamKey
    && left.fingerprint === right.fingerprint
    && sameTarget(left.target, right.target)
    && left.streamId === right.streamId
    && left.closeId === right.closeId
    && left.generation === right.generation;
}

function isCommitUncertain(error: unknown): boolean {
  return isRecord(error) && error.code === "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN";
}

type OpenAdmission =
  | { kind: "conflict"; reason: "stream_conflict" }
  | { kind: "busy" }
  | {
      kind: "admitted";
      streamAuthority: PersistedClaimStreamAuthority;
      reservesStreamSlot: boolean;
      immediateStreamLost: boolean;
    };

/**
 * H0-owned durable terminal lineage authority.
 *
 * The whole lineage is one closed, versioned HostState record. Every public
 * method performs at most one synchronous HostState transaction; any
 * post-commit uncertainty is reconciled against the same serializer cut before
 * returning. This class is deliberately not constructed by production wiring.
 */
export class RelayV2TerminalDurableLineageAuthority
  implements RelayV2TerminalDurableLineage {
  readonly limits: Readonly<RelayV2TerminalDurableLineageLimits>;
  readonly hostInstanceId: string;

  private readonly store: Pick<RelayV2HostStateStore, "serialize" | "hostInstanceId">;
  private readonly now: () => number;
  private readonly issueAuthorityId: (kind: "claim" | "fence") => string;
  private readonly admissionFence:
    | Pick<RelayV2TerminalCanonicalResolver, "fenceSessionForAdmission">
    | undefined;
  private activated = false;
  private recoveryStarted = false;

  constructor(options: RelayV2TerminalDurableLineageAuthorityOptions) {
    if (!isRecord(options)
      || !isRecord(options.store)
      || typeof options.store.serialize !== "function"
      || !isOpaque(options.store.hostInstanceId)) {
      throw new TypeError("Relay v2 terminal durable lineage requires HostState");
    }
    this.store = options.store;
    this.hostInstanceId = options.store.hostInstanceId;
    this.now = options.now ?? Date.now;
    this.issueAuthorityId = options.issueAuthorityId
      ?? ((kind) => `${kind}_${randomUUID().replaceAll("-", "")}`);
    if (options.admissionFence !== undefined
      && (!isRecord(options.admissionFence)
        || typeof options.admissionFence.fenceSessionForAdmission !== "function")) {
      throw new TypeError("Relay v2 terminal durable lineage admission fence is invalid");
    }
    this.admissionFence = options.admissionFence;
    const limits = {
      ...RELAY_V2_TERMINAL_DURABLE_LINEAGE_LIMITS,
      ...options.testLimits,
    };
    for (const [name, value] of Object.entries(limits)) {
      const ceiling = RELAY_V2_TERMINAL_DURABLE_LINEAGE_LIMITS[
        name as keyof RelayV2TerminalDurableLineageLimits
      ];
      if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
        throw new TypeError(`Relay v2 terminal durable lineage limit ${name} is invalid`);
      }
    }
    this.limits = Object.freeze(limits);
  }

  /**
   * Performs the complete H3 recovery cut in one H0 transaction and only then
   * signs a candidate bound to this exact lineage and manager instance.
   */
  async recoverForHostH3(manager: unknown): Promise<RelayV2HostH3RecoveryCandidate> {
    const binding = captureRelayV2TerminalManagerRecoveryBinding(manager, this);
    if (binding === null
      || binding.hostInstanceId !== this.hostInstanceId
      || this.recoveryStarted
      || this.activated) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal recovery manager or lineage is stale",
      );
    }
    this.recoveryStarted = true;
    let proposed: { hostEpoch: string; ownerFence: string } | null = null;
    const recovered = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        if (binding.hostEpoch !== transaction.hostEpoch) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal recovery host epoch mismatched HostState",
          );
        }
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        const ownerFence = this.replaceOwner(state, authorityExpiresAtMs, true);
        proposed = Object.freeze({ hostEpoch: transaction.hostEpoch, ownerFence });
        return { result: proposed, state };
      };
      return this.commitAndReconcile(section, mutate, (snapshot) => {
        const state = this.stateFromSnapshot(snapshot);
        if (proposed === null
          || snapshot.hostEpoch !== proposed.hostEpoch
          || state.activeHostInstanceId !== this.hostInstanceId
          || state.ownerFence !== proposed.ownerFence) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal recovery commit could not be reconciled",
          );
        }
        return proposed;
      });
    });
    this.activated = true;
    return issueRelayV2HostH3RecoveryCandidate(binding, recovered.ownerFence);
  }

  async claimOpen(
    claim: RelayV2TerminalDurableOpenClaim,
  ): Promise<RelayV2TerminalDurableOpenClaimResult> {
    const normalized = this.validateOpenClaim(claim);
    const claimToken = this.issueOwnedId("claim");
    const fence = this.issueOwnedId("fence");
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const existing = state.openRecords.find((record) => record.key === normalized.key);
        if (existing) {
          if (existing.fingerprint !== normalized.fingerprint
            || !this.sameLogicalClaim(existing, normalized)) {
            return { result: { status: "conflict", reason: "open_conflict" } as const, state };
          }
          if (existing.status === "pending") this.settlePendingAsStreamLost(state, existing);
          return {
            result: replayOpenResult(existing),
            state,
          };
        }
        const admission = this.openAdmission(state, normalized);
        if (admission.kind === "conflict") {
          return { result: { status: "conflict", reason: admission.reason } as const, state };
        }
        if (admission.kind === "busy") {
          return { result: { status: "busy", reason: "control_record_quota" } as const, state };
        }
        const { streamAuthority, reservesStreamSlot } = admission;
        if (admission.immediateStreamLost) {
          const record: PersistedOpenRecord = {
            status: "final",
            key: normalized.key,
            streamKey: normalized.streamKey,
            fingerprint: normalized.fingerprint,
            ownerHostInstanceId: normalized.hostInstanceId,
            claimToken,
            fence,
            target: cloneTarget(normalized.target),
            pane: normalized.pane,
            resumeTokenHash: normalized.resumeTokenHash,
            mode: normalized.mode,
            previousGeneration: normalized.previousGeneration,
            requestedOffset: normalized.requestedOffset,
            streamAuthority,
            retainedAuthorityDigest: retainedAuthorityDigest(state, normalized.streamKey),
            reservesStreamSlot: false,
            issuedGeneration: null,
            preparedBinding: null,
            expiresAtMs: Math.max(normalized.expiresAtMs, authorityExpiresAtMs),
            outcome: null,
          };
          this.finishOpenRecord(record, this.streamLostOutcome(record));
          state.openRecords.push(record);
          return {
            result: replayOpenResult(record),
            state,
          };
        }
        let allocatedGeneration: string | null = null;
        if (normalized.mode !== "resume") {
          const highWater = nextCounter(state.generationHighWater);
          if (highWater === null) {
            return { result: { status: "busy", reason: "control_record_quota" } as const, state };
          }
          state.generationHighWater = highWater;
          allocatedGeneration = issuedGeneration(transaction.hostEpoch, highWater);
        }
        const record: PersistedOpenRecord = {
          status: "pending",
          key: normalized.key,
          streamKey: normalized.streamKey,
          fingerprint: normalized.fingerprint,
          ownerHostInstanceId: normalized.hostInstanceId,
          claimToken,
          fence,
          target: cloneTarget(normalized.target),
          pane: normalized.pane,
          resumeTokenHash: normalized.resumeTokenHash,
          mode: normalized.mode,
          previousGeneration: normalized.previousGeneration,
          requestedOffset: normalized.requestedOffset,
          streamAuthority,
          retainedAuthorityDigest: retainedAuthorityDigest(state, normalized.streamKey),
          reservesStreamSlot,
          issuedGeneration: allocatedGeneration,
          preparedBinding: null,
          expiresAtMs: Math.max(normalized.expiresAtMs, authorityExpiresAtMs),
          outcome: null,
        };
        state.openRecords.push(record);
        return {
          result: {
            status: "claimed",
            claimToken,
            fence,
            issuedGeneration: allocatedGeneration,
            streamAuthority: publicAuthority(streamAuthority),
          } as const,
          state,
        };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableOpenClaimResult>(
        section,
        mutate,
        (snapshot) => this.openClaimAfterCommit(snapshot, normalized, claimToken, fence),
      );
    });
    this.activated = true;
    return result;
  }

  async prepareOpen(rawInput: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    preparation:
      | { kind: "current"; resolution: RelayV2TerminalCanonicalResolution }
      | { kind: "retained"; binding: RelayV2TerminalCanonicalTargetBindingV1 };
  }): Promise<RelayV2TerminalDurableOpenPrepareResult> {
    const input = this.validatePrepareOpen(rawInput);
    const proposedBinding = input.preparation.kind === "current"
      ? input.preparation.resolution.binding
      : input.preparation.binding;
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const record = state.openRecords.find((candidate) => candidate.key === input.key);
        if (!record
          || record.fingerprint !== input.fingerprint
          || record.ownerHostInstanceId !== input.hostInstanceId
          || record.claimToken !== input.claimToken
          || record.fence !== input.fence) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal prepare owner is missing or mismatched",
          );
        }
        if (record.status === "final") {
          return {
            result: replayOpenResult(record),
            state,
          };
        }
        const expectedPreparationKind = record.mode === "resume" ? "retained" : "current";
        if (input.preparation.kind !== expectedPreparationKind) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal preparation kind crossed its claimed mode",
          );
        }
        if (!sameTarget(record.target, proposedBinding)
          || record.pane !== proposedBinding.pane) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal prepare target differs from the claimed target",
          );
        }
        this.recheckPrepareAuthority(state, record);
        if (record.preparedBinding !== null) {
          if (!sameCanonicalBinding(record.preparedBinding, proposedBinding)) {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
              "Relay v2 terminal pending claim has a different prepared binding",
            );
          }
          return {
            result: {
              status: "prepared",
              binding: cloneCanonicalBinding(record.preparedBinding),
            } as const,
            state,
          };
        }
        if (input.preparation.kind === "retained") {
          if (record.mode !== "resume"
            || record.streamAuthority.status === "absent"
            || record.streamAuthority.status === "lost"
            || !sameCanonicalBinding(
              record.streamAuthority.canonicalBinding,
              proposedBinding,
            )) {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
              "Relay v2 terminal resume lost its retained exact binding",
            );
          }
        } else {
          if (record.mode === "resume") {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
              "Relay v2 terminal resume cannot resolve a current target",
            );
          }
          if (record.streamAuthority.status !== "absent"
            && !sameCanonicalBinding(
              record.streamAuthority.canonicalBinding,
              proposedBinding,
            )) {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
              "Relay v2 terminal replacement changed its exact target/control binding",
            );
          }
          if (!this.admissionFence) {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE",
              "Relay v2 exact terminal target admission is not wired",
            );
          }
          let fenceResult: unknown;
          try {
            fenceResult = this.admissionFence.fenceSessionForAdmission(
              transaction,
              input.preparation.resolution,
            );
          } catch {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE",
              "Relay v2 terminal admission fence rejected the exact target",
            );
          }
          requireSynchronousAdmissionFence(fenceResult);
        }
        record.preparedBinding = cloneCanonicalBinding(proposedBinding);
        return {
          result: {
            status: "prepared",
            binding: cloneCanonicalBinding(proposedBinding),
          } as const,
          state,
        };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableOpenPrepareResult>(
        section,
        mutate,
        (snapshot) => {
          const record = this.stateFromSnapshot(snapshot).openRecords.find(
            (candidate) => candidate.key === input.key,
          );
          if (!record || record.fingerprint !== input.fingerprint) {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
              "Relay v2 terminal preparation could not be reconciled",
            );
          }
          if (record.status === "final") {
            return replayOpenResult(record);
          }
          if (record.preparedBinding === null
            || !sameCanonicalBinding(record.preparedBinding, proposedBinding)) {
            return lineageError(
              "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
              "Relay v2 terminal preparation remained uncommitted",
            );
          }
          return {
            status: "prepared",
            binding: cloneCanonicalBinding(record.preparedBinding),
          } as const;
        },
      );
    });
    this.activated = true;
    return result;
  }

  async completeOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
  }): Promise<RelayV2TerminalDurableOpenCommitResult> {
    return this.settleOpen(input, undefined);
  }

  async failOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    outcome: Exclude<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
    streamEffect: RelayV2TerminalOpenFailureStreamEffect;
  }): Promise<RelayV2TerminalDurableOpenCommitResult> {
    const { streamEffect, ...settlement } = input;
    return this.settleOpen(settlement, this.validateStreamEffect(streamEffect));
  }

  async claimClose(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    intent?: RelayV2TerminalDurableCloseIntent;
  }): Promise<RelayV2TerminalDurableCloseClaimResult> {
    const normalized = this.validateCloseClaimInput(input);
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const existing = state.closeRecords.find(
          (record) => record.value.key === normalized.key,
        );
        if (existing) {
          if (existing.value.fingerprint !== normalized.fingerprint) {
            return { result: { status: "close_conflict" } as const, state };
          }
          if (normalized.intent && !sameCloseBinding(existing.value, normalized.intent)) {
            return { result: { status: "close_conflict" } as const, state };
          }
          if (existing.status === "final") {
            return {
              result: { status: "final", tombstone: cloneClose(existing.value) } as const,
              state,
            };
          }
          existing.ownerHostInstanceId = this.hostInstanceId;
          existing.ownerFence = state.ownerFence;
          return {
            result: {
              status: "existing_intent",
              intent: cloneClose(existing.value),
              ownerFence: existing.ownerFence,
            } as const,
            state,
          };
        }
        if (!normalized.intent) return { result: { status: "not_found" } as const, state };
        const stream = state.streamAuthorities.find(
          (candidate) => candidate.streamKey === normalized.intent!.streamKey,
        );
        if (!stream
          || stream.generation !== normalized.intent.generation
          || stream.hostInstanceId !== normalized.intent.hostInstanceId
          || !sameTarget(stream.target, normalized.intent.target)
          || !stream.closeSlotReserved) {
          return { result: { status: "not_found" } as const, state };
        }
        stream.status = "closed";
        stream.closedExpiresAtMs = Math.max(
          stream.closedExpiresAtMs ?? 0,
          normalized.intent.expiresAtMs,
          authorityExpiresAtMs,
        );
        stream.closeSlotReserved = false;
        const durableIntent = {
          ...normalized.intent,
          expiresAtMs: Math.max(normalized.intent.expiresAtMs, authorityExpiresAtMs),
        };
        state.closeRecords.push({
          status: "intent",
          ownerHostInstanceId: this.hostInstanceId,
          ownerFence: state.ownerFence,
          value: cloneClose(durableIntent),
        });
        return {
          result: {
            status: "claimed",
            intent: cloneClose(durableIntent),
            ownerFence: state.ownerFence,
          } as const,
          state,
        };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableCloseClaimResult>(section, mutate, (snapshot) => (
        this.closeClaimAfterCommit(snapshot, normalized)
      ));
    });
    this.activated = true;
    return result;
  }

  async finalizeClose(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    ownerFence: string;
  }): Promise<RelayV2TerminalDurableCloseTombstone> {
    const normalized = this.validateFinalizeClose(input);
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const record = state.closeRecords.find(
          (candidate) => candidate.value.key === normalized.key,
        );
        if (!record
          || record.value.fingerprint !== normalized.fingerprint
          || record.ownerHostInstanceId !== normalized.hostInstanceId
          || record.ownerFence !== normalized.ownerFence) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal close intent owner is missing or mismatched",
          );
        }
        record.status = "final";
        return { result: cloneClose(record.value), state };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableCloseTombstone>(section, mutate, (snapshot) => {
        const state = this.stateFromSnapshot(snapshot);
        const record = state.closeRecords.find(
          (candidate) => candidate.value.key === normalized.key,
        );
        if (!record
          || record.status !== "final"
          || record.value.fingerprint !== normalized.fingerprint
          || record.ownerHostInstanceId !== normalized.hostInstanceId
          || record.ownerFence !== normalized.ownerFence) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal close finalization could not be reconciled",
          );
        }
        return cloneClose(record.value);
      });
    });
    this.activated = true;
    return result;
  }

  async markStreamClosed(input: {
    streamKey: string;
    generation: string;
    hostInstanceId: string;
    expiresAtMs: number;
  }): Promise<RelayV2TerminalDurableStreamClosedResult> {
    const normalized = this.validateStreamTransition(input);
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const stream = state.streamAuthorities.find(
          (candidate) => candidate.streamKey === normalized.streamKey,
        );
        if (!stream
          || stream.generation !== normalized.generation
          || stream.hostInstanceId !== normalized.hostInstanceId) {
          return {
            result: { status: "conflict", reason: "stream_identity_mismatch" } as const,
            state,
          };
        }
        const alreadyClosed = stream.status === "closed";
        stream.status = "closed";
        stream.closedExpiresAtMs = Math.max(
          stream.closedExpiresAtMs ?? 0,
          normalized.expiresAtMs,
          authorityExpiresAtMs,
        );
        return {
          result: { status: alreadyClosed ? "already_closed" : "closed" } as const,
          state,
        };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableStreamClosedResult>(section, mutate, (snapshot) => {
        const stream = this.stateFromSnapshot(snapshot).streamAuthorities.find(
          (candidate) => candidate.streamKey === normalized.streamKey,
        );
        if (stream
          && stream.status === "closed"
          && stream.generation === normalized.generation
          && stream.hostInstanceId === normalized.hostInstanceId
          && (stream.closedExpiresAtMs ?? 0) >= authorityExpiresAtMs) {
          return { status: "closed" };
        }
        return { status: "conflict", reason: "stream_identity_mismatch" };
      });
    });
    this.activated = true;
    return result;
  }

  async releaseStreamReservation(input: {
    streamKey: string;
    generation: string;
    hostInstanceId: string;
  }): Promise<RelayV2TerminalDurableStreamReleaseResult> {
    const normalized = this.validateRelease(input);
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const index = state.streamAuthorities.findIndex(
          (candidate) => candidate.streamKey === normalized.streamKey,
        );
        if (index < 0) {
          return { result: { status: "already_released" } as const, state };
        }
        const stream = state.streamAuthorities[index]!;
        if (stream.generation !== normalized.generation
          || stream.hostInstanceId !== normalized.hostInstanceId) {
          return {
            result: { status: "conflict", reason: "generation_mismatch" } as const,
            state,
          };
        }
        state.streamAuthorities.splice(index, 1);
        return { result: { status: "released" } as const, state };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableStreamReleaseResult>(section, mutate, (snapshot) => {
        const stream = this.stateFromSnapshot(snapshot).streamAuthorities.find(
          (candidate) => candidate.streamKey === normalized.streamKey,
        );
        if (!stream) return { status: "released" };
        if (stream.generation !== normalized.generation
          || stream.hostInstanceId !== normalized.hostInstanceId) {
          return { status: "conflict", reason: "generation_mismatch" };
        }
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
          "Relay v2 terminal stream release did not reach a definitive state",
        );
      });
    });
    this.activated = true;
    return result;
  }

  private async settleOpen(
    rawInput: {
      key: string;
      fingerprint: string;
      hostInstanceId: string;
      claimToken: string;
      fence: string;
      outcome: RelayV2TerminalDurableOpenOutcome;
    },
    streamEffect: RelayV2TerminalOpenFailureStreamEffect | undefined,
  ): Promise<RelayV2TerminalDurableOpenCommitResult> {
    const input = this.validateSettleOpen(rawInput, streamEffect !== undefined);
    const result = await this.store.serialize((section) => {
      const authorityExpiresAtMs = this.authorityRetentionExpiresAtMs();
      const mutate = (transaction: RelayV2HostStateTransaction) => {
        const state = this.stateForTransaction(transaction);
        this.cleanup(state);
        this.prepareOwner(state, authorityExpiresAtMs);
        const record = state.openRecords.find((candidate) => candidate.key === input.key);
        if (!record
          || record.fingerprint !== input.fingerprint
          || record.ownerHostInstanceId !== input.hostInstanceId
          || record.claimToken !== input.claimToken
          || record.fence !== input.fence) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal open claim owner is missing or mismatched",
          );
        }
        if (record.status === "final") {
          return {
            result: replayOpenResult(record),
            state,
          };
        }
        if (input.outcome.kind === "opened") {
          const completion = this.completeOpened(state, record, input.outcome);
          if (completion === "stream_lost") {
            this.finishOpenRecord(record, this.streamLostOutcome(record));
            return {
              result: replayOpenResult(record),
              state,
            };
          }
        } else {
          this.applyFailureEffect(state, record, streamEffect!);
        }
        this.finishOpenRecord(record, input.outcome);
        return {
          result: { status: "committed", outcome: cloneOutcome(input.outcome) } as const,
          state,
        };
      };
      return this.commitAndReconcile<RelayV2TerminalDurableOpenCommitResult>(section, mutate, (snapshot) => {
        const record = this.stateFromSnapshot(snapshot).openRecords.find(
          (candidate) => candidate.key === input.key,
        );
        if (!record || record.fingerprint !== input.fingerprint) {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal open settlement could not be reconciled",
          );
        }
        if (record.status === "pending") {
          return lineageError(
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
            "Relay v2 terminal open settlement remained pending after reconciliation",
          );
        }
        if (sameOutcome(record.outcome!, input.outcome)) {
          return { status: "committed", outcome: cloneOutcome(record.outcome!) };
        }
        return replayOpenResult(record);
      });
    });
    this.activated = true;
    return result;
  }

  private completeOpened(
    state: PersistedTerminalLineageState,
    record: PersistedOpenRecord,
    outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>,
  ): "completed" | "stream_lost" {
    if (record.preparedBinding === null
      || !sameTarget(record.preparedBinding, record.target)
      || record.preparedBinding.pane !== record.pane) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal opened outcome lacks a durable exact preparation",
      );
    }
    const expectedDisposition = record.mode === "new"
      ? "new"
      : record.mode === "resume"
        ? "resumed"
        : "reset";
    if (outcome.disposition !== expectedDisposition
      || ((record.mode === "new" || record.mode === "reset")
        && outcome.replayFromOffset !== "0")) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal opened outcome crossed its claimed mode",
      );
    }
    const currentIndex = state.streamAuthorities.findIndex(
      (stream) => stream.streamKey === record.streamKey,
    );
    const current = currentIndex < 0 ? undefined : state.streamAuthorities[currentIndex];
    if (record.mode === "resume") {
      if (record.streamAuthority.status === "absent"
        || record.streamAuthority.status === "lost"
        || !streamMatchesClaim(current, record.streamAuthority)
        || record.previousGeneration !== record.streamAuthority.generation
        || !sameTarget(record.target, record.streamAuthority.target)
        || record.pane !== record.streamAuthority.pane
        || record.resumeTokenHash !== record.streamAuthority.resumeTokenHash
        || record.requestedOffset !== record.streamAuthority.requestedOffset
        || !sameCanonicalBinding(
          record.preparedBinding,
          record.streamAuthority.canonicalBinding,
        )
        || outcome.generation !== record.streamAuthority.generation
        || outcome.resumeTokenHash !== record.streamAuthority.resumeTokenHash
        || outcome.replayFromOffset !== record.requestedOffset
        || current.hostInstanceId !== record.ownerHostInstanceId) {
        return "stream_lost";
      }
      return "completed";
    }
    if (record.issuedGeneration === null || outcome.generation !== record.issuedGeneration) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal opened outcome did not use its durable issued generation",
      );
    }
    if (record.mode === "reset" && record.streamAuthority.status !== "absent" && (
      record.previousGeneration !== record.streamAuthority.generation
      || record.resumeTokenHash !== record.streamAuthority.resumeTokenHash
      || !sameTarget(record.target, record.streamAuthority.target)
      || record.pane !== record.streamAuthority.pane
      || record.requestedOffset === null
      || record.requestedOffset !== record.streamAuthority.requestedOffset
      || !sameCanonicalBinding(
        record.preparedBinding,
        record.streamAuthority.canonicalBinding,
      )
    )) {
      return "stream_lost";
    }
    const lostIndex = state.lostAuthorities.findIndex((stream) => (
      stream.streamKey === record.streamKey
      && lostMatchesClaim(stream, record.streamAuthority)
    ));
    if (record.streamAuthority.status === "absent") {
      if (current) return "stream_lost";
    } else if (record.streamAuthority.status === "lost") {
      if (current || lostIndex < 0) return "stream_lost";
    } else if (!streamMatchesClaim(current, record.streamAuthority)) {
      return "stream_lost";
    }
    const closeSlotReserved = current?.closeSlotReserved === true || record.reservesStreamSlot;
    const replacement: PersistedStreamAuthority = {
      status: "live",
      streamKey: record.streamKey,
      generation: outcome.generation,
      hostInstanceId: record.ownerHostInstanceId,
      target: cloneTarget(record.target),
      pane: record.pane,
      resumeTokenHash: outcome.resumeTokenHash,
      canonicalBinding: cloneCanonicalBinding(record.preparedBinding!),
      closeSlotReserved,
      closedExpiresAtMs: null,
    };
    if (!closeSlotReserved) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal generation has no reserved close slot",
      );
    }
    if (currentIndex < 0) state.streamAuthorities.push(replacement);
    else state.streamAuthorities[currentIndex] = replacement;
    if (lostIndex >= 0) state.lostAuthorities.splice(lostIndex, 1);
    return "completed";
  }

  private openAdmission(
    state: PersistedTerminalLineageState,
    claim: RelayV2TerminalDurableOpenClaim,
  ): OpenAdmission {
    if (state.openRecords.some((record) => (
      record.status === "pending" && record.streamKey === claim.streamKey
    ))) {
      return { kind: "conflict", reason: "stream_conflict" };
    }
    const stream = state.streamAuthorities.find(
      (candidate) => candidate.streamKey === claim.streamKey,
    );
    const lostForStream = state.lostAuthorities.filter(
      (candidate) => candidate.streamKey === claim.streamKey,
    );
    const retainedCloseForStream = state.closeRecords.some(
      (record) => record.value.streamKey === claim.streamKey,
    );
    const exactLost = lostForStream.find((candidate) => (
      claim.previousGeneration === candidate.generation
      && claim.resumeTokenHash === candidate.resumeTokenHash
      && sameTarget(claim.target, candidate.target)
      && claim.pane === candidate.pane
    ));
    if ((stream || lostForStream.length > 0 || retainedCloseForStream)
      && claim.mode === "new") {
      return { kind: "conflict", reason: "stream_conflict" };
    }
    if (claim.mode === "reset" && stream && (
      claim.previousGeneration !== stream.generation
      || claim.resumeTokenHash !== stream.resumeTokenHash
      || !sameTarget(claim.target, stream.target)
      || claim.pane !== stream.pane
    )) {
      return { kind: "conflict", reason: "stream_conflict" };
    }
    if (claim.mode === "reset"
      && !stream
      && claim.previousGeneration !== null
      && !exactLost) {
      return { kind: "conflict", reason: "stream_conflict" };
    }
    const streamAuthority = stream
      ? claimAuthorityFromStream(stream, claim.requestedOffset)
      : claimAuthorityFromLost(exactLost, claim.requestedOffset);
    const immediateStreamLost = claim.mode === "resume"
      && !stream
      && (exactLost !== undefined || retainedCloseForStream);
    const reservesStreamSlot = claim.mode !== "resume"
      && (!stream || !stream.closeSlotReserved);
    if (controlSlots(state) + 1 + (reservesStreamSlot ? 1 : 0)
        > this.limits.maxControlRecords
      || liveStreamSlots(state, claim) > this.limits.maxStreams
      || (claim.mode !== "resume" && nextCounter(state.generationHighWater) === null)) {
      return { kind: "busy" };
    }
    return {
      kind: "admitted",
      streamAuthority,
      reservesStreamSlot,
      immediateStreamLost,
    };
  }

  private recheckPrepareAuthority(
    state: PersistedTerminalLineageState,
    record: PersistedOpenRecord,
  ): void {
    if (record.retainedAuthorityDigest !== retainedAuthorityDigest(state, record.streamKey)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal preparation crossed a retained authority change",
      );
    }
    const current = state.streamAuthorities.find(
      (candidate) => candidate.streamKey === record.streamKey,
    );
    const exactLost = state.lostAuthorities.find((candidate) => (
      candidate.streamKey === record.streamKey
      && lostMatchesClaim(candidate, record.streamAuthority)
    ));
    if (record.mode === "new") {
      const retainedClose = state.closeRecords.some(
        (candidate) => candidate.value.streamKey === record.streamKey,
      );
      if (record.streamAuthority.status !== "absent"
        || current !== undefined
        || state.lostAuthorities.some(
          (candidate) => candidate.streamKey === record.streamKey,
        )
        || retainedClose) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
          "Relay v2 terminal new preparation no longer has absent authority",
        );
      }
      return;
    }
    if (record.mode === "resume") {
      if (record.streamAuthority.status === "absent"
        || record.streamAuthority.status === "lost"
        || !streamMatchesClaim(current, record.streamAuthority)
        || current.hostInstanceId !== record.ownerHostInstanceId) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
          "Relay v2 terminal resume preparation lost its current exact authority",
        );
      }
      return;
    }
    if (record.streamAuthority.status === "absent") {
      if (current !== undefined) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
          "Relay v2 terminal reset preparation gained a different authority",
        );
      }
      return;
    }
    if (record.streamAuthority.status === "lost") {
      if (current !== undefined || exactLost === undefined) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
          "Relay v2 terminal reset preparation lost its captured lost authority",
        );
      }
      return;
    }
    if (!streamMatchesClaim(current, record.streamAuthority)
      || current.hostInstanceId !== record.ownerHostInstanceId) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal reset preparation lost its current exact authority",
      );
    }
  }

  private applyFailureEffect(
    state: PersistedTerminalLineageState,
    record: PersistedOpenRecord,
    effect: RelayV2TerminalOpenFailureStreamEffect,
  ): void {
    if (effect.kind === "preserve") return;
    if (record.mode !== "reset"
      || record.previousGeneration !== effect.generation
      || record.resumeTokenHash === null
      || record.streamAuthority.status === "absent"
      || record.streamAuthority.generation !== effect.generation
      || !sameTarget(record.streamAuthority.target, record.target)
      || record.streamAuthority.pane !== record.pane
      || record.streamAuthority.resumeTokenHash !== record.resumeTokenHash
      || (record.preparedBinding !== null
        && !sameCanonicalBinding(
          record.preparedBinding,
          record.streamAuthority.canonicalBinding,
        ))
      || record.streamAuthority.requestedOffset !== record.requestedOffset) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal reset retirement lacks exact binding evidence",
      );
    }
    const index = state.streamAuthorities.findIndex(
      (stream) => stream.streamKey === record.streamKey,
    );
    const lostIndex = state.lostAuthorities.findIndex((stream) => (
      stream.streamKey === record.streamKey
      && lostMatchesClaim(stream, record.streamAuthority)
    ));
    if ((index < 0 || !streamMatchesClaim(state.streamAuthorities[index], record.streamAuthority))
      && lostIndex < 0) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal reset retirement lost its exact stream authority",
      );
    }
    if (index >= 0) state.streamAuthorities.splice(index, 1);
    if (lostIndex >= 0) state.lostAuthorities.splice(lostIndex, 1);
  }

  private settlePendingAsStreamLost(
    state: PersistedTerminalLineageState,
    record: PersistedOpenRecord,
  ): void {
    if (record.mode === "reset"
      && record.previousGeneration !== null
      && record.resumeTokenHash !== null
      && record.streamAuthority.status !== "absent"
      && record.streamAuthority.generation === record.previousGeneration
      && sameTarget(record.streamAuthority.target, record.target)
      && record.streamAuthority.pane === record.pane
      && record.streamAuthority.resumeTokenHash === record.resumeTokenHash
      && (record.preparedBinding === null
        || sameCanonicalBinding(
          record.preparedBinding,
          record.streamAuthority.canonicalBinding,
        ))
      && record.streamAuthority.requestedOffset === record.requestedOffset) {
      const index = state.streamAuthorities.findIndex(
        (stream) => stream.streamKey === record.streamKey,
      );
      if (index >= 0 && streamMatchesClaim(
        state.streamAuthorities[index],
        record.streamAuthority,
      )) {
        state.streamAuthorities.splice(index, 1);
      }
    }
    this.finishOpenRecord(record, this.streamLostOutcome(record));
  }

  private streamLostOutcome(
    record: PersistedOpenRecord,
  ): Extract<RelayV2TerminalDurableOpenOutcome, { kind: "reset" }> {
    const openedGeneration = record.outcome?.kind === "opened"
      ? record.outcome.generation
      : null;
    return {
      kind: "reset",
      generation: openedGeneration ?? record.issuedGeneration ?? record.previousGeneration,
      reason: "stream_lost",
      requestedOffset: record.requestedOffset,
      bufferStartOffset: null,
      tailOffset: null,
    };
  }

  private finishOpenRecord(
    record: PersistedOpenRecord,
    outcome: RelayV2TerminalDurableOpenOutcome,
  ): void {
    record.status = "final";
    record.outcome = cloneOutcome(outcome);
    record.reservesStreamSlot = false;
  }

  private cleanup(state: PersistedTerminalLineageState): void {
    const now = this.now();
    for (const record of state.openRecords) {
      if (record.status === "pending" && record.expiresAtMs <= now) {
        this.settlePendingAsStreamLost(state, record);
      }
    }
    state.openRecords = state.openRecords.filter((record) => record.expiresAtMs > now);
    const expiredCloseBindings = new Set(state.closeRecords
      .filter((record) => record.value.expiresAtMs <= now)
      .map((record) => `${record.value.streamKey}\0${record.value.generation}`));
    state.closeRecords = state.closeRecords.filter((record) => record.value.expiresAtMs > now);
    state.lostAuthorities = state.lostAuthorities.filter((record) => record.expiresAtMs > now);
    state.streamAuthorities = state.streamAuthorities.filter((stream) => (
      !expiredCloseBindings.has(`${stream.streamKey}\0${stream.generation}`)
      && (
        stream.status === "live"
        || stream.closedExpiresAtMs === null
        || stream.closedExpiresAtMs > now
      )
    ));
  }

  private prepareOwner(
    state: PersistedTerminalLineageState,
    authorityExpiresAtMs: number,
  ): void {
    if (state.activeHostInstanceId === this.hostInstanceId) {
      return;
    }
    this.replaceOwner(state, authorityExpiresAtMs, false);
  }

  private replaceOwner(
    state: PersistedTerminalLineageState,
    authorityExpiresAtMs: number,
    force: boolean,
  ): string {
    if (!force && state.activeHostInstanceId === this.hostInstanceId) {
      return state.ownerFence;
    }
    if (this.activated) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal authority was superseded by a newer host process",
      );
    }
    const fence = nextCounter(state.ownerFence);
    if (fence === null) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal process owner fence is exhausted",
      );
    }
    for (const stream of state.streamAuthorities) {
      const hasCloseEvidence = state.closeRecords.some((record) => (
        record.value.streamKey === stream.streamKey
        && record.value.generation === stream.generation
      ));
      if (hasCloseEvidence) continue;
      const existing = state.lostAuthorities.find((record) => (
        record.streamKey === stream.streamKey && record.generation === stream.generation
      ));
      if (existing) {
        existing.expiresAtMs = Math.max(existing.expiresAtMs, authorityExpiresAtMs);
      } else {
        state.lostAuthorities.push({
          streamKey: stream.streamKey,
          generation: stream.generation,
          ownerHostInstanceId: stream.hostInstanceId,
          target: cloneTarget(stream.target),
          pane: stream.pane,
          resumeTokenHash: stream.resumeTokenHash,
          canonicalBinding: cloneCanonicalBinding(stream.canonicalBinding),
          expiresAtMs: authorityExpiresAtMs,
        });
      }
    }
    state.streamAuthorities = [];
    for (const record of state.openRecords) {
      // A completed opened winner remains the immutable proof for its issued
      // generation. H3 converts that replay to stream_lost when no exact local
      // effect target survives this process fence. Only unfinished claims are
      // settled here.
      if (record.status === "pending") this.finishOpenRecord(record, this.streamLostOutcome(record));
    }
    state.activeHostInstanceId = this.hostInstanceId;
    state.ownerFence = fence;
    if (controlSlots(state) > this.limits.maxControlRecords) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT",
        "Relay v2 terminal process retirement exceeded its evidence quota",
      );
    }
    return fence;
  }

  private stateForTransaction(
    transaction: RelayV2HostStateTransaction,
  ): PersistedTerminalLineageState {
    const value = transaction.getMaterializedRecord(TERMINAL_LINEAGE_KEY);
    return value === undefined
      ? emptyState(transaction.hostEpoch)
      : parseState(value, transaction.hostEpoch, this.limits);
  }

  private stateFromSnapshot(snapshot: RelayV2HostStateSnapshot): PersistedTerminalLineageState {
    const value = snapshot.materialized[TERMINAL_LINEAGE_KEY];
    return value === undefined
      ? emptyState(snapshot.hostEpoch)
      : parseState(value, snapshot.hostEpoch, this.limits);
  }

  private putState(
    transaction: RelayV2HostStateTransaction,
    state: PersistedTerminalLineageState,
  ): void {
    const normalized = parseState(state, transaction.hostEpoch, this.limits);
    transaction.putMaterializedRecord(
      TERMINAL_LINEAGE_KEY,
      normalized as unknown as RelayV2HostJson,
    );
  }

  private commitAndReconcile<T>(
    section: RelayV2HostStateCriticalSection,
    mutate: (transaction: RelayV2HostStateTransaction) => {
      result: T;
      state: PersistedTerminalLineageState;
    },
    reconcile: (snapshot: RelayV2HostStateSnapshot) => T,
  ): T {
    try {
      return section.transaction((transaction) => {
        const mutation = mutate(transaction);
        this.putState(transaction, mutation.state);
        return mutation.result;
      }).value;
    } catch (error) {
      if (!isCommitUncertain(error)) throw error;
      return reconcile(section.read());
    }
  }

  private issueOwnedId(kind: "claim" | "fence"): string {
    const value = this.issueAuthorityId(kind);
    if (!isOpaque(value)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        `Relay v2 terminal ${kind} issuer returned an invalid authority ID`,
      );
    }
    return value;
  }

  private authorityRetentionExpiresAtMs(): number {
    const expiresAtMs = this.now() + RELAY_V2_TERMINAL_CONTROL_RETENTION_MS;
    if (!isSafeTime(expiresAtMs)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal durable retention expiry is outside the safe time range",
      );
    }
    return expiresAtMs;
  }

  private validateOpenClaim(
    value: RelayV2TerminalDurableOpenClaim,
  ): RelayV2TerminalDurableOpenClaim {
    if (!isRecord(value)
      || !exactKeys(value, [
        "key",
        "streamKey",
        "fingerprint",
        "hostInstanceId",
        "target",
        "pane",
        "resumeTokenHash",
        "mode",
        "previousGeneration",
        "requestedOffset",
        "expiresAtMs",
      ])
      || !isDurableKey(value.key)
      || !isDurableKey(value.streamKey)
      || !isFingerprint(value.fingerprint)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId
      || !(value.resumeTokenHash === null || isFingerprint(value.resumeTokenHash))
      || (value.mode !== "new" && value.mode !== "resume" && value.mode !== "reset")
      || !(value.previousGeneration === null || isOpaque(value.previousGeneration))
      || !(value.requestedOffset === null || isCounter(value.requestedOffset))
      || !isSafeTime(value.expiresAtMs)
      || value.expiresAtMs <= this.now()
      || value.expiresAtMs > this.now() + RELAY_V2_TERMINAL_CONTROL_RETENTION_MS
      || (value.mode === "new" && (
        value.resumeTokenHash !== null
        || value.previousGeneration !== null
        || value.requestedOffset !== null
      ))
      || (value.mode === "resume" && (
        value.resumeTokenHash === null
        || value.previousGeneration === null
        || value.requestedOffset === null
      ))
      || (value.mode === "reset" && !(
        (value.resumeTokenHash === null
          && value.previousGeneration === null
          && value.requestedOffset === null)
        || (value.resumeTokenHash !== null
          && value.previousGeneration !== null
          && value.requestedOffset !== null)
      ))) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal open claim input is invalid",
      );
    }
    return {
      ...value,
      target: parseTarget(value.target),
      pane: parsePane(value.pane),
    };
  }

  private sameLogicalClaim(
    record: PersistedOpenRecord,
    claim: RelayV2TerminalDurableOpenClaim,
  ): boolean {
    return record.streamKey === claim.streamKey
      && sameTarget(record.target, claim.target)
      && record.pane === claim.pane
      && record.resumeTokenHash === claim.resumeTokenHash
      && record.mode === claim.mode
      && record.previousGeneration === claim.previousGeneration
      && record.requestedOffset === claim.requestedOffset;
  }

  private validatePrepareOpen(value: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    preparation:
      | { kind: "current"; resolution: RelayV2TerminalCanonicalResolution }
      | { kind: "retained"; binding: RelayV2TerminalCanonicalTargetBindingV1 };
  }): typeof value {
    if (!isRecord(value)
      || !exactKeys(value, [
        "key", "fingerprint", "hostInstanceId", "claimToken", "fence", "preparation",
      ])
      || !isDurableKey(value.key)
      || !isFingerprint(value.fingerprint)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId
      || !isOpaque(value.claimToken)
      || !isOpaque(value.fence)
      || !isRecord(value.preparation)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal prepare input is invalid",
      );
    }
    if (value.preparation.kind === "retained"
      && exactKeys(value.preparation, ["kind", "binding"])) {
      return {
        ...value,
        preparation: {
          kind: "retained",
          binding: parseCanonicalBinding(
            value.preparation.binding,
            "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
          ),
        },
      };
    }
    if (value.preparation.kind !== "current"
      || !exactKeys(value.preparation, ["kind", "resolution"])
      || !isRecord(value.preparation.resolution)
      || !exactKeys(value.preparation.resolution, ["target", "binding", "admission"])
      || !isRecord(value.preparation.resolution.target)
      || !exactKeys(value.preparation.resolution.target, [
        "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
      ])) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal current preparation is invalid",
      );
    }
    const binding = parseCanonicalBinding(
      value.preparation.resolution.binding,
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
    );
    const target = value.preparation.resolution.target;
    if (!sameTarget(binding, target as unknown as RelayV2TerminalWireTarget)
      || target.pane !== binding.pane
      || target.canonicalTargetId !== binding.backendInstanceKey
      || target.controlTargetId !== binding.exactControlIdentity.controlTargetId
      || !isRecord(value.preparation.resolution.admission)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal current preparation binding is mismatched",
      );
    }
    return {
      ...value,
      preparation: {
        kind: "current",
        resolution: {
          ...value.preparation.resolution,
          target: { ...value.preparation.resolution.target },
          binding,
        },
      },
    };
  }

  private validateSettleOpen(
    value: {
      key: string;
      fingerprint: string;
      hostInstanceId: string;
      claimToken: string;
      fence: string;
      outcome: RelayV2TerminalDurableOpenOutcome;
    },
    failure: boolean,
  ): typeof value {
    if (!isRecord(value)
      || !exactKeys(value, [
        "key", "fingerprint", "hostInstanceId", "claimToken", "fence", "outcome",
      ])
      || !isDurableKey(value.key)
      || !isFingerprint(value.fingerprint)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId
      || !isOpaque(value.claimToken)
      || !isOpaque(value.fence)) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal open settlement input is invalid",
      );
    }
    const outcome = parseOpenOutcome(value.outcome);
    if ((failure && outcome.kind === "opened") || (!failure && outcome.kind !== "opened")) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal open settlement used the wrong outcome branch",
      );
    }
    return { ...value, outcome };
  }

  private validateStreamEffect(
    value: RelayV2TerminalOpenFailureStreamEffect,
  ): RelayV2TerminalOpenFailureStreamEffect {
    if (isRecord(value) && exactKeys(value, ["kind"]) && value.kind === "preserve") {
      return { kind: "preserve" };
    }
    if (isRecord(value)
      && exactKeys(value, ["kind", "generation"])
      && value.kind === "retire_previous"
      && isOpaque(value.generation)) {
      return { kind: "retire_previous", generation: value.generation };
    }
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
      "Relay v2 terminal failure stream effect is invalid",
    );
  }

  private validateCloseClaimInput(value: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    intent?: RelayV2TerminalDurableCloseIntent;
  }): typeof value {
    const expected = value.intent === undefined
      ? ["key", "fingerprint", "hostInstanceId"]
      : ["key", "fingerprint", "hostInstanceId", "intent"];
    if (!isRecord(value)
      || !exactKeys(value, expected)
      || !isDurableKey(value.key)
      || !isFingerprint(value.fingerprint)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal close claim input is invalid",
      );
    }
    if (value.intent === undefined) return value;
    const intent = parseCloseTombstone(value.intent);
    if (intent.key !== value.key
      || intent.fingerprint !== value.fingerprint
      || intent.hostInstanceId !== value.hostInstanceId
      || intent.expiresAtMs <= this.now()
      || intent.expiresAtMs > this.now() + RELAY_V2_TERMINAL_CONTROL_RETENTION_MS) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal close intent does not match its claim",
      );
    }
    return { ...value, intent };
  }

  private validateFinalizeClose(value: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    ownerFence: string;
  }): typeof value {
    if (!isRecord(value)
      || !exactKeys(value, ["key", "fingerprint", "hostInstanceId", "ownerFence"])
      || !isDurableKey(value.key)
      || !isFingerprint(value.fingerprint)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId
      || !isCounter(value.ownerFence)
      || value.ownerFence === "0") {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal close finalization input is invalid",
      );
    }
    return value;
  }

  private validateStreamTransition(value: {
    streamKey: string;
    generation: string;
    hostInstanceId: string;
    expiresAtMs: number;
  }): typeof value {
    if (!isRecord(value)
      || !exactKeys(value, ["streamKey", "generation", "hostInstanceId", "expiresAtMs"])
      || !isDurableKey(value.streamKey)
      || !isOpaque(value.generation)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId
      || !isSafeTime(value.expiresAtMs)
      || value.expiresAtMs <= this.now()
      || value.expiresAtMs > this.now() + RELAY_V2_TERMINAL_CONTROL_RETENTION_MS) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal natural close input is invalid",
      );
    }
    return value;
  }

  private validateRelease(value: {
    streamKey: string;
    generation: string;
    hostInstanceId: string;
  }): typeof value {
    if (!isRecord(value)
      || !exactKeys(value, ["streamKey", "generation", "hostInstanceId"])
      || !isDurableKey(value.streamKey)
      || !isOpaque(value.generation)
      || !isOpaque(value.hostInstanceId)
      || value.hostInstanceId !== this.hostInstanceId) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT",
        "Relay v2 terminal stream release input is invalid",
      );
    }
    return value;
  }

  private openClaimAfterCommit(
    snapshot: RelayV2HostStateSnapshot,
    claim: RelayV2TerminalDurableOpenClaim,
    claimToken: string,
    fence: string,
  ): RelayV2TerminalDurableOpenClaimResult {
    const state = this.stateFromSnapshot(snapshot);
    if (state.activeHostInstanceId !== this.hostInstanceId) {
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal open claim owner activation was not committed",
      );
    }
    const record = state.openRecords.find((candidate) => candidate.key === claim.key);
    if (record) {
      if (record.fingerprint !== claim.fingerprint || !this.sameLogicalClaim(record, claim)) {
        return { status: "conflict", reason: "open_conflict" };
      }
      if (record.status === "final") {
        return replayOpenResult(record);
      }
      if (record.claimToken === claimToken && record.fence === fence) {
        return {
          status: "claimed",
          claimToken,
          fence,
          issuedGeneration: record.issuedGeneration,
          streamAuthority: publicAuthority(record.streamAuthority),
        };
      }
      return lineageError(
        "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
        "Relay v2 terminal open claim owner changed during reconciliation",
      );
    }
    const admission = this.openAdmission(state, claim);
    if (admission.kind === "conflict") {
      return { status: "conflict", reason: admission.reason };
    }
    if (admission.kind === "busy") {
      return { status: "busy", reason: "control_record_quota" };
    }
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
      "Relay v2 terminal open claim commit could not be reconciled",
    );
  }

  private closeClaimAfterCommit(
    snapshot: RelayV2HostStateSnapshot,
    input: {
      key: string;
      fingerprint: string;
      hostInstanceId: string;
      intent?: RelayV2TerminalDurableCloseIntent;
    },
  ): RelayV2TerminalDurableCloseClaimResult {
    const state = this.stateFromSnapshot(snapshot);
    const record = state.closeRecords.find(
      (candidate) => candidate.value.key === input.key,
    );
    if (record) {
      if (record.value.fingerprint !== input.fingerprint
        || (input.intent && !sameCloseBinding(record.value, input.intent))) {
        return { status: "close_conflict" };
      }
      if (record.status === "final") {
        return { status: "final", tombstone: cloneClose(record.value) };
      }
      if (record.ownerHostInstanceId !== input.hostInstanceId
        || record.ownerFence !== state.ownerFence) {
        return lineageError(
          "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
          "Relay v2 terminal close intent owner adoption could not be reconciled",
        );
      }
      return {
        status: "existing_intent",
        intent: cloneClose(record.value),
        ownerFence: record.ownerFence,
      };
    }
    if (!input.intent) return { status: "not_found" };
    const stream = state.streamAuthorities.find(
      (candidate) => candidate.streamKey === input.intent!.streamKey,
    );
    if (!stream
      || stream.generation !== input.intent.generation
      || stream.hostInstanceId !== input.intent.hostInstanceId
      || !sameTarget(stream.target, input.intent.target)
      || !stream.closeSlotReserved) {
      return { status: "not_found" };
    }
    return lineageError(
      "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT",
      "Relay v2 terminal close claim commit could not be reconciled",
    );
  }
}
