import {
  RELAY_V2_PUBLIC_FRAME_BYTES,
  type RelayV2FrameMetadata,
} from "../../../v2/codec.js";
import type { RelayV2JsonObject } from "../../../v2/codecSchema.js";
import { createCodecSchemaHelpers } from "../../../v2/codecSchemaHelpers.js";
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

const {
  exact,
  field,
  id,
  literal,
  object,
  oneOf,
  stringValue,
} = createCodecSchemaHelpers(reject, { wellFormedStrings: true });

function name(value: RelayV2JsonValue): string {
  return stringValue(value, { maxBytes: 1_024, allowOuterWhitespace: true });
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
  stringValue(field(error, "message"), { maxBytes: 4_096, allowOuterWhitespace: true });
  if (typeof field(error, "retryable") !== "boolean") reject("type-coercion");
  literal(field(error, "commandDisposition"), "not_applicable");
}

export function validateRelayLarkBindingsFrame(
  frame: RelayV2JsonObject,
): RelayLarkBindingsNormalizedFrame {
  const type = stringValue(field(frame, "type"), { maxBytes: 128 });
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
