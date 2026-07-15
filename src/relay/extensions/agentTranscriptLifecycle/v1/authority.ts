import { createHash } from "node:crypto";

const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_ID_UTF8_BYTES = 128;
const MAX_TEXT_UTF8_BYTES = 65_536;
const MAX_FAILURE_SUMMARY_UTF8_BYTES = 1_024;

export type RelayAgentLifecycleState =
  | "running"
  | "waiting_for_user"
  | "failed"
  | "completed";

export type RelayAgentAuthorityDisposition =
  | "applied"
  | "duplicate"
  | "source_gap"
  | "stale_source"
  | "source_event_conflict"
  | "source_history_expired"
  | "invalid_transition"
  | "redundant_terminal"
  | "terminal_conflict"
  | "entry_id_conflict"
  | "entry_deleted";

export type RelayAgentEntryRole = "user" | "agent";
export type RelayAgentEntryRedactionReason = "user_request" | "policy" | "retention";

export interface RelayAgentAuthorityBinding {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  timelineEpoch: string;
}

export interface RelayAgentFailure {
  code: string;
  summary: string | null;
}

export interface RelayAgentSourceStartedMutation {
  mutationType: "source.started";
}

export interface RelayAgentLifecycleChangedMutation {
  mutationType: "lifecycle.changed";
  scope: "run" | "turn";
  runId: string;
  turnId: string | null;
  state: RelayAgentLifecycleState;
  failure: RelayAgentFailure | null;
}

export interface RelayAgentTextEntryAppendedMutation {
  mutationType: "text_entry.appended";
  entryId: string;
  runId: string;
  turnId: string;
  role: RelayAgentEntryRole;
  text: string;
  commandId: string | null;
}

export interface RelayAgentEntryRedactedMutation {
  mutationType: "entry.redacted";
  entryId: string;
  reason: RelayAgentEntryRedactionReason;
}

export interface RelayAgentEntryDeletedMutation {
  mutationType: "entry.deleted";
  entryId: string;
  reason: RelayAgentEntryRedactionReason;
}

export type RelayAgentSourceMutation =
  | RelayAgentSourceStartedMutation
  | RelayAgentLifecycleChangedMutation
  | RelayAgentTextEntryAppendedMutation
  | RelayAgentEntryRedactedMutation
  | RelayAgentEntryDeletedMutation;

export interface RelayAgentSourceEvent {
  sourceEpoch: string;
  sourceSeq: string;
  sourceEventId: string;
  occurredAtMs: number;
  mutation: RelayAgentSourceMutation;
}

export interface RelayAgentLifecycleRecord {
  recordType: "lifecycle";
  lifecycleEventId: string;
  sourceEpoch: string;
  scope: "run" | "turn";
  runId: string;
  turnId: string | null;
  state: RelayAgentLifecycleState;
  failure: RelayAgentFailure | null;
  occurredAtMs: number;
  agentEventSeq: string;
}

export interface RelayAgentTextEntryRecord {
  recordType: "text_entry";
  entryId: string;
  runId: string;
  turnId: string;
  role: RelayAgentEntryRole;
  state: "visible" | "redacted";
  text: string | null;
  redactionReason: RelayAgentEntryRedactionReason | null;
  commandId: string | null;
  createdAtMs: number;
  createdAgentSeq: string;
  lastModifiedAgentSeq: string;
}

export interface RelayAgentRunRecord {
  runId: string;
  sourceEpoch: string;
  state: RelayAgentLifecycleState;
  turnIds: readonly string[];
  lifecycle: RelayAgentLifecycleRecord;
}

export interface RelayAgentTurnRecord {
  turnId: string;
  runId: string;
  sourceEpoch: string;
  state: RelayAgentLifecycleState;
  lifecycle: RelayAgentLifecycleRecord;
}

export interface RelayAgentDeletedEntryTombstone {
  entryId: string;
  sourceEpoch: string;
  reason: RelayAgentEntryRedactionReason;
  deletedAgentSeq: string;
}

export interface RelayAgentSourceDedupeEvidence {
  sessionId: string;
  timelineEpoch: string;
  sourceEpoch: string;
  sourceEventId: string;
  sourceSeq: string;
  fingerprintAlgorithm: "sha256-canonical-json";
  fingerprintDigest: string;
}

export interface RelayAgentSourceAuthorityState {
  sourceEpoch: string;
  lastSourceSeq: string;
  fenced: boolean;
  dedupe: Readonly<Record<string, RelayAgentSourceDedupeEvidence>>;
}

export interface RelayAgentAuthorityState {
  schemaVersion: 1;
  binding: Readonly<RelayAgentAuthorityBinding>;
  agentEventSeq: string;
  activeSourceEpoch: string | null;
  sources: Readonly<Record<string, RelayAgentSourceAuthorityState>>;
  runs: Readonly<Record<string, RelayAgentRunRecord>>;
  /** Indexed by the canonical JSON tuple [runId, turnId]. */
  turns: Readonly<Record<string, RelayAgentTurnRecord>>;
  entries: Readonly<Record<string, RelayAgentTextEntryRecord>>;
  deletedEntries: Readonly<Record<string, RelayAgentDeletedEntryTombstone>>;
}

export type RelayAgentPublicMutation =
  | {
      mutationType: "source.availability";
      state: "connected";
      sourceEpoch: string;
      reason: "source_restarted" | null;
    }
  | {
      mutationType: "lifecycle.changed";
      lifecycle: RelayAgentLifecycleRecord;
    }
  | {
      mutationType: "text_entry.appended";
      entry: RelayAgentTextEntryRecord;
    }
  | {
      mutationType: "entry.redacted";
      entryId: string;
      reason: RelayAgentEntryRedactionReason;
    }
  | {
      mutationType: "entry.deleted";
      entryId: string;
      reason: RelayAgentEntryRedactionReason;
    };

/**
 * A host-authority record, not a public Relay frame. A future store adapter
 * must commit this record together with `state` before acknowledging source.
 */
export interface RelayAgentAuthorityPublicEvent {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  timelineEpoch: string;
  agentEventSeq: string;
  eventId: string;
  occurredAtMs: number;
  mutation: RelayAgentPublicMutation;
}

export interface RelayAgentAuthorityReduction {
  state: RelayAgentAuthorityState;
  disposition: RelayAgentAuthorityDisposition;
  agentEventSeq: string;
  expectedSourceSeq: string | null;
  publicEvent: RelayAgentAuthorityPublicEvent | null;
  sourceFenced: boolean;
}

export class RelayAgentAuthorityInputError extends TypeError {
  readonly code = "invalid_source_event" as const;

  constructor(message: string) {
    super(message);
    this.name = "RelayAgentAuthorityInputError";
  }
}

export class RelayAgentAuthorityStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayAgentAuthorityStateError";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface DomainReduction {
  disposition:
    | "applied"
    | "invalid_transition"
    | "redundant_terminal"
    | "terminal_conflict"
    | "entry_id_conflict"
    | "entry_deleted";
  runs: RelayAgentAuthorityState["runs"];
  turns: RelayAgentAuthorityState["turns"];
  entries: RelayAgentAuthorityState["entries"];
  deletedEntries: RelayAgentAuthorityState["deletedEntries"];
  publicMutation: RelayAgentPublicMutation | null;
}

function emptyRecord<T>(): Readonly<Record<string, T>> {
  return Object.freeze(Object.create(null) as Record<string, T>);
}

function cloneRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, value);
}

function withoutRecordKey<T>(value: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const next = cloneRecord(value);
  delete next[key];
  return Object.freeze(next);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RelayAgentAuthorityInputError(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RelayAgentAuthorityInputError(`${label} contains an unpaired surrogate`);
    }
  }
}

function utf8Bytes(value: string, label: string): number {
  assertWellFormedUnicode(value, label);
  return Buffer.byteLength(value, "utf8");
}

function parseOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new RelayAgentAuthorityInputError(`${label} must be a non-empty opaque ID`);
  }
  if (utf8Bytes(value, label) > MAX_ID_UTF8_BYTES) {
    throw new RelayAgentAuthorityInputError(`${label} exceeds ${MAX_ID_UTF8_BYTES} UTF-8 bytes`);
  }
  return value;
}

function parseText(value: unknown, label: string, maxBytes: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.length === 0)) {
    throw new RelayAgentAuthorityInputError(`${label} is invalid`);
  }
  if (utf8Bytes(value, label) > maxBytes) {
    throw new RelayAgentAuthorityInputError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function parseSafeTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE_INTEGER) {
    throw new RelayAgentAuthorityInputError(`${label} must be a non-negative JSON safe integer`);
  }
  return value as number;
}

function parseCounter(value: unknown, label: string, positive: boolean): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RelayAgentAuthorityInputError(`${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new RelayAgentAuthorityInputError(`${label} is outside the accepted uint64 range`);
  }
  return value;
}

function incrementCounter(value: string, label: string): string {
  const next = BigInt(value) + 1n;
  if (next > UINT64_MAX) throw new RelayAgentAuthorityStateError(`${label} is exhausted`);
  return next.toString();
}

function asClosedObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayAgentAuthorityInputError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RelayAgentAuthorityInputError(`${label} must use its closed schema`);
  }
  return record;
}

function parseFailure(value: unknown, state: RelayAgentLifecycleState): RelayAgentFailure | null {
  if (state !== "failed") {
    if (value !== null) throw new RelayAgentAuthorityInputError("non-failed lifecycle must have failure=null");
    return null;
  }
  const record = asClosedObject(value, "mutation.failure", ["code", "summary"]);
  const summary = record.summary === null
    ? null
    : parseText(record.summary, "mutation.failure.summary", MAX_FAILURE_SUMMARY_UTF8_BYTES, true);
  return deepFreeze({
    code: parseOpaqueId(record.code, "mutation.failure.code"),
    summary,
  });
}

function parseLifecycleMutation(record: Record<string, unknown>): RelayAgentLifecycleChangedMutation {
  const scope = record.scope;
  if (scope !== "run" && scope !== "turn") {
    throw new RelayAgentAuthorityInputError("mutation.scope is invalid");
  }
  const state = record.state;
  if (state !== "running" && state !== "waiting_for_user" && state !== "failed" && state !== "completed") {
    throw new RelayAgentAuthorityInputError("mutation.state is invalid");
  }
  const turnId = scope === "run"
    ? (() => {
        if (record.turnId !== null) throw new RelayAgentAuthorityInputError("run lifecycle must have turnId=null");
        return null;
      })()
    : parseOpaqueId(record.turnId, "mutation.turnId");
  return deepFreeze({
    mutationType: "lifecycle.changed",
    scope,
    runId: parseOpaqueId(record.runId, "mutation.runId"),
    turnId,
    state,
    failure: parseFailure(record.failure, state),
  });
}

function parseRedactionReason(value: unknown, label: string): RelayAgentEntryRedactionReason {
  if (value !== "user_request" && value !== "policy" && value !== "retention") {
    throw new RelayAgentAuthorityInputError(`${label} is invalid`);
  }
  return value;
}

function parseMutation(value: unknown): RelayAgentSourceMutation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayAgentAuthorityInputError("mutation must be an object");
  }
  const mutationType = (value as Record<string, unknown>).mutationType;
  switch (mutationType) {
    case "source.started": {
      asClosedObject(value, "mutation", ["mutationType"]);
      return deepFreeze({ mutationType });
    }
    case "lifecycle.changed": {
      const record = asClosedObject(value, "mutation", [
        "mutationType",
        "scope",
        "runId",
        "turnId",
        "state",
        "failure",
      ]);
      return parseLifecycleMutation(record);
    }
    case "text_entry.appended": {
      const record = asClosedObject(value, "mutation", [
        "mutationType",
        "entryId",
        "runId",
        "turnId",
        "role",
        "text",
        "commandId",
      ]);
      if (record.role !== "user" && record.role !== "agent") {
        throw new RelayAgentAuthorityInputError("mutation.role is invalid");
      }
      const commandId = record.commandId === null
        ? null
        : parseOpaqueId(record.commandId, "mutation.commandId");
      if (record.role === "agent" && commandId !== null) {
        throw new RelayAgentAuthorityInputError("agent entry must have commandId=null");
      }
      return deepFreeze({
        mutationType,
        entryId: parseOpaqueId(record.entryId, "mutation.entryId"),
        runId: parseOpaqueId(record.runId, "mutation.runId"),
        turnId: parseOpaqueId(record.turnId, "mutation.turnId"),
        role: record.role,
        text: parseText(record.text, "mutation.text", MAX_TEXT_UTF8_BYTES, true),
        commandId,
      });
    }
    case "entry.redacted":
    case "entry.deleted": {
      const record = asClosedObject(value, "mutation", ["mutationType", "entryId", "reason"]);
      return deepFreeze({
        mutationType,
        entryId: parseOpaqueId(record.entryId, "mutation.entryId"),
        reason: parseRedactionReason(record.reason, "mutation.reason"),
      });
    }
    default:
      throw new RelayAgentAuthorityInputError("mutation.mutationType is not an accepted structured source event");
  }
}

function parseSourceEvent(value: unknown): RelayAgentSourceEvent {
  const record = asClosedObject(value, "source event", [
    "sourceEpoch",
    "sourceSeq",
    "sourceEventId",
    "occurredAtMs",
    "mutation",
  ]);
  return deepFreeze({
    sourceEpoch: parseOpaqueId(record.sourceEpoch, "sourceEpoch"),
    sourceSeq: parseCounter(record.sourceSeq, "sourceSeq", true),
    sourceEventId: parseOpaqueId(record.sourceEventId, "sourceEventId"),
    occurredAtMs: parseSafeTimestamp(record.occurredAtMs, "occurredAtMs"),
    mutation: parseMutation(record.mutation),
  });
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RelayAgentAuthorityInputError("fingerprint contains an invalid number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`
  )).join(",")}}`;
}

function fingerprintSourceEvent(event: RelayAgentSourceEvent): string {
  return createHash("sha256")
    .update(canonicalJson(event as unknown as Json), "utf8")
    .digest("hex");
}

function eventIdFor(binding: RelayAgentAuthorityBinding, agentEventSeq: string): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      hostId: binding.hostId,
      hostEpoch: binding.hostEpoch,
      scopeId: binding.scopeId,
      sessionId: binding.sessionId,
      timelineEpoch: binding.timelineEpoch,
      agentEventSeq,
    }), "utf8")
    .digest("base64url");
  return `agent-event-${digest.slice(0, 32)}`;
}

function isTerminal(state: RelayAgentLifecycleState): boolean {
  return state === "failed" || state === "completed";
}

function turnKey(runId: string, turnId: string): string {
  return JSON.stringify([runId, turnId]);
}

function transitionAllowed(from: RelayAgentLifecycleState, to: RelayAgentLifecycleState): boolean {
  if (from === "running") return to === "waiting_for_user" || to === "failed" || to === "completed";
  if (from === "waiting_for_user") return to === "running" || to === "failed" || to === "completed";
  return false;
}

function rejectedDomain(
  state: RelayAgentAuthorityState,
  disposition: Exclude<DomainReduction["disposition"], "applied">,
): DomainReduction {
  return {
    disposition,
    runs: state.runs,
    turns: state.turns,
    entries: state.entries,
    deletedEntries: state.deletedEntries,
    publicMutation: null,
  };
}

function lifecycleRecord(
  event: RelayAgentSourceEvent,
  mutation: RelayAgentLifecycleChangedMutation,
  agentEventSeq: string,
  eventId: string,
): RelayAgentLifecycleRecord {
  return deepFreeze({
    recordType: "lifecycle",
    lifecycleEventId: eventId,
    sourceEpoch: event.sourceEpoch,
    scope: mutation.scope,
    runId: mutation.runId,
    turnId: mutation.turnId,
    state: mutation.state,
    failure: mutation.failure,
    occurredAtMs: event.occurredAtMs,
    agentEventSeq,
  });
}

function reduceLifecycle(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  mutation: RelayAgentLifecycleChangedMutation,
  agentEventSeq: string,
  eventId: string,
): DomainReduction {
  const record = lifecycleRecord(event, mutation, agentEventSeq, eventId);
  if (mutation.scope === "run") {
    const existing = state.runs[mutation.runId];
    if (!existing) {
      if (mutation.state !== "running") return rejectedDomain(state, "invalid_transition");
      const runs = cloneRecord(state.runs);
      runs[mutation.runId] = deepFreeze({
        runId: mutation.runId,
        sourceEpoch: event.sourceEpoch,
        state: mutation.state,
        turnIds: Object.freeze([]),
        lifecycle: record,
      });
      return {
        disposition: "applied",
        runs: Object.freeze(runs),
        turns: state.turns,
        entries: state.entries,
        deletedEntries: state.deletedEntries,
        publicMutation: deepFreeze({ mutationType: "lifecycle.changed", lifecycle: record }),
      };
    }
    if (existing.sourceEpoch !== event.sourceEpoch) return rejectedDomain(state, "invalid_transition");
    if (isTerminal(existing.state)) {
      if (mutation.state === existing.state) return rejectedDomain(state, "redundant_terminal");
      return rejectedDomain(state, isTerminal(mutation.state) ? "terminal_conflict" : "invalid_transition");
    }
    if (!transitionAllowed(existing.state, mutation.state)) return rejectedDomain(state, "invalid_transition");
    const knownTurns = existing.turnIds
      .map((turnId) => state.turns[turnKey(existing.runId, turnId)])
      .filter((turn) => turn !== undefined);
    if (mutation.state === "waiting_for_user") {
      const active = knownTurns.find((turn) => !isTerminal(turn.state));
      if (active && active.state !== "waiting_for_user") return rejectedDomain(state, "invalid_transition");
    }
    if (isTerminal(mutation.state) && knownTurns.some((turn) => !isTerminal(turn.state))) {
      return rejectedDomain(state, "invalid_transition");
    }
    const runs = cloneRecord(state.runs);
    runs[mutation.runId] = deepFreeze({ ...existing, state: mutation.state, lifecycle: record });
    return {
      disposition: "applied",
      runs: Object.freeze(runs),
      turns: state.turns,
      entries: state.entries,
      deletedEntries: state.deletedEntries,
      publicMutation: deepFreeze({ mutationType: "lifecycle.changed", lifecycle: record }),
    };
  }

  const turnId = mutation.turnId!;
  const compositeTurnKey = turnKey(mutation.runId, turnId);
  const run = state.runs[mutation.runId];
  if (!run || run.sourceEpoch !== event.sourceEpoch) return rejectedDomain(state, "invalid_transition");
  const existing = state.turns[compositeTurnKey];
  if (!existing) {
    if (mutation.state !== "running" || run.state !== "running") {
      return rejectedDomain(state, "invalid_transition");
    }
    const active = run.turnIds
      .map((knownTurnId) => state.turns[turnKey(run.runId, knownTurnId)])
      .find((turn) => turn && !isTerminal(turn.state));
    if (active) return rejectedDomain(state, "invalid_transition");
    const turns = cloneRecord(state.turns);
    turns[compositeTurnKey] = deepFreeze({
      turnId,
      runId: mutation.runId,
      sourceEpoch: event.sourceEpoch,
      state: mutation.state,
      lifecycle: record,
    });
    const runs = cloneRecord(state.runs);
    runs[mutation.runId] = deepFreeze({
      ...run,
      turnIds: Object.freeze([...run.turnIds, turnId]),
    });
    return {
      disposition: "applied",
      runs: Object.freeze(runs),
      turns: Object.freeze(turns),
      entries: state.entries,
      deletedEntries: state.deletedEntries,
      publicMutation: deepFreeze({ mutationType: "lifecycle.changed", lifecycle: record }),
    };
  }
  if (existing.runId !== mutation.runId || existing.sourceEpoch !== event.sourceEpoch) {
    return rejectedDomain(state, "invalid_transition");
  }
  if (isTerminal(existing.state)) {
    if (mutation.state === existing.state) return rejectedDomain(state, "redundant_terminal");
    return rejectedDomain(state, isTerminal(mutation.state) ? "terminal_conflict" : "invalid_transition");
  }
  if (!transitionAllowed(existing.state, mutation.state)) return rejectedDomain(state, "invalid_transition");
  if (mutation.state === "running" && run.state !== "running") {
    return rejectedDomain(state, "invalid_transition");
  }
  if (isTerminal(run.state)) return rejectedDomain(state, "invalid_transition");
  const turns = cloneRecord(state.turns);
  turns[compositeTurnKey] = deepFreeze({ ...existing, state: mutation.state, lifecycle: record });
  return {
    disposition: "applied",
    runs: state.runs,
    turns: Object.freeze(turns),
    entries: state.entries,
    deletedEntries: state.deletedEntries,
    publicMutation: deepFreeze({ mutationType: "lifecycle.changed", lifecycle: record }),
  };
}

function reduceEntryAppend(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  mutation: RelayAgentTextEntryAppendedMutation,
  agentEventSeq: string,
): DomainReduction {
  if (state.deletedEntries[mutation.entryId]) return rejectedDomain(state, "entry_deleted");
  if (state.entries[mutation.entryId]) return rejectedDomain(state, "entry_id_conflict");
  const run = state.runs[mutation.runId];
  const turn = state.turns[turnKey(mutation.runId, mutation.turnId)];
  if (
    !run
    || !turn
    || run.sourceEpoch !== event.sourceEpoch
    || turn.sourceEpoch !== event.sourceEpoch
    || turn.runId !== mutation.runId
  ) {
    return rejectedDomain(state, "invalid_transition");
  }
  const allowed = mutation.role === "agent"
    ? turn.state === "running"
    : turn.state === "running" || turn.state === "waiting_for_user";
  if (!allowed) return rejectedDomain(state, "invalid_transition");
  const entry: RelayAgentTextEntryRecord = deepFreeze({
    recordType: "text_entry",
    entryId: mutation.entryId,
    runId: mutation.runId,
    turnId: mutation.turnId,
    role: mutation.role,
    state: "visible",
    text: mutation.text,
    redactionReason: null,
    commandId: mutation.commandId,
    createdAtMs: event.occurredAtMs,
    createdAgentSeq: agentEventSeq,
    lastModifiedAgentSeq: agentEventSeq,
  });
  const entries = cloneRecord(state.entries);
  entries[mutation.entryId] = entry;
  return {
    disposition: "applied",
    runs: state.runs,
    turns: state.turns,
    entries: Object.freeze(entries),
    deletedEntries: state.deletedEntries,
    publicMutation: deepFreeze({ mutationType: "text_entry.appended", entry }),
  };
}

function reduceEntryRedaction(
  state: RelayAgentAuthorityState,
  mutation: RelayAgentEntryRedactedMutation,
  agentEventSeq: string,
): DomainReduction {
  if (state.deletedEntries[mutation.entryId]) return rejectedDomain(state, "entry_deleted");
  const existing = state.entries[mutation.entryId];
  if (!existing || existing.state !== "visible") return rejectedDomain(state, "invalid_transition");
  const entries = cloneRecord(state.entries);
  entries[mutation.entryId] = deepFreeze({
    ...existing,
    state: "redacted",
    text: null,
    redactionReason: mutation.reason,
    lastModifiedAgentSeq: agentEventSeq,
  });
  return {
    disposition: "applied",
    runs: state.runs,
    turns: state.turns,
    entries: Object.freeze(entries),
    deletedEntries: state.deletedEntries,
    publicMutation: deepFreeze({
      mutationType: "entry.redacted",
      entryId: mutation.entryId,
      reason: mutation.reason,
    }),
  };
}

function reduceEntryDelete(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  mutation: RelayAgentEntryDeletedMutation,
  agentEventSeq: string,
): DomainReduction {
  if (state.deletedEntries[mutation.entryId]) return rejectedDomain(state, "entry_deleted");
  if (!state.entries[mutation.entryId]) return rejectedDomain(state, "invalid_transition");
  const deletedEntries = cloneRecord(state.deletedEntries);
  deletedEntries[mutation.entryId] = deepFreeze({
    entryId: mutation.entryId,
    sourceEpoch: event.sourceEpoch,
    reason: mutation.reason,
    deletedAgentSeq: agentEventSeq,
  });
  return {
    disposition: "applied",
    runs: state.runs,
    turns: state.turns,
    entries: withoutRecordKey(state.entries, mutation.entryId),
    deletedEntries: Object.freeze(deletedEntries),
    publicMutation: deepFreeze({
      mutationType: "entry.deleted",
      entryId: mutation.entryId,
      reason: mutation.reason,
    }),
  };
}

function reduceDomain(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  agentEventSeq: string,
  eventId: string,
): DomainReduction {
  switch (event.mutation.mutationType) {
    case "source.started":
      return {
        disposition: "applied",
        runs: state.runs,
        turns: state.turns,
        entries: state.entries,
        deletedEntries: state.deletedEntries,
        publicMutation: deepFreeze({
          mutationType: "source.availability",
          state: "connected",
          sourceEpoch: event.sourceEpoch,
          reason: state.activeSourceEpoch === null ? null : "source_restarted",
        }),
      };
    case "lifecycle.changed":
      return reduceLifecycle(state, event, event.mutation, agentEventSeq, eventId);
    case "text_entry.appended":
      return reduceEntryAppend(state, event, event.mutation, agentEventSeq);
    case "entry.redacted":
      return reduceEntryRedaction(state, event.mutation, agentEventSeq);
    case "entry.deleted":
      return reduceEntryDelete(state, event, event.mutation, agentEventSeq);
  }
}

function result(
  state: RelayAgentAuthorityState,
  disposition: RelayAgentAuthorityDisposition,
  options: {
    expectedSourceSeq?: string | null;
    publicEvent?: RelayAgentAuthorityPublicEvent | null;
    sourceFenced?: boolean;
  } = {},
): RelayAgentAuthorityReduction {
  return deepFreeze({
    state,
    disposition,
    agentEventSeq: state.agentEventSeq,
    expectedSourceSeq: options.expectedSourceSeq ?? null,
    publicEvent: options.publicEvent ?? null,
    sourceFenced: options.sourceFenced ?? false,
  });
}

function fenceSource(
  state: RelayAgentAuthorityState,
  source: RelayAgentSourceAuthorityState,
): RelayAgentAuthorityState {
  if (source.fenced) return state;
  const sources = cloneRecord(state.sources);
  sources[source.sourceEpoch] = deepFreeze({ ...source, fenced: true });
  return deepFreeze({ ...state, sources: Object.freeze(sources) });
}

export function createRelayAgentAuthorityState(binding: RelayAgentAuthorityBinding): RelayAgentAuthorityState {
  const parsed = asClosedObject(binding, "authority binding", [
    "hostId",
    "hostEpoch",
    "scopeId",
    "sessionId",
    "timelineEpoch",
  ]);
  const normalizedBinding = deepFreeze({
    hostId: parseOpaqueId(parsed.hostId, "binding.hostId"),
    hostEpoch: parseOpaqueId(parsed.hostEpoch, "binding.hostEpoch"),
    scopeId: parseOpaqueId(parsed.scopeId, "binding.scopeId"),
    sessionId: parseOpaqueId(parsed.sessionId, "binding.sessionId"),
    timelineEpoch: parseOpaqueId(parsed.timelineEpoch, "binding.timelineEpoch"),
  });
  return deepFreeze({
    schemaVersion: 1,
    binding: normalizedBinding,
    agentEventSeq: "0",
    activeSourceEpoch: null,
    sources: emptyRecord(),
    runs: emptyRecord(),
    turns: emptyRecord(),
    entries: emptyRecord(),
    deletedEntries: emptyRecord(),
  });
}

/**
 * Pure authority transition. It performs no I/O, persistence, transport,
 * capability advertisement, snapshot, replay, command, or terminal work.
 * A caller must atomically persist the returned state and publicEvent before
 * acknowledging any result whose state differs from the input state.
 */
export function reduceRelayAgentAuthority(
  state: RelayAgentAuthorityState,
  sourceInput: unknown,
): RelayAgentAuthorityReduction {
  const event = parseSourceEvent(sourceInput);
  const fingerprintDigest = fingerprintSourceEvent(event);
  const source = state.sources[event.sourceEpoch];

  if (state.activeSourceEpoch !== null && event.sourceEpoch !== state.activeSourceEpoch && source) {
    return result(state, "stale_source");
  }

  if (source?.fenced) return result(state, "source_event_conflict", { sourceFenced: true });

  const retained = source?.dedupe[event.sourceEventId];
  if (retained) {
    if (retained.fingerprintDigest === fingerprintDigest) return result(state, "duplicate");
    const fencedState = fenceSource(state, source);
    return result(fencedState, "source_event_conflict", { sourceFenced: true });
  }

  if (source && BigInt(event.sourceSeq) <= BigInt(source.lastSourceSeq)) {
    return result(state, "source_history_expired");
  }

  if (state.activeSourceEpoch !== null && event.sourceEpoch !== state.activeSourceEpoch) {
    if (event.mutation.mutationType !== "source.started" || event.sourceSeq !== "1") {
      return result(state, "source_gap", { expectedSourceSeq: "1" });
    }
  }

  const expectedSourceSeq = source ? incrementCounter(source.lastSourceSeq, "sourceSeq") : "1";
  if (event.sourceSeq !== expectedSourceSeq) {
    return result(state, "source_gap", { expectedSourceSeq });
  }
  if (
    (!source && event.mutation.mutationType !== "source.started")
    || (source && event.mutation.mutationType === "source.started")
  ) {
    return result(state, "invalid_transition");
  }

  const nextAgentEventSeq = incrementCounter(state.agentEventSeq, "agentEventSeq");
  const eventId = eventIdFor(state.binding, nextAgentEventSeq);
  const domain = reduceDomain(state, event, nextAgentEventSeq, eventId);
  if (domain.disposition !== "applied" && domain.disposition !== "redundant_terminal") {
    return result(state, domain.disposition);
  }

  const dedupe = cloneRecord(source?.dedupe ?? emptyRecord<RelayAgentSourceDedupeEvidence>());
  dedupe[event.sourceEventId] = deepFreeze({
    sessionId: state.binding.sessionId,
    timelineEpoch: state.binding.timelineEpoch,
    sourceEpoch: event.sourceEpoch,
    sourceEventId: event.sourceEventId,
    sourceSeq: event.sourceSeq,
    fingerprintAlgorithm: "sha256-canonical-json",
    fingerprintDigest,
  });
  const nextSource: RelayAgentSourceAuthorityState = deepFreeze({
    sourceEpoch: event.sourceEpoch,
    lastSourceSeq: event.sourceSeq,
    fenced: false,
    dedupe: Object.freeze(dedupe),
  });
  const sources = cloneRecord(state.sources);
  sources[event.sourceEpoch] = nextSource;

  if (domain.disposition === "redundant_terminal") {
    const nextState = deepFreeze({ ...state, sources: Object.freeze(sources) });
    return result(nextState, "redundant_terminal");
  }

  const publicEvent: RelayAgentAuthorityPublicEvent = deepFreeze({
    ...state.binding,
    agentEventSeq: nextAgentEventSeq,
    eventId,
    occurredAtMs: event.occurredAtMs,
    mutation: domain.publicMutation!,
  });
  const nextState: RelayAgentAuthorityState = deepFreeze({
    ...state,
    agentEventSeq: nextAgentEventSeq,
    activeSourceEpoch: event.mutation.mutationType === "source.started"
      ? event.sourceEpoch
      : state.activeSourceEpoch,
    sources: Object.freeze(sources),
    runs: domain.runs,
    turns: domain.turns,
    entries: domain.entries,
    deletedEntries: domain.deletedEntries,
  });
  return result(nextState, "applied", { publicEvent });
}
