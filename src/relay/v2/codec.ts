import {
  RelayV2SchemaError,
  validateRelayV2CommandRouteEnvelope as validateRelayV2CommandRouteEnvelopeSchema,
  validateRelayV2CarrierFrame,
  validateRelayV2HttpsBody,
  validateRelayV2PublicFrame,
  type RelayV2HttpsSchema,
  type RelayV2CommandRouteEnvelope,
  type RelayV2JsonObject,
  type RelayV2NormalizedMessage,
} from "./codecSchema.js";
import {
  decodeRelayV2StrictUtf8,
  inspectRelayV2Json,
  parseRelayV2JsonObject,
  RelayV2JsonError,
  type RelayV2JsonLimits,
} from "./strictJson.js";

export const RELAY_V2_PUBLIC_FRAME_BYTES = 1_048_576;
export const RELAY_V2_CARRIER_FRAME_BYTES = 1_500_000;
export const RELAY_V2_HTTP_BODY_BYTES = 16_384;

export type RelayV2WebSocketChannel = "public" | "carrier";

export interface RelayV2FrameMetadata {
  opcode?: "text" | "binary";
  compressed?: boolean;
}

export interface RelayV2DecodedMessage {
  frame: RelayV2JsonObject;
  normalized: RelayV2NormalizedMessage;
  canonicalWire: string;
}

export interface RelayV2DecodedCommandRouteEnvelope {
  frame: RelayV2JsonObject;
  envelope: RelayV2CommandRouteEnvelope;
  canonicalWire: string;
}

export type RelayV2CodecErrorCode = "INVALID_ENVELOPE" | "PROTOCOL_UNSUPPORTED";

export class RelayV2CodecError extends Error {
  constructor(
    readonly code: RelayV2CodecErrorCode,
    readonly failureClass: string,
  ) {
    super(
      code === "PROTOCOL_UNSUPPORTED"
        ? "Relay v2 transport encoding is unsupported"
        : "Relay v2 frame is invalid",
    );
    this.name = "RelayV2CodecError";
  }
}

const STANDARD_JSON_LIMITS: RelayV2JsonLimits = {
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
};

const SNAPSHOT_JSON_LIMITS: RelayV2JsonLimits = {
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: 8_192,
  maxNodes: 16_384,
};

const HTTP_JSON_LIMITS: RelayV2JsonLimits = {
  maxDepth: 8,
  maxDirectKeys: 32,
  maxTotalKeys: 32,
  maxNodes: 128,
};

function codecFailure(error: unknown): never {
  if (error instanceof RelayV2CodecError) throw error;
  if (error instanceof RelayV2JsonError || error instanceof RelayV2SchemaError) {
    throw new RelayV2CodecError("INVALID_ENVELOPE", error.failureClass);
  }
  throw error;
}

function parseWebSocketObject(
  channel: RelayV2WebSocketChannel,
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata,
): RelayV2JsonObject {
  if ((metadata.opcode ?? "text") !== "text") {
    throw new RelayV2CodecError("INVALID_ENVELOPE", "binary-frame");
  }
  if (metadata.compressed === true) {
    throw new RelayV2CodecError("PROTOCOL_UNSUPPORTED", "compression-not-allowed");
  }
  const frameLimit = channel === "public"
    ? RELAY_V2_PUBLIC_FRAME_BYTES
    : RELAY_V2_CARRIER_FRAME_BYTES;
  if (bytes.byteLength > frameLimit) {
    throw new RelayV2CodecError("INVALID_ENVELOPE", "frame-limit");
  }
  const source = decodeRelayV2StrictUtf8(bytes);
  const inspection = inspectRelayV2Json(
    source,
    channel === "public" ? SNAPSHOT_JSON_LIMITS : STANDARD_JSON_LIMITS,
  );
  const limits = channel === "public"
      && inspection.rootIsObject
      && inspection.rootType === "state.snapshot.chunk"
    ? SNAPSHOT_JSON_LIMITS
    : STANDARD_JSON_LIMITS;
  if (inspection.totalKeys > limits.maxTotalKeys) {
    throw new RelayV2CodecError("INVALID_ENVELOPE", "json-total-key-limit");
  }
  if (inspection.totalNodes > limits.maxNodes) {
    throw new RelayV2CodecError("INVALID_ENVELOPE", "json-node-limit");
  }
  return parseRelayV2JsonObject(source, limits);
}

function parseHttpObject(
  bytes: Uint8Array,
  contentEncoding: string | null,
): RelayV2JsonObject {
  if (
    contentEncoding !== null
    && contentEncoding.length > 0
    && contentEncoding.toLowerCase() !== "identity"
  ) {
    throw new RelayV2CodecError("PROTOCOL_UNSUPPORTED", "compression-not-allowed");
  }
  if (bytes.byteLength > RELAY_V2_HTTP_BODY_BYTES) {
    throw new RelayV2CodecError("INVALID_ENVELOPE", "frame-limit");
  }
  const source = decodeRelayV2StrictUtf8(bytes);
  return parseRelayV2JsonObject(source, HTTP_JSON_LIMITS);
}

export function decodeRelayV2WebSocketFrame(
  channel: RelayV2WebSocketChannel,
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata = {},
): RelayV2DecodedMessage {
  try {
    const frame = parseWebSocketObject(channel, bytes, metadata);
    const normalized = channel === "public"
      ? validateRelayV2PublicFrame(frame)
      : validateRelayV2CarrierFrame(frame);
    return {
      frame,
      normalized,
      canonicalWire: JSON.stringify(frame),
    };
  } catch (error) {
    return codecFailure(error);
  }
}

export function decodeRelayV2CommandRouteEnvelope(
  bytes: Uint8Array,
  metadata: RelayV2FrameMetadata = {},
): RelayV2DecodedCommandRouteEnvelope {
  try {
    const frame = parseWebSocketObject("public", bytes, metadata);
    return {
      frame,
      envelope: validateRelayV2CommandRouteEnvelopeSchema(frame),
      canonicalWire: JSON.stringify(frame),
    };
  } catch (error) {
    return codecFailure(error);
  }
}

export function decodeRelayV2HttpsBody(
  schema: RelayV2HttpsSchema,
  bytes: Uint8Array,
  contentEncoding: string | null = null,
): RelayV2DecodedMessage {
  try {
    const frame = parseHttpObject(bytes, contentEncoding);
    return {
      frame,
      normalized: validateRelayV2HttpsBody(schema, frame),
      canonicalWire: JSON.stringify(frame),
    };
  } catch (error) {
    return codecFailure(error);
  }
}

function encodeChecked(
  frame: RelayV2JsonObject,
  normalized: RelayV2NormalizedMessage,
  limit: number,
): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(frame));
  if (bytes.byteLength > limit) {
    throw new RelayV2CodecError("INVALID_ENVELOPE", "frame-limit");
  }
  void normalized;
  return bytes;
}

export function encodeRelayV2WebSocketFrame(
  channel: RelayV2WebSocketChannel,
  frame: RelayV2JsonObject,
): Uint8Array {
  try {
    const normalized = channel === "public"
      ? validateRelayV2PublicFrame(frame)
      : validateRelayV2CarrierFrame(frame);
    return encodeChecked(
      frame,
      normalized,
      channel === "public"
        ? RELAY_V2_PUBLIC_FRAME_BYTES
        : RELAY_V2_CARRIER_FRAME_BYTES,
    );
  } catch (error) {
    return codecFailure(error);
  }
}

export function validateRelayV2CommandRouteEnvelope(
  frame: RelayV2JsonObject,
): RelayV2CommandRouteEnvelope {
  try {
    const envelope = validateRelayV2CommandRouteEnvelopeSchema(frame);
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    if (bytes.byteLength > RELAY_V2_PUBLIC_FRAME_BYTES) {
      throw new RelayV2CodecError("INVALID_ENVELOPE", "frame-limit");
    }
    return envelope;
  } catch (error) {
    return codecFailure(error);
  }
}

export function encodeRelayV2HttpsBody(
  schema: RelayV2HttpsSchema,
  body: RelayV2JsonObject,
): Uint8Array {
  try {
    return encodeChecked(
      body,
      validateRelayV2HttpsBody(schema, body),
      RELAY_V2_HTTP_BODY_BYTES,
    );
  } catch (error) {
    return codecFailure(error);
  }
}

export type RelayV2ClientDialect = "tw-relay.v1" | "tw-relay.v2";

export type RelayV2DialectOutcome =
  | {
      outcome: "accept";
      selectedDialect: RelayV2ClientDialect;
      translation: false;
      fallback: false;
    }
  | {
      outcome: "reject";
      errorCode: "HOST_DIALECT_UNAVAILABLE" | "CAPABILITY_UNAVAILABLE";
      fallback: false;
    };

export function resolveRelayV2RouteDialect(input: {
  clientDialect: RelayV2ClientDialect;
  hostDialects: readonly RelayV2ClientDialect[];
  requiredCapabilities?: readonly string[];
  hostCapabilities?: readonly string[];
}): RelayV2DialectOutcome {
  if (!input.hostDialects.includes(input.clientDialect)) {
    return {
      outcome: "reject",
      errorCode: "HOST_DIALECT_UNAVAILABLE",
      fallback: false,
    };
  }
  if (input.clientDialect === "tw-relay.v2") {
    const required = input.requiredCapabilities ?? [];
    const available = new Set(input.hostCapabilities ?? []);
    if (required.some((capability) => !available.has(capability))) {
      return {
        outcome: "reject",
        errorCode: "CAPABILITY_UNAVAILABLE",
        fallback: false,
      };
    }
  }
  return {
    outcome: "accept",
    selectedDialect: input.clientDialect,
    translation: false,
    fallback: false,
  };
}
