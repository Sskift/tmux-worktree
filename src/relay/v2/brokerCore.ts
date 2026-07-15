import { randomBytes, randomUUID } from "node:crypto";
import type { RelayV2AuthContext } from "./auth.js";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
  RELAY_V2_CARRIER_FRAME_BYTES,
  RELAY_V2_PUBLIC_FRAME_BYTES,
  resolveRelayV2RouteDialect,
} from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";

export const RELAY_V2_REQUIRED_CAPABILITIES = Object.freeze([
  "error.structured.v1",
  "command.ledger.v1",
  "command.query.v1",
  "snapshot.revision.v1",
  "event.sequence.v1",
  "terminal.stream.resume.v1",
] as const);

export const RELAY_V2_BROKER_LIMITS = Object.freeze({
  maxFrameBytes: RELAY_V2_PUBLIC_FRAME_BYTES,
  maxCarrierFrameBytes: RELAY_V2_CARRIER_FRAME_BYTES,
  routeBufferedBytesPerDirection: 1_048_576,
  routeLowWaterBytesPerDirection: 524_288,
  routeLowWaterFramesPerDirection: 64,
  carrierBufferedBytes: 16_777_216,
  carrierLowWaterBytes: 8_388_608,
  maxQueuedRouteFrames: 128,
  maxInFlightRequestsPerRoute: 64,
} as const);

const CARRIER_CONTROL_RESERVE_BYTES = 65_536;
const BACKPRESSURE_CLOSE_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLIENT_TO_HOST_PUBLIC_TYPES = new Set([
  "client.hello",
  "command.execute",
  "command.query",
  "scopes.snapshot.get",
  "sessions.snapshot.get",
  "state.snapshot.get",
  "state.snapshot.release",
  "terminal.open",
  "terminal.output_ack",
  "terminal.replay_request",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
]);

const HOST_TO_CLIENT_PUBLIC_TYPES = new Set([
  "host.welcome",
  "error",
  "command.status",
  "command.result",
  "command.statuses",
  "scopes.snapshot",
  "sessions.snapshot",
  "state.snapshot.chunk",
  "state.snapshot.released",
  "scopes.changed",
  "sessions.changed",
  "terminal.opened",
  "terminal.output",
  "terminal.replay_started",
  "terminal.reset_required",
  "terminal.input_ack",
  "terminal.input_error",
  "terminal.resize_ack",
  "terminal.resize_error",
  "terminal.closed",
]);

export type RelayBrokerRole = "client" | "host";

export interface RelayBrokerUpgradeRequest {
  pathname: string;
  search: string;
  authorizationHeaders: readonly string[];
  legacyQuerySecret?: string | null;
  offeredProtocols: readonly string[];
}

export interface RelayBrokerUpgradeDependencies {
  verifyLegacySecret(secret: string): boolean | Promise<boolean>;
  verifyV2AccessToken(
    token: string,
    expectedRole: RelayBrokerRole,
  ): RelayV2AuthContext | Promise<RelayV2AuthContext>;
}

export type RelayBrokerUpgradeResult =
  | {
      outcome: "accept";
      stack: "v1";
      credentialKind: "legacy_shared_secret";
      role: RelayBrokerRole;
      selectedProtocol: "tw-relay.v1" | null;
      fallback: false;
    }
  | {
      outcome: "accept";
      stack: "v2";
      credentialKind: "twcap2";
      role: RelayBrokerRole;
      selectedProtocol: "tw-relay.v2" | "tw-relay.host.v2";
      authContext: RelayV2AuthContext;
      fallback: false;
    }
  | {
      outcome: "reject";
      status: 400 | 401 | 403 | 404 | 426;
      errorCode:
        | "AUTH_REQUIRED"
        | "AUTH_INVALID"
        | "GRANT_NOT_FOUND"
        | "ROLE_MISMATCH"
        | "PERMISSION_DENIED"
        | "PROTOCOL_UNSUPPORTED";
      fallback: false;
    };

export interface RelayV2StructuredError {
  code:
    | "BUSY"
    | "AUTH_INVALID"
    | "CAPABILITY_UNAVAILABLE"
    | "DUPLICATE_CONNECTOR"
    | "HOST_DIALECT_UNAVAILABLE"
    | "HOST_OFFLINE"
    | "HOST_SUPERSEDED"
    | "IDEMPOTENCY_CONFLICT"
    | "INTERNAL"
    | "INVALID_ENVELOPE"
    | "PERMISSION_DENIED"
    | "SLOW_CONSUMER";
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  commandDisposition:
    | "not_accepted"
    | "accepted"
    | "running"
    | "completed"
    | "in_doubt"
    | "not_applicable";
  details: null;
}

export type RelayV2BrokerAction =
  | {
      kind: "send_host";
      transportId: string;
      frame: RelayV2JsonObject;
      /** Present when adapter acceptance is an explicit broker commit fence. */
      deliveryId?: string;
    }
  | {
      kind: "close_host";
      transportId: string;
      closeCode: 1013 | 4400 | 4403 | 4409 | 4411;
      reason: string;
    }
  | {
      kind: "route_opened";
      connectionId: string;
      routeId: string;
      routeFence: string;
      hostId: string;
      hostEpoch: string;
      hostInstanceId: string;
      capabilities: string[];
    }
  | {
      kind: "route_unavailable";
      connectionId: string;
      hostId: string;
      closeCode: 1013 | 4403 | 4406;
      error: RelayV2StructuredError;
    }
  | {
      kind: "close_client";
      connectionId: string;
      closeCode: number;
      reason: string;
    }
  | {
      kind: "pause_client" | "resume_client";
      connectionId: string;
    }
  | {
      kind: "pause_host_route" | "resume_host_route";
      transportId: string;
      routeId: string;
    };

export type RelayV2AuthControlRequest =
  | {
      type: "host.reauthenticate";
      requestId: string;
      connectorId: string;
      accessToken: string;
      currentAuthContext: Readonly<RelayV2AuthContext>;
    }
  | {
      type: "enrollment.create" | "grant.revoke";
      requestId: string;
      connectorId: string;
      payload: RelayV2JsonObject;
      currentAuthContext: Readonly<RelayV2AuthContext>;
    };

export type RelayV2AuthControlDecision =
  | {
      outcome: "success";
      /** Persisted first/replay carrier ACK owned by the authority. */
      response: RelayV2JsonObject;
      /** True only when response came from the authority's persisted replay record. */
      replayed: boolean;
      /** Required only for a successful host.reauthenticate. */
      nextAuthContext?: RelayV2AuthContext;
    }
  | {
      outcome: "reject";
      error: RelayV2StructuredError;
    };

/**
 * Persistent authority boundary for carrier auth controls. Implementations
 * own transactionality, request replay records, credential writes and
 * revocation/enrollment state. The broker only commits a replacement host
 * auth context after a valid host.reauthenticated ACK is available.
 */
export interface RelayV2BrokerAuthControlAuthority {
  handle(
    request: RelayV2AuthControlRequest,
  ): RelayV2AuthControlDecision | Promise<RelayV2AuthControlDecision>;
}

export interface RelayV2BrokerResult {
  /** True only when the input was admitted to broker-owned bounded state. */
  accepted: boolean;
  /**
   * Pump actions are edge-triggered. A pause stops the named source; only a
   * later delivery acknowledgement may emit its matching resume.
   */
  actions: RelayV2BrokerAction[];
  error?: RelayV2StructuredError;
}

export interface RelayV2RouteOpenResult extends RelayV2BrokerResult {
  routeId?: string;
  routeFence?: string;
}

export interface RelayV2CarrierDelivery {
  /** Remains charged to the carrier until acknowledgeHostDelivery. */
  deliveryId: string;
  transportId: string;
  frame: RelayV2JsonObject;
  wire: Uint8Array;
}

export interface RelayV2ClientDelivery {
  /** Remains charged to the route/carrier until acknowledgeClientDelivery. */
  deliveryId: string;
  connectionId: string;
  opcode: "text";
  bytes: Uint8Array;
}

export interface RelayV2HostDirectoryView {
  hostId: string;
  state: "online" | "offline";
  revision: string;
  hostEpoch: string | null;
  hostInstanceId: string | null;
  connectorId: string | null;
  clientDialects: ("tw-relay.v1" | "tw-relay.v2")[];
  capabilities: string[];
  observedAtMs: number;
}

export type RelayV2ClientAdmission =
  | {
      outcome: "accept";
      connectorId: string;
      hostEpoch: string;
      hostInstanceId: string;
    }
  | {
      outcome: "reject";
      status: 426 | 503;
      error: RelayV2StructuredError;
    };

type HostHello = {
  requestId: string;
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  clientDialects: ("tw-relay.v1" | "tw-relay.v2")[];
  capabilities: string[];
  maxFrameBytes: number;
  terminalMaxFrameBytes: number;
};

type QueuedCarrierFrame = {
  frame: RelayV2JsonObject;
  wire: Uint8Array;
  wireBytes: number;
  route: RouteState | null;
  rawBytes: number;
  routeSeq: bigint | null;
};

type InFlightCarrierFrame = QueuedCarrierFrame & {
  deliveryId: string;
};

type CarrierState = {
  transportId: string;
  authContext: RelayV2AuthContext;
  status: "pending" | "registering" | "active" | "superseded" | "closed";
  connectorId: string | null;
  hello: HostHello | null;
  registration: {
    deliveryId: string;
    baseDirectoryRevision: bigint;
    previousTransportId: string | null;
  } | null;
  controlQueue: QueuedCarrierFrame[];
  dataQueues: Map<string, QueuedCarrierFrame[]>;
  dataOrder: string[];
  dataCursor: number;
  queuedBytes: number;
  inFlightBytes: number;
  hostToClientBufferedBytes: number;
  inFlight: Map<string, InFlightCarrierFrame>;
};

type QueuedClientFrame = {
  bytes: Uint8Array;
  route: RouteState;
};

type InFlightClientFrame = QueuedClientFrame & {
  deliveryId: string;
};

type ClientState = {
  connectionId: string;
  authContext: RelayV2AuthContext;
  routeId: string;
  queue: QueuedClientFrame[];
  inFlight: Map<string, InFlightClientFrame>;
};

type RouteState = {
  connectionId: string;
  routeId: string;
  routeFence: string;
  openRequestId: string;
  connectorId: string;
  carrierTransportId: string;
  authContext: RelayV2AuthContext;
  status: "opening" | "opened" | "closing" | "closed";
  maxFrameBytes: number;
  nextClientToHostSeq: bigint;
  lastClientToHostDispatchedSeq: bigint;
  expectedHostToClientSeq: bigint;
  clientToHostBufferedBytes: number;
  clientToHostFrames: number;
  hostToClientBufferedBytes: number;
  hostToClientFrames: number;
  inFlightRequestIds: Set<string>;
  clientToHostPressureSinceMs: number | null;
  hostToClientPressureSinceMs: number | null;
  clientReadPaused: boolean;
  hostReadPaused: boolean;
};

type DirectoryRecord = {
  hostId: string;
  state: "online" | "offline";
  revision: bigint;
  hostEpoch: string | null;
  hostInstanceId: string | null;
  connectorId: string | null;
  clientDialects: ("tw-relay.v1" | "tw-relay.v2")[];
  capabilities: string[];
  observedAtMs: number;
};

function roleForPath(pathname: string): RelayBrokerRole | undefined {
  if (pathname === "/client") return "client";
  if (pathname === "/host") return "host";
  return undefined;
}

function bearerCredential(header: string): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

function upgradeReject(
  status: 400 | 401 | 403 | 404 | 426,
  errorCode: Extract<RelayBrokerUpgradeResult, { outcome: "reject" }>["errorCode"],
): RelayBrokerUpgradeResult {
  return { outcome: "reject", status, errorCode, fallback: false };
}

function authFailureStatus(code: unknown): 401 | 403 {
  return code === "AUTH_INVALID" ? 401 : 403;
}

/**
 * Selects exactly one legacy or v2 authentication stack before WebSocket
 * Upgrade. The caller must use the returned stack directly; retrying the
 * other verifier after any rejection would violate the credential boundary.
 *
 * This function deliberately does not read issuer/grant persistence. The
 * broker authentication owner supplies that transaction-backed verifier.
 */
export async function dispatchRelayBrokerUpgrade(
  request: RelayBrokerUpgradeRequest,
  dependencies: RelayBrokerUpgradeDependencies,
): Promise<RelayBrokerUpgradeResult> {
  if (request.authorizationHeaders.length > 1) {
    return upgradeReject(401, "AUTH_INVALID");
  }
  const authorization = request.authorizationHeaders[0];
  const headerCredential = authorization === undefined
    ? undefined
    : bearerCredential(authorization);
  if (authorization !== undefined && headerCredential === undefined) {
    return upgradeReject(401, "AUTH_INVALID");
  }
  const queryCredential = request.legacyQuerySecret ?? undefined;
  const credential = headerCredential ?? queryCredential;
  if (!credential) return upgradeReject(401, "AUTH_REQUIRED");

  const role = roleForPath(request.pathname);
  const credentialLooksV2 = credential.startsWith("twcap2.");
  if (credentialLooksV2) {
    if (headerCredential === undefined) {
      // A twcap2 token in the legacy query slot is still a v2 credential, but
      // v2 credentials are forbidden in URLs. It can never become v1 input.
      return upgradeReject(401, "AUTH_INVALID");
    }
    if (role === undefined) return upgradeReject(404, "PROTOCOL_UNSUPPORTED");
    if (request.search !== "") return upgradeReject(400, "PROTOCOL_UNSUPPORTED");
    const requiredProtocol = role === "client" ? "tw-relay.v2" : "tw-relay.host.v2";
    if (
      request.offeredProtocols.length !== 1
      || request.offeredProtocols[0] !== requiredProtocol
    ) {
      return upgradeReject(426, "PROTOCOL_UNSUPPORTED");
    }
    try {
      const authContext = await dependencies.verifyV2AccessToken(credential, role);
      if (
        authContext.scheme !== "twcap2"
        || authContext.role !== role
        || (role === "client" && authContext.clientInstanceId === null)
        || (role === "host" && authContext.clientInstanceId !== null)
      ) {
        return upgradeReject(403, "ROLE_MISMATCH");
      }
      return {
        outcome: "accept",
        stack: "v2",
        credentialKind: "twcap2",
        role,
        selectedProtocol: requiredProtocol,
        authContext,
        fallback: false,
      };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (
        code === "GRANT_NOT_FOUND"
        || code === "ROLE_MISMATCH"
        || code === "PERMISSION_DENIED"
      ) {
        return upgradeReject(authFailureStatus(code), code);
      }
      return upgradeReject(401, "AUTH_INVALID");
    }
  }

  if (role === undefined) return upgradeReject(404, "PROTOCOL_UNSUPPORTED");
  if (
    request.offeredProtocols.length > 1
    || (request.offeredProtocols.length === 1
      && request.offeredProtocols[0] !== "tw-relay.v1")
  ) {
    return upgradeReject(426, "PROTOCOL_UNSUPPORTED");
  }
  if (!await dependencies.verifyLegacySecret(credential)) {
    return upgradeReject(401, "AUTH_INVALID");
  }
  return {
    outcome: "accept",
    stack: "v1",
    credentialKind: "legacy_shared_secret",
    role,
    selectedProtocol: request.offeredProtocols.length === 1 ? "tw-relay.v1" : null,
    fallback: false,
  };
}

function structuredError(
  code: RelayV2StructuredError["code"],
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
  commandDisposition: RelayV2StructuredError["commandDisposition"] = "not_applicable",
): RelayV2StructuredError {
  return {
    code,
    message,
    retryable,
    retryAfterMs,
    commandDisposition,
    details: null,
  };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function cloneFrame(frame: RelayV2JsonObject): RelayV2JsonObject {
  return structuredClone(frame);
}

function encodeCarrier(frame: RelayV2JsonObject): Uint8Array {
  return encodeRelayV2WebSocketFrame("carrier", frame);
}

function carrierFrame(frame: RelayV2JsonObject): QueuedCarrierFrame {
  const wire = encodeCarrier(frame);
  return {
    frame: cloneFrame(frame),
    wire,
    wireBytes: wire.byteLength,
    route: null,
    rawBytes: 0,
    routeSeq: null,
  };
}

function parseHostHello(frame: RelayV2JsonObject): HostHello {
  const payload = frame.payload as RelayV2JsonObject;
  const limits = payload.limits as RelayV2JsonObject;
  return {
    requestId: frame.requestId as string,
    hostId: payload.hostId as string,
    hostEpoch: payload.hostEpoch as string,
    hostInstanceId: payload.hostInstanceId as string,
    clientDialects: [...payload.clientDialects as string[]] as HostHello["clientDialects"],
    capabilities: [...payload.capabilities as string[]],
    maxFrameBytes: limits.maxFrameBytes as number,
    terminalMaxFrameBytes: limits.terminalMaxFrameBytes as number,
  };
}

function lastDispatchedClientSeq(route: RouteState): string {
  return route.lastClientToHostDispatchedSeq.toString(10);
}

function lastAcceptedHostSeq(route: RouteState): string {
  return (route.expectedHostToClientSeq - 1n).toString(10);
}

export class RelayV2BrokerCore {
  readonly brokerEpoch: string;

  private readonly carriers = new Map<string, CarrierState>();
  private readonly activeCarriers = new Map<string, CarrierState>();
  private readonly registeringCarriers = new Map<string, CarrierState>();
  private readonly directory = new Map<string, DirectoryRecord>();
  private readonly routes = new Map<string, RouteState>();
  private readonly clients = new Map<string, ClientState>();
  private readonly now: () => number;
  private readonly authControlAuthority: RelayV2BrokerAuthControlAuthority | undefined;

  constructor(options: {
    brokerEpoch?: string;
    now?: () => number;
    authControlAuthority?: RelayV2BrokerAuthControlAuthority;
  } = {}) {
    this.brokerEpoch = options.brokerEpoch ?? randomUUID();
    if (!isIdentifier(this.brokerEpoch)) throw new Error("invalid Relay v2 broker epoch");
    this.now = options.now ?? Date.now;
    this.authControlAuthority = options.authControlAuthority;
  }

  /** Attach only after dispatchRelayBrokerUpgrade accepted a role=host v2 Upgrade. */
  attachHostCarrier(transportId: string, authContext: RelayV2AuthContext): void {
    if (!isIdentifier(transportId) || this.carriers.has(transportId)) {
      throw new Error("invalid or duplicate Relay v2 carrier transport ID");
    }
    if (
      authContext.scheme !== "twcap2"
      || authContext.role !== "host"
      || authContext.clientInstanceId !== null
    ) {
      throw new Error("Relay v2 host carrier requires a verified host auth context");
    }
    this.carriers.set(transportId, {
      transportId,
      authContext: Object.freeze({ ...authContext }),
      status: "pending",
      connectorId: null,
      hello: null,
      registration: null,
      controlQueue: [],
      dataQueues: new Map(),
      dataOrder: [],
      dataCursor: 0,
      queuedBytes: 0,
      inFlightBytes: 0,
      hostToClientBufferedBytes: 0,
      inFlight: new Map(),
    });
  }

  inspectHost(hostId: string): RelayV2HostDirectoryView | undefined {
    const record = this.directory.get(hostId);
    if (!record) return undefined;
    return {
      hostId: record.hostId,
      state: record.state,
      revision: record.revision.toString(10),
      hostEpoch: record.hostEpoch,
      hostInstanceId: record.hostInstanceId,
      connectorId: record.connectorId,
      clientDialects: [...record.clientDialects],
      capabilities: [...record.capabilities],
      observedAtMs: record.observedAtMs,
    };
  }

  inspectClientAdmission(authContext: RelayV2AuthContext): RelayV2ClientAdmission {
    if (
      authContext.scheme !== "twcap2"
      || authContext.role !== "client"
      || authContext.clientInstanceId === null
    ) {
      return {
        outcome: "reject",
        status: 503,
        error: structuredError("PERMISSION_DENIED", "Client authorization is not valid"),
      };
    }
    const carrier = this.activeCarriers.get(authContext.hostId);
    if (!carrier || carrier.status !== "active" || !carrier.hello || !carrier.connectorId) {
      return {
        outcome: "reject",
        status: 503,
        error: structuredError(
          "HOST_OFFLINE",
          "Host is not connected",
          true,
          1_000,
          "not_accepted",
        ),
      };
    }
    const dialect = resolveRelayV2RouteDialect({
      clientDialect: "tw-relay.v2",
      hostDialects: carrier.hello.clientDialects,
      requiredCapabilities: RELAY_V2_REQUIRED_CAPABILITIES,
      hostCapabilities: carrier.hello.capabilities,
    });
    if (dialect.outcome === "reject") {
      return {
        outcome: "reject",
        status: 426,
        error: structuredError(
          dialect.errorCode,
          dialect.errorCode === "HOST_DIALECT_UNAVAILABLE"
            ? "Requested client dialect is unavailable"
            : "Required Relay v2 capabilities are unavailable",
        ),
      };
    }
    return {
      outcome: "accept",
      connectorId: carrier.connectorId,
      hostEpoch: carrier.hello.hostEpoch,
      hostInstanceId: carrier.hello.hostInstanceId,
    };
  }

  /**
   * Call inspectClientAdmission before sending HTTP 101 so known offline and
   * dialect failures stay HTTP 503/426. This second admission closes the race
   * between 101 and route.open. It opens only the carrier route: route_opened
   * is an adapter signal, not a public relay.welcome, so capability
   * advertisement remains gated on later H/G2 integration.
   */
  openClientRoute(
    connectionId: string,
    authContext: RelayV2AuthContext,
  ): RelayV2RouteOpenResult {
    if (!isIdentifier(connectionId) || this.clients.has(connectionId)) {
      return this.failure("INVALID_ENVELOPE", "Client connection ID is invalid");
    }
    const admission = this.inspectClientAdmission(authContext);
    if (admission.outcome === "reject") {
      return {
        accepted: false,
        error: admission.error,
        actions: [{
          kind: "route_unavailable",
          connectionId,
          hostId: authContext.hostId,
          closeCode: admission.status === 426 ? 4406 : 1013,
          error: admission.error,
        }],
      };
    }
    const carrier = this.activeCarriers.get(authContext.hostId)!;
    if (
      this.carrierBufferedBytes(carrier)
      >= RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - CARRIER_CONTROL_RESERVE_BYTES
    ) {
      const error = structuredError("BUSY", "Host carrier is under backpressure", true, 1_000);
      return {
        accepted: false,
        error,
        actions: [{
          kind: "route_unavailable",
          connectionId,
          hostId: authContext.hostId,
          closeCode: 1013,
          error,
        }],
      };
    }
    const routeId = randomUUID();
    const routeFence = randomBytes(16).toString("base64url");
    const openRequestId = randomUUID();
    const route: RouteState = {
      connectionId,
      routeId,
      routeFence,
      openRequestId,
      connectorId: admission.connectorId,
      carrierTransportId: carrier.transportId,
      authContext: Object.freeze({ ...authContext }),
      status: "opening",
      maxFrameBytes: Math.min(
        RELAY_V2_BROKER_LIMITS.maxFrameBytes,
        carrier.hello!.maxFrameBytes,
      ),
      nextClientToHostSeq: 1n,
      lastClientToHostDispatchedSeq: 0n,
      expectedHostToClientSeq: 1n,
      clientToHostBufferedBytes: 0,
      clientToHostFrames: 0,
      hostToClientBufferedBytes: 0,
      hostToClientFrames: 0,
      inFlightRequestIds: new Set(),
      clientToHostPressureSinceMs: null,
      hostToClientPressureSinceMs: null,
      clientReadPaused: false,
      hostReadPaused: false,
    };
    const frame = {
      carrierVersion: 1,
      type: "route.open",
      requestId: openRequestId,
      connectorId: route.connectorId,
      routeId,
      routeFence,
      payload: {
        connectionId,
        clientDialect: "tw-relay.v2",
        authContext: {
          scheme: "twcap2",
          role: "client",
          hostId: authContext.hostId,
          principalId: authContext.principalId,
          grantId: authContext.grantId,
          clientInstanceId: authContext.clientInstanceId!,
          jti: authContext.jti,
          kid: authContext.kid,
          expiresAtMs: authContext.expiresAtMs,
        },
        limits: { maxFrameBytes: route.maxFrameBytes },
      },
    } satisfies RelayV2JsonObject;
    if (!this.enqueueCarrierControl(carrier, frame, route)) {
      const error = structuredError("BUSY", "Host carrier cannot admit route control", true, 1_000);
      return {
        accepted: false,
        error,
        actions: [{
          kind: "route_unavailable",
          connectionId,
          hostId: authContext.hostId,
          closeCode: 1013,
          error,
        }],
      };
    }
    this.routes.set(routeId, route);
    this.clients.set(connectionId, {
      connectionId,
      authContext: Object.freeze({ ...authContext }),
      routeId,
      queue: [],
      inFlight: new Map(),
    });
    return { accepted: true, actions: [], routeId, routeFence };
  }

  async receiveHostFrame(
    transportId: string,
    bytes: Uint8Array,
  ): Promise<RelayV2BrokerResult> {
    const carrier = this.carriers.get(transportId);
    if (!carrier || carrier.status === "closed") {
      return this.failure("HOST_SUPERSEDED", "Carrier is no longer registered", [{
        kind: "close_host",
        transportId,
        closeCode: 4409,
        reason: "host_superseded",
      }]);
    }
    let frame: RelayV2JsonObject;
    try {
      frame = decodeRelayV2WebSocketFrame("carrier", bytes).frame;
    } catch {
      return this.protocolViolation(carrier, "invalid_carrier_frame");
    }
    const type = frame.type as string;
    if (carrier.status === "pending") {
      if (type !== "host.hello") return this.protocolViolation(carrier, "host_hello_required");
      return this.registerHost(carrier, frame);
    }
    if (carrier.status === "registering") {
      return this.protocolViolation(carrier, "host_registration_uncommitted");
    }
    if (carrier.status === "superseded") {
      return this.failure("HOST_SUPERSEDED", "Carrier was superseded", [{
        kind: "close_host",
        transportId,
        closeCode: 4409,
        reason: "host_superseded",
      }]);
    }
    if (type === "host.hello") return this.protocolViolation(carrier, "duplicate_host_hello");
    if (!carrier.connectorId || frame.connectorId !== carrier.connectorId) {
      return this.protocolViolation(carrier, "stale_connector");
    }

    switch (type) {
      case "route.opened":
        return this.routeOpened(carrier, frame);
      case "route.rejected":
        return this.routeRejected(carrier, frame);
      case "route.data":
        return this.routeDataFromHost(carrier, frame);
      case "route.unbound":
        return this.routeUnbound(carrier, frame);
      case "route.close":
        return this.routeClosedByHost(carrier, frame);
      case "host.reauthenticate":
      case "enrollment.create":
      case "grant.revoke":
        return this.handleAuthControl(carrier, frame, type);
      default:
        return this.protocolViolation(carrier, "unsupported_carrier_control");
    }
  }

  /**
   * Adapter commit fence for the direct host.registered delivery. Call only
   * after the WebSocket implementation has accepted that control frame for
   * delivery. Until this succeeds the connector is deliberately not online.
   */
  acknowledgeHostControlDelivery(
    transportId: string,
    deliveryId: string,
  ): RelayV2BrokerResult {
    const carrier = this.carriers.get(transportId);
    const registration = carrier?.registration;
    if (
      !carrier
      || carrier.status !== "registering"
      || !carrier.hello
      || !carrier.connectorId
      || !registration
      || registration.deliveryId !== deliveryId
      || this.registeringCarriers.get(carrier.authContext.hostId) !== carrier
    ) {
      return this.failure("INVALID_ENVELOPE", "Host control delivery fence is stale");
    }
    const currentRevision = this.directory.get(carrier.authContext.hostId)?.revision ?? 0n;
    const previous = registration.previousTransportId === null
      ? undefined
      : this.carriers.get(registration.previousTransportId);
    if (
      currentRevision !== registration.baseDirectoryRevision
      || (registration.previousTransportId !== null
        && (!previous || previous.status !== "active"))
    ) {
      this.cancelRegistration(carrier);
      return this.failure("BUSY", "Host registration changed before delivery commit", [{
        kind: "close_host",
        transportId,
        closeCode: 1013,
        reason: "registration_commit_race",
      }]);
    }

    this.registeringCarriers.delete(carrier.authContext.hostId);
    carrier.registration = null;
    carrier.status = "active";
    this.activeCarriers.set(carrier.authContext.hostId, carrier);
    this.publishDirectory(carrier, "online");
    const actions: RelayV2BrokerAction[] = [];
    if (previous?.connectorId && previous.hello) {
      previous.status = "superseded";
      this.invalidateConnectorRoutes(previous, actions, true);
      actions.push({
        kind: "send_host",
        transportId: previous.transportId,
        frame: this.checkedCarrierFrame({
          carrierVersion: 1,
          type: "host.superseded",
          connectorId: previous.connectorId,
          payload: {
            hostId: carrier.hello.hostId,
            losingConnectorId: previous.connectorId,
            winningConnectorId: carrier.connectorId,
            losingHostInstanceId: previous.hello.hostInstanceId,
            winningHostInstanceId: carrier.hello.hostInstanceId,
            reason: "new_authenticated_connector",
          },
        }),
      });
      actions.push({
        kind: "close_host",
        transportId: previous.transportId,
        closeCode: 4409,
        reason: "host_superseded",
      });
      this.discardCarrier(previous);
      this.carriers.delete(previous.transportId);
    }
    return { accepted: true, actions };
  }

  rejectHostControlDelivery(transportId: string, deliveryId: string): RelayV2BrokerResult {
    const carrier = this.carriers.get(transportId);
    if (
      !carrier
      || carrier.status !== "registering"
      || carrier.registration?.deliveryId !== deliveryId
    ) {
      return this.failure("INVALID_ENVELOPE", "Host control delivery fence is stale");
    }
    this.cancelRegistration(carrier);
    return { accepted: true, actions: [] };
  }

  forwardClientFrame(connectionId: string, bytes: Uint8Array): RelayV2BrokerResult {
    const client = this.clients.get(connectionId);
    const route = client ? this.routes.get(client.routeId) : undefined;
    if (!client || !route || route.status !== "opened") {
      return this.failure("INVALID_ENVELOPE", "Client route is not open");
    }
    let publicFrame: RelayV2JsonObject;
    try {
      publicFrame = decodeRelayV2WebSocketFrame("public", bytes).frame;
    } catch {
      const actions = this.beginRouteUnbind(route, "protocol_error");
      actions.push({
        kind: "close_client",
        connectionId,
        closeCode: 4400,
        reason: "invalid_public_frame",
      });
      return this.failure("INVALID_ENVELOPE", "Client frame is not a valid public envelope", actions);
    }
    if (
      bytes.byteLength > route.maxFrameBytes
      || !this.isClientPublicFrameAuthorized(route, publicFrame)
    ) {
      const actions = this.beginRouteUnbind(route, "protocol_error");
      actions.push({
        kind: "close_client",
        connectionId,
        closeCode: 4400,
        reason: "invalid_public_identity",
      });
      return this.failure("INVALID_ENVELOPE", "Client public identity is not authorized", actions);
    }
    const carrier = this.carriers.get(route.carrierTransportId);
    if (
      !carrier
      || carrier.status !== "active"
      || carrier.connectorId !== route.connectorId
    ) {
      const error = structuredError(
        "HOST_OFFLINE",
        "Host is not connected",
        true,
        1_000,
        "not_accepted",
      );
      this.dropRoute(route);
      return {
        accepted: false,
        error,
        actions: [{ kind: "close_client", connectionId, closeCode: 1013, reason: "host_offline" }],
      };
    }
    const requestId = publicFrame.kind === "request"
      ? publicFrame.requestId as string
      : null;
    if (requestId !== null && route.inFlightRequestIds.has(requestId)) {
      return this.failure(
        "IDEMPOTENCY_CONFLICT",
        "Request ID is already in flight on this route",
      );
    }
    if (
      requestId !== null
      && route.inFlightRequestIds.size >= RELAY_V2_BROKER_LIMITS.maxInFlightRequestsPerRoute
    ) {
      const error = structuredError(
        "BUSY",
        "Route has too many in-flight requests",
        true,
        1_000,
        "not_accepted",
      );
      return { accepted: false, error, actions: [] };
    }
    const seq = route.nextClientToHostSeq;
    const frame = {
      carrierVersion: 1,
      type: "route.data",
      connectorId: route.connectorId,
      routeId: route.routeId,
      routeFence: route.routeFence,
      direction: "client_to_host",
      seq: seq.toString(10),
      payload: {
        opcode: "text",
        encoding: "base64",
        data: Buffer.from(bytes).toString("base64"),
      },
    } satisfies RelayV2JsonObject;
    if (!this.enqueueCarrierData(carrier, route, frame, bytes.byteLength, seq)) {
      const error = structuredError(
        "SLOW_CONSUMER",
        "Route cannot admit more client data",
        true,
        1_000,
        "not_accepted",
      );
      const actions = this.markClientPressure(route);
      return { accepted: false, error, actions };
    }
    route.nextClientToHostSeq += 1n;
    if (requestId !== null) route.inFlightRequestIds.add(requestId);
    const actions = this.clientToHostAtHighWater(carrier, route)
      ? this.markClientPressure(route)
      : [];
    return { accepted: true, actions };
  }

  unbindClient(
    connectionId: string,
    reason:
      | "client_closed"
      | "client_replaced"
      | "auth_expired"
      | "auth_revoked"
      | "slow_consumer"
      | "protocol_error"
      | "broker_shutdown" = "client_closed",
  ): RelayV2BrokerResult {
    const client = this.clients.get(connectionId);
    const route = client ? this.routes.get(client.routeId) : undefined;
    if (!client || !route) return { accepted: true, actions: [] };
    const actions = this.beginRouteUnbind(route, reason);
    return { accepted: true, actions };
  }

  disconnectHost(transportId: string): RelayV2BrokerResult {
    const carrier = this.carriers.get(transportId);
    if (!carrier) return { accepted: true, actions: [] };
    const actions: RelayV2BrokerAction[] = [];
    if (carrier.status === "registering") {
      this.registeringCarriers.delete(carrier.authContext.hostId);
      carrier.registration = null;
    }
    if (
      carrier.status === "active"
      && carrier.connectorId
      && this.activeCarriers.get(carrier.authContext.hostId) === carrier
    ) {
      this.activeCarriers.delete(carrier.authContext.hostId);
      this.publishDirectory(carrier, "offline");
      this.invalidateConnectorRoutes(carrier, actions, false);
    }
    this.discardCarrier(carrier);
    carrier.status = "closed";
    this.carriers.delete(transportId);
    return { accepted: true, actions };
  }

  /**
   * Moves bounded broker entries into the adapter pump. Returned deliveries
   * remain in-flight and billed; the adapter must ACK each accepted write.
   */
  drainHostCarrier(
    transportId: string,
    options: { maxFrames?: number; maxBytes?: number } = {},
  ): RelayV2CarrierDelivery[] {
    const carrier = this.carriers.get(transportId);
    if (!carrier || carrier.status !== "active") return [];
    const maxFrames = options.maxFrames ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    const deliveries: RelayV2CarrierDelivery[] = [];
    let drainedBytes = 0;

    const deliver = (entry: QueuedCarrierFrame): boolean => {
      if (deliveries.length >= maxFrames || drainedBytes + entry.wireBytes > maxBytes) return false;
      const deliveryId = randomUUID();
      carrier.queuedBytes -= entry.wireBytes;
      carrier.inFlightBytes += entry.wireBytes;
      carrier.inFlight.set(deliveryId, { ...entry, deliveryId });
      if (entry.route && entry.routeSeq !== null) {
        entry.route.lastClientToHostDispatchedSeq = entry.routeSeq;
      }
      drainedBytes += entry.wireBytes;
      deliveries.push({
        deliveryId,
        transportId,
        frame: cloneFrame(entry.frame),
        wire: entry.wire.slice(),
      });
      return true;
    };

    while (carrier.controlQueue.length > 0) {
      const entry = carrier.controlQueue[0]!;
      if (!deliver(entry)) return deliveries;
      carrier.controlQueue.shift();
    }

    let scansWithoutDelivery = 0;
    while (carrier.dataOrder.length > 0 && deliveries.length < maxFrames) {
      if (carrier.dataCursor >= carrier.dataOrder.length) carrier.dataCursor = 0;
      const routeId = carrier.dataOrder[carrier.dataCursor]!;
      const queue = carrier.dataQueues.get(routeId);
      if (!queue || queue.length === 0) {
        carrier.dataQueues.delete(routeId);
        carrier.dataOrder.splice(carrier.dataCursor, 1);
        scansWithoutDelivery = 0;
        continue;
      }
      const entry = queue[0]!;
      if (!deliver(entry)) {
        scansWithoutDelivery += 1;
        carrier.dataCursor = (carrier.dataCursor + 1) % carrier.dataOrder.length;
        if (scansWithoutDelivery >= carrier.dataOrder.length) break;
        continue;
      }
      scansWithoutDelivery = 0;
      queue.shift();
      if (queue.length === 0) {
        carrier.dataQueues.delete(routeId);
        carrier.dataOrder.splice(carrier.dataCursor, 1);
      } else {
        carrier.dataCursor = (carrier.dataCursor + 1) % carrier.dataOrder.length;
      }
    }
    return deliveries;
  }

  /** Releases carrier accounting; delivery ACK methods are the only resume edges. */
  acknowledgeHostDelivery(transportId: string, deliveryId: string): RelayV2BrokerResult {
    const carrier = this.carriers.get(transportId);
    const delivery = carrier?.inFlight.get(deliveryId);
    if (!carrier || !delivery) {
      return this.failure("INVALID_ENVELOPE", "Carrier delivery acknowledgement is stale");
    }
    carrier.inFlight.delete(deliveryId);
    carrier.inFlightBytes -= delivery.wireBytes;
    if (delivery.route && delivery.routeSeq !== null) {
      delivery.route.clientToHostBufferedBytes -= delivery.rawBytes;
      delivery.route.clientToHostFrames -= 1;
    }
    return { accepted: true, actions: this.collectCarrierResumes(carrier) };
  }

  /**
   * Moves bounded broker entries into the client adapter pump. Returned
   * deliveries remain billed until acknowledgeClientDelivery.
   */
  drainClient(
    connectionId: string,
    options: { maxFrames?: number; maxBytes?: number } = {},
  ): RelayV2ClientDelivery[] {
    const client = this.clients.get(connectionId);
    if (!client) return [];
    const maxFrames = options.maxFrames ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    const deliveries: RelayV2ClientDelivery[] = [];
    let bytes = 0;
    while (client.queue.length > 0 && deliveries.length < maxFrames) {
      const entry = client.queue[0]!;
      if (bytes + entry.bytes.byteLength > maxBytes) break;
      client.queue.shift();
      const deliveryId = randomUUID();
      client.inFlight.set(deliveryId, { ...entry, deliveryId });
      bytes += entry.bytes.byteLength;
      deliveries.push({
        deliveryId,
        connectionId,
        opcode: "text",
        bytes: entry.bytes.slice(),
      });
    }
    return deliveries;
  }

  /** Releases route accounting; delivery ACK methods are the only resume edges. */
  acknowledgeClientDelivery(connectionId: string, deliveryId: string): RelayV2BrokerResult {
    const client = this.clients.get(connectionId);
    const delivery = client?.inFlight.get(deliveryId);
    if (!client || !delivery) {
      return this.failure("INVALID_ENVELOPE", "Client delivery acknowledgement is stale");
    }
    client.inFlight.delete(deliveryId);
    this.releaseHostToClientBytes(delivery.route, delivery.bytes.byteLength);
    const carrier = this.carriers.get(delivery.route.carrierTransportId);
    return {
      accepted: true,
      actions: carrier ? this.collectCarrierResumes(carrier) : [],
    };
  }

  /** Close only routes that have remained above a bounded pressure fence for 5 seconds. */
  sweepBackpressure(): RelayV2BrokerResult {
    const actions: RelayV2BrokerAction[] = [];
    const now = this.now();
    for (const route of [...this.routes.values()]) {
      if (route.status !== "opened") continue;
      const pressureSince = [
        route.clientToHostPressureSinceMs,
        route.hostToClientPressureSinceMs,
      ].filter((value): value is number => value !== null)
        .reduce<number | null>((earliest, value) => (
          earliest === null || value < earliest ? value : earliest
        ), null);
      if (pressureSince === null || now - pressureSince < BACKPRESSURE_CLOSE_MS) continue;
      actions.push(...this.beginRouteUnbind(route, "slow_consumer"));
      actions.push({
        kind: "close_client",
        connectionId: route.connectionId,
        closeCode: 1013,
        reason: "sustained_backpressure",
      });
    }
    return { accepted: true, actions };
  }

  private registerHost(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const hello = parseHostHello(frame);
    if (
      hello.hostId !== carrier.authContext.hostId
      || !isUuid(hello.hostEpoch)
      || !isUuid(hello.hostInstanceId)
      || hello.maxFrameBytes <= 0
      || hello.terminalMaxFrameBytes <= 0
      || hello.terminalMaxFrameBytes > hello.maxFrameBytes
    ) {
      const error = structuredError("PERMISSION_DENIED", "Host hello does not match authorization");
      carrier.status = "closed";
      this.discardCarrier(carrier);
      this.carriers.delete(carrier.transportId);
      return {
        accepted: false,
        error,
        actions: [
          this.carrierErrorAction(carrier.transportId, hello.requestId, null, "host.hello", error),
          { kind: "close_host", transportId: carrier.transportId, closeCode: 4403, reason: "host_identity_mismatch" },
        ],
      };
    }
    const previous = this.activeCarriers.get(hello.hostId);
    const registering = this.registeringCarriers.get(hello.hostId);
    if (
      previous?.hello?.hostInstanceId === hello.hostInstanceId
      || registering?.hello?.hostInstanceId === hello.hostInstanceId
    ) {
      const error = structuredError("DUPLICATE_CONNECTOR", "Host process already has an active connector");
      carrier.status = "closed";
      this.discardCarrier(carrier);
      this.carriers.delete(carrier.transportId);
      return {
        accepted: false,
        error,
        actions: [
          this.carrierErrorAction(carrier.transportId, hello.requestId, null, "host.hello", error),
          { kind: "close_host", transportId: carrier.transportId, closeCode: 4411, reason: "duplicate_connector" },
        ],
      };
    }
    if (registering) {
      const error = structuredError(
        "BUSY",
        "Host registration is already being committed",
        true,
        100,
      );
      carrier.status = "closed";
      this.discardCarrier(carrier);
      this.carriers.delete(carrier.transportId);
      return {
        accepted: false,
        error,
        actions: [
          this.carrierErrorAction(carrier.transportId, hello.requestId, null, "host.hello", error),
          { kind: "close_host", transportId: carrier.transportId, closeCode: 1013, reason: "registration_busy" },
        ],
      };
    }

    const connectorId = randomUUID();
    const deliveryId = randomUUID();
    const baseDirectoryRevision = this.directory.get(hello.hostId)?.revision ?? 0n;
    carrier.connectorId = connectorId;
    carrier.hello = hello;
    carrier.status = "registering";
    carrier.registration = {
      deliveryId,
      baseDirectoryRevision,
      previousTransportId: previous?.transportId ?? null,
    };
    this.registeringCarriers.set(hello.hostId, carrier);
    const revision = (baseDirectoryRevision + 1n).toString(10);
    const actions: RelayV2BrokerAction[] = [];
    const replaced = previous !== undefined;
    actions.push({
      kind: "send_host",
      transportId: carrier.transportId,
      deliveryId,
      frame: this.checkedCarrierFrame({
        carrierVersion: 1,
        type: "host.registered",
        requestId: hello.requestId,
        connectorId,
        payload: {
          brokerEpoch: this.brokerEpoch,
          hostsRevision: revision,
          disposition: replaced ? "replaced" : "connected",
          supersededHostInstanceId: previous?.hello?.hostInstanceId ?? null,
          limits: {
            maxCarrierFrameBytes: RELAY_V2_BROKER_LIMITS.maxCarrierFrameBytes,
            brokerCarrierBufferedBytes: RELAY_V2_BROKER_LIMITS.carrierBufferedBytes,
            brokerCarrierLowWaterBytes: RELAY_V2_BROKER_LIMITS.carrierLowWaterBytes,
          },
        },
      }),
    });
    return { accepted: true, actions };
  }

  private routeOpened(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const route = this.currentRouteForFrame(carrier, frame);
    if (!route || route.status !== "opening" || frame.requestId !== route.openRequestId) {
      return this.protocolViolation(carrier, "stale_route_opened");
    }
    const openedMaxFrameBytes = (frame.payload as RelayV2JsonObject).maxFrameBytes as number;
    if (openedMaxFrameBytes <= 0 || openedMaxFrameBytes > route.maxFrameBytes) {
      return this.protocolViolation(carrier, "invalid_route_frame_limit");
    }
    route.maxFrameBytes = openedMaxFrameBytes;
    route.status = "opened";
    return {
      accepted: true,
      actions: [{
        kind: "route_opened",
        connectionId: route.connectionId,
        routeId: route.routeId,
        routeFence: route.routeFence,
        hostId: route.authContext.hostId,
        hostEpoch: carrier.hello!.hostEpoch,
        hostInstanceId: carrier.hello!.hostInstanceId,
        capabilities: [...carrier.hello!.capabilities],
      }],
    };
  }

  private routeRejected(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const route = this.currentRouteForFrame(carrier, frame);
    if (!route || route.status !== "opening" || frame.requestId !== route.openRequestId) {
      return this.protocolViolation(carrier, "stale_route_rejected");
    }
    const source = frame.error as RelayV2JsonObject;
    const allowedCodes = new Set<RelayV2StructuredError["code"]>([
      "BUSY",
      "PERMISSION_DENIED",
      "INTERNAL",
      "CAPABILITY_UNAVAILABLE",
      "HOST_DIALECT_UNAVAILABLE",
    ]);
    if (!allowedCodes.has(source.code as RelayV2StructuredError["code"])) {
      return this.protocolViolation(carrier, "invalid_route_rejection_code");
    }
    const error = cloneFrame(source) as unknown as RelayV2StructuredError;
    this.dropRoute(route);
    const closeCode = error.code === "PERMISSION_DENIED"
      ? 4403
      : error.code === "CAPABILITY_UNAVAILABLE" || error.code === "HOST_DIALECT_UNAVAILABLE"
        ? 4406
        : 1013;
    return {
      accepted: false,
      error,
      actions: [{
        kind: "route_unavailable",
        connectionId: route.connectionId,
        hostId: route.authContext.hostId,
        closeCode,
        error,
      }],
    };
  }

  private routeDataFromHost(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const route = this.currentRouteForFrame(carrier, frame);
    if (!route || route.status !== "opened" || frame.direction !== "host_to_client") {
      return this.protocolViolation(carrier, "stale_route_data");
    }
    const seq = BigInt(frame.seq as string);
    if (seq !== route.expectedHostToClientSeq) {
      return this.protocolViolation(carrier, "non_contiguous_route_sequence");
    }
    const payload = frame.payload as RelayV2JsonObject;
    const bytes = Buffer.from(payload.data as string, "base64");
    let publicFrame: RelayV2JsonObject;
    try {
      publicFrame = decodeRelayV2WebSocketFrame("public", bytes).frame;
    } catch {
      return this.protocolViolation(carrier, "invalid_public_envelope");
    }
    if (
      bytes.byteLength > route.maxFrameBytes
      || !this.isHostPublicFrameAuthorized(carrier, route, publicFrame)
    ) {
      return this.protocolViolation(carrier, "forged_public_identity");
    }
    const client = this.clients.get(route.connectionId);
    if (!client) return this.protocolViolation(carrier, "route_client_missing");
    const responseRequestId = publicFrame.kind === "response"
      ? publicFrame.requestId as string
      : null;
    if (responseRequestId !== null && !route.inFlightRequestIds.has(responseRequestId)) {
      return this.protocolViolation(carrier, "uncorrelated_public_response");
    }
    if (
      route.hostToClientFrames + 1 > RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || route.hostToClientBufferedBytes + bytes.byteLength
        > RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || this.carrierBufferedBytes(carrier) + bytes.byteLength
        > RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - CARRIER_CONTROL_RESERVE_BYTES
    ) {
      const error = structuredError("SLOW_CONSUMER", "Client route cannot drain", true, 1_000);
      const actions = this.markHostPressure(route);
      return { accepted: false, error, actions };
    }
    route.expectedHostToClientSeq += 1n;
    route.hostToClientFrames += 1;
    route.hostToClientBufferedBytes += bytes.byteLength;
    carrier.hostToClientBufferedBytes += bytes.byteLength;
    client.queue.push({ bytes, route });
    if (responseRequestId !== null) route.inFlightRequestIds.delete(responseRequestId);
    const actions = this.hostToClientAtHighWater(carrier, route)
      ? this.markHostPressure(route)
      : [];
    return { accepted: true, actions };
  }

  private routeUnbound(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const route = this.currentRouteForFrame(carrier, frame);
    if (!route || route.status !== "closing") return this.protocolViolation(carrier, "stale_route_unbound");
    const payload = frame.payload as RelayV2JsonObject;
    if (
      payload.lastClientToHostSeq !== lastDispatchedClientSeq(route)
      || payload.lastHostToClientSeq !== lastAcceptedHostSeq(route)
    ) {
      return this.protocolViolation(carrier, "route_unbound_watermark_mismatch");
    }
    this.dropRoute(route);
    return { accepted: true, actions: [] };
  }

  private routeClosedByHost(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const route = this.currentRouteForFrame(carrier, frame);
    if (!route || route.status !== "opened") return this.protocolViolation(carrier, "stale_route_close");
    const payload = frame.payload as RelayV2JsonObject;
    const reason = payload.reason === "slow_consumer"
      ? "slow_consumer"
      : payload.reason === "host_shutdown"
        ? "broker_shutdown"
        : "protocol_error";
    const actions = this.beginRouteUnbind(route, reason);
    actions.push({
      kind: "close_client",
      connectionId: route.connectionId,
      closeCode: payload.closeCode as 1013 | 4400,
      reason: payload.reason as string,
    });
    return { accepted: true, actions };
  }

  private async handleAuthControl(
    carrier: CarrierState,
    frame: RelayV2JsonObject,
    type: "host.reauthenticate" | "enrollment.create" | "grant.revoke",
  ): Promise<RelayV2BrokerResult> {
    const requestId = frame.requestId as string;
    const connectorId = carrier.connectorId!;
    if (!this.authControlAuthority) {
      const error = structuredError(
        "CAPABILITY_UNAVAILABLE",
        "Persistent carrier auth-control authority is not configured",
      );
      return {
        accepted: false,
        error,
        actions: this.enqueueAuthControlResponse(
          carrier,
          this.carrierErrorFrame(requestId, connectorId, type, error),
        ),
      };
    }
    const payload = cloneFrame(frame.payload as RelayV2JsonObject);
    const request: RelayV2AuthControlRequest = type === "host.reauthenticate"
      ? {
          type,
          requestId,
          connectorId,
          accessToken: payload.accessToken as string,
          currentAuthContext: Object.freeze({ ...carrier.authContext }),
        }
      : {
          type,
          requestId,
          connectorId,
          payload,
          currentAuthContext: Object.freeze({ ...carrier.authContext }),
    };
    try {
      const decision = await this.authControlAuthority.handle(request);
      if (
        this.carriers.get(carrier.transportId) !== carrier
        || carrier.status !== "active"
        || carrier.connectorId !== connectorId
      ) {
        return this.failure("HOST_SUPERSEDED", "Carrier changed during auth control");
      }
      if (decision.outcome === "reject") {
        return {
          accepted: false,
          error: decision.error,
          actions: this.enqueueAuthControlResponse(
            carrier,
            this.carrierErrorFrame(requestId, connectorId, type, decision.error),
          ),
        };
      }
      const expectedResponseType = type === "host.reauthenticate"
        ? "host.reauthenticated"
        : type === "enrollment.create"
          ? "enrollment.created"
          : "grant.revoked";
      const response = this.checkedCarrierFrame(decision.response);
      if (
        response.type !== expectedResponseType
        || response.requestId !== requestId
        || response.connectorId !== connectorId
      ) {
        throw new Error("invalid auth-control authority response");
      }
      if (type === "host.reauthenticate") {
        const next = decision.nextAuthContext;
        const responsePayload = response.payload as RelayV2JsonObject;
        if (
          !next
          || next.scheme !== "twcap2"
          || next.role !== "host"
          || next.clientInstanceId !== null
          || next.hostId !== carrier.authContext.hostId
          || next.principalId !== carrier.authContext.principalId
          || next.grantId !== carrier.authContext.grantId
          || responsePayload.grantId !== next.grantId
          || responsePayload.jti !== next.jti
          || responsePayload.expiresAtMs !== next.expiresAtMs
          || (!decision.replayed && next.jti === carrier.authContext.jti)
          || (!decision.replayed
            && carrier.authContext.jti !== request.currentAuthContext.jti)
          || (decision.replayed
            && carrier.authContext.jti !== request.currentAuthContext.jti
            && carrier.authContext.jti !== next.jti)
        ) {
          throw new Error("invalid replacement host auth context");
        }
        // This is the only auth-context mutation point. Authority rejection or
        // invalid ACK above leaves the previous context intact until its exp.
        carrier.authContext = Object.freeze({ ...next });
      } else if (decision.nextAuthContext !== undefined) {
        throw new Error("unexpected auth context replacement");
      }
      return {
        accepted: true,
        actions: this.enqueueAuthControlResponse(carrier, response),
      };
    } catch {
      const error = structuredError(
        "INTERNAL",
        "Carrier auth-control authority failed",
        true,
        1_000,
      );
      return {
        accepted: false,
        error,
        actions: this.enqueueAuthControlResponse(
          carrier,
          this.carrierErrorFrame(requestId, connectorId, type, error),
        ),
      };
    }
  }

  private isClientPublicFrameAuthorized(
    route: RouteState,
    frame: RelayV2JsonObject,
  ): boolean {
    if (!CLIENT_TO_HOST_PUBLIC_TYPES.has(frame.type as string)) return false;
    if (Object.hasOwn(frame, "hostId") && frame.hostId !== route.authContext.hostId) return false;
    const carrier = this.carriers.get(route.carrierTransportId);
    if (!carrier?.hello) return false;
    if (
      Object.hasOwn(frame, "expectedHostEpoch")
      && frame.expectedHostEpoch !== carrier.hello.hostEpoch
    ) return false;
    if (frame.type === "client.hello") {
      const payload = frame.payload as RelayV2JsonObject;
      if (payload.clientInstanceId !== route.authContext.clientInstanceId) return false;
    }
    return true;
  }

  private isHostPublicFrameAuthorized(
    carrier: CarrierState,
    route: RouteState,
    frame: RelayV2JsonObject,
  ): boolean {
    if (!HOST_TO_CLIENT_PUBLIC_TYPES.has(frame.type as string) || !carrier.hello) return false;
    if (Object.hasOwn(frame, "hostId") && frame.hostId !== route.authContext.hostId) return false;
    if (Object.hasOwn(frame, "hostEpoch") && frame.hostEpoch !== carrier.hello.hostEpoch) return false;
    if (
      Object.hasOwn(frame, "hostInstanceId")
      && frame.hostInstanceId !== carrier.hello.hostInstanceId
    ) return false;
    return true;
  }

  private currentRouteForFrame(
    carrier: CarrierState,
    frame: RelayV2JsonObject,
  ): RouteState | undefined {
    const route = this.routes.get(frame.routeId as string);
    if (
      !route
      || route.carrierTransportId !== carrier.transportId
      || route.connectorId !== carrier.connectorId
      || route.routeFence !== frame.routeFence
    ) {
      return undefined;
    }
    return route;
  }

  private beginRouteUnbind(
    route: RouteState,
    reason:
      | "client_closed"
      | "client_replaced"
      | "auth_expired"
      | "auth_revoked"
      | "slow_consumer"
      | "protocol_error"
      | "broker_shutdown",
  ): RelayV2BrokerAction[] {
    if (route.status === "closed" || route.status === "closing") return [];
    const carrier = this.carriers.get(route.carrierTransportId);
    if (!carrier || carrier.status !== "active" || carrier.connectorId !== route.connectorId) {
      this.dropRoute(route);
      return [];
    }
    this.discardQueuedRouteData(carrier, route);
    this.discardQueuedClientData(route);
    route.status = "closing";
    const frame = {
      carrierVersion: 1,
      type: "route.unbind",
      connectorId: route.connectorId,
      routeId: route.routeId,
      routeFence: route.routeFence,
      payload: {
        reason,
        lastClientToHostSeq: lastDispatchedClientSeq(route),
      },
    } satisfies RelayV2JsonObject;
    if (!this.enqueueCarrierControl(carrier, frame, route)) {
      return [{
        kind: "close_host",
        transportId: carrier.transportId,
        closeCode: 1013,
        reason: "carrier_control_backpressure",
      }];
    }
    return [];
  }

  private carrierBufferedBytes(carrier: CarrierState): number {
    return carrier.queuedBytes + carrier.inFlightBytes + carrier.hostToClientBufferedBytes;
  }

  private clientToHostAtHighWater(carrier: CarrierState, route: RouteState): boolean {
    return route.clientToHostFrames >= RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || route.clientToHostBufferedBytes
        >= RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || this.carrierBufferedBytes(carrier)
        >= RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - CARRIER_CONTROL_RESERVE_BYTES;
  }

  private hostToClientAtHighWater(carrier: CarrierState, route: RouteState): boolean {
    return route.hostToClientFrames >= RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || route.hostToClientBufferedBytes
        >= RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || this.carrierBufferedBytes(carrier)
        >= RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - CARRIER_CONTROL_RESERVE_BYTES;
  }

  private markClientPressure(route: RouteState): RelayV2BrokerAction[] {
    if (route.clientToHostPressureSinceMs === null) {
      route.clientToHostPressureSinceMs = this.now();
    }
    if (route.clientReadPaused) return [];
    route.clientReadPaused = true;
    return [{ kind: "pause_client", connectionId: route.connectionId }];
  }

  private markHostPressure(route: RouteState): RelayV2BrokerAction[] {
    if (route.hostToClientPressureSinceMs === null) {
      route.hostToClientPressureSinceMs = this.now();
    }
    if (route.hostReadPaused) return [];
    route.hostReadPaused = true;
    return [{
      kind: "pause_host_route",
      transportId: route.carrierTransportId,
      routeId: route.routeId,
    }];
  }

  private maybeResumeClientPressure(
    carrier: CarrierState,
    route: RouteState,
  ): RelayV2BrokerAction[] {
    if (
      route.status !== "opened"
      || !route.clientReadPaused
      || route.clientToHostBufferedBytes
        >= RELAY_V2_BROKER_LIMITS.routeLowWaterBytesPerDirection
      || route.clientToHostFrames
        >= RELAY_V2_BROKER_LIMITS.routeLowWaterFramesPerDirection
      || this.carrierBufferedBytes(carrier) >= RELAY_V2_BROKER_LIMITS.carrierLowWaterBytes
    ) return [];
    route.clientReadPaused = false;
    route.clientToHostPressureSinceMs = null;
    return [{ kind: "resume_client", connectionId: route.connectionId }];
  }

  private maybeResumeHostPressure(route: RouteState): RelayV2BrokerAction[] {
    const carrier = this.carriers.get(route.carrierTransportId);
    if (
      route.status !== "opened"
      || !route.hostReadPaused
      || !carrier
      || route.hostToClientBufferedBytes
        >= RELAY_V2_BROKER_LIMITS.routeLowWaterBytesPerDirection
      || route.hostToClientFrames
        >= RELAY_V2_BROKER_LIMITS.routeLowWaterFramesPerDirection
      || this.carrierBufferedBytes(carrier) >= RELAY_V2_BROKER_LIMITS.carrierLowWaterBytes
    ) return [];
    route.hostReadPaused = false;
    route.hostToClientPressureSinceMs = null;
    return [{
      kind: "resume_host_route",
      transportId: route.carrierTransportId,
      routeId: route.routeId,
    }];
  }

  private collectCarrierResumes(carrier: CarrierState): RelayV2BrokerAction[] {
    const actions: RelayV2BrokerAction[] = [];
    for (const route of this.routes.values()) {
      if (route.carrierTransportId !== carrier.transportId) continue;
      actions.push(...this.maybeResumeClientPressure(carrier, route));
      actions.push(...this.maybeResumeHostPressure(route));
    }
    return actions;
  }

  private enqueueCarrierControl(
    carrier: CarrierState,
    frame: RelayV2JsonObject,
    route: RouteState | null,
  ): boolean {
    const entry = carrierFrame(frame);
    entry.route = route;
    if (
      this.carrierBufferedBytes(carrier) + entry.wireBytes
      > RELAY_V2_BROKER_LIMITS.carrierBufferedBytes
    ) return false;
    carrier.controlQueue.push(entry);
    carrier.queuedBytes += entry.wireBytes;
    return true;
  }

  private enqueueCarrierData(
    carrier: CarrierState,
    route: RouteState,
    frame: RelayV2JsonObject,
    rawBytes: number,
    routeSeq: bigint,
  ): boolean {
    const wire = encodeCarrier(frame);
    if (
      route.clientToHostFrames + 1 > RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || route.clientToHostBufferedBytes + rawBytes
        > RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || this.carrierBufferedBytes(carrier) + wire.byteLength
        > RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - CARRIER_CONTROL_RESERVE_BYTES
    ) return false;
    const entry: QueuedCarrierFrame = {
      frame: cloneFrame(frame),
      wire,
      wireBytes: wire.byteLength,
      route,
      rawBytes,
      routeSeq,
    };
    let queue = carrier.dataQueues.get(route.routeId);
    if (!queue) {
      queue = [];
      carrier.dataQueues.set(route.routeId, queue);
      carrier.dataOrder.push(route.routeId);
    }
    queue.push(entry);
    carrier.queuedBytes += wire.byteLength;
    route.clientToHostBufferedBytes += rawBytes;
    route.clientToHostFrames += 1;
    return true;
  }

  private discardQueuedRouteData(carrier: CarrierState, route: RouteState): void {
    const queue = carrier.dataQueues.get(route.routeId);
    if (!queue) return;
    for (const entry of queue) {
      carrier.queuedBytes -= entry.wireBytes;
      route.clientToHostBufferedBytes -= entry.rawBytes;
      route.clientToHostFrames -= 1;
    }
    carrier.dataQueues.delete(route.routeId);
    const index = carrier.dataOrder.indexOf(route.routeId);
    if (index >= 0) {
      carrier.dataOrder.splice(index, 1);
      if (carrier.dataCursor > index) carrier.dataCursor -= 1;
      if (carrier.dataCursor >= carrier.dataOrder.length) carrier.dataCursor = 0;
    }
  }

  private dropRoute(route: RouteState): void {
    if (route.status === "closed") return;
    const carrier = this.carriers.get(route.carrierTransportId);
    if (carrier) this.discardQueuedRouteData(carrier, route);
    const client = this.clients.get(route.connectionId);
    if (client) {
      for (const entry of client.queue) this.releaseHostToClientBytes(route, entry.bytes.byteLength);
      client.queue = [];
      for (const delivery of client.inFlight.values()) {
        this.releaseHostToClientBytes(route, delivery.bytes.byteLength);
      }
      client.inFlight.clear();
      this.clients.delete(route.connectionId);
    }
    route.status = "closed";
    this.routes.delete(route.routeId);
  }

  private discardQueuedClientData(route: RouteState): void {
    const client = this.clients.get(route.connectionId);
    if (!client) return;
    for (const entry of client.queue) this.releaseHostToClientBytes(route, entry.bytes.byteLength);
    client.queue = [];
  }

  private releaseHostToClientBytes(route: RouteState, bytes: number): void {
    route.hostToClientBufferedBytes = Math.max(0, route.hostToClientBufferedBytes - bytes);
    route.hostToClientFrames = Math.max(0, route.hostToClientFrames - 1);
    const carrier = this.carriers.get(route.carrierTransportId);
    if (carrier) {
      carrier.hostToClientBufferedBytes = Math.max(0, carrier.hostToClientBufferedBytes - bytes);
    }
  }

  private invalidateConnectorRoutes(
    carrier: CarrierState,
    actions: RelayV2BrokerAction[],
    superseded: boolean,
  ): void {
    for (const route of [...this.routes.values()]) {
      if (route.carrierTransportId !== carrier.transportId) continue;
      if (route.status === "opening") {
        actions.push({
          kind: "route_unavailable",
          connectionId: route.connectionId,
          hostId: route.authContext.hostId,
          closeCode: 1013,
          error: structuredError(
            "HOST_OFFLINE",
            "Host became unavailable before route opened",
            true,
            1_000,
            "not_accepted",
          ),
        });
      } else {
        actions.push({
          kind: "close_client",
          connectionId: route.connectionId,
          closeCode: 1013,
          reason: superseded ? "host_superseded" : "host_offline",
        });
      }
      this.dropRoute(route);
    }
  }

  private discardCarrier(carrier: CarrierState): void {
    carrier.controlQueue = [];
    carrier.dataQueues.clear();
    carrier.dataOrder = [];
    carrier.dataCursor = 0;
    carrier.queuedBytes = 0;
    for (const delivery of carrier.inFlight.values()) {
      if (delivery.route && delivery.routeSeq !== null) {
        delivery.route.clientToHostBufferedBytes = Math.max(
          0,
          delivery.route.clientToHostBufferedBytes - delivery.rawBytes,
        );
        delivery.route.clientToHostFrames = Math.max(0, delivery.route.clientToHostFrames - 1);
      }
    }
    carrier.inFlight.clear();
    carrier.inFlightBytes = 0;
    carrier.hostToClientBufferedBytes = 0;
  }

  private cancelRegistration(carrier: CarrierState): void {
    if (this.registeringCarriers.get(carrier.authContext.hostId) === carrier) {
      this.registeringCarriers.delete(carrier.authContext.hostId);
    }
    carrier.registration = null;
    carrier.status = "closed";
    this.discardCarrier(carrier);
    this.carriers.delete(carrier.transportId);
  }

  private publishDirectory(carrier: CarrierState, state: "online" | "offline"): string {
    const previous = this.directory.get(carrier.authContext.hostId);
    const revision = (previous?.revision ?? 0n) + 1n;
    const hello = carrier.hello;
    this.directory.set(carrier.authContext.hostId, {
      hostId: carrier.authContext.hostId,
      state,
      revision,
      hostEpoch: hello?.hostEpoch ?? previous?.hostEpoch ?? null,
      hostInstanceId: hello?.hostInstanceId ?? previous?.hostInstanceId ?? null,
      connectorId: state === "online" ? carrier.connectorId : null,
      clientDialects: hello ? [...hello.clientDialects] : [...previous?.clientDialects ?? []],
      capabilities: hello ? [...hello.capabilities] : [...previous?.capabilities ?? []],
      observedAtMs: this.now(),
    });
    return revision.toString(10);
  }

  private carrierErrorAction(
    transportId: string,
    requestId: string,
    connectorId: string | null,
    failedType: "host.hello" | "host.reauthenticate" | "enrollment.create" | "grant.revoke",
    error: RelayV2StructuredError,
  ): RelayV2BrokerAction {
    return {
      kind: "send_host",
      transportId,
      frame: this.carrierErrorFrame(requestId, connectorId, failedType, error),
    };
  }

  private carrierErrorFrame(
    requestId: string,
    connectorId: string | null,
    failedType: "host.hello" | "host.reauthenticate" | "enrollment.create" | "grant.revoke",
    error: RelayV2StructuredError,
  ): RelayV2JsonObject {
    return this.checkedCarrierFrame({
      carrierVersion: 1,
      type: "carrier.error",
      requestId,
      connectorId,
      payload: { failedType },
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        retryAfterMs: error.retryAfterMs,
        commandDisposition: error.commandDisposition,
        details: error.details,
      },
    });
  }

  private enqueueAuthControlResponse(
    carrier: CarrierState,
    frame: RelayV2JsonObject,
  ): RelayV2BrokerAction[] {
    if (this.enqueueCarrierControl(carrier, frame, null)) return [];
    return [{
      kind: "close_host",
      transportId: carrier.transportId,
      closeCode: 1013,
      reason: "carrier_control_backpressure",
    }];
  }

  private checkedCarrierFrame(frame: RelayV2JsonObject): RelayV2JsonObject {
    encodeCarrier(frame);
    return cloneFrame(frame);
  }

  private protocolViolation(carrier: CarrierState, reason: string): RelayV2BrokerResult {
    const actions: RelayV2BrokerAction[] = [{
      kind: "close_host",
      transportId: carrier.transportId,
      closeCode: 4400,
      reason,
    }];
    if (
      carrier.status === "active"
      && this.activeCarriers.get(carrier.authContext.hostId) === carrier
    ) {
      this.activeCarriers.delete(carrier.authContext.hostId);
      this.publishDirectory(carrier, "offline");
      this.invalidateConnectorRoutes(carrier, actions, false);
    }
    if (carrier.status === "registering") {
      this.registeringCarriers.delete(carrier.authContext.hostId);
      carrier.registration = null;
    }
    carrier.status = "closed";
    this.discardCarrier(carrier);
    this.carriers.delete(carrier.transportId);
    return this.failure("INVALID_ENVELOPE", "Carrier protocol violation", actions);
  }

  private failure(
    code: RelayV2StructuredError["code"],
    message: string,
    actions: RelayV2BrokerAction[] = [],
  ): RelayV2BrokerResult {
    const error = structuredError(code, message);
    return { accepted: false, error, actions };
  }

}
