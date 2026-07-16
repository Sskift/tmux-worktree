import {
  RELAY_V2_PUBLIC_FRAME_BYTES,
  type RelayV2FrameMetadata,
} from "../../../v2/codec.js";
import type {
  RelayV2JsonObject,
} from "../../../v2/codecSchema.js";
import {
  decodeRelayV2StrictUtf8,
  inspectRelayV2Json,
  parseRelayV2JsonObject,
  RelayV2JsonError,
  type RelayV2JsonLimits,
  type RelayV2JsonValue,
} from "../../../v2/strictJson.js";

export const RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY =
  "agent.transcript-lifecycle.v1" as const;
export const RELAY_AGENT_MAX_TEXT_UTF8_BYTES = 65_536;
export const RELAY_AGENT_MAX_FAILURE_SUMMARY_UTF8_BYTES = 1_024;
export const RELAY_AGENT_MAX_PAGE_RECORDS = 256;
export const RELAY_AGENT_MIN_REPLAY_RETENTION_MS = 86_400_000;
export const RELAY_AGENT_DEFAULT_REPLAY_RETENTION_MS = 604_800_000;
export const RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS = 300_000;
export const RELAY_AGENT_CODEC_ERROR_DOMAIN =
  "relay-agent-transcript-lifecycle-codec-v1" as const;

export type RelayAgentCodecErrorCode = "INVALID_ENVELOPE" | "PROTOCOL_UNSUPPORTED";

export interface RelayAgentCodecFailure {
  domain: typeof RELAY_AGENT_CODEC_ERROR_DOMAIN;
  code: RelayAgentCodecErrorCode;
  failureClass: string;
}

export class RelayAgentTranscriptLifecycleCodecError extends Error
  implements RelayAgentCodecFailure {
  readonly domain = RELAY_AGENT_CODEC_ERROR_DOMAIN;

  constructor(
    readonly code: RelayAgentCodecErrorCode,
    readonly failureClass: string,
  ) {
    super(
      code === "PROTOCOL_UNSUPPORTED"
        ? "Relay Agent extension transport encoding is unsupported"
        : "Relay Agent extension frame is invalid",
    );
    this.name = "RelayAgentTranscriptLifecycleCodecError";
  }
}

/** Stable cross-bundle classification seam; callers must not use instanceof. */
export function relayAgentCodecFailure(error: unknown): RelayAgentCodecFailure | null {
  if (error === null || typeof error !== "object") return null;
  const candidate = error as Partial<RelayAgentCodecFailure>;
  if (candidate.domain !== RELAY_AGENT_CODEC_ERROR_DOMAIN
    || (candidate.code !== "INVALID_ENVELOPE" && candidate.code !== "PROTOCOL_UNSUPPORTED")
    || typeof candidate.failureClass !== "string"
    || candidate.failureClass.length === 0
    || Buffer.byteLength(candidate.failureClass, "utf8") > 128) {
    return null;
  }
  return Object.freeze({
    domain: RELAY_AGENT_CODEC_ERROR_DOMAIN,
    code: candidate.code,
    failureClass: candidate.failureClass,
  });
}

const UINT64_MAX = 18_446_744_073_709_551_615n;
const STANDARD_JSON_LIMITS: RelayV2JsonLimits = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
});
const PAGED_JSON_LIMITS: RelayV2JsonLimits = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: 8_192,
  maxNodes: 16_384,
});
const PAGED_TYPES = new Set([
  "agent.timeline.snapshot.page",
  "agent.timeline.replay.page",
]);
const EXTENSION_ERROR_CODES = new Set([
  "AGENT_TIMELINE_UNAVAILABLE",
  "AGENT_CURSOR_EXPIRED",
  "AGENT_CURSOR_AHEAD",
  "AGENT_SNAPSHOT_EXPIRED",
  "AGENT_TIMELINE_EPOCH_MISMATCH",
  // This base-v2 lineage error remains owned by the base envelope.
  "HOST_EPOCH_MISMATCH",
]);

export interface RelayAgentTranscriptLifecycleNormalizedFrame {
  channel: "public";
  version: 2;
  capability: typeof RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY;
  kind: "request" | "response" | "event";
  type: string;
  requestId: string | null;
}

export interface RelayAgentTranscriptLifecycleDecodedFrame {
  frame: RelayV2JsonObject;
  normalized: RelayAgentTranscriptLifecycleNormalizedFrame;
  canonicalWire: string;
}

class RelayAgentSchemaError extends Error {
  constructor(readonly failureClass: string) {
    super("Relay Agent extension frame does not match the frozen schema");
    this.name = "RelayAgentSchemaError";
  }
}

function reject(failureClass: string): never {
  throw new RelayAgentSchemaError(failureClass);
}

function codecFailure(error: unknown): never {
  if (relayAgentCodecFailure(error) !== null) throw error;
  if (error instanceof RelayV2JsonError || error instanceof RelayAgentSchemaError) {
    throw new RelayAgentTranscriptLifecycleCodecError("INVALID_ENVELOPE", error.failureClass);
  }
  throw error;
}

function object(value: RelayV2JsonValue): RelayV2JsonObject {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "object" || Array.isArray(value)) reject("type-coercion");
  return value;
}

function exact(
  value: RelayV2JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) reject("missing-field");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reject("unknown-field");
  }
}

function field(value: RelayV2JsonObject, name: string): RelayV2JsonValue {
  if (!Object.hasOwn(value, name)) reject("missing-field");
  return value[name]!;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject("invalid-utf8");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      reject("invalid-utf8");
    }
  }
}

function stringValue(
  value: RelayV2JsonValue,
  options: {
    allowEmpty?: boolean;
    allowOuterWhitespace?: boolean;
    maxBytes?: number;
  } = {},
): string {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  assertWellFormedUnicode(value);
  if (!options.allowEmpty && value.length === 0) reject("invalid-argument");
  if (value.includes("\0")) reject("invalid-argument");
  if (!options.allowOuterWhitespace && value.trim() !== value) reject("invalid-argument");
  if (options.maxBytes !== undefined && Buffer.byteLength(value, "utf8") > options.maxBytes) {
    reject("id-byte-limit");
  }
  return value;
}

function id(value: RelayV2JsonValue): string {
  return stringValue(value, { maxBytes: 128 });
}

function cursor(value: RelayV2JsonValue): string {
  return stringValue(value, { maxBytes: 1_024 });
}

function text(value: RelayV2JsonValue, maxBytes: number): string {
  return stringValue(value, {
    allowEmpty: true,
    allowOuterWhitespace: true,
    maxBytes,
  });
}

function literal<T extends string | number | boolean>(value: RelayV2JsonValue, expected: T): T {
  if (value !== expected) {
    if (value === null) reject("forbidden-null");
    reject("schema-mismatch");
  }
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: RelayV2JsonValue,
  allowed: T,
): T[number] {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  if (!(allowed as readonly string[]).includes(value)) reject("schema-mismatch");
  return value as T[number];
}

function nullable<T>(value: RelayV2JsonValue, validator: (item: RelayV2JsonValue) => T): T | null {
  return value === null ? null : validator(value);
}

function booleanValue(value: RelayV2JsonValue): boolean {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "boolean") reject("type-coercion");
  return value;
}

function integer(value: RelayV2JsonValue, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    reject("type-coercion");
  }
  if (value < minimum || value > maximum) reject("invalid-argument");
  return value;
}

function counter(value: RelayV2JsonValue): string {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) reject("non-canonical-counter");
  if (BigInt(value) > UINT64_MAX) reject("counter-overflow");
  return value;
}

function positiveCounter(value: RelayV2JsonValue): string {
  const parsed = counter(value);
  if (parsed === "0") reject("invalid-argument");
  return parsed;
}

function array(
  value: RelayV2JsonValue,
  validator: (item: RelayV2JsonValue, index: number) => void,
  maximum: number,
  minimum = 0,
): RelayV2JsonValue[] {
  if (value === null) reject("forbidden-null");
  if (!Array.isArray(value)) reject("type-coercion");
  if (value.length < minimum || value.length > maximum) reject("invalid-argument");
  value.forEach(validator);
  return value;
}

function compareCounter(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function nextCounter(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > UINT64_MAX) reject("counter-overflow");
  return next.toString();
}

function validateRoot(
  frame: RelayV2JsonObject,
  kind: "request" | "response" | "event",
  type: string,
  required: readonly string[],
): void {
  exact(frame, ["protocolVersion", "kind", "type", ...required]);
  literal(field(frame, "protocolVersion"), 2);
  literal(field(frame, "kind"), kind);
  literal(field(frame, "type"), type);
  for (const name of [
    "requestId", "hostId", "expectedHostEpoch", "hostEpoch", "scopeId", "sessionId",
  ]) {
    if (Object.hasOwn(frame, name)) id(frame[name]!);
  }
}

function validateTargetRequest(frame: RelayV2JsonObject, type: string): void {
  validateRoot(frame, "request", type, [
    "requestId", "hostId", "expectedHostEpoch", "scopeId", "sessionId", "payload",
  ]);
}

function validateTargetResponse(frame: RelayV2JsonObject, type: string): void {
  validateRoot(frame, "response", type, [
    "requestId", "hostId", "hostEpoch", "scopeId", "sessionId", "payload",
  ]);
}

function validateTargetEvent(frame: RelayV2JsonObject, type: string): void {
  validateRoot(frame, "event", type, [
    "hostId", "hostEpoch", "scopeId", "sessionId", "payload",
  ]);
}

function validateFailure(value: RelayV2JsonValue, state: string): void {
  if (state !== "failed") {
    if (value !== null) reject("schema-mismatch");
    return;
  }
  const failure = object(value);
  exact(failure, ["code", "summary"]);
  id(field(failure, "code"));
  nullable(field(failure, "summary"), (item) => (
    text(item, RELAY_AGENT_MAX_FAILURE_SUMMARY_UTF8_BYTES)
  ));
}

function validateLifecycleRecord(value: RelayV2JsonValue): RelayV2JsonObject {
  const record = object(value);
  exact(record, [
    "recordType", "lifecycleEventId", "sourceEpoch", "scope", "runId", "turnId",
    "state", "failure", "occurredAtMs", "agentEventSeq",
  ]);
  literal(field(record, "recordType"), "lifecycle");
  id(field(record, "lifecycleEventId"));
  id(field(record, "sourceEpoch"));
  const scope = oneOf(field(record, "scope"), ["run", "turn"] as const);
  id(field(record, "runId"));
  if (scope === "run") {
    if (field(record, "turnId") !== null) reject("schema-mismatch");
  } else {
    id(field(record, "turnId"));
  }
  const state = oneOf(
    field(record, "state"),
    ["running", "waiting_for_user", "failed", "completed"] as const,
  );
  validateFailure(field(record, "failure"), state);
  integer(field(record, "occurredAtMs"));
  positiveCounter(field(record, "agentEventSeq"));
  return record;
}

function validateTextEntryRecord(value: RelayV2JsonValue): RelayV2JsonObject {
  const record = object(value);
  exact(record, [
    "recordType", "entryId", "runId", "turnId", "role", "state", "text",
    "redactionReason", "commandId", "createdAtMs", "createdAgentSeq", "lastModifiedAgentSeq",
  ]);
  literal(field(record, "recordType"), "text_entry");
  id(field(record, "entryId"));
  id(field(record, "runId"));
  id(field(record, "turnId"));
  const role = oneOf(field(record, "role"), ["user", "agent"] as const);
  const state = oneOf(field(record, "state"), ["visible", "redacted"] as const);
  if (state === "visible") {
    text(field(record, "text"), RELAY_AGENT_MAX_TEXT_UTF8_BYTES);
    if (field(record, "redactionReason") !== null) reject("schema-mismatch");
  } else {
    if (field(record, "text") !== null) reject("schema-mismatch");
    oneOf(field(record, "redactionReason"), ["user_request", "policy", "retention"] as const);
  }
  const commandId = nullable(field(record, "commandId"), id);
  if (role === "agent" && commandId !== null) reject("schema-mismatch");
  integer(field(record, "createdAtMs"));
  const created = positiveCounter(field(record, "createdAgentSeq"));
  const modified = positiveCounter(field(record, "lastModifiedAgentSeq"));
  if (compareCounter(created, modified) > 0) reject("schema-mismatch");
  if (state === "visible" && created !== modified) reject("schema-mismatch");
  if (state === "redacted" && created === modified) reject("schema-mismatch");
  return record;
}

function validateMutation(
  value: RelayV2JsonValue,
  publicIdentity?: { agentEventSeq: string; eventId: string; occurredAtMs: number },
): RelayV2JsonObject {
  const mutation = object(value);
  const mutationType = stringValue(field(mutation, "mutationType"), { maxBytes: 128 });
  switch (mutationType) {
    case "text_entry.appended": {
      exact(mutation, ["mutationType", "entry"]);
      const entry = validateTextEntryRecord(field(mutation, "entry"));
      if (entry.state !== "visible") reject("schema-mismatch");
      if (publicIdentity && (
        entry.createdAgentSeq !== publicIdentity.agentEventSeq
        || entry.lastModifiedAgentSeq !== publicIdentity.agentEventSeq
        || entry.createdAtMs !== publicIdentity.occurredAtMs
      )) reject("schema-mismatch");
      break;
    }
    case "entry.redacted":
    case "entry.deleted":
      exact(mutation, ["mutationType", "entryId", "reason"]);
      id(field(mutation, "entryId"));
      oneOf(field(mutation, "reason"), ["user_request", "policy", "retention"] as const);
      break;
    case "lifecycle.changed": {
      exact(mutation, ["mutationType", "lifecycle"]);
      const lifecycle = validateLifecycleRecord(field(mutation, "lifecycle"));
      if (publicIdentity && (
        lifecycle.lifecycleEventId !== publicIdentity.eventId
        || lifecycle.agentEventSeq !== publicIdentity.agentEventSeq
        || lifecycle.occurredAtMs !== publicIdentity.occurredAtMs
      )) reject("schema-mismatch");
      break;
    }
    case "source.availability": {
      exact(mutation, ["mutationType", "state", "sourceEpoch", "reason"]);
      const state = oneOf(field(mutation, "state"), ["connected", "interrupted"] as const);
      id(field(mutation, "sourceEpoch"));
      const reason = nullable(
        field(mutation, "reason"),
        (item) => oneOf(item, ["source_disconnected", "source_restarted"] as const),
      );
      if ((state === "interrupted" && reason !== "source_disconnected")
        || (state === "connected" && reason !== null && reason !== "source_restarted")) {
        reject("schema-mismatch");
      }
      break;
    }
    default:
      reject("unknown-message-type");
  }
  return mutation;
}

function validatePublicEventItem(value: RelayV2JsonValue): RelayV2JsonObject {
  const event = object(value);
  exact(event, ["agentEventSeq", "eventId", "occurredAtMs", "mutation"]);
  const agentEventSeq = positiveCounter(field(event, "agentEventSeq"));
  const eventId = id(field(event, "eventId"));
  const occurredAtMs = integer(field(event, "occurredAtMs"));
  validateMutation(field(event, "mutation"), { agentEventSeq, eventId, occurredAtMs });
  return event;
}

function snapshotRecordOrder(record: RelayV2JsonObject): readonly [string, string] {
  if (record.recordType === "lifecycle") {
    return [record.agentEventSeq as string, record.lifecycleEventId as string];
  }
  return [record.createdAgentSeq as string, record.entryId as string];
}

function validateSnapshotRecords(value: RelayV2JsonValue, throughAgentSeq: string): void {
  let previous: readonly [string, string] | null = null;
  array(value, (item) => {
    const record = object(item);
    if (record.recordType === "lifecycle") {
      validateLifecycleRecord(record);
      if (compareCounter(record.agentEventSeq as string, throughAgentSeq) > 0) {
        reject("schema-mismatch");
      }
    } else if (record.recordType === "text_entry") {
      validateTextEntryRecord(record);
      if (compareCounter(record.createdAgentSeq as string, throughAgentSeq) > 0
        || compareCounter(record.lastModifiedAgentSeq as string, throughAgentSeq) > 0) {
        reject("schema-mismatch");
      }
    } else reject("schema-mismatch");
    const current = snapshotRecordOrder(record);
    if (previous !== null) {
      const sequenceOrder = compareCounter(previous[0], current[0]);
      if (sequenceOrder > 0 || (sequenceOrder === 0 && Buffer.compare(
        Buffer.from(previous[1], "utf8"),
        Buffer.from(current[1], "utf8"),
      ) >= 0)) reject("schema-mismatch");
    }
    previous = current;
  }, RELAY_AGENT_MAX_PAGE_RECORDS);
}

function validateStatusPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, [
    "capability", "support", "reason", "liveSource", "activeSourceEpoch", "timelineEpoch",
    "currentAgentSeq", "earliestReplaySeq", "limits",
  ]);
  literal(field(payload, "capability"), RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY);
  const support = oneOf(field(payload, "support"), ["available", "unavailable"] as const);
  if (support === "unavailable") {
    oneOf(field(payload, "reason"), [
      "agent_unsupported", "session_not_agent_managed", "adapter_unavailable", "store_unavailable",
    ] as const);
    literal(field(payload, "liveSource"), "absent");
    for (const name of [
      "activeSourceEpoch", "timelineEpoch", "currentAgentSeq", "earliestReplaySeq", "limits",
    ]) {
      if (field(payload, name) !== null) reject("schema-mismatch");
    }
    return;
  }
  if (field(payload, "reason") !== null) reject("schema-mismatch");
  oneOf(field(payload, "liveSource"), ["connected", "interrupted"] as const);
  id(field(payload, "activeSourceEpoch"));
  id(field(payload, "timelineEpoch"));
  const current = counter(field(payload, "currentAgentSeq"));
  const earliest = counter(field(payload, "earliestReplaySeq"));
  if (compareCounter(earliest, current) > 0) reject("schema-mismatch");
  const limits = object(field(payload, "limits"));
  exact(limits, ["maxTextUtf8Bytes", "maxPageRecords", "eventReplayRetentionMs", "snapshotLeaseMs"]);
  literal(field(limits, "maxTextUtf8Bytes"), RELAY_AGENT_MAX_TEXT_UTF8_BYTES);
  literal(field(limits, "maxPageRecords"), RELAY_AGENT_MAX_PAGE_RECORDS);
  integer(field(limits, "eventReplayRetentionMs"), RELAY_AGENT_MIN_REPLAY_RETENTION_MS);
  literal(field(limits, "snapshotLeaseMs"), RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS);
}

function validateStructuredError(value: RelayV2JsonValue): void {
  const error = object(value);
  exact(error, ["code", "message", "retryable", "commandDisposition"], ["retryAfterMs", "details"]);
  const code = stringValue(field(error, "code"), { maxBytes: 128 });
  if (!EXTENSION_ERROR_CODES.has(code)) reject("schema-mismatch");
  text(field(error, "message"), 4_096);
  booleanValue(field(error, "retryable"));
  literal(field(error, "commandDisposition"), "not_applicable");
  if (Object.hasOwn(error, "retryAfterMs")) {
    nullable(field(error, "retryAfterMs"), (item) => integer(item));
  }
  if (code === "HOST_EPOCH_MISMATCH") {
    if (!Object.hasOwn(error, "details") || error.details === null) reject("schema-mismatch");
  } else {
    if (!Object.hasOwn(error, "details") || error.details === null) return;
    reject("schema-mismatch");
  }
  const details = object(error.details);
  exact(details, ["expectedHostEpoch", "actualHostEpoch"]);
  id(field(details, "expectedHostEpoch"));
  id(field(details, "actualHostEpoch"));
}

export function validateRelayAgentTranscriptLifecycleFrame(
  frame: RelayV2JsonObject,
): RelayAgentTranscriptLifecycleNormalizedFrame {
  const type = stringValue(field(frame, "type"), { maxBytes: 128 });
  switch (type) {
    case "agent.timeline.status.get": {
      validateTargetRequest(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, []);
      break;
    }
    case "agent.timeline.status":
      validateTargetResponse(frame, type);
      validateStatusPayload(field(frame, "payload"));
      break;
    case "agent.timeline.snapshot.get": {
      validateTargetRequest(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, ["snapshotRequestId", "snapshotId", "cursor", "nextPageIndex"]);
      id(field(payload, "snapshotRequestId"));
      const snapshotId = nullable(field(payload, "snapshotId"), id);
      const nextCursor = nullable(field(payload, "cursor"), cursor);
      const nextPageIndex = integer(field(payload, "nextPageIndex"));
      if ((snapshotId === null) !== (nextCursor === null)
        || (snapshotId === null && nextPageIndex !== 0)
        || (snapshotId !== null && nextPageIndex === 0)) reject("schema-mismatch");
      break;
    }
    case "agent.timeline.snapshot.page": {
      validateTargetResponse(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "capability", "timelineEpoch", "snapshotRequestId", "snapshotId", "pageIndex",
        "isLast", "nextCursor", "throughAgentSeq", "earliestRetainedSeq", "records",
      ]);
      literal(field(payload, "capability"), RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY);
      id(field(payload, "timelineEpoch"));
      id(field(payload, "snapshotRequestId"));
      id(field(payload, "snapshotId"));
      integer(field(payload, "pageIndex"));
      const isLast = booleanValue(field(payload, "isLast"));
      const next = nullable(field(payload, "nextCursor"), cursor);
      if (isLast === (next !== null)) reject("schema-mismatch");
      const through = counter(field(payload, "throughAgentSeq"));
      const earliest = counter(field(payload, "earliestRetainedSeq"));
      if (compareCounter(earliest, through) > 0) reject("schema-mismatch");
      validateSnapshotRecords(field(payload, "records"), through);
      break;
    }
    case "agent.timeline.replay.get": {
      validateTargetRequest(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, ["timelineEpoch", "afterAgentSeq", "cursor", "limit"]);
      id(field(payload, "timelineEpoch"));
      counter(field(payload, "afterAgentSeq"));
      nullable(field(payload, "cursor"), cursor);
      integer(field(payload, "limit"), 1, RELAY_AGENT_MAX_PAGE_RECORDS);
      break;
    }
    case "agent.timeline.replay.page": {
      validateTargetResponse(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "capability", "timelineEpoch", "afterAgentSeq", "replayThroughAgentSeq",
        "isLast", "nextCursor", "events",
      ]);
      literal(field(payload, "capability"), RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY);
      id(field(payload, "timelineEpoch"));
      const after = counter(field(payload, "afterAgentSeq"));
      const through = counter(field(payload, "replayThroughAgentSeq"));
      if (compareCounter(after, through) > 0) reject("schema-mismatch");
      const isLast = booleanValue(field(payload, "isLast"));
      const next = nullable(field(payload, "nextCursor"), cursor);
      if (isLast === (next !== null)) reject("schema-mismatch");
      let previous: string | null = null;
      const events = array(field(payload, "events"), (item) => {
        const event = validatePublicEventItem(item);
        if (compareCounter(event.agentEventSeq as string, after) <= 0
          || compareCounter(event.agentEventSeq as string, through) > 0
          || (previous !== null && event.agentEventSeq !== nextCounter(previous))) {
          reject("schema-mismatch");
        }
        previous = event.agentEventSeq as string;
      }, RELAY_AGENT_MAX_PAGE_RECORDS);
      if (!isLast && events.length === 0) reject("schema-mismatch");
      if (isLast && (
        (events.length === 0 && after !== through)
        || (events.length > 0 && previous !== through)
      )) reject("schema-mismatch");
      break;
    }
    case "agent.timeline.event": {
      validateTargetEvent(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "capability", "timelineEpoch", "agentEventSeq", "eventId", "occurredAtMs", "mutation",
      ]);
      literal(field(payload, "capability"), RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY);
      id(field(payload, "timelineEpoch"));
      const agentEventSeq = positiveCounter(field(payload, "agentEventSeq"));
      const eventId = id(field(payload, "eventId"));
      const occurredAtMs = integer(field(payload, "occurredAtMs"));
      validateMutation(field(payload, "mutation"), { agentEventSeq, eventId, occurredAtMs });
      break;
    }
    case "agent.timeline.reset": {
      validateTargetEvent(frame, type);
      const payload = object(field(frame, "payload"));
      exact(payload, ["capability", "previousTimelineEpoch", "newTimelineEpoch", "reason"]);
      literal(field(payload, "capability"), RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY);
      id(field(payload, "previousTimelineEpoch"));
      const next = nullable(field(payload, "newTimelineEpoch"), id);
      const reason = oneOf(field(payload, "reason"), ["deleted", "store_reset"] as const);
      if ((reason === "deleted") !== (next !== null)) reject("schema-mismatch");
      break;
    }
    case "error": {
      validateRoot(frame, "response", type, [
        "requestId", "hostId", "hostEpoch", "scopeId", "sessionId", "payload", "error",
      ]);
      if (field(frame, "payload") !== null) reject("schema-mismatch");
      validateStructuredError(field(frame, "error"));
      break;
    }
    default:
      reject("unknown-message-type");
  }
  return Object.freeze({
    channel: "public",
    version: 2,
    capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
    kind: frame.kind as "request" | "response" | "event",
    type,
    requestId: Object.hasOwn(frame, "requestId") ? frame.requestId as string : null,
  });
}

function parseFrame(bytes: Uint8Array, metadata: RelayV2FrameMetadata): RelayV2JsonObject {
  if ((metadata.opcode ?? "text") !== "text") {
    throw new RelayAgentTranscriptLifecycleCodecError("INVALID_ENVELOPE", "binary-frame");
  }
  if (metadata.compressed === true) {
    throw new RelayAgentTranscriptLifecycleCodecError("PROTOCOL_UNSUPPORTED", "compression-not-allowed");
  }
  if (bytes.byteLength > RELAY_V2_PUBLIC_FRAME_BYTES) {
    throw new RelayAgentTranscriptLifecycleCodecError("INVALID_ENVELOPE", "frame-limit");
  }
  const source = decodeRelayV2StrictUtf8(bytes);
  const inspection = inspectRelayV2Json(source, PAGED_JSON_LIMITS);
  const limits = inspection.rootIsObject
    && inspection.rootType !== null
    && PAGED_TYPES.has(inspection.rootType)
    ? PAGED_JSON_LIMITS
    : STANDARD_JSON_LIMITS;
  if (inspection.totalKeys > limits.maxTotalKeys) {
    throw new RelayAgentTranscriptLifecycleCodecError("INVALID_ENVELOPE", "json-total-key-limit");
  }
  if (inspection.totalNodes > limits.maxNodes) {
    throw new RelayAgentTranscriptLifecycleCodecError("INVALID_ENVELOPE", "json-node-limit");
  }
  return parseRelayV2JsonObject(source, limits);
}

export function decodeRelayAgentTranscriptLifecycleFrame(
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata = {},
): RelayAgentTranscriptLifecycleDecodedFrame {
  try {
    const frame = parseFrame(bytes, metadata);
    return Object.freeze({
      frame,
      normalized: validateRelayAgentTranscriptLifecycleFrame(frame),
      canonicalWire: JSON.stringify(frame),
    });
  } catch (error) {
    return codecFailure(error);
  }
}

export function encodeRelayAgentTranscriptLifecycleFrame(
  frame: RelayV2JsonObject,
): Uint8Array {
  try {
    validateRelayAgentTranscriptLifecycleFrame(frame);
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    // The outbound boundary must enforce the same byte, direct-key, total-key,
    // node, depth, UTF-8, and closed-schema limits as the inbound boundary.
    // This also makes the durable page freezer a faithful wire preflight.
    validateRelayAgentTranscriptLifecycleFrame(parseFrame(bytes, {}));
    return bytes;
  } catch (error) {
    return codecFailure(error);
  }
}
