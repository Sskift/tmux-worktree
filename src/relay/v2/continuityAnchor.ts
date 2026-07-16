export const RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION = 1 as const;

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CAS_TOKEN_BYTES = 512;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type RelayV2ContinuityAnchorErrorCode =
  | "INVALID_CHECKPOINT"
  | "INVALID_AUTHORITY_RESPONSE"
  | "ANCHOR_UNAVAILABLE"
  | "STATE_COMMIT_UNCERTAIN"
  | "ANCHOR_COMMIT_UNCERTAIN"
  | "CAS_CONFLICT"
  | "ROLLBACK_DETECTED";

export class RelayV2ContinuityAnchorError extends Error {
  readonly code: RelayV2ContinuityAnchorErrorCode;

  constructor(code: RelayV2ContinuityAnchorErrorCode, message: string) {
    super(message);
    this.name = "RelayV2ContinuityAnchorError";
    this.code = code;
  }
}

/**
 * Digest-bearing identity of one complete caller-owned state commit.
 *
 * The caller is responsible for hashing the exact durable state represented by
 * stateDigest. Sequence zero is the only genesis shape; every later checkpoint
 * must name its immediate parent commit.
 */
export interface RelayV2ContinuityCheckpoint {
  protocolVersion: typeof RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
  anchorId: string;
  sequence: string;
  commitId: string;
  parentCommitId: string | null;
  stateDigest: string;
}

export interface RelayV2ContinuityAnchorUninitialized {
  protocolVersion: typeof RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
  status: "uninitialized";
  anchorId: string;
  casToken: string;
}

export interface RelayV2ContinuityAnchorCommitted {
  protocolVersion: typeof RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
  status: "committed";
  anchorId: string;
  casToken: string;
  checkpoint: RelayV2ContinuityCheckpoint;
}

export type RelayV2ContinuityAnchorSnapshot =
  | RelayV2ContinuityAnchorUninitialized
  | RelayV2ContinuityAnchorCommitted;

export interface RelayV2ContinuityAnchorReadRequest {
  protocolVersion: typeof RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
  anchorId: string;
}

export interface RelayV2ContinuityAnchorCasRequest {
  protocolVersion: typeof RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
  anchorId: string;
  expected: RelayV2ContinuityAnchorSnapshot;
  next: RelayV2ContinuityCheckpoint;
}

/**
 * The injected implementation is the rollback-independent authority.
 *
 * It must durably serialize reads and CAS operations, issue non-repeating CAS
 * tokens, enforce genesis-or-exactly-one-successor monotonicity, and never
 * report an initialized anchor as uninitialized again. In particular, this
 * authority must not share the caller state directory or its rollback domain.
 * Results are decoded at runtime so an incompatible or malformed adapter fails
 * closed rather than becoming continuity evidence.
 */
export interface RelayV2MonotonicCasAuthority {
  read(request: RelayV2ContinuityAnchorReadRequest): Promise<unknown>;
  compareAndSwap(request: RelayV2ContinuityAnchorCasRequest): Promise<unknown>;
}

export interface RelayV2ContinuityAnchorOptions {
  /** Stable namespace provisioned outside the rollbackable caller state. */
  anchorId: string;
  authority: RelayV2MonotonicCasAuthority;
}

export interface RelayV2ContinuityAnchorCasResult {
  protocolVersion: typeof RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
  outcome: "swapped" | "conflict";
  current: RelayV2ContinuityAnchorSnapshot;
}

export interface RelayV2ContinuityReconcileResult {
  disposition:
    | "matched"
    | "initialized"
    | "recovered_state_before_anchor"
    | "converged_after_cas_conflict";
  anchor: RelayV2ContinuityAnchorCommitted;
}

export interface RelayV2ContinuityAdvanceInput {
  current: RelayV2ContinuityCheckpoint;
  next: RelayV2ContinuityCheckpoint;
  /** Atomically publish the exact state represented by next before anchor CAS. */
  publishState(next: Readonly<RelayV2ContinuityCheckpoint>): void | Promise<void>;
}

export interface RelayV2ContinuityAdvanceResult {
  disposition: "committed" | "converged_after_cas_conflict";
  anchor: RelayV2ContinuityAnchorCommitted;
}

function fail(
  code: RelayV2ContinuityAnchorErrorCode,
  message: string,
): never {
  throw new RelayV2ContinuityAnchorError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_IDENTIFIER_LENGTH
    && IDENTIFIER.test(value);
}

function isCanonicalUint64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
}

function isCasToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_CAS_TOKEN_BYTES) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function checkpointError(source: "caller" | "authority"): never {
  return source === "caller"
    ? fail("INVALID_CHECKPOINT", "Relay v2 continuity checkpoint is invalid")
    : fail("INVALID_AUTHORITY_RESPONSE", "Relay v2 continuity authority returned an invalid checkpoint");
}

function parseCheckpoint(
  value: unknown,
  expectedAnchorId: string,
  source: "caller" | "authority",
): RelayV2ContinuityCheckpoint {
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocolVersion",
    "anchorId",
    "sequence",
    "commitId",
    "parentCommitId",
    "stateDigest",
  ])) checkpointError(source);

  if (
    value.protocolVersion !== RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION
    || value.anchorId !== expectedAnchorId
    || !isIdentifier(value.anchorId)
    || !isCanonicalUint64(value.sequence)
    || !isIdentifier(value.commitId)
    || (value.parentCommitId !== null && !isIdentifier(value.parentCommitId))
    || typeof value.stateDigest !== "string"
    || !SHA256_HEX.test(value.stateDigest)
  ) checkpointError(source);

  const sequence = BigInt(value.sequence);
  if (
    (sequence === 0n && value.parentCommitId !== null)
    || (sequence > 0n && value.parentCommitId === null)
    || value.commitId === value.parentCommitId
  ) checkpointError(source);

  return {
    protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
    anchorId: value.anchorId,
    sequence: value.sequence,
    commitId: value.commitId,
    parentCommitId: value.parentCommitId,
    stateDigest: value.stateDigest,
  };
}

function parseSnapshot(
  value: unknown,
  expectedAnchorId: string,
): RelayV2ContinuityAnchorSnapshot {
  if (!isRecord(value)) {
    return fail("INVALID_AUTHORITY_RESPONSE", "Relay v2 continuity authority returned an invalid snapshot");
  }
  const commonValid = value.protocolVersion === RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION
    && value.anchorId === expectedAnchorId
    && isIdentifier(value.anchorId)
    && isCasToken(value.casToken);
  if (value.status === "uninitialized") {
    if (!commonValid || !hasExactKeys(value, [
      "protocolVersion", "status", "anchorId", "casToken",
    ])) {
      return fail("INVALID_AUTHORITY_RESPONSE", "Relay v2 continuity authority returned an invalid snapshot");
    }
    return {
      protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "uninitialized",
      anchorId: value.anchorId,
      casToken: value.casToken,
    };
  }
  if (value.status === "committed") {
    if (!commonValid || !hasExactKeys(value, [
      "protocolVersion", "status", "anchorId", "casToken", "checkpoint",
    ])) {
      return fail("INVALID_AUTHORITY_RESPONSE", "Relay v2 continuity authority returned an invalid snapshot");
    }
    return {
      protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "committed",
      anchorId: value.anchorId,
      casToken: value.casToken,
      checkpoint: parseCheckpoint(value.checkpoint, expectedAnchorId, "authority"),
    };
  }
  return fail("INVALID_AUTHORITY_RESPONSE", "Relay v2 continuity authority returned an invalid snapshot");
}

function parseCasResult(
  value: unknown,
  expectedAnchorId: string,
): RelayV2ContinuityAnchorCasResult {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["protocolVersion", "outcome", "current"])
    || value.protocolVersion !== RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION
    || (value.outcome !== "swapped" && value.outcome !== "conflict")
  ) {
    return fail("INVALID_AUTHORITY_RESPONSE", "Relay v2 continuity authority returned an invalid CAS result");
  }
  return {
    protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
    outcome: value.outcome,
    current: parseSnapshot(value.current, expectedAnchorId),
  };
}

function sameCheckpoint(
  left: RelayV2ContinuityCheckpoint,
  right: RelayV2ContinuityCheckpoint,
): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.anchorId === right.anchorId
    && left.sequence === right.sequence
    && left.commitId === right.commitId
    && left.parentCommitId === right.parentCommitId
    && left.stateDigest === right.stateDigest;
}

function isImmediateSuccessor(
  next: RelayV2ContinuityCheckpoint,
  current: RelayV2ContinuityCheckpoint,
): boolean {
  return BigInt(current.sequence) < MAX_UINT64
    && BigInt(next.sequence) === BigInt(current.sequence) + 1n
    && next.parentCommitId === current.commitId;
}

function cloneSnapshot(
  snapshot: RelayV2ContinuityAnchorSnapshot,
): RelayV2ContinuityAnchorSnapshot {
  if (snapshot.status === "uninitialized") return { ...snapshot };
  return { ...snapshot, checkpoint: { ...snapshot.checkpoint } };
}

function freezeCheckpoint(
  checkpoint: RelayV2ContinuityCheckpoint,
): Readonly<RelayV2ContinuityCheckpoint> {
  return Object.freeze({ ...checkpoint });
}

interface PromoteResult {
  disposition: "swapped" | "converged_after_cas_conflict";
  anchor: RelayV2ContinuityAnchorCommitted;
}

/**
 * Orders a caller-owned atomic state commit before an injected external anchor
 * CAS and reconciles the single crash window that ordering creates.
 *
 * This class intentionally has no persistence implementation or default
 * authority. A caller that cannot supply an external monotonic/CAS authority
 * cannot construct continuity evidence.
 */
export class RelayV2ContinuityAnchor {
  readonly anchorId: string;

  private readonly authority: RelayV2MonotonicCasAuthority;
  private serializerTail: Promise<void> = Promise.resolve();

  constructor(options: RelayV2ContinuityAnchorOptions) {
    if (!isRecord(options) || !isIdentifier(options.anchorId)) {
      throw new TypeError("Relay v2 continuity anchorId is invalid");
    }
    if (
      !isRecord(options.authority)
      || typeof options.authority.read !== "function"
      || typeof options.authority.compareAndSwap !== "function"
    ) {
      throw new TypeError("Relay v2 continuity authority must be supplied by the caller");
    }
    this.anchorId = options.anchorId;
    this.authority = options.authority as RelayV2MonotonicCasAuthority;
  }

  async reconcile(
    localCheckpoint: RelayV2ContinuityCheckpoint,
  ): Promise<RelayV2ContinuityReconcileResult> {
    const local = parseCheckpoint(localCheckpoint, this.anchorId, "caller");
    return await this.serialize(() => this.reconcileInternal(local));
  }

  async advance(input: RelayV2ContinuityAdvanceInput): Promise<RelayV2ContinuityAdvanceResult> {
    if (!isRecord(input) || typeof input.publishState !== "function") {
      throw new TypeError("Relay v2 continuity advance input is invalid");
    }
    const current = parseCheckpoint(input.current, this.anchorId, "caller");
    const next = parseCheckpoint(input.next, this.anchorId, "caller");
    const publishState = input.publishState;
    if (!isImmediateSuccessor(next, current)) {
      throw new RelayV2ContinuityAnchorError(
        "INVALID_CHECKPOINT",
        "Relay v2 continuity next checkpoint is not the immediate successor",
      );
    }

    return await this.serialize(async () => {
      const reconciled = await this.reconcileInternal(current);
      if (!sameCheckpoint(reconciled.anchor.checkpoint, current)) {
        return fail("ROLLBACK_DETECTED", "Relay v2 continuity state does not match its external anchor");
      }

      try {
        await publishState(freezeCheckpoint(next));
      } catch {
        return fail(
          "STATE_COMMIT_UNCERTAIN",
          "Relay v2 continuity state publication did not provide a durable completion result",
        );
      }

      const promoted = await this.promote(reconciled.anchor, next);
      return {
        disposition: promoted.disposition === "swapped"
          ? "committed"
          : "converged_after_cas_conflict",
        anchor: promoted.anchor,
      };
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.serializerTail;
    this.serializerTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async reconcileInternal(
    local: RelayV2ContinuityCheckpoint,
  ): Promise<RelayV2ContinuityReconcileResult> {
    const observed = await this.readAnchor();
    if (observed.status === "uninitialized") {
      if (local.sequence !== "0" || local.parentCommitId !== null) {
        return fail(
          "ROLLBACK_DETECTED",
          "Relay v2 continuity authority has no history for a non-genesis state",
        );
      }
      const promoted = await this.promote(observed, local);
      return {
        disposition: promoted.disposition === "swapped"
          ? "initialized"
          : "converged_after_cas_conflict",
        anchor: promoted.anchor,
      };
    }
    if (sameCheckpoint(observed.checkpoint, local)) {
      return { disposition: "matched", anchor: observed };
    }
    if (isImmediateSuccessor(local, observed.checkpoint)) {
      const promoted = await this.promote(observed, local);
      return {
        disposition: promoted.disposition === "swapped"
          ? "recovered_state_before_anchor"
          : "converged_after_cas_conflict",
        anchor: promoted.anchor,
      };
    }
    return fail(
      "ROLLBACK_DETECTED",
      "Relay v2 continuity state is rolled back or diverges from its external anchor",
    );
  }

  private async readAnchor(): Promise<RelayV2ContinuityAnchorSnapshot> {
    let raw: unknown;
    try {
      raw = await this.authority.read({
        protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        anchorId: this.anchorId,
      });
    } catch {
      return fail("ANCHOR_UNAVAILABLE", "Relay v2 external continuity authority is unavailable");
    }
    return parseSnapshot(raw, this.anchorId);
  }

  private async promote(
    expected: RelayV2ContinuityAnchorSnapshot,
    next: RelayV2ContinuityCheckpoint,
  ): Promise<PromoteResult> {
    let raw: unknown;
    try {
      raw = await this.authority.compareAndSwap({
        protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        anchorId: this.anchorId,
        expected: cloneSnapshot(expected),
        next: { ...next },
      });
    } catch {
      return fail(
        "ANCHOR_COMMIT_UNCERTAIN",
        "Relay v2 continuity anchor CAS did not provide a durable completion result",
      );
    }

    let result: RelayV2ContinuityAnchorCasResult;
    try {
      result = parseCasResult(raw, this.anchorId);
    } catch (error) {
      if (error instanceof RelayV2ContinuityAnchorError) {
        return fail(
          "ANCHOR_COMMIT_UNCERTAIN",
          "Relay v2 continuity anchor CAS returned an unusable completion result",
        );
      }
      throw error;
    }

    if (result.current.casToken === expected.casToken) {
      return fail(
        "ANCHOR_COMMIT_UNCERTAIN",
        "Relay v2 continuity anchor CAS did not advance its comparison token",
      );
    }
    if (
      result.current.status === "committed"
      && sameCheckpoint(result.current.checkpoint, next)
    ) {
      return {
        disposition: result.outcome === "swapped"
          ? "swapped"
          : "converged_after_cas_conflict",
        anchor: result.current,
      };
    }
    if (result.outcome === "swapped") {
      return fail(
        "ANCHOR_COMMIT_UNCERTAIN",
        "Relay v2 continuity authority acknowledged a different checkpoint",
      );
    }
    return fail(
      "CAS_CONFLICT",
      "Relay v2 continuity anchor CAS lost to a different checkpoint",
    );
  }
}
