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

export const RELAY_AGENT_CHAT_CAPABILITY = "agent.chat.v2" as const;
export const RELAY_AGENT_CHAT_MAX_MESSAGE_UTF8_BYTES = 65_536;
export const RELAY_AGENT_CHAT_MAX_TURN_UTF8_BYTES = 262_144;
export const RELAY_AGENT_CHAT_MAX_CONTENT_PARTS = 16;
export const RELAY_AGENT_CHAT_MAX_IMAGE_BYTES = 4 * 1_024 * 1_024;
export const RELAY_AGENT_CHAT_IMAGE_CHUNK_BYTES = 192 * 1_024;
export const RELAY_AGENT_CHAT_MAX_HISTORY_TURNS = 256;
export const RELAY_AGENT_CHAT_MAX_STEERED_MESSAGES = 64;
export const RELAY_AGENT_CHAT_MAX_PROGRESS_STEPS = 16;
export const RELAY_AGENT_CHAT_CODEC_ERROR_DOMAIN =
  "relay-agent-chat-codec-v2" as const;

export type RelayAgentChatCodecErrorCode = "INVALID_ENVELOPE" | "PROTOCOL_UNSUPPORTED";

export interface RelayAgentChatCodecFailure {
  domain: typeof RELAY_AGENT_CHAT_CODEC_ERROR_DOMAIN;
  code: RelayAgentChatCodecErrorCode;
  failureClass: string;
}

export class RelayAgentChatCodecError extends Error implements RelayAgentChatCodecFailure {
  readonly domain = RELAY_AGENT_CHAT_CODEC_ERROR_DOMAIN;

  constructor(
    readonly code: RelayAgentChatCodecErrorCode,
    readonly failureClass: string,
  ) {
    super(
      code === "PROTOCOL_UNSUPPORTED"
        ? "Relay Agent chat extension transport encoding is unsupported"
        : "Relay Agent chat extension frame is invalid",
    );
    this.name = "RelayAgentChatCodecError";
  }
}

/** Stable cross-bundle classification seam; callers must not use instanceof. */
export function relayAgentChatCodecFailure(error: unknown): RelayAgentChatCodecFailure | null {
  if (error === null || typeof error !== "object") return null;
  const candidate = error as Partial<RelayAgentChatCodecFailure>;
  if (candidate.domain !== RELAY_AGENT_CHAT_CODEC_ERROR_DOMAIN
    || (candidate.code !== "INVALID_ENVELOPE" && candidate.code !== "PROTOCOL_UNSUPPORTED")
    || typeof candidate.failureClass !== "string"
    || candidate.failureClass.length === 0
    || Buffer.byteLength(candidate.failureClass, "utf8") > 128) {
    return null;
  }
  return Object.freeze({
    domain: RELAY_AGENT_CHAT_CODEC_ERROR_DOMAIN,
    code: candidate.code,
    failureClass: candidate.failureClass,
  });
}

const STANDARD_JSON_LIMITS: RelayV2JsonLimits = Object.freeze({
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
});

const EXTENSION_ERROR_CODES = new Set([
  "AGENT_CHAT_UNAVAILABLE",
  "AGENT_CHAT_SESSION_UNAVAILABLE",
  // This base-v2 lineage error remains owned by the base envelope.
  "HOST_EPOCH_MISMATCH",
]);

export interface RelayAgentChatNormalizedFrame {
  channel: "public";
  version: 2;
  capability: typeof RELAY_AGENT_CHAT_CAPABILITY;
  kind: "request" | "response" | "event";
  type: string;
  requestId: string | null;
}

export interface RelayAgentChatDecodedFrame {
  frame: RelayV2JsonObject;
  normalized: RelayAgentChatNormalizedFrame;
  canonicalWire: string;
}

class RelayAgentChatSchemaError extends Error {
  constructor(readonly failureClass: string) {
    super("Relay Agent chat extension frame does not match the frozen schema");
    this.name = "RelayAgentChatSchemaError";
  }
}

function reject(failureClass: string): never {
  throw new RelayAgentChatSchemaError(failureClass);
}

function codecFailure(error: unknown): never {
  if (relayAgentChatCodecFailure(error) !== null) throw error;
  if (error instanceof RelayV2JsonError || error instanceof RelayAgentChatSchemaError) {
    throw new RelayAgentChatCodecError("INVALID_ENVELOPE", error.failureClass);
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

function validateSteeredMessage(value: RelayV2JsonValue): void {
  const item = object(value);
  exact(item, ["message", "sentAt"]);
  text(field(item, "message"), RELAY_AGENT_CHAT_MAX_MESSAGE_UTF8_BYTES);
  text(field(item, "sentAt"), 64);
}

function validateProgressStep(value: RelayV2JsonValue): void {
  const step = object(value);
  exact(step, ["stepId", "kind", "title", "status"]);
  id(field(step, "stepId"));
  oneOf(field(step, "kind"), ["status", "tool"] as const);
  text(field(step, "title"), 240);
  oneOf(field(step, "status"), ["running", "completed", "failed"] as const);
}

const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

function validateContentPart(value: RelayV2JsonValue): void {
  const part = object(value);
  const type = oneOf(field(part, "type"), ["markdown", "image"] as const);
  if (type === "markdown") {
    exact(part, ["type", "text"]);
    text(field(part, "text"), RELAY_AGENT_CHAT_MAX_TURN_UTF8_BYTES);
    return;
  }
  exact(part, [
    "type", "imageId", "mimeType", "altText", "byteLength", "sha256",
  ]);
  const imageId = id(field(part, "imageId"));
  oneOf(field(part, "mimeType"), IMAGE_MIME_TYPES);
  text(field(part, "altText"), 1_024);
  integer(
    field(part, "byteLength"),
    1,
    RELAY_AGENT_CHAT_MAX_IMAGE_BYTES,
  );
  const sha256 = stringValue(field(part, "sha256"), { maxBytes: 64 });
  if (!/^[0-9a-f]{64}$/.test(sha256) || imageId !== `image-${sha256}`) {
    reject("invalid-argument");
  }
}

function validateTurn(value: RelayV2JsonValue): void {
  const turn = object(value);
  exact(
    turn,
    [
      "turnId", "session", "userMessage", "status", "content", "error", "sentAt",
      "completedAt", "steeredMessages", "progress",
    ],
  );
  id(field(turn, "turnId"));
  id(field(turn, "session"));
  text(field(turn, "userMessage"), RELAY_AGENT_CHAT_MAX_MESSAGE_UTF8_BYTES);
  const status = oneOf(
    field(turn, "status"),
    ["working", "replied", "failed", "recovery-required"] as const,
  );
  const content = nullable(field(turn, "content"), (items) => (
    array(items, validateContentPart, RELAY_AGENT_CHAT_MAX_CONTENT_PARTS, 1)
  ));
  array(field(turn, "progress"), validateProgressStep, RELAY_AGENT_CHAT_MAX_PROGRESS_STEPS);
  const error = nullable(field(turn, "error"), (item) => (
    text(item, 4_096)
  ));
  const completedAt = nullable(field(turn, "completedAt"), (item) => (
    text(item, 64)
  ));
  if (status === "working") {
    if (content !== null || completedAt !== null) reject("schema-mismatch");
  } else if (status === "replied") {
    if (content === null || error !== null || completedAt === null) reject("schema-mismatch");
  } else if (status === "failed" || status === "recovery-required") {
    if (content !== null || error === null || completedAt === null) reject("schema-mismatch");
  }
  text(field(turn, "sentAt"), 64);
  const steered = nullable(field(turn, "steeredMessages"), (items) => (
    array(items, validateSteeredMessage, RELAY_AGENT_CHAT_MAX_STEERED_MESSAGES)
  ));
  if (steered !== null && steered.length > 0 && status === "working") reject("schema-mismatch");
}

function validateSendPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["session", "message"]);
  id(field(payload, "session"));
  text(field(payload, "message"), RELAY_AGENT_CHAT_MAX_MESSAGE_UTF8_BYTES);
}

function validateHistoryPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["session"], ["limit"]);
  id(field(payload, "session"));
  if (Object.hasOwn(payload, "limit")) {
    integer(field(payload, "limit"), 1, RELAY_AGENT_CHAT_MAX_HISTORY_TURNS);
  }
}

function validateImageGetPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["session", "imageId", "offset"]);
  id(field(payload, "session"));
  id(field(payload, "imageId"));
  integer(field(payload, "offset"), 0, RELAY_AGENT_CHAT_MAX_IMAGE_BYTES - 1);
}

function validateSentPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["session", "turnId"]);
  id(field(payload, "session"));
  id(field(payload, "turnId"));
}

function validateEventPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["session", "turn"]);
  id(field(payload, "session"));
  validateTurn(field(payload, "turn"));
}

function validateHistoryResultPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, ["session", "turns"]);
  id(field(payload, "session"));
  array(field(payload, "turns"), validateTurn, RELAY_AGENT_CHAT_MAX_HISTORY_TURNS);
}

function validateImageChunkPayload(value: RelayV2JsonValue): void {
  const payload = object(value);
  exact(payload, [
    "session", "imageId", "mimeType", "byteLength", "sha256", "offset", "dataBase64",
    "nextOffset",
  ]);
  id(field(payload, "session"));
  const imageId = id(field(payload, "imageId"));
  oneOf(field(payload, "mimeType"), IMAGE_MIME_TYPES);
  const byteLength = integer(field(payload, "byteLength"), 1, RELAY_AGENT_CHAT_MAX_IMAGE_BYTES);
  const sha256 = stringValue(field(payload, "sha256"), { maxBytes: 64 });
  const offset = integer(field(payload, "offset"), 0, byteLength - 1);
  const dataBase64 = stringValue(field(payload, "dataBase64"), {
    allowOuterWhitespace: true,
    maxBytes: Math.ceil(RELAY_AGENT_CHAT_IMAGE_CHUNK_BYTES / 3) * 4,
  });
  if (!/^[0-9a-f]{64}$/.test(sha256) || imageId !== `image-${sha256}`
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
    reject("invalid-argument");
  }
  const data = Buffer.from(dataBase64, "base64");
  if (data.byteLength === 0 || data.byteLength > RELAY_AGENT_CHAT_IMAGE_CHUNK_BYTES
    || data.toString("base64") !== dataBase64 || offset + data.byteLength > byteLength) {
    reject("schema-mismatch");
  }
  const nextOffset = nullable(field(payload, "nextOffset"), (item) => (
    integer(item, offset + 1, byteLength - 1)
  ));
  if ((nextOffset === null) !== (offset + data.byteLength === byteLength)
    || (nextOffset !== null && nextOffset !== offset + data.byteLength)) {
    reject("schema-mismatch");
  }
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

export function validateRelayAgentChatFrame(
  frame: RelayV2JsonObject,
): RelayAgentChatNormalizedFrame {
  const type = stringValue(field(frame, "type"), { maxBytes: 128 });
  switch (type) {
    case "agent.chat.send": {
      validateTargetRequest(frame, type);
      validateSendPayload(field(frame, "payload"));
      break;
    }
    case "agent.chat.history": {
      validateTargetRequest(frame, type);
      validateHistoryPayload(field(frame, "payload"));
      break;
    }
    case "agent.chat.image.get": {
      validateTargetRequest(frame, type);
      validateImageGetPayload(field(frame, "payload"));
      break;
    }
    case "agent.chat.sent": {
      validateTargetResponse(frame, type);
      validateSentPayload(field(frame, "payload"));
      break;
    }
    case "agent.chat.event": {
      validateTargetEvent(frame, type);
      validateEventPayload(field(frame, "payload"));
      break;
    }
    case "agent.chat.history.result": {
      validateTargetResponse(frame, type);
      validateHistoryResultPayload(field(frame, "payload"));
      break;
    }
    case "agent.chat.image.chunk": {
      validateTargetResponse(frame, type);
      validateImageChunkPayload(field(frame, "payload"));
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
    capability: RELAY_AGENT_CHAT_CAPABILITY,
    kind: frame.kind as "request" | "response" | "event",
    type,
    requestId: Object.hasOwn(frame, "requestId") ? frame.requestId as string : null,
  });
}

function parseFrame(bytes: Uint8Array, metadata: RelayV2FrameMetadata): RelayV2JsonObject {
  if ((metadata.opcode ?? "text") !== "text") {
    throw new RelayAgentChatCodecError("INVALID_ENVELOPE", "binary-frame");
  }
  if (metadata.compressed === true) {
    throw new RelayAgentChatCodecError("PROTOCOL_UNSUPPORTED", "compression-not-allowed");
  }
  if (bytes.byteLength > RELAY_V2_PUBLIC_FRAME_BYTES) {
    throw new RelayAgentChatCodecError("INVALID_ENVELOPE", "frame-limit");
  }
  const source = decodeRelayV2StrictUtf8(bytes);
  const inspection = inspectRelayV2Json(source, STANDARD_JSON_LIMITS);
  if (inspection.totalKeys > STANDARD_JSON_LIMITS.maxTotalKeys) {
    throw new RelayAgentChatCodecError("INVALID_ENVELOPE", "json-total-key-limit");
  }
  if (inspection.totalNodes > STANDARD_JSON_LIMITS.maxNodes) {
    throw new RelayAgentChatCodecError("INVALID_ENVELOPE", "json-node-limit");
  }
  return parseRelayV2JsonObject(source, STANDARD_JSON_LIMITS);
}

export function decodeRelayAgentChatFrame(
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata = {},
): RelayAgentChatDecodedFrame {
  try {
    const frame = parseFrame(bytes, metadata);
    return Object.freeze({
      frame,
      normalized: validateRelayAgentChatFrame(frame),
      canonicalWire: JSON.stringify(frame),
    });
  } catch (error) {
    return codecFailure(error);
  }
}

export function encodeRelayAgentChatFrame(
  frame: RelayV2JsonObject,
): Uint8Array {
  try {
    validateRelayAgentChatFrame(frame);
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    validateRelayAgentChatFrame(parseFrame(bytes, {}));
    return bytes;
  } catch (error) {
    return codecFailure(error);
  }
}

/** Envelope helper for host/broker unavailable responses. */
export function encodeRelayAgentChatUnavailableError(input: {
  requestId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  code: "AGENT_CHAT_UNAVAILABLE" | "AGENT_CHAT_SESSION_UNAVAILABLE";
  message: string;
  retryable: boolean;
}): Uint8Array {
  return encodeRelayAgentChatFrame({
    protocolVersion: 2,
    kind: "response",
    type: "error",
    requestId: input.requestId,
    hostId: input.hostId,
    hostEpoch: input.hostEpoch,
    scopeId: input.scopeId,
    sessionId: input.sessionId,
    payload: null,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      commandDisposition: "not_applicable",
    },
  });
}
