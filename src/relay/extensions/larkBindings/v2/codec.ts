import {
  RELAY_V2_PUBLIC_FRAME_BYTES,
  type RelayV2FrameMetadata,
} from "../../../v2/codec.js";
import type { RelayV2JsonObject } from "../../../v2/codecSchema.js";
import {
  decodeRelayV2StrictUtf8,
  inspectRelayV2Json,
  parseRelayV2JsonObject,
  RelayV2JsonError,
  type RelayV2JsonLimits,
  type RelayV2JsonValue,
} from "../../../v2/strictJson.js";

export const RELAY_LARK_BINDINGS_CAPABILITY = "lark.bindings.v2" as const;
export const RELAY_LARK_BINDINGS_MAX_BINDINGS = 256;
export const RELAY_LARK_BINDINGS_CODEC_ERROR_DOMAIN =
  "relay-lark-bindings-codec-v2" as const;

export type RelayLarkBindingsCodecErrorCode =
  | "INVALID_ENVELOPE"
  | "PROTOCOL_UNSUPPORTED";

export interface RelayLarkBindingsCodecFailure {
  domain: typeof RELAY_LARK_BINDINGS_CODEC_ERROR_DOMAIN;
  code: RelayLarkBindingsCodecErrorCode;
  failureClass: string;
}

export class RelayLarkBindingsCodecError extends Error
  implements RelayLarkBindingsCodecFailure {
  readonly domain = RELAY_LARK_BINDINGS_CODEC_ERROR_DOMAIN;

  constructor(
    readonly code: RelayLarkBindingsCodecErrorCode,
    readonly failureClass: string,
  ) {
    super(
      code === "PROTOCOL_UNSUPPORTED"
        ? "Relay Lark bindings extension transport encoding is unsupported"
        : "Relay Lark bindings extension frame is invalid",
    );
    this.name = "RelayLarkBindingsCodecError";
  }
}

export function relayLarkBindingsCodecFailure(
  error: unknown,
): RelayLarkBindingsCodecFailure | null {
  if (error === null || typeof error !== "object") return null;
  const candidate = error as Partial<RelayLarkBindingsCodecFailure>;
  if (candidate.domain !== RELAY_LARK_BINDINGS_CODEC_ERROR_DOMAIN
    || (candidate.code !== "INVALID_ENVELOPE"
      && candidate.code !== "PROTOCOL_UNSUPPORTED")
    || typeof candidate.failureClass !== "string"
    || candidate.failureClass.length === 0
    || Buffer.byteLength(candidate.failureClass, "utf8") > 128) {
    return null;
  }
  return Object.freeze({
    domain: RELAY_LARK_BINDINGS_CODEC_ERROR_DOMAIN,
    code: candidate.code,
    failureClass: candidate.failureClass,
  });
}

export type RelayLarkBindingStatus = "active" | "pausing" | "paused" | "stale";
export type RelayLarkBindingReplyMode = "topic" | "direct";

export interface RelayLarkBindingProjection extends RelayV2JsonObject {
  id: string;
  chatName: string;
  sessionName: string;
  status: RelayLarkBindingStatus;
  replyMode: RelayLarkBindingReplyMode;
}

export interface RelayLarkBindingsNormalizedFrame {
  channel: "public";
  version: 2;
  capability: typeof RELAY_LARK_BINDINGS_CAPABILITY;
  kind: "request" | "response";
  type: string;
  requestId: string;
}

export interface RelayLarkBindingsDecodedFrame {
  frame: RelayV2JsonObject;
  normalized: RelayLarkBindingsNormalizedFrame;
  canonicalWire: string;
}

class RelayLarkBindingsSchemaError extends Error {
  constructor(readonly failureClass: string) {
    super("Relay Lark bindings extension frame does not match the frozen schema");
    this.name = "RelayLarkBindingsSchemaError";
  }
}

const JSON_LIMITS: RelayV2JsonLimits = Object.freeze({
  maxDepth: 12,
  maxDirectKeys: 256,
  maxTotalKeys: 4_096,
  maxNodes: 8_192,
});

function reject(failureClass: string): never {
  throw new RelayLarkBindingsSchemaError(failureClass);
}

function codecFailure(error: unknown): never {
  if (relayLarkBindingsCodecFailure(error) !== null) throw error;
  if (error instanceof RelayV2JsonError || error instanceof RelayLarkBindingsSchemaError) {
    throw new RelayLarkBindingsCodecError("INVALID_ENVELOPE", error.failureClass);
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
): void {
  const allowed = new Set(required);
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

function wellFormed(value: string): void {
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
  maxBytes: number,
  allowWhitespace = false,
): string {
  if (value === null) reject("forbidden-null");
  if (typeof value !== "string") reject("type-coercion");
  wellFormed(value);
  if (value.length === 0 || value.includes("\0")) reject("invalid-argument");
  if (!allowWhitespace && value.trim() !== value) reject("invalid-argument");
  if (Buffer.byteLength(value, "utf8") > maxBytes) reject("id-byte-limit");
  return value;
}

function id(value: RelayV2JsonValue): string {
  return stringValue(value, 128);
}

function name(value: RelayV2JsonValue): string {
  return stringValue(value, 1_024, true);
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

function binding(value: RelayV2JsonValue): void {
  const item = object(value);
  exact(item, ["id", "chatName", "sessionName", "status", "replyMode"]);
  id(field(item, "id"));
  name(field(item, "chatName"));
  name(field(item, "sessionName"));
  oneOf(field(item, "status"), ["active", "pausing", "paused", "stale"] as const);
  oneOf(field(item, "replyMode"), ["topic", "direct"] as const);
}

function bindings(value: RelayV2JsonValue): void {
  if (!Array.isArray(value)) reject("type-coercion");
  if (value.length > RELAY_LARK_BINDINGS_MAX_BINDINGS) reject("invalid-argument");
  value.forEach(binding);
}

function targetRoot(
  frame: RelayV2JsonObject,
  kind: "request" | "response",
  type: string,
): void {
  exact(frame, [
    "protocolVersion", "kind", "type", "requestId", "hostId",
    kind === "request" ? "expectedHostEpoch" : "hostEpoch",
    "scopeId", "sessionId", "payload",
  ]);
  literal(field(frame, "protocolVersion"), 2);
  literal(field(frame, "kind"), kind);
  literal(field(frame, "type"), type);
  for (const key of [
    "requestId", "hostId", kind === "request" ? "expectedHostEpoch" : "hostEpoch",
    "scopeId", "sessionId",
  ]) id(field(frame, key));
}

function requestPayload(frame: RelayV2JsonObject): RelayV2JsonObject {
  return object(field(frame, "payload"));
}

function validateGet(frame: RelayV2JsonObject): void {
  targetRoot(frame, "request", "lark.bindings.get");
  exact(requestPayload(frame), []);
}

function validateUpdate(frame: RelayV2JsonObject): void {
  targetRoot(frame, "request", "lark.binding.reply_mode.update");
  const payload = requestPayload(frame);
  exact(payload, ["bindingId", "replyMode"]);
  id(field(payload, "bindingId"));
  oneOf(field(payload, "replyMode"), ["topic", "direct"] as const);
}

function validateUnlink(frame: RelayV2JsonObject): void {
  targetRoot(frame, "request", "lark.binding.unlink");
  const payload = requestPayload(frame);
  exact(payload, ["bindingId"]);
  id(field(payload, "bindingId"));
}

function validateListResult(frame: RelayV2JsonObject): void {
  targetRoot(frame, "response", "lark.bindings.result");
  const payload = requestPayload(frame);
  exact(payload, ["bindings"]);
  bindings(field(payload, "bindings"));
}

function validateUpdated(frame: RelayV2JsonObject): void {
  targetRoot(frame, "response", "lark.binding.updated");
  const payload = requestPayload(frame);
  exact(payload, ["binding"]);
  binding(field(payload, "binding"));
}

function validateUnlinked(frame: RelayV2JsonObject): void {
  targetRoot(frame, "response", "lark.binding.unlinked");
  const payload = requestPayload(frame);
  exact(payload, ["bindingId"]);
  id(field(payload, "bindingId"));
}

function validateError(frame: RelayV2JsonObject): void {
  exact(frame, [
    "protocolVersion", "kind", "type", "requestId", "hostId", "hostEpoch",
    "scopeId", "sessionId", "payload", "error",
  ]);
  literal(field(frame, "protocolVersion"), 2);
  literal(field(frame, "kind"), "response");
  literal(field(frame, "type"), "error");
  for (const key of [
    "requestId", "hostId", "hostEpoch", "scopeId", "sessionId",
  ]) id(field(frame, key));
  if (field(frame, "payload") !== null) reject("schema-mismatch");
  const error = object(field(frame, "error"));
  exact(error, ["code", "message", "retryable", "commandDisposition"]);
  oneOf(
    field(error, "code"),
    ["LARK_BINDINGS_UNAVAILABLE", "LARK_BINDING_INVALID"] as const,
  );
  stringValue(field(error, "message"), 4_096, true);
  if (typeof field(error, "retryable") !== "boolean") reject("type-coercion");
  literal(field(error, "commandDisposition"), "not_applicable");
}

export function validateRelayLarkBindingsFrame(
  frame: RelayV2JsonObject,
): RelayLarkBindingsNormalizedFrame {
  const type = stringValue(field(frame, "type"), 128);
  switch (type) {
    case "lark.bindings.get": validateGet(frame); break;
    case "lark.binding.reply_mode.update": validateUpdate(frame); break;
    case "lark.binding.unlink": validateUnlink(frame); break;
    case "lark.bindings.result": validateListResult(frame); break;
    case "lark.binding.updated": validateUpdated(frame); break;
    case "lark.binding.unlinked": validateUnlinked(frame); break;
    case "error": validateError(frame); break;
    default: reject("unknown-message-type");
  }
  return Object.freeze({
    channel: "public",
    version: 2,
    capability: RELAY_LARK_BINDINGS_CAPABILITY,
    kind: frame.kind as "request" | "response",
    type,
    requestId: frame.requestId as string,
  });
}

function parseFrame(
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata,
): RelayV2JsonObject {
  if ((metadata.opcode ?? "text") !== "text") {
    throw new RelayLarkBindingsCodecError("INVALID_ENVELOPE", "binary-frame");
  }
  if (metadata.compressed === true) {
    throw new RelayLarkBindingsCodecError(
      "PROTOCOL_UNSUPPORTED",
      "compression-not-allowed",
    );
  }
  if (bytes.byteLength > RELAY_V2_PUBLIC_FRAME_BYTES) {
    throw new RelayLarkBindingsCodecError("INVALID_ENVELOPE", "frame-limit");
  }
  const source = decodeRelayV2StrictUtf8(bytes);
  const inspection = inspectRelayV2Json(source, JSON_LIMITS);
  if (inspection.totalKeys > JSON_LIMITS.maxTotalKeys) {
    throw new RelayLarkBindingsCodecError("INVALID_ENVELOPE", "json-total-key-limit");
  }
  if (inspection.totalNodes > JSON_LIMITS.maxNodes) {
    throw new RelayLarkBindingsCodecError("INVALID_ENVELOPE", "json-node-limit");
  }
  return parseRelayV2JsonObject(source, JSON_LIMITS);
}

export function decodeRelayLarkBindingsFrame(
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata = {},
): RelayLarkBindingsDecodedFrame {
  try {
    const frame = parseFrame(bytes, metadata);
    return Object.freeze({
      frame,
      normalized: validateRelayLarkBindingsFrame(frame),
      canonicalWire: JSON.stringify(frame),
    });
  } catch (error) {
    return codecFailure(error);
  }
}

export function encodeRelayLarkBindingsFrame(
  frame: RelayV2JsonObject,
): Uint8Array {
  try {
    validateRelayLarkBindingsFrame(frame);
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    validateRelayLarkBindingsFrame(parseFrame(bytes, {}));
    return bytes;
  } catch (error) {
    return codecFailure(error);
  }
}

export function encodeRelayLarkBindingsError(input: {
  requestId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  code: "LARK_BINDINGS_UNAVAILABLE" | "LARK_BINDING_INVALID";
  message: string;
  retryable: boolean;
}): Uint8Array {
  return encodeRelayLarkBindingsFrame({
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
