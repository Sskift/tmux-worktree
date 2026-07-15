import type { RelayV2JsonValue } from "./strictJson.js";

export type RelayV2CodecFailureClass =
  | "base64-decoded-limit"
  | "forbidden-null"
  | "id-byte-limit"
  | "invalid-argument"
  | "missing-field"
  | "non-canonical-base64"
  | "non-canonical-base64url"
  | "non-canonical-counter"
  | "counter-overflow"
  | "schema-mismatch"
  | "type-coercion"
  | "unknown-field"
  | "unknown-message-type";

export class RelayV2SchemaError extends Error {
  readonly code = "INVALID_ENVELOPE" as const;

  constructor(readonly failureClass: RelayV2CodecFailureClass) {
    super("Relay v2 message does not match the frozen schema");
    this.name = "RelayV2SchemaError";
  }
}

export type RelayV2JsonObject = { [key: string]: RelayV2JsonValue };

export interface RelayV2NormalizedPublicFrame {
  channel: "public";
  version: 2;
  kind: "request" | "response" | "event";
  type: string;
  requestId: string | null;
}

export interface RelayV2NormalizedCarrierFrame {
  channel: "carrier";
  version: 1;
  type: string;
  requestId: string | null;
}

export interface RelayV2NormalizedHttpsBody {
  channel: "https";
  schema: RelayV2HttpsSchema;
}

export type RelayV2NormalizedMessage =
  | RelayV2NormalizedPublicFrame
  | RelayV2NormalizedCarrierFrame
  | RelayV2NormalizedHttpsBody;

export type RelayV2HttpsSchema =
  | "enrollment.redeem.request"
  | "enrollment.redeem.response"
  | "token.refresh.client.request"
  | "token.refresh.client.response"
  | "grant.self-revoke.request"
  | "grant.self-revoke.response"
  | "host.bootstrap.request"
  | "host.bootstrap.response"
  | "token.refresh.host.request"
  | "token.refresh.host.response"
  | "error.response";

const ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "PERMISSION_DENIED",
  "GRANT_NOT_FOUND",
  "ROLE_MISMATCH",
  "PROTOCOL_UNSUPPORTED",
  "HOST_DIALECT_UNAVAILABLE",
  "CAPABILITY_UNAVAILABLE",
  "INVALID_ENVELOPE",
  "INVALID_ARGUMENT",
  "HOST_NOT_FOUND",
  "HOST_OFFLINE",
  "HOST_EPOCH_MISMATCH",
  "EVENT_CURSOR_AHEAD",
  "HOST_SUPERSEDED",
  "DUPLICATE_CONNECTOR",
  "SCOPE_NOT_FOUND",
  "SCOPE_UNREACHABLE",
  "SNAPSHOT_EXPIRED",
  "SNAPSHOT_TOO_LARGE",
  "PROJECT_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "PANE_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "COMMAND_NOT_ACCEPTED",
  "COMMAND_WINDOW_EXPIRED",
  "COMMAND_RESULT_EXPIRED",
  "COMMAND_STATUS_UNKNOWN",
  "COMMAND_IN_DOUBT",
  "COMMAND_FAILED",
  "RATE_LIMITED",
  "BUSY",
  "SLOW_CONSUMER",
  "TERMINAL_STREAM_NOT_FOUND",
  "TERMINAL_STREAM_CONFLICT",
  "TERMINAL_OPEN_CONFLICT",
  "TERMINAL_CLOSE_CONFLICT",
  "TERMINAL_ROUTE_STALE",
  "TERMINAL_GENERATION_STALE",
  "TERMINAL_OFFSET_EXPIRED",
  "TERMINAL_INVALID_ACK",
  "TERMINAL_INPUT_GAP",
  "TERMINAL_INPUT_CONFLICT",
  "TERMINAL_RESIZE_GAP",
  "TERMINAL_RESIZE_CONFLICT",
  "INTERNAL",
]);

const COMMAND_DISPOSITIONS = [
  "not_accepted",
  "accepted",
  "running",
  "completed",
  "in_doubt",
  "not_applicable",
] as const;

const COUNTER_MAX = 18_446_744_073_709_551_615n;

function reject(failureClass: RelayV2CodecFailureClass): never {
  throw new RelayV2SchemaError(failureClass);
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

function stringValue(
  value: RelayV2JsonValue,
  options: {
    allowEmpty?: boolean;
    allowOuterWhitespace?: boolean;
    maxBytes?: number;
    maxCharacters?: number;
    allowNul?: boolean;
  } = {},
): string {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  if (!options.allowEmpty && value.length === 0) reject("invalid-argument");
  if (!options.allowNul && value.includes("\0")) reject("invalid-argument");
  if (!options.allowOuterWhitespace && value.trim() !== value) reject("invalid-argument");
  if (
    options.maxBytes !== undefined
    && Buffer.byteLength(value, "utf8") > options.maxBytes
  ) {
    reject("id-byte-limit");
  }
  if (
    options.maxCharacters !== undefined
    && Array.from(value).length > options.maxCharacters
  ) {
    reject("invalid-argument");
  }
  return value;
}

function id(value: RelayV2JsonValue): string {
  return stringValue(value, { maxBytes: 128 });
}

function cursor(value: RelayV2JsonValue): string {
  return stringValue(value, { maxBytes: 1_024 });
}

function nullable<T>(
  value: RelayV2JsonValue,
  validator: (item: RelayV2JsonValue) => T,
): T | null {
  return value === null ? null : validator(value);
}

function booleanValue(value: RelayV2JsonValue): boolean {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "boolean") reject("type-coercion");
  return value;
}

function nullValue(value: RelayV2JsonValue): null {
  if (value !== null) reject("schema-mismatch");
  return null;
}

function integer(
  value: RelayV2JsonValue,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === null) reject("forbidden-null");
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
  ) {
    reject("type-coercion");
  }
  if (value < minimum || value > maximum) reject("invalid-argument");
  return value;
}

function literal<T extends string | number | boolean>(
  value: RelayV2JsonValue,
  expected: T,
): T {
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

function array(
  value: RelayV2JsonValue,
  validator: (item: RelayV2JsonValue) => void,
  maximum: number,
  minimum = 0,
): RelayV2JsonValue[] {
  if (value === null) reject("forbidden-null");
  if (!Array.isArray(value)) reject("type-coercion");
  if (value.length < minimum || value.length > maximum) reject("invalid-argument");
  for (const item of value) validator(item);
  return value;
}

function counter(value: RelayV2JsonValue): string {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) reject("non-canonical-counter");
  if (BigInt(value) > COUNTER_MAX) reject("counter-overflow");
  return value;
}

function canonicalBase64(value: RelayV2JsonValue, maxDecodedBytes: number): string {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  const encoded = value;
  if (encoded.length === 0 || encoded.trim() !== encoded || encoded.includes("\0")) {
    reject("invalid-argument");
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    reject("non-canonical-base64");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedBytes = (encoded.length / 4) * 3 - padding;
  if (decodedBytes > maxDecodedBytes) reject("base64-decoded-limit");
  if (Buffer.from(encoded, "base64").toString("base64") !== encoded) {
    reject("non-canonical-base64");
  }
  return encoded;
}

function canonicalBase64Url(value: RelayV2JsonValue, decodedBytes?: number): string {
  const encoded = stringValue(value, { maxBytes: 2_048 });
  if (!/^(?:[A-Za-z0-9_-]{2,})$/.test(encoded) || encoded.includes("=")) {
    reject("non-canonical-base64url");
  }
  if (decodedBytes !== undefined) {
    const expectedLength = Math.ceil((decodedBytes * 4) / 3);
    if (encoded.length !== expectedLength) reject("non-canonical-base64url");
  }
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - encoded.length % 4) % 4);
  const roundTrip = Buffer.from(padded, "base64").toString("base64url");
  if (roundTrip !== encoded) reject("non-canonical-base64url");
  return encoded;
}

function capabilities(value: RelayV2JsonValue): string[] {
  const seen = new Set<string>();
  const values = array(value, (item) => {
    const capability = id(item);
    if (seen.has(capability)) reject("schema-mismatch");
    seen.add(capability);
  }, 64).map((item) => item as string);
  return values;
}

function validateStructuredError(value: RelayV2JsonValue): void {
  const error = object(value);
  exact(
    error,
    ["code", "message", "retryable", "commandDisposition"],
    ["retryAfterMs", "details"],
  );
  const code = stringValue(field(error, "code"), { maxBytes: 128 });
  if (!ERROR_CODES.has(code)) reject("schema-mismatch");
  stringValue(field(error, "message"), {
    allowOuterWhitespace: true,
    maxBytes: 4_096,
  });
  booleanValue(field(error, "retryable"));
  oneOf(field(error, "commandDisposition"), COMMAND_DISPOSITIONS);
  if (Object.hasOwn(error, "retryAfterMs")) {
    nullable(field(error, "retryAfterMs"), (item) => integer(item));
  }
  if (!Object.hasOwn(error, "details") || error.details === null) return;
  const details = object(error.details);
  switch (code) {
    case "HOST_EPOCH_MISMATCH":
      exact(details, ["expectedHostEpoch", "actualHostEpoch"]);
      id(field(details, "expectedHostEpoch"));
      id(field(details, "actualHostEpoch"));
      return;
    case "EVENT_CURSOR_AHEAD":
      exact(details, ["clientLastEventSeq", "hostEventSeq"]);
      counter(field(details, "clientLastEventSeq"));
      counter(field(details, "hostEventSeq"));
      return;
    case "COMMAND_WINDOW_EXPIRED":
      exact(details, ["reissueRequired"]);
      literal(field(details, "reissueRequired"), true);
      return;
    case "SNAPSHOT_TOO_LARGE":
      exact(details, ["useStateSnapshot"]);
      literal(field(details, "useStateSnapshot"), true);
      return;
    case "COMMAND_RESULT_EXPIRED":
      exact(details, ["finalState"]);
      oneOf(field(details, "finalState"), ["succeeded", "failed", "in_doubt"] as const);
      return;
    default:
      reject("schema-mismatch");
  }
}

function validateScope(value: RelayV2JsonValue): void {
  const scope = object(value);
  exact(scope, ["scopeId", "displayName", "kind", "reachability"]);
  id(field(scope, "scopeId"));
  stringValue(field(scope, "displayName"), {
    allowOuterWhitespace: true,
    maxBytes: 128,
  });
  oneOf(field(scope, "kind"), ["local", "ssh"] as const);
  oneOf(field(scope, "reachability"), ["online", "unreachable"] as const);
}

function validateSession(value: RelayV2JsonValue): void {
  const session = object(value);
  exact(session, [
    "scopeId",
    "sessionId",
    "kind",
    "displayName",
    "state",
    "project",
    "label",
    "cwd",
    "attached",
    "windowCount",
    "createdAtMs",
    "activityAtMs",
  ]);
  id(field(session, "scopeId"));
  id(field(session, "sessionId"));
  const kind = oneOf(field(session, "kind"), ["worktree", "terminal"] as const);
  stringValue(field(session, "displayName"), {
    allowOuterWhitespace: true,
    maxBytes: 128,
  });
  literal(field(session, "state"), "running");
  const project = nullable(field(session, "project"), (item) => (
    stringValue(item, { maxBytes: 128 })
  ));
  const label = nullable(field(session, "label"), (item) => (
    stringValue(item, { allowOuterWhitespace: true, maxBytes: 128 })
  ));
  const cwd = nullable(field(session, "cwd"), (item) => (
    stringValue(item, { allowOuterWhitespace: true, maxBytes: 4_096 })
  ));
  if (kind === "worktree" && (project === null || cwd === null)) reject("schema-mismatch");
  if (kind === "terminal" && (label === null || cwd === null)) reject("schema-mismatch");
  booleanValue(field(session, "attached"));
  integer(field(session, "windowCount"));
  integer(field(session, "createdAtMs"));
  integer(field(session, "activityAtMs"));
}

function validateTopLevelIdentifiers(frame: RelayV2JsonObject): void {
  for (const name of [
    "requestId",
    "commandId",
    "hostId",
    "expectedHostEpoch",
    "hostEpoch",
    "hostInstanceId",
    "scopeId",
    "sessionId",
    "streamId",
  ]) {
    if (Object.hasOwn(frame, name)) id(frame[name]!);
  }
  if (Object.hasOwn(frame, "eventSeq")) counter(frame.eventSeq!);
}

function publicRoot(
  frame: RelayV2JsonObject,
  kind: "request" | "response" | "event",
  type: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  exact(frame, ["protocolVersion", "kind", "type", ...required], optional);
  literal(field(frame, "protocolVersion"), 2);
  literal(field(frame, "kind"), kind);
  literal(field(frame, "type"), type);
  validateTopLevelIdentifiers(frame);
}

function validateRelayWelcome(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, [
    "selectedVersion",
    "connectionId",
    "brokerEpoch",
    "principalId",
    "capabilities",
    "limits",
  ]);
  literal(field(payload, "selectedVersion"), 2);
  id(field(payload, "connectionId"));
  id(field(payload, "brokerEpoch"));
  id(field(payload, "principalId"));
  capabilities(field(payload, "capabilities"));
  const limits = object(field(payload, "limits"));
  exact(limits, [
    "maxFrameBytes",
    "maxCarrierFrameBytes",
    "brokerRouteBufferedBytesPerDirection",
    "brokerRouteLowWaterBytesPerDirection",
    "brokerCarrierBufferedBytes",
    "brokerCarrierLowWaterBytes",
    "maxQueuedRouteFrames",
    "maxInFlightRequestsPerRoute",
  ]);
  for (const item of Object.values(limits)) integer(item, 1);
}

function validateClientHello(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, [
    "clientInstanceId",
    "capabilities",
    "requiredCapabilities",
    "resume",
  ]);
  id(field(payload, "clientInstanceId"));
  capabilities(field(payload, "capabilities"));
  capabilities(field(payload, "requiredCapabilities"));
  if (payload.resume === null) return;
  const resume = object(payload.resume);
  exact(resume, ["hostEpoch", "lastEventSeq"]);
  id(field(resume, "hostEpoch"));
  counter(field(resume, "lastEventSeq"));
}

function validateHostWelcome(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, [
    "selectedVersion",
    "capabilities",
    "eventSeq",
    "resumeDisposition",
    "resumeReason",
    "commandDedupeWindow",
    "limits",
  ]);
  literal(field(payload, "selectedVersion"), 2);
  capabilities(field(payload, "capabilities"));
  counter(field(payload, "eventSeq"));
  const disposition = oneOf(
    field(payload, "resumeDisposition"),
    ["caught_up", "snapshot_required"] as const,
  );
  const reason = oneOf(
    field(payload, "resumeReason"),
    ["matched", "fresh", "host_epoch_changed", "cursor_behind"] as const,
  );
  if (
    (disposition === "caught_up" && reason !== "matched")
    || (disposition === "snapshot_required" && reason === "matched")
  ) {
    reject("schema-mismatch");
  }
  const window = object(field(payload, "commandDedupeWindow"));
  exact(window, ["windowId", "windowSeq", "acceptUntilMs", "queryUntilMs"]);
  id(field(window, "windowId"));
  counter(field(window, "windowSeq"));
  integer(field(window, "acceptUntilMs"));
  integer(field(window, "queryUntilMs"));
  const limits = object(field(payload, "limits"));
  exact(limits, [
    "commandResultRetentionMs",
    "commandDedupeRetentionMs",
    "maxCommandQueryIds",
    "stateSnapshotChunkBytes",
    "stateSnapshotChunkRecords",
    "stateSnapshotMaxBytes",
    "stateSnapshotMaxRecords",
    "stateSnapshotIdleLeaseMs",
    "stateSnapshotMaxLifetimeMs",
    "stateSnapshotMaxPinnedPerPrincipal",
    "stateSnapshotMaxPinnedPerHost",
    "stateSnapshotPinnedBytesPerHost",
    "stateSnapshotPinnedMetadataBytesPerHost",
    "stateSnapshotChunkMaxJsonKeys",
    "stateSnapshotChunkMaxJsonNodes",
    "terminalReplayBytesPerStream",
    "terminalReplayBytesPerHost",
    "terminalDetachedLeaseMs",
    "terminalControlDedupeRetentionMs",
    "terminalMaxUnackedBytes",
    "terminalMaxFrameBytes",
    "terminalInputDedupeEntriesPerStream",
    "terminalResizeDedupeEntriesPerStream",
    "terminalMaxStreamsPerHost",
    "terminalControlRecordsPerHost",
    "brokerRouteBufferedBytesPerDirection",
    "brokerRouteLowWaterBytesPerDirection",
  ]);
  for (const item of Object.values(limits)) integer(item, 1);
}

function validateCommandArguments(
  operation: "create_worktree" | "create_terminal" | "send_agent_message" | "kill_session",
  value: RelayV2JsonValue,
): void {
  const argumentsValue = object(value);
  switch (operation) {
    case "create_worktree": {
      exact(argumentsValue, ["aiCommand"], ["project", "path", "name", "branch"]);
      if (!Object.hasOwn(argumentsValue, "project") && !Object.hasOwn(argumentsValue, "path")) {
        reject("invalid-argument");
      }
      if (Object.hasOwn(argumentsValue, "project")) {
        stringValue(argumentsValue.project!, { maxBytes: 128 });
      }
      if (Object.hasOwn(argumentsValue, "path")) {
        stringValue(argumentsValue.path!, {
          allowOuterWhitespace: true,
          maxBytes: 4_096,
        });
      }
      if (Object.hasOwn(argumentsValue, "name")) {
        stringValue(argumentsValue.name!, {
          maxBytes: 128,
          maxCharacters: 20,
        });
      }
      if (Object.hasOwn(argumentsValue, "branch")) {
        stringValue(argumentsValue.branch!, { maxBytes: 255 });
      }
      stringValue(field(argumentsValue, "aiCommand"), {
        allowOuterWhitespace: true,
        maxBytes: 4_096,
      });
      return;
    }
    case "create_terminal":
      exact(argumentsValue, ["cwd"], ["label"]);
      stringValue(field(argumentsValue, "cwd"), {
        allowOuterWhitespace: true,
        maxBytes: 4_096,
      });
      if (Object.hasOwn(argumentsValue, "label")) {
        stringValue(argumentsValue.label!, {
          allowOuterWhitespace: true,
          maxBytes: 128,
        });
      }
      return;
    case "send_agent_message": {
      exact(argumentsValue, ["pane", "message", "submit"]);
      integer(field(argumentsValue, "pane"), 0, 65_535);
      const message = stringValue(field(argumentsValue, "message"), {
        allowEmpty: true,
        allowOuterWhitespace: true,
        maxBytes: 65_536,
      });
      const submit = booleanValue(field(argumentsValue, "submit"));
      if (message.length === 0 && !submit) reject("invalid-argument");
      return;
    }
    case "kill_session":
      exact(argumentsValue, []);
  }
}

function validateCommandResult(value: RelayV2JsonValue): void {
  const result = object(value);
  if (Object.hasOwn(result, "session")) {
    exact(result, ["session"]);
    validateSession(field(result, "session"));
    return;
  }
  if (Object.hasOwn(result, "messageUtf8Bytes")) {
    exact(result, ["pane", "submit", "messageUtf8Bytes"]);
    integer(field(result, "pane"), 0, 65_535);
    booleanValue(field(result, "submit"));
    integer(field(result, "messageUtf8Bytes"), 0, 65_536);
    return;
  }
  if (Object.hasOwn(result, "terminated")) {
    exact(result, ["sessionId", "terminated"]);
    id(field(result, "sessionId"));
    literal(field(result, "terminated"), true);
    return;
  }
  reject("schema-mismatch");
}

function validateCommandStatusPayload(
  value: RelayV2JsonValue,
  topLevelError: RelayV2JsonValue,
  allowNonFinal: boolean,
): void {
  const payload = object(value);
  exact(payload, [
    "dedupeWindowId",
    "state",
    "deduplicated",
    "updatedAtMs",
    "dedupeUntilMs",
    "result",
  ]);
  id(field(payload, "dedupeWindowId"));
  const states = allowNonFinal
    ? ["accepted", "running", "succeeded", "failed", "in_doubt"] as const
    : ["succeeded", "failed", "in_doubt"] as const;
  const state = oneOf(field(payload, "state"), states);
  booleanValue(field(payload, "deduplicated"));
  integer(field(payload, "updatedAtMs"));
  nullable(field(payload, "dedupeUntilMs"), (item) => integer(item));

  if (state === "accepted" || state === "running") {
    nullValue(field(payload, "result"));
    if (topLevelError !== null) reject("schema-mismatch");
    return;
  }
  if (state === "succeeded") {
    validateCommandResult(field(payload, "result"));
    if (topLevelError !== null) reject("schema-mismatch");
    return;
  }
  if (field(payload, "result") !== null || topLevelError === null) {
    reject("schema-mismatch");
  }
  validateStructuredError(topLevelError);
  const error = object(topLevelError);
  const code = field(error, "code");
  const disposition = field(error, "commandDisposition");
  if (
    state === "in_doubt"
    && (code !== "COMMAND_IN_DOUBT" || disposition !== "in_doubt")
  ) {
    reject("schema-mismatch");
  }
  if (
    state === "failed"
    && (
      field(error, "retryable") !== false
      || disposition !== "completed"
      || code === "COMMAND_IN_DOUBT"
    )
  ) {
    reject("schema-mismatch");
  }
}

function validateCommandResultPayload(
  value: RelayV2JsonValue,
  topLevelError: RelayV2JsonValue,
): void {
  const payload = object(value);
  exact(payload, ["dedupeWindowId", "state", "updatedAtMs", "result"]);
  id(field(payload, "dedupeWindowId"));
  const state = oneOf(
    field(payload, "state"),
    ["succeeded", "failed", "in_doubt"] as const,
  );
  integer(field(payload, "updatedAtMs"));
  if (state === "succeeded") {
    validateCommandResult(field(payload, "result"));
    if (topLevelError !== null) reject("schema-mismatch");
    return;
  }
  nullValue(field(payload, "result"));
  if (topLevelError === null) reject("schema-mismatch");
  validateStructuredError(topLevelError);
  const error = object(topLevelError);
  if (
    state === "in_doubt"
    && (
      field(error, "code") !== "COMMAND_IN_DOUBT"
      || field(error, "commandDisposition") !== "in_doubt"
    )
  ) {
    reject("schema-mismatch");
  }
  if (
    state === "failed"
    && (
      field(error, "retryable") !== false
      || field(error, "commandDisposition") !== "completed"
    )
  ) {
    reject("schema-mismatch");
  }
}

function validateCommandQueryItem(value: RelayV2JsonValue): void {
  const item = object(value);
  exact(item, ["commandId", "dedupeWindowId"]);
  id(field(item, "commandId"));
  id(field(item, "dedupeWindowId"));
}

function validateCommandStatusesItem(value: RelayV2JsonValue): void {
  const item = object(value);
  exact(item, [
    "commandId",
    "dedupeWindowId",
    "state",
    "updatedAtMs",
    "dedupeUntilMs",
    "retryable",
    "retryAfterMs",
    "reissueRequired",
    "result",
    "error",
  ]);
  id(field(item, "commandId"));
  id(field(item, "dedupeWindowId"));
  const state = oneOf(field(item, "state"), [
    "not_accepted",
    "accepted",
    "running",
    "succeeded",
    "failed",
    "in_doubt",
    "expired",
    "unknown",
  ] as const);
  integer(field(item, "updatedAtMs"));
  const dedupeUntil = nullable(field(item, "dedupeUntilMs"), (entry) => integer(entry));
  const retryable = booleanValue(field(item, "retryable"));
  const retryAfter = nullable(field(item, "retryAfterMs"), (entry) => integer(entry));
  const reissueRequired = booleanValue(field(item, "reissueRequired"));
  const result = field(item, "result");
  const error = field(item, "error");

  if (state === "accepted" || state === "running") {
    if (
      dedupeUntil !== null
      || retryable
      || retryAfter !== null
      || reissueRequired
      || result !== null
      || error !== null
    ) {
      reject("schema-mismatch");
    }
    return;
  }
  if (state === "succeeded") {
    if (
      dedupeUntil === null
      || retryable
      || retryAfter !== null
      || reissueRequired
      || error !== null
    ) {
      reject("schema-mismatch");
    }
    validateCommandResult(result);
    return;
  }
  if (result !== null || error === null) reject("schema-mismatch");
  validateStructuredError(error);
  const structured = object(error);
  const code = field(structured, "code");
  const disposition = field(structured, "commandDisposition");
  switch (state) {
    case "not_accepted":
      if (
        dedupeUntil !== null
        || code !== (reissueRequired ? "COMMAND_WINDOW_EXPIRED" : "COMMAND_NOT_ACCEPTED")
        || disposition !== "not_accepted"
        || retryable === reissueRequired
        || (retryable && retryAfter === null)
        || (!retryable && retryAfter !== null)
      ) {
        reject("schema-mismatch");
      }
      return;
    case "failed":
      if (
        dedupeUntil === null
        || retryable
        || retryAfter !== null
        || reissueRequired
        || disposition !== "completed"
      ) {
        reject("schema-mismatch");
      }
      return;
    case "in_doubt":
      if (
        dedupeUntil === null
        || retryable
        || retryAfter !== null
        || reissueRequired
        || code !== "COMMAND_IN_DOUBT"
        || disposition !== "in_doubt"
      ) {
        reject("schema-mismatch");
      }
      return;
    case "expired":
      if (
        dedupeUntil === null
        || retryable
        || retryAfter !== null
        || reissueRequired
        || code !== "COMMAND_RESULT_EXPIRED"
      ) {
        reject("schema-mismatch");
      }
      return;
    case "unknown":
      if (
        dedupeUntil !== null
        || retryable
        || retryAfter !== null
        || reissueRequired
        || code !== "COMMAND_STATUS_UNKNOWN"
        || disposition !== "in_doubt"
      ) {
        reject("schema-mismatch");
      }
  }
}

function validateSessionsSnapshotScope(value: RelayV2JsonValue): void {
  const scope = object(value);
  exact(scope, ["scopeId", "revision", "completeness", "items", "error"]);
  id(field(scope, "scopeId"));
  counter(field(scope, "revision"));
  const completeness = oneOf(
    field(scope, "completeness"),
    ["complete", "partial"] as const,
  );
  array(field(scope, "items"), validateSession, 256);
  if (completeness === "complete") {
    if (field(scope, "error") !== null) reject("schema-mismatch");
  } else {
    validateStructuredError(field(scope, "error"));
  }
}

function validateStateSnapshotRecord(value: RelayV2JsonValue): void {
  const record = object(value);
  const recordType = oneOf(
    field(record, "recordType"),
    ["scope", "sessions_scope", "session"] as const,
  );
  switch (recordType) {
    case "scope":
      exact(record, ["recordType", "item"]);
      validateScope(field(record, "item"));
      return;
    case "sessions_scope":
      exact(record, ["recordType", "scopeId", "revision", "completeness"]);
      id(field(record, "scopeId"));
      counter(field(record, "revision"));
      literal(field(record, "completeness"), "complete");
      return;
    case "session":
      exact(record, ["recordType", "scopeId", "item"]);
      id(field(record, "scopeId"));
      validateSession(field(record, "item"));
  }
}

function validateStateChange(type: "scopes.changed" | "sessions.changed", value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["dimension", "resourceKey", "resultingRevision", "change"]);
  counter(field(payload, "resultingRevision"));
  const change = object(field(payload, "change"));
  if (type === "scopes.changed") {
    literal(field(payload, "dimension"), "scopes");
    literal(field(payload, "resourceKey"), "scopes");
    const operation = oneOf(field(change, "op"), ["upsert", "delete"] as const);
    if (operation === "upsert") {
      exact(change, ["op", "item"]);
      validateScope(field(change, "item"));
    } else {
      exact(change, ["op", "scopeId"]);
      id(field(change, "scopeId"));
    }
    return;
  }
  literal(field(payload, "dimension"), "sessions");
  id(field(payload, "resourceKey"));
  const operation = oneOf(field(change, "op"), ["upsert", "delete"] as const);
  if (operation === "upsert") {
    exact(change, ["op", "item"]);
    validateSession(field(change, "item"));
  } else {
    exact(change, ["op", "sessionId"]);
    id(field(change, "sessionId"));
  }
}

function validateTerminalResume(value: RelayV2JsonValue): void {
  const resume = object(value);
  exact(resume, ["generation", "nextOffset", "resumeToken"]);
  id(field(resume, "generation"));
  counter(field(resume, "nextOffset"));
  stringValue(field(resume, "resumeToken"), { maxBytes: 4_096 });
}

function validateTerminalResetPayload(
  value: RelayV2JsonValue,
  correlated: boolean,
): void {
  const payload = object(value);
  exact(payload, [
    ...(correlated ? ["origin"] : []),
    "generation",
    "reason",
    "requestedOffset",
    "bufferStartOffset",
    "tailOffset",
  ]);
  if (correlated) oneOf(field(payload, "origin"), ["open", "replay"] as const);
  nullable(field(payload, "generation"), id);
  oneOf(field(payload, "reason"), [
    "generation_stale",
    "offset_expired",
    "stream_lost",
    "slow_consumer",
    "host_buffer_pressure",
  ] as const);
  nullable(field(payload, "requestedOffset"), counter);
  nullable(field(payload, "bufferStartOffset"), counter);
  nullable(field(payload, "tailOffset"), counter);
}

function validateTerminalClosedPayload(
  value: RelayV2JsonValue,
  correlated: boolean,
): void {
  const payload = object(value);
  exact(payload, [
    ...(correlated ? ["closeId"] : []),
    "generation",
    "finalOffset",
    "replayAvailable",
    "bufferStartOffset",
    "reason",
    "exitCode",
    ...(correlated ? ["deduplicated"] : []),
  ]);
  if (correlated) {
    id(field(payload, "closeId"));
    booleanValue(field(payload, "deduplicated"));
  }
  id(field(payload, "generation"));
  counter(field(payload, "finalOffset"));
  const replayAvailable = booleanValue(field(payload, "replayAvailable"));
  const bufferStart = nullable(field(payload, "bufferStartOffset"), counter);
  if (replayAvailable !== (bufferStart !== null)) reject("schema-mismatch");
  const reason = oneOf(
    field(payload, "reason"),
    correlated
      ? ["client_closed", "backend_exit", "backend_error"] as const
      : ["backend_exit", "backend_error"] as const,
  );
  const exitCode = nullable(field(payload, "exitCode"), (item) => (
    integer(item, -2_147_483_648, 2_147_483_647)
  ));
  if (reason === "client_closed" && exitCode !== null) reject("schema-mismatch");
  if (reason === "backend_exit" && exitCode === null) reject("schema-mismatch");
}

export function validateRelayV2PublicFrame(
  frame: RelayV2JsonObject,
): RelayV2NormalizedPublicFrame {
  const type = stringValue(field(frame, "type"), { maxBytes: 128 });
  switch (type) {
    case "relay.welcome":
      publicRoot(frame, "event", type, ["payload"]);
      validateRelayWelcome(field(frame, "payload"));
      break;
    case "relay.unavailable": {
      publicRoot(frame, "event", type, ["hostId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["error"]);
      validateStructuredError(field(payload, "error"));
      break;
    }
    case "client.hello":
      publicRoot(frame, "request", type, ["requestId", "hostId", "payload"]);
      validateClientHello(field(frame, "payload"));
      break;
    case "host.welcome":
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "hostInstanceId",
        "payload",
      ]);
      validateHostWelcome(field(frame, "payload"));
      break;
    case "error":
      publicRoot(
        frame,
        "response",
        type,
        ["requestId", "payload", "error"],
        ["commandId", "hostId", "hostEpoch", "scopeId", "sessionId", "streamId"],
      );
      nullValue(field(frame, "payload"));
      validateStructuredError(field(frame, "error"));
      break;
    case "auth.expiring": {
      publicRoot(frame, "event", type, ["payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["grantId", "expiresAtMs", "refreshRecommendedAtMs"]);
      id(field(payload, "grantId"));
      integer(field(payload, "expiresAtMs"));
      integer(field(payload, "refreshRecommendedAtMs"));
      break;
    }
    case "host.presence": {
      publicRoot(frame, "event", type, ["hostId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(
        payload,
        [
          "brokerEpoch",
          "revision",
          "state",
          "reason",
          "hostEpoch",
          "hostInstanceId",
          "previousHostInstanceId",
          "observedAtMs",
        ],
      );
      id(field(payload, "brokerEpoch"));
      counter(field(payload, "revision"));
      oneOf(field(payload, "state"), ["online", "offline"] as const);
      oneOf(field(payload, "reason"), [
        "connected",
        "reconnected",
        "superseded",
        "disconnected",
      ] as const);
      nullable(field(payload, "hostEpoch"), id);
      nullable(field(payload, "hostInstanceId"), id);
      nullable(field(payload, "previousHostInstanceId"), id);
      integer(field(payload, "observedAtMs"));
      break;
    }
    case "hosts.snapshot.get": {
      publicRoot(frame, "request", type, ["requestId", "payload"]);
      exact(object(field(frame, "payload")), []);
      break;
    }
    case "hosts.snapshot": {
      publicRoot(frame, "response", type, ["requestId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["brokerEpoch", "revision", "items"]);
      id(field(payload, "brokerEpoch"));
      counter(field(payload, "revision"));
      array(field(payload, "items"), (entry) => {
        const item = object(entry);
        exact(item, [
          "hostId",
          "state",
          "hostEpoch",
          "hostInstanceId",
          "clientDialects",
          "capabilities",
          "observedAtMs",
        ]);
        id(field(item, "hostId"));
        oneOf(field(item, "state"), ["online", "offline"] as const);
        nullable(field(item, "hostEpoch"), id);
        nullable(field(item, "hostInstanceId"), id);
        array(field(item, "clientDialects"), (dialect) => {
          oneOf(dialect, ["tw-relay.v1", "tw-relay.v2"] as const);
        }, 2);
        capabilities(field(item, "capabilities"));
        integer(field(item, "observedAtMs"));
      }, 256);
      break;
    }
    case "command.execute": {
      publicRoot(
        frame,
        "request",
        type,
        [
          "requestId",
          "commandId",
          "hostId",
          "expectedHostEpoch",
          "scopeId",
          "payload",
        ],
        ["sessionId"],
      );
      const payload = object(field(frame, "payload"));
      exact(payload, ["dedupeWindowId", "operation", "arguments"]);
      id(field(payload, "dedupeWindowId"));
      const operation = oneOf(field(payload, "operation"), [
        "create_worktree",
        "create_terminal",
        "send_agent_message",
        "kill_session",
      ] as const);
      const requiresSession = operation === "send_agent_message" || operation === "kill_session";
      if (requiresSession !== Object.hasOwn(frame, "sessionId")) reject("schema-mismatch");
      validateCommandArguments(operation, field(payload, "arguments"));
      break;
    }
    case "command.status": {
      publicRoot(
        frame,
        "response",
        type,
        [
          "requestId",
          "commandId",
          "hostId",
          "hostEpoch",
          "scopeId",
          "payload",
          "error",
        ],
        ["sessionId"],
      );
      validateCommandStatusPayload(
        field(frame, "payload"),
        field(frame, "error"),
        true,
      );
      break;
    }
    case "command.result": {
      publicRoot(
        frame,
        "event",
        type,
        ["commandId", "hostId", "hostEpoch", "scopeId", "payload", "error"],
        ["sessionId"],
      );
      validateCommandResultPayload(
        field(frame, "payload"),
        field(frame, "error"),
      );
      break;
    }
    case "command.query": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["items"]);
      array(field(payload, "items"), validateCommandQueryItem, 32, 1);
      break;
    }
    case "command.statuses": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["dedupeWatermark", "items"]);
      const watermark = object(field(payload, "dedupeWatermark"));
      exact(watermark, [
        "oldestQueryableWindowSeq",
        "newestIssuedWindowSeq",
        "observedAtMs",
      ]);
      counter(field(watermark, "oldestQueryableWindowSeq"));
      counter(field(watermark, "newestIssuedWindowSeq"));
      integer(field(watermark, "observedAtMs"));
      array(field(payload, "items"), validateCommandStatusesItem, 32);
      break;
    }
    case "scopes.snapshot.get": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "payload",
      ]);
      exact(object(field(frame, "payload")), []);
      break;
    }
    case "scopes.snapshot": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "coverageComplete",
        "revision",
        "throughEventSeq",
        "items",
      ]);
      booleanValue(field(payload, "coverageComplete"));
      counter(field(payload, "revision"));
      nullValue(field(payload, "throughEventSeq"));
      array(field(payload, "items"), validateScope, 256);
      break;
    }
    case "sessions.snapshot.get": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["scopeIds"]);
      if (payload.scopeIds !== null) {
        array(payload.scopeIds, id, 100, 1);
      }
      break;
    }
    case "sessions.snapshot": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["coverageComplete", "throughEventSeq", "scopes"]);
      booleanValue(field(payload, "coverageComplete"));
      nullValue(field(payload, "throughEventSeq"));
      array(field(payload, "scopes"), validateSessionsSnapshotScope, 100);
      break;
    }
    case "state.snapshot.get": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "snapshotRequestId",
        "snapshotId",
        "cursor",
        "nextChunkIndex",
      ]);
      id(field(payload, "snapshotRequestId"));
      nullable(field(payload, "snapshotId"), id);
      nullable(field(payload, "cursor"), cursor);
      integer(field(payload, "nextChunkIndex"));
      const first = payload.snapshotId === null && payload.cursor === null;
      if (first !== (payload.nextChunkIndex === 0)) reject("schema-mismatch");
      if ((payload.snapshotId === null) !== (payload.cursor === null)) {
        reject("schema-mismatch");
      }
      break;
    }
    case "state.snapshot.chunk": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "coverageComplete",
        "snapshotRequestId",
        "snapshotId",
        "snapshotCreatedAtMs",
        "snapshotLeaseExpiresAtMs",
        "snapshotAbsoluteExpiresAtMs",
        "chunkIndex",
        "isLast",
        "nextCursor",
        "throughEventSeq",
        "scopesRevision",
        "totalRecords",
        "totalCanonicalBytes",
        "cutDigest",
        "records",
      ]);
      literal(field(payload, "coverageComplete"), true);
      id(field(payload, "snapshotRequestId"));
      id(field(payload, "snapshotId"));
      integer(field(payload, "snapshotCreatedAtMs"));
      integer(field(payload, "snapshotLeaseExpiresAtMs"));
      integer(field(payload, "snapshotAbsoluteExpiresAtMs"));
      integer(field(payload, "chunkIndex"));
      const last = booleanValue(field(payload, "isLast"));
      const next = nullable(field(payload, "nextCursor"), cursor);
      if (last === (next !== null)) reject("schema-mismatch");
      counter(field(payload, "throughEventSeq"));
      counter(field(payload, "scopesRevision"));
      integer(field(payload, "totalRecords"), 0, 100_000);
      integer(field(payload, "totalCanonicalBytes"), 0, 268_435_456);
      canonicalBase64Url(field(payload, "cutDigest"), 32);
      array(field(payload, "records"), validateStateSnapshotRecord, 256);
      break;
    }
    case "state.snapshot.release": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["snapshotRequestId", "snapshotId", "reason"]);
      id(field(payload, "snapshotRequestId"));
      id(field(payload, "snapshotId"));
      oneOf(field(payload, "reason"), ["completed", "abandoned"] as const);
      break;
    }
    case "state.snapshot.released": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "snapshotRequestId",
        "snapshotId",
        "released",
        "alreadyReleased",
        "releasedAtMs",
      ]);
      id(field(payload, "snapshotRequestId"));
      id(field(payload, "snapshotId"));
      booleanValue(field(payload, "released"));
      booleanValue(field(payload, "alreadyReleased"));
      integer(field(payload, "releasedAtMs"));
      break;
    }
    case "scopes.changed":
    case "sessions.changed":
      publicRoot(frame, "event", type, [
        "hostId",
        "hostEpoch",
        "scopeId",
        "eventSeq",
        "payload",
      ]);
      validateStateChange(type, field(frame, "payload"));
      break;
    case "terminal.open": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "scopeId",
        "sessionId",
        "streamId",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(
        payload,
        ["openId", "pane", "cols", "rows", "mode"],
        ["resume"],
      );
      id(field(payload, "openId"));
      integer(field(payload, "pane"), 0, 65_535);
      integer(field(payload, "cols"), 1, 1_000);
      integer(field(payload, "rows"), 1, 500);
      const mode = oneOf(field(payload, "mode"), ["new", "resume", "reset"] as const);
      const hasResume = Object.hasOwn(payload, "resume");
      if (mode === "new" && hasResume) reject("schema-mismatch");
      if (mode === "resume" && !hasResume) reject("missing-field");
      if (hasResume) validateTerminalResume(payload.resume!);
      break;
    }
    case "terminal.opened": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "streamId",
        "hostInstanceId",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "openId",
        "deduplicated",
        "generation",
        "resumeToken",
        "disposition",
        "replayFromOffset",
        "bufferStartOffset",
        "tailOffset",
        "maxUnackedBytes",
        "resetReason",
      ]);
      id(field(payload, "openId"));
      booleanValue(field(payload, "deduplicated"));
      id(field(payload, "generation"));
      stringValue(field(payload, "resumeToken"), { maxBytes: 4_096 });
      oneOf(field(payload, "disposition"), ["new", "resumed", "reset"] as const);
      counter(field(payload, "replayFromOffset"));
      counter(field(payload, "bufferStartOffset"));
      counter(field(payload, "tailOffset"));
      integer(field(payload, "maxUnackedBytes"));
      nullable(field(payload, "resetReason"), (entry) => {
        oneOf(entry, [
          "generation_stale",
          "offset_expired",
          "stream_lost",
          "slow_consumer",
          "host_buffer_pressure",
        ] as const);
      });
      break;
    }
    case "terminal.output": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "offset", "encoding", "data"]);
      id(field(payload, "generation"));
      counter(field(payload, "offset"));
      literal(field(payload, "encoding"), "base64");
      canonicalBase64(field(payload, "data"), 65_536);
      break;
    }
    case "terminal.output_ack": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "nextOffset"]);
      id(field(payload, "generation"));
      counter(field(payload, "nextOffset"));
      break;
    }
    case "terminal.replay_request": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "scopeId",
        "sessionId",
        "streamId",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "fromOffset"]);
      id(field(payload, "generation"));
      counter(field(payload, "fromOffset"));
      break;
    }
    case "terminal.replay_started": {
      publicRoot(frame, "response", type, [
        "requestId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "streamId",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "fromOffset", "tailOffsetAtStart"]);
      id(field(payload, "generation"));
      counter(field(payload, "fromOffset"));
      counter(field(payload, "tailOffsetAtStart"));
      break;
    }
    case "terminal.reset_required":
      if (frame.kind === "response") {
        publicRoot(frame, "response", type, [
          "requestId",
          "hostId",
          "hostEpoch",
          "scopeId",
          "sessionId",
          "streamId",
          "payload",
        ]);
        validateTerminalResetPayload(field(frame, "payload"), true);
      } else if (frame.kind === "event") {
        publicRoot(frame, "event", type, ["streamId", "payload"]);
        validateTerminalResetPayload(field(frame, "payload"), false);
      } else {
        reject("schema-mismatch");
      }
      break;
    case "terminal.input": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "inputSeq", "encoding", "data"]);
      id(field(payload, "generation"));
      counter(field(payload, "inputSeq"));
      literal(field(payload, "encoding"), "base64");
      canonicalBase64(field(payload, "data"), 65_536);
      break;
    }
    case "terminal.input_ack": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "ackedThroughInputSeq"]);
      id(field(payload, "generation"));
      counter(field(payload, "ackedThroughInputSeq"));
      break;
    }
    case "terminal.input_error": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "inputSeq", "ackedThroughInputSeq", "error"]);
      id(field(payload, "generation"));
      counter(field(payload, "inputSeq"));
      counter(field(payload, "ackedThroughInputSeq"));
      validateStructuredError(field(payload, "error"));
      break;
    }
    case "terminal.resize": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "resizeSeq", "cols", "rows"]);
      id(field(payload, "generation"));
      counter(field(payload, "resizeSeq"));
      integer(field(payload, "cols"), 1, 1_000);
      integer(field(payload, "rows"), 1, 500);
      break;
    }
    case "terminal.resize_ack": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "ackedThroughResizeSeq"]);
      id(field(payload, "generation"));
      counter(field(payload, "ackedThroughResizeSeq"));
      break;
    }
    case "terminal.resize_error": {
      publicRoot(frame, "event", type, ["streamId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["generation", "resizeSeq", "ackedThroughResizeSeq", "error"]);
      id(field(payload, "generation"));
      counter(field(payload, "resizeSeq"));
      counter(field(payload, "ackedThroughResizeSeq"));
      validateStructuredError(field(payload, "error"));
      break;
    }
    case "terminal.close": {
      publicRoot(frame, "request", type, [
        "requestId",
        "hostId",
        "expectedHostEpoch",
        "scopeId",
        "sessionId",
        "streamId",
        "payload",
      ]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["closeId", "generation", "resumeToken"]);
      id(field(payload, "closeId"));
      id(field(payload, "generation"));
      stringValue(field(payload, "resumeToken"), { maxBytes: 4_096 });
      break;
    }
    case "terminal.closed":
      if (frame.kind === "response") {
        publicRoot(frame, "response", type, [
          "requestId",
          "hostId",
          "hostEpoch",
          "hostInstanceId",
          "scopeId",
          "sessionId",
          "streamId",
          "payload",
        ]);
        validateTerminalClosedPayload(field(frame, "payload"), true);
      } else if (frame.kind === "event") {
        publicRoot(frame, "event", type, ["streamId", "payload"]);
        validateTerminalClosedPayload(field(frame, "payload"), false);
      } else {
        reject("schema-mismatch");
      }
      break;
    default:
      reject("unknown-message-type");
  }

  return {
    channel: "public",
    version: 2,
    kind: frame.kind as RelayV2NormalizedPublicFrame["kind"],
    type,
    requestId: Object.hasOwn(frame, "requestId") ? frame.requestId as string : null,
  };
}

function carrierRoot(
  frame: RelayV2JsonObject,
  type: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  exact(frame, ["carrierVersion", "type", ...required], optional);
  literal(field(frame, "carrierVersion"), 1);
  literal(field(frame, "type"), type);
  for (const name of ["requestId", "connectorId", "routeId", "routeFence"]) {
    if (Object.hasOwn(frame, name)) id(frame[name]!);
  }
}

function secret(value: RelayV2JsonValue): string {
  return stringValue(value, { maxBytes: 8_192 });
}

function validateCarrierRouteIdentity(frame: RelayV2JsonObject): void {
  id(field(frame, "connectorId"));
  id(field(frame, "routeId"));
  id(field(frame, "routeFence"));
}

export function validateRelayV2CarrierFrame(
  frame: RelayV2JsonObject,
): RelayV2NormalizedCarrierFrame {
  const type = stringValue(field(frame, "type"), { maxBytes: 128 });
  switch (type) {
    case "enrollment.create": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["expiresInMs", "deviceLabel"]);
      integer(field(payload, "expiresInMs"), 1, 300_000);
      nullable(field(payload, "deviceLabel"), (item) => {
        stringValue(item, { allowOuterWhitespace: true, maxBytes: 128 });
      });
      break;
    }
    case "enrollment.created": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "deduplicated",
        "enrollmentId",
        "enrollmentCode",
        "hostId",
        "issuerUrl",
        "relayUrl",
        "expiresAtMs",
      ]);
      booleanValue(field(payload, "deduplicated"));
      id(field(payload, "enrollmentId"));
      secret(field(payload, "enrollmentCode"));
      id(field(payload, "hostId"));
      httpsUrl(field(payload, "issuerUrl"));
      wssUrl(field(payload, "relayUrl"));
      integer(field(payload, "expiresAtMs"));
      break;
    }
    case "grant.revoke": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["grantId", "reason"]);
      id(field(payload, "grantId"));
      literal(field(payload, "reason"), "user_revoked");
      break;
    }
    case "grant.revoked": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["grantId", "revokedAtMs", "alreadyRevoked"]);
      id(field(payload, "grantId"));
      integer(field(payload, "revokedAtMs"));
      booleanValue(field(payload, "alreadyRevoked"));
      break;
    }
    case "host.reauthenticate": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["accessToken"]);
      secret(field(payload, "accessToken"));
      break;
    }
    case "host.reauthenticated": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["grantId", "jti", "expiresAtMs", "deduplicated"]);
      id(field(payload, "grantId"));
      id(field(payload, "jti"));
      integer(field(payload, "expiresAtMs"));
      booleanValue(field(payload, "deduplicated"));
      break;
    }
    case "host.auth_expiring": {
      carrierRoot(frame, type, ["connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, ["grantId", "expiresAtMs", "refreshRecommendedAtMs"]);
      id(field(payload, "grantId"));
      integer(field(payload, "expiresAtMs"));
      integer(field(payload, "refreshRecommendedAtMs"));
      break;
    }
    case "host.superseded": {
      carrierRoot(frame, type, ["connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "hostId",
        "losingConnectorId",
        "winningConnectorId",
        "losingHostInstanceId",
        "winningHostInstanceId",
        "reason",
      ]);
      for (const name of [
        "hostId",
        "losingConnectorId",
        "winningConnectorId",
        "losingHostInstanceId",
        "winningHostInstanceId",
      ]) {
        id(field(payload, name));
      }
      literal(field(payload, "reason"), "new_authenticated_connector");
      break;
    }
    case "carrier.error": {
      exact(frame, [
        "carrierVersion",
        "type",
        "requestId",
        "connectorId",
        "payload",
        "error",
      ]);
      literal(field(frame, "carrierVersion"), 1);
      literal(field(frame, "type"), type);
      id(field(frame, "requestId"));
      const payload = object(field(frame, "payload"));
      exact(payload, ["failedType"]);
      const failedType = oneOf(field(payload, "failedType"), [
        "host.hello",
        "host.reauthenticate",
        "enrollment.create",
        "grant.revoke",
      ] as const);
      if (failedType === "host.hello") {
        nullValue(field(frame, "connectorId"));
      } else {
        id(field(frame, "connectorId"));
      }
      validateStructuredError(field(frame, "error"));
      break;
    }
    case "host.hello": {
      carrierRoot(frame, type, ["requestId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "hostId",
        "hostEpoch",
        "hostInstanceId",
        "clientDialects",
        "capabilities",
        "limits",
      ]);
      id(field(payload, "hostId"));
      id(field(payload, "hostEpoch"));
      id(field(payload, "hostInstanceId"));
      const dialects = array(field(payload, "clientDialects"), (entry) => {
        oneOf(entry, ["tw-relay.v1", "tw-relay.v2"] as const);
      }, 2, 1);
      if (new Set(dialects as string[]).size !== dialects.length) {
        reject("schema-mismatch");
      }
      capabilities(field(payload, "capabilities"));
      const limits = object(field(payload, "limits"));
      exact(limits, ["maxFrameBytes", "terminalMaxFrameBytes"]);
      const maxFrameBytes = integer(field(limits, "maxFrameBytes"), 1);
      const terminalMaxFrameBytes = integer(field(limits, "terminalMaxFrameBytes"), 1);
      if (terminalMaxFrameBytes > maxFrameBytes) reject("invalid-argument");
      break;
    }
    case "host.registered": {
      carrierRoot(frame, type, ["requestId", "connectorId", "payload"]);
      const payload = object(field(frame, "payload"));
      exact(payload, [
        "brokerEpoch",
        "hostsRevision",
        "disposition",
        "supersededHostInstanceId",
        "limits",
      ]);
      id(field(payload, "brokerEpoch"));
      counter(field(payload, "hostsRevision"));
      oneOf(field(payload, "disposition"), ["connected", "replaced"] as const);
      nullable(field(payload, "supersededHostInstanceId"), id);
      const limits = object(field(payload, "limits"));
      exact(limits, [
        "maxCarrierFrameBytes",
        "brokerCarrierBufferedBytes",
        "brokerCarrierLowWaterBytes",
      ]);
      for (const item of Object.values(limits)) integer(item, 1);
      break;
    }
    case "route.open": {
      carrierRoot(frame, type, [
        "requestId",
        "connectorId",
        "routeId",
        "routeFence",
        "payload",
      ]);
      validateCarrierRouteIdentity(frame);
      const payload = object(field(frame, "payload"));
      exact(payload, ["connectionId", "clientDialect", "authContext", "limits"]);
      id(field(payload, "connectionId"));
      literal(field(payload, "clientDialect"), "tw-relay.v2");
      const auth = object(field(payload, "authContext"));
      exact(auth, [
        "scheme",
        "role",
        "hostId",
        "principalId",
        "grantId",
        "clientInstanceId",
        "jti",
        "kid",
        "expiresAtMs",
      ]);
      literal(field(auth, "scheme"), "twcap2");
      literal(field(auth, "role"), "client");
      for (const name of [
        "hostId",
        "principalId",
        "grantId",
        "clientInstanceId",
        "jti",
        "kid",
      ]) {
        id(field(auth, name));
      }
      integer(field(auth, "expiresAtMs"));
      const limits = object(field(payload, "limits"));
      exact(limits, ["maxFrameBytes"]);
      integer(field(limits, "maxFrameBytes"), 1);
      break;
    }
    case "route.opened": {
      carrierRoot(frame, type, [
        "requestId",
        "connectorId",
        "routeId",
        "routeFence",
        "payload",
      ]);
      validateCarrierRouteIdentity(frame);
      const payload = object(field(frame, "payload"));
      exact(payload, ["acceptedAtMs", "maxFrameBytes"]);
      integer(field(payload, "acceptedAtMs"));
      integer(field(payload, "maxFrameBytes"), 1);
      break;
    }
    case "route.rejected": {
      carrierRoot(frame, type, [
        "requestId",
        "connectorId",
        "routeId",
        "routeFence",
        "payload",
        "error",
      ]);
      validateCarrierRouteIdentity(frame);
      nullValue(field(frame, "payload"));
      validateStructuredError(field(frame, "error"));
      break;
    }
    case "route.data": {
      carrierRoot(frame, type, [
        "connectorId",
        "routeId",
        "routeFence",
        "direction",
        "seq",
        "payload",
      ]);
      validateCarrierRouteIdentity(frame);
      oneOf(field(frame, "direction"), ["client_to_host", "host_to_client"] as const);
      counter(field(frame, "seq"));
      const payload = object(field(frame, "payload"));
      exact(payload, ["opcode", "encoding", "data"]);
      literal(field(payload, "opcode"), "text");
      literal(field(payload, "encoding"), "base64");
      canonicalBase64(field(payload, "data"), 1_048_576);
      break;
    }
    case "route.unbind": {
      carrierRoot(frame, type, [
        "connectorId",
        "routeId",
        "routeFence",
        "payload",
      ]);
      validateCarrierRouteIdentity(frame);
      const payload = object(field(frame, "payload"));
      exact(payload, ["reason", "lastClientToHostSeq"]);
      oneOf(field(payload, "reason"), [
        "client_closed",
        "client_replaced",
        "auth_expired",
        "auth_revoked",
        "slow_consumer",
        "protocol_error",
        "broker_shutdown",
      ] as const);
      counter(field(payload, "lastClientToHostSeq"));
      break;
    }
    case "route.unbound": {
      carrierRoot(frame, type, [
        "connectorId",
        "routeId",
        "routeFence",
        "payload",
      ]);
      validateCarrierRouteIdentity(frame);
      const payload = object(field(frame, "payload"));
      exact(payload, ["reason", "lastClientToHostSeq", "lastHostToClientSeq"]);
      oneOf(field(payload, "reason"), [
        "client_closed",
        "client_replaced",
        "auth_expired",
        "auth_revoked",
        "slow_consumer",
        "protocol_error",
        "broker_shutdown",
      ] as const);
      counter(field(payload, "lastClientToHostSeq"));
      counter(field(payload, "lastHostToClientSeq"));
      break;
    }
    case "route.close": {
      carrierRoot(frame, type, [
        "connectorId",
        "routeId",
        "routeFence",
        "payload",
      ]);
      validateCarrierRouteIdentity(frame);
      const payload = object(field(frame, "payload"));
      exact(payload, ["closeCode", "reason", "error"]);
      integer(field(payload, "closeCode"), 1_000, 4_999);
      oneOf(field(payload, "reason"), [
        "slow_consumer",
        "protocol_error",
        "host_shutdown",
      ] as const);
      validateStructuredError(field(payload, "error"));
      break;
    }
    default:
      reject("unknown-message-type");
  }
  return {
    channel: "carrier",
    version: 1,
    type,
    requestId: Object.hasOwn(frame, "requestId") ? frame.requestId as string : null,
  };
}

function exactUrl(value: RelayV2JsonValue, protocol: "https:" | "wss:"): string {
  const text = stringValue(value, { maxBytes: 2_048 });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return reject("invalid-argument");
  }
  if (
    parsed.protocol !== protocol
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hash.length > 0
  ) {
    reject("invalid-argument");
  }
  return text;
}

function httpsUrl(value: RelayV2JsonValue): string {
  return exactUrl(value, "https:");
}

function wssUrl(value: RelayV2JsonValue): string {
  return exactUrl(value, "wss:");
}

function validateClientCredentialResponse(
  value: RelayV2JsonObject,
  attemptField: "exchangeAttemptId" | "refreshAttemptId",
): void {
  exact(value, [
    attemptField,
    "principalId",
    "grantId",
    "hostId",
    "relayUrl",
    "accessToken",
    "accessExpiresAtMs",
    "refreshToken",
    "refreshExpiresAtMs",
  ]);
  id(field(value, attemptField));
  id(field(value, "principalId"));
  id(field(value, "grantId"));
  id(field(value, "hostId"));
  wssUrl(field(value, "relayUrl"));
  secret(field(value, "accessToken"));
  integer(field(value, "accessExpiresAtMs"));
  secret(field(value, "refreshToken"));
  integer(field(value, "refreshExpiresAtMs"));
}

function validateHostCredentialResponse(
  value: RelayV2JsonObject,
  attemptField: "bootstrapAttemptId" | "refreshAttemptId",
): void {
  exact(value, [
    attemptField,
    "principalId",
    "grantId",
    "hostId",
    "accessToken",
    "accessExpiresAtMs",
    "refreshToken",
    "refreshExpiresAtMs",
  ]);
  id(field(value, attemptField));
  id(field(value, "principalId"));
  id(field(value, "grantId"));
  id(field(value, "hostId"));
  secret(field(value, "accessToken"));
  integer(field(value, "accessExpiresAtMs"));
  secret(field(value, "refreshToken"));
  integer(field(value, "refreshExpiresAtMs"));
}

export function validateRelayV2HttpsBody(
  schema: RelayV2HttpsSchema,
  body: RelayV2JsonObject,
): RelayV2NormalizedHttpsBody {
  switch (schema) {
    case "enrollment.redeem.request":
      exact(body, [
        "exchangeAttemptId",
        "enrollmentId",
        "enrollmentCode",
        "clientInstanceId",
        "deviceLabel",
      ]);
      id(field(body, "exchangeAttemptId"));
      id(field(body, "enrollmentId"));
      secret(field(body, "enrollmentCode"));
      id(field(body, "clientInstanceId"));
      stringValue(field(body, "deviceLabel"), {
        allowOuterWhitespace: true,
        maxBytes: 128,
      });
      break;
    case "enrollment.redeem.response":
      validateClientCredentialResponse(body, "exchangeAttemptId");
      break;
    case "token.refresh.client.request":
      exact(body, [
        "refreshAttemptId",
        "grantId",
        "clientInstanceId",
        "refreshToken",
      ]);
      id(field(body, "refreshAttemptId"));
      id(field(body, "grantId"));
      id(field(body, "clientInstanceId"));
      secret(field(body, "refreshToken"));
      break;
    case "token.refresh.client.response":
      validateClientCredentialResponse(body, "refreshAttemptId");
      break;
    case "grant.self-revoke.request":
      exact(body, ["reason"]);
      literal(field(body, "reason"), "user_revoked");
      break;
    case "grant.self-revoke.response":
      exact(body, ["grantId", "revokedAtMs", "alreadyRevoked"]);
      id(field(body, "grantId"));
      integer(field(body, "revokedAtMs"));
      booleanValue(field(body, "alreadyRevoked"));
      break;
    case "host.bootstrap.request":
      exact(body, [
        "bootstrapAttemptId",
        "bootstrapToken",
        "hostId",
        "hostEpoch",
        "hostInstanceId",
      ]);
      id(field(body, "bootstrapAttemptId"));
      secret(field(body, "bootstrapToken"));
      id(field(body, "hostId"));
      id(field(body, "hostEpoch"));
      id(field(body, "hostInstanceId"));
      break;
    case "host.bootstrap.response":
      validateHostCredentialResponse(body, "bootstrapAttemptId");
      break;
    case "token.refresh.host.request":
      exact(body, [
        "refreshAttemptId",
        "grantId",
        "hostInstanceId",
        "refreshToken",
      ]);
      id(field(body, "refreshAttemptId"));
      id(field(body, "grantId"));
      id(field(body, "hostInstanceId"));
      secret(field(body, "refreshToken"));
      break;
    case "token.refresh.host.response":
      validateHostCredentialResponse(body, "refreshAttemptId");
      break;
    case "error.response":
      exact(body, ["error"]);
      validateStructuredError(field(body, "error"));
      break;
  }
  return { channel: "https", schema };
}
