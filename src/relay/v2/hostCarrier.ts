import { randomUUID } from "node:crypto";
import {
  RELAY_V2_CARRIER_ROUTE_HARD_LIMIT,
  RELAY_V2_CARRIER_ROUTE_IDENTITY_HARD_LIMIT,
} from "./carrierLimits.js";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
  RELAY_V2_PUBLIC_FRAME_BYTES,
  type RelayV2FrameMetadata,
} from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RelayV2DashboardManagementHostCarrierControlAdapter,
} from "./relayV2DashboardManagementHostCarrierControlAdapter.js";

export const RELAY_V2_HOST_SUPERSEDED_EXIT_CODE = 78;

const MAX_COUNTER = 18_446_744_073_709_551_615n;
const DEFAULT_TERMINAL_FRAME_BYTES = 65_536;
const MAX_CARRIER_BUFFER_BYTES = 16 * 1_048_576;

export type RelayV2HostCarrierPhase =
  | "connecting"
  | "registered"
  | "offline"
  | "superseded";

export interface RelayV2HostCarrierStatus {
  phase: RelayV2HostCarrierPhase;
  generation: number;
  connectorId: string | null;
  disposition?: "connected" | "replaced";
  closeCode?: number;
  winningConnectorId?: string;
  winningHostInstanceId?: string;
}

export interface RelayV2HostCarrierTransport {
  /**
   * Return true only after ownership of the complete frame has been accepted.
   * False means the transport retained no bytes; the actor owns the retry.
   * The transport must not synchronously reenter any connection callback.
   */
  trySend(frame: Uint8Array, deliveryToken: string): boolean;
  /**
   * Actor-owned application bytes accepted by this transport and not yet
   * removed from its FIFO buffer. No unrelated socket bytes may be included.
   */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

export interface RelayV2HostCarrierOutboundReceipt {
  settle(delivered: boolean): void;
}

export type RelayV2HostCarrierRouteClose =
  | Readonly<{
      closeCode: 1013;
      reason: "slow_consumer";
      errorCode: "SLOW_CONSUMER";
      retryable: true;
    }>
  | Readonly<{
      closeCode: 4400;
      reason: "protocol_error";
      errorCode: "INTERNAL";
      retryable: false;
    }>
  | Readonly<{
      closeCode: 4406;
      reason: "protocol_error";
      errorCode: "CAPABILITY_UNAVAILABLE";
      retryable: false;
    }>
  | Readonly<{
      closeCode: 1011;
      reason: "host_shutdown";
      errorCode: "INTERNAL";
      retryable: false;
    }>
  | Readonly<{
      closeCode: 4409;
      reason: "host_shutdown";
      errorCode: "HOST_SUPERSEDED";
      retryable: false;
    }>;

export interface RelayV2HostCredentialRecord {
  reference: string;
  version: string;
  grantId: string;
  accessJti: string;
  accessToken: string;
}

export interface RelayV2HostCredentialAckFence {
  reference: string;
  version: string;
  requestId: string;
  grantId: string;
  accessJti: string;
}

/**
 * The credential owner performs the durable preparation and ACK CAS. The
 * carrier sends only the returned winner and presents an ACK when its
 * connector/request/jti/reference fence is still current. This module
 * intentionally provides no credential authority or persistence adapter; G1
 * integration must inject the dedicated v2 implementation.
 */
export interface RelayV2HostCarrierCredentialReferences {
  read(reference: string): RelayV2HostCredentialRecord;
  prepareReauthentication(input: {
    credentialReference: string;
    requestId: string;
  }): {
    fence: RelayV2HostCredentialAckFence;
    accessToken: string;
  };
  acknowledgeReauthentication(fence: RelayV2HostCredentialAckFence): boolean;
}

export interface RelayV2HostRouteV2AuthContext {
  scheme: "twcap2";
  role: "client";
  hostId: string;
  principalId: string;
  grantId: string;
  clientInstanceId: string;
  jti: string;
  kid: string;
  expiresAtMs: number;
}

export interface RelayV2HostRouteV1AuthContext {
  scheme: "legacy_shared_secret";
  role: "client";
  hostId: string;
  principalId: null;
  grantId: null;
  clientInstanceId: null;
}

export type RelayV2HostRouteAuthContext =
  | RelayV2HostRouteV2AuthContext
  | RelayV2HostRouteV1AuthContext;

export type RelayV2HostCarrierClientDialect = "tw-relay.v1" | "tw-relay.v2";

export interface RelayV2HostCarrierDialectAdapter {
  /** Validate inbound and outbound bytes without rewriting either direction. */
  validate(payload: Uint8Array): void;
}

export interface RelayV2HostCarrierPublicPayloadDecoder {
  /** Called only after canonical encoded-length preflight passed. */
  decodeCanonicalBase64(encoded: string): Uint8Array;
}

export interface RelayV2HostRouteBinding {
  readonly connectorGeneration: number;
  readonly connectorId: string;
  readonly routeId: string;
  readonly routeFence: string;
  readonly connectionId: string;
  readonly clientDialect: RelayV2HostCarrierClientDialect;
  readonly maxFrameBytes: number;
  readonly authContext: Readonly<RelayV2HostRouteAuthContext>;
}

export type RelayV2HostRouteUnbindReason =
  | "client_closed"
  | "client_replaced"
  | "auth_expired"
  | "auth_revoked"
  | "slow_consumer"
  | "protocol_error"
  | "broker_shutdown";

export type RelayV2HostLocalUnbindReason =
  | RelayV2HostRouteUnbindReason
  | "carrier_closed"
  | "connector_replaced"
  | "host_superseded";

export type RelayV2HostCarrierStructuredErrorCode =
  | "BUSY"
  | "PERMISSION_DENIED"
  | "HOST_DIALECT_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "SLOW_CONSUMER"
  | "HOST_SUPERSEDED"
  | "INTERNAL";

export interface RelayV2HostRouteBindingRejection {
  readonly accepted: false;
  readonly code: Exclude<
    RelayV2HostCarrierStructuredErrorCode,
    "SLOW_CONSUMER" | "HOST_SUPERSEDED"
  >;
  readonly message: string;
  readonly retryable: boolean;
}

const HOST_ROUTE_BINDING_REJECTION_CODES = new Set<
  RelayV2HostRouteBindingRejection["code"]
>([
  "BUSY",
  "PERMISSION_DENIED",
  "HOST_DIALECT_UNAVAILABLE",
  "CAPABILITY_UNAVAILABLE",
  "INTERNAL",
]);

export interface RelayV2HostCarrierRouteSink {
  /** A typed rejection prevents route.opened from being emitted. */
  onRouteBound(
    binding: RelayV2HostRouteBinding,
  ): void | RelayV2HostRouteBindingRejection;
  onClientFrame(binding: RelayV2HostRouteBinding, payload: Uint8Array): void;
  onRouteUnbound(
    binding: RelayV2HostRouteBinding,
    reason: RelayV2HostLocalUnbindReason,
  ): void;
  onRouteClosing?(binding: RelayV2HostRouteBinding, code: string): void;
}

export interface RelayV2HostCarrierQueueLimits {
  maxRoutes?: number;
  maxRouteIdentitiesPerConnector?: number;
  maxQueuedControlFrames?: number;
  maxQueuedDataFrames?: number;
  maxQueuedDataFramesPerRoute?: number;
  carrierHighWaterBytes?: number;
  carrierLowWaterBytes?: number;
  carrierControlReserveBytes?: number;
  routeHighWaterBytes?: number;
  routeLowWaterBytes?: number;
}

export interface RelayV2HostCarrierOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  credentialReferences: RelayV2HostCarrierCredentialReferences;
  routeSink: RelayV2HostCarrierRouteSink;
  clientDialects?: readonly RelayV2HostCarrierClientDialect[];
  dialectAdapters?: Partial<Record<RelayV2HostCarrierClientDialect, RelayV2HostCarrierDialectAdapter>>;
  publicPayloadDecoder?: RelayV2HostCarrierPublicPayloadDecoder;
  /** Defaults to no base capabilities. The actor is not a readiness signal. */
  advertisedCapabilities?: readonly string[];
  maxFrameBytes?: number;
  terminalMaxFrameBytes?: number;
  clock?: () => number;
  /** Returns a cancellation function. Defaults to an unref'd Node timer. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
  idFactory?: () => string;
  queueLimits?: RelayV2HostCarrierQueueLimits;
  onStatus?: (status: RelayV2HostCarrierStatus) => void;
  onAuthExpiring?: (input: {
    grantId: string;
    expiresAtMs: number;
    refreshRecommendedAtMs: number;
  }) => void;
  onReauthenticationError?: (input: {
    requestId: string;
    code: string;
    retryable: boolean;
  }) => void;
}

export interface RelayV2HostCarrierDashboardManagementEnrollmentResult {
  readonly type: "enrollment.created";
  readonly requestId: string;
  readonly connectorGeneration: number;
  readonly connectorId: string;
  readonly hostId: string;
  readonly deduplicated: boolean;
  readonly enrollmentId: string;
  readonly enrollmentCode: string;
  readonly issuerUrl: string;
  readonly relayUrl: string;
  readonly expiresAtMs: number;
  readonly deviceLabel: string | null;
}

export interface RelayV2HostCarrierDashboardManagementRevocationResult {
  readonly type: "grant.revoked";
  readonly requestId: string;
  readonly connectorGeneration: number;
  readonly connectorId: string;
  readonly hostId: string;
  readonly grantId: string;
  readonly revokedAtMs: number;
  readonly alreadyRevoked: boolean;
}

export type RelayV2HostCarrierDashboardManagementControlOperation =
  | Readonly<{
      operation: "create_enrollment";
      input: Readonly<{
        requestId: string;
        hostId: string;
        connectorId: string;
        deviceLabel: string | null;
      }>;
    }>
  | Readonly<{
      operation: "revoke_grant";
      input: Readonly<{
        requestId: string;
        hostId: string;
        connectorId: string;
        grantId: string;
        reason: "user_revoked";
      }>;
    }>;

export type RelayV2HostCarrierDashboardManagementControlResult =
  | RelayV2HostCarrierDashboardManagementEnrollmentResult
  | RelayV2HostCarrierDashboardManagementRevocationResult;

const dashboardManagementControlOwnerConstructionKey = Object.freeze({});

/**
 * Actor-created, native-private bridge used only while constructing the NDM4
 * adapter in this HostCarrier module closure. It exposes one closed operation,
 * never a frame sender or connector handle.
 */
export class RelayV2HostCarrierDashboardManagementControlOwner {
  readonly #invoke: (
    operation: RelayV2HostCarrierDashboardManagementControlOperation,
  ) => Promise<RelayV2HostCarrierDashboardManagementControlResult>;

  constructor(
    constructionKey: unknown,
    invoke: (
      operation: RelayV2HostCarrierDashboardManagementControlOperation,
    ) => Promise<RelayV2HostCarrierDashboardManagementControlResult>,
  ) {
    if (constructionKey !== dashboardManagementControlOwnerConstructionKey
      || typeof invoke !== "function") {
      throw new Error("Relay v2 HostCarrier Dashboard management owner is closed");
    }
    this.#invoke = invoke;
  }

  static isOwner(
    value: unknown,
  ): value is RelayV2HostCarrierDashboardManagementControlOwner {
    if (typeof value !== "object" || value === null) return false;
    try {
      return typeof (value as RelayV2HostCarrierDashboardManagementControlOwner).#invoke
        === "function";
    } catch {
      return false;
    }
  }

  invoke(
    operation: RelayV2HostCarrierDashboardManagementControlOperation,
  ): Promise<RelayV2HostCarrierDashboardManagementControlResult> {
    return this.#invoke(operation);
  }
}

export type RelayV2HostCarrierDashboardManagementControlErrorCode =
  | "NOT_REGISTERED"
  | "BUSY"
  | "QUEUE_REFUSED"
  | "CARRIER_UNAVAILABLE"
  | "CARRIER_REJECTED";

export class RelayV2HostCarrierDashboardManagementControlError extends Error {
  constructor(readonly code: RelayV2HostCarrierDashboardManagementControlErrorCode) {
    super("Relay v2 host carrier Dashboard management control failed");
    this.name = "RelayV2HostCarrierDashboardManagementControlError";
  }
}

export interface RelayV2HostCarrierConnection {
  readonly generation: number;
  receive(frame: Uint8Array, metadata?: RelayV2FrameMetadata): void;
  /**
   * Confirm the next complete FIFO frame previously accepted by trySend. The
   * transport must first remove that frame from its own bufferedAmount view.
   */
  acknowledge(deliveryToken: string): void;
  /**
   * Release route.data that the broker definitively did not accept. This is
   * not an ACK and is valid only as part of that route's close/unbind fence.
   */
  rejectUnaccepted(deliveryToken: string): void;
  /** Notify that the transport may write again or crossed its low water. */
  writable(): void;
  closed(code?: number): void;
}

interface QueueLimits {
  maxRoutes: number;
  maxRouteIdentitiesPerConnector: number;
  maxQueuedControlFrames: number;
  maxQueuedDataFrames: number;
  maxQueuedDataFramesPerRoute: number;
  carrierHighWaterBytes: number;
  carrierLowWaterBytes: number;
  carrierControlReserveBytes: number;
  routeHighWaterBytes: number;
  routeLowWaterBytes: number;
}

interface PendingReauthentication extends RelayV2HostCredentialAckFence {
  queueKey: string;
}

type DashboardManagementControlKind = "enrollment.create" | "grant.revoke";

interface PendingDashboardManagementControl {
  readonly kind: DashboardManagementControlKind;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly connectorGeneration: number;
  readonly connectorId: string;
  readonly queueKey: string;
  readonly deviceLabel: string | null;
  readonly grantId: string | null;
  readonly promise: Promise<
    RelayV2HostCarrierDashboardManagementEnrollmentResult
    | RelayV2HostCarrierDashboardManagementRevocationResult
  >;
  readonly resolve: (value:
    RelayV2HostCarrierDashboardManagementEnrollmentResult
    | RelayV2HostCarrierDashboardManagementRevocationResult
  ) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

interface OutboundReceiptCallback {
  receiver: RelayV2HostCarrierOutboundReceipt;
  settle: RelayV2HostCarrierOutboundReceipt["settle"];
}

interface OutboundReceiptCell {
  admissionKnown: boolean;
  owned: boolean;
  pendingOutcome: boolean | null;
  done: boolean;
  callback: OutboundReceiptCallback | null;
}

interface OutboundItem {
  bytes: Uint8Array;
  deliveryToken: string;
  route?: RouteState;
  routeSequence?: bigint;
  payloadBytes?: number;
  queueKey?: string;
  onSent?: () => void;
  /** Durable reauthentication is retried only by an explicit caller attempt. */
  dropOnTransportRefusal?: boolean;
  transportRefused?: boolean;
  receipt?: OutboundReceiptCell;
}

interface RouteState {
  binding: RelayV2HostRouteBinding;
  phase: "opening" | "open" | "closing";
  clientToHostSeq: bigint;
  /** Highest sequence reserved in the actor-owned FIFO. */
  hostToClientAllocatedSeq: bigint;
  /** Highest contiguous sequence accepted by transport.trySend. */
  hostToClientEmittedSeq: bigint;
  outboundQueue: OutboundItem[];
  queuedFrames: number;
  outstandingFrames: number;
  outstandingPayloadBytes: number;
  outstandingCarrierBytes: number;
  pressureSinceMs: number | null;
}

interface ConnectorState {
  generation: number;
  transport: RelayV2HostCarrierTransport;
  helloRequestId: string;
  helloSent: boolean;
  phase: "hello" | "registered" | "closed";
  connectorId: string | null;
  credential: Omit<RelayV2HostCredentialRecord, "accessToken">;
  pendingReauthentication: PendingReauthentication | null;
  pendingDashboardManagementControl: PendingDashboardManagementControl | null;
  routes: Map<string, RouteState>;
  seenRouteIds: Set<string>;
  nextDeliveryToken: bigint;
  controlQueue: OutboundItem[];
  controlBytes: number;
  dataRoutes: RouteState[];
  dataQueuedFrames: number;
  dataCarrierBytes: number;
  inFlight: OutboundItem[];
  socketUnconfirmedBytes: number;
  carrierPressureSinceMs: number | null;
  orphanedInFlightSinceMs: number | null;
  pressureTimer: { deadlineMs: number; cancel: () => void } | null;
  flushing: boolean;
}

interface ReauthenticationPreparationLease {
  readonly connector: ConnectorState;
  readonly connectorGeneration: number;
  readonly connectorId: string;
  readonly transport: RelayV2HostCarrierTransport;
  invalidated: boolean;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error("Relay v2 host carrier limits must be positive safe integers");
  }
  return selected;
}

function makeQueueLimits(input: RelayV2HostCarrierQueueLimits = {}): QueueLimits {
  const maxRoutes = positiveLimit(input.maxRoutes, 128);
  const maxRouteIdentitiesPerConnector = positiveLimit(
    input.maxRouteIdentitiesPerConnector,
    RELAY_V2_CARRIER_ROUTE_IDENTITY_HARD_LIMIT,
  );
  const carrierHighWaterBytes = positiveLimit(
    input.carrierHighWaterBytes,
    MAX_CARRIER_BUFFER_BYTES,
  );
  const carrierLowWaterBytes = positiveLimit(
    input.carrierLowWaterBytes,
    8 * 1_048_576,
  );
  const carrierControlReserveBytes = positiveLimit(
    input.carrierControlReserveBytes,
    65_536,
  );
  const routeHighWaterBytes = positiveLimit(input.routeHighWaterBytes, 1_048_576);
  const routeLowWaterBytes = positiveLimit(input.routeLowWaterBytes, 524_288);
  if (maxRoutes > RELAY_V2_CARRIER_ROUTE_HARD_LIMIT) {
    throw new Error("Relay v2 host carrier route limit exceeds the production ceiling");
  }
  if (maxRouteIdentitiesPerConnector > RELAY_V2_CARRIER_ROUTE_IDENTITY_HARD_LIMIT) {
    throw new Error("Relay v2 host carrier route identity limit exceeds the production ceiling");
  }
  if (carrierHighWaterBytes > MAX_CARRIER_BUFFER_BYTES) {
    throw new Error("Relay v2 host carrier hard limit cannot exceed 16 MiB");
  }
  if (carrierLowWaterBytes >= carrierHighWaterBytes
    || carrierControlReserveBytes >= carrierHighWaterBytes
    || routeLowWaterBytes >= routeHighWaterBytes) {
    throw new Error("Relay v2 host carrier low water must be below high water");
  }
  return {
    maxRoutes,
    maxRouteIdentitiesPerConnector,
    maxQueuedControlFrames: positiveLimit(input.maxQueuedControlFrames, 64),
    maxQueuedDataFrames: positiveLimit(input.maxQueuedDataFrames, 1_024),
    maxQueuedDataFramesPerRoute: positiveLimit(
      input.maxQueuedDataFramesPerRoute,
      128,
    ),
    carrierHighWaterBytes,
    carrierLowWaterBytes,
    carrierControlReserveBytes,
    routeHighWaterBytes,
    routeLowWaterBytes,
  };
}

function safeNow(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Relay v2 host carrier clock returned an invalid timestamp");
  }
  return value;
}

function stringField(object: RelayV2JsonObject, name: string): string {
  return object[name] as string;
}

function objectField(object: RelayV2JsonObject, name: string): RelayV2JsonObject {
  return object[name] as RelayV2JsonObject;
}

function counterField(object: RelayV2JsonObject, name: string): bigint {
  return BigInt(stringField(object, name));
}

function canonicalBase64DecodedLength(encoded: string): number | null {
  if (encoded.length % 4 !== 0) return null;
  const quartets = encoded.length / 4;
  if (!Number.isSafeInteger(quartets)
    || quartets > Math.floor((Number.MAX_SAFE_INTEGER + 2) / 3)) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return quartets * 3 - padding;
}

function publicBytes(encoded: string): Uint8Array {
  return Buffer.from(encoded, "base64");
}

function copyCredentialMetadata(
  record: RelayV2HostCredentialRecord,
): Omit<RelayV2HostCredentialRecord, "accessToken"> {
  return {
    reference: record.reference,
    version: record.version,
    grantId: record.grantId,
    accessJti: record.accessJti,
  };
}

function validateCredentialRecord(
  requestedReference: string,
  record: RelayV2HostCredentialRecord,
): void {
  if (record.reference !== requestedReference) {
    throw new Error("Relay v2 host credential reference changed during lookup");
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(record.version)) {
    throw new Error("Relay v2 host credential version is not canonical");
  }
  if (BigInt(record.version) > MAX_COUNTER) {
    throw new Error("Relay v2 host credential version overflowed");
  }
  for (const [name, value] of [
    ["reference", record.reference],
    ["grantId", record.grantId],
    ["accessJti", record.accessJti],
  ] as const) {
    if (!value || Buffer.byteLength(value, "utf8") > 128 || /[\0\r\n]/.test(value)) {
      throw new Error(`Relay v2 host credential ${name} is invalid`);
    }
  }
  if (!record.accessToken || Buffer.byteLength(record.accessToken, "utf8") > 8_192) {
    throw new Error("Relay v2 host credential token is invalid");
  }
}

function captureExactOwnDataValues(
  value: unknown,
  fields: readonly string[],
  expectedPrototype: object | null = Object.prototype,
): readonly unknown[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(value) !== expectedPrototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const expected = new Set(fields);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !expected.has(key))) return null;
  const values: unknown[] = [];
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    values.push(descriptor.value);
  }
  return values;
}

function dashboardControlIdentifier(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 128
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) {
    throw new RelayV2HostCarrierDashboardManagementControlError("CARRIER_REJECTED");
  }
  return value;
}

function dashboardControlDeviceLabel(value: unknown): string | null {
  if (value === null) return null;
  return dashboardControlIdentifier(value);
}

function dashboardManagementUrl(
  value: unknown,
  protocol: "https:" | "wss:",
  pathname: "/" | "/client",
): string {
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > 2_048
    || !/^[\x21-\x7e]+$/.test(value)
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) {
    throw new Error("Relay v2 host carrier management URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Relay v2 host carrier management URL is invalid");
  }
  const prefix = protocol === "https:" ? "https://" : "wss://";
  const authority = value.startsWith(prefix)
    ? value.slice(prefix.length).split("/", 1)[0]
    : "";
  if (parsed.protocol !== protocol
    || parsed.hostname.length === 0
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || authority.endsWith(":")
    || parsed.pathname !== pathname) {
    throw new Error("Relay v2 host carrier management URL is invalid");
  }
  return value;
}

function dashboardControlCarrierError(
  value: unknown,
): RelayV2HostCarrierDashboardManagementControlError | null {
  const fields = captureExactOwnDataValues(value, [
    "code",
    "message",
    "retryable",
    "retryAfterMs",
    "commandDisposition",
    "details",
  ], null);
  if (!fields) return null;
  const [code, message, retryable, retryAfterMs, commandDisposition, details] = fields;
  if (typeof message !== "string"
    || typeof retryable !== "boolean"
    || commandDisposition !== "not_applicable"
    || details !== null
    || (retryAfterMs !== null
      && (!Number.isSafeInteger(retryAfterMs) || (retryAfterMs as number) < 0))) return null;
  if (code === "BUSY" && retryable === true) {
    return new RelayV2HostCarrierDashboardManagementControlError("BUSY");
  }
  if (code === "CAPABILITY_UNAVAILABLE"
    && retryable === false
    && retryAfterMs === null) {
    return new RelayV2HostCarrierDashboardManagementControlError("CARRIER_UNAVAILABLE");
  }
  if ((code === "AUTH_INVALID"
      || code === "GRANT_NOT_FOUND"
      || code === "ROLE_MISMATCH"
      || code === "PERMISSION_DENIED"
      || code === "IDEMPOTENCY_CONFLICT"
      || code === "INVALID_ENVELOPE")
    && retryable === false
    && retryAfterMs === null) {
    return new RelayV2HostCarrierDashboardManagementControlError("CARRIER_REJECTED");
  }
  return null;
}

type PreparedReauthenticationSnapshot = Readonly<
  RelayV2HostCredentialAckFence & { accessToken: string }
>;

function snapshotPreparedReauthentication(
  requestedReference: string,
  prepared: unknown,
): PreparedReauthenticationSnapshot {
  const preparedValues = captureExactOwnDataValues(prepared, ["fence", "accessToken"]);
  const fenceValues = preparedValues
    ? captureExactOwnDataValues(preparedValues[0], [
        "reference", "version", "requestId", "grantId", "accessJti",
      ])
    : null;
  if (!preparedValues || !fenceValues) {
    throw new Error("Relay v2 host reauthentication preparation is invalid");
  }
  const [reference, version, requestId, grantId, accessJti] = fenceValues;
  const accessToken = preparedValues[1];
  if (typeof reference !== "string"
    || typeof version !== "string"
    || typeof requestId !== "string"
    || typeof grantId !== "string"
    || typeof accessJti !== "string"
    || typeof accessToken !== "string") {
    throw new Error("Relay v2 host reauthentication preparation is invalid");
  }
  const snapshot = Object.freeze({
    reference,
    version,
    requestId,
    grantId,
    accessJti,
    accessToken,
  });
  validateCredentialRecord(requestedReference, snapshot);
  if (snapshot.version === "0"
    || !snapshot.requestId
    || Buffer.byteLength(snapshot.requestId, "utf8") > 128
    || /[\0\r\n]/.test(snapshot.requestId)) {
    throw new Error("Relay v2 host reauthentication fence is invalid");
  }
  return snapshot;
}

function structuredError(
  code: RelayV2HostCarrierStructuredErrorCode,
  message: string,
  retryable: boolean,
): RelayV2JsonObject {
  return {
    code,
    message,
    retryable,
    retryAfterMs: null,
    commandDisposition: "not_applicable",
    details: null,
  };
}

const ROUTE_CLOSE_SLOW_CONSUMER: RelayV2HostCarrierRouteClose = Object.freeze({
  closeCode: 1013,
  reason: "slow_consumer",
  errorCode: "SLOW_CONSUMER",
  retryable: true,
});

const ROUTE_CLOSE_PROTOCOL_ERROR: RelayV2HostCarrierRouteClose = Object.freeze({
  closeCode: 4400,
  reason: "protocol_error",
  errorCode: "INTERNAL",
  retryable: false,
});

const ROUTE_CLOSE_HOST_SHUTDOWN: RelayV2HostCarrierRouteClose = Object.freeze({
  closeCode: 1011,
  reason: "host_shutdown",
  errorCode: "INTERNAL",
  retryable: false,
});

function captureOutboundReceipt(
  receipt: RelayV2HostCarrierOutboundReceipt,
): OutboundReceiptCallback {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Relay v2 host carrier outbound receipt is invalid");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(receipt, "settle");
  } catch {
    throw new Error("Relay v2 host carrier outbound receipt is invalid");
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "function") {
    throw new Error("Relay v2 host carrier outbound receipt is invalid");
  }
  return Object.freeze({
    receiver: receipt,
    settle: descriptor.value as RelayV2HostCarrierOutboundReceipt["settle"],
  });
}

function exactRouteClose(value: unknown): RelayV2HostCarrierRouteClose | null {
  const values = captureExactOwnDataValues(
    value,
    ["closeCode", "reason", "errorCode", "retryable"],
  );
  if (!values) return null;
  const tuple = values as readonly [unknown, unknown, unknown, unknown];
  if ((tuple[0] === 1013 && tuple[1] === "slow_consumer"
      && tuple[2] === "SLOW_CONSUMER" && tuple[3] === true)
    || (tuple[0] === 4400 && tuple[1] === "protocol_error"
      && tuple[2] === "INTERNAL" && tuple[3] === false)
    || (tuple[0] === 4406 && tuple[1] === "protocol_error"
      && tuple[2] === "CAPABILITY_UNAVAILABLE" && tuple[3] === false)
    || (tuple[0] === 1011 && tuple[1] === "host_shutdown"
      && tuple[2] === "INTERNAL" && tuple[3] === false)
    || (tuple[0] === 4409 && tuple[1] === "host_shutdown"
      && tuple[2] === "HOST_SUPERSEDED" && tuple[3] === false)) {
    return Object.freeze({
      closeCode: tuple[0],
      reason: tuple[1],
      errorCode: tuple[2],
      retryable: tuple[3],
    }) as RelayV2HostCarrierRouteClose;
  }
  return null;
}

function legacyRouteClose(
  reason: "slow_consumer" | "protocol_error" | "host_shutdown",
): RelayV2HostCarrierRouteClose {
  switch (reason) {
    case "slow_consumer": return ROUTE_CLOSE_SLOW_CONSUMER;
    case "protocol_error": return ROUTE_CLOSE_PROTOCOL_ERROR;
    case "host_shutdown": return ROUTE_CLOSE_HOST_SHUTDOWN;
  }
}

export class RelayV2HostCarrierActor {
  private readonly clock: () => number;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;
  private readonly idFactory: () => string;
  private readonly limits: QueueLimits;
  private readonly capabilities: string[];
  private readonly clientDialects: RelayV2HostCarrierClientDialect[];
  private readonly v1DialectAdapter?: RelayV2HostCarrierDialectAdapter;
  private readonly publicPayloadDecoder: RelayV2HostCarrierPublicPayloadDecoder;
  private readonly maxFrameBytes: number;
  private readonly terminalMaxFrameBytes: number;
  private generation = 0;
  private current: ConnectorState | null = null;
  /**
   * A synchronous credential adapter may invoke arbitrary JavaScript (and a
   * returned Proxy may do the same while its descriptors are inspected). Keep
   * one actor-local lease bound to the exact connector incarnation so no such
   * reentry can start a second durable preparation.
   */
  private reauthenticationPreparation: ReauthenticationPreparationLease | null = null;
  private permanentlySuperseded = false;
  private disposed = false;
  private dispatchingReceipts = false;
  private readonly receiptDispatchQueue: Array<Readonly<{
    callback: OutboundReceiptCallback;
    outcome: boolean;
  }>> = [];
  private latestStatus: RelayV2HostCarrierStatus | null = null;
  private dashboardManagementControlAdapter:
    RelayV2DashboardManagementHostCarrierControlAdapter | null = null;

  constructor(private readonly options: RelayV2HostCarrierOptions) {
    this.clock = options.clock ?? Date.now;
    this.schedule = options.schedule ?? ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.idFactory = options.idFactory ?? randomUUID;
    this.limits = makeQueueLimits(options.queueLimits);
    this.capabilities = [...(options.advertisedCapabilities ?? [])];
    this.clientDialects = [...(options.clientDialects ?? ["tw-relay.v2"])];
    this.v1DialectAdapter = options.dialectAdapters?.["tw-relay.v1"];
    this.publicPayloadDecoder = options.publicPayloadDecoder ?? {
      decodeCanonicalBase64: publicBytes,
    };
    if (this.clientDialects.length === 0
      || new Set(this.clientDialects).size !== this.clientDialects.length
      || this.clientDialects.some((dialect) => (
        dialect !== "tw-relay.v1" && dialect !== "tw-relay.v2"
      ))) {
      throw new Error("Relay v2 host carrier dialect advertisement is invalid");
    }
    if (this.clientDialects.includes("tw-relay.v1")
      && !this.v1DialectAdapter) {
      throw new Error("Relay v1 carrier advertisement requires an explicit v1 codec adapter");
    }
    this.maxFrameBytes = positiveLimit(options.maxFrameBytes, RELAY_V2_PUBLIC_FRAME_BYTES);
    this.terminalMaxFrameBytes = positiveLimit(
      options.terminalMaxFrameBytes,
      DEFAULT_TERMINAL_FRAME_BYTES,
    );
    if (this.maxFrameBytes > RELAY_V2_PUBLIC_FRAME_BYTES) {
      throw new Error("Relay v2 host carrier maxFrameBytes exceeds the codec limit");
    }
    if (this.terminalMaxFrameBytes > DEFAULT_TERMINAL_FRAME_BYTES) {
      throw new Error("Relay v2 host carrier terminalMaxFrameBytes exceeds the contract");
    }
  }

  status(): RelayV2HostCarrierStatus | null {
    return this.latestStatus ? { ...this.latestStatus } : null;
  }

  createDashboardManagementCarrierControlAdapter():
  RelayV2DashboardManagementHostCarrierControlAdapter {
    if (this.dashboardManagementControlAdapter !== null) {
      return this.dashboardManagementControlAdapter;
    }
    const owner = Object.freeze(new RelayV2HostCarrierDashboardManagementControlOwner(
      dashboardManagementControlOwnerConstructionKey,
      (operation) => operation.operation === "create_enrollment"
        ? this.requestDashboardEnrollment(operation.input)
        : this.requestDashboardGrantRevocation(operation.input),
    ));
    const adapter = new RelayV2DashboardManagementHostCarrierControlAdapter({ owner });
    this.dashboardManagementControlAdapter = adapter;
    return adapter;
  }

  private requestDashboardEnrollment(input: Readonly<{
    requestId: string;
    hostId: string;
    connectorId: string;
    deviceLabel: string | null;
  }>): Promise<RelayV2HostCarrierDashboardManagementEnrollmentResult> {
    const values = captureExactOwnDataValues(input, [
      "requestId", "hostId", "connectorId", "deviceLabel",
    ]);
    if (!values) {
      return Promise.reject(
        new RelayV2HostCarrierDashboardManagementControlError("CARRIER_REJECTED"),
      );
    }
    let requestId: string;
    let hostId: string;
    let connectorId: string;
    let deviceLabel: string | null;
    try {
      requestId = dashboardControlIdentifier(values[0]);
      hostId = dashboardControlIdentifier(values[1]);
      connectorId = dashboardControlIdentifier(values[2]);
      deviceLabel = dashboardControlDeviceLabel(values[3]);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.submitDashboardManagementControl({
      kind: "enrollment.create",
      requestId,
      hostId,
      connectorId,
      deviceLabel,
      grantId: null,
    }) as Promise<RelayV2HostCarrierDashboardManagementEnrollmentResult>;
  }

  private requestDashboardGrantRevocation(input: Readonly<{
    requestId: string;
    hostId: string;
    connectorId: string;
    grantId: string;
    reason: "user_revoked";
  }>): Promise<RelayV2HostCarrierDashboardManagementRevocationResult> {
    const values = captureExactOwnDataValues(input, [
      "requestId", "hostId", "connectorId", "grantId", "reason",
    ]);
    if (!values || values[4] !== "user_revoked") {
      return Promise.reject(
        new RelayV2HostCarrierDashboardManagementControlError("CARRIER_REJECTED"),
      );
    }
    let requestId: string;
    let hostId: string;
    let connectorId: string;
    let grantId: string;
    try {
      requestId = dashboardControlIdentifier(values[0]);
      hostId = dashboardControlIdentifier(values[1]);
      connectorId = dashboardControlIdentifier(values[2]);
      grantId = dashboardControlIdentifier(values[3]);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.submitDashboardManagementControl({
      kind: "grant.revoke",
      requestId,
      hostId,
      connectorId,
      deviceLabel: null,
      grantId,
    }) as Promise<RelayV2HostCarrierDashboardManagementRevocationResult>;
  }

  private submitDashboardManagementControl(input: Readonly<{
    kind: DashboardManagementControlKind;
    requestId: string;
    hostId: string;
    connectorId: string;
    deviceLabel: string | null;
    grantId: string | null;
  }>): Promise<
    RelayV2HostCarrierDashboardManagementEnrollmentResult
    | RelayV2HostCarrierDashboardManagementRevocationResult
  > {
    const connector = this.current;
    if (this.disposed
      || this.permanentlySuperseded
      || !connector
      || connector.phase !== "registered"
      || connector.connectorId === null
      || input.hostId !== this.options.hostId
      || input.connectorId !== connector.connectorId) {
      return Promise.reject(
        new RelayV2HostCarrierDashboardManagementControlError("NOT_REGISTERED"),
      );
    }
    const fingerprint = JSON.stringify([
      input.kind,
      input.requestId,
      input.hostId,
      input.connectorId,
      input.deviceLabel,
      input.grantId,
    ]);
    const existing = connector.pendingDashboardManagementControl;
    if (existing !== null) {
      if (existing.fingerprint === fingerprint) return existing.promise;
      return Promise.reject(
        new RelayV2HostCarrierDashboardManagementControlError("BUSY"),
      );
    }

    let resolve!: PendingDashboardManagementControl["resolve"];
    let reject!: PendingDashboardManagementControl["reject"];
    const promise = new Promise<
      RelayV2HostCarrierDashboardManagementEnrollmentResult
      | RelayV2HostCarrierDashboardManagementRevocationResult
    >((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: PendingDashboardManagementControl = {
      kind: input.kind,
      requestId: input.requestId,
      fingerprint,
      connectorGeneration: connector.generation,
      connectorId: connector.connectorId,
      queueKey: `dashboard:${connector.generation}:${input.kind}:${input.requestId}`,
      deviceLabel: input.deviceLabel,
      grantId: input.grantId,
      promise,
      resolve,
      reject,
      settled: false,
    };
    connector.pendingDashboardManagementControl = pending;
    const frame: RelayV2JsonObject = input.kind === "enrollment.create"
      ? {
          carrierVersion: 1,
          type: "enrollment.create",
          requestId: input.requestId,
          connectorId: input.connectorId,
          payload: {
            expiresInMs: 300_000,
            deviceLabel: input.deviceLabel,
          },
        }
      : {
          carrierVersion: 1,
          type: "grant.revoke",
          requestId: input.requestId,
          connectorId: input.connectorId,
          payload: {
            grantId: input.grantId!,
            reason: "user_revoked",
          },
        };
    const accepted = this.enqueueControl(connector, frame, { queueKey: pending.queueKey });
    if (!accepted && connector.pendingDashboardManagementControl === pending) {
      this.removeControlItems(connector, (item) => item.queueKey === pending.queueKey);
      this.rejectDashboardManagementControl(
        connector,
        pending,
        new RelayV2HostCarrierDashboardManagementControlError("QUEUE_REFUSED"),
      );
    }
    return promise;
  }

  private newReceiptCell(
    receipt: RelayV2HostCarrierOutboundReceipt | undefined,
  ): OutboundReceiptCell | undefined {
    if (receipt === undefined) return undefined;
    return {
      admissionKnown: false,
      owned: false,
      pendingOutcome: null,
      done: false,
      callback: captureOutboundReceipt(receipt),
    };
  }

  private finishReceiptAdmission(cell: OutboundReceiptCell | undefined, accepted: boolean): void {
    if (!cell || cell.admissionKnown) return;
    cell.admissionKnown = true;
    if (!accepted) {
      cell.done = true;
      cell.owned = false;
      cell.pendingOutcome = null;
      cell.callback = null;
      return;
    }
    cell.owned = true;
    const pending = cell.pendingOutcome;
    cell.pendingOutcome = null;
    if (pending !== null) this.recordReceiptOutcome(cell, pending);
  }

  private recordReceiptOutcome(cell: OutboundReceiptCell | undefined, outcome: boolean): void {
    if (!cell || cell.done) return;
    if (!cell.admissionKnown) {
      // A synchronous flush/cleanup may finish before sendPublic knows whether
      // ownership was transferred. The first terminal outcome is authoritative.
      if (cell.pendingOutcome === null) cell.pendingOutcome = outcome;
      return;
    }
    if (!cell.owned) return;
    cell.done = true;
    cell.pendingOutcome = null;
    const callback = cell.callback;
    cell.callback = null;
    if (!callback) return;
    this.receiptDispatchQueue.push(Object.freeze({ callback, outcome }));
    if (this.dispatchingReceipts) return;
    this.dispatchingReceipts = true;
    try {
      while (this.receiptDispatchQueue.length > 0) {
        const dispatch = this.receiptDispatchQueue.shift()!;
        try {
          Reflect.apply(
            dispatch.callback.settle,
            dispatch.callback.receiver,
            [dispatch.outcome],
          );
        } catch {
          // Receipt observation cannot regain queue ownership or corrupt the
          // accounting already committed before this dispatch.
        }
      }
    } finally {
      this.dispatchingReceipts = false;
    }
  }

  private settleDetached(items: readonly OutboundItem[], outcome: boolean): void {
    for (const item of items) this.recordReceiptOutcome(item.receipt, outcome);
  }

  connect(
    transport: RelayV2HostCarrierTransport,
    credentialReference: string,
  ): RelayV2HostCarrierConnection {
    if (this.disposed) {
      throw new Error("Relay v2 host carrier was disposed and cannot reconnect");
    }
    if (this.permanentlySuperseded) {
      throw new Error("Relay v2 host carrier was superseded and cannot reconnect");
    }
    const credential = this.options.credentialReferences.read(credentialReference);
    validateCredentialRecord(credentialReference, credential);
    const credentialMetadata = copyCredentialMetadata(credential);
    const helloRequestId = this.idFactory();
    // Credential/id adapters are synchronous but may reenter arbitrary actor
    // lifecycle. Never publish a connector after such reentry disposed or
    // permanently superseded this actor.
    if (this.disposed) {
      throw new Error("Relay v2 host carrier was disposed and cannot reconnect");
    }
    if (this.permanentlySuperseded) {
      throw new Error("Relay v2 host carrier was superseded and cannot reconnect");
    }
    const previous = this.current;
    const connector: ConnectorState = {
      generation: ++this.generation,
      transport,
      helloRequestId,
      helloSent: false,
      phase: "hello",
      connectorId: null,
      credential: credentialMetadata,
      pendingReauthentication: null,
      pendingDashboardManagementControl: null,
      routes: new Map(),
      seenRouteIds: new Set(),
      nextDeliveryToken: 0n,
      controlQueue: [],
      controlBytes: 0,
      dataRoutes: [],
      dataQueuedFrames: 0,
      dataCarrierBytes: 0,
      inFlight: [],
      socketUnconfirmedBytes: 0,
      carrierPressureSinceMs: null,
      orphanedInFlightSinceMs: null,
      pressureTimer: null,
      flushing: false,
    };

    // Publish the winner before closing the loser. A synchronous close callback
    // from the old transport is therefore generation-stale and cannot emit an
    // offline transition for the new connector.
    this.current = connector;
    try {
      this.publishStatus({
        phase: "connecting",
        generation: connector.generation,
        connectorId: null,
      });
      if (previous) {
        previous.phase = "closed";
        this.cleanupConnector(previous, "connector_replaced");
        previous.transport.close(1000, "connector_replaced");
      }

      const hello: RelayV2JsonObject = {
        carrierVersion: 1,
        type: "host.hello",
        requestId: connector.helloRequestId,
        payload: {
          hostId: this.options.hostId,
          hostEpoch: this.options.hostEpoch,
          hostInstanceId: this.options.hostInstanceId,
          clientDialects: [...this.clientDialects],
          capabilities: [...this.capabilities],
          limits: {
            maxFrameBytes: this.maxFrameBytes,
            terminalMaxFrameBytes: this.terminalMaxFrameBytes,
          },
        },
      };
      if (!this.enqueueControl(connector, hello, {
        onSent: () => { connector.helloSent = true; },
      })) {
        throw new Error("Relay v2 host carrier could not queue host.hello");
      }

      const generation = connector.generation;
      return Object.freeze({
        generation,
        receive: (frame: Uint8Array, metadata: RelayV2FrameMetadata = {}) => {
          this.receive(generation, frame, metadata);
        },
        acknowledge: (deliveryToken: string) => {
          this.acknowledge(generation, deliveryToken);
        },
        rejectUnaccepted: (deliveryToken: string) => {
          this.rejectUnaccepted(generation, deliveryToken);
        },
        writable: () => { this.writable(generation); },
        closed: (code?: number) => { this.closed(generation, code); },
      });
    } catch (error) {
      this.rollbackConnectorStart(connector);
      throw error;
    }
  }

  private rollbackConnectorStart(connector: ConnectorState): void {
    const wasCurrent = this.current === connector;
    if (wasCurrent) this.current = null;
    connector.phase = "closed";
    this.cleanupConnector(connector, "carrier_closed");
    if (wasCurrent) {
      this.publishStatus({
        phase: "offline",
        generation: connector.generation,
        connectorId: connector.connectorId,
        closeCode: 1013,
      });
    }
  }

  requestReauthentication(requestId: string, credentialReference: string): boolean {
    if (this.disposed) return false;
    const activePreparation = this.reauthenticationPreparation;
    if (activePreparation) {
      activePreparation.invalidated = true;
      throw new Error("Relay v2 host reauthentication preparation was reentered");
    }
    const connector = this.current;
    if (!connector || connector.phase !== "registered" || !connector.connectorId) {
      return false;
    }
    const preparation: ReauthenticationPreparationLease = {
      connector,
      connectorGeneration: connector.generation,
      connectorId: connector.connectorId,
      transport: connector.transport,
      invalidated: false,
    };
    this.reauthenticationPreparation = preparation;
    try {
      const winner = snapshotPreparedReauthentication(
        credentialReference,
        this.options.credentialReferences.prepareReauthentication({
          credentialReference,
          requestId,
        }),
      );
      // Preparation and descriptor capture are both untrusted synchronous
      // calls. Re-establish exact ownership before touching volatile pending
      // state or either carrier queue.
      if (!this.ownsReauthenticationPreparation(preparation)) return false;
      if (winner.grantId !== connector.credential.grantId) {
        throw new Error("Relay v2 host reauthentication cannot change the host grant");
      }

      const queueKey = `reauth:${winner.requestId}:${winner.version}:${winner.accessJti}`;
      if (connector.pendingReauthentication) {
        this.removeControlItems(
          connector,
          (item) => item.queueKey === connector.pendingReauthentication?.queueKey,
        );
      }
      const pending: PendingReauthentication = {
        reference: winner.reference,
        version: winner.version,
        requestId: winner.requestId,
        grantId: winner.grantId,
        accessJti: winner.accessJti,
        queueKey,
      };
      connector.pendingReauthentication = pending;

      const frame: RelayV2JsonObject = {
        carrierVersion: 1,
        type: "host.reauthenticate",
        requestId: winner.requestId,
        connectorId: preparation.connectorId,
        payload: { accessToken: winner.accessToken },
      };
      if (!this.enqueueControl(connector, frame, {
        queueKey,
        dropOnTransportRefusal: true,
      })) {
        return false;
      }
      return true;
    } finally {
      // Never clear a lease installed by a later connector incarnation.
      if (this.reauthenticationPreparation === preparation) {
        this.reauthenticationPreparation = null;
      }
    }
  }

  private ownsReauthenticationPreparation(
    preparation: ReauthenticationPreparationLease,
  ): boolean {
    const connector = preparation.connector;
    return !preparation.invalidated
      && this.reauthenticationPreparation === preparation
      && !this.permanentlySuperseded
      && this.current === connector
      && connector.generation === preparation.connectorGeneration
      && connector.connectorId === preparation.connectorId
      && connector.transport === preparation.transport
      && connector.phase === "registered";
  }

  sendPublic(
    binding: RelayV2HostRouteBinding,
    payload: Uint8Array,
    receipt?: RelayV2HostCarrierOutboundReceipt,
  ): boolean {
    let receiptCell: OutboundReceiptCell | undefined;
    try {
      receiptCell = this.newReceiptCell(receipt);
    } catch {
      return false;
    }
    const connector = this.current;
    const route = connector ? this.currentRoute(connector, binding) : undefined;
    if (!connector || connector.phase !== "registered" || !route || route.phase !== "open") {
      this.finishReceiptAdmission(receiptCell, false);
      return false;
    }
    if (payload.byteLength > route.binding.maxFrameBytes) {
      this.failRoute(connector, route, ROUTE_CLOSE_PROTOCOL_ERROR);
      this.finishReceiptAdmission(receiptCell, false);
      return false;
    }
    try {
      this.validatePublicPayload(route, payload);
    } catch {
      this.failRoute(connector, route, ROUTE_CLOSE_PROTOCOL_ERROR);
      this.finishReceiptAdmission(receiptCell, false);
      return false;
    }
    if (route.hostToClientAllocatedSeq >= MAX_COUNTER) {
      this.failRoute(connector, route, ROUTE_CLOSE_PROTOCOL_ERROR);
      this.finishReceiptAdmission(receiptCell, false);
      return false;
    }

    const next = route.hostToClientAllocatedSeq + 1n;
    const frame: RelayV2JsonObject = {
      carrierVersion: 1,
      type: "route.data",
      connectorId: route.binding.connectorId,
      routeId: route.binding.routeId,
      routeFence: route.binding.routeFence,
      direction: "host_to_client",
      seq: next.toString(10),
      payload: {
        opcode: "text",
        encoding: "base64",
        data: Buffer.from(payload).toString("base64"),
      },
    };
    const accepted = this.enqueueData(
      connector,
      route,
      next,
      frame,
      payload.byteLength,
      receiptCell,
    );
    this.finishReceiptAdmission(receiptCell, accepted);
    return accepted;
  }

  closeRoute(
    binding: RelayV2HostRouteBinding,
    input: RelayV2HostCarrierRouteClose
      | "slow_consumer"
      | "protocol_error"
      | "host_shutdown" = "host_shutdown",
  ): boolean {
    const connector = this.current;
    const route = connector ? this.currentRoute(connector, binding) : undefined;
    if (!connector || !route || route.phase === "closing") return false;
    const close = typeof input === "string" ? legacyRouteClose(input) : exactRouteClose(input);
    if (!close) return false;
    this.failRoute(connector, route, close);
    return true;
  }

  private receive(
    generation: number,
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
  ): void {
    const connector = this.current;
    if (!connector || connector.generation !== generation || connector.phase === "closed") return;
    let frame: RelayV2JsonObject;
    try {
      frame = decodeRelayV2WebSocketFrame("carrier", bytes, metadata).frame;
    } catch {
      this.failConnector(connector, 4400, "invalid_carrier_frame");
      return;
    }

    const type = stringField(frame, "type");
    if (connector.phase === "hello") {
      if (type === "host.registered") {
        this.handleRegistered(connector, frame);
      } else if (type === "carrier.error") {
        const payload = objectField(frame, "payload");
        const error = objectField(frame, "error");
        if (stringField(payload, "failedType") !== "host.hello"
          || stringField(frame, "requestId") !== connector.helloRequestId) {
          this.failConnector(connector, 4400, "invalid_host_registration_error");
          return;
        }
        if (stringField(error, "code") === "DUPLICATE_CONNECTOR") {
          this.failConnector(connector, 4411, "duplicate_connector");
        } else {
          this.failConnector(connector, 4400, "host_registration_rejected");
        }
      } else {
        this.failConnector(connector, 4400, "registered_barrier_violation");
      }
      return;
    }

    if (!this.hasCurrentConnectorId(connector, frame)) {
      this.failConnector(connector, 4400, "stale_connector_source");
      return;
    }
    switch (type) {
      case "enrollment.created":
        this.handleEnrollmentCreated(connector, frame);
        return;
      case "grant.revoked":
        this.handleGrantRevoked(connector, frame);
        return;
      case "host.reauthenticated":
        this.handleReauthenticated(connector, frame);
        return;
      case "host.auth_expiring":
        this.handleAuthExpiring(connector, frame);
        return;
      case "host.superseded":
        this.handleSuperseded(connector, frame);
        return;
      case "carrier.error":
        this.handleCarrierError(connector, frame);
        return;
      case "route.open":
        this.handleRouteOpen(connector, frame);
        return;
      case "route.data":
        this.handleRouteData(connector, frame);
        return;
      case "route.unbind":
        this.handleRouteUnbind(connector, frame);
        return;
      default:
        this.failConnector(connector, 4400, "carrier_direction_violation");
    }
  }

  private handleRegistered(connector: ConnectorState, frame: RelayV2JsonObject): void {
    if (!connector.helloSent
      || stringField(frame, "requestId") !== connector.helloRequestId) {
      this.failConnector(connector, 4400, "invalid_host_registered");
      return;
    }
    const payload = objectField(frame, "payload");
    const disposition = stringField(payload, "disposition") as "connected" | "replaced";
    const supersededHostInstanceId = payload.supersededHostInstanceId;
    if ((disposition === "connected" && supersededHostInstanceId !== null)
      || (disposition === "replaced" && typeof supersededHostInstanceId !== "string")) {
      this.failConnector(connector, 4400, "invalid_host_registered_disposition");
      return;
    }
    connector.connectorId = stringField(frame, "connectorId");
    connector.phase = "registered";
    this.publishStatus({
      phase: "registered",
      generation: connector.generation,
      connectorId: connector.connectorId,
      disposition,
    });
  }

  private exactDashboardManagementPending(
    connector: ConnectorState,
    frame: RelayV2JsonObject,
    kind: DashboardManagementControlKind,
  ): PendingDashboardManagementControl | null {
    const pending = connector.pendingDashboardManagementControl;
    if (!pending
      || pending.kind !== kind
      || pending.requestId !== stringField(frame, "requestId")
      || pending.connectorGeneration !== connector.generation
      || pending.connectorId !== connector.connectorId) {
      this.failConnector(connector, 4400, "invalid_dashboard_control_correlation");
      return null;
    }
    return pending;
  }

  private handleEnrollmentCreated(
    connector: ConnectorState,
    frame: RelayV2JsonObject,
  ): void {
    const pending = this.exactDashboardManagementPending(
      connector,
      frame,
      "enrollment.create",
    );
    if (!pending) return;
    try {
      const payload = objectField(frame, "payload");
      const enrollmentCode = stringField(payload, "enrollmentCode");
      if (!enrollmentCode.startsWith("twenroll2.")
        || enrollmentCode.length === "twenroll2.".length
        || Buffer.byteLength(enrollmentCode, "utf8") > 512
        || /[\0\r\n]/.test(enrollmentCode)
        || stringField(payload, "hostId") !== this.options.hostId) {
        throw new Error("invalid enrollment response");
      }
      const result: RelayV2HostCarrierDashboardManagementEnrollmentResult = Object.freeze({
        type: "enrollment.created",
        requestId: pending.requestId,
        connectorGeneration: pending.connectorGeneration,
        connectorId: pending.connectorId,
        hostId: this.options.hostId,
        deduplicated: payload.deduplicated as boolean,
        enrollmentId: stringField(payload, "enrollmentId"),
        enrollmentCode,
        issuerUrl: dashboardManagementUrl(payload.issuerUrl, "https:", "/"),
        relayUrl: dashboardManagementUrl(payload.relayUrl, "wss:", "/client"),
        expiresAtMs: payload.expiresAtMs as number,
        deviceLabel: pending.deviceLabel,
      });
      this.resolveDashboardManagementControl(connector, pending, result);
    } catch {
      this.failConnector(connector, 4400, "invalid_dashboard_control_response");
    }
  }

  private handleGrantRevoked(
    connector: ConnectorState,
    frame: RelayV2JsonObject,
  ): void {
    const pending = this.exactDashboardManagementPending(
      connector,
      frame,
      "grant.revoke",
    );
    if (!pending) return;
    const payload = objectField(frame, "payload");
    if (pending.grantId === null || stringField(payload, "grantId") !== pending.grantId) {
      this.failConnector(connector, 4400, "invalid_dashboard_control_response");
      return;
    }
    const result: RelayV2HostCarrierDashboardManagementRevocationResult = Object.freeze({
      type: "grant.revoked",
      requestId: pending.requestId,
      connectorGeneration: pending.connectorGeneration,
      connectorId: pending.connectorId,
      hostId: this.options.hostId,
      grantId: pending.grantId,
      revokedAtMs: payload.revokedAtMs as number,
      alreadyRevoked: payload.alreadyRevoked as boolean,
    });
    this.resolveDashboardManagementControl(connector, pending, result);
  }

  private handleReauthenticated(connector: ConnectorState, frame: RelayV2JsonObject): void {
    const managementPending = connector.pendingDashboardManagementControl;
    if (managementPending?.requestId === stringField(frame, "requestId")) {
      this.failConnector(connector, 4400, "invalid_dashboard_control_correlation");
      return;
    }
    const pending = connector.pendingReauthentication;
    if (!pending || stringField(frame, "requestId") !== pending.requestId) return;
    const payload = objectField(frame, "payload");
    if (stringField(payload, "grantId") !== pending.grantId
      || stringField(payload, "jti") !== pending.accessJti) return;

    const acknowledged = this.options.credentialReferences.acknowledgeReauthentication({
      reference: pending.reference,
      version: pending.version,
      requestId: pending.requestId,
      grantId: pending.grantId,
      accessJti: pending.accessJti,
    });
    if (!acknowledged || connector.pendingReauthentication !== pending) return;
    connector.credential = {
      reference: pending.reference,
      version: pending.version,
      grantId: pending.grantId,
      accessJti: pending.accessJti,
    };
    connector.pendingReauthentication = null;
  }

  private handleAuthExpiring(connector: ConnectorState, frame: RelayV2JsonObject): void {
    const payload = objectField(frame, "payload");
    if (stringField(payload, "grantId") !== connector.credential.grantId) return;
    this.options.onAuthExpiring?.({
      grantId: stringField(payload, "grantId"),
      expiresAtMs: payload.expiresAtMs as number,
      refreshRecommendedAtMs: payload.refreshRecommendedAtMs as number,
    });
  }

  private handleCarrierError(connector: ConnectorState, frame: RelayV2JsonObject): void {
    const payload = objectField(frame, "payload");
    const failedType = stringField(payload, "failedType");
    const managementPending = connector.pendingDashboardManagementControl;
    if (managementPending?.requestId === stringField(frame, "requestId")
      && failedType !== managementPending.kind) {
      this.failConnector(connector, 4400, "invalid_dashboard_control_correlation");
      return;
    }
    if (failedType === "enrollment.create" || failedType === "grant.revoke") {
      const pending = this.exactDashboardManagementPending(connector, frame, failedType);
      if (!pending) return;
      const error = dashboardControlCarrierError(objectField(frame, "error"));
      if (!error) {
        this.failConnector(connector, 4400, "invalid_dashboard_control_error");
        return;
      }
      this.rejectDashboardManagementControl(connector, pending, error);
      return;
    }
    if (failedType !== "host.reauthenticate") return;
    const pending = connector.pendingReauthentication;
    if (!pending || stringField(frame, "requestId") !== pending.requestId) return;
    const error = objectField(frame, "error");
    this.options.onReauthenticationError?.({
      requestId: pending.requestId,
      code: stringField(error, "code"),
      retryable: error.retryable as boolean,
    });
  }

  private handleSuperseded(connector: ConnectorState, frame: RelayV2JsonObject): void {
    const payload = objectField(frame, "payload");
    if (stringField(payload, "losingConnectorId") !== connector.connectorId
      || stringField(payload, "losingHostInstanceId") !== this.options.hostInstanceId
      || stringField(payload, "hostId") !== this.options.hostId) return;
    this.permanentlySuperseded = true;
    this.current = null;
    connector.phase = "closed";
    this.cleanupConnector(connector, "host_superseded");
    this.publishStatus({
      phase: "superseded",
      generation: connector.generation,
      connectorId: connector.connectorId,
      closeCode: 4409,
      winningConnectorId: stringField(payload, "winningConnectorId"),
      winningHostInstanceId: stringField(payload, "winningHostInstanceId"),
    });
    connector.transport.close(4409, "host_superseded");
  }

  private handleRouteOpen(connector: ConnectorState, frame: RelayV2JsonObject): void {
    const routeId = stringField(frame, "routeId");
    if (connector.seenRouteIds.has(routeId)) {
      this.failConnector(connector, 4400, "route_identity_reused");
      return;
    }
    if (connector.seenRouteIds.size >= this.limits.maxRouteIdentitiesPerConnector
      || connector.routes.size >= this.limits.maxRoutes) {
      this.rejectRoute(connector, frame, "BUSY", "Host route capacity is exhausted", true);
      return;
    }
    connector.seenRouteIds.add(routeId);

    const payload = objectField(frame, "payload");
    const clientDialect = stringField(
      payload,
      "clientDialect",
    ) as RelayV2HostCarrierClientDialect;
    if (!this.clientDialects.includes(clientDialect)) {
      this.rejectRoute(
        connector,
        frame,
        "HOST_DIALECT_UNAVAILABLE",
        "Requested client dialect is unavailable",
        false,
      );
      return;
    }
    const auth = objectField(payload, "authContext");
    if (stringField(auth, "hostId") !== this.options.hostId) {
      this.rejectRoute(
        connector,
        frame,
        "PERMISSION_DENIED",
        "Route host authorization does not match this host",
        false,
      );
      return;
    }
    const requestedMax = objectField(payload, "limits").maxFrameBytes as number;
    const routeFence = stringField(frame, "routeFence");
    const authContext: RelayV2HostRouteAuthContext = clientDialect === "tw-relay.v2"
      ? Object.freeze({
          scheme: "twcap2" as const,
          role: "client" as const,
          hostId: stringField(auth, "hostId"),
          principalId: stringField(auth, "principalId"),
          grantId: stringField(auth, "grantId"),
          clientInstanceId: stringField(auth, "clientInstanceId"),
          jti: stringField(auth, "jti"),
          kid: stringField(auth, "kid"),
          expiresAtMs: auth.expiresAtMs as number,
        })
      : Object.freeze({
          scheme: "legacy_shared_secret" as const,
          role: "client" as const,
          hostId: stringField(auth, "hostId"),
          principalId: null,
          grantId: null,
          clientInstanceId: null,
        });
    const binding: RelayV2HostRouteBinding = Object.freeze({
      connectorGeneration: connector.generation,
      connectorId: connector.connectorId!,
      routeId,
      routeFence,
      connectionId: stringField(payload, "connectionId"),
      clientDialect,
      maxFrameBytes: Math.min(requestedMax, this.maxFrameBytes),
      authContext,
    });
    const route: RouteState = {
      binding,
      phase: "opening",
      clientToHostSeq: 0n,
      hostToClientAllocatedSeq: 0n,
      hostToClientEmittedSeq: 0n,
      outboundQueue: [],
      queuedFrames: 0,
      outstandingFrames: 0,
      outstandingPayloadBytes: 0,
      outstandingCarrierBytes: 0,
      pressureSinceMs: null,
    };
    connector.routes.set(routeId, route);
    try {
      const rejection = this.options.routeSink.onRouteBound(binding);
      if (rejection !== undefined) {
        if (rejection.accepted !== false
          || !HOST_ROUTE_BINDING_REJECTION_CODES.has(rejection.code)
          || typeof rejection.message !== "string"
          || typeof rejection.retryable !== "boolean") {
          throw new Error("Route sink returned an invalid binding result");
        }
        connector.routes.delete(routeId);
        this.rejectRoute(
          connector,
          frame,
          rejection.code,
          rejection.message,
          rejection.retryable,
        );
        return;
      }
    } catch {
      connector.routes.delete(routeId);
      this.rejectRoute(connector, frame, "INTERNAL", "Route sink rejected binding", true);
      return;
    }

    const response: RelayV2JsonObject = {
      carrierVersion: 1,
      type: "route.opened",
      requestId: stringField(frame, "requestId"),
      connectorId: binding.connectorId,
      routeId: binding.routeId,
      routeFence: binding.routeFence,
      payload: {
        acceptedAtMs: safeNow(this.clock),
        maxFrameBytes: binding.maxFrameBytes,
      },
    };
    this.enqueueControl(connector, response, {
      route,
      onSent: () => {
        if (this.currentRoute(connector, binding) === route && route.phase === "opening") {
          route.phase = "open";
        }
      },
    });
  }

  private rejectRoute(
    connector: ConnectorState,
    request: RelayV2JsonObject,
    code: RelayV2HostRouteBindingRejection["code"],
    message: string,
    retryable: boolean,
  ): void {
    this.enqueueControl(connector, {
      carrierVersion: 1,
      type: "route.rejected",
      requestId: stringField(request, "requestId"),
      connectorId: connector.connectorId!,
      routeId: stringField(request, "routeId"),
      routeFence: stringField(request, "routeFence"),
      payload: null,
      error: structuredError(code, message, retryable),
    });
  }

  private handleRouteData(connector: ConnectorState, frame: RelayV2JsonObject): void {
    if (stringField(frame, "direction") !== "client_to_host") {
      this.failConnector(connector, 4400, "carrier_direction_violation");
      return;
    }
    const route = this.exactRoute(connector, frame);
    if (!route) {
      this.failConnector(connector, 4400, "stale_route_source");
      return;
    }
    if (route.phase === "closing") {
      this.failConnector(connector, 4400, "closed_route_source");
      return;
    }
    if (route.phase === "opening") {
      this.failConnector(connector, 4400, "route_opened_barrier_violation");
      return;
    }
    const seq = counterField(frame, "seq");
    if (seq !== route.clientToHostSeq + 1n) {
      this.failConnector(connector, 4400, "carrier_sequence_violation");
      return;
    }
    const payload = objectField(frame, "payload");
    const encoded = stringField(payload, "data");
    const decodedLength = canonicalBase64DecodedLength(encoded);
    if (decodedLength === null) {
      this.failConnector(connector, 4400, "invalid_public_route_frame");
      return;
    }
    if (decodedLength > route.binding.maxFrameBytes) {
      this.failConnector(connector, 4400, "route_frame_limit");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = this.publicPayloadDecoder.decodeCanonicalBase64(encoded);
    } catch {
      this.failConnector(connector, 4400, "invalid_public_route_frame");
      return;
    }
    if (!(bytes instanceof Uint8Array)
      || bytes.byteLength !== decodedLength
      || bytes.byteLength > route.binding.maxFrameBytes) {
      this.failConnector(connector, 4400, "invalid_public_route_frame");
      return;
    }
    try {
      this.validatePublicPayload(route, bytes);
    } catch {
      this.failConnector(connector, 4400, "invalid_public_route_frame");
      return;
    }
    route.clientToHostSeq = seq;
    try {
      // Validation selects a dialect but never rewrites or translates bytes.
      this.options.routeSink.onClientFrame(route.binding, bytes);
    } catch {
      this.failConnector(connector, 1013, "route_sink_failure");
    }
  }

  private handleRouteUnbind(connector: ConnectorState, frame: RelayV2JsonObject): void {
    const route = this.exactRoute(connector, frame);
    if (!route) {
      this.failConnector(connector, 4400, "stale_route_source");
      return;
    }
    const payload = objectField(frame, "payload");
    if (counterField(payload, "lastClientToHostSeq") !== route.clientToHostSeq) {
      this.failConnector(connector, 4400, "carrier_sequence_violation");
      return;
    }
    route.phase = "closing";
    connector.routes.delete(route.binding.routeId);
    const detached = this.detachQueuedDataForRoute(connector, route);
    this.removeControlItems(connector, (item) => item.route === route);
    const reason = stringField(payload, "reason") as RelayV2HostRouteUnbindReason;
    try {
      this.options.routeSink.onRouteUnbound(route.binding, reason);
    } catch {
      // The transport binding is already removed. A presentation/domain sink
      // callback cannot resurrect it or prevent the carrier ACK.
    }
    this.settleDetached(detached, false);
    this.enqueueControl(connector, {
      carrierVersion: 1,
      type: "route.unbound",
      connectorId: route.binding.connectorId,
      routeId: route.binding.routeId,
      routeFence: route.binding.routeFence,
      payload: {
        reason,
        lastClientToHostSeq: route.clientToHostSeq.toString(10),
        lastHostToClientSeq: route.hostToClientEmittedSeq.toString(10),
      },
    });
    if (route.outstandingCarrierBytes > 0) {
      // The route owner is gone, so its route-level pressure timer can no
      // longer provide liveness for transport-owned writes. Keep a carrier
      // fence until those writes are ACKed; a lost transport ACK then closes
      // the carrier instead of leaving unaccounted bytes alive forever.
      connector.orphanedInFlightSinceMs ??= safeNow(this.clock);
    }
    if (this.connectorCanFlush(connector)) this.refreshPressureTimer(connector);
  }

  private failRoute(
    connector: ConnectorState,
    route: RouteState,
    close: RelayV2HostCarrierRouteClose,
  ): void {
    if (route.phase === "closing") return;
    const ownsCarrierPressure = connector.carrierPressureSinceMs !== null
      && this.carrierPressureOwner(connector) === route;
    route.phase = "closing";
    route.pressureSinceMs = null;
    if (ownsCarrierPressure) {
      connector.carrierPressureSinceMs = null;
    }
    const detached = this.detachQueuedDataForRoute(connector, route);
    try {
      this.options.routeSink.onRouteClosing?.(route.binding, close.errorCode);
    } catch {
      // Route fencing and the close control remain authoritative.
    }
    this.settleDetached(detached, false);
    const message = close.errorCode === "SLOW_CONSUMER"
      ? "Route cannot drain"
      : close.errorCode === "CAPABILITY_UNAVAILABLE"
        ? "Route capability is unavailable"
        : close.errorCode === "HOST_SUPERSEDED"
          ? "Host process was superseded"
          : "Route carrier state is no longer safe";
    this.enqueueControl(connector, {
      carrierVersion: 1,
      type: "route.close",
      connectorId: route.binding.connectorId,
      routeId: route.binding.routeId,
      routeFence: route.binding.routeFence,
      payload: {
        closeCode: close.closeCode,
        reason: close.reason,
        error: structuredError(close.errorCode, message, close.retryable),
      },
    }, { route });
    if (this.connectorCanFlush(connector)) this.refreshPressureTimer(connector);
  }

  private exactRoute(
    connector: ConnectorState,
    frame: RelayV2JsonObject,
  ): RouteState | undefined {
    const route = connector.routes.get(stringField(frame, "routeId"));
    if (!route || route.binding.routeFence !== stringField(frame, "routeFence")) return undefined;
    return route;
  }

  private currentRoute(
    connector: ConnectorState,
    binding: RelayV2HostRouteBinding,
  ): RouteState | undefined {
    if (this.current !== connector
      || binding.connectorGeneration !== connector.generation
      || binding.connectorId !== connector.connectorId) return undefined;
    const route = connector.routes.get(binding.routeId);
    if (!route || route.binding !== binding || route.binding.routeFence !== binding.routeFence) {
      return undefined;
    }
    return route;
  }

  private hasCurrentConnectorId(
    connector: ConnectorState,
    frame: RelayV2JsonObject,
  ): boolean {
    return typeof frame.connectorId === "string"
      && frame.connectorId === connector.connectorId;
  }

  private enqueueControl(
    connector: ConnectorState,
    frame: RelayV2JsonObject,
    metadata: Omit<OutboundItem, "bytes" | "deliveryToken"> = {},
  ): boolean {
    let bytes: Uint8Array;
    try {
      bytes = encodeRelayV2WebSocketFrame("carrier", frame);
    } catch {
      this.failConnector(connector, 4400, "invalid_outbound_control");
      return false;
    }
    if (connector.controlQueue.length >= this.limits.maxQueuedControlFrames
      || !this.carrierHasCapacity(connector, bytes.byteLength, false)) {
      this.noteCarrierPressure(connector);
      this.evaluatePressure(connector);
      return false;
    }
    const item: OutboundItem = {
      ...metadata,
      bytes,
      deliveryToken: this.newDeliveryToken(connector),
    };
    connector.controlQueue.push(item);
    connector.controlBytes += bytes.byteLength;
    this.noteAdmissionPressure(connector, metadata.route ?? null, false);
    if (!this.connectorCanFlush(connector)) return false;
    this.flush(connector);
    return connector.phase !== "closed" && item.transportRefused !== true;
  }

  private enqueueData(
    connector: ConnectorState,
    route: RouteState,
    routeSequence: bigint,
    frame: RelayV2JsonObject,
    payloadBytes: number,
    receipt: OutboundReceiptCell | undefined,
  ): boolean {
    let bytes: Uint8Array;
    try {
      bytes = encodeRelayV2WebSocketFrame("carrier", frame);
    } catch {
      return false;
    }
    if (route.outstandingFrames >= this.limits.maxQueuedDataFramesPerRoute
      || route.outstandingPayloadBytes > this.limits.routeHighWaterBytes - payloadBytes) {
      this.noteRoutePressure(connector, route);
      this.evaluatePressure(connector);
      return false;
    }
    if (connector.dataQueuedFrames >= this.limits.maxQueuedDataFrames
      || !this.carrierHasCapacity(connector, bytes.byteLength, true)) {
      this.noteCarrierPressure(connector);
      this.evaluatePressure(connector);
      return false;
    }
    const item = {
      bytes,
      deliveryToken: this.newDeliveryToken(connector),
      route,
      routeSequence,
      payloadBytes,
      receipt,
    } satisfies OutboundItem;
    if (route.outboundQueue.length === 0) connector.dataRoutes.push(route);
    route.outboundQueue.push(item);
    connector.dataQueuedFrames += 1;
    connector.dataCarrierBytes += bytes.byteLength;
    route.queuedFrames += 1;
    route.outstandingFrames += 1;
    route.outstandingPayloadBytes += payloadBytes;
    route.outstandingCarrierBytes += bytes.byteLength;
    route.hostToClientAllocatedSeq = routeSequence;
    this.noteAdmissionPressure(connector, route, true);
    if (!this.connectorCanFlush(connector)) return false;
    this.flush(connector);
    return connector.phase !== "closed";
  }

  private flush(connector: ConnectorState): void {
    if (connector.flushing || !this.connectorCanFlush(connector)) return;
    connector.flushing = true;
    let refusedDataRoutes = 0;
    try {
      while (this.connectorCanFlush(connector)) {
        const control = connector.controlQueue[0];
        if (control) {
          if (!connector.transport.trySend(
            control.bytes.slice(),
            control.deliveryToken,
          )) {
            if (control.dropOnTransportRefusal) {
              if (connector.controlQueue[0] !== control) {
                this.failConnector(connector, 1013, "reentrant_transport_mutation");
                return;
              }
              connector.controlQueue.shift();
              connector.controlBytes -= control.bytes.byteLength;
              control.transportRefused = true;
              this.evaluatePressure(connector);
            }
            return;
          }
          if (!this.connectorCanFlush(connector)) return;
          if (connector.controlQueue[0] !== control) {
            this.failConnector(connector, 1013, "reentrant_transport_mutation");
            return;
          }
          connector.controlQueue.shift();
          connector.controlBytes -= control.bytes.byteLength;
          this.commitTransportItem(connector, control);
          refusedDataRoutes = 0;
          continue;
        }

        const route = connector.dataRoutes.shift();
        if (!route) return;
        const item = route.outboundQueue[0];
        if (!item) {
          this.failConnector(connector, 1013, "invalid_route_queue_state");
          return;
        }
        if (!connector.transport.trySend(item.bytes.slice(), item.deliveryToken)) {
          connector.dataRoutes.push(route);
          refusedDataRoutes += 1;
          if (refusedDataRoutes >= connector.dataRoutes.length) return;
          continue;
        }
        if (!this.connectorCanFlush(connector)) return;
        if (route.outboundQueue[0] !== item) {
          this.failConnector(connector, 1013, "reentrant_transport_mutation");
          return;
        }
        route.outboundQueue.shift();
        connector.dataQueuedFrames -= 1;
        connector.dataCarrierBytes -= item.bytes.byteLength;
        route.queuedFrames -= 1;
        if (route.outboundQueue.length > 0) {
          connector.dataRoutes.push(route);
        }
        this.commitTransportItem(connector, item);
        refusedDataRoutes = 0;
      }
    } catch {
      this.failConnector(connector, 1013, "carrier_transport_failure");
    } finally {
      connector.flushing = false;
    }
  }

  private commitTransportItem(connector: ConnectorState, item: OutboundItem): void {
    connector.inFlight.push(item);
    connector.socketUnconfirmedBytes += item.bytes.byteLength;
    if (item.route && item.routeSequence !== undefined) {
      if (item.routeSequence !== item.route.hostToClientEmittedSeq + 1n) {
        this.failConnector(connector, 1013, "non_contiguous_transport_commit");
        return;
      }
      item.route.hostToClientEmittedSeq = item.routeSequence;
    }
    item.onSent?.();
  }

  private newDeliveryToken(connector: ConnectorState): string {
    if (connector.nextDeliveryToken >= MAX_COUNTER) {
      this.failConnector(connector, 1013, "delivery_token_exhausted");
      throw new Error("Relay v2 host carrier delivery token exhausted");
    }
    connector.nextDeliveryToken += 1n;
    return `${connector.generation}:${connector.nextDeliveryToken.toString(10)}`;
  }

  private connectorCanFlush(connector: ConnectorState): boolean {
    return this.current === connector && connector.phase !== "closed";
  }

  private carrierHasCapacity(
    connector: ConnectorState,
    additionalBytes: number,
    reserveControl: boolean,
  ): boolean {
    const ceiling = this.limits.carrierHighWaterBytes
      - (reserveControl ? this.limits.carrierControlReserveBytes : 0);
    try {
      return this.carrierOutstandingBytes(connector) <= ceiling - additionalBytes;
    } catch {
      this.failConnector(connector, 1013, "invalid_transport_accounting");
      return false;
    }
  }

  private carrierOutstandingBytes(connector: ConnectorState): number {
    const transportBytes = connector.transport.bufferedAmount();
    if (!Number.isSafeInteger(transportBytes) || transportBytes < 0) {
      throw new Error("Relay v2 host carrier transport bufferedAmount is invalid");
    }
    // socketUnconfirmedBytes and bufferedAmount describe the same transport
    // ownership interval. The larger view closes accounting gaps without
    // charging a frame twice when both sides have observed it.
    return connector.controlBytes
      + connector.dataCarrierBytes
      + Math.max(connector.socketUnconfirmedBytes, transportBytes);
  }

  private noteRoutePressure(connector: ConnectorState, route: RouteState): void {
    route.pressureSinceMs ??= safeNow(this.clock);
    this.refreshPressureTimer(connector);
  }

  private noteCarrierPressure(connector: ConnectorState): void {
    connector.carrierPressureSinceMs ??= safeNow(this.clock);
    this.refreshPressureTimer(connector);
  }

  private noteAdmissionPressure(
    connector: ConnectorState,
    route: RouteState | null,
    reserveControl: boolean,
  ): void {
    if (route && (route.outstandingPayloadBytes >= this.limits.routeHighWaterBytes
      || route.outstandingFrames >= this.limits.maxQueuedDataFramesPerRoute)) {
      this.noteRoutePressure(connector, route);
    }
    let total: number;
    try {
      total = this.carrierOutstandingBytes(connector);
    } catch {
      this.failConnector(connector, 1013, "invalid_transport_accounting");
      return;
    }
    const ceiling = this.limits.carrierHighWaterBytes
      - (reserveControl ? this.limits.carrierControlReserveBytes : 0);
    const frameLimitReached = reserveControl
      ? connector.dataQueuedFrames >= this.limits.maxQueuedDataFrames
      : connector.controlQueue.length >= this.limits.maxQueuedControlFrames;
    if (total >= ceiling || frameLimitReached) {
      this.noteCarrierPressure(connector);
    }
  }

  private carrierPressureOwner(connector: ConnectorState): RouteState | null {
    const candidates = new Set(connector.routes.values());
    let unownedBytes = connector.controlBytes;
    for (const item of connector.inFlight) {
      if (item.route) candidates.add(item.route);
      else unownedBytes += item.bytes.byteLength;
    }
    try {
      unownedBytes += Math.max(
        0,
        connector.transport.bufferedAmount() - connector.socketUnconfirmedBytes,
      );
    } catch {
      return null;
    }
    let owner: RouteState | null = null;
    for (const route of candidates) {
      if (route.outstandingCarrierBytes === 0) continue;
      if (!owner
        || route.outstandingCarrierBytes > owner.outstandingCarrierBytes
        || (route.outstandingCarrierBytes === owner.outstandingCarrierBytes
          && route.binding.routeId < owner.binding.routeId)) {
        owner = route;
      }
    }
    return owner && owner.outstandingCarrierBytes > unownedBytes ? owner : null;
  }

  private validatePublicPayload(route: RouteState, payload: Uint8Array): void {
    if (route.binding.clientDialect === "tw-relay.v2") {
      decodeRelayV2WebSocketFrame("public", payload, {
        opcode: "text",
        compressed: false,
      });
      return;
    }
    this.v1DialectAdapter!.validate(payload.slice());
  }

  private refreshPressureTimer(connector: ConnectorState): void {
    if (!this.connectorCanFlush(connector)) return;
    const deadlines: number[] = [];
    if (connector.carrierPressureSinceMs !== null) {
      deadlines.push(connector.carrierPressureSinceMs + 5_000);
    }
    if (connector.orphanedInFlightSinceMs !== null) {
      deadlines.push(connector.orphanedInFlightSinceMs + 5_000);
    }
    for (const route of connector.routes.values()) {
      if (route.pressureSinceMs !== null && route.phase === "open") {
        deadlines.push(route.pressureSinceMs + 5_000);
      }
    }
    const deadlineMs = deadlines.length === 0 ? null : Math.min(...deadlines);
    if (deadlineMs === null) {
      connector.pressureTimer?.cancel();
      connector.pressureTimer = null;
      return;
    }
    if (connector.pressureTimer?.deadlineMs === deadlineMs) return;
    connector.pressureTimer?.cancel();
    const delayMs = Math.max(0, deadlineMs - safeNow(this.clock));
    const generation = connector.generation;
    const cancel = this.schedule(delayMs, () => {
      if (this.current !== connector || connector.generation !== generation) return;
      connector.pressureTimer = null;
      this.evaluatePressure(connector);
    });
    connector.pressureTimer = { deadlineMs, cancel };
  }

  private evaluatePressure(connector: ConnectorState): void {
    if (!this.connectorCanFlush(connector)) return;
    let total: number;
    try {
      total = this.carrierOutstandingBytes(connector);
    } catch {
      this.failConnector(connector, 1013, "invalid_transport_accounting");
      return;
    }
    if (total > this.limits.carrierHighWaterBytes) {
      this.failConnector(connector, 1013, "carrier_hard_limit_breached");
      return;
    }
    const now = safeNow(this.clock);
    const hasOrphanedInFlight = connector.inFlight.some((item) => (
      item.route !== undefined
      && connector.routes.get(item.route.binding.routeId) !== item.route
    ));
    if (!hasOrphanedInFlight) {
      connector.orphanedInFlightSinceMs = null;
    } else if (connector.orphanedInFlightSinceMs !== null
      && now - connector.orphanedInFlightSinceMs >= 5_000) {
      this.failConnector(connector, 1013, "carrier_pressure_timeout");
      return;
    }
    for (const route of connector.routes.values()) {
      if (route.pressureSinceMs === null) continue;
      const belowLowWater = route.outstandingPayloadBytes < this.limits.routeLowWaterBytes
        && route.outstandingFrames < this.limits.maxQueuedDataFramesPerRoute / 2;
      if (belowLowWater) {
        route.pressureSinceMs = null;
      } else if (now - route.pressureSinceMs >= 5_000 && route.phase === "open") {
        route.pressureSinceMs = null;
        this.failRoute(connector, route, ROUTE_CLOSE_SLOW_CONSUMER);
      }
    }
    if (!this.connectorCanFlush(connector)) return;
    try {
      total = this.carrierOutstandingBytes(connector);
    } catch {
      this.failConnector(connector, 1013, "invalid_transport_accounting");
      return;
    }
    const carrierBelowLowWater = total < this.limits.carrierLowWaterBytes
      && connector.controlQueue.length < this.limits.maxQueuedControlFrames / 2
      && connector.dataQueuedFrames < this.limits.maxQueuedDataFrames / 2;
    if (carrierBelowLowWater) {
      connector.carrierPressureSinceMs = null;
    } else if (connector.carrierPressureSinceMs !== null
      && now - connector.carrierPressureSinceMs >= 5_000) {
      const pressureRoute = this.carrierPressureOwner(connector);
      connector.carrierPressureSinceMs = null;
      if (pressureRoute && pressureRoute.phase === "open") {
        this.failRoute(connector, pressureRoute, ROUTE_CLOSE_SLOW_CONSUMER);
      } else {
        this.failConnector(connector, 1013, "carrier_pressure_timeout");
      }
    }
    if (this.connectorCanFlush(connector)) this.refreshPressureTimer(connector);
  }

  private acknowledge(generation: number, deliveryToken: string): void {
    const connector = this.current;
    if (!connector || connector.generation !== generation) return;
    if (connector.flushing || this.dispatchingReceipts) {
      this.failConnector(connector, 4400, "reentrant_transport_ack");
      return;
    }
    const item = connector.inFlight[0];
    if (!item || item.deliveryToken !== deliveryToken) {
      this.failConnector(connector, 4400, "invalid_transport_ack");
      return;
    }
    let transportBytes: number;
    try {
      transportBytes = connector.transport.bufferedAmount();
    } catch {
      this.failConnector(connector, 1013, "invalid_transport_accounting");
      return;
    }
    const actorBytesAfterAck = connector.socketUnconfirmedBytes - item.bytes.byteLength;
    if (!Number.isSafeInteger(transportBytes)
      || transportBytes < 0
      || transportBytes > actorBytesAfterAck) {
      this.failConnector(connector, 4400, "premature_transport_ack");
      return;
    }
    connector.inFlight.shift();
    connector.socketUnconfirmedBytes -= item.bytes.byteLength;
    if (item.route && item.payloadBytes !== undefined) {
      item.route.outstandingFrames -= 1;
      item.route.outstandingPayloadBytes -= item.payloadBytes;
      item.route.outstandingCarrierBytes -= item.bytes.byteLength;
    }
    this.recordReceiptOutcome(item.receipt, true);
    // Pressure is evaluated against post-ACK accounting. Evaluating before
    // the decrement can expire a five-second fence even when this exact ACK
    // crosses low water and should recover the route/carrier.
    this.evaluatePressure(connector);
    if (!this.connectorCanFlush(connector)) return;
    this.flush(connector);
    if (this.connectorCanFlush(connector)) this.evaluatePressure(connector);
  }

  private rejectUnaccepted(generation: number, deliveryToken: string): void {
    const connector = this.current;
    if (!connector || connector.generation !== generation) return;
    if (connector.flushing || this.dispatchingReceipts) {
      this.failConnector(connector, 4400, "reentrant_transport_reject");
      return;
    }
    const index = connector.inFlight.findIndex((candidate) => (
      candidate.deliveryToken === deliveryToken
    ));
    const item = index < 0 ? undefined : connector.inFlight[index];
    if (!item?.route || item.routeSequence === undefined || item.payloadBytes === undefined
      || item.routeSequence !== item.route.hostToClientEmittedSeq) {
      this.failConnector(connector, 4400, "invalid_transport_reject");
      return;
    }
    connector.inFlight.splice(index, 1);
    connector.socketUnconfirmedBytes -= item.bytes.byteLength;
    item.route.outstandingFrames -= 1;
    item.route.outstandingPayloadBytes -= item.payloadBytes;
    item.route.outstandingCarrierBytes -= item.bytes.byteLength;
    item.route.hostToClientEmittedSeq -= 1n;
    item.route.hostToClientAllocatedSeq = item.route.hostToClientEmittedSeq;
    this.recordReceiptOutcome(item.receipt, false);
    // Do not flush synchronously. The pump must deliver the route close/unbind
    // control before this route is allowed to produce again.
    this.evaluatePressure(connector);
  }

  private writable(generation: number): void {
    const connector = this.current;
    if (!connector || connector.generation !== generation) return;
    this.evaluatePressure(connector);
    this.flush(connector);
    this.evaluatePressure(connector);
  }

  private closed(generation: number, code = 1006): void {
    const connector = this.current;
    if (!connector || connector.generation !== generation || connector.phase === "closed") return;
    if (code === 4409) {
      this.permanentlySuperseded = true;
      this.current = null;
      connector.phase = "closed";
      this.cleanupConnector(connector, "host_superseded");
      this.publishStatus({
        phase: "superseded",
        generation,
        connectorId: connector.connectorId,
        closeCode: code,
      });
      return;
    }
    this.current = null;
    connector.phase = "closed";
    this.cleanupConnector(connector, "carrier_closed");
    this.publishStatus({
      phase: "offline",
      generation,
      connectorId: connector.connectorId,
      closeCode: code,
    });
  }

  private failConnector(connector: ConnectorState, code: number, reason: string): void {
    if (this.current !== connector || connector.phase === "closed") return;
    this.current = null;
    connector.phase = "closed";
    this.cleanupConnector(connector, "carrier_closed");
    this.publishStatus({
      phase: "offline",
      generation: connector.generation,
      connectorId: connector.connectorId,
      closeCode: code,
    });
    connector.transport.close(code, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const connector = this.current;
    this.current = null;
    if (!connector || connector.phase === "closed") return;
    connector.phase = "closed";
    this.cleanupConnector(connector, "carrier_closed");
    this.publishStatus({
      phase: "offline",
      generation: connector.generation,
      connectorId: connector.connectorId,
      closeCode: 1000,
    });
    try { connector.transport.close(1000, "host_shutdown"); } catch {}
  }

  private cleanupConnector(
    connector: ConnectorState,
    reason: RelayV2HostLocalUnbindReason,
  ): void {
    const pendingControl = connector.pendingDashboardManagementControl;
    if (pendingControl !== null) {
      this.rejectDashboardManagementControl(
        connector,
        pendingControl,
        new RelayV2HostCarrierDashboardManagementControlError("NOT_REGISTERED"),
      );
    }
    const routes = [...connector.routes.values()];
    for (const route of routes) route.phase = "closing";
    connector.routes.clear();
    const detached = this.detachConnectorQueues(connector, routes);
    for (const route of routes) {
      try {
        this.options.routeSink.onRouteUnbound(route.binding, reason);
      } catch {
        // Connector retirement is not reversible by a sink callback.
      }
    }
    this.settleDetached(detached, false);
  }

  private resolveDashboardManagementControl(
    connector: ConnectorState,
    pending: PendingDashboardManagementControl,
    result: RelayV2HostCarrierDashboardManagementEnrollmentResult
      | RelayV2HostCarrierDashboardManagementRevocationResult,
  ): void {
    if (pending.settled || connector.pendingDashboardManagementControl !== pending) return;
    connector.pendingDashboardManagementControl = null;
    pending.settled = true;
    pending.resolve(result);
  }

  private rejectDashboardManagementControl(
    connector: ConnectorState,
    pending: PendingDashboardManagementControl,
    error: RelayV2HostCarrierDashboardManagementControlError,
  ): void {
    if (pending.settled || connector.pendingDashboardManagementControl !== pending) return;
    connector.pendingDashboardManagementControl = null;
    pending.settled = true;
    pending.reject(error);
  }

  private detachQueuedDataForRoute(
    connector: ConnectorState,
    route: RouteState,
  ): OutboundItem[] {
    const detached = route.outboundQueue;
    for (const item of detached) {
      connector.dataCarrierBytes -= item.bytes.byteLength;
      connector.dataQueuedFrames -= 1;
      route.queuedFrames -= 1;
      route.outstandingFrames -= 1;
      route.outstandingPayloadBytes -= item.payloadBytes ?? 0;
      route.outstandingCarrierBytes -= item.bytes.byteLength;
    }
    route.outboundQueue = [];
    route.hostToClientAllocatedSeq = route.hostToClientEmittedSeq;
    connector.dataRoutes = connector.dataRoutes.filter((candidate) => candidate !== route);
    return detached;
  }

  private removeControlItems(
    connector: ConnectorState,
    predicate: (item: OutboundItem) => boolean,
  ): void {
    const retained: OutboundItem[] = [];
    for (const item of connector.controlQueue) {
      if (predicate(item)) connector.controlBytes -= item.bytes.byteLength;
      else retained.push(item);
    }
    connector.controlQueue = retained;
  }

  private detachConnectorQueues(
    connector: ConnectorState,
    routesSnapshot: readonly RouteState[],
  ): OutboundItem[] {
    try {
      connector.pressureTimer?.cancel();
    } catch {
      // Lifecycle cleanup remains authoritative even if a scheduler adapter's
      // cancellation receipt is faulty.
    }
    connector.pressureTimer = null;
    const detached = [...connector.controlQueue];
    const sequenceOwners = new Set<RouteState>();
    for (const route of new Set([...routesSnapshot, ...connector.dataRoutes])) {
      sequenceOwners.add(route);
      detached.push(...this.detachQueuedDataForRoute(connector, route));
    }
    for (const item of connector.inFlight) {
      connector.socketUnconfirmedBytes -= item.bytes.byteLength;
      if (item.route && item.payloadBytes !== undefined) {
        sequenceOwners.add(item.route);
        item.route.outstandingFrames -= 1;
        item.route.outstandingPayloadBytes -= item.payloadBytes;
        item.route.outstandingCarrierBytes -= item.bytes.byteLength;
        item.route.hostToClientEmittedSeq -= 1n;
      }
      detached.push(item);
    }
    for (const route of sequenceOwners) {
      route.hostToClientAllocatedSeq = route.hostToClientEmittedSeq;
    }
    connector.controlQueue = [];
    connector.controlBytes = 0;
    connector.dataRoutes = [];
    connector.dataQueuedFrames = 0;
    connector.dataCarrierBytes = 0;
    connector.inFlight = [];
    connector.socketUnconfirmedBytes = 0;
    connector.carrierPressureSinceMs = null;
    connector.orphanedInFlightSinceMs = null;
    connector.pendingReauthentication = null;
    connector.pendingDashboardManagementControl = null;
    return detached;
  }

  private publishStatus(status: RelayV2HostCarrierStatus): void {
    this.latestStatus = { ...status };
    try {
      this.options.onStatus?.({ ...status });
    } catch {
      // Status observation cannot own connector lifecycle.
    }
  }
}
