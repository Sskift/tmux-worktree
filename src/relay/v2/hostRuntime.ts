import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import { RELAY_V2_REQUIRED_CAPABILITIES } from "./brokerCore.js";
import type {
  RelayV2HostCarrierRouteSink,
  RelayV2HostLocalUnbindReason,
  RelayV2HostRouteBinding,
} from "./hostCarrier.js";
import type {
  RelayV2CommandAuthContext,
  RelayV2CommandDedupeWindow,
  RelayV2HostCommandPlane,
} from "./hostCommandPlane.js";
import type {
  RelayV2HostStateStore,
} from "./hostState.js";
import {
  RelayV2MaterializedStateError,
} from "./resourceState.js";
import type {
  RelayV2MaterializedStateFoundation,
  RelayV2StateEventSink,
  RelayV2WelcomeCut,
} from "./resourceState.js";
import {
  RelayV2StateSnapshotSpoolError,
} from "./stateSnapshotSpool.js";
import type {
  RelayV2StateSnapshotChunk,
  RelayV2StateSnapshotGet,
  RelayV2StateSnapshotRelease,
  RelayV2StateSnapshotReleased,
  RelayV2StateSnapshotSpool,
} from "./stateSnapshotSpool.js";
import type {
  RelayV2TerminalAuthContext,
  RelayV2TerminalCloseRequest,
  RelayV2TerminalInput,
  RelayV2TerminalManager,
  RelayV2TerminalOpenRequest,
  RelayV2TerminalOutputAck,
  RelayV2TerminalReplayRequest,
  RelayV2TerminalResize,
  RelayV2TerminalRoute,
} from "./terminalManager.js";

export const RELAY_V2_HOST_RUNTIME_LIMITS = Object.freeze({
  maxRoutes: 256,
  maxInFlightRequestsPerRoute: 64,
  maxPendingOperationsPerRoute: 128,
  maxOutboundFramesPerRoute: 128,
  maxOutboundBytesPerRoute: 1_048_576,
  outboundReceiptTimeoutMs: 5_000,
} as const);

const MAX_PUBLIC_FRAME_BYTES = 1_048_576;

export type RelayV2RequiredCapability =
  typeof RELAY_V2_REQUIRED_CAPABILITIES[number];

export type RelayV2HostCapabilityIntersection = Readonly<
  Record<RelayV2RequiredCapability, boolean>
>;

export interface RelayV2HostReadinessSnapshot {
  /** Opaque monotonic source generation. It is never serialized. */
  generation: string;
  capabilities: RelayV2HostCapabilityIntersection;
}

export interface RelayV2HostReadinessSink {
  /** Literal true is the only successful synchronous bounded delivery. */
  apply(snapshot: RelayV2HostReadinessSnapshot): boolean;
  close(): void;
}

export interface RelayV2HostReadinessSubscription {
  unsubscribe(): void;
}

/**
 * The source owns the six-way H0/H1/H2/H3/carrier/codec intersection. It must
 * synchronously deliver its current snapshot through sink.apply before
 * subscribe returns. A withdrawal is an incomplete snapshot or sink.close;
 * the runtime fences every existing route before acknowledging apply.
 */
export interface RelayV2HostCapabilityIntersectionPort {
  subscribe(sink: RelayV2HostReadinessSink): RelayV2HostReadinessSubscription;
}

export interface RelayV2HostRuntimeIdentity {
  hostEpoch: string;
  hostInstanceId: string;
}

export interface RelayV2HostRuntimeIdentityPort {
  current(): Promise<RelayV2HostRuntimeIdentity>;
}

export interface RelayV2HostRuntimeCommandPort {
  execute(
    auth: RelayV2CommandAuthContext,
    frame: RelayV2JsonObject,
  ): Promise<RelayV2JsonObject>;
  query(
    auth: RelayV2CommandAuthContext,
    frame: RelayV2JsonObject,
  ): Promise<RelayV2JsonObject>;
  /** Issues the H1-owned window before H2 enters linearizeWelcome. */
  issueDedupeWindow(): Promise<RelayV2CommandDedupeWindow>;
}

export interface RelayV2HostRuntimeHelloBuildInput {
  hello: RelayV2JsonObject;
  cut: RelayV2WelcomeCut;
  commandDedupeWindow: RelayV2CommandDedupeWindow;
  capabilities: readonly RelayV2RequiredCapability[];
}

export interface RelayV2HostRuntimeWelcomeSerializer {
  /** Must be pure and synchronous; it runs inside H2's H0 serializer. */
  build(input: RelayV2HostRuntimeHelloBuildInput): RelayV2JsonObject;
}

export interface RelayV2HostRuntimeResourcePort {
  linearizeWelcome(
    subscriberId: string,
    sink: RelayV2StateEventSink<RelayV2JsonObject>,
    buildWelcome: (cut: RelayV2WelcomeCut) => RelayV2JsonObject,
  ): Promise<RelayV2JsonObject>;
  scopesSnapshot(
    requestId: string,
    expectedHostEpoch: string,
  ): Promise<RelayV2JsonObject>;
  sessionsSnapshot(
    requestId: string,
    expectedHostEpoch: string,
    scopeIds: readonly string[] | null,
  ): Promise<RelayV2JsonObject>;
  unsubscribe(subscriberId: string): void;
}

export interface RelayV2HostRuntimeSnapshotPort {
  get(request: RelayV2StateSnapshotGet): Promise<RelayV2StateSnapshotChunk>;
  release(request: RelayV2StateSnapshotRelease): Promise<RelayV2StateSnapshotReleased>;
}

export interface RelayV2HostRuntimeTerminalPort {
  open(request: RelayV2TerminalOpenRequest): Promise<void>;
  requestReplay(request: RelayV2TerminalReplayRequest): Promise<void>;
  acknowledgeOutput(ack: RelayV2TerminalOutputAck): Promise<void>;
  input(input: RelayV2TerminalInput): Promise<void>;
  resize(resize: RelayV2TerminalResize): Promise<void>;
  close(request: RelayV2TerminalCloseRequest): Promise<void>;
  unbind(auth: RelayV2TerminalAuthContext, route: RelayV2TerminalRoute): Promise<void>;
}

export interface RelayV2HostRuntimeAuthorityRoute extends RelayV2TerminalRoute {
  /** Process-local exact binding token. Never serialized. */
  readonly runtimeBindingId: string;
}

export type RelayV2HostRuntimeClose = Readonly<{
  code: 4400 | 4406 | 1013;
  reason:
    | "protocol_error"
    | "event_cursor_ahead"
    | "route_unavailable"
    | "capability_withdrawn"
    | "slow_consumer"
    | "authority_failure"
    | "host_shutdown";
}>;

export interface RelayV2HostRuntimeOutboundReceipt {
  /** Exactly one call transfers or rejects transport ownership. */
  settle(accepted: boolean): void;
}

export interface RelayV2HostRuntimeOutboundPort {
  /**
   * Synchronous bounded admission only. Literal true transfers the frame to
   * transport ownership, which remains charged until receipt.settle. Promise
   * admission is deliberately unsupported.
   */
  trySend(
    binding: RelayV2HostRouteBinding,
    payload: Uint8Array,
    receipt: RelayV2HostRuntimeOutboundReceipt,
  ): boolean;
  close(binding: RelayV2HostRouteBinding, close: RelayV2HostRuntimeClose): void;
}

type RuntimeLimits = typeof RELAY_V2_HOST_RUNTIME_LIMITS;

export interface RelayV2HostRuntimeOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  identity: RelayV2HostRuntimeIdentityPort;
  capabilityIntersection: RelayV2HostCapabilityIntersectionPort;
  commands: RelayV2HostRuntimeCommandPort;
  resources: RelayV2HostRuntimeResourcePort;
  snapshots: RelayV2HostRuntimeSnapshotPort;
  terminals: RelayV2HostRuntimeTerminalPort;
  welcome: RelayV2HostRuntimeWelcomeSerializer;
  outbound: RelayV2HostRuntimeOutboundPort;
  /** Tests may only make frozen limits stricter. */
  testLimits?: Partial<RuntimeLimits>;
}

export interface RelayV2HostRuntimeActualAuthorityInput {
  h0: Pick<RelayV2HostStateStore, "read">;
  h1: Pick<RelayV2HostCommandPlane, "execute" | "query" | "issueDedupeWindow">;
  h2: Pick<
    RelayV2MaterializedStateFoundation,
    "linearizeWelcome" | "scopesSnapshot" | "sessionsSnapshot" | "unsubscribe"
  >;
  snapshotSpool: Pick<RelayV2StateSnapshotSpool, "get" | "release">;
  h3: Pick<
    RelayV2TerminalManager,
    "open" | "requestReplay" | "acknowledgeOutput" | "input" | "resize" | "close" | "unbind"
  >;
  /** Synchronous local policy; no H0/H1 call is permitted from this callback. */
  nextDedupeWindowBounds(): { acceptUntilMs: number; queryUntilMs: number };
}

export interface RelayV2HostRuntimeAuthorityPorts {
  identity: RelayV2HostRuntimeIdentityPort;
  commands: RelayV2HostRuntimeCommandPort;
  resources: RelayV2HostRuntimeResourcePort;
  snapshots: RelayV2HostRuntimeSnapshotPort;
  terminals: RelayV2HostRuntimeTerminalPort;
}

/**
 * Unwired structural adapter for the actual H0/H1/H2/spool/H3 foundations.
 * It adds no authority, fallback, credential, executor, or transport policy.
 */
export function createRelayV2HostRuntimeAuthorityPorts(
  input: RelayV2HostRuntimeActualAuthorityInput,
): RelayV2HostRuntimeAuthorityPorts {
  return Object.freeze({
    identity: Object.freeze({
      current: async () => {
        const snapshot = await input.h0.read();
        return {
          hostEpoch: snapshot.hostEpoch,
          hostInstanceId: snapshot.hostInstanceId,
        };
      },
    }),
    commands: Object.freeze({
      execute: (auth: RelayV2CommandAuthContext, frame: RelayV2JsonObject) => (
        input.h1.execute(auth, frame)
      ),
      query: (auth: RelayV2CommandAuthContext, frame: RelayV2JsonObject) => (
        input.h1.query(auth, frame)
      ),
      issueDedupeWindow: () => input.h1.issueDedupeWindow(input.nextDedupeWindowBounds()),
    }),
    resources: Object.freeze({
      linearizeWelcome: (
        subscriberId: string,
        sink: RelayV2StateEventSink<RelayV2JsonObject>,
        buildWelcome: (cut: RelayV2WelcomeCut) => RelayV2JsonObject,
      ) => input.h2.linearizeWelcome(subscriberId, sink, buildWelcome),
      scopesSnapshot: (requestId: string, expectedHostEpoch: string) => (
        input.h2.scopesSnapshot(requestId, expectedHostEpoch)
      ),
      sessionsSnapshot: (
        requestId: string,
        expectedHostEpoch: string,
        scopeIds: readonly string[] | null,
      ) => input.h2.sessionsSnapshot(requestId, expectedHostEpoch, scopeIds),
      unsubscribe: (subscriberId: string) => input.h2.unsubscribe(subscriberId),
    }),
    snapshots: Object.freeze({
      get: (request: RelayV2StateSnapshotGet) => input.snapshotSpool.get(request),
      release: (request: RelayV2StateSnapshotRelease) => input.snapshotSpool.release(request),
    }),
    terminals: Object.freeze({
      open: (request: RelayV2TerminalOpenRequest) => input.h3.open(request),
      requestReplay: (request: RelayV2TerminalReplayRequest) => input.h3.requestReplay(request),
      acknowledgeOutput: (ack: RelayV2TerminalOutputAck) => input.h3.acknowledgeOutput(ack),
      input: (terminalInput: RelayV2TerminalInput) => input.h3.input(terminalInput),
      resize: (resize: RelayV2TerminalResize) => input.h3.resize(resize),
      close: (request: RelayV2TerminalCloseRequest) => input.h3.close(request),
      unbind: (auth: RelayV2TerminalAuthContext, route: RelayV2TerminalRoute) => (
        input.h3.unbind(auth, route)
      ),
    }),
  });
}

export type RelayV2HostRuntimeAuthorityErrorCode =
  | "BUSY"
  | "CAPABILITY_UNAVAILABLE"
  | "EVENT_CURSOR_AHEAD"
  | "HOST_EPOCH_MISMATCH"
  | "INTERNAL"
  | "INVALID_ARGUMENT"
  | "SCOPE_NOT_FOUND"
  | "SNAPSHOT_EXPIRED";

/** A typed serializer/adapter failure; its message is never sent to clients. */
export class RelayV2HostRuntimeAuthorityError extends Error {
  constructor(
    readonly code: RelayV2HostRuntimeAuthorityErrorCode,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super("Relay v2 host runtime authority adapter failed");
    this.name = "RelayV2HostRuntimeAuthorityError";
  }
}

type RequestOwner = "hello" | "command" | "resource" | "snapshot" | "terminal";

interface PendingRequest {
  requestId: string;
  owner: RequestOwner;
  requestType: string;
  allowedResponseTypes: ReadonlySet<string>;
  hostId: string;
  commandId: string | null;
  scopeId: string | null;
  sessionId: string | null;
  streamId: string | null;
}

interface OutboundItem {
  bytes: Uint8Array;
  receiptTimer: ReturnType<typeof setTimeout> | null;
  receiptSettled: boolean;
  admissionKnown: boolean;
  admitted: boolean;
  earlyReceipt: boolean | null;
}

interface RouteState {
  binding: RelayV2HostRouteBinding;
  authorityRoute: RelayV2HostRuntimeAuthorityRoute;
  auth: RelayV2CommandAuthContext;
  subscriberId: string;
  phase: "bound" | "hello_pending" | "ready" | "closing" | "closed";
  accepting: boolean;
  welcomeAccepted: boolean;
  terminalUnbound: boolean;
  closeSent: boolean;
  closeAfterDrain: RelayV2HostRuntimeClose | null;
  pendingOperations: number;
  pendingRequests: Map<string, PendingRequest>;
  outbound: OutboundItem[];
  outboundBytes: number;
  sending: boolean;
  validatingReceipt: boolean;
}

const CLIENT_FRAME_TYPES = new Set([
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

const TERMINAL_TYPES = new Set([
  "terminal.open",
  "terminal.output_ack",
  "terminal.replay_request",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
]);

const TERMINAL_OUTBOUND_EVENT_TYPES = new Set([
  "terminal.output",
  "terminal.input_ack",
  "terminal.input_error",
  "terminal.resize_ack",
  "terminal.resize_error",
]);

const RESPONSE_TYPES = new Map<string, ReadonlySet<string>>([
  ["client.hello", new Set(["host.welcome", "error"])],
  ["command.execute", new Set(["command.status", "error"])],
  ["command.query", new Set(["command.statuses", "error"])],
  ["scopes.snapshot.get", new Set(["scopes.snapshot", "error"])],
  ["sessions.snapshot.get", new Set(["sessions.snapshot", "error"])],
  ["state.snapshot.get", new Set(["state.snapshot.chunk", "error"])],
  ["state.snapshot.release", new Set(["state.snapshot.released", "error"])],
  ["terminal.open", new Set(["terminal.opened", "terminal.reset_required", "error"])],
  ["terminal.replay_request", new Set([
    "terminal.replay_started",
    "terminal.reset_required",
    "error",
  ])],
  ["terminal.close", new Set(["terminal.closed", "error"])],
]);

const AUTHORITY_ERROR_MESSAGES: Readonly<Record<RelayV2HostRuntimeAuthorityErrorCode, string>> = {
  BUSY: "Relay v2 authority is temporarily unavailable",
  CAPABILITY_UNAVAILABLE: "Relay v2 authority capability is unavailable",
  EVENT_CURSOR_AHEAD: "Client event cursor is ahead of the current host event sequence",
  HOST_EPOCH_MISMATCH: "Client targets a stale host lineage",
  INTERNAL: "Relay v2 authority failed",
  INVALID_ARGUMENT: "Relay v2 request is invalid",
  SCOPE_NOT_FOUND: "Relay v2 scope was not found",
  SNAPSHOT_EXPIRED: "Relay v2 snapshot is unavailable",
};

function positiveLimit(value: number | undefined, production: number, name: string): number {
  const selected = value ?? production;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > production) {
    throw new Error(`invalid or widened Relay v2 host runtime limit ${name}`);
  }
  return selected;
}

function resolveLimits(input: Partial<RuntimeLimits> = {}): RuntimeLimits {
  return Object.freeze({
    maxRoutes: positiveLimit(input.maxRoutes, RELAY_V2_HOST_RUNTIME_LIMITS.maxRoutes, "maxRoutes"),
    maxInFlightRequestsPerRoute: positiveLimit(
      input.maxInFlightRequestsPerRoute,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxInFlightRequestsPerRoute,
      "maxInFlightRequestsPerRoute",
    ),
    maxPendingOperationsPerRoute: positiveLimit(
      input.maxPendingOperationsPerRoute,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxPendingOperationsPerRoute,
      "maxPendingOperationsPerRoute",
    ),
    maxOutboundFramesPerRoute: positiveLimit(
      input.maxOutboundFramesPerRoute,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxOutboundFramesPerRoute,
      "maxOutboundFramesPerRoute",
    ),
    maxOutboundBytesPerRoute: positiveLimit(
      input.maxOutboundBytesPerRoute,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxOutboundBytesPerRoute,
      "maxOutboundBytesPerRoute",
    ),
    outboundReceiptTimeoutMs: positiveLimit(
      input.outboundReceiptTimeoutMs,
      RELAY_V2_HOST_RUNTIME_LIMITS.outboundReceiptTimeoutMs,
      "outboundReceiptTimeoutMs",
    ),
  });
}

function immutableBinding(binding: RelayV2HostRouteBinding): RelayV2HostRouteBinding {
  return Object.freeze({
    connectorGeneration: binding.connectorGeneration,
    connectorId: binding.connectorId,
    routeId: binding.routeId,
    routeFence: binding.routeFence,
    connectionId: binding.connectionId,
    clientDialect: binding.clientDialect,
    maxFrameBytes: binding.maxFrameBytes,
    authContext: Object.freeze({ ...binding.authContext }),
  });
}

function objectField(frame: RelayV2JsonObject, name: string): RelayV2JsonObject {
  return frame[name] as RelayV2JsonObject;
}

function stringField(frame: RelayV2JsonObject, name: string): string {
  return frame[name] as string;
}

function optionalString(frame: RelayV2JsonObject, name: string): string | null {
  return typeof frame[name] === "string" ? frame[name] as string : null;
}

function terminalAuth(route: RouteState): RelayV2TerminalAuthContext {
  return {
    principalId: route.auth.principalId,
    clientInstanceId: route.auth.clientInstanceId,
  };
}

function terminalTarget(frame: RelayV2JsonObject): {
  hostId: string;
  scopeId: string;
  sessionId: string;
} {
  return {
    hostId: stringField(frame, "hostId"),
    scopeId: stringField(frame, "scopeId"),
    sessionId: stringField(frame, "sessionId"),
  };
}

function exactCapabilityIntersection(
  value: RelayV2HostCapabilityIntersection,
): RelayV2RequiredCapability[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== RELAY_V2_REQUIRED_CAPABILITIES.length
    || keys.some((key) => !(RELAY_V2_REQUIRED_CAPABILITIES as readonly string[]).includes(key))) {
    return null;
  }
  return RELAY_V2_REQUIRED_CAPABILITIES.every((capability) => value[capability] === true)
    ? [...RELAY_V2_REQUIRED_CAPABILITIES]
    : [];
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128;
}

function isCounter(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function requestOwner(type: string): RequestOwner {
  if (type === "client.hello") return "hello";
  if (type === "command.execute" || type === "command.query") return "command";
  if (type === "scopes.snapshot.get" || type === "sessions.snapshot.get") return "resource";
  if (type === "state.snapshot.get" || type === "state.snapshot.release") return "snapshot";
  return "terminal";
}

function pendingRequest(frame: RelayV2JsonObject): PendingRequest {
  const type = stringField(frame, "type");
  const allowed = RESPONSE_TYPES.get(type);
  if (!allowed) throw new Error("Relay v2 request has no response owner");
  return Object.freeze({
    requestId: stringField(frame, "requestId"),
    owner: requestOwner(type),
    requestType: type,
    allowedResponseTypes: allowed,
    hostId: optionalString(frame, "hostId") ?? "",
    commandId: optionalString(frame, "commandId"),
    scopeId: optionalString(frame, "scopeId"),
    sessionId: optionalString(frame, "sessionId"),
    streamId: optionalString(frame, "streamId"),
  });
}

function structuredAuthorityError(error: unknown): {
  code: RelayV2HostRuntimeAuthorityErrorCode;
  details: Readonly<Record<string, unknown>> | null;
} | null {
  if (error instanceof RelayV2HostRuntimeAuthorityError
    || error instanceof RelayV2MaterializedStateError
    || error instanceof RelayV2StateSnapshotSpoolError) {
    const code = error.code as RelayV2HostRuntimeAuthorityErrorCode;
    if (!Object.hasOwn(AUTHORITY_ERROR_MESSAGES, code)) return null;
    return { code, details: error.details };
  }
  return null;
}

function exactErrorDetails(
  code: RelayV2HostRuntimeAuthorityErrorCode,
  details: Readonly<Record<string, unknown>> | null,
): RelayV2JsonObject | null {
  if (code === "HOST_EPOCH_MISMATCH") {
    if (!details
      || !isOpaque(details.expectedHostEpoch)
      || !isOpaque(details.actualHostEpoch)
      || Object.keys(details).length !== 2) return null;
    return {
      expectedHostEpoch: details.expectedHostEpoch,
      actualHostEpoch: details.actualHostEpoch,
    };
  }
  if (code === "EVENT_CURSOR_AHEAD") {
    if (!details
      || !isCounter(details.clientLastEventSeq)
      || !isCounter(details.hostEventSeq)
      || Object.keys(details).length !== 2) return null;
    return {
      clientLastEventSeq: details.clientLastEventSeq,
      hostEventSeq: details.hostEventSeq,
    };
  }
  return null;
}

function snapshotChunkFrame(
  hostId: string,
  requestId: string,
  chunk: RelayV2StateSnapshotChunk,
): RelayV2JsonObject {
  const { hostEpoch, ...payload } = chunk;
  return {
    protocolVersion: 2,
    kind: "response",
    type: "state.snapshot.chunk",
    requestId,
    hostId,
    hostEpoch,
    payload: structuredClone(payload) as unknown as RelayV2JsonObject,
  };
}

function snapshotReleasedFrame(
  hostId: string,
  requestId: string,
  released: RelayV2StateSnapshotReleased,
): RelayV2JsonObject {
  const { hostEpoch, ...payload } = released;
  return {
    protocolVersion: 2,
    kind: "response",
    type: "state.snapshot.released",
    requestId,
    hostId,
    hostEpoch,
    payload: structuredClone(payload) as unknown as RelayV2JsonObject,
  };
}

/**
 * Unwired host route/runtime composition foundation. It owns v2 public frame
 * dispatch, exact route fencing, readiness withdrawal and bounded delivery;
 * every business transition remains in H0/H1/H2/spool/H3.
 */
export class RelayV2HostRuntime implements RelayV2HostCarrierRouteSink {
  readonly limits: RuntimeLimits;

  private readonly routesByCarrierKey = new Map<string, RouteState>();
  private readonly routesByRuntimeId = new Map<string, RouteState>();
  private readonly readinessSubscription: RelayV2HostReadinessSubscription;
  private activeCapabilities: readonly RelayV2RequiredCapability[] | null = null;
  private readinessObserved = false;
  private nextBindingId = 0;

  constructor(private readonly options: RelayV2HostRuntimeOptions) {
    for (const [name, value] of [
      ["hostId", options.hostId],
      ["hostEpoch", options.hostEpoch],
      ["hostInstanceId", options.hostInstanceId],
    ] as const) {
      if (!isOpaque(value)) throw new Error(`Relay v2 host runtime ${name} is invalid`);
    }
    this.limits = resolveLimits(options.testLimits);
    const sink: RelayV2HostReadinessSink = Object.freeze({
      apply: (snapshot) => this.applyReadiness(snapshot),
      close: () => this.withdrawReadiness(),
    });
    this.readinessSubscription = options.capabilityIntersection.subscribe(sink);
    if (!this.readinessObserved
      || !this.readinessSubscription
      || typeof this.readinessSubscription.unsubscribe !== "function") {
      try { this.readinessSubscription?.unsubscribe(); } catch {}
      throw new Error("Relay v2 readiness source did not synchronously establish bounded state");
    }
  }

  advertisedCapabilities(): RelayV2RequiredCapability[] {
    return this.activeCapabilities === null ? [] : [...this.activeCapabilities];
  }

  dispose(): void {
    this.activeCapabilities = null;
    for (const route of [...this.routesByCarrierKey.values()]) {
      this.closeImmediately(route, { code: 1013, reason: "host_shutdown" });
    }
    try { this.readinessSubscription.unsubscribe(); } catch {}
  }

  onRouteBound(input: RelayV2HostRouteBinding): void {
    if (input.clientDialect !== "tw-relay.v2"
      || input.authContext.scheme !== "twcap2"
      || input.authContext.role !== "client"
      || input.authContext.hostId !== this.options.hostId) {
      this.closeBinding(input, { code: 4406, reason: "route_unavailable" });
      return;
    }
    if (this.activeCapabilities === null
      || this.activeCapabilities.length !== RELAY_V2_REQUIRED_CAPABILITIES.length) {
      this.closeBinding(input, { code: 4406, reason: "capability_withdrawn" });
      return;
    }
    if (this.routesByCarrierKey.size >= this.limits.maxRoutes) {
      this.closeBinding(input, { code: 1013, reason: "slow_consumer" });
      return;
    }
    const binding = immutableBinding(input);
    const key = this.carrierKey(binding);
    if (this.routesByCarrierKey.has(key)) {
      this.closeBinding(binding, { code: 4400, reason: "protocol_error" });
      return;
    }
    const runtimeBindingId = `host-route-${++this.nextBindingId}`;
    const authorityRoute = Object.freeze({
      connectorId: binding.connectorId,
      routeId: binding.routeId,
      routeFence: binding.routeFence,
      runtimeBindingId,
    });
    const route: RouteState = {
      binding,
      authorityRoute,
      auth: Object.freeze({
        principalId: input.authContext.principalId,
        clientInstanceId: input.authContext.clientInstanceId,
        hostId: input.authContext.hostId,
      }),
      subscriberId: runtimeBindingId,
      phase: "bound",
      accepting: true,
      welcomeAccepted: false,
      terminalUnbound: false,
      closeSent: false,
      closeAfterDrain: null,
      pendingOperations: 0,
      pendingRequests: new Map(),
      outbound: [],
      outboundBytes: 0,
      sending: false,
      validatingReceipt: false,
    };
    this.routesByCarrierKey.set(key, route);
    this.routesByRuntimeId.set(runtimeBindingId, route);
  }

  onClientFrame(binding: RelayV2HostRouteBinding, payload: Uint8Array): void {
    const route = this.currentRoute(binding);
    if (!route || !this.isAdmitted(route)) return;
    const inboundLimit = Math.min(MAX_PUBLIC_FRAME_BYTES, route.binding.maxFrameBytes);
    if (payload.byteLength > inboundLimit) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }

    let frame: RelayV2JsonObject;
    try {
      frame = decodeRelayV2WebSocketFrame("public", payload, {
        opcode: "text",
        compressed: false,
      }).frame;
    } catch {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }
    const type = stringField(frame, "type");
    if (!CLIENT_FRAME_TYPES.has(type)) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }
    if (type === "client.hello") {
      if (route.phase !== "bound") {
        this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
        return;
      }
      route.phase = "hello_pending";
    }

    const isRequest = frame.kind === "request";
    let pending: PendingRequest | null = null;
    if (isRequest) {
      try { pending = pendingRequest(frame); } catch {
        this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
        return;
      }
      if (route.pendingRequests.has(pending.requestId)) {
        this.drainLocalError(
          route,
          pending,
          "INVALID_ARGUMENT",
          "Relay v2 requestId is already in flight",
          false,
          { code: 4400, reason: "protocol_error" },
        );
        return;
      }
      if (route.pendingRequests.size >= this.limits.maxInFlightRequestsPerRoute) {
        if (!this.enqueueError(
          route,
          pending,
          "BUSY",
          "Relay v2 route request capacity is exhausted",
          true,
        )) this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
        return;
      }
    }
    if (route.pendingOperations >= this.limits.maxPendingOperationsPerRoute) {
      if (pending && this.enqueueError(
        route,
        pending,
        "BUSY",
        "Relay v2 route operation capacity is exhausted",
        true,
      )) return;
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      return;
    }

    route.pendingOperations += 1;
    if (pending) route.pendingRequests.set(pending.requestId, pending);
    void this.dispatch(route, frame, pending).catch((error) => {
      this.handleAuthorityFailure(route, pending, error);
    }).finally(() => {
      route.pendingOperations = Math.max(0, route.pendingOperations - 1);
      if (pending && route.pendingRequests.get(pending.requestId) === pending) {
        route.pendingRequests.delete(pending.requestId);
      }
    });
  }

  onRouteClosing(binding: RelayV2HostRouteBinding): void {
    const route = this.currentRoute(binding);
    if (route) {
      route.phase = "closing";
      route.closeSent = true;
      this.fenceAdmission(route, false);
    }
  }

  onRouteUnbound(
    binding: RelayV2HostRouteBinding,
    _reason: RelayV2HostLocalUnbindReason,
  ): void {
    const route = this.currentRoute(binding);
    if (route) this.fenceAdmission(route, true);
  }

  /** H3's send callback. Exact process binding and current H0 identity are rechecked. */
  async sendTerminalFrame(
    authorityRoute: RelayV2HostRuntimeAuthorityRoute,
    frame: RelayV2JsonObject,
  ): Promise<void> {
    const route = this.routesByRuntimeId.get(authorityRoute.runtimeBindingId);
    if (!route
      || route.authorityRoute !== authorityRoute
      || route.phase !== "ready"
      || !this.isAdmitted(route)) {
      throw new Error("Relay v2 terminal callback targets a stale route binding");
    }
    const identity = await this.verifyCurrentIdentity(route, null, true);
    if (!identity) throw new Error("Relay v2 terminal callback lost its route fence");
    if (frame.kind === "response") {
      const requestId = optionalString(frame, "requestId");
      const pending = requestId === null ? undefined : route.pendingRequests.get(requestId);
      if (!pending || pending.owner !== "terminal") {
        throw new Error("Relay v2 terminal callback is not owned by a terminal request");
      }
      this.assertCorrelatedResponse(route, pending, frame, identity);
    } else if (frame.kind === "event") {
      if (!TERMINAL_OUTBOUND_EVENT_TYPES.has(String(frame.type))) {
        throw new Error("Relay v2 terminal callback returned another authority's event");
      }
      this.assertRouteFrameIdentity(route, frame, identity);
    } else {
      throw new Error("Relay v2 terminal callback returned an invalid frame kind");
    }
    if (!this.enqueueOutbound(route, frame)) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      throw new Error("Relay v2 terminal callback exceeded bounded route capacity");
    }
    const afterCallback = await this.verifyCurrentIdentity(route, null, true);
    if (!afterCallback) throw new Error("Relay v2 terminal callback lost its post-send fence");
  }

  private applyReadiness(snapshot: RelayV2HostReadinessSnapshot): boolean {
    this.readinessObserved = true;
    const capabilities = snapshot
      && isOpaque(snapshot.generation)
      ? exactCapabilityIntersection(snapshot.capabilities)
      : null;
    if (capabilities === null) {
      this.withdrawReadiness();
      return false;
    }
    if (capabilities.length !== RELAY_V2_REQUIRED_CAPABILITIES.length) {
      this.withdrawReadiness();
      return true;
    }
    this.activeCapabilities = Object.freeze(capabilities);
    return true;
  }

  private withdrawReadiness(): void {
    this.readinessObserved = true;
    this.activeCapabilities = null;
    for (const route of [...this.routesByCarrierKey.values()]) {
      this.closeImmediately(route, { code: 4406, reason: "capability_withdrawn" });
    }
  }

  private async dispatch(
    route: RouteState,
    frame: RelayV2JsonObject,
    pending: PendingRequest | null,
  ): Promise<void> {
    const identity = await this.verifyCurrentIdentity(route, pending, false);
    if (!identity) return;
    if (Object.hasOwn(frame, "hostId") && frame.hostId !== route.auth.hostId) {
      if (pending) {
        this.drainLocalError(
          route,
          pending,
          "PERMISSION_DENIED",
          "Frame host authorization does not match the route binding",
          false,
          { code: 4400, reason: "protocol_error" },
        );
      } else this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }
    if (Object.hasOwn(frame, "expectedHostEpoch")
      && frame.expectedHostEpoch !== identity.hostEpoch) {
      if (pending) this.drainEpochMismatch(route, pending, String(frame.expectedHostEpoch), identity.hostEpoch);
      else this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }

    const type = stringField(frame, "type");
    if (type === "client.hello") {
      await this.dispatchHello(route, frame, pending!, identity);
      return;
    }
    if (route.phase !== "ready" || !this.isAdmitted(route)) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }

    switch (type) {
      case "command.execute": {
        const response = await this.options.commands.execute(route.auth, frame);
        const current = await this.verifyCurrentIdentity(route, pending, true);
        if (current) this.sendReturned(route, pending!, response, current);
        return;
      }
      case "command.query": {
        const response = await this.options.commands.query(route.auth, frame);
        const current = await this.verifyCurrentIdentity(route, pending, true);
        if (current) this.sendReturned(route, pending!, response, current);
        return;
      }
      case "scopes.snapshot.get": {
        const response = await this.options.resources.scopesSnapshot(
          pending!.requestId,
          stringField(frame, "expectedHostEpoch"),
        );
        const current = await this.verifyCurrentIdentity(route, pending, true);
        if (current) this.sendReturned(route, pending!, response, current);
        return;
      }
      case "sessions.snapshot.get": {
        const scopeIds = objectField(frame, "payload").scopeIds as string[] | null;
        const response = await this.options.resources.sessionsSnapshot(
          pending!.requestId,
          stringField(frame, "expectedHostEpoch"),
          scopeIds === null ? null : [...scopeIds],
        );
        const current = await this.verifyCurrentIdentity(route, pending, true);
        if (current) this.sendReturned(route, pending!, response, current);
        return;
      }
      case "state.snapshot.get": {
        const payload = objectField(frame, "payload");
        const chunk = await this.options.snapshots.get({
          principalId: route.auth.principalId,
          clientInstanceId: route.auth.clientInstanceId,
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          snapshotRequestId: stringField(payload, "snapshotRequestId"),
          snapshotId: payload.snapshotId as string | null,
          cursor: payload.cursor as string | null,
          nextChunkIndex: payload.nextChunkIndex as number,
        });
        const current = await this.verifyCurrentIdentity(route, pending, true);
        if (current) this.sendReturned(
          route,
          pending!,
          snapshotChunkFrame(this.options.hostId, pending!.requestId, chunk),
          current,
        );
        return;
      }
      case "state.snapshot.release": {
        const payload = objectField(frame, "payload");
        const released = await this.options.snapshots.release({
          principalId: route.auth.principalId,
          clientInstanceId: route.auth.clientInstanceId,
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          snapshotRequestId: stringField(payload, "snapshotRequestId"),
          snapshotId: stringField(payload, "snapshotId"),
          reason: stringField(payload, "reason") as "completed" | "abandoned",
        });
        const current = await this.verifyCurrentIdentity(route, pending, true);
        if (current) this.sendReturned(
          route,
          pending!,
          snapshotReleasedFrame(this.options.hostId, pending!.requestId, released),
          current,
        );
        return;
      }
      default:
        if (!TERMINAL_TYPES.has(type)) {
          this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
          return;
        }
        await this.dispatchTerminal(route, frame);
        await this.verifyCurrentIdentity(route, pending, true);
    }
  }

  private async dispatchHello(
    route: RouteState,
    frame: RelayV2JsonObject,
    pending: PendingRequest,
    identity: RelayV2HostRuntimeIdentity,
  ): Promise<void> {
    if (route.phase !== "hello_pending" || !this.isAdmitted(route)) return;
    const payload = objectField(frame, "payload");
    if (payload.clientInstanceId !== route.auth.clientInstanceId) {
      this.drainLocalError(
        route,
        pending,
        "PERMISSION_DENIED",
        "clientInstanceId does not match the authenticated route",
        false,
        { code: 4400, reason: "protocol_error" },
      );
      return;
    }
    const available = this.advertisedCapabilities();
    const offered = payload.capabilities as string[];
    const required = payload.requiredCapabilities as string[];
    if (available.length !== RELAY_V2_REQUIRED_CAPABILITIES.length
      || RELAY_V2_REQUIRED_CAPABILITIES.some((capability) => !offered.includes(capability))
      || required.some((capability) => !available.includes(capability as RelayV2RequiredCapability))) {
      this.drainLocalError(
        route,
        pending,
        "CAPABILITY_UNAVAILABLE",
        "Relay v2 base capability intersection is incomplete",
        false,
        { code: 4406, reason: "route_unavailable" },
      );
      return;
    }

    const commandDedupeWindow = await this.options.commands.issueDedupeWindow();
    const afterWindow = await this.verifyCurrentIdentity(route, pending, true);
    if (!afterWindow || afterWindow.hostEpoch !== identity.hostEpoch) return;
    if (!this.isAdmitted(route)) return;

    const sink: RelayV2StateEventSink<RelayV2JsonObject> = Object.freeze({
      enqueue: (outbound: RelayV2JsonObject) => this.enqueueResourceEvent(route, pending, outbound),
      close: (error: RelayV2MaterializedStateError) => {
        if (!this.isCurrent(route)) return;
        const close = error.code === "CAPABILITY_UNAVAILABLE"
          ? { code: 4406, reason: "capability_withdrawn" } as const
          : error.code === "BUSY"
            ? { code: 1013, reason: "slow_consumer" } as const
            : { code: 4400, reason: "protocol_error" } as const;
        this.closeImmediately(route, close);
      },
    });
    await this.options.resources.linearizeWelcome(
      route.subscriberId,
      sink,
      (cut) => {
        if (!this.isAdmitted(route)
          || cut.hostEpoch !== identity.hostEpoch
          || cut.hostInstanceId !== identity.hostInstanceId) {
          throw new RelayV2HostRuntimeAuthorityError("HOST_EPOCH_MISMATCH", {
            expectedHostEpoch: identity.hostEpoch,
            actualHostEpoch: cut.hostEpoch,
          });
        }
        const welcome = this.options.welcome.build({
          hello: structuredClone(frame),
          cut: structuredClone(cut),
          commandDedupeWindow: structuredClone(commandDedupeWindow),
          capabilities: [...available],
        });
        if (welcome && typeof (welcome as { then?: unknown }).then === "function") {
          throw new RelayV2HostRuntimeAuthorityError("INTERNAL");
        }
        return welcome;
      },
    );
    const afterWelcome = await this.verifyCurrentIdentity(route, pending, true);
    if (!afterWelcome) return;
    if (!route.welcomeAccepted) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
    }
  }

  private enqueueResourceEvent(
    route: RouteState,
    hello: PendingRequest,
    frame: RelayV2JsonObject,
  ): boolean {
    if (!this.isAdmitted(route)) return false;
    if (!route.welcomeAccepted) {
      const payload = frame.payload as RelayV2JsonObject | undefined;
      if (route.phase !== "hello_pending"
        || frame.type !== "host.welcome"
        || frame.kind !== "response"
        || frame.requestId !== hello.requestId
        || frame.hostId !== this.options.hostId
        || frame.hostEpoch !== this.options.hostEpoch
        || frame.hostInstanceId !== this.options.hostInstanceId
        || !payload
        || !Array.isArray(payload.capabilities)
        || payload.capabilities.length !== RELAY_V2_REQUIRED_CAPABILITIES.length
        || RELAY_V2_REQUIRED_CAPABILITIES.some((capability) => (
          !(payload.capabilities as string[]).includes(capability)
        ))) {
        this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
        return false;
      }
      route.welcomeAccepted = true;
      route.phase = "ready";
    } else if (frame.type === "host.welcome"
      || (frame.type !== "scopes.changed" && frame.type !== "sessions.changed")
      || frame.hostId !== route.auth.hostId
      || frame.hostEpoch !== this.options.hostEpoch) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return false;
    }
    if (!this.isAdmitted(route) || !this.enqueueOutbound(route, frame)) {
      if (this.isCurrent(route)) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      }
      return false;
    }
    void this.verifyCurrentIdentity(route, null, true);
    return true;
  }

  private async dispatchTerminal(route: RouteState, frame: RelayV2JsonObject): Promise<void> {
    const common = {
      auth: terminalAuth(route),
      route: route.authorityRoute,
      streamId: stringField(frame, "streamId"),
    };
    const type = stringField(frame, "type");
    const payload = objectField(frame, "payload");
    switch (type) {
      case "terminal.open": {
        const resume = Object.hasOwn(payload, "resume") ? objectField(payload, "resume") : undefined;
        await this.options.terminals.open({
          ...common,
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          target: terminalTarget(frame),
          openId: stringField(payload, "openId"),
          pane: payload.pane as number,
          cols: payload.cols as number,
          rows: payload.rows as number,
          mode: stringField(payload, "mode") as "new" | "resume" | "reset",
          ...(resume === undefined ? {} : {
            resume: {
              generation: stringField(resume, "generation"),
              nextOffset: stringField(resume, "nextOffset"),
              resumeToken: stringField(resume, "resumeToken"),
            },
          }),
        });
        return;
      }
      case "terminal.replay_request":
        await this.options.terminals.requestReplay({
          ...common,
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          target: terminalTarget(frame),
          generation: stringField(payload, "generation"),
          fromOffset: stringField(payload, "fromOffset"),
        });
        return;
      case "terminal.close":
        await this.options.terminals.close({
          ...common,
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          target: terminalTarget(frame),
          closeId: stringField(payload, "closeId"),
          generation: stringField(payload, "generation"),
          resumeToken: stringField(payload, "resumeToken"),
        });
        return;
      case "terminal.output_ack":
        await this.options.terminals.acknowledgeOutput({
          ...common,
          generation: stringField(payload, "generation"),
          nextOffset: stringField(payload, "nextOffset"),
        });
        return;
      case "terminal.input":
        await this.options.terminals.input({
          ...common,
          generation: stringField(payload, "generation"),
          inputSeq: stringField(payload, "inputSeq"),
          data: Uint8Array.from(Buffer.from(stringField(payload, "data"), "base64")),
        });
        return;
      case "terminal.resize":
        await this.options.terminals.resize({
          ...common,
          generation: stringField(payload, "generation"),
          resizeSeq: stringField(payload, "resizeSeq"),
          cols: payload.cols as number,
          rows: payload.rows as number,
        });
    }
  }

  private sendReturned(
    route: RouteState,
    pending: PendingRequest,
    response: RelayV2JsonObject,
    identity: RelayV2HostRuntimeIdentity,
  ): void {
    if (!this.isAdmitted(route)) return;
    this.assertCorrelatedResponse(route, pending, response, identity);
    if (!this.enqueueOutbound(route, response)) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
    }
  }

  private assertCorrelatedResponse(
    route: RouteState,
    pending: PendingRequest,
    response: RelayV2JsonObject,
    identity: RelayV2HostRuntimeIdentity,
  ): void {
    if (response.kind !== "response"
      || response.requestId !== pending.requestId
      || !pending.allowedResponseTypes.has(String(response.type))) {
      throw new Error("Relay v2 authority returned an unowned response");
    }
    this.assertRouteFrameIdentity(route, response, identity);
    for (const [field, expected] of [
      ["commandId", pending.commandId],
      ["scopeId", pending.scopeId],
      ["sessionId", pending.sessionId],
      ["streamId", pending.streamId],
    ] as const) {
      if (expected !== null && response[field] !== expected) {
        throw new Error(`Relay v2 authority response ${field} does not match its request owner`);
      }
    }
  }

  private assertRouteFrameIdentity(
    route: RouteState,
    frame: RelayV2JsonObject,
    identity: RelayV2HostRuntimeIdentity,
  ): void {
    if (frame.hostId !== route.auth.hostId
      || frame.hostEpoch !== identity.hostEpoch
      || (Object.hasOwn(frame, "hostInstanceId")
        && frame.hostInstanceId !== identity.hostInstanceId)) {
      throw new Error("Relay v2 authority frame crossed its host identity fence");
    }
  }

  private handleAuthorityFailure(
    route: RouteState,
    pending: PendingRequest | null,
    error: unknown,
  ): void {
    if (!this.isCurrent(route)) return;
    // H1/H3 may already have crossed a mutation boundary. A thrown error can
    // never be converted into not_accepted, retryable, or an invented result.
    if (!pending || pending.owner === "command" || pending.owner === "terminal") {
      this.closeImmediately(route, { code: 1013, reason: "authority_failure" });
      return;
    }
    const structured = structuredAuthorityError(error);
    if (!structured) {
      this.closeImmediately(route, { code: 1013, reason: "authority_failure" });
      return;
    }
    if (structured.code === "INTERNAL") {
      this.closeImmediately(route, { code: 1013, reason: "authority_failure" });
      return;
    }
    const exactDetails = exactErrorDetails(structured.code, structured.details);
    if ((structured.code === "HOST_EPOCH_MISMATCH"
      || structured.code === "EVENT_CURSOR_AHEAD") && exactDetails === null) {
      this.closeImmediately(route, { code: 1013, reason: "authority_failure" });
      return;
    }
    const actualHostEpoch = structured.code === "HOST_EPOCH_MISMATCH"
      ? stringField(exactDetails!, "actualHostEpoch")
      : this.options.hostEpoch;
    const close = structured.code === "EVENT_CURSOR_AHEAD"
      ? { code: 4400, reason: "event_cursor_ahead" } as const
      : structured.code === "HOST_EPOCH_MISMATCH"
        ? { code: 4400, reason: "protocol_error" } as const
        : structured.code === "CAPABILITY_UNAVAILABLE"
          ? { code: 4406, reason: "route_unavailable" } as const
          : pending.owner === "hello"
            ? { code: 1013, reason: "authority_failure" } as const
            : null;
    if (close) {
      this.drainLocalError(
        route,
        pending,
        structured.code,
        AUTHORITY_ERROR_MESSAGES[structured.code],
        structured.code === "BUSY",
        close,
        exactDetails,
        actualHostEpoch,
      );
    } else if (!this.enqueueError(
      route,
      pending,
      structured.code,
      AUTHORITY_ERROR_MESSAGES[structured.code],
      structured.code === "BUSY",
      false,
      exactDetails,
      actualHostEpoch,
    )) this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
  }

  private enqueueError(
    route: RouteState,
    pending: PendingRequest,
    code: string,
    message: string,
    retryable: boolean,
    allowClosing = false,
    details: RelayV2JsonObject | null = null,
    actualHostEpoch = this.options.hostEpoch,
  ): boolean {
    const frame: RelayV2JsonObject = {
      protocolVersion: 2,
      kind: "response",
      type: "error",
      requestId: pending.requestId,
      ...(pending.commandId === null ? {} : { commandId: pending.commandId }),
      ...(pending.hostId.length === 0 ? {} : { hostId: pending.hostId }),
      hostEpoch: actualHostEpoch,
      ...(pending.scopeId === null ? {} : { scopeId: pending.scopeId }),
      ...(pending.sessionId === null ? {} : { sessionId: pending.sessionId }),
      ...(pending.streamId === null ? {} : { streamId: pending.streamId }),
      payload: null,
      error: {
        code,
        message,
        retryable,
        retryAfterMs: retryable ? 0 : null,
        commandDisposition: pending.owner === "command" ? "not_accepted" : "not_applicable",
        details,
      },
    };
    return this.enqueueOutbound(route, frame, allowClosing);
  }

  private drainEpochMismatch(
    route: RouteState,
    pending: PendingRequest,
    expectedHostEpoch: string,
    actualHostEpoch: string,
  ): void {
    this.drainLocalError(
      route,
      pending,
      "HOST_EPOCH_MISMATCH",
      AUTHORITY_ERROR_MESSAGES.HOST_EPOCH_MISMATCH,
      false,
      { code: 4400, reason: "protocol_error" },
      { expectedHostEpoch, actualHostEpoch },
      actualHostEpoch,
    );
  }

  private drainLocalError(
    route: RouteState,
    pending: PendingRequest,
    code: string,
    message: string,
    retryable: boolean,
    close: RelayV2HostRuntimeClose,
    details: RelayV2JsonObject | null = null,
    actualHostEpoch = this.options.hostEpoch,
  ): void {
    route.accepting = false;
    route.phase = "closing";
    route.closeAfterDrain = close;
    if (!this.enqueueError(
      route,
      pending,
      code,
      message,
      retryable,
      true,
      details,
      actualHostEpoch,
    )) this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
  }

  private async verifyCurrentIdentity(
    route: RouteState,
    pending: PendingRequest | null,
    ownerInvoked: boolean,
    allowClosing = false,
  ): Promise<RelayV2HostRuntimeIdentity | null> {
    let identity: RelayV2HostRuntimeIdentity;
    try {
      identity = await this.options.identity.current();
    } catch {
      if (this.isCurrent(route)) {
        this.closeImmediately(route, { code: 1013, reason: "authority_failure" });
      }
      return null;
    }
    if (!this.isCurrent(route)
      || this.activeCapabilities === null
      || (!route.accepting && !allowClosing)) return null;
    if (!identity
      || identity.hostEpoch !== this.options.hostEpoch
      || identity.hostInstanceId !== this.options.hostInstanceId) {
      if (!ownerInvoked && pending && isOpaque(identity?.hostEpoch)) {
        this.drainEpochMismatch(route, pending, this.options.hostEpoch, identity.hostEpoch);
      } else {
        this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      }
      return null;
    }
    return identity;
  }

  private enqueueOutbound(
    route: RouteState,
    frame: RelayV2JsonObject,
    allowClosing = false,
  ): boolean {
    if (!this.isCurrent(route)
      || (!route.accepting && !allowClosing)
      || route.phase === "closed") return false;
    let bytes: Uint8Array;
    try {
      bytes = encodeRelayV2WebSocketFrame("public", frame);
    } catch {
      return false;
    }
    if (bytes.byteLength > Math.min(MAX_PUBLIC_FRAME_BYTES, route.binding.maxFrameBytes)
      || route.outbound.length >= this.limits.maxOutboundFramesPerRoute
      || route.outboundBytes > this.limits.maxOutboundBytesPerRoute - bytes.byteLength) {
      return false;
    }
    route.outbound.push({
      bytes,
      receiptTimer: null,
      receiptSettled: false,
      admissionKnown: false,
      admitted: false,
      earlyReceipt: null,
    });
    route.outboundBytes += bytes.byteLength;
    this.flushOutbound(route);
    return true;
  }

  private flushOutbound(route: RouteState): void {
    if (route.sending || route.validatingReceipt || !this.isCurrent(route)) return;
    const item = route.outbound[0];
    if (!item) {
      if (route.closeAfterDrain) this.finishClose(route, route.closeAfterDrain);
      return;
    }
    route.sending = true;
    const receipt: RelayV2HostRuntimeOutboundReceipt = Object.freeze({
      settle: (accepted: boolean) => {
        if (item.receiptSettled) return;
        if (!item.admissionKnown) {
          item.earlyReceipt = accepted === true;
          return;
        }
        this.outboundSettled(route, item, accepted === true);
      },
    });
    let admitted = false;
    try {
      admitted = this.options.outbound.trySend(route.binding, item.bytes.slice(), receipt) === true;
    } catch {
      admitted = false;
    }
    item.admissionKnown = true;
    item.admitted = admitted;
    if (!admitted) {
      this.outboundSettled(route, item, false);
      return;
    }
    if (item.earlyReceipt !== null) {
      this.outboundSettled(route, item, item.earlyReceipt);
      return;
    }
    item.receiptTimer = setTimeout(() => {
      this.outboundSettled(route, item, false);
    }, this.limits.outboundReceiptTimeoutMs);
    item.receiptTimer.unref?.();
  }

  private outboundSettled(route: RouteState, item: OutboundItem, accepted: boolean): void {
    if (item.receiptSettled || route.outbound[0] !== item) return;
    item.receiptSettled = true;
    if (item.receiptTimer) clearTimeout(item.receiptTimer);
    route.outbound.shift();
    route.outboundBytes -= item.bytes.byteLength;
    route.sending = false;
    if (!accepted) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      return;
    }
    route.validatingReceipt = true;
    void this.verifyCurrentIdentity(route, null, true, true).then((identity) => {
      route.validatingReceipt = false;
      if (!this.isCurrent(route)) return;
      if (!identity) {
        if (route.closeAfterDrain) this.finishClose(route, route.closeAfterDrain);
        return;
      }
      this.flushOutbound(route);
    });
  }

  private closeImmediately(route: RouteState, close: RelayV2HostRuntimeClose): void {
    if (route.phase === "closed") return;
    this.fenceAdmission(route, false);
    this.finishClose(route, close);
  }

  private finishClose(route: RouteState, close: RelayV2HostRuntimeClose): void {
    if (route.phase === "closed" || route.closeSent) return;
    route.phase = "closing";
    route.closeSent = true;
    this.clearOutbound(route);
    this.closeBinding(route.binding, close);
  }

  private closeBinding(binding: RelayV2HostRouteBinding, close: RelayV2HostRuntimeClose): void {
    try { this.options.outbound.close(binding, close); } catch {}
  }

  private fenceAdmission(route: RouteState, remove: boolean): void {
    route.accepting = false;
    route.closeAfterDrain = null;
    if (remove) route.phase = "closed";
    try { this.options.resources.unsubscribe(route.subscriberId); } catch {}
    if (!route.terminalUnbound) {
      route.terminalUnbound = true;
      try {
        void this.options.terminals.unbind(terminalAuth(route), route.authorityRoute)
          .catch(() => undefined);
      } catch {}
    }
    this.clearOutbound(route);
    if (remove) {
      this.routesByCarrierKey.delete(this.carrierKey(route.binding));
      this.routesByRuntimeId.delete(route.authorityRoute.runtimeBindingId);
    }
  }

  private clearOutbound(route: RouteState): void {
    for (const item of route.outbound) {
      if (item.receiptTimer) clearTimeout(item.receiptTimer);
      item.receiptSettled = true;
    }
    route.outbound = [];
    route.outboundBytes = 0;
    route.sending = false;
    route.validatingReceipt = false;
  }

  private currentRoute(binding: RelayV2HostRouteBinding): RouteState | undefined {
    const route = this.routesByCarrierKey.get(this.carrierKey(binding));
    if (!route || route.phase === "closed") return undefined;
    const frozen = route.binding;
    if (binding.connectorGeneration !== frozen.connectorGeneration
      || binding.connectorId !== frozen.connectorId
      || binding.routeId !== frozen.routeId
      || binding.routeFence !== frozen.routeFence
      || binding.connectionId !== frozen.connectionId
      || binding.clientDialect !== frozen.clientDialect
      || binding.maxFrameBytes !== frozen.maxFrameBytes
      || binding.authContext.scheme !== "twcap2"
      || binding.authContext.role !== frozen.authContext.role
      || binding.authContext.principalId !== route.auth.principalId
      || binding.authContext.clientInstanceId !== route.auth.clientInstanceId
      || binding.authContext.hostId !== route.auth.hostId
      || binding.authContext.grantId !== frozen.authContext.grantId
      || binding.authContext.jti !== frozen.authContext.jti
      || binding.authContext.kid !== frozen.authContext.kid
      || binding.authContext.expiresAtMs !== frozen.authContext.expiresAtMs) return undefined;
    return route;
  }

  private isCurrent(route: RouteState): boolean {
    return route.phase !== "closed"
      && this.routesByCarrierKey.get(this.carrierKey(route.binding)) === route
      && this.routesByRuntimeId.get(route.authorityRoute.runtimeBindingId) === route;
  }

  private isAdmitted(route: RouteState): boolean {
    return route.accepting
      && this.activeCapabilities !== null
      && this.activeCapabilities.length === RELAY_V2_REQUIRED_CAPABILITIES.length
      && this.isCurrent(route);
  }

  private carrierKey(binding: Pick<RelayV2HostRouteBinding,
    "connectorGeneration" | "connectorId" | "routeId" | "routeFence"
  >): string {
    return JSON.stringify([
      binding.connectorGeneration,
      binding.connectorId,
      binding.routeId,
      binding.routeFence,
    ]);
  }
}
