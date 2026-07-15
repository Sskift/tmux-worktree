import { createHash } from "node:crypto";
import {
  encodeRelayV2WebSocketFrame,
  validateRelayV2CommandRouteEnvelope,
} from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  type RelayV2HostJson,
  type RelayV2MaterializedReadinessFence,
  type RelayV2HostStateCommit,
  type RelayV2HostStateCriticalSection,
  type RelayV2HostStateSnapshot,
  type RelayV2HostStateTransaction,
  RelayV2HostStateCommitUncertainError,
  RelayV2HostStateStore,
} from "./hostState.js";

export const RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_COMMAND_PLAN_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_COMMAND_RESULT_RETENTION_MS = 86_400_000;
export const RELAY_V2_COMMAND_DEDUPE_RETENTION_MS = 604_800_000;

const COMMAND_RECORD_SCHEMA_VERSION = 1 as const;
const COMMAND_WINDOW_REVISION_KEY = "command-windows";
const COMMAND_KEY_PREFIX = "cmd:v1:";
const WINDOW_KEY_PREFIX = "cmdwin:v1:";

export type RelayV2CommandOperation =
  | "create_worktree"
  | "create_terminal"
  | "send_agent_message"
  | "kill_session";

export type RelayV2CommandDisposition =
  | "not_accepted"
  | "accepted"
  | "running"
  | "completed"
  | "in_doubt"
  | "not_applicable";

export interface RelayV2CommandAuthContext {
  principalId: string;
  clientInstanceId: string;
  hostId: string;
}

export interface RelayV2CommandStructuredError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | null;
  commandDisposition: RelayV2CommandDisposition;
  details?: RelayV2HostJson;
}

export interface RelayV2CanonicalCommandRequest {
  fingerprintSchemaVersion: typeof RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION;
  authority: "tw_rpc" | "terminal_control";
  operation: RelayV2CommandOperation;
  principalId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string | null;
  arguments: RelayV2JsonObject;
}

interface RelayV2CanonicalExecutionPlanBase {
  schemaVersion: typeof RELAY_V2_COMMAND_PLAN_SCHEMA_VERSION;
  operation: RelayV2CommandOperation;
  principalId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string | null;
  arguments: RelayV2JsonObject;
  adapterState: RelayV2HostJson;
  resourceReservation: RelayV2CommandResourceReservationBinding | null;
}

export interface RelayV2TwRpcExecutionPlan extends RelayV2CanonicalExecutionPlanBase {
  authority: "tw_rpc";
  operation: "create_worktree" | "create_terminal" | "kill_session";
}

export interface RelayV2TerminalControlExecutionPlan extends RelayV2CanonicalExecutionPlanBase {
  authority: "terminal_control";
  operation: "send_agent_message";
}

export type RelayV2CanonicalExecutionPlan =
  | RelayV2TwRpcExecutionPlan
  | RelayV2TerminalControlExecutionPlan;

export interface RelayV2CommandAuthorityEvidence {
  schemaVersion: typeof RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION;
  coverage: "complete" | "partial" | "unreachable";
  authority: "tw_rpc" | "terminal_control";
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string | null;
  evidence: RelayV2HostJson;
}

export interface RelayV2CommandRequestFingerprint {
  schemaVersion: typeof RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION;
  algorithm: "sha256-rfc8785";
  digest: string;
}

export interface RelayV2CommandResourceReservationBinding {
  schemaVersion: typeof RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION;
  owner: "relay_v2_resource_state";
  reservationId: string;
}

export interface RelayV2CommandResourceReservationIntent {
  schemaVersion: typeof RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION;
  owner: "relay_v2_resource_state";
  operation: "create_worktree" | "create_terminal";
  principalId: string;
  hostId: string;
  hostEpoch: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
  scopeId: string;
  reservationPlan: RelayV2HostJson;
}

export type RelayV2CommandResourceReservationResult =
  | { kind: "reserved"; binding: RelayV2CommandResourceReservationBinding }
  | { kind: "rejected"; error: RelayV2CommandStructuredError };

export interface RelayV2CommandResourceCommitIntent {
  schemaVersion: typeof RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION;
  owner: "relay_v2_resource_state";
  operation: "create_worktree" | "create_terminal" | "kill_session";
  principalId: string;
  hostId: string;
  hostEpoch: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
  scopeId: string;
  sessionId: string | null;
  reservationBinding: RelayV2CommandResourceReservationBinding | null;
  backendOutcome: RelayV2CanonicalBackendOutcome;
  commitIntent: RelayV2HostJson;
}

export interface RelayV2CanonicalBackendOutcome {
  schemaVersion: typeof RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION;
  backendInstanceKey: string;
  evidence: RelayV2HostJson;
}

export interface RelayV2CommandResourceSettlementIntent {
  schemaVersion: typeof RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION;
  owner: "relay_v2_resource_state";
  operation: "create_worktree" | "create_terminal";
  principalId: string;
  hostId: string;
  hostEpoch: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
  scopeId: string;
  reservationBinding: RelayV2CommandResourceReservationBinding | null;
  disposition: "release_no_side_effect" | "retain_uncertain";
  backendOutcome: RelayV2CanonicalBackendOutcome | null;
}

export type RelayV2CommandResourceSettlementResult =
  | "retained"
  | "retained_fenced"
  | "released"
  | "consumed";

export interface RelayV2CommandResourceCommitEvidence {
  schemaVersion: typeof RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION;
  owner: "relay_v2_resource_state";
  operation: "create_worktree" | "create_terminal" | "kill_session";
  principalId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  result: RelayV2JsonObject;
  events: RelayV2JsonObject[];
  evidence: RelayV2HostJson;
}

export interface RelayV2CommandResourceTransaction {
  getMaterializedRecord(key: string): RelayV2HostJson | undefined;
  putMaterializedRecord(key: string, value: RelayV2HostJson): void;
  deleteMaterializedRecord(key: string): void;
  getRevision(revisionKey: string): string | undefined;
  allocateRevision(revisionKey: string): string;
  allocateEventSeq(): string;
  issueOpaqueId(prefix?: string): string;
  getMaterializedReadinessFence(): RelayV2MaterializedReadinessFence | null;
  latchMaterializedReadinessFence(reason: "materialized_authority_conflict"): void;
}

/**
 * H2 owns backend-evidence parsing, opaque Session identity reservation/reuse,
 * Session mappings, revisions, and event sequence allocation. reserve runs in
 * the same H0 transaction as ACCEPTED and allocates the opaque Session ID but
 * never predicts a backend incarnation. commit runs with the command terminal
 * transaction and attaches only the executor's post-create backendInstanceKey.
 * publishCommitted is a synchronous bounded enqueue before the H0 serializer
 * is released. A throw or thenable return fences the committed cut; production
 * implementations must not reenter H0 or perform backend/network I/O there.
 * The canonical executor cannot provide the public Session result or ID.
 */
export interface RelayV2CommandResourceMutationOwner {
  reserve(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceReservationIntent,
  ): RelayV2CommandResourceReservationResult;
  commit(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceCommitIntent,
  ): RelayV2CommandResourceCommitEvidence;
  settle(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceSettlementIntent,
  ): RelayV2CommandResourceSettlementResult;
  hasPendingSettlement(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceSettlementIntent,
  ): boolean;
  publishCommitted(
    snapshot: RelayV2HostStateSnapshot,
    evidence: RelayV2CommandResourceCommitEvidence,
  ): void;
  fenceCommitUncertain(snapshot: RelayV2HostStateSnapshot): void;
  fencePersistedCapacity(snapshot: RelayV2HostStateSnapshot): void;
  fenceMaterializedAuthority(snapshot: RelayV2HostStateSnapshot): void;
}

export type RelayV2CommandAdmission =
  | {
      kind: "executable";
      adapterState: RelayV2HostJson;
      resourceReservationPlan?: RelayV2HostJson;
    }
  | {
      kind: "immutable_business_failure";
      error: RelayV2CommandStructuredError;
      authorityEvidence: RelayV2CommandAuthorityEvidence;
    }
  | {
      kind: "transient_admission_failure";
      error: RelayV2CommandStructuredError;
      authorityEvidence?: RelayV2CommandAuthorityEvidence;
    };

type RelayV2ExecutionFailureOutcome =
  | {
      state: "failed";
      error: RelayV2CommandStructuredError;
    }
  | {
      state: "in_doubt";
    };

export type RelayV2TwRpcExecutionOutcome =
  | {
      state: "succeeded";
      backendOutcome: RelayV2CanonicalBackendOutcome;
      commitIntent: RelayV2HostJson;
    }
  | {
      state: "failed";
      sideEffect: "not_applied";
      error: RelayV2CommandStructuredError;
    }
  | { state: "in_doubt" };

export type RelayV2TerminalControlExecutionOutcome =
  | {
      state: "succeeded";
      result: RelayV2JsonObject;
    }
  | RelayV2ExecutionFailureOutcome;

type RelayV2FinalizedExecutionOutcome = RelayV2TerminalControlExecutionOutcome;

/**
 * Runtime adapters must resolve immutable targets without side effects, then
 * make exactly one call through the selected canonical authority. The command
 * plane deliberately has no git/tmux primitive and never retries executeTwRpc
 * or executeTerminalControl after RUNNING has been persisted.
 */
export interface RelayV2CanonicalCommandExecutor {
  resolve(request: RelayV2CanonicalCommandRequest): Promise<RelayV2CommandAdmission>;
  executeTwRpc(plan: RelayV2TwRpcExecutionPlan): Promise<RelayV2TwRpcExecutionOutcome>;
  executeTerminalControl(
    plan: RelayV2TerminalControlExecutionPlan,
  ): Promise<RelayV2TerminalControlExecutionOutcome>;
}

export interface RelayV2CommandDedupeWindow {
  windowId: string;
  windowSeq: string;
  acceptUntilMs: number;
  queryUntilMs: number;
}

export interface RelayV2HostCommandPlaneOptions {
  store: RelayV2HostStateStore;
  hostId: string;
  executor: RelayV2CanonicalCommandExecutor;
  /**
   * Required before create/kill capabilities can be enabled. When absent, a
   * resource side effect can only finalize IN_DOUBT, never a false success.
   */
  resourceMutationOwner?: RelayV2CommandResourceMutationOwner;
  now?: () => number;
  recover?: boolean;
}

interface NormalizedCommand {
  requestId: string;
  commandId: string;
  hostId: string;
  expectedHostEpoch: string;
  scopeId: string;
  sessionId: string | null;
  dedupeWindowId: string;
  operation: RelayV2CommandOperation;
  arguments: RelayV2JsonObject;
}

type StoredFingerprint = RelayV2CommandRequestFingerprint;

type StoredCommandState = "accepted" | "running" | "succeeded" | "failed" | "in_doubt";
type StoredFinalState = "succeeded" | "failed" | "in_doubt";

interface StoredCommandRecord {
  schemaVersion: typeof COMMAND_RECORD_SCHEMA_VERSION;
  recordType: "command";
  hostEpoch: string;
  principalId: string;
  acceptedClientInstanceId: string;
  hostId: string;
  commandId: string;
  fingerprint: StoredFingerprint;
  dedupeWindowId: string;
  operation: RelayV2CommandOperation;
  scopeId: string;
  sessionId: string | null;
  arguments: RelayV2JsonObject;
  executionPlan: RelayV2CanonicalExecutionPlan | null;
  authorityEvidence: RelayV2CommandAuthorityEvidence | null;
  state: StoredCommandState;
  acceptedAtMs: number;
  updatedAtMs: number;
  finalizedAtMs: number | null;
  resultUntilMs: number | null;
  dedupeUntilMs: number | null;
  result: RelayV2JsonObject | null;
  error: RelayV2CommandStructuredError | null;
}

interface StoredCommandTombstone {
  schemaVersion: typeof COMMAND_RECORD_SCHEMA_VERSION;
  recordType: "command_tombstone";
  hostEpoch: string;
  principalId: string;
  acceptedClientInstanceId: string;
  hostId: string;
  commandId: string;
  fingerprint: StoredFingerprint;
  dedupeWindowId: string;
  operation: RelayV2CommandOperation;
  scopeId: string;
  sessionId: string | null;
  finalState: StoredFinalState;
  updatedAtMs: number;
  dedupeUntilMs: number;
}

type StoredCommand = StoredCommandRecord | StoredCommandTombstone;

interface StoredDedupeWindow {
  schemaVersion: typeof COMMAND_RECORD_SCHEMA_VERSION;
  recordType: "dedupe_window";
  hostEpoch: string;
  windowId: string;
  windowSeq: string;
  acceptUntilMs: number;
  queryUntilMs: number;
}

interface CommandIdentity {
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
}

class AdmissionAbort extends Error {
  constructor(readonly value: AdmissionTransactionResult) {
    super("Relay v2 command admission did not create a record");
  }
}

class TransitionAbort extends Error {
  constructor(readonly record: StoredCommand) {
    super("Relay v2 command transition was already resolved");
  }
}

type AdmissionTransactionResult =
  | { kind: "epoch_mismatch"; actualHostEpoch: string }
  | { kind: "window_expired" }
  | { kind: "resource_rejected"; error: RelayV2CommandStructuredError }
  | { kind: "existing"; record: StoredCommand }
  | { kind: "inserted"; record: StoredCommandRecord };

export class RelayV2HostCommandPlaneStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayV2HostCommandPlaneStateError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isThenable(value: unknown): boolean {
  try {
    const thenable = ((typeof value === "object" && value !== null)
      || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function";
    if (thenable) void Promise.resolve(value).catch(() => undefined);
    return thenable;
  } catch {
    return true;
  }
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

function isCommandOperation(value: unknown): value is RelayV2CommandOperation {
  return value === "create_worktree"
    || value === "create_terminal"
    || value === "send_agent_message"
    || value === "kill_session";
}

function isCommandDisposition(value: unknown): value is RelayV2CommandDisposition {
  return value === "not_accepted"
    || value === "accepted"
    || value === "running"
    || value === "completed"
    || value === "in_doubt"
    || value === "not_applicable";
}

function isImmutableNotFoundCode(code: string): boolean {
  return code === "SCOPE_NOT_FOUND"
    || code === "PROJECT_NOT_FOUND"
    || code === "SESSION_NOT_FOUND"
    || code === "PANE_NOT_FOUND";
}

function targetRelationshipIsValid(
  operation: RelayV2CommandOperation,
  sessionId: string | null,
): boolean {
  const requiresSession = operation === "send_agent_message" || operation === "kill_session";
  return requiresSession === (sessionId !== null);
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isHostStateCommitUncertain(error: unknown): boolean {
  return error instanceof RelayV2HostStateCommitUncertainError
    || (isRecord(error)
      && error.code === "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN"
      && error.name === "RelayV2HostStateCommitUncertainError");
}

function isHostStateCapacityError(error: unknown): boolean {
  return isRecord(error)
    && error.code === "RELAY_V2_HOST_STATE_CAPACITY_EXCEEDED";
}

function assertJson(value: unknown, seen = new Set<object>()): asserts value is RelayV2HostJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Relay v2 command data contains a non-finite number");
    return;
  }
  if (typeof value !== "object") throw new TypeError("Relay v2 command data is not JSON");
  if (seen.has(value)) throw new TypeError("Relay v2 command data contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Relay v2 command data must use plain JSON objects");
    }
    for (const item of Object.values(value)) assertJson(item, seen);
  }
  seen.delete(value);
}

function cloneJson<T>(value: T): T {
  assertJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertWellFormedString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Relay v2 command fingerprint contains an unpaired surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Relay v2 command fingerprint contains an unpaired surrogate");
    }
  }
}

function canonicalJson(value: RelayV2HostJson): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot fingerprint a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertWellFormedString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => {
    assertWellFormedString(key);
    return `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`;
  }).join(",")}}`;
}

function sha256Canonical(value: RelayV2HostJson): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function storageKey(prefix: string, value: RelayV2HostJson): string {
  return `${prefix}${sha256Canonical(value)}`;
}

function commandStorageKey(identity: CommandIdentity): string {
  return storageKey(COMMAND_KEY_PREFIX, cloneJson(identity) as unknown as RelayV2HostJson);
}

function windowStorageKey(windowId: string): string {
  return storageKey(WINDOW_KEY_PREFIX, { windowId });
}

function authorityFor(operation: RelayV2CommandOperation): "tw_rpc" | "terminal_control" {
  return operation === "send_agent_message" ? "terminal_control" : "tw_rpc";
}

function commandDisposition(record: StoredCommand): RelayV2CommandDisposition {
  if (record.recordType === "command_tombstone") {
    return record.finalState === "in_doubt" ? "in_doubt" : "completed";
  }
  switch (record.state) {
    case "accepted": return "accepted";
    case "running": return "running";
    case "in_doubt": return "in_doubt";
    default: return "completed";
  }
}

function checkedFrame(frame: RelayV2JsonObject): RelayV2JsonObject {
  encodeRelayV2WebSocketFrame("public", frame);
  return frame;
}

function normalizeError(error: RelayV2CommandStructuredError): RelayV2CommandStructuredError {
  const normalized: RelayV2CommandStructuredError = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    commandDisposition: error.commandDisposition,
    details: error.details ?? null,
  };
  if (error.retryAfterMs !== undefined) normalized.retryAfterMs = error.retryAfterMs;
  assertJson(normalized);
  return cloneJson(normalized);
}

function errorFrame(
  request: NormalizedCommand | {
    requestId: string;
    hostId: string;
    expectedHostEpoch: string;
  },
  actualHostEpoch: string | null,
  error: RelayV2CommandStructuredError,
): RelayV2JsonObject {
  const frame: RelayV2JsonObject = {
    protocolVersion: 2,
    kind: "response",
    type: "error",
    requestId: request.requestId,
    hostId: request.hostId,
    payload: null,
    error: cloneJson(normalizeError(error)) as unknown as RelayV2HostJson,
  };
  if (actualHostEpoch !== null) frame.hostEpoch = actualHostEpoch;
  if ("commandId" in request) {
    frame.commandId = request.commandId;
    frame.scopeId = request.scopeId;
    if (request.sessionId !== null) frame.sessionId = request.sessionId;
  }
  return checkedFrame(frame);
}

function epochMismatchFrame(
  request: NormalizedCommand | {
    requestId: string;
    hostId: string;
    expectedHostEpoch: string;
  },
  actualHostEpoch: string,
): RelayV2JsonObject {
  return errorFrame(request, actualHostEpoch, {
    code: "HOST_EPOCH_MISMATCH",
    message: "Expected host authority does not match current host authority",
    retryable: false,
    commandDisposition: "not_accepted",
    details: {
      expectedHostEpoch: request.expectedHostEpoch,
      actualHostEpoch,
    },
  });
}

function commandWindowExpiredFrame(
  request: NormalizedCommand,
  actualHostEpoch: string,
): RelayV2JsonObject {
  return errorFrame(request, actualHostEpoch, {
    code: "COMMAND_WINDOW_EXPIRED",
    message: "Command dedupe window no longer accepts new commands",
    retryable: false,
    commandDisposition: "not_accepted",
    details: { reissueRequired: true },
  });
}

function parseExecuteFrame(frame: RelayV2JsonObject): NormalizedCommand {
  encodeRelayV2WebSocketFrame("public", frame);
  if (frame.type !== "command.execute") throw new TypeError("expected Relay v2 command.execute");
  const payload = frame.payload as RelayV2JsonObject;
  const operation = payload.operation as RelayV2CommandOperation;
  const rawArguments = cloneJson(payload.arguments as RelayV2JsonObject);
  if (operation === "send_agent_message") {
    rawArguments.message = (rawArguments.message as string).replace(/\r\n?/g, "\n");
  }
  return {
    requestId: frame.requestId as string,
    commandId: frame.commandId as string,
    hostId: frame.hostId as string,
    expectedHostEpoch: frame.expectedHostEpoch as string,
    scopeId: frame.scopeId as string,
    sessionId: (frame.sessionId as string | undefined) ?? null,
    dedupeWindowId: payload.dedupeWindowId as string,
    operation,
    arguments: rawArguments,
  };
}

function parseQueryFrame(frame: RelayV2JsonObject): {
  requestId: string;
  hostId: string;
  expectedHostEpoch: string;
  items: Array<{ commandId: string; dedupeWindowId: string }>;
} {
  encodeRelayV2WebSocketFrame("public", frame);
  if (frame.type !== "command.query") throw new TypeError("expected Relay v2 command.query");
  const payload = frame.payload as RelayV2JsonObject;
  return {
    requestId: frame.requestId as string,
    hostId: frame.hostId as string,
    expectedHostEpoch: frame.expectedHostEpoch as string,
    items: cloneJson(payload.items) as Array<{ commandId: string; dedupeWindowId: string }>,
  };
}

function fingerprintFor(input: {
  operation: RelayV2CommandOperation;
  dedupeWindowId: string;
  hostEpoch: string;
  hostId: string;
  scopeId: string;
  sessionId: string | null;
  arguments: RelayV2JsonObject;
}): StoredFingerprint {
  const canonical: Record<string, RelayV2HostJson> = {
    schemaVersion: RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION,
    operation: input.operation,
    dedupeWindowId: input.dedupeWindowId,
    hostEpoch: input.hostEpoch,
    hostId: input.hostId,
    scopeId: input.scopeId,
  };
  if (input.sessionId !== null) canonical.sessionId = input.sessionId;
  canonical.arguments = cloneJson(input.arguments) as unknown as RelayV2HostJson;
  return {
    schemaVersion: RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION,
    algorithm: "sha256-rfc8785",
    digest: sha256Canonical(canonical),
  };
}

function commandFingerprint(command: NormalizedCommand): StoredFingerprint {
  return fingerprintFor({
    operation: command.operation,
    dedupeWindowId: command.dedupeWindowId,
    hostEpoch: command.expectedHostEpoch,
    hostId: command.hostId,
    scopeId: command.scopeId,
    sessionId: command.sessionId,
    arguments: command.arguments,
  });
}

function parseFingerprint(value: unknown): StoredFingerprint {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "algorithm", "digest"])
    || value.schemaVersion !== RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION
    || value.algorithm !== "sha256-rfc8785"
    || typeof value.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.digest)) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command fingerprint record is malformed");
  }
  return value as unknown as StoredFingerprint;
}

function parseResourceReservationBinding(
  value: unknown,
): RelayV2CommandResourceReservationBinding {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "owner", "reservationId"])
    || value.schemaVersion !== RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION
    || value.owner !== "relay_v2_resource_state"
    || typeof value.reservationId !== "string"
    || value.reservationId.length === 0
    || Buffer.byteLength(value.reservationId, "utf8") > 128) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 resource reservation binding is malformed");
  }
  return cloneJson(value) as unknown as RelayV2CommandResourceReservationBinding;
}

function parseStoredError(value: unknown): RelayV2CommandStructuredError {
  if (!isRecord(value)
    || !hasExactKeys(
      value,
      ["code", "message", "retryable", "commandDisposition", "details"],
      ["retryAfterMs"],
    )
    || typeof value.code !== "string"
    || value.code.length === 0
    || typeof value.message !== "string"
    || typeof value.retryable !== "boolean"
    || !isCommandDisposition(value.commandDisposition)
    || (Object.hasOwn(value, "retryAfterMs")
      && value.retryAfterMs !== null
      && !isSafeTime(value.retryAfterMs))) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command error record is malformed");
  }
  assertJson(value.details);
  return cloneJson(value) as unknown as RelayV2CommandStructuredError;
}

function validateStoredRequestSemantics(value: {
  commandId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string | null;
  dedupeWindowId: string;
  operation: RelayV2CommandOperation;
  arguments: RelayV2JsonObject;
}): void {
  const frame: RelayV2JsonObject = {
    protocolVersion: 2,
    kind: "request",
    type: "command.execute",
    requestId: "stored-command-validation",
    commandId: value.commandId,
    hostId: value.hostId,
    expectedHostEpoch: value.hostEpoch,
    scopeId: value.scopeId,
    payload: {
      dedupeWindowId: value.dedupeWindowId,
      operation: value.operation,
      arguments: cloneJson(value.arguments),
    },
  };
  if (value.sessionId !== null) frame.sessionId = value.sessionId;
  try {
    encodeRelayV2WebSocketFrame("public", frame);
  } catch {
    throw new RelayV2HostCommandPlaneStateError(
      "Relay v2 stored command arguments or target relationship are malformed",
    );
  }
}

function validateStoredFinalSemantics(
  record: StoredCommandRecord,
): void {
  if (record.state !== "succeeded" && record.state !== "failed" && record.state !== "in_doubt") {
    return;
  }
  try {
    if (record.state === "succeeded") {
      validateResultForRecord(record, record.result!);
    } else if (record.state === "failed") {
      if (record.error!.retryable
        || record.error!.commandDisposition !== "completed"
        || record.error!.code === "COMMAND_IN_DOUBT") {
        throw new Error("invalid failed disposition");
      }
    } else if (canonicalJson(normalizeError(record.error!) as unknown as RelayV2HostJson)
      !== canonicalJson(inDoubtError() as unknown as RelayV2HostJson)) {
      throw new Error("invalid in-doubt error");
    }
    const probe: RelayV2JsonObject = {
      protocolVersion: 2,
      kind: "event",
      type: "command.result",
      commandId: record.commandId,
      hostId: record.hostId,
      hostEpoch: record.hostEpoch,
      scopeId: record.scopeId,
      payload: {
        dedupeWindowId: record.dedupeWindowId,
        state: record.state,
        updatedAtMs: record.updatedAtMs,
        result: record.result === null ? null : cloneJson(record.result),
      },
      error: record.error === null
        ? null
        : cloneJson(normalizeError(record.error)) as unknown as RelayV2HostJson,
    };
    if (record.sessionId !== null) probe.sessionId = record.sessionId;
    checkedFrame(probe);
  } catch {
    throw new RelayV2HostCommandPlaneStateError(
      "Relay v2 stored command result or error semantics are malformed",
    );
  }
}

function parseAuthorityEvidence(
  value: unknown,
  expected: {
    operation: RelayV2CommandOperation;
    hostId: string;
    hostEpoch: string;
    scopeId: string;
    sessionId: string | null;
  },
): RelayV2CommandAuthorityEvidence {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "coverage",
      "authority",
      "hostId",
      "hostEpoch",
      "scopeId",
      "sessionId",
      "evidence",
    ])
    || value.schemaVersion !== RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION
    || (value.coverage !== "complete"
      && value.coverage !== "partial"
      && value.coverage !== "unreachable")
    || (value.authority !== "tw_rpc" && value.authority !== "terminal_control")
    || value.authority !== authorityFor(expected.operation)
    || value.hostId !== expected.hostId
    || value.hostEpoch !== expected.hostEpoch
    || value.scopeId !== expected.scopeId
    || value.sessionId !== expected.sessionId) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command authority evidence is malformed");
  }
  assertJson(value.evidence);
  return cloneJson(value) as unknown as RelayV2CommandAuthorityEvidence;
}

function parseExecutionPlan(
  value: unknown,
  expected: {
    operation: RelayV2CommandOperation;
    principalId: string;
    hostId: string;
    hostEpoch: string;
    scopeId: string;
    sessionId: string | null;
    arguments: RelayV2JsonObject;
  },
): RelayV2CanonicalExecutionPlan {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "authority",
      "operation",
      "principalId",
      "hostId",
      "hostEpoch",
      "scopeId",
      "sessionId",
      "arguments",
      "adapterState",
      "resourceReservation",
    ])
    || value.schemaVersion !== RELAY_V2_COMMAND_PLAN_SCHEMA_VERSION
    || !isCommandOperation(value.operation)
    || (value.authority !== "tw_rpc" && value.authority !== "terminal_control")
    || value.authority !== authorityFor(value.operation)
    || value.operation !== expected.operation
    || value.principalId !== expected.principalId
    || value.hostId !== expected.hostId
    || value.hostEpoch !== expected.hostEpoch
    || value.scopeId !== expected.scopeId
    || value.sessionId !== expected.sessionId
    || !isRecord(value.arguments)
    || ((value.operation === "create_worktree" || value.operation === "create_terminal")
      ? value.resourceReservation === null
      : value.resourceReservation !== null)) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command execution plan is malformed");
  }
  assertJson(value.arguments);
  assertJson(value.adapterState);
  if (value.resourceReservation !== null) {
    parseResourceReservationBinding(value.resourceReservation);
  }
  if (canonicalJson(value.arguments as RelayV2HostJson)
    !== canonicalJson(expected.arguments as unknown as RelayV2HostJson)) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command execution plan arguments do not match ledger");
  }
  return cloneJson(value) as unknown as RelayV2CanonicalExecutionPlan;
}

function parseStoredCommand(value: RelayV2HostJson): StoredCommand {
  if (!isRecord(value) || value.schemaVersion !== COMMAND_RECORD_SCHEMA_VERSION) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command ledger record is malformed");
  }
  if (value.recordType === "command_tombstone") {
    if (!hasExactKeys(value, [
      "schemaVersion",
      "recordType",
      "hostEpoch",
      "principalId",
      "acceptedClientInstanceId",
      "hostId",
      "commandId",
      "fingerprint",
      "dedupeWindowId",
      "operation",
      "scopeId",
      "sessionId",
      "finalState",
      "updatedAtMs",
      "dedupeUntilMs",
    ])
      || typeof value.hostEpoch !== "string"
      || typeof value.principalId !== "string"
      || value.principalId.length === 0
      || typeof value.acceptedClientInstanceId !== "string"
      || value.acceptedClientInstanceId.length === 0
      || typeof value.hostId !== "string"
      || typeof value.commandId !== "string"
      || typeof value.dedupeWindowId !== "string"
      || !isCommandOperation(value.operation)
      || typeof value.scopeId !== "string"
      || (value.sessionId !== null && typeof value.sessionId !== "string")
      || !targetRelationshipIsValid(value.operation, value.sessionId as string | null)
      || !(value.finalState === "succeeded"
        || value.finalState === "failed"
        || value.finalState === "in_doubt")
      || !isSafeTime(value.updatedAtMs)
      || !isSafeTime(value.dedupeUntilMs)) {
      throw new RelayV2HostCommandPlaneStateError("Relay v2 command tombstone is malformed");
    }
    parseFingerprint(value.fingerprint);
    return cloneJson(value) as unknown as StoredCommandTombstone;
  }
  if (value.recordType !== "command"
    || !hasExactKeys(value, [
      "schemaVersion",
      "recordType",
      "hostEpoch",
      "principalId",
      "acceptedClientInstanceId",
      "hostId",
      "commandId",
      "fingerprint",
      "dedupeWindowId",
      "operation",
      "scopeId",
      "sessionId",
      "arguments",
      "executionPlan",
      "authorityEvidence",
      "state",
      "acceptedAtMs",
      "updatedAtMs",
      "finalizedAtMs",
      "resultUntilMs",
      "dedupeUntilMs",
      "result",
      "error",
    ])
    || typeof value.hostEpoch !== "string"
    || typeof value.principalId !== "string"
    || value.principalId.length === 0
    || typeof value.acceptedClientInstanceId !== "string"
    || value.acceptedClientInstanceId.length === 0
    || typeof value.hostId !== "string"
    || typeof value.commandId !== "string"
    || typeof value.dedupeWindowId !== "string"
    || !isCommandOperation(value.operation)
    || typeof value.scopeId !== "string"
    || (value.sessionId !== null && typeof value.sessionId !== "string")
    || !(value.state === "accepted"
      || value.state === "running"
      || value.state === "succeeded"
      || value.state === "failed"
      || value.state === "in_doubt")
    || !isSafeTime(value.acceptedAtMs)
    || !isSafeTime(value.updatedAtMs)
    || value.updatedAtMs < value.acceptedAtMs
    || !isRecord(value.arguments)
    || (value.executionPlan !== null && !isRecord(value.executionPlan))
    || (value.authorityEvidence !== null && !isRecord(value.authorityEvidence))) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command state record is malformed");
  }
  const fingerprint = parseFingerprint(value.fingerprint);
  assertJson(value.arguments);
  validateStoredRequestSemantics({
    commandId: value.commandId,
    hostId: value.hostId,
    hostEpoch: value.hostEpoch,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
    dedupeWindowId: value.dedupeWindowId,
    operation: value.operation,
    arguments: value.arguments as RelayV2JsonObject,
  });
  const expectedFingerprint = fingerprintFor({
    operation: value.operation,
    dedupeWindowId: value.dedupeWindowId,
    hostEpoch: value.hostEpoch,
    hostId: value.hostId,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
    arguments: value.arguments as RelayV2JsonObject,
  });
  if (!fingerprintsEqual(fingerprint, expectedFingerprint)) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command fingerprint does not match ledger");
  }
  const expected = {
    operation: value.operation,
    principalId: value.principalId,
    hostId: value.hostId,
    hostEpoch: value.hostEpoch,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
    arguments: value.arguments as RelayV2JsonObject,
  };
  const executionPlan = value.executionPlan === null
    ? null
    : parseExecutionPlan(value.executionPlan, expected);
  const authorityEvidence = value.authorityEvidence === null
    ? null
    : parseAuthorityEvidence(value.authorityEvidence, expected);
  const final = value.state === "succeeded" || value.state === "failed" || value.state === "in_doubt";
  const finalTimesValid = final
    ? isSafeTime(value.finalizedAtMs)
      && isSafeTime(value.resultUntilMs)
      && isSafeTime(value.dedupeUntilMs)
    : value.finalizedAtMs === null
      && value.resultUntilMs === null
      && value.dedupeUntilMs === null;
  if (!finalTimesValid) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command retention fields are malformed");
  }
  if ((!final && executionPlan === null)
    || (final && executionPlan !== null)
    || (!final && authorityEvidence !== null)
    || (value.state === "succeeded" && (!isRecord(value.result) || value.error !== null))
    || (value.state === "failed" && (value.result !== null || value.error === null))
    || (value.state === "in_doubt" && (value.result !== null || value.error === null))
    || (!final && (value.result !== null || value.error !== null))) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command result fields are malformed");
  }
  if (value.result !== null) assertJson(value.result);
  const error = value.error === null ? null : parseStoredError(value.error);
  const immutableFailure = error !== null && isImmutableNotFoundCode(error.code);
  if ((immutableFailure && authorityEvidence?.coverage !== "complete")
    || (!immutableFailure && authorityEvidence !== null)) {
    throw new RelayV2HostCommandPlaneStateError(
      "Relay v2 immutable command failure lacks complete authority evidence",
    );
  }
  const record = {
    ...cloneJson(value),
    executionPlan,
    authorityEvidence,
    error,
  } as unknown as StoredCommandRecord;
  validateStoredFinalSemantics(record);
  return record;
}

function parseWindow(value: RelayV2HostJson): StoredDedupeWindow {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "recordType",
      "hostEpoch",
      "windowId",
      "windowSeq",
      "acceptUntilMs",
      "queryUntilMs",
    ])
    || value.schemaVersion !== COMMAND_RECORD_SCHEMA_VERSION
    || value.recordType !== "dedupe_window"
    || typeof value.hostEpoch !== "string"
    || typeof value.windowId !== "string"
    || typeof value.windowSeq !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(value.windowSeq)
    || !isSafeTime(value.acceptUntilMs)
    || !isSafeTime(value.queryUntilMs)) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command dedupe window is malformed");
  }
  return value as unknown as StoredDedupeWindow;
}

function verifyStoredIdentity(record: StoredCommand, identity: CommandIdentity): void {
  if (record.hostEpoch !== identity.hostEpoch
    || record.principalId !== identity.principalId
    || record.hostId !== identity.hostId
    || record.commandId !== identity.commandId) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 command ledger key collision or corruption");
  }
}

function readCommand(
  source: Pick<RelayV2HostStateSnapshot, "commands"> | RelayV2HostStateTransaction,
  identity: CommandIdentity,
): StoredCommand | undefined {
  const key = commandStorageKey(identity);
  const value = "commands" in source
    ? source.commands[key]
    : source.getCommandRecord(key);
  if (value === undefined) return undefined;
  const record = parseStoredCommand(value);
  verifyStoredIdentity(record, identity);
  return record;
}

export interface RelayV2CommandReservationLedgerIdentity {
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
}

/**
 * Narrow read-only H1 ledger interpretation used by H2 while holding the same
 * H0 transaction that proves an uncertain create side effect absent. H2 never
 * receives arbitrary command-ledger mutation access.
 */
export function relayV2CommandReservationLedgerState(
  source: Pick<RelayV2HostStateTransaction, "getCommandRecord">,
  candidate: RelayV2CommandReservationLedgerIdentity,
): "in_doubt" | "other" | "missing" {
  const identity: CommandIdentity = {
    hostEpoch: candidate.hostEpoch,
    principalId: candidate.principalId,
    hostId: candidate.hostId,
    commandId: candidate.commandId,
  };
  const value = source.getCommandRecord(commandStorageKey(identity));
  if (value === undefined) return "missing";
  const record = parseStoredCommand(value);
  verifyStoredIdentity(record, identity);
  if (!fingerprintsEqual(record.fingerprint, candidate.requestFingerprint)) return "other";
  if (record.operation !== "create_worktree" && record.operation !== "create_terminal") {
    return "other";
  }
  if (record.recordType === "command_tombstone") {
    return record.finalState === "in_doubt" ? "in_doubt" : "other";
  }
  return record.state === "in_doubt" ? "in_doubt" : "other";
}

function readWindow(
  source: Pick<RelayV2HostStateSnapshot, "materialized"> | RelayV2HostStateTransaction,
  hostEpoch: string,
  windowId: string,
): StoredDedupeWindow | undefined {
  const key = windowStorageKey(windowId);
  const value = "materialized" in source
    ? source.materialized[key]
    : source.getMaterializedRecord(key);
  if (value === undefined) return undefined;
  const window = parseWindow(value);
  if (window.hostEpoch !== hostEpoch || window.windowId !== windowId) {
    throw new RelayV2HostCommandPlaneStateError("Relay v2 dedupe window key collision or corruption");
  }
  return window;
}

function fingerprintsEqual(left: StoredFingerprint, right: StoredFingerprint): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.algorithm === right.algorithm
    && left.digest === right.digest;
}

function planFor(
  auth: RelayV2CommandAuthContext,
  command: NormalizedCommand,
  adapterState: RelayV2HostJson,
  resourceReservation: RelayV2CommandResourceReservationBinding | null,
): RelayV2CanonicalExecutionPlan {
  const base = {
    schemaVersion: RELAY_V2_COMMAND_PLAN_SCHEMA_VERSION,
    operation: command.operation,
    principalId: auth.principalId,
    hostId: command.hostId,
    hostEpoch: command.expectedHostEpoch,
    scopeId: command.scopeId,
    sessionId: command.sessionId,
    arguments: cloneJson(command.arguments),
    adapterState: cloneJson(adapterState),
    resourceReservation: resourceReservation === null ? null : cloneJson(resourceReservation),
  };
  if (command.operation === "send_agent_message") {
    return { ...base, authority: "terminal_control", operation: command.operation };
  }
  return { ...base, authority: "tw_rpc", operation: command.operation };
}

function createAcceptedRecord(
  auth: RelayV2CommandAuthContext,
  command: NormalizedCommand,
  fingerprint: StoredFingerprint,
  executionPlan: RelayV2CanonicalExecutionPlan,
  now: number,
): StoredCommandRecord {
  return {
    schemaVersion: COMMAND_RECORD_SCHEMA_VERSION,
    recordType: "command",
    hostEpoch: command.expectedHostEpoch,
    principalId: auth.principalId,
    acceptedClientInstanceId: auth.clientInstanceId,
    hostId: command.hostId,
    commandId: command.commandId,
    fingerprint,
    dedupeWindowId: command.dedupeWindowId,
    operation: command.operation,
    scopeId: command.scopeId,
    sessionId: command.sessionId,
    arguments: cloneJson(command.arguments),
    executionPlan,
    authorityEvidence: null,
    state: "accepted",
    acceptedAtMs: now,
    updatedAtMs: now,
    finalizedAtMs: null,
    resultUntilMs: null,
    dedupeUntilMs: null,
    result: null,
    error: null,
  };
}

function retentionUntil(now: number, window: StoredDedupeWindow | undefined): number {
  return Math.max(now + RELAY_V2_COMMAND_DEDUPE_RETENTION_MS, window?.queryUntilMs ?? 0);
}

function createFinalFailureRecord(
  auth: RelayV2CommandAuthContext,
  command: NormalizedCommand,
  fingerprint: StoredFingerprint,
  error: RelayV2CommandStructuredError,
  authorityEvidence: RelayV2CommandAuthorityEvidence,
  window: StoredDedupeWindow,
  now: number,
): StoredCommandRecord {
  return {
    ...createAcceptedRecord(
      auth,
      command,
      fingerprint,
      planFor(auth, command, null, null),
      now,
    ),
    executionPlan: null,
    authorityEvidence: cloneJson(authorityEvidence),
    state: "failed",
    finalizedAtMs: now,
    resultUntilMs: now + RELAY_V2_COMMAND_RESULT_RETENTION_MS,
    dedupeUntilMs: retentionUntil(now, window),
    error: normalizeError(error),
  };
}

function inDoubtError(): RelayV2CommandStructuredError {
  return {
    code: "COMMAND_IN_DOUBT",
    message: "Command outcome is uncertain",
    retryable: false,
    commandDisposition: "in_doubt",
    details: null,
  };
}

function statusFrame(
  request: NormalizedCommand,
  hostEpoch: string,
  record: StoredCommandRecord,
  deduplicated: boolean,
): RelayV2JsonObject {
  const frame: RelayV2JsonObject = {
    protocolVersion: 2,
    kind: "response",
    type: "command.status",
    requestId: request.requestId,
    commandId: request.commandId,
    hostId: request.hostId,
    hostEpoch,
    scopeId: request.scopeId,
    payload: {
      dedupeWindowId: record.dedupeWindowId,
      state: record.state,
      deduplicated,
      updatedAtMs: record.updatedAtMs,
      dedupeUntilMs: record.dedupeUntilMs,
      result: record.result === null ? null : cloneJson(record.result),
    },
    error: record.error === null ? null : cloneJson(normalizeError(record.error)) as unknown as RelayV2HostJson,
  };
  if (request.sessionId !== null) frame.sessionId = request.sessionId;
  return checkedFrame(frame);
}

function tombstoneFrame(
  request: NormalizedCommand,
  hostEpoch: string,
  record: StoredCommandTombstone,
): RelayV2JsonObject {
  return errorFrame(request, hostEpoch, {
    code: "COMMAND_RESULT_EXPIRED",
    message: "Command result expired",
    retryable: false,
    commandDisposition: record.finalState === "in_doubt" ? "in_doubt" : "completed",
    details: { finalState: record.finalState },
  });
}

function validateAdmissionEvidence(
  request: RelayV2CanonicalCommandRequest,
  evidence: RelayV2CommandAuthorityEvidence,
): RelayV2CommandAuthorityEvidence {
  return parseAuthorityEvidence(evidence as unknown, request);
}

function validateImmutableFailure(
  request: RelayV2CanonicalCommandRequest,
  error: RelayV2CommandStructuredError,
  evidence: RelayV2CommandAuthorityEvidence,
): {
  error: RelayV2CommandStructuredError;
  authorityEvidence: RelayV2CommandAuthorityEvidence;
} {
  if (!isImmutableNotFoundCode(error.code)
    || error.retryable
    || error.commandDisposition !== "completed") {
    throw new TypeError("canonical executor returned an invalid immutable command failure");
  }
  const authorityEvidence = validateAdmissionEvidence(request, evidence);
  if (authorityEvidence.coverage !== "complete") {
    throw new TypeError("immutable command failure requires complete authority evidence");
  }
  return { error: normalizeError(error), authorityEvidence };
}

function validateTransientFailure(
  request: RelayV2CanonicalCommandRequest,
  error: RelayV2CommandStructuredError,
  evidence?: RelayV2CommandAuthorityEvidence,
): RelayV2CommandStructuredError {
  if (error.commandDisposition !== "not_accepted") {
    throw new TypeError("canonical executor returned an accepted transient admission failure");
  }
  let coverage: RelayV2CommandAuthorityEvidence["coverage"] | undefined;
  if (evidence !== undefined) {
    const parsed = validateAdmissionEvidence(request, evidence);
    coverage = parsed.coverage;
    if (parsed.coverage === "complete" && isImmutableNotFoundCode(error.code)) {
      throw new TypeError("complete immutable authority evidence must not be returned as transient");
    }
  }
  if (isImmutableNotFoundCode(error.code) && coverage !== "complete") {
    return normalizeError({
      code: "SCOPE_UNREACHABLE",
      message: "Canonical target authority is incomplete or unreachable",
      retryable: true,
      commandDisposition: "not_accepted",
      details: null,
    });
  }
  if (!error.retryable) {
    throw new TypeError("transient admission failures must remain retryable");
  }
  return normalizeError(error);
}

function isResourceMutation(
  operation: RelayV2CommandOperation,
): operation is "create_worktree" | "create_terminal" | "kill_session" {
  return operation !== "send_agent_message";
}

function resourceTransactionFacade(
  transaction: RelayV2HostStateTransaction,
): RelayV2CommandResourceTransaction {
  return Object.freeze({
    getMaterializedRecord: (key: string) => transaction.getMaterializedRecord(key),
    putMaterializedRecord: (key: string, value: RelayV2HostJson) => {
      transaction.putMaterializedRecord(key, value);
    },
    deleteMaterializedRecord: (key: string) => transaction.deleteMaterializedRecord(key),
    getRevision: (revisionKey: string) => transaction.getRevision(revisionKey),
    allocateRevision: (revisionKey: string) => transaction.allocateRevision(revisionKey),
    allocateEventSeq: () => transaction.allocateEventSeq(),
    issueOpaqueId: (prefix?: string) => transaction.issueOpaqueId(prefix),
    getMaterializedReadinessFence: () => transaction.getMaterializedReadinessFence(),
    latchMaterializedReadinessFence: (reason) => (
      transaction.latchMaterializedReadinessFence(reason)
    ),
  });
}

function assertNoCanonicalSessionId(value: RelayV2HostJson): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCanonicalSessionId(item);
    return;
  }
  if (!isRecord(value)) return;
  if (Object.hasOwn(value, "sessionId")) {
    throw new TypeError("canonical executor must not allocate or return an opaque Session identity");
  }
  for (const item of Object.values(value)) assertNoCanonicalSessionId(item as RelayV2HostJson);
}

function parseCanonicalBackendOutcome(
  value: unknown,
  operation: RelayV2CommandOperation,
): RelayV2CanonicalBackendOutcome {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "backendInstanceKey", "evidence"])
    || value.schemaVersion !== RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION
    || typeof value.backendInstanceKey !== "string"
    || value.backendInstanceKey.length === 0
    || value.backendInstanceKey.trim() !== value.backendInstanceKey
    || value.backendInstanceKey.includes("\0")
    || Buffer.byteLength(value.backendInstanceKey, "utf8") > 4_096) {
    throw new TypeError("canonical executor returned an invalid backend outcome");
  }
  assertJson(value.evidence);
  if (operation === "create_worktree" || operation === "create_terminal") {
    assertNoCanonicalSessionId(value.evidence as RelayV2HostJson);
  }
  return cloneJson(value) as unknown as RelayV2CanonicalBackendOutcome;
}

function parseResourceCommitIntent(
  value: unknown,
  record: StoredCommandRecord,
): RelayV2CommandResourceCommitIntent {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "owner",
      "operation",
      "principalId",
      "hostId",
      "hostEpoch",
      "commandId",
      "requestFingerprint",
      "scopeId",
      "sessionId",
      "reservationBinding",
      "backendOutcome",
      "commitIntent",
    ])
    || value.schemaVersion !== RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION
    || value.owner !== "relay_v2_resource_state"
    || !isCommandOperation(value.operation)
    || !isResourceMutation(value.operation)
    || value.operation !== record.operation
    || value.principalId !== record.principalId
    || value.hostId !== record.hostId
    || value.hostEpoch !== record.hostEpoch
    || value.commandId !== record.commandId
    || value.scopeId !== record.scopeId
    || value.sessionId !== record.sessionId
    || ((record.operation === "create_worktree" || record.operation === "create_terminal")
      ? value.reservationBinding === null
      : value.reservationBinding !== null)) {
    throw new TypeError("H1 formed an invalid Relay v2 resource commit intent");
  }
  const requestFingerprint = parseFingerprint(value.requestFingerprint);
  if (!fingerprintsEqual(requestFingerprint, record.fingerprint)) {
    throw new TypeError("H1 resource commit fingerprint changed after admission");
  }
  if (value.reservationBinding !== null) {
    const binding = parseResourceReservationBinding(value.reservationBinding);
    if (record.executionPlan === null
      || canonicalJson(binding as unknown as RelayV2HostJson)
        !== canonicalJson(record.executionPlan.resourceReservation as unknown as RelayV2HostJson)) {
      throw new TypeError("H1 resource commit reservation changed after admission");
    }
  }
  const backendOutcome = parseCanonicalBackendOutcome(value.backendOutcome, record.operation);
  assertJson(value.commitIntent);
  if (record.operation === "create_worktree" || record.operation === "create_terminal") {
    assertNoCanonicalSessionId(value.commitIntent as RelayV2HostJson);
  }
  return {
    ...cloneJson(value),
    backendOutcome,
  } as unknown as RelayV2CommandResourceCommitIntent;
}

function parseResourceCommitEvidence(
  value: unknown,
  record: StoredCommandRecord,
): RelayV2CommandResourceCommitEvidence {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "owner",
      "operation",
      "principalId",
      "hostId",
      "hostEpoch",
      "scopeId",
      "sessionId",
      "result",
      "events",
      "evidence",
    ])
    || value.schemaVersion !== RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION
    || value.owner !== "relay_v2_resource_state"
    || !isCommandOperation(value.operation)
    || !isResourceMutation(value.operation)
    || value.operation !== record.operation
    || value.principalId !== record.principalId
    || value.hostId !== record.hostId
    || value.hostEpoch !== record.hostEpoch
    || value.scopeId !== record.scopeId
    || typeof value.sessionId !== "string"
    || value.sessionId.length === 0
    || (record.operation === "kill_session" && value.sessionId !== record.sessionId)
    || !isRecord(value.result)
    || !Array.isArray(value.events)) {
    throw new TypeError("H2 returned invalid Relay v2 resource commit evidence");
  }
  assertJson(value.evidence);
  for (const event of value.events) checkedFrame(event);
  validateResultForRecord(record, value.result as RelayV2JsonObject);
  if ((record.operation === "create_worktree" || record.operation === "create_terminal")
    && (value.result as RelayV2JsonObject).session
    && ((value.result as RelayV2JsonObject).session as RelayV2JsonObject).sessionId !== value.sessionId) {
    throw new TypeError("H2 Session result does not match its allocated opaque identity");
  }
  return cloneJson(value) as unknown as RelayV2CommandResourceCommitEvidence;
}

interface PreparedExecutionOutcome {
  outcome: RelayV2FinalizedExecutionOutcome | null;
  resourceCommitIntent: RelayV2CommandResourceCommitIntent | null;
  resourceSettlementIntent: RelayV2CommandResourceSettlementIntent | null;
}

function resourceSettlementIntentFor(
  record: StoredCommand,
  disposition: RelayV2CommandResourceSettlementIntent["disposition"],
  backendOutcome: RelayV2CanonicalBackendOutcome | null,
): RelayV2CommandResourceSettlementIntent | null {
  if (record.operation !== "create_worktree" && record.operation !== "create_terminal") {
    return null;
  }
  return {
    schemaVersion: RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
    owner: "relay_v2_resource_state",
    operation: record.operation,
    principalId: record.principalId,
    hostId: record.hostId,
    hostEpoch: record.hostEpoch,
    commandId: record.commandId,
    requestFingerprint: cloneJson(record.fingerprint),
    scopeId: record.scopeId,
    reservationBinding: record.recordType === "command"
      ? record.executionPlan?.resourceReservation ?? null
      : null,
    disposition,
    backendOutcome: backendOutcome === null ? null : cloneJson(backendOutcome),
  };
}

function validateResultForRecord(
  record: StoredCommandRecord,
  result: RelayV2JsonObject,
): void {
  if (record.operation === "create_worktree" || record.operation === "create_terminal") {
    if (!isRecord(result) || !isRecord(result.session)) {
      throw new TypeError("H2 returned an invalid Session result");
    }
    if (result.session.scopeId !== record.scopeId
      || result.session.kind !== (record.operation === "create_worktree" ? "worktree" : "terminal")) {
      throw new TypeError("H2 returned a Session for another target");
    }
    return;
  }
  if (record.operation === "send_agent_message") {
    const args = record.arguments;
    if (result.pane !== args.pane
      || result.submit !== args.submit
      || result.messageUtf8Bytes !== Buffer.byteLength(args.message as string, "utf8")) {
      throw new TypeError("terminal-control executor returned a mismatched input result");
    }
    return;
  }
  if (result.sessionId !== record.sessionId || result.terminated !== true) {
    throw new TypeError("H2 returned a mismatched Session result");
  }
}

function validateFailureOutcome(
  record: StoredCommandRecord,
  outcome: RelayV2ExecutionFailureOutcome,
): RelayV2ExecutionFailureOutcome {
  if (outcome.state === "in_doubt") return outcome;
  const error = normalizeError(outcome.error);
  if (error.retryable || error.commandDisposition !== "completed") {
    throw new TypeError("canonical executor returned a retryable final failure");
  }
  if (isImmutableNotFoundCode(error.code)) {
    throw new TypeError("post-side-effect NOT_FOUND lacks resolver complete-authority evidence");
  }
  const probe: RelayV2JsonObject = {
    protocolVersion: 2,
    kind: "event",
    type: "command.result",
    commandId: record.commandId,
    hostId: record.hostId,
    hostEpoch: record.hostEpoch,
    scopeId: record.scopeId,
    payload: {
      dedupeWindowId: record.dedupeWindowId,
      state: "failed",
      updatedAtMs: record.updatedAtMs,
      result: null,
    },
    error: cloneJson(error) as unknown as RelayV2HostJson,
  };
  if (record.sessionId !== null) probe.sessionId = record.sessionId;
  checkedFrame(probe);
  return { state: "failed", error };
}

function validateSucceededResult(
  record: StoredCommandRecord,
  rawResult: RelayV2JsonObject,
): RelayV2FinalizedExecutionOutcome {
  const result = cloneJson(rawResult);
  validateResultForRecord(record, result);
  const probe: RelayV2JsonObject = {
    protocolVersion: 2,
    kind: "event",
    type: "command.result",
    commandId: record.commandId,
    hostId: record.hostId,
    hostEpoch: record.hostEpoch,
    scopeId: record.scopeId,
    payload: {
      dedupeWindowId: record.dedupeWindowId,
      state: "succeeded",
      updatedAtMs: record.updatedAtMs,
      result,
    },
    error: null,
  };
  if (record.sessionId !== null) probe.sessionId = record.sessionId;
  checkedFrame(probe);
  return { state: "succeeded", result };
}

function validateTerminalOutcome(
  record: StoredCommandRecord,
  outcome: RelayV2TerminalControlExecutionOutcome,
): RelayV2FinalizedExecutionOutcome {
  return outcome.state === "succeeded"
    ? validateSucceededResult(record, outcome.result)
    : validateFailureOutcome(record, outcome);
}

function compactTombstone(record: StoredCommandRecord): StoredCommandTombstone {
  if (record.state !== "succeeded" && record.state !== "failed" && record.state !== "in_doubt") {
    throw new RelayV2HostCommandPlaneStateError("cannot compact a non-final Relay v2 command");
  }
  return {
    schemaVersion: COMMAND_RECORD_SCHEMA_VERSION,
    recordType: "command_tombstone",
    hostEpoch: record.hostEpoch,
    principalId: record.principalId,
    acceptedClientInstanceId: record.acceptedClientInstanceId,
    hostId: record.hostId,
    commandId: record.commandId,
    fingerprint: record.fingerprint,
    dedupeWindowId: record.dedupeWindowId,
    operation: record.operation,
    scopeId: record.scopeId,
    sessionId: record.sessionId,
    finalState: record.state,
    updatedAtMs: record.updatedAtMs,
    dedupeUntilMs: record.dedupeUntilMs!,
  };
}

export class RelayV2HostCommandPlane {
  private readonly store: RelayV2HostStateStore;
  private readonly hostId: string;
  private readonly executor: RelayV2CanonicalCommandExecutor;
  private readonly resourceMutationOwner: RelayV2CommandResourceMutationOwner | undefined;
  private readonly clock: () => number;
  private readonly runners = new Map<string, Promise<StoredCommand>>();

  private constructor(options: RelayV2HostCommandPlaneOptions) {
    this.store = options.store;
    this.hostId = options.hostId;
    this.executor = options.executor;
    this.resourceMutationOwner = options.resourceMutationOwner;
    this.clock = options.now ?? Date.now;
  }

  static async open(options: RelayV2HostCommandPlaneOptions): Promise<RelayV2HostCommandPlane> {
    const plane = new RelayV2HostCommandPlane(options);
    if (options.recover !== false) await plane.recoverInterrupted();
    return plane;
  }

  async issueDedupeWindow(input: {
    acceptUntilMs: number;
    queryUntilMs: number;
  }): Promise<RelayV2CommandDedupeWindow> {
    const now = this.now();
    if (!isSafeTime(input.acceptUntilMs)
      || !isSafeTime(input.queryUntilMs)
      || input.acceptUntilMs < now
      || input.queryUntilMs < input.acceptUntilMs + RELAY_V2_COMMAND_DEDUPE_RETENTION_MS) {
      throw new TypeError("Relay v2 command dedupe window retention is invalid");
    }
    const commit = await this.store.transaction((transaction) => {
      const windowSeq = transaction.allocateRevision(COMMAND_WINDOW_REVISION_KEY);
      const windowId = transaction.issueOpaqueId("cmdwin");
      const window: StoredDedupeWindow = {
        schemaVersion: COMMAND_RECORD_SCHEMA_VERSION,
        recordType: "dedupe_window",
        hostEpoch: transaction.hostEpoch,
        windowId,
        windowSeq,
        acceptUntilMs: input.acceptUntilMs,
        queryUntilMs: input.queryUntilMs,
      };
      transaction.putMaterializedRecord(windowStorageKey(windowId), cloneJson(window) as unknown as RelayV2HostJson);
      return window;
    });
    return {
      windowId: commit.value.windowId,
      windowSeq: commit.value.windowSeq,
      acceptUntilMs: commit.value.acceptUntilMs,
      queryUntilMs: commit.value.queryUntilMs,
    };
  }

  async execute(
    auth: RelayV2CommandAuthContext,
    frame: RelayV2JsonObject,
  ): Promise<RelayV2JsonObject> {
    const route = validateRelayV2CommandRouteEnvelope(frame);
    if (route.type !== "command.execute") throw new TypeError("expected Relay v2 command.execute");
    if (!this.authMatches(auth, route.hostId)) {
      return errorFrame(route, null, {
        code: "PERMISSION_DENIED",
        message: "Authenticated route cannot access this host",
        retryable: false,
        commandDisposition: "not_accepted",
        details: null,
      });
    }
    const initialEpoch = await this.readEpoch();
    if (route.expectedHostEpoch !== initialEpoch) {
      return epochMismatchFrame(route, initialEpoch);
    }
    const command = parseExecuteFrame(frame);

    const fingerprint = commandFingerprint(command);
    const identity: CommandIdentity = {
      hostEpoch: command.expectedHostEpoch,
      principalId: auth.principalId,
      hostId: command.hostId,
      commandId: command.commandId,
    };
    const first = await this.store.serialize((section) => {
      const snapshot = section.read();
      if (snapshot.hostEpoch !== command.expectedHostEpoch) {
        return { actualHostEpoch: snapshot.hostEpoch } as const;
      }
      const existing = readCommand(snapshot, identity);
      const window = existing === undefined
        ? readWindow(snapshot, snapshot.hostEpoch, command.dedupeWindowId)
        : undefined;
      return { existing, window } as const;
    });
    if ("actualHostEpoch" in first && first.actualHostEpoch !== undefined) {
      return epochMismatchFrame(command, first.actualHostEpoch);
    }
    if (first.existing !== undefined) {
      return this.responseForExisting(command, first.existing, fingerprint, identity);
    }
    if (first.window === undefined || this.now() > first.window.acceptUntilMs) {
      return commandWindowExpiredFrame(command, command.expectedHostEpoch);
    }

    const canonicalRequest: RelayV2CanonicalCommandRequest = {
      fingerprintSchemaVersion: RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION,
      authority: authorityFor(command.operation),
      operation: command.operation,
      principalId: auth.principalId,
      hostId: command.hostId,
      hostEpoch: command.expectedHostEpoch,
      scopeId: command.scopeId,
      sessionId: command.sessionId,
      arguments: cloneJson(command.arguments),
    };
    let admission: RelayV2CommandAdmission;
    try {
      admission = await this.executor.resolve(canonicalRequest);
    } catch {
      return this.preLedgerFailure(command, {
        code: "INTERNAL",
        message: "Command target could not be resolved",
        retryable: true,
        commandDisposition: "not_accepted",
        details: null,
      });
    }

    if (admission.kind === "transient_admission_failure") {
      try {
        return this.preLedgerFailure(command, validateTransientFailure(
          canonicalRequest,
          admission.error,
          admission.authorityEvidence,
        ));
      } catch {
        return this.preLedgerFailure(command, {
          code: "INTERNAL",
          message: "Command target evidence was invalid",
          retryable: true,
          commandDisposition: "not_accepted",
          details: null,
        });
      }
    }

    let immutableFailure: ReturnType<typeof validateImmutableFailure> | undefined;
    if (admission.kind === "immutable_business_failure") {
      try {
        immutableFailure = validateImmutableFailure(
          canonicalRequest,
          admission.error,
          admission.authorityEvidence,
        );
      } catch {
        return this.preLedgerFailure(command, {
          code: "SCOPE_UNREACHABLE",
          message: "Canonical target authority is incomplete or unreachable",
          retryable: true,
          commandDisposition: "not_accepted",
          details: null,
        });
      }
    }

    let admitted: AdmissionTransactionResult;
    try {
      const commit = await this.store.serialize((section) => {
        try {
          return section.transaction((transaction) => {
            if (transaction.hostEpoch !== command.expectedHostEpoch) {
              throw new AdmissionAbort({
                kind: "epoch_mismatch",
                actualHostEpoch: transaction.hostEpoch,
              });
            }
            const existing = readCommand(transaction, identity);
            if (existing !== undefined) {
              throw new AdmissionAbort({ kind: "existing", record: existing });
            }
            const window = readWindow(transaction, transaction.hostEpoch, command.dedupeWindowId);
            const now = this.now();
            if (window === undefined || now > window.acceptUntilMs) {
              throw new AdmissionAbort({ kind: "window_expired" });
            }
            let resourceReservation: RelayV2CommandResourceReservationBinding | null = null;
            if (admission.kind === "executable"
              && (command.operation === "create_worktree"
                || command.operation === "create_terminal")) {
              if (this.resourceMutationOwner === undefined) {
                throw new AdmissionAbort({
                  kind: "resource_rejected",
                  error: {
                    code: "CAPABILITY_UNAVAILABLE",
                    message: "Relay v2 resource reservation owner is not wired",
                    retryable: true,
                    commandDisposition: "not_accepted",
                    details: null,
                  },
                });
              }
              const reservationPlan = admission.resourceReservationPlan ?? null;
              assertJson(reservationPlan);
              const reserved = this.resourceMutationOwner.reserve(
                resourceTransactionFacade(transaction),
                {
                  schemaVersion: RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
                  owner: "relay_v2_resource_state",
                  operation: command.operation,
                  principalId: auth.principalId,
                  hostId: command.hostId,
                  hostEpoch: command.expectedHostEpoch,
                  commandId: command.commandId,
                  requestFingerprint: cloneJson(fingerprint),
                  scopeId: command.scopeId,
                  reservationPlan: cloneJson(reservationPlan),
                },
              );
              if (reserved.kind === "rejected") {
                const error = normalizeError(reserved.error);
                if (error.commandDisposition !== "not_accepted") {
                  throw new RelayV2HostCommandPlaneStateError(
                    "H2 returned an invalid pre-admission reservation rejection",
                  );
                }
                throw new AdmissionAbort({
                  kind: "resource_rejected",
                  error,
                });
              }
              resourceReservation = parseResourceReservationBinding(reserved.binding);
            }
            const record = admission.kind === "immutable_business_failure"
              ? createFinalFailureRecord(
                  auth,
                  command,
                  fingerprint,
                  immutableFailure!.error,
                  immutableFailure!.authorityEvidence,
                  window,
                  now,
                )
              : createAcceptedRecord(
                  auth,
                  command,
                  fingerprint,
                  planFor(auth, command, admission.adapterState, resourceReservation),
                  now,
                );
            transaction.putCommandRecord(
              commandStorageKey(identity),
              cloneJson(record) as unknown as RelayV2HostJson,
            );
            return { kind: "inserted", record } as const;
          });
        } catch (error) {
          if (isHostStateCapacityError(error)) {
            this.latchPersistedCapacity(section);
            throw new AdmissionAbort({
              kind: "resource_rejected",
              error: {
                code: "CAPABILITY_UNAVAILABLE",
                message: "Relay v2 host persistence capacity is unavailable",
                retryable: true,
                commandDisposition: "not_accepted",
                details: null,
              },
            });
          }
          throw error;
        }
      });
      admitted = commit.value;
    } catch (error) {
      if (error instanceof AdmissionAbort) {
        admitted = error.value;
      } else if (isHostStateCommitUncertain(error)) {
        const observed = await this.readIdentity(identity);
        if (observed === undefined) throw error;
        if (observed.recordType !== "command" || !fingerprintsEqual(observed.fingerprint, fingerprint)) {
          throw new RelayV2HostCommandPlaneStateError(
            "uncertain Relay v2 admission did not expose the admitted command",
          );
        }
        admitted = { kind: "inserted", record: observed };
      } else {
        throw error;
      }
    }

    if (admitted.kind === "epoch_mismatch") {
      return epochMismatchFrame(command, admitted.actualHostEpoch);
    }
    if (admitted.kind === "window_expired") {
      return commandWindowExpiredFrame(command, command.expectedHostEpoch);
    }
    if (admitted.kind === "resource_rejected") {
      return this.preLedgerFailure(command, admitted.error);
    }
    if (admitted.kind === "existing") {
      return this.responseForExisting(command, admitted.record, fingerprint, identity);
    }
    if (admitted.record.state !== "accepted") {
      return statusFrame(command, command.expectedHostEpoch, admitted.record, false);
    }
    const settled = await this.ensureRunner(identity);
    if (settled.recordType === "command_tombstone") {
      return tombstoneFrame(command, command.expectedHostEpoch, settled);
    }
    return statusFrame(command, command.expectedHostEpoch, settled, false);
  }

  async query(
    auth: RelayV2CommandAuthContext,
    frame: RelayV2JsonObject,
  ): Promise<RelayV2JsonObject> {
    const route = validateRelayV2CommandRouteEnvelope(frame);
    if (route.type !== "command.query") throw new TypeError("expected Relay v2 command.query");
    if (!this.authMatches(auth, route.hostId)) {
      return errorFrame(route, null, {
        code: "PERMISSION_DENIED",
        message: "Authenticated route cannot access this host",
        retryable: false,
        commandDisposition: "not_accepted",
        details: null,
      });
    }
    const initialEpoch = await this.readEpoch();
    if (route.expectedHostEpoch !== initialEpoch) {
      return epochMismatchFrame(route, initialEpoch);
    }
    const query = parseQueryFrame(frame);

    await this.compact();
    const now = this.now();
    return this.store.serialize((section) => {
      const snapshot = section.read();
      if (snapshot.hostEpoch !== query.expectedHostEpoch) {
        return epochMismatchFrame(query, snapshot.hostEpoch);
      }
      const windows = this.queryableWindows(snapshot, now);
      const items = query.items.map((item) => this.queryItem(
        snapshot,
        auth,
        item,
        windows,
        now,
      ));
      const newest = snapshot.revisions[COMMAND_WINDOW_REVISION_KEY] ?? "0";
      const oldest = [...windows.values()]
        .map((window) => window.windowSeq)
        .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)[0]
        ?? newest;
      return checkedFrame({
        protocolVersion: 2,
        kind: "response",
        type: "command.statuses",
        requestId: query.requestId,
        hostId: query.hostId,
        hostEpoch: snapshot.hostEpoch,
        payload: {
          dedupeWatermark: {
            oldestQueryableWindowSeq: oldest,
            newestIssuedWindowSeq: newest,
            observedAtMs: now,
          },
          items,
        },
      });
    });
  }

  async compact(): Promise<void> {
    const now = this.now();
    const snapshot = await this.store.read();
    const commandChanges: Array<{
      key: string;
      action: "delete" | "tombstone";
      record?: StoredCommandRecord;
    }> = Object.entries(snapshot.commands).reduce<Array<{
      key: string;
      action: "delete" | "tombstone";
      record?: StoredCommandRecord;
    }>>((changes, [key, value]) => {
      if (!key.startsWith(COMMAND_KEY_PREFIX)) return changes;
      const record = parseStoredCommand(value);
      if (record.recordType === "command_tombstone") {
        if (now > record.dedupeUntilMs) changes.push({ key, action: "delete" });
        return changes;
      }
      if ((record.state === "succeeded" || record.state === "failed" || record.state === "in_doubt")
        && now > record.resultUntilMs!) {
        changes.push({ key, action: "tombstone", record });
      }
      return changes;
    }, []);
    const windowDeletes = Object.entries(snapshot.materialized).flatMap(([key, value]) => {
      if (!key.startsWith(WINDOW_KEY_PREFIX)) return [];
      const window = parseWindow(value);
      return now > window.queryUntilMs ? [key] : [];
    });
    if (commandChanges.length === 0 && windowDeletes.length === 0) return;

    await this.store.transaction((transaction) => {
      for (const change of commandChanges) {
        const currentValue = transaction.getCommandRecord(change.key);
        if (currentValue === undefined) continue;
        const current = parseStoredCommand(currentValue);
        if (current.recordType === "command_tombstone") {
          if (now > current.dedupeUntilMs) {
            if (current.finalState === "in_doubt"
              && (current.operation === "create_worktree" || current.operation === "create_terminal")) {
              if (this.resourceMutationOwner === undefined) continue;
              const settlement = resourceSettlementIntentFor(current, "retain_uncertain", null)!;
              if (this.resourceMutationOwner.hasPendingSettlement(
                resourceTransactionFacade(transaction),
                settlement,
              )) continue;
            }
            transaction.deleteCommandRecord(change.key);
          }
        } else if ((current.state === "succeeded" || current.state === "failed" || current.state === "in_doubt")
          && now > current.resultUntilMs!) {
          transaction.putCommandRecord(
            change.key,
            cloneJson(compactTombstone(current)) as unknown as RelayV2HostJson,
          );
        }
      }
      for (const key of windowDeletes) {
        const currentValue = transaction.getMaterializedRecord(key);
        if (currentValue !== undefined && now > parseWindow(currentValue).queryUntilMs) {
          transaction.deleteMaterializedRecord(key);
        }
      }
    });
  }

  async recoverInterrupted(): Promise<void> {
    const now = this.now();
    const snapshot = await this.store.read();
    const runningKeys = Object.entries(snapshot.commands).flatMap(([key, value]) => {
      if (!key.startsWith(COMMAND_KEY_PREFIX)) return [];
      const record = parseStoredCommand(value);
      return record.recordType === "command" && record.state === "running" ? [key] : [];
    });
    if (runningKeys.length > 0) {
      await this.store.transaction((transaction) => {
        for (const key of runningKeys) {
          const value = transaction.getCommandRecord(key);
          if (value === undefined) continue;
          const record = parseStoredCommand(value);
          if (record.recordType !== "command" || record.state !== "running") continue;
          const settlement = resourceSettlementIntentFor(record, "retain_uncertain", null);
          if (settlement !== null) {
            if (this.resourceMutationOwner === undefined) {
              throw new RelayV2HostCommandPlaneStateError("Relay v2 resource mutation owner disappeared");
            }
            const disposition = this.resourceMutationOwner.settle(
              resourceTransactionFacade(transaction),
              settlement,
            );
            if (disposition === "released") {
              throw new RelayV2HostCommandPlaneStateError(
                "restart uncertainty released a reservation without complete proof",
              );
            }
          }
          const window = readWindow(transaction, transaction.hostEpoch, record.dedupeWindowId);
          transaction.putCommandRecord(
            key,
            cloneJson(this.finalizedRecord(record, { state: "in_doubt" }, window, now)) as unknown as RelayV2HostJson,
          );
        }
      });
    }

    const recovered = await this.store.read();
    const runners: Array<Promise<StoredCommand>> = [];
    for (const [key, value] of Object.entries(recovered.commands)) {
      if (!key.startsWith(COMMAND_KEY_PREFIX)) continue;
      const record = parseStoredCommand(value);
      if (record.recordType !== "command" || record.state !== "accepted") continue;
      runners.push(this.ensureRunner({
        hostEpoch: record.hostEpoch,
        principalId: record.principalId,
        hostId: record.hostId,
        commandId: record.commandId,
      }));
    }
    await Promise.all(runners);
  }

  private now(): number {
    const value = this.clock();
    if (!isSafeTime(value)) throw new TypeError("Relay v2 command clock returned an invalid time");
    return value;
  }

  private async readEpoch(): Promise<string> {
    return this.store.serialize((section) => section.read().hostEpoch);
  }

  private authMatches(auth: RelayV2CommandAuthContext, requestHostId: string): boolean {
    return typeof auth.hostId === "string"
      && auth.hostId === this.hostId
      && requestHostId === this.hostId
      && typeof auth.principalId === "string"
      && auth.principalId.length > 0
      && typeof auth.clientInstanceId === "string"
      && auth.clientInstanceId.length > 0;
  }

  private async readIdentity(identity: CommandIdentity): Promise<StoredCommand | undefined> {
    return this.store.serialize((section) => readCommand(section.read(), identity));
  }

  private async preLedgerFailure(
    command: NormalizedCommand,
    error: RelayV2CommandStructuredError,
  ): Promise<RelayV2JsonObject> {
    const actualEpoch = await this.readEpoch();
    if (actualEpoch !== command.expectedHostEpoch) return epochMismatchFrame(command, actualEpoch);
    return errorFrame(command, actualEpoch, error);
  }

  private async responseForExisting(
    command: NormalizedCommand,
    record: StoredCommand,
    fingerprint: StoredFingerprint,
    identity: CommandIdentity,
  ): Promise<RelayV2JsonObject> {
    if (!fingerprintsEqual(record.fingerprint, fingerprint)) {
      return errorFrame(command, record.hostEpoch, {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Command ID was already used for a different request",
        retryable: false,
        commandDisposition: commandDisposition(record),
        details: null,
      });
    }
    if (record.recordType === "command_tombstone") {
      return tombstoneFrame(command, record.hostEpoch, record);
    }
    if (record.state === "accepted") {
      const settled = await this.ensureRunner(identity);
      if (settled.recordType === "command_tombstone") {
        return tombstoneFrame(command, record.hostEpoch, settled);
      }
      return statusFrame(command, record.hostEpoch, settled, true);
    }
    return statusFrame(command, record.hostEpoch, record, true);
  }

  private ensureRunner(identity: CommandIdentity): Promise<StoredCommand> {
    const key = commandStorageKey(identity);
    const existing = this.runners.get(key);
    if (existing !== undefined) return existing;
    const runner = this.runAcceptedWorker(identity);
    this.runners.set(key, runner);
    void runner.finally(() => {
      if (this.runners.get(key) === runner) this.runners.delete(key);
    }).catch(() => undefined);
    return runner;
  }

  private async runAcceptedWorker(identity: CommandIdentity): Promise<StoredCommand> {
    const claimed = await this.claimAccepted(identity);
    if (!claimed.claimed) return claimed.record;
    const running = claimed.record;

    let prepared: PreparedExecutionOutcome;
    try {
      if (running.executionPlan === null) {
        throw new RelayV2HostCommandPlaneStateError("accepted Relay v2 command has no execution plan");
      }
      if (running.executionPlan.authority === "tw_rpc") {
        const raw = await this.executor.executeTwRpc(running.executionPlan);
        prepared = this.prepareTwRpcOutcome(running, raw);
      } else if (running.executionPlan.authority === "terminal_control") {
        const raw = await this.executor.executeTerminalControl(running.executionPlan);
        prepared = {
          outcome: validateTerminalOutcome(running, raw),
          resourceCommitIntent: null,
          resourceSettlementIntent: null,
        };
      } else {
        throw new RelayV2HostCommandPlaneStateError("unknown Relay v2 command execution authority");
      }
    } catch {
      return this.markInDoubt(identity, null);
    }

    try {
      return await this.finalizeRunning(identity, prepared);
    } catch {
      // The side effect has already crossed its boundary. A failed or uncertain
      // final ledger commit can only converge to the committed final record or
      // IN_DOUBT; it never invokes the executor again.
      return this.markInDoubt(identity, prepared);
    }
  }

  private async claimAccepted(identity: CommandIdentity): Promise<{
    claimed: true;
    record: StoredCommandRecord;
  } | {
    claimed: false;
    record: StoredCommand;
  }> {
    while (true) {
      try {
        const commit = await this.store.transaction((transaction) => {
          const current = readCommand(transaction, identity);
          if (current === undefined) {
            throw new RelayV2HostCommandPlaneStateError("accepted Relay v2 command disappeared");
          }
          if (current.recordType !== "command" || current.state !== "accepted") {
            throw new TransitionAbort(current);
          }
          const next: StoredCommandRecord = {
            ...current,
            state: "running",
            updatedAtMs: this.now(),
          };
          transaction.putCommandRecord(
            commandStorageKey(identity),
            cloneJson(next) as unknown as RelayV2HostJson,
          );
          return next;
        });
        return { claimed: true, record: commit.value };
      } catch (error) {
        if (error instanceof TransitionAbort) {
          return { claimed: false, record: error.record };
        }
        const observed = await this.readIdentity(identity);
        if (observed === undefined) throw error;
        if (isHostStateCommitUncertain(error)
          && observed.recordType === "command"
          && observed.state === "running") {
          return { claimed: true, record: observed };
        }
        if (observed.recordType !== "command" || observed.state !== "accepted") {
          return { claimed: false, record: observed };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private prepareTwRpcOutcome(
    running: StoredCommandRecord,
    outcome: RelayV2TwRpcExecutionOutcome,
  ): PreparedExecutionOutcome {
    if (outcome.state !== "succeeded") {
      if (outcome.state === "failed" && (
        !isRecord(outcome)
        || !hasExactKeys(outcome, ["state", "sideEffect", "error"])
        || outcome.sideEffect !== "not_applied"
      )) {
        throw new TypeError("canonical TW RPC failure lacks no-side-effect proof");
      }
      return {
        outcome: validateFailureOutcome(running, outcome),
        resourceCommitIntent: null,
        resourceSettlementIntent: resourceSettlementIntentFor(
          running,
          outcome.state === "failed" ? "release_no_side_effect" : "retain_uncertain",
          null,
        ),
      };
    }
    if (!isRecord(outcome)
      || !hasExactKeys(outcome, ["state", "backendOutcome", "commitIntent"])) {
      throw new TypeError("canonical TW RPC executor returned an invalid commit intent");
    }
    const backendOutcome = parseCanonicalBackendOutcome(outcome.backendOutcome, running.operation);
    assertJson(outcome.commitIntent);
    if (running.executionPlan === null
      || running.executionPlan.authority !== "tw_rpc"
      || !isResourceMutation(running.operation)) {
      throw new RelayV2HostCommandPlaneStateError("resource command lacks a TW RPC execution plan");
    }
    if (this.resourceMutationOwner === undefined) {
      throw new RelayV2HostCommandPlaneStateError(
        "Relay v2 resource mutation owner is not wired; resource capability must remain disabled",
      );
    }
    const intent = parseResourceCommitIntent({
      schemaVersion: RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
      owner: "relay_v2_resource_state",
      operation: running.operation,
      principalId: running.principalId,
      hostId: running.hostId,
      hostEpoch: running.hostEpoch,
      commandId: running.commandId,
      requestFingerprint: cloneJson(running.fingerprint),
      scopeId: running.scopeId,
      sessionId: running.sessionId,
      reservationBinding: running.executionPlan.resourceReservation,
      backendOutcome,
      commitIntent: cloneJson(outcome.commitIntent),
    }, running);
    return {
      outcome: null,
      resourceCommitIntent: intent,
      resourceSettlementIntent: null,
    };
  }

  private async finalizeRunning(
    identity: CommandIdentity,
    prepared: PreparedExecutionOutcome,
  ): Promise<StoredCommand> {
    try {
      const commit = await this.store.serialize((section) => {
        let committed: RelayV2HostStateCommit<{
          record: StoredCommandRecord;
          resourceEvidence: RelayV2CommandResourceCommitEvidence | null;
        }>;
        try {
          committed = section.transaction((transaction) => {
            const current = readCommand(transaction, identity);
            if (current === undefined) {
              throw new RelayV2HostCommandPlaneStateError("running Relay v2 command disappeared");
            }
            if (current.recordType !== "command" || current.state !== "running") {
              throw new TransitionAbort(current);
            }
            const window = readWindow(transaction, transaction.hostEpoch, current.dedupeWindowId);
            let outcome = prepared.outcome;
            let resourceEvidence: RelayV2CommandResourceCommitEvidence | null = null;
            if (prepared.resourceCommitIntent !== null) {
              if (this.resourceMutationOwner === undefined) {
                throw new RelayV2HostCommandPlaneStateError("Relay v2 resource mutation owner disappeared");
              }
              if (outcome !== null) {
                throw new RelayV2HostCommandPlaneStateError("resource commit intent carried an early final outcome");
              }
              const intent = parseResourceCommitIntent(prepared.resourceCommitIntent, current);
              const evidence = parseResourceCommitEvidence(
                this.resourceMutationOwner.commit(resourceTransactionFacade(transaction), intent),
                current,
              );
              resourceEvidence = evidence;
              outcome = validateSucceededResult(current, evidence.result);
            }
            if (prepared.resourceSettlementIntent !== null) {
              if (this.resourceMutationOwner === undefined) {
                throw new RelayV2HostCommandPlaneStateError("Relay v2 resource mutation owner disappeared");
              }
              const disposition = this.resourceMutationOwner.settle(
                resourceTransactionFacade(transaction),
                prepared.resourceSettlementIntent,
              );
              if (prepared.resourceSettlementIntent.disposition === "release_no_side_effect"
                && disposition !== "released") {
                throw new RelayV2HostCommandPlaneStateError(
                  "no-side-effect failure could not release its active reservation",
                );
              }
            }
            if (outcome === null) {
              throw new RelayV2HostCommandPlaneStateError("command finalization lacks an outcome");
            }
            const next = this.finalizedRecord(current, outcome, window, this.now());
            transaction.putCommandRecord(
              commandStorageKey(identity),
              cloneJson(next) as unknown as RelayV2HostJson,
            );
            return { record: next, resourceEvidence };
          });
        } catch (error) {
          if (isHostStateCommitUncertain(error) && this.resourceMutationOwner !== undefined) {
            this.resourceMutationOwner.fenceCommitUncertain(section.read());
          } else if (isHostStateCapacityError(error)) {
            this.latchPersistedCapacity(section);
          }
          throw error;
        }
        if (committed.value.resourceEvidence !== null && this.resourceMutationOwner !== undefined) {
          try {
            const publication = this.resourceMutationOwner.publishCommitted(
              committed.snapshot,
              committed.value.resourceEvidence,
            ) as unknown;
            if (isThenable(publication)) {
              throw new RelayV2HostCommandPlaneStateError(
                "Relay v2 resource publication must be a synchronous bounded enqueue",
              );
            }
          } catch {
            this.resourceMutationOwner.fenceCommitUncertain(committed.snapshot);
          }
        }
        return committed;
      });
      return commit.value.record;
    } catch (error) {
      if (error instanceof TransitionAbort) return error.record;
      if (isHostStateCommitUncertain(error)) {
        const snapshot = await this.store.read();
        const observed = readCommand(snapshot, identity);
        if (observed !== undefined
          && (observed.recordType === "command_tombstone" || observed.state !== "running")) {
          return observed;
        }
      }
      throw error;
    }
  }

  private latchPersistedCapacity(section: RelayV2HostStateCriticalSection): void {
    try {
      const fenced = section.latchMaterializedReadinessFence(
        "persisted_capacity_exceeded",
      );
      this.resourceMutationOwner?.fencePersistedCapacity(fenced.snapshot);
    } catch (error) {
      if (isHostStateCommitUncertain(error)) {
        this.resourceMutationOwner?.fenceCommitUncertain(section.read());
      }
      throw error;
    }
  }

  private async markInDoubt(
    identity: CommandIdentity,
    prepared: PreparedExecutionOutcome | null,
  ): Promise<StoredCommand> {
    try {
      const commit = await this.store.serialize((section) => {
        const committed = section.transaction((transaction) => {
          const current = readCommand(transaction, identity);
          if (current === undefined) {
            throw new RelayV2HostCommandPlaneStateError("uncertain Relay v2 command disappeared");
          }
          if (current.recordType !== "command" || current.state !== "running") {
            throw new TransitionAbort(current);
          }
          const settlement = resourceSettlementIntentFor(
            current,
            "retain_uncertain",
            prepared?.resourceCommitIntent?.backendOutcome ?? null,
          );
          let authorityFenced = false;
          if (settlement !== null) {
            if (this.resourceMutationOwner === undefined) {
              throw new RelayV2HostCommandPlaneStateError("Relay v2 resource mutation owner disappeared");
            }
            const disposition = this.resourceMutationOwner.settle(
              resourceTransactionFacade(transaction),
              settlement,
            );
            if (disposition === "released") {
              throw new RelayV2HostCommandPlaneStateError(
                "uncertain command reservation was released without complete proof",
              );
            }
            authorityFenced = disposition === "retained_fenced";
          }
          const window = readWindow(transaction, transaction.hostEpoch, current.dedupeWindowId);
          const next = this.finalizedRecord(current, { state: "in_doubt" }, window, this.now());
          transaction.putCommandRecord(
            commandStorageKey(identity),
            cloneJson(next) as unknown as RelayV2HostJson,
          );
          return { record: next, authorityFenced };
        });
        if (committed.value.authorityFenced) {
          this.resourceMutationOwner?.fenceMaterializedAuthority(committed.snapshot);
        }
        return committed;
      });
      return commit.value.record;
    } catch (error) {
      if (error instanceof TransitionAbort) return error.record;
      if (isHostStateCommitUncertain(error)) {
        const observed = await this.readIdentity(identity);
        if (observed !== undefined
          && (observed.recordType === "command_tombstone" || observed.state !== "running")) {
          return observed;
        }
      }
      throw error;
    }
  }

  private finalizedRecord(
    current: StoredCommandRecord,
    outcome: RelayV2FinalizedExecutionOutcome,
    window: StoredDedupeWindow | undefined,
    now: number,
  ): StoredCommandRecord {
    if (outcome.state === "succeeded") {
      return {
        ...current,
        executionPlan: null,
        state: "succeeded",
        updatedAtMs: now,
        finalizedAtMs: now,
        resultUntilMs: now + RELAY_V2_COMMAND_RESULT_RETENTION_MS,
        dedupeUntilMs: retentionUntil(now, window),
        result: cloneJson(outcome.result),
        error: null,
      };
    }
    const error = outcome.state === "failed"
      ? normalizeError(outcome.error)
      : inDoubtError();
    return {
      ...current,
      executionPlan: null,
      state: outcome.state,
      updatedAtMs: now,
      finalizedAtMs: now,
      resultUntilMs: now + RELAY_V2_COMMAND_RESULT_RETENTION_MS,
      dedupeUntilMs: retentionUntil(now, window),
      result: null,
      error,
    };
  }

  private queryableWindows(
    snapshot: RelayV2HostStateSnapshot,
    now: number,
  ): Map<string, StoredDedupeWindow> {
    const windows = new Map<string, StoredDedupeWindow>();
    for (const [key, value] of Object.entries(snapshot.materialized)) {
      if (!key.startsWith(WINDOW_KEY_PREFIX)) continue;
      const window = parseWindow(value);
      if (window.hostEpoch === snapshot.hostEpoch && now <= window.queryUntilMs) {
        windows.set(window.windowId, window);
      }
    }
    return windows;
  }

  private queryItem(
    snapshot: RelayV2HostStateSnapshot,
    auth: RelayV2CommandAuthContext,
    item: { commandId: string; dedupeWindowId: string },
    windows: Map<string, StoredDedupeWindow>,
    now: number,
  ): RelayV2HostJson {
    const identity: CommandIdentity = {
      hostEpoch: snapshot.hostEpoch,
      principalId: auth.principalId,
      hostId: auth.hostId,
      commandId: item.commandId,
    };
    const record = readCommand(snapshot, identity);
    if (record !== undefined && record.dedupeWindowId === item.dedupeWindowId) {
      if (record.recordType === "command_tombstone") {
        return this.expiredQueryItem(item, record, now);
      }
      return {
        commandId: item.commandId,
        dedupeWindowId: item.dedupeWindowId,
        state: record.state,
        updatedAtMs: record.updatedAtMs,
        dedupeUntilMs: record.dedupeUntilMs,
        retryable: false,
        retryAfterMs: null,
        reissueRequired: false,
        result: record.result === null ? null : cloneJson(record.result),
        error: record.error === null ? null : cloneJson(normalizeError(record.error)) as unknown as RelayV2HostJson,
      };
    }

    const window = windows.get(item.dedupeWindowId);
    if (record === undefined && window !== undefined) {
      const active = now <= window.acceptUntilMs;
      return {
        commandId: item.commandId,
        dedupeWindowId: item.dedupeWindowId,
        state: "not_accepted",
        updatedAtMs: now,
        dedupeUntilMs: null,
        retryable: active,
        retryAfterMs: active ? 0 : null,
        reissueRequired: !active,
        result: null,
        error: normalizeError(active
          ? {
              code: "COMMAND_NOT_ACCEPTED",
              message: "Command was not durably accepted",
              retryable: true,
              commandDisposition: "not_accepted",
              details: null,
            }
          : {
              code: "COMMAND_WINDOW_EXPIRED",
              message: "Command dedupe window no longer accepts new commands",
              retryable: false,
              commandDisposition: "not_accepted",
              details: { reissueRequired: true },
            }) as unknown as RelayV2HostJson,
      };
    }

    return {
      commandId: item.commandId,
      dedupeWindowId: item.dedupeWindowId,
      state: "unknown",
      updatedAtMs: now,
      dedupeUntilMs: null,
      retryable: false,
      retryAfterMs: null,
      reissueRequired: false,
      result: null,
      error: normalizeError({
        code: "COMMAND_STATUS_UNKNOWN",
        message: "Command status cannot be proven",
        retryable: false,
        commandDisposition: "in_doubt",
        details: null,
      }) as unknown as RelayV2HostJson,
    };
  }

  private expiredQueryItem(
    item: { commandId: string; dedupeWindowId: string },
    record: StoredCommandTombstone,
    now: number,
  ): RelayV2HostJson {
    return {
      commandId: item.commandId,
      dedupeWindowId: item.dedupeWindowId,
      state: "expired",
      updatedAtMs: record.updatedAtMs,
      dedupeUntilMs: record.dedupeUntilMs,
      retryable: false,
      retryAfterMs: null,
      reissueRequired: false,
      result: null,
      error: normalizeError({
        code: "COMMAND_RESULT_EXPIRED",
        message: "Command result expired",
        retryable: false,
        commandDisposition: record.finalState === "in_doubt" ? "in_doubt" : "completed",
        details: { finalState: record.finalState },
      }) as unknown as RelayV2HostJson,
    };
  }
}
