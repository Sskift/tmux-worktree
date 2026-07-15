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
 * The credential owner performs the durable CAS. The carrier only presents an
 * ACK when its connector/request/jti/reference fence is still current. This
 * module intentionally provides no credential authority or persistence
 * adapter; G1 integration must inject the later dedicated v2 implementation.
 */
export interface RelayV2HostCarrierCredentialReferences {
  read(reference: string): RelayV2HostCredentialRecord;
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

export interface RelayV2HostCarrierRouteSink {
  onRouteBound(binding: RelayV2HostRouteBinding): void;
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

interface OutboundItem {
  bytes: Uint8Array;
  deliveryToken: string;
  route?: RouteState;
  routeSequence?: bigint;
  payloadBytes?: number;
  queueKey?: string;
  onSent?: () => void;
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

function publicBytes(encoded: string): Uint8Array {
  return Uint8Array.from(Buffer.from(encoded, "base64"));
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

function structuredError(
  code:
    | "BUSY"
    | "PERMISSION_DENIED"
    | "HOST_DIALECT_UNAVAILABLE"
    | "SLOW_CONSUMER"
    | "INTERNAL",
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

export class RelayV2HostCarrierActor {
  private readonly clock: () => number;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;
  private readonly idFactory: () => string;
  private readonly limits: QueueLimits;
  private readonly capabilities: string[];
  private readonly clientDialects: RelayV2HostCarrierClientDialect[];
  private readonly v1DialectAdapter?: RelayV2HostCarrierDialectAdapter;
  private readonly maxFrameBytes: number;
  private readonly terminalMaxFrameBytes: number;
  private generation = 0;
  private current: ConnectorState | null = null;
  private permanentlySuperseded = false;
  private latestStatus: RelayV2HostCarrierStatus | null = null;

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

  connect(
    transport: RelayV2HostCarrierTransport,
    credentialReference: string,
  ): RelayV2HostCarrierConnection {
    if (this.permanentlySuperseded) {
      throw new Error("Relay v2 host carrier was superseded and cannot reconnect");
    }
    const credential = this.options.credentialReferences.read(credentialReference);
    validateCredentialRecord(credentialReference, credential);

    const previous = this.current;
    const connector: ConnectorState = {
      generation: ++this.generation,
      transport,
      helloRequestId: this.idFactory(),
      helloSent: false,
      phase: "hello",
      connectorId: null,
      credential: copyCredentialMetadata(credential),
      pendingReauthentication: null,
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
        this.retireConnectorRoutes(previous, "connector_replaced");
        this.clearQueues(previous);
        previous.phase = "closed";
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
    this.retireConnectorRoutes(connector, "carrier_closed");
    this.clearQueues(connector);
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
    const connector = this.current;
    if (!connector || connector.phase !== "registered" || !connector.connectorId) {
      return false;
    }
    const credential = this.options.credentialReferences.read(credentialReference);
    validateCredentialRecord(credentialReference, credential);
    if (credential.grantId !== connector.credential.grantId) {
      throw new Error("Relay v2 host reauthentication cannot change the host grant");
    }

    const queueKey = `reauth:${requestId}`;
    if (connector.pendingReauthentication) {
      this.removeControlItems(
        connector,
        (item) => item.queueKey === connector.pendingReauthentication?.queueKey,
      );
    }
    connector.pendingReauthentication = {
      reference: credential.reference,
      version: credential.version,
      requestId,
      grantId: credential.grantId,
      accessJti: credential.accessJti,
      queueKey,
    };

    const frame: RelayV2JsonObject = {
      carrierVersion: 1,
      type: "host.reauthenticate",
      requestId,
      connectorId: connector.connectorId,
      payload: { accessToken: credential.accessToken },
    };
    if (!this.enqueueControl(connector, frame, { queueKey })) {
      return false;
    }
    return true;
  }

  sendPublic(binding: RelayV2HostRouteBinding, payload: Uint8Array): boolean {
    const connector = this.current;
    const route = connector ? this.currentRoute(connector, binding) : undefined;
    if (!connector || connector.phase !== "registered" || !route || route.phase !== "open") {
      return false;
    }
    if (payload.byteLength > route.binding.maxFrameBytes) {
      this.failRoute(connector, route, "protocol_error", "INTERNAL");
      return false;
    }
    try {
      this.validatePublicPayload(route, payload);
    } catch {
      this.failRoute(connector, route, "protocol_error", "INTERNAL");
      return false;
    }
    if (route.hostToClientAllocatedSeq >= MAX_COUNTER) {
      this.failRoute(connector, route, "protocol_error", "INTERNAL");
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
    if (!this.enqueueData(connector, route, next, frame, payload.byteLength)) {
      return false;
    }
    return true;
  }

  closeRoute(
    binding: RelayV2HostRouteBinding,
    reason: "slow_consumer" | "protocol_error" | "host_shutdown" = "host_shutdown",
  ): boolean {
    const connector = this.current;
    const route = connector ? this.currentRoute(connector, binding) : undefined;
    if (!connector || !route || route.phase === "closing") return false;
    this.failRoute(
      connector,
      route,
      reason,
      reason === "slow_consumer" ? "SLOW_CONSUMER" : "INTERNAL",
    );
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

  private handleReauthenticated(connector: ConnectorState, frame: RelayV2JsonObject): void {
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
    if (stringField(payload, "failedType") !== "host.reauthenticate") return;
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
    this.retireConnectorRoutes(connector, "host_superseded");
    this.clearQueues(connector);
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
      this.options.routeSink.onRouteBound(binding);
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
    code: "BUSY" | "PERMISSION_DENIED" | "HOST_DIALECT_UNAVAILABLE" | "INTERNAL",
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
    const bytes = publicBytes(stringField(payload, "data"));
    if (bytes.byteLength > route.binding.maxFrameBytes) {
      this.failConnector(connector, 4400, "route_frame_limit");
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
    this.removeDataForRoute(connector, route);
    this.removeControlItems(connector, (item) => item.route === route);
    if (route.outstandingCarrierBytes > 0) {
      // The route owner is gone, so its route-level pressure timer can no
      // longer provide liveness for transport-owned writes. Keep a carrier
      // fence until those writes are ACKed; a lost transport ACK then closes
      // the carrier instead of leaving unaccounted bytes alive forever.
      connector.orphanedInFlightSinceMs ??= safeNow(this.clock);
      this.refreshPressureTimer(connector);
    }
    const reason = stringField(payload, "reason") as RelayV2HostRouteUnbindReason;
    try {
      this.options.routeSink.onRouteUnbound(route.binding, reason);
    } catch {
      // The transport binding is already removed. A presentation/domain sink
      // callback cannot resurrect it or prevent the carrier ACK.
    }
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
    if (this.connectorCanFlush(connector)) this.refreshPressureTimer(connector);
  }

  private failRoute(
    connector: ConnectorState,
    route: RouteState,
    reason: "slow_consumer" | "protocol_error" | "host_shutdown",
    code: "SLOW_CONSUMER" | "INTERNAL",
  ): void {
    if (route.phase === "closing") return;
    const ownsCarrierPressure = connector.carrierPressureSinceMs !== null
      && this.carrierPressureOwner(connector) === route;
    route.phase = "closing";
    route.pressureSinceMs = null;
    if (ownsCarrierPressure) {
      connector.carrierPressureSinceMs = null;
    }
    this.removeDataForRoute(connector, route);
    try {
      this.options.routeSink.onRouteClosing?.(route.binding, code);
    } catch {
      // Route fencing and the close control remain authoritative.
    }
    const message = code === "SLOW_CONSUMER"
      ? "Route cannot drain"
      : "Route carrier state is no longer safe";
    this.enqueueControl(connector, {
      carrierVersion: 1,
      type: "route.close",
      connectorId: route.binding.connectorId,
      routeId: route.binding.routeId,
      routeFence: route.binding.routeFence,
      payload: {
        closeCode: code === "SLOW_CONSUMER" ? 1013 : 4400,
        reason,
        error: structuredError(code, message, code === "SLOW_CONSUMER"),
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
    connector.controlQueue.push({
      ...metadata,
      bytes,
      deliveryToken: this.newDeliveryToken(connector),
    });
    connector.controlBytes += bytes.byteLength;
    this.noteAdmissionPressure(connector, metadata.route ?? null, false);
    if (!this.connectorCanFlush(connector)) return false;
    this.flush(connector);
    return connector.phase !== "closed";
  }

  private enqueueData(
    connector: ConnectorState,
    route: RouteState,
    routeSequence: bigint,
    frame: RelayV2JsonObject,
    payloadBytes: number,
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
          )) return;
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
        this.failRoute(connector, route, "slow_consumer", "SLOW_CONSUMER");
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
        this.failRoute(connector, pressureRoute, "slow_consumer", "SLOW_CONSUMER");
      } else {
        this.failConnector(connector, 1013, "carrier_pressure_timeout");
      }
    }
    if (this.connectorCanFlush(connector)) this.refreshPressureTimer(connector);
  }

  private acknowledge(generation: number, deliveryToken: string): void {
    const connector = this.current;
    if (!connector || connector.generation !== generation) return;
    if (connector.flushing) {
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
    if (connector.flushing) {
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
      this.retireConnectorRoutes(connector, "host_superseded");
      this.clearQueues(connector);
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
    this.retireConnectorRoutes(connector, "carrier_closed");
    this.clearQueues(connector);
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
    this.retireConnectorRoutes(connector, "carrier_closed");
    this.clearQueues(connector);
    this.publishStatus({
      phase: "offline",
      generation: connector.generation,
      connectorId: connector.connectorId,
      closeCode: code,
    });
    connector.transport.close(code, reason);
  }

  private retireConnectorRoutes(
    connector: ConnectorState,
    reason: RelayV2HostLocalUnbindReason,
  ): void {
    for (const route of connector.routes.values()) {
      try {
        this.options.routeSink.onRouteUnbound(route.binding, reason);
      } catch {
        // Connector retirement is not reversible by a sink callback.
      }
    }
    connector.routes.clear();
  }

  private removeDataForRoute(connector: ConnectorState, route: RouteState): void {
    for (const item of route.outboundQueue) {
      connector.dataCarrierBytes -= item.bytes.byteLength;
      connector.dataQueuedFrames -= 1;
      route.queuedFrames -= 1;
      route.outstandingFrames -= 1;
      route.outstandingPayloadBytes -= item.payloadBytes ?? 0;
      route.outstandingCarrierBytes -= item.bytes.byteLength;
    }
    route.outboundQueue = [];
    connector.dataRoutes = connector.dataRoutes.filter((candidate) => candidate !== route);
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

  private clearQueues(connector: ConnectorState): void {
    try {
      connector.pressureTimer?.cancel();
    } catch {
      // Lifecycle cleanup remains authoritative even if a scheduler adapter's
      // cancellation receipt is faulty.
    }
    connector.pressureTimer = null;
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
