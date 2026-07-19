import { randomBytes, randomUUID } from "node:crypto";
import type { RelayV2AuthContext } from "./auth.js";
import { RELAY_V2_CARRIER_ROUTE_HARD_LIMIT } from "./carrierLimits.js";
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
  maxRoutesPerCarrier: RELAY_V2_CARRIER_ROUTE_HARD_LIMIT,
  maxBackpressureSweepActionsPerCarrier: RELAY_V2_CARRIER_ROUTE_HARD_LIMIT * 2 + 1,
  maxBackpressureSweepMandatoryActionsPerCarrier: RELAY_V2_CARRIER_ROUTE_HARD_LIMIT + 1,
} as const);

const CARRIER_CONTROL_RESERVE_BYTES = 65_536;
const BACKPRESSURE_CLOSE_MS = 5_000;
const MAX_COMMITTED_LIVE_AUTHORIZATION_INVALIDATIONS = 8_192;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION_AUTHORIZATION_KEYS = Object.freeze([
  "scheme",
  "role",
  "hostId",
  "principalId",
  "grantId",
  "clientInstanceId",
  "jti",
  "kid",
  "expiresAtMs",
  "authorizationRevision",
  "authorizationFence",
] as const);

const CLIENT_TO_HOST_PUBLIC_TYPES = new Set([
  "hosts.snapshot.get",
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

type RelayV2PresenceReason = "connected" | "reconnected" | "superseded" | "disconnected";

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
  ): RelayV2BrokerConnectionAuthorization | Promise<RelayV2BrokerConnectionAuthorization>;
}

/**
 * Internal authorization captured from the durable credential authority.
 * The revision/fence never enters public or carrier frames.
 */
export interface RelayV2BrokerConnectionAuthorization extends RelayV2AuthContext {
  authorizationRevision: string;
  authorizationFence: string;
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
      authContext: RelayV2BrokerConnectionAuthorization;
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
    | "GRANT_NOT_FOUND"
    | "HOST_DIALECT_UNAVAILABLE"
    | "HOST_OFFLINE"
    | "HOST_SUPERSEDED"
    | "IDEMPOTENCY_CONFLICT"
    | "INTERNAL"
    | "INVALID_ENVELOPE"
    | "PERMISSION_DENIED"
    | "ROLE_MISMATCH"
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
      /**
       * Internal producer wake only. B7c still has to bind the exact
       * generation target to the carrier Pump; this is never a wire frame.
       */
      kind: "host_output_ready";
      transportId: string;
      connectionIncarnation: string;
      readyEpoch: string;
    }
  | {
      kind: "send_host";
      transportId: string;
      /** Exact carrier incarnation; only an exact source-self missing-carrier close may omit it. */
      connectionIncarnation?: string;
      frame: RelayV2JsonObject;
      /** Present when adapter acceptance is an explicit broker commit fence. */
      deliveryId?: string;
    }
  | {
      kind: "close_host";
      transportId: string;
      connectionIncarnation?: string;
      closeCode: 1013 | 4400 | 4401 | 4403 | 4409 | 4411;
      reason: string;
    }
  | {
      kind: "route_opened";
      connectionId: string;
      connectionIncarnation: string;
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
      connectionIncarnation: string;
      hostId: string;
      closeCode: 1013 | 4401 | 4403 | 4406;
      error: RelayV2StructuredError;
    }
  | {
      kind: "close_client";
      connectionId: string;
      connectionIncarnation: string;
      closeCode: number;
      reason: string;
    }
  | {
      kind: "pause_client" | "resume_client";
      connectionId: string;
      connectionIncarnation: string;
    }
  | {
      kind: "pause_host_route" | "resume_host_route";
      transportId: string;
      connectionIncarnation?: string;
      routeId: string;
    };

export type RelayV2AuthControlRequest =
  | {
      type: "host.reauthenticate";
      requestId: string;
      connectorId: string;
      accessToken: string;
      currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>;
    }
  | {
      type: "enrollment.create" | "grant.revoke";
      requestId: string;
      connectorId: string;
      payload: RelayV2JsonObject;
      currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>;
    };

export type RelayV2AuthControlDecision =
  | {
      outcome: "success";
      /** Persisted first/replay carrier ACK owned by the authority. */
      response: RelayV2JsonObject;
      /** True only when response came from the authority's persisted replay record. */
      replayed: boolean;
      /** Required only for a successful host.reauthenticate. */
      nextAuthContext?: RelayV2BrokerConnectionAuthorization;
    }
  | {
      outcome: "reject";
      error: RelayV2StructuredError;
    };

/**
 * Persistent authority boundary for carrier auth controls. Implementations
 * own transactionality, request replay records, credential writes and
 * revocation/enrollment state. Handoff starts an authority-owned transaction
 * that may complete after its carrier closes; it is intentionally not given a
 * carrier AbortSignal. Carrier cancellation only fences Broker application of
 * the eventual decision. The broker commits a replacement host auth context
 * only after a valid host.reauthenticated ACK is available on the same carrier.
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
   * later low-water acknowledgement or terminal route transition may emit
   * its matching resume.
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

export type RelayV2BrokerOutputReadyFence = Readonly<
  | {
      kind: "host";
      transportId: string;
      connectionIncarnation: string;
      readyEpoch: string;
    }
  | {
      kind: "client";
      connectionId: string;
      connectionIncarnation: string;
      readyEpoch: string;
    }
>;

/**
 * Synchronous edge sink. Implementations may only coalesce/schedule the
 * opaque fence; they must not reenter BrokerCore from this callback.
 */
export interface RelayV2BrokerOutputReadyPort {
  ready(fence: RelayV2BrokerOutputReadyFence): void;
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

export type RelayV2LiveAuthorizationInvalidation =
  | {
      reason: "access_expired";
      role: RelayBrokerRole;
      hostId: string;
      jti: string;
    }
  | {
      reason: "grant_revoked";
      role: RelayBrokerRole;
      hostId: string;
      grantId: string;
    }
  | {
      reason: "kid_removed";
      role?: RelayBrokerRole;
      hostId?: string;
      kid: string;
    };

export interface RelayV2LiveAuthorizationCommitReceipt {
  authorizationRevision: string;
  authorizationFence: string;
}

export type RelayV2LiveAuthorizationCloseReason =
  | RelayV2LiveAuthorizationInvalidation["reason"]
  | "credential_authority_unavailable"
  | "host_authorization_fenced";

export type RelayV2LiveAuthorizationCloseSignal =
  | {
      connectionKind: "client";
      connectionId: string;
      /** Async close owners must exact-match this connection incarnation. */
      connectionIncarnation: string;
      reason: RelayV2LiveAuthorizationCloseReason;
      authorization: Readonly<RelayV2BrokerConnectionAuthorization>;
    }
  | {
      connectionKind: "host";
      transportId: string;
      /** Async close owners must exact-match this connection incarnation. */
      connectionIncarnation: string;
      reason: RelayV2LiveAuthorizationCloseReason;
      authorization: Readonly<RelayV2BrokerConnectionAuthorization>;
    };

export interface RelayV2LiveAuthorizationCommitBarrier {
  committed(receipt: RelayV2LiveAuthorizationCommitReceipt): void;
  cancelled(): void;
  failClosed(): void;
}

/**
 * Narrow composition seam from the credential fact owner into the broker's
 * active-connection admission/fence owner.
 */
export interface RelayV2LiveAuthorizationFencePort {
  begin(
    invalidation: RelayV2LiveAuthorizationInvalidation,
  ): RelayV2LiveAuthorizationCommitBarrier;
  /**
   * Synchronously withdraw every active broker admission/dispatch gate after
   * the credential fact owner loses authority. Close policy remains owned by
   * the injected connection owner.
   */
  failClosed(): void;
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
      status: 401 | 403 | 426 | 503;
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
  connectionIncarnation: string;
  outputReadyEpoch: bigint;
  authContext: RelayV2BrokerConnectionAuthorization;
  authorizationState: "active" | "fenced";
  authorizationCloseSignalled: boolean;
  authorizationCleanupState: "idle" | "applying" | "complete";
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
  routeIds: Set<string>;
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
  connectionIncarnation: string;
  outputReadyEpoch: bigint;
  authContext: RelayV2BrokerConnectionAuthorization;
  authorizationState: "active" | "fenced";
  authorizationCloseSignalled: boolean;
  authorizationCleanupState: "idle" | "applying" | "complete";
  routeId: string;
  queue: QueuedClientFrame[];
  inFlight: Map<string, InFlightClientFrame>;
};

type RouteState = {
  connectionId: string;
  connectionIncarnation: string;
  routeId: string;
  routeFence: string;
  openRequestId: string;
  connectorId: string;
  carrierTransportId: string;
  carrierConnectionIncarnation: string;
  authContext: RelayV2BrokerConnectionAuthorization;
  status: "opening" | "opened" | "closing" | "closed";
  firstApplicationFrame: "pending" | "welcome" | "unavailable";
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

type PendingLiveAuthorizationInvalidation = {
  invalidation: RelayV2LiveAuthorizationInvalidation;
  settled: boolean;
};

type CommittedLiveAuthorizationInvalidation = {
  invalidation: RelayV2LiveAuthorizationInvalidation;
  receipt: RelayV2LiveAuthorizationCommitReceipt;
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
  presenceReason: RelayV2PresenceReason;
  previousHostInstanceId: string | null;
};

const BROKER_OUTPUT_READY_FENCES = new WeakMap<object, () => boolean>();

/** Runtime provenance + current-owner check for an opaque ready capability. */
export function relayV2BrokerOutputReadyMayDrain(
  fence: unknown,
): fence is RelayV2BrokerOutputReadyFence {
  if (fence === null || typeof fence !== "object") return false;
  const current = BROKER_OUTPUT_READY_FENCES.get(fence);
  if (!current) return false;
  try {
    return current() === true;
  } catch {
    return false;
  }
}

function brokerOutputReadyFence(
  value: RelayV2BrokerOutputReadyFence,
  current: () => boolean,
): RelayV2BrokerOutputReadyFence {
  const fence = Object.freeze(value);
  BROKER_OUTPUT_READY_FENCES.set(fence, current);
  return fence;
}

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
      const verified = await dependencies.verifyV2AccessToken(credential, role);
      const authContext = cloneClosedConnectionAuthorization(verified);
      if (
        !authContext
        || authContext.role !== role
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

function readOwnDataRecord(source: unknown): {
  keys: string[];
  values: Record<string, unknown>;
} | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.some((key) => typeof key !== "string")) return undefined;
  const keys = ownKeys as string[];
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    values[key] = descriptor.value;
  }
  return { keys, values };
}

function cloneClosedConnectionAuthorization(
  source: unknown,
): RelayV2BrokerConnectionAuthorization | undefined {
  try {
    const own = readOwnDataRecord(source);
    if (!own) return undefined;
    const { keys, values: input } = own;
    if (
      keys.length !== CONNECTION_AUTHORIZATION_KEYS.length
      || keys.some((key) => (
        !CONNECTION_AUTHORIZATION_KEYS.includes(
          key as (typeof CONNECTION_AUTHORIZATION_KEYS)[number],
        )
      ))
    ) return undefined;
    const snapshot = {
      scheme: input.scheme,
      role: input.role,
      hostId: input.hostId,
      principalId: input.principalId,
      grantId: input.grantId,
      clientInstanceId: input.clientInstanceId,
      jti: input.jti,
      kid: input.kid,
      expiresAtMs: input.expiresAtMs,
      authorizationRevision: input.authorizationRevision,
      authorizationFence: input.authorizationFence,
    };
    if (
      snapshot.scheme !== "twcap2"
      || (snapshot.role !== "client" && snapshot.role !== "host")
      || !isIdentifier(snapshot.hostId)
      || !isIdentifier(snapshot.principalId)
      || !isIdentifier(snapshot.grantId)
      || !isIdentifier(snapshot.jti)
      || !isIdentifier(snapshot.kid)
      || !isIdentifier(snapshot.authorizationFence)
      || !Number.isSafeInteger(snapshot.expiresAtMs)
      || (snapshot.expiresAtMs as number) < 0
      || typeof snapshot.authorizationRevision !== "string"
      || !/^(0|[1-9][0-9]*)$/.test(snapshot.authorizationRevision)
      || BigInt(snapshot.authorizationRevision) > MAX_UINT64
      || (snapshot.role === "client"
        ? !isIdentifier(snapshot.clientInstanceId)
        : snapshot.clientInstanceId !== null)
    ) return undefined;
    return Object.freeze(snapshot as RelayV2BrokerConnectionAuthorization);
  } catch {
    return undefined;
  }
}

function cloneClosedAuthorizationReceipt(
  source: unknown,
): RelayV2LiveAuthorizationCommitReceipt | undefined {
  try {
    const own = readOwnDataRecord(source);
    if (!own) return undefined;
    const { keys, values: input } = own;
    if (
      keys.length !== 2
      || !keys.every((key) => key === "authorizationRevision" || key === "authorizationFence")
    ) return undefined;
    const authorizationRevision = input.authorizationRevision;
    const authorizationFence = input.authorizationFence;
    if (
      typeof authorizationRevision !== "string"
      || !/^(0|[1-9][0-9]*)$/.test(authorizationRevision)
      || BigInt(authorizationRevision) > MAX_UINT64
      || !isIdentifier(authorizationFence)
    ) return undefined;
    return Object.freeze({ authorizationRevision, authorizationFence });
  } catch {
    return undefined;
  }
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

function completeBaseReadiness(hello: HostHello): string[] {
  if (
    !hello.clientDialects.includes("tw-relay.v2")
    || !RELAY_V2_REQUIRED_CAPABILITIES.every((capability) => (
      hello.capabilities.includes(capability)
    ))
  ) return [];
  // The frozen base set is an atomic readiness result. Arbitrary values from
  // host.hello are never copied into a broker-produced welcome or directory
  // capability view.
  return [...RELAY_V2_REQUIRED_CAPABILITIES];
}

export class RelayV2BrokerCore {
  readonly brokerEpoch: string;

  private readonly carriers = new Map<string, CarrierState>();
  private readonly activeCarriers = new Map<string, CarrierState>();
  private readonly registeringCarriers = new Map<string, CarrierState>();
  private readonly directory = new Map<string, DirectoryRecord>();
  private readonly routes = new Map<string, RouteState>();
  private readonly clients = new Map<string, ClientState>();
  private readonly pendingLiveAuthorizationInvalidations:
    PendingLiveAuthorizationInvalidation[] = [];
  private readonly committedLiveAuthorizationInvalidations:
    CommittedLiveAuthorizationInvalidation[] = [];
  private liveAuthCompositionLatched = false;
  private outputReadyCompositionLatched = false;
  private liveAuthGlobalFenceApplying = false;
  private liveAuthGlobalFenceApplied = false;
  private authorizationHighWater: RelayV2LiveAuthorizationCommitReceipt | null = null;
  private readonly now: () => number;
  private readonly authControlAuthority: RelayV2BrokerAuthControlAuthority | undefined;
  private readonly outputReadyPort: RelayV2BrokerOutputReadyPort | undefined;
  private readonly baseCapabilityReadiness: string[];
  private readonly onLiveAuthorizationClose:
    ((signal: RelayV2LiveAuthorizationCloseSignal) => void) | undefined;
  private readonly liveAuthorizationFencePortValue: RelayV2LiveAuthorizationFencePort;

  constructor(options: {
    brokerEpoch?: string;
    now?: () => number;
    authControlAuthority?: RelayV2BrokerAuthControlAuthority;
    outputReadyPort?: RelayV2BrokerOutputReadyPort;
    onLiveAuthorizationClose?: (signal: RelayV2LiveAuthorizationCloseSignal) => void;
    /**
     * Explicit complete base-v2 composition receipt. Omission keeps
     * advertisement disabled even when host.hello claims the base set.
     */
    baseCapabilityReadiness?: readonly string[];
  } = {}) {
    this.brokerEpoch = options.brokerEpoch ?? randomUUID();
    if (!isIdentifier(this.brokerEpoch)) throw new Error("invalid Relay v2 broker epoch");
    this.now = options.now ?? Date.now;
    this.authControlAuthority = options.authControlAuthority;
    this.outputReadyPort = options.outputReadyPort;
    this.onLiveAuthorizationClose = options.onLiveAuthorizationClose;
    this.liveAuthorizationFencePortValue = Object.freeze({
      begin: (invalidation: RelayV2LiveAuthorizationInvalidation) => (
        this.beginLiveAuthorizationInvalidation(invalidation)
      ),
      failClosed: () => {
        this.latchCredentialAuthorityUnavailable();
      },
    });
    this.baseCapabilityReadiness = RELAY_V2_REQUIRED_CAPABILITIES.every((capability) => (
      options.baseCapabilityReadiness?.includes(capability)
    ))
      ? [...RELAY_V2_REQUIRED_CAPABILITIES]
      : [];
  }

  /** Unwired credential-authority commit seam; it does not imply readiness. */
  get liveAuthorizationFencePort(): RelayV2LiveAuthorizationFencePort {
    return this.liveAuthorizationFencePortValue;
  }

  get outputReadyCompositionState(): "open" | "latched_fail_closed" {
    return this.outputReadyCompositionLatched ? "latched_fail_closed" : "open";
  }

  /** Attach only after dispatchRelayBrokerUpgrade accepted a role=host v2 Upgrade. */
  attachHostCarrier(
    transportId: string,
    authContext: RelayV2BrokerConnectionAuthorization,
    connectionIncarnation: string = randomUUID(),
  ): void {
    if (this.liveAuthCompositionLatched || this.outputReadyCompositionLatched) {
      throw new Error("Relay v2 Broker composition is latched fail-closed");
    }
    if (
      !isIdentifier(transportId)
      || !isIdentifier(connectionIncarnation)
      || this.carriers.has(transportId)
    ) {
      throw new Error("invalid or duplicate Relay v2 carrier transport ID");
    }
    const authorization = cloneClosedConnectionAuthorization(authContext);
    if (
      !authorization
      || authorization.role !== "host"
      || !this.admitNewConnectionAuthorization(authorization)
    ) {
      throw new Error("Relay v2 host carrier requires a verified host auth context");
    }
    this.carriers.set(transportId, {
      transportId,
      connectionIncarnation,
      outputReadyEpoch: 0n,
      authContext: authorization,
      authorizationState: "active",
      authorizationCloseSignalled: false,
      authorizationCleanupState: "idle",
      status: "pending",
      connectorId: null,
      hello: null,
      registration: null,
      controlQueue: [],
      dataQueues: new Map(),
      routeIds: new Set(),
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

  /**
   * Broker-authoritative, claim-scoped directory snapshot. Unknown and
   * unauthorized claims are deliberately indistinguishable and never fall
   * back to a global/empty directory view.
   */
  readHostsSnapshot(
    authContext: Readonly<RelayV2BrokerConnectionAuthorization>,
    requestId: string,
  ): RelayV2JsonObject | undefined {
    const authorization = cloneClosedConnectionAuthorization(authContext);
    if (!authorization || !this.isDirectoryClient(authorization) || !isIdentifier(requestId)) {
      return undefined;
    }
    const record = this.directory.get(authorization.hostId);
    if (!record) return undefined;
    const frame = {
      protocolVersion: 2,
      kind: "response",
      type: "hosts.snapshot",
      requestId,
      payload: {
        brokerEpoch: this.brokerEpoch,
        revision: record.revision.toString(10),
        items: [{
          hostId: record.hostId,
          state: record.state,
          hostEpoch: record.hostEpoch!,
          hostInstanceId: record.hostInstanceId!,
          clientDialects: [...record.clientDialects],
          capabilities: [...record.capabilities],
          observedAtMs: record.observedAtMs,
        }],
      },
    } satisfies RelayV2JsonObject;
    encodeRelayV2WebSocketFrame("public", frame);
    return cloneFrame(frame);
  }

  /** Latest claim-scoped presence transition for gap/revision recovery. */
  readHostPresence(
    authContext: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): RelayV2JsonObject | undefined {
    const authorization = cloneClosedConnectionAuthorization(authContext);
    if (!authorization || !this.isDirectoryClient(authorization)) return undefined;
    const record = this.directory.get(authorization.hostId);
    if (!record) return undefined;
    const frame = {
      protocolVersion: 2,
      kind: "event",
      type: "host.presence",
      hostId: record.hostId,
      payload: {
        brokerEpoch: this.brokerEpoch,
        revision: record.revision.toString(10),
        state: record.state,
        reason: record.presenceReason,
        hostEpoch: record.hostEpoch!,
        hostInstanceId: record.hostInstanceId!,
        previousHostInstanceId: record.previousHostInstanceId,
        observedAtMs: record.observedAtMs,
      },
    } satisfies RelayV2JsonObject;
    encodeRelayV2WebSocketFrame("public", frame);
    return cloneFrame(frame);
  }

  inspectClientAdmission(
    authContext: RelayV2BrokerConnectionAuthorization,
  ): RelayV2ClientAdmission {
    const authorization = cloneClosedConnectionAuthorization(authContext);
    if (
      !authorization
      || authorization.role !== "client"
    ) {
      return {
        outcome: "reject",
        status: 503,
        error: structuredError("PERMISSION_DENIED", "Client authorization is not valid"),
      };
    }
    return this.inspectClosedClientAdmission(authorization);
  }

  private inspectClosedClientAdmission(
    authorization: RelayV2BrokerConnectionAuthorization,
  ): RelayV2ClientAdmission {
    if (this.liveAuthCompositionLatched || this.outputReadyCompositionLatched) {
      return {
        outcome: "reject",
        status: 503,
        error: structuredError(
          "CAPABILITY_UNAVAILABLE",
          "Broker composition is latched fail-closed",
        ),
      };
    }
    const liveAuthFence = this.liveAuthorizationInvalidationFor(authorization);
    const authorizationExpired = this.isAuthorizationExpired(authorization);
    if (
      authorizationExpired
      || !this.observeAuthorizationHighWater(authorization)
      || liveAuthFence
    ) {
      return {
        outcome: "reject",
        status: authorizationExpired
          || liveAuthFence?.reason === "access_expired"
          ? 401
          : 403,
        error: structuredError("AUTH_INVALID", "Client authorization is fenced"),
      };
    }
    const carrier = this.activeCarriers.get(authorization.hostId);
    if (
      !carrier
      || carrier.status !== "active"
      || !carrier.hello
      || !carrier.connectorId
      || !this.isCarrierAuthorizationActive(carrier)
    ) {
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
      hostCapabilities: completeBaseReadiness(carrier.hello),
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

  /** Process-lifetime state; there is intentionally no in-place reset. */
  inspectLiveAuthCompositionLatch(): "open" | "latched_fail_closed" {
    return this.liveAuthCompositionLatched ? "latched_fail_closed" : "open";
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
    authContext: RelayV2BrokerConnectionAuthorization,
    connectionIncarnation = randomUUID(),
  ): RelayV2RouteOpenResult {
    if (
      !isIdentifier(connectionId)
      || !isIdentifier(connectionIncarnation)
      || this.clients.has(connectionId)
    ) {
      return this.failure("INVALID_ENVELOPE", "Client connection ID is invalid");
    }
    const authorization = cloneClosedConnectionAuthorization(authContext);
    if (!authorization || authorization.role !== "client") {
      return this.failure("PERMISSION_DENIED", "Client authorization is not valid");
    }
    const admission = this.inspectClosedClientAdmission(authorization);
    if (admission.outcome === "reject") {
      return {
        accepted: false,
        error: admission.error,
        actions: [{
          kind: "route_unavailable",
          connectionId,
          connectionIncarnation,
          hostId: authorization.hostId,
          closeCode: admission.status === 426
            ? 4406
            : admission.status === 401
              ? 4401
              : admission.status === 403
                ? 4403
                : 1013,
          error: admission.error,
        }],
      };
    }
    const carrier = this.activeCarriers.get(authorization.hostId);
    if (!carrier || !this.isCarrierAuthorizationActive(carrier)) {
      const error = structuredError(
        "HOST_OFFLINE",
        "Host authorization is not active",
        true,
        1_000,
        "not_accepted",
      );
      return {
        accepted: false,
        error,
        actions: [{
          kind: "route_unavailable",
          connectionId,
          connectionIncarnation,
          hostId: authorization.hostId,
          closeCode: 1013,
          error,
        }],
      };
    }
    if (carrier.routeIds.size >= RELAY_V2_BROKER_LIMITS.maxRoutesPerCarrier) {
      const error = structuredError(
        "BUSY",
        "Host carrier route capacity is exhausted",
        true,
        1_000,
        "not_accepted",
      );
      return {
        accepted: false,
        error,
        actions: [{
          kind: "route_unavailable",
          connectionId,
          connectionIncarnation,
          hostId: authorization.hostId,
          closeCode: 1013,
          error,
        }],
      };
    }
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
          connectionIncarnation,
          hostId: authorization.hostId,
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
      connectionIncarnation,
      routeId,
      routeFence,
      openRequestId,
      connectorId: admission.connectorId,
      carrierTransportId: carrier.transportId,
      carrierConnectionIncarnation: carrier.connectionIncarnation,
      authContext: authorization,
      status: "opening",
      firstApplicationFrame: "pending",
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
          hostId: authorization.hostId,
          principalId: authorization.principalId,
          grantId: authorization.grantId,
          clientInstanceId: authorization.clientInstanceId!,
          jti: authorization.jti,
          kid: authorization.kid,
          expiresAtMs: authorization.expiresAtMs,
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
          connectionIncarnation,
          hostId: authorization.hostId,
          closeCode: 1013,
          error,
        }],
      };
    }
    this.routes.set(routeId, route);
    carrier.routeIds.add(routeId);
    this.clients.set(connectionId, {
      connectionId,
      connectionIncarnation,
      outputReadyEpoch: 0n,
      authContext: authorization,
      authorizationState: "active",
      authorizationCloseSignalled: false,
      authorizationCleanupState: "idle",
      routeId,
      queue: [],
      inFlight: new Map(),
    });
    return { accepted: true, actions: [], routeId, routeFence };
  }

  /**
   * The optional signal bounds this carrier delivery and its Broker mutation.
   * It does not cancel an auth-control transaction already handed to its
   * persistent authority.
   */
  async receiveHostFrame(
    transportId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<RelayV2BrokerResult> {
    if (signal?.aborted) {
      return this.failure("HOST_SUPERSEDED", "Carrier delivery was cancelled");
    }
    const carrier = this.carriers.get(transportId);
    if (!carrier) {
      return this.failure("HOST_SUPERSEDED", "Carrier is no longer registered", [{
        kind: "close_host",
        transportId,
        closeCode: 4409,
        reason: "host_superseded",
      }]);
    }
    if (carrier.status === "closed") {
      return this.failure("HOST_SUPERSEDED", "Carrier is no longer registered", [{
        kind: "close_host",
        transportId,
        connectionIncarnation: carrier.connectionIncarnation,
        closeCode: 4409,
        reason: "host_superseded",
      }]);
    }
    if (!this.isCarrierAuthorizationActive(carrier)) {
      return this.failure("AUTH_INVALID", "Carrier authorization is being fenced");
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
        connectionIncarnation: carrier.connectionIncarnation,
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
        return this.handleAuthControl(carrier, frame, type, signal);
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
    if (!this.isCarrierAuthorizationActive(carrier)) {
      const error = structuredError(
        this.liveAuthCompositionLatched ? "CAPABILITY_UNAVAILABLE" : "AUTH_INVALID",
        "Host authorization cannot commit registration",
      );
      return { accepted: false, error, actions: [] };
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
        connectionIncarnation: carrier.connectionIncarnation,
        closeCode: 1013,
        reason: "registration_commit_race",
      }]);
    }

    this.registeringCarriers.delete(carrier.authContext.hostId);
    carrier.registration = null;
    carrier.status = "active";
    this.activeCarriers.set(carrier.authContext.hostId, carrier);
    const directoryBefore = this.directory.get(carrier.authContext.hostId);
    const presenceReason: RelayV2PresenceReason = previous
      ? "superseded"
      : directoryBefore?.state === "offline"
          && directoryBefore.hostEpoch === carrier.hello.hostEpoch
        ? "reconnected"
        : "connected";
    this.publishDirectory(
      carrier,
      "online",
      presenceReason,
      presenceReason === "superseded"
        ? previous?.hello?.hostInstanceId ?? null
        : presenceReason === "reconnected"
          ? directoryBefore?.hostInstanceId ?? null
          : null,
    );
    const actions: RelayV2BrokerAction[] = [];
    if (previous?.connectorId && previous.hello) {
      previous.status = "superseded";
      this.invalidateConnectorRoutes(previous, actions, true);
      actions.push({
        kind: "send_host",
        transportId: previous.transportId,
        connectionIncarnation: previous.connectionIncarnation,
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
        connectionIncarnation: previous.connectionIncarnation,
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
    if (!this.isClientAuthorizationActive(client)) {
      return this.failure("AUTH_INVALID", "Client authorization is being fenced");
    }
    const carrier = this.carriers.get(route.carrierTransportId);
    if (
      !carrier
      || carrier.status !== "active"
      || carrier.connectorId !== route.connectorId
      || this.activeCarriers.get(route.authContext.hostId) !== carrier
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
        actions: [{
          kind: "close_client",
          connectionId,
          connectionIncarnation: route.connectionIncarnation,
          closeCode: 1013,
          reason: "host_offline",
        }],
      };
    }
    if (!this.isCarrierAuthorizationActive(carrier)) {
      return this.failure("AUTH_INVALID", "Host authorization is being fenced");
    }
    let publicFrame: RelayV2JsonObject;
    try {
      publicFrame = decodeRelayV2WebSocketFrame("public", bytes).frame;
    } catch {
      const actions = this.beginRouteUnbind(route, "protocol_error");
      actions.push({
        kind: "close_client",
        connectionId,
        connectionIncarnation: route.connectionIncarnation,
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
        connectionIncarnation: route.connectionIncarnation,
        closeCode: 4400,
        reason: "invalid_public_identity",
      });
      return this.failure("INVALID_ENVELOPE", "Client public identity is not authorized", actions);
    }
    if (publicFrame.type === "hosts.snapshot.get") {
      const snapshot = this.readHostsSnapshot(
        route.authContext,
        publicFrame.requestId as string,
      );
      if (!snapshot) {
        return this.failure("HOST_OFFLINE", "Authorized host directory is unavailable");
      }
      const responseBytes = encodeRelayV2WebSocketFrame("public", snapshot);
      if (
        route.hostToClientFrames + 1 > RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
        || route.hostToClientBufferedBytes + responseBytes.byteLength
          > RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
        || this.carrierBufferedBytes(carrier) + responseBytes.byteLength
          > RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - CARRIER_CONTROL_RESERVE_BYTES
      ) {
        const error = structuredError("SLOW_CONSUMER", "Client directory route cannot drain", true, 1_000);
        const actions = this.beginRouteUnbind(route, "slow_consumer");
        actions.push({
          kind: "close_client",
          connectionId,
          connectionIncarnation: route.connectionIncarnation,
          closeCode: 1013,
          reason: "slow_consumer",
        });
        return { accepted: false, error, actions };
      }
      route.hostToClientFrames += 1;
      route.hostToClientBufferedBytes += responseBytes.byteLength;
      carrier.hostToClientBufferedBytes += responseBytes.byteLength;
      const clientQueueWasEmpty = client.queue.length === 0;
      client.queue.push({ bytes: responseBytes, route });
      if (clientQueueWasEmpty) this.signalClientOutputReady(client, true);
      return { accepted: true, actions: [] };
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
      this.publishDirectory(carrier, "offline", "disconnected", null);
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
    options: { maxFrames?: number; maxBytes?: number; controlOnly?: boolean } = {},
  ): RelayV2CarrierDelivery[] {
    const carrier = this.carriers.get(transportId);
    if (!carrier) return [];
    const isCurrentCarrierOwner = () => (
      this.carriers.get(transportId) === carrier
      && carrier.status === "active"
      && carrier.connectorId !== null
      && this.activeCarriers.get(carrier.authContext.hostId) === carrier
    );
    if (
      !isCurrentCarrierOwner()
      || !this.isCarrierAuthorizationActive(carrier)
      || !isCurrentCarrierOwner()
    ) return [];
    const maxFrames = options.maxFrames ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    const deliveries: RelayV2CarrierDelivery[] = [];
    let drainedBytes = 0;

    const deliver = (entry: QueuedCarrierFrame): "delivered" | "blocked" | "fenced" => {
      if (
        !isCurrentCarrierOwner()
        || !this.isCarrierAuthorizationActive(carrier)
        || !isCurrentCarrierOwner()
      ) return "fenced";
      if (
        entry.route
        && (entry.frame.type === "route.open" || entry.frame.type === "route.data")
      ) {
        const client = this.clients.get(entry.route.connectionId);
        if (
          !client
          || this.routes.get(entry.route.routeId) !== entry.route
          || client.routeId !== entry.route.routeId
          || entry.route.carrierTransportId !== carrier.transportId
          || entry.route.connectorId !== carrier.connectorId
          || !carrier.routeIds.has(entry.route.routeId)
          || !this.isClientAuthorizationActive(client)
          || this.clients.get(entry.route.connectionId) !== client
          || this.routes.get(entry.route.routeId) !== entry.route
          || !isCurrentCarrierOwner()
        ) return "fenced";
      }
      const remainsQueued = carrier.controlQueue[0] === entry
        || (entry.route !== null
          && carrier.dataQueues.get(entry.route.routeId)?.[0] === entry);
      if (!remainsQueued || !isCurrentCarrierOwner()) return "fenced";
      if (deliveries.length >= maxFrames || drainedBytes + entry.wireBytes > maxBytes) {
        return "blocked";
      }
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
      return "delivered";
    };

    while (carrier.controlQueue.length > 0) {
      const entry = carrier.controlQueue[0]!;
      const outcome = deliver(entry);
      if (outcome === "blocked") return deliveries;
      if (outcome === "fenced") return deliveries;
      carrier.controlQueue.shift();
      this.invalidateCarrierOutputReadyIfEmpty(carrier);
    }

    if (options.controlOnly) return deliveries;

    let scansWithoutDelivery = 0;
    while (carrier.dataOrder.length > 0 && deliveries.length < maxFrames) {
      if (carrier.dataCursor >= carrier.dataOrder.length) carrier.dataCursor = 0;
      const routeId = carrier.dataOrder[carrier.dataCursor]!;
      const queue = carrier.dataQueues.get(routeId);
      if (!queue || queue.length === 0) {
        carrier.dataQueues.delete(routeId);
        carrier.dataOrder.splice(carrier.dataCursor, 1);
        this.invalidateCarrierOutputReadyIfEmpty(carrier);
        scansWithoutDelivery = 0;
        continue;
      }
      const entry = queue[0]!;
      const outcome = deliver(entry);
      if (outcome === "fenced") return deliveries;
      if (outcome === "blocked") {
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
        this.invalidateCarrierOutputReadyIfEmpty(carrier);
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
    if (!this.carrierOutputQueueEmpty(carrier)) {
      this.signalCarrierOutputReady(carrier, false);
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
    const isCurrentClientOwner = () => (
      this.clients.get(connectionId) === client
      && client.authorizationState === "active"
      && !this.liveAuthCompositionLatched
    );
    if (
      !isCurrentClientOwner()
      || !this.isClientAuthorizationActive(client)
      || !isCurrentClientOwner()
    ) return [];
    const maxFrames = options.maxFrames ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    const deliveries: RelayV2ClientDelivery[] = [];
    let bytes = 0;
    while (client.queue.length > 0 && deliveries.length < maxFrames) {
      if (
        !isCurrentClientOwner()
        || !this.isClientAuthorizationActive(client)
        || !isCurrentClientOwner()
      ) return deliveries;
      const entry = client.queue[0]!;
      const route = entry.route;
      const carrier = this.carriers.get(route.carrierTransportId);
      if (
        !carrier
        || client.queue[0] !== entry
        || this.routes.get(route.routeId) !== route
        || route.connectionId !== connectionId
        || client.routeId !== route.routeId
        || route.status !== "opened"
        || carrier.status !== "active"
        || carrier.connectorId !== route.connectorId
        || this.carriers.get(route.carrierTransportId) !== carrier
        || this.activeCarriers.get(route.authContext.hostId) !== carrier
        || !this.isCarrierAuthorizationActive(carrier)
        || !isCurrentClientOwner()
        || client.queue[0] !== entry
        || this.routes.get(route.routeId) !== route
        || this.carriers.get(route.carrierTransportId) !== carrier
        || carrier.status !== "active"
        || carrier.connectorId !== route.connectorId
        || this.activeCarriers.get(route.authContext.hostId) !== carrier
      ) return deliveries;
      if (bytes + entry.bytes.byteLength > maxBytes) break;
      client.queue.shift();
      this.invalidateClientOutputReadyIfEmpty(client);
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

  /** Close only this carrier's routes that remained above pressure for 5 seconds. */
  sweepBackpressure(transportId: string): RelayV2BrokerResult {
    const carrier = this.carriers.get(transportId);
    if (!carrier || carrier.status !== "active") {
      return { accepted: true, actions: [] };
    }
    const actions: RelayV2BrokerAction[] = [];
    let closeHost: RelayV2BrokerAction | null = null;
    const now = this.now();
    for (const routeId of carrier.routeIds) {
      const route = this.routes.get(routeId);
      if (!route || route.carrierTransportId !== transportId) {
        carrier.routeIds.delete(routeId);
        continue;
      }
      if (route.status !== "opened") continue;
      const pressureSince = [
        route.clientToHostPressureSinceMs,
        route.hostToClientPressureSinceMs,
      ].filter((value): value is number => value !== null)
        .reduce<number | null>((earliest, value) => (
          earliest === null || value < earliest ? value : earliest
        ), null);
      if (pressureSince === null || now - pressureSince < BACKPRESSURE_CLOSE_MS) continue;
      for (const action of this.beginRouteUnbind(route, "slow_consumer")) {
        if (action.kind === "close_host") {
          // Control admission is a carrier-level failure. Keep one terminal
          // transport action while retaining every route's client cleanup.
          closeHost ??= action;
        } else {
          actions.push(action);
        }
      }
      actions.push({
        kind: "close_client",
        connectionId: route.connectionId,
        connectionIncarnation: route.connectionIncarnation,
        closeCode: 1013,
        reason: "sustained_backpressure",
      });
    }
    // Keep the carrier close last: the pump can first admit at most one
    // resume and one client cleanup per bounded route, then begins teardown
    // with at most maxRoutesPerCarrier + 1 mandatory actions registered.
    if (closeHost) actions.push(closeHost);
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
          this.carrierErrorAction(carrier, hello.requestId, null, "host.hello", error),
          { kind: "close_host", transportId: carrier.transportId, connectionIncarnation: carrier.connectionIncarnation, closeCode: 4403, reason: "host_identity_mismatch" },
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
          this.carrierErrorAction(carrier, hello.requestId, null, "host.hello", error),
          { kind: "close_host", transportId: carrier.transportId, connectionIncarnation: carrier.connectionIncarnation, closeCode: 4411, reason: "duplicate_connector" },
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
          this.carrierErrorAction(carrier, hello.requestId, null, "host.hello", error),
          { kind: "close_host", transportId: carrier.transportId, connectionIncarnation: carrier.connectionIncarnation, closeCode: 1013, reason: "registration_busy" },
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
      connectionIncarnation: carrier.connectionIncarnation,
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
    const client = route ? this.clients.get(route.connectionId) : undefined;
    if (client && !this.isClientAuthorizationActive(client)) {
      return { accepted: false, actions: [], error: structuredError(
        "AUTH_INVALID",
        "Client authorization is fenced",
      ) };
    }
    const openedMaxFrameBytes = (frame.payload as RelayV2JsonObject).maxFrameBytes as number;
    if (
      route?.status === "closing"
      && route.firstApplicationFrame === "unavailable"
      && frame.requestId === route.openRequestId
    ) {
      // route.open crossed the carrier handoff before an auth/offline fence.
      // Its already-queued route.unbind remains the only Host cleanup; a late
      // opened ACK must never resurrect relay.welcome.
      if (openedMaxFrameBytes <= 0 || openedMaxFrameBytes > route.maxFrameBytes) {
        return this.protocolViolation(carrier, "invalid_route_frame_limit");
      }
      return { accepted: true, actions: [] };
    }
    if (
      !route
      || route.status !== "opening"
      || route.firstApplicationFrame !== "pending"
      || frame.requestId !== route.openRequestId
    ) {
      return this.protocolViolation(carrier, "stale_route_opened");
    }
    if (openedMaxFrameBytes <= 0 || openedMaxFrameBytes > route.maxFrameBytes) {
      return this.protocolViolation(carrier, "invalid_route_frame_limit");
    }
    route.maxFrameBytes = openedMaxFrameBytes;
    route.status = "opened";
    route.firstApplicationFrame = "welcome";
    return {
      accepted: true,
      actions: [{
        kind: "route_opened",
        connectionId: route.connectionId,
        connectionIncarnation: route.connectionIncarnation,
        routeId: route.routeId,
        routeFence: route.routeFence,
        hostId: route.authContext.hostId,
        hostEpoch: carrier.hello!.hostEpoch,
        hostInstanceId: carrier.hello!.hostInstanceId,
        capabilities: this.advertisedBaseCapabilities(carrier.hello!),
      }],
    };
  }

  private routeRejected(carrier: CarrierState, frame: RelayV2JsonObject): RelayV2BrokerResult {
    const route = this.currentRouteForFrame(carrier, frame);
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
    if (
      route?.status === "closing"
      && route.firstApplicationFrame === "unavailable"
      && frame.requestId === route.openRequestId
    ) {
      this.dropRoute(route);
      return { accepted: true, actions: [] };
    }
    if (
      !route
      || route.status !== "opening"
      || route.firstApplicationFrame !== "pending"
      || frame.requestId !== route.openRequestId
    ) {
      return this.protocolViolation(carrier, "stale_route_rejected");
    }
    const error = cloneFrame(source) as unknown as RelayV2StructuredError;
    route.firstApplicationFrame = "unavailable";
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
        connectionIncarnation: route.connectionIncarnation,
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
    const clientAuthorization = this.clients.get(route.connectionId);
    if (!clientAuthorization || !this.isClientAuthorizationActive(clientAuthorization)) {
      return this.failure("AUTH_INVALID", "Client authorization is fenced");
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
    const clientQueueWasEmpty = client.queue.length === 0;
    client.queue.push({ bytes, route });
    if (clientQueueWasEmpty) this.signalClientOutputReady(client, true);
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
      connectionIncarnation: route.connectionIncarnation,
      closeCode: payload.closeCode as 1013 | 4400,
      reason: payload.reason as string,
    });
    return { accepted: true, actions };
  }

  private async handleAuthControl(
    carrier: CarrierState,
    frame: RelayV2JsonObject,
    type: "host.reauthenticate" | "enrollment.create" | "grant.revoke",
    signal?: AbortSignal,
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
          currentAuthContext: carrier.authContext,
        }
      : {
          type,
          requestId,
          connectorId,
          payload,
          currentAuthContext: carrier.authContext,
    };
    try {
      const authorityResult = this.authControlAuthority.handle(request);
      const decision = signal
        ? await new Promise<RelayV2AuthControlDecision>((resolve, reject) => {
            const onAbort = () => { reject(new Error("carrier delivery cancelled")); };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            void Promise.resolve(authorityResult).then(
              (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
              },
              (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
          })
        : await authorityResult;
      if (
        this.carriers.get(carrier.transportId) !== carrier
        || carrier.status !== "active"
        || carrier.connectorId !== connectorId
      ) {
        return this.failure("HOST_SUPERSEDED", "Carrier changed during auth control");
      }
      if (!this.isCarrierAuthorizationActive(carrier)) {
        return this.failure("AUTH_INVALID", "Carrier authorization changed during auth control");
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
        const next = cloneClosedConnectionAuthorization(decision.nextAuthContext);
        const responsePayload = response.payload as RelayV2JsonObject;
        if (
          !next
          || next.role !== "host"
          || next.hostId !== carrier.authContext.hostId
          || next.principalId !== carrier.authContext.principalId
          || next.grantId !== carrier.authContext.grantId
          || !this.admitReplacementAuthorization(carrier.authContext, next)
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
        carrier.authContext = next;
      } else if (decision.nextAuthContext !== undefined) {
        throw new Error("unexpected auth context replacement");
      }
      return {
        accepted: true,
        actions: this.enqueueAuthControlResponse(carrier, response),
      };
    } catch {
      if (signal?.aborted) {
        return this.failure("HOST_SUPERSEDED", "Carrier delivery was cancelled");
      }
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

  private isDirectoryClient(
    authContext: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): boolean {
    return authContext.scheme === "twcap2"
      && authContext.role === "client"
      && authContext.clientInstanceId !== null
      && !this.isAuthorizationExpired(authContext)
      && this.liveAuthorizationInvalidationFor(authContext) === undefined
      && !this.liveAuthCompositionLatched;
  }

  private advertisedBaseCapabilities(hello: HostHello): string[] {
    if (
      this.baseCapabilityReadiness.length !== RELAY_V2_REQUIRED_CAPABILITIES.length
      || completeBaseReadiness(hello).length !== RELAY_V2_REQUIRED_CAPABILITIES.length
    ) return [];
    return [...RELAY_V2_REQUIRED_CAPABILITIES];
  }

  private beginLiveAuthorizationInvalidation(
    invalidation: RelayV2LiveAuthorizationInvalidation,
  ): RelayV2LiveAuthorizationCommitBarrier {
    const installed = this.cloneLiveAuthorizationInvalidation(invalidation);
    if (!this.onLiveAuthorizationClose || this.liveAuthCompositionLatched) {
      throw new Error("Relay v2 live-authorization close signal is unavailable");
    }
    const pending: PendingLiveAuthorizationInvalidation = {
      invalidation: installed,
      settled: false,
    };
    this.pendingLiveAuthorizationInvalidations.push(pending);
    const settle = () => {
      const index = this.pendingLiveAuthorizationInvalidations.indexOf(pending);
      if (index >= 0) this.pendingLiveAuthorizationInvalidations.splice(index, 1);
    };
    return Object.freeze({
      committed: (receipt: RelayV2LiveAuthorizationCommitReceipt) => {
        if (pending.settled) return;
        pending.settled = true;
        try {
          const committedReceipt = cloneClosedAuthorizationReceipt(receipt);
          if (
            !committedReceipt
            || !this.observeAuthorizationHighWater(committedReceipt)
            || this.committedLiveAuthorizationInvalidations.length
              >= MAX_COMMITTED_LIVE_AUTHORIZATION_INVALIDATIONS
          ) {
            settle();
            this.latchCredentialAuthorityUnavailable();
            return;
          }
          const committed = Object.freeze({
            invalidation: installed,
            receipt: committedReceipt,
          });
          this.committedLiveAuthorizationInvalidations.push(committed);
          // A committed exact-identity fence replaces the pending fence before
          // pending admission is reopened. Late attach can therefore never use
          // a pre-commit verification result after settlement.
          settle();
          this.applyCommittedLiveAuthorizationInvalidation(committed);
        } catch {
          // Receipt proxies, coercion, capacity bookkeeping and fence
          // application are all outside the pending record's trust boundary.
          // Never leave a settled record installed or reopen admission.
          settle();
          this.latchCredentialAuthorityUnavailable();
        }
      },
      cancelled: () => {
        if (pending.settled) return;
        pending.settled = true;
        settle();
      },
      failClosed: () => {
        if (pending.settled) return;
        pending.settled = true;
        settle();
        this.latchCredentialAuthorityUnavailable();
      },
    });
  }

  private cloneLiveAuthorizationInvalidation(
    invalidation: unknown,
  ): RelayV2LiveAuthorizationInvalidation {
    const own = readOwnDataRecord(invalidation);
    if (!own) {
      throw new Error("invalid Relay v2 live-authorization fence");
    }
    const { keys, values: runtime } = own;
    const exactKeys = (allowed: readonly string[]): boolean => {
      return keys.length === allowed.length
        && keys.every((key) => allowed.includes(key));
    };
    const validRole = (value: unknown): value is RelayBrokerRole => (
      value === "client" || value === "host"
    );
    const reason = runtime.reason;
    if (reason === "grant_revoked") {
      const role = runtime.role;
      const hostId = runtime.hostId;
      const grantId = runtime.grantId;
      if (
        !exactKeys(["reason", "role", "hostId", "grantId"])
        || !validRole(role)
        || !isIdentifier(hostId)
        || !isIdentifier(grantId)
      ) throw new Error("invalid Relay v2 grant-revocation authorization fence");
      return Object.freeze({ reason, role, hostId, grantId });
    }
    if (reason === "access_expired") {
      const role = runtime.role;
      const hostId = runtime.hostId;
      const jti = runtime.jti;
      if (
        !exactKeys(["reason", "role", "hostId", "jti"])
        || !validRole(role)
        || !isIdentifier(hostId)
        || !isIdentifier(jti)
      ) throw new Error("invalid Relay v2 access-expiry authorization fence");
      return Object.freeze({ reason, role, hostId, jti });
    }
    if (reason === "kid_removed") {
      const role = runtime.role;
      const hostId = runtime.hostId;
      const kid = runtime.kid;
      const allowed = ["reason", "kid"];
      if (role !== undefined) allowed.push("role");
      if (hostId !== undefined) allowed.push("hostId");
      if (
        !exactKeys(allowed)
        || !isIdentifier(kid)
        || (role !== undefined && !validRole(role))
        || (hostId !== undefined && !isIdentifier(hostId))
      ) throw new Error("invalid Relay v2 kid-removal authorization fence");
      return Object.freeze({
        reason,
        kid,
        ...(role === undefined ? {} : { role }),
        ...(hostId === undefined ? {} : { hostId }),
      });
    }
    throw new Error("invalid Relay v2 live-authorization fence reason");
  }

  private isLiveAuthorizationCommitReceiptValid(
    receipt: Readonly<RelayV2LiveAuthorizationCommitReceipt>,
  ): boolean {
    return receipt !== null
      && typeof receipt === "object"
      && isIdentifier(receipt.authorizationFence)
      && /^(0|[1-9][0-9]*)$/.test(receipt.authorizationRevision)
      && BigInt(receipt.authorizationRevision) <= MAX_UINT64;
  }

  private observeAuthorizationHighWater(
    authorization: Readonly<RelayV2LiveAuthorizationCommitReceipt>,
  ): boolean {
    if (!this.isLiveAuthorizationCommitReceiptValid(authorization)) return false;
    const revision = BigInt(authorization.authorizationRevision);
    if (this.authorizationHighWater === null) {
      this.authorizationHighWater = Object.freeze({
        authorizationRevision: authorization.authorizationRevision,
        authorizationFence: authorization.authorizationFence,
      });
      return true;
    }
    const current = BigInt(this.authorizationHighWater.authorizationRevision);
    if (revision > current) {
      this.authorizationHighWater = Object.freeze({
        authorizationRevision: authorization.authorizationRevision,
        authorizationFence: authorization.authorizationFence,
      });
      return true;
    }
    if (revision === current) {
      return authorization.authorizationFence === this.authorizationHighWater.authorizationFence;
    }
    // A lower revision is not globally stale: exact committed identity fences
    // below decide whether this particular principal/grant/kid may attach.
    return true;
  }

  private isAuthorizationExpired(
    authorization: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): boolean {
    return authorization.expiresAtMs <= this.now();
  }

  private authMatchesLiveAuthorizationInvalidation(
    authorization: Readonly<RelayV2BrokerConnectionAuthorization>,
    invalidation: RelayV2LiveAuthorizationInvalidation,
  ): boolean {
    if (invalidation.reason === "kid_removed") {
      return authorization.kid === invalidation.kid
        && (invalidation.role === undefined || authorization.role === invalidation.role)
        && (invalidation.hostId === undefined || authorization.hostId === invalidation.hostId);
    }
    if (
      authorization.role !== invalidation.role
      || authorization.hostId !== invalidation.hostId
    ) return false;
    return invalidation.reason === "grant_revoked"
      ? authorization.grantId === invalidation.grantId
      : authorization.jti === invalidation.jti;
  }

  private liveAuthorizationInvalidationFor(
    authorization: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): RelayV2LiveAuthorizationInvalidation | undefined {
    const pending = this.pendingLiveAuthorizationInvalidations.find((candidate) => (
      this.authMatchesLiveAuthorizationInvalidation(authorization, candidate.invalidation)
    ));
    if (pending) return pending.invalidation;
    return this.committedLiveAuthorizationInvalidations.find((candidate) => (
      this.authMatchesLiveAuthorizationInvalidation(authorization, candidate.invalidation)
    ))?.invalidation;
  }

  private committedLiveAuthorizationInvalidationFor(
    authorization: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): CommittedLiveAuthorizationInvalidation | undefined {
    return this.committedLiveAuthorizationInvalidations.find((candidate) => (
      this.authMatchesLiveAuthorizationInvalidation(authorization, candidate.invalidation)
    ));
  }

  private admitNewConnectionAuthorization(
    authorization: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): boolean {
    return !this.isAuthorizationExpired(authorization)
      && !this.liveAuthCompositionLatched
      && !this.outputReadyCompositionLatched
      && this.liveAuthorizationInvalidationFor(authorization) === undefined
      && this.observeAuthorizationHighWater(authorization);
  }

  private admitReplacementAuthorization(
    current: Readonly<RelayV2BrokerConnectionAuthorization>,
    replacement: Readonly<RelayV2BrokerConnectionAuthorization>,
  ): boolean {
    if (
      this.isAuthorizationExpired(replacement)
      || this.liveAuthCompositionLatched
      || this.outputReadyCompositionLatched
      || this.liveAuthorizationInvalidationFor(replacement) !== undefined
    ) return false;
    if (BigInt(replacement.authorizationRevision) < BigInt(current.authorizationRevision)) {
      return false;
    }
    return this.observeAuthorizationHighWater(replacement);
  }

  private isCarrierAuthorizationActive(carrier: CarrierState): boolean {
    if (
      carrier.authorizationState === "fenced"
      || this.liveAuthCompositionLatched
      || this.outputReadyCompositionLatched
    ) return false;
    const expired = this.isAuthorizationExpired(carrier.authContext);
    if (
      carrier.authorizationState === "fenced"
      || this.liveAuthCompositionLatched
      || this.outputReadyCompositionLatched
    ) return false;
    if (expired) {
      this.fenceHostAuthorization(carrier, "access_expired");
      return false;
    }
    const committed = this.committedLiveAuthorizationInvalidationFor(carrier.authContext);
    if (committed) {
      this.fenceHostAuthorization(carrier, committed.invalidation.reason, committed.receipt);
      return false;
    }
    return this.liveAuthorizationInvalidationFor(carrier.authContext) === undefined;
  }

  private isClientAuthorizationActive(client: ClientState): boolean {
    if (
      client.authorizationState === "fenced"
      || this.liveAuthCompositionLatched
      || this.outputReadyCompositionLatched
    ) return false;
    const expired = this.isAuthorizationExpired(client.authContext);
    if (
      client.authorizationState === "fenced"
      || this.liveAuthCompositionLatched
      || this.outputReadyCompositionLatched
    ) return false;
    if (expired) {
      this.fenceClientAuthorization(client, "access_expired");
      return false;
    }
    const committed = this.committedLiveAuthorizationInvalidationFor(client.authContext);
    if (committed) {
      this.fenceClientAuthorization(client, committed.invalidation.reason, committed.receipt);
      return false;
    }
    return this.liveAuthorizationInvalidationFor(client.authContext) === undefined;
  }

  private applyCommittedLiveAuthorizationInvalidation(
    committed: CommittedLiveAuthorizationInvalidation,
  ): void {
    const directClients = [...this.clients.values()].filter((client) => (
      this.authMatchesLiveAuthorizationInvalidation(
        client.authContext,
        committed.invalidation,
      )
    ));
    const directCarriers = [...this.carriers.values()].filter((carrier) => (
      this.authMatchesLiveAuthorizationInvalidation(
        carrier.authContext,
        committed.invalidation,
      )
    ));
    // Direct client matches must capture the exact committed reason/receipt
    // before a matching Host fence cascades through its routes.
    for (const client of directClients) {
      this.fenceClientAuthorization(
        client,
        committed.invalidation.reason,
        committed.receipt,
      );
    }
    for (const carrier of directCarriers) {
      this.fenceHostAuthorization(
        carrier,
        committed.invalidation.reason,
        committed.receipt,
      );
    }
  }

  private latchCredentialAuthorityUnavailable(): void {
    this.liveAuthCompositionLatched = true;
    if (this.liveAuthGlobalFenceApplied || this.liveAuthGlobalFenceApplying) return;
    this.liveAuthGlobalFenceApplying = true;
    const clients = [...this.clients.values()];
    const carriers = [...this.carriers.values()];

    // Phase one contains no injected calls, codec work or directory publish.
    // Every dispatch/admission gate closes before any best-effort cleanup.
    for (const client of clients) client.authorizationState = "fenced";
    for (const carrier of carriers) carrier.authorizationState = "fenced";

    // Phase two isolates each connection. A throwing clock, codec, directory
    // publish or close owner cannot prevent the remaining once-only signals.
    for (const client of clients) {
      try {
        this.cleanupFencedClientAuthorization(client, "credential_authority_unavailable", true);
      } catch {
        this.signalClientAuthorizationClose(client, "credential_authority_unavailable");
      }
    }
    for (const carrier of carriers) {
      try {
        this.cleanupFencedHostAuthorization(carrier, "credential_authority_unavailable");
      } catch {
        this.signalHostAuthorizationClose(carrier, "credential_authority_unavailable");
      }
    }
    this.liveAuthGlobalFenceApplying = false;
    this.liveAuthGlobalFenceApplied = true;
  }

  private authorizationAtReceipt(
    authorization: Readonly<RelayV2BrokerConnectionAuthorization>,
    receipt: Readonly<RelayV2LiveAuthorizationCommitReceipt> | undefined,
  ): RelayV2BrokerConnectionAuthorization {
    const snapshot = cloneClosedConnectionAuthorization({
      scheme: authorization.scheme,
      role: authorization.role,
      hostId: authorization.hostId,
      principalId: authorization.principalId,
      grantId: authorization.grantId,
      clientInstanceId: authorization.clientInstanceId,
      jti: authorization.jti,
      kid: authorization.kid,
      expiresAtMs: authorization.expiresAtMs,
      authorizationRevision: receipt?.authorizationRevision
        ?? authorization.authorizationRevision,
      authorizationFence: receipt?.authorizationFence
        ?? authorization.authorizationFence,
    });
    if (!snapshot) throw new Error("invalid Relay v2 authorization receipt snapshot");
    return snapshot;
  }

  private fenceHostAuthorization(
    carrier: CarrierState,
    reason: RelayV2LiveAuthorizationCloseReason,
    receipt?: RelayV2LiveAuthorizationCommitReceipt,
  ): void {
    if (carrier.authorizationState === "fenced") return;
    carrier.authorizationState = "fenced";
    let failed = false;
    try {
      carrier.authContext = this.authorizationAtReceipt(carrier.authContext, receipt);
    } catch {
      failed = true;
    }
    this.cleanupFencedHostAuthorization(carrier, reason);
    if (failed) this.latchCredentialAuthorityUnavailable();
  }

  private cleanupFencedHostAuthorization(
    carrier: CarrierState,
    reason: RelayV2LiveAuthorizationCloseReason,
  ): void {
    if (carrier.authorizationCleanupState !== "idle") return;
    carrier.authorizationCleanupState = "applying";
    let failed = false;
    try {
      if (this.activeCarriers.get(carrier.authContext.hostId) === carrier) {
        this.activeCarriers.delete(carrier.authContext.hostId);
        if (carrier.hello && carrier.connectorId) {
          try {
            this.publishDirectory(carrier, "offline", "disconnected", null);
          } catch {
            failed = true;
          }
        }
      }
    } catch {
      failed = true;
    }
    try {
      if (this.registeringCarriers.get(carrier.authContext.hostId) === carrier) {
        this.registeringCarriers.delete(carrier.authContext.hostId);
      }
      carrier.registration = null;
    } catch {
      failed = true;
    }
    for (const routeId of [...carrier.routeIds]) {
      try {
        const route = this.routes.get(routeId);
        const client = route ? this.clients.get(route.connectionId) : undefined;
        if (client) {
          this.fenceClientAuthorization(client, "host_authorization_fenced", undefined, false);
        }
        if (route) this.dropRoute(route);
      } catch {
        failed = true;
      }
    }
    try {
      carrier.status = "closed";
      this.discardCarrier(carrier);
    } catch {
      failed = true;
    }
    carrier.authorizationCleanupState = "complete";
    this.signalHostAuthorizationClose(carrier, reason);
    if (this.carriers.get(carrier.transportId) === carrier) {
      this.carriers.delete(carrier.transportId);
    }
    if (failed) this.latchCredentialAuthorityUnavailable();
  }

  private fenceClientAuthorization(
    client: ClientState,
    reason: RelayV2LiveAuthorizationCloseReason,
    receipt?: RelayV2LiveAuthorizationCommitReceipt,
    unbind = true,
  ): void {
    if (client.authorizationState === "fenced") return;
    client.authorizationState = "fenced";
    let failed = false;
    try {
      client.authContext = this.authorizationAtReceipt(client.authContext, receipt);
      const route = this.routes.get(client.routeId);
      if (route) route.authContext = client.authContext;
    } catch {
      failed = true;
    }
    this.cleanupFencedClientAuthorization(client, reason, unbind);
    if (failed) this.latchCredentialAuthorityUnavailable();
  }

  private cleanupFencedClientAuthorization(
    client: ClientState,
    reason: RelayV2LiveAuthorizationCloseReason,
    unbind: boolean,
  ): void {
    if (client.authorizationCleanupState !== "idle") return;
    client.authorizationCleanupState = "applying";
    let failed = false;
    try {
      const route = this.routes.get(client.routeId);
      if (route && unbind) this.fenceRouteForAuthorization(route, reason);
    } catch {
      failed = true;
    }
    client.authorizationCleanupState = "complete";
    this.signalClientAuthorizationClose(client, reason);
    if (failed) this.latchCredentialAuthorityUnavailable();
  }

  private fenceRouteForAuthorization(
    route: RouteState,
    reason: RelayV2LiveAuthorizationCloseReason,
  ): void {
    if (route.status === "closed" || route.status === "closing") return;
    const carrier = this.carriers.get(route.carrierTransportId);
    if (!carrier || carrier.status !== "active" || carrier.connectorId !== route.connectorId) {
      this.dropRoute(route);
      return;
    }
    this.discardQueuedRouteData(carrier, route);
    this.discardQueuedRouteControl(carrier, route);
    this.discardQueuedClientData(route);
    if (route.status === "opening" && route.firstApplicationFrame === "pending") {
      route.firstApplicationFrame = "unavailable";
    }
    route.status = "closing";
    this.enqueueCarrierControl(carrier, {
      carrierVersion: 1,
      type: "route.unbind",
      connectorId: route.connectorId,
      routeId: route.routeId,
      routeFence: route.routeFence,
      payload: {
        reason: reason === "access_expired" ? "auth_expired" : "auth_revoked",
        lastClientToHostSeq: lastDispatchedClientSeq(route),
      },
    }, route);
  }

  private signalHostAuthorizationClose(
    carrier: CarrierState,
    reason: RelayV2LiveAuthorizationCloseReason,
  ): void {
    if (carrier.authorizationCloseSignalled) return;
    carrier.authorizationCloseSignalled = true;
    try {
      this.onLiveAuthorizationClose?.(Object.freeze({
        connectionKind: "host",
        transportId: carrier.transportId,
        connectionIncarnation: carrier.connectionIncarnation,
        reason,
        authorization: carrier.authContext,
      }));
    } catch {
      this.latchCredentialAuthorityUnavailable();
    }
  }

  private signalClientAuthorizationClose(
    client: ClientState,
    reason: RelayV2LiveAuthorizationCloseReason,
  ): void {
    if (client.authorizationCloseSignalled) return;
    client.authorizationCloseSignalled = true;
    try {
      this.onLiveAuthorizationClose?.(Object.freeze({
        connectionKind: "client",
        connectionId: client.connectionId,
        connectionIncarnation: client.connectionIncarnation,
        reason,
        authorization: client.authContext,
      }));
    } catch {
      this.latchCredentialAuthorityUnavailable();
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
    const actions: RelayV2BrokerAction[] = [];
    if (route.clientReadPaused) {
      route.clientReadPaused = false;
      route.clientToHostPressureSinceMs = null;
      actions.push({
        kind: "resume_client",
        connectionId: route.connectionId,
        connectionIncarnation: route.connectionIncarnation,
      });
    }
    const carrier = this.carriers.get(route.carrierTransportId);
    if (!carrier || carrier.status !== "active" || carrier.connectorId !== route.connectorId) {
      this.dropRoute(route);
      return actions;
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
      actions.push({
        kind: "close_host",
        transportId: carrier.transportId,
        connectionIncarnation: carrier.connectionIncarnation,
        closeCode: 1013,
        reason: "carrier_control_backpressure",
      });
    }
    return actions;
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
    return [{
      kind: "pause_client",
      connectionId: route.connectionId,
      connectionIncarnation: route.connectionIncarnation,
    }];
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
      connectionIncarnation: route.carrierConnectionIncarnation,
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
    return [{
      kind: "resume_client",
      connectionId: route.connectionId,
      connectionIncarnation: route.connectionIncarnation,
    }];
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
      connectionIncarnation: route.carrierConnectionIncarnation,
      routeId: route.routeId,
    }];
  }

  private collectCarrierResumes(carrier: CarrierState): RelayV2BrokerAction[] {
    const actions: RelayV2BrokerAction[] = [];
    for (const routeId of carrier.routeIds) {
      const route = this.routes.get(routeId);
      if (!route || route.carrierTransportId !== carrier.transportId) {
        carrier.routeIds.delete(routeId);
        continue;
      }
      actions.push(...this.maybeResumeClientPressure(carrier, route));
      actions.push(...this.maybeResumeHostPressure(route));
    }
    return actions;
  }

  private carrierOutputQueueEmpty(carrier: CarrierState): boolean {
    return carrier.controlQueue.length === 0 && carrier.dataQueues.size === 0;
  }

  private signalCarrierOutputReady(
    carrier: CarrierState,
    newQueueEpoch: boolean,
  ): void {
    if (newQueueEpoch) carrier.outputReadyEpoch += 1n;
    if (
      !this.outputReadyPort
      || this.outputReadyCompositionLatched
      || this.carrierOutputQueueEmpty(carrier)
    ) return;
    const epoch = carrier.outputReadyEpoch;
    const connectionIncarnation = carrier.connectionIncarnation;
    const fence = brokerOutputReadyFence(Object.freeze({
      kind: "host" as const,
      transportId: carrier.transportId,
      connectionIncarnation,
      readyEpoch: epoch.toString(10),
    }), () => (
      this.carriers.get(carrier.transportId) === carrier
      && carrier.connectionIncarnation === connectionIncarnation
      && carrier.outputReadyEpoch === epoch
      && carrier.authorizationState === "active"
      && !this.liveAuthCompositionLatched
      && !this.outputReadyCompositionLatched
      && !this.carrierOutputQueueEmpty(carrier)
    ));
    try {
      this.outputReadyPort.ready(fence);
    } catch {
      // The queue mutation is already committed. Never unwind it; permanently
      // close all ready-based admission/dispatch instead of silently assuming
      // a future edge will repair the composition.
      this.outputReadyCompositionLatched = true;
    }
  }

  private invalidateCarrierOutputReadyIfEmpty(carrier: CarrierState): void {
    if (this.carrierOutputQueueEmpty(carrier)) carrier.outputReadyEpoch += 1n;
  }

  private signalClientOutputReady(
    client: ClientState,
    newQueueEpoch: boolean,
  ): void {
    if (newQueueEpoch) client.outputReadyEpoch += 1n;
    if (
      !this.outputReadyPort
      || this.outputReadyCompositionLatched
      || client.queue.length === 0
    ) return;
    const epoch = client.outputReadyEpoch;
    const connectionIncarnation = client.connectionIncarnation;
    const fence = brokerOutputReadyFence(Object.freeze({
      kind: "client" as const,
      connectionId: client.connectionId,
      connectionIncarnation,
      readyEpoch: epoch.toString(10),
    }), () => {
      const route = this.routes.get(client.routeId);
      return this.clients.get(client.connectionId) === client
        && client.connectionIncarnation === connectionIncarnation
        && client.outputReadyEpoch === epoch
        && client.authorizationState === "active"
        && !this.liveAuthCompositionLatched
        && !this.outputReadyCompositionLatched
        && client.queue.length > 0
        && route?.connectionId === client.connectionId
        && route.connectionIncarnation === client.connectionIncarnation
        && route.status === "opened";
    });
    try {
      this.outputReadyPort.ready(fence);
    } catch {
      this.outputReadyCompositionLatched = true;
    }
  }

  private invalidateClientOutputReadyIfEmpty(client: ClientState): void {
    if (client.queue.length === 0) client.outputReadyEpoch += 1n;
  }

  private enqueueCarrierControl(
    carrier: CarrierState,
    frame: RelayV2JsonObject,
    route: RouteState | null,
  ): boolean {
    const wasEmpty = this.carrierOutputQueueEmpty(carrier);
    const entry = carrierFrame(frame);
    entry.route = route;
    if (
      this.carrierBufferedBytes(carrier) + entry.wireBytes
      > RELAY_V2_BROKER_LIMITS.carrierBufferedBytes
    ) return false;
    carrier.controlQueue.push(entry);
    carrier.queuedBytes += entry.wireBytes;
    if (wasEmpty) this.signalCarrierOutputReady(carrier, true);
    return true;
  }

  private enqueueCarrierData(
    carrier: CarrierState,
    route: RouteState,
    frame: RelayV2JsonObject,
    rawBytes: number,
    routeSeq: bigint,
  ): boolean {
    const wasEmpty = this.carrierOutputQueueEmpty(carrier);
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
    if (wasEmpty) this.signalCarrierOutputReady(carrier, true);
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
    this.invalidateCarrierOutputReadyIfEmpty(carrier);
  }

  private discardQueuedRouteControl(carrier: CarrierState, route: RouteState): void {
    const retained: QueuedCarrierFrame[] = [];
    for (const entry of carrier.controlQueue) {
      if (entry.route !== route) {
        retained.push(entry);
        continue;
      }
      carrier.queuedBytes -= entry.wireBytes;
    }
    carrier.controlQueue = retained;
    this.invalidateCarrierOutputReadyIfEmpty(carrier);
  }

  private dropRoute(route: RouteState): void {
    if (route.status === "closed") return;
    const carrier = this.carriers.get(route.carrierTransportId);
    if (carrier) {
      this.discardQueuedRouteData(carrier, route);
      this.discardQueuedRouteControl(carrier, route);
      carrier.routeIds.delete(route.routeId);
    }
    const client = this.clients.get(route.connectionId);
    if (client) {
      for (const entry of client.queue) this.releaseHostToClientBytes(route, entry.bytes.byteLength);
      client.queue = [];
      for (const delivery of client.inFlight.values()) {
        this.releaseHostToClientBytes(route, delivery.bytes.byteLength);
      }
      client.inFlight.clear();
      client.outputReadyEpoch += 1n;
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
    client.outputReadyEpoch += 1n;
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
    for (const routeId of [...carrier.routeIds]) {
      const route = this.routes.get(routeId);
      if (!route || route.carrierTransportId !== carrier.transportId) {
        carrier.routeIds.delete(routeId);
        continue;
      }
      if (route.status === "opening" && route.firstApplicationFrame === "pending") {
        route.firstApplicationFrame = "unavailable";
        actions.push({
          kind: "route_unavailable",
          connectionId: route.connectionId,
          connectionIncarnation: route.connectionIncarnation,
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
          connectionIncarnation: route.connectionIncarnation,
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
    carrier.routeIds.clear();
    carrier.dataOrder = [];
    carrier.dataCursor = 0;
    carrier.outputReadyEpoch += 1n;
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

  private publishDirectory(
    carrier: CarrierState,
    state: "online" | "offline",
    presenceReason: RelayV2PresenceReason,
    previousHostInstanceId: string | null,
  ): string {
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
      capabilities: hello
        ? this.advertisedBaseCapabilities(hello)
        : [...previous?.capabilities ?? []],
      observedAtMs: this.now(),
      presenceReason,
      previousHostInstanceId,
    });
    return revision.toString(10);
  }

  private carrierErrorAction(
    carrier: CarrierState,
    requestId: string,
    connectorId: string | null,
    failedType: "host.hello" | "host.reauthenticate" | "enrollment.create" | "grant.revoke",
    error: RelayV2StructuredError,
  ): RelayV2BrokerAction {
    return {
      kind: "send_host",
      transportId: carrier.transportId,
      connectionIncarnation: carrier.connectionIncarnation,
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
      connectionIncarnation: carrier.connectionIncarnation,
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
      connectionIncarnation: carrier.connectionIncarnation,
      closeCode: 4400,
      reason,
    }];
    if (
      carrier.status === "active"
      && this.activeCarriers.get(carrier.authContext.hostId) === carrier
    ) {
      this.activeCarriers.delete(carrier.authContext.hostId);
      this.publishDirectory(carrier, "offline", "disconnected", null);
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
