import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RELAY_V2_REQUIRED_CAPABILITIES,
} from "./brokerCore.js";
import type {
  RelayV2HostCarrierRouteSink,
  RelayV2HostLocalUnbindReason,
  RelayV2HostRouteBinding,
} from "./hostCarrier.js";
import type {
  RelayV2CommandAuthContext,
} from "./hostCommandPlane.js";
import type {
  RelayV2TerminalAuthContext,
  RelayV2TerminalCloseRequest,
  RelayV2TerminalInput,
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
} as const);

export type RelayV2RequiredCapability =
  typeof RELAY_V2_REQUIRED_CAPABILITIES[number];

export type RelayV2HostCapabilityIntersection = Readonly<
  Record<RelayV2RequiredCapability, boolean>
>;

/**
 * This is the already-computed intersection of the codec, H0/H1/H2/H3 and
 * carrier readiness signals. It is deliberately required and has no default.
 * A composition root may advertise the returned six capabilities only when
 * every injected signal is literally true.
 */
export interface RelayV2HostCapabilityIntersectionPort {
  current(): RelayV2HostCapabilityIntersection;
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
}

export interface RelayV2HostRuntimeEventSink {
  /** Literal true is the only successful bounded admission receipt. */
  enqueue(frame: RelayV2JsonObject): boolean;
  close(error?: unknown): void;
}

export interface RelayV2HostRuntimeHelloRequest {
  subscriberId: string;
  requestId: string;
  auth: RelayV2CommandAuthContext;
  hostEpoch: string;
  hostInstanceId: string;
  capabilities: readonly RelayV2RequiredCapability[];
  clientCapabilities: readonly string[];
  requiredCapabilities: readonly string[];
  resume: RelayV2JsonObject | null;
}

export interface RelayV2HostRuntimeResourceRequest {
  requestId: string;
  expectedHostEpoch: string;
}

export interface RelayV2HostRuntimeSessionsRequest
  extends RelayV2HostRuntimeResourceRequest {
  scopeIds: readonly string[] | null;
}

export interface RelayV2HostRuntimeSnapshotGetRequest
  extends RelayV2HostRuntimeResourceRequest {
  principalId: string;
  clientInstanceId: string;
  snapshotRequestId: string;
  snapshotId: string | null;
  cursor: string | null;
  nextChunkIndex: number;
}

export interface RelayV2HostRuntimeSnapshotReleaseRequest
  extends RelayV2HostRuntimeResourceRequest {
  principalId: string;
  clientInstanceId: string;
  snapshotRequestId: string;
  snapshotId: string;
  reason: "completed" | "abandoned";
}

/**
 * Narrow H0/H2 serializer adapter. The hello implementation must enqueue its
 * host.welcome through the supplied sink while holding the existing H2
 * welcome barrier. Snapshot methods return already-authoritative public frames.
 */
export interface RelayV2HostRuntimeResourcePort {
  hello(
    request: RelayV2HostRuntimeHelloRequest,
    sink: RelayV2HostRuntimeEventSink,
  ): Promise<void>;
  scopesSnapshot(
    request: RelayV2HostRuntimeResourceRequest,
  ): Promise<RelayV2JsonObject>;
  sessionsSnapshot(
    request: RelayV2HostRuntimeSessionsRequest,
  ): Promise<RelayV2JsonObject>;
  stateSnapshotGet(
    request: RelayV2HostRuntimeSnapshotGetRequest,
  ): Promise<RelayV2JsonObject>;
  stateSnapshotRelease(
    request: RelayV2HostRuntimeSnapshotReleaseRequest,
  ): Promise<RelayV2JsonObject>;
  unsubscribe(subscriberId: string): void;
}

/** The existing H3 surface, without any copied terminal state. */
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
  /** Process-local exact binding token. Never serialized onto the wire. */
  readonly runtimeBindingId: string;
}

export interface RelayV2HostRuntimeOutboundPort {
  /**
   * Accept one complete public frame for this exact carrier binding. False or
   * rejection is terminal pressure; this core never retries another dialect.
   */
  trySend(
    binding: RelayV2HostRouteBinding,
    payload: Uint8Array,
  ): boolean | Promise<boolean>;
  close(
    binding: RelayV2HostRouteBinding,
    reason: "slow_consumer" | "protocol_error" | "host_shutdown",
  ): void;
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
  terminals: RelayV2HostRuntimeTerminalPort;
  outbound: RelayV2HostRuntimeOutboundPort;
  /** Tests may only make the frozen bounds stricter. */
  testLimits?: Partial<RuntimeLimits>;
}

interface OutboundItem {
  bytes: Uint8Array;
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
  closeReason: "slow_consumer" | "protocol_error" | "host_shutdown" | null;
  pendingOperations: number;
  pendingRequestIds: Set<string>;
  outbound: OutboundItem[];
  outboundBytes: number;
  sending: boolean;
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

const TERMINAL_OUTBOUND_TYPES = new Set([
  "error",
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

const RESPONSE_TYPES = new Map<string, ReadonlySet<string>>([
  ["command.execute", new Set(["command.status", "error"])],
  ["command.query", new Set(["command.statuses", "error"])],
  ["scopes.snapshot.get", new Set(["scopes.snapshot", "error"])],
  ["sessions.snapshot.get", new Set(["sessions.snapshot", "error"])],
  ["state.snapshot.get", new Set(["state.snapshot.chunk", "error"])],
  ["state.snapshot.release", new Set(["state.snapshot.released", "error"])],
]);

const KNOWN_ERROR_CODES = new Set([
  "BUSY",
  "CAPABILITY_UNAVAILABLE",
  "HOST_EPOCH_MISMATCH",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "SCOPE_NOT_FOUND",
  "SCOPE_UNREACHABLE",
  "SNAPSHOT_EXPIRED",
  "SNAPSHOT_TOO_LARGE",
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
]);

function positiveLimit(
  value: number | undefined,
  production: number,
  name: string,
): number {
  const selected = value ?? production;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > production) {
    throw new Error(`invalid or widened Relay v2 host runtime limit ${name}`);
  }
  return selected;
}

function resolveLimits(input: Partial<RuntimeLimits> = {}): RuntimeLimits {
  return Object.freeze({
    maxRoutes: positiveLimit(
      input.maxRoutes,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxRoutes,
      "maxRoutes",
    ),
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

function safeCode(error: unknown): string {
  if (!error || typeof error !== "object") return "INTERNAL";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && KNOWN_ERROR_CODES.has(code)
    ? code
    : "INTERNAL";
}

function safeMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && Buffer.byteLength(message, "utf8") <= 4_096
    ? message
    : fallback;
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
): RelayV2RequiredCapability[] {
  if (!value || typeof value !== "object") return [];
  const keys = Object.keys(value);
  if (keys.length !== RELAY_V2_REQUIRED_CAPABILITIES.length
    || keys.some((key) => !(RELAY_V2_REQUIRED_CAPABILITIES as readonly string[]).includes(key))) {
    return [];
  }
  return RELAY_V2_REQUIRED_CAPABILITIES.every((capability) => value[capability] === true)
    ? [...RELAY_V2_REQUIRED_CAPABILITIES]
    : [];
}

/**
 * Unwired host route/runtime composition foundation. It owns only v2 frame
 * dispatch, exact route fencing and composition-level bounded admission.
 */
export class RelayV2HostRuntime implements RelayV2HostCarrierRouteSink {
  readonly limits: RuntimeLimits;

  private readonly routesByCarrierKey = new Map<string, RouteState>();
  private readonly routesByRuntimeId = new Map<string, RouteState>();
  private nextBindingId = 0;

  constructor(private readonly options: RelayV2HostRuntimeOptions) {
    for (const [name, value] of [
      ["hostId", options.hostId],
      ["hostEpoch", options.hostEpoch],
      ["hostInstanceId", options.hostInstanceId],
    ] as const) {
      if (!value || Buffer.byteLength(value, "utf8") > 128) {
        throw new Error(`Relay v2 host runtime ${name} is invalid`);
      }
    }
    this.limits = resolveLimits(options.testLimits);
    // Touch the mandatory source once. Malformed, incomplete, or later
    // throwing reads are all treated as a fail-closed readiness withdrawal.
    void exactCapabilityIntersection(options.capabilityIntersection.current());
  }

  advertisedCapabilities(): RelayV2RequiredCapability[] {
    try {
      return exactCapabilityIntersection(this.options.capabilityIntersection.current());
    } catch {
      return [];
    }
  }

  onRouteBound(input: RelayV2HostRouteBinding): void {
    if (input.clientDialect !== "tw-relay.v2"
      || input.authContext.scheme !== "twcap2"
      || input.authContext.role !== "client"
      || input.authContext.hostId !== this.options.hostId) {
      throw new Error("Relay v2 host runtime accepts only a bound twcap2 v2 route");
    }
    if (this.routesByCarrierKey.size >= this.limits.maxRoutes) {
      throw new Error("Relay v2 host runtime route capacity is exhausted");
    }
    const binding = immutableBinding(input);
    const key = this.carrierKey(binding);
    if (this.routesByCarrierKey.has(key)) {
      throw new Error("Relay v2 host runtime route binding was reused");
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
      closeReason: null,
      pendingOperations: 0,
      pendingRequestIds: new Set(),
      outbound: [],
      outboundBytes: 0,
      sending: false,
    };
    this.routesByCarrierKey.set(key, route);
    this.routesByRuntimeId.set(runtimeBindingId, route);
  }

  onClientFrame(binding: RelayV2HostRouteBinding, payload: Uint8Array): void {
    const route = this.currentRoute(binding);
    if (!route || !route.accepting) return;

    let frame: RelayV2JsonObject;
    try {
      frame = decodeRelayV2WebSocketFrame("public", payload, {
        opcode: "text",
        compressed: false,
      }).frame;
    } catch {
      this.closeImmediately(route, "protocol_error");
      return;
    }
    const type = stringField(frame, "type");
    if (!CLIENT_FRAME_TYPES.has(type)) {
      this.closeImmediately(route, "protocol_error");
      return;
    }
    if (type === "client.hello") {
      if (route.phase !== "bound") {
        this.closeImmediately(route, "protocol_error");
        return;
      }
      // Freeze the handshake admission synchronously in carrier sequence
      // order. A later frame cannot overtake the H0 identity read and enter an
      // authority before this hello has installed its H2 W+1 barrier.
      route.phase = "hello_pending";
    }

    const isRequest = frame.kind === "request";
    const requestId = isRequest ? stringField(frame, "requestId") : null;
    if (isRequest) {
      if (route.pendingRequestIds.has(requestId!)) {
        this.drainErrorAndClose(
          route,
          frame,
          "INVALID_ARGUMENT",
          "requestId is already in flight on this route",
          false,
        );
        return;
      }
      if (route.pendingRequestIds.size >= this.limits.maxInFlightRequestsPerRoute) {
        if (!this.enqueueError(
          route,
          frame,
          "BUSY",
          "Route request capacity is exhausted",
          true,
        )) {
          this.closeImmediately(route, "slow_consumer");
        }
        return;
      }
    }
    if (route.pendingOperations >= this.limits.maxPendingOperationsPerRoute) {
      if (isRequest && this.enqueueError(
        route,
        frame,
        "BUSY",
        "Route operation capacity is exhausted",
        true,
      )) return;
      this.closeImmediately(route, "slow_consumer");
      return;
    }

    route.pendingOperations += 1;
    if (requestId !== null) route.pendingRequestIds.add(requestId);
    void this.dispatch(route, frame).catch((error) => {
      if (!this.isCurrent(route)) return;
      if (requestId !== null) {
        if (type === "client.hello") {
          this.drainErrorAndClose(
            route,
            frame,
            safeCode(error),
            safeMessage(error, "Relay v2 host authority failed"),
            safeCode(error) === "BUSY",
          );
        } else if (!this.enqueueError(
          route,
          frame,
          safeCode(error),
          safeMessage(error, "Relay v2 host authority failed"),
          safeCode(error) === "BUSY",
        )) {
          this.closeImmediately(route, "slow_consumer");
        }
      } else {
        this.closeImmediately(route, "protocol_error");
      }
    }).finally(() => {
      route.pendingOperations = Math.max(0, route.pendingOperations - 1);
      if (requestId !== null) route.pendingRequestIds.delete(requestId);
    });
  }

  onRouteClosing(binding: RelayV2HostRouteBinding): void {
    const route = this.currentRoute(binding);
    if (route) this.fenceAdmission(route, "host_shutdown", false);
  }

  onRouteUnbound(
    binding: RelayV2HostRouteBinding,
    _reason: RelayV2HostLocalUnbindReason,
  ): void {
    const route = this.currentRoute(binding);
    if (!route) return;
    this.fenceAdmission(route, "host_shutdown", true);
  }

  /**
   * H3's injected send callback uses this method. The process-local binding ID
   * prevents a late callback from matching a structurally reused carrier route.
   */
  async sendTerminalFrame(
    authorityRoute: RelayV2HostRuntimeAuthorityRoute,
    frame: RelayV2JsonObject,
  ): Promise<void> {
    const route = this.routesByRuntimeId.get(authorityRoute.runtimeBindingId);
    if (!route
      || route.authorityRoute !== authorityRoute
      || !this.isCurrent(route)
      || route.phase !== "ready") {
      throw new Error("Relay v2 terminal callback targets a stale route binding");
    }
    if (!TERMINAL_OUTBOUND_TYPES.has(String(frame.type))) {
      throw new Error("Relay v2 terminal callback returned another authority's frame");
    }
    if (frame.kind === "response"
      && (typeof frame.requestId !== "string"
        || !route.pendingRequestIds.has(frame.requestId))) {
      throw new Error("Relay v2 terminal callback is not correlated to an active request");
    }
    if (!this.enqueueOutbound(route, frame)) {
      throw new Error("Relay v2 terminal callback exceeded route capacity");
    }
  }

  private async dispatch(route: RouteState, frame: RelayV2JsonObject): Promise<void> {
    const identity = await this.options.identity.current();
    if (!this.isCurrent(route)) return;
    if (!identity
      || identity.hostEpoch !== this.options.hostEpoch
      || identity.hostInstanceId !== this.options.hostInstanceId) {
      if (frame.kind === "request") {
        this.drainEpochMismatch(route, frame, identity?.hostEpoch ?? this.options.hostEpoch);
      } else {
        this.closeImmediately(route, "protocol_error");
      }
      return;
    }
    if (Object.hasOwn(frame, "hostId") && frame.hostId !== route.auth.hostId) {
      this.drainErrorAndClose(
        route,
        frame,
        "PERMISSION_DENIED",
        "Frame host authorization does not match the route binding",
        false,
      );
      return;
    }
    if (Object.hasOwn(frame, "expectedHostEpoch")
      && frame.expectedHostEpoch !== identity.hostEpoch) {
      this.drainEpochMismatch(route, frame, identity.hostEpoch);
      return;
    }

    const type = stringField(frame, "type");
    if (type === "client.hello") {
      await this.dispatchHello(route, frame, identity);
      return;
    }
    if (route.phase !== "ready") {
      this.closeImmediately(route, "protocol_error");
      return;
    }
    if (this.advertisedCapabilities().length !== RELAY_V2_REQUIRED_CAPABILITIES.length) {
      if (frame.kind === "request") {
        this.drainErrorAndClose(
          route,
          frame,
          "CAPABILITY_UNAVAILABLE",
          "Relay v2 base capability intersection is incomplete",
          false,
        );
      } else {
        this.closeImmediately(route, "protocol_error");
      }
      return;
    }

    switch (type) {
      case "command.execute":
        await this.sendReturned(route, frame, await this.options.commands.execute(route.auth, frame));
        return;
      case "command.query":
        await this.sendReturned(route, frame, await this.options.commands.query(route.auth, frame));
        return;
      case "scopes.snapshot.get":
        await this.sendReturned(route, frame, await this.options.resources.scopesSnapshot({
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
        }));
        return;
      case "sessions.snapshot.get": {
        const scopeIds = objectField(frame, "payload").scopeIds as string[] | null;
        await this.sendReturned(route, frame, await this.options.resources.sessionsSnapshot({
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          scopeIds: scopeIds === null ? null : [...scopeIds],
        }));
        return;
      }
      case "state.snapshot.get": {
        const payload = objectField(frame, "payload");
        await this.sendReturned(route, frame, await this.options.resources.stateSnapshotGet({
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          principalId: route.auth.principalId,
          clientInstanceId: route.auth.clientInstanceId,
          snapshotRequestId: stringField(payload, "snapshotRequestId"),
          snapshotId: payload.snapshotId as string | null,
          cursor: payload.cursor as string | null,
          nextChunkIndex: payload.nextChunkIndex as number,
        }));
        return;
      }
      case "state.snapshot.release": {
        const payload = objectField(frame, "payload");
        await this.sendReturned(route, frame, await this.options.resources.stateSnapshotRelease({
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          principalId: route.auth.principalId,
          clientInstanceId: route.auth.clientInstanceId,
          snapshotRequestId: stringField(payload, "snapshotRequestId"),
          snapshotId: stringField(payload, "snapshotId"),
          reason: stringField(payload, "reason") as "completed" | "abandoned",
        }));
        return;
      }
      default:
        if (!TERMINAL_TYPES.has(type)) {
          this.closeImmediately(route, "protocol_error");
          return;
        }
        await this.dispatchTerminal(route, frame);
    }
  }

  private async dispatchHello(
    route: RouteState,
    frame: RelayV2JsonObject,
    identity: RelayV2HostRuntimeIdentity,
  ): Promise<void> {
    if (route.phase !== "hello_pending") {
      this.closeImmediately(route, "protocol_error");
      return;
    }
    const payload = objectField(frame, "payload");
    if (payload.clientInstanceId !== route.auth.clientInstanceId) {
      this.drainErrorAndClose(
        route,
        frame,
        "PERMISSION_DENIED",
        "clientInstanceId does not match the authenticated route",
        false,
      );
      return;
    }
    const available = this.advertisedCapabilities();
    const offered = payload.capabilities as string[];
    const required = payload.requiredCapabilities as string[];
    if (available.length !== RELAY_V2_REQUIRED_CAPABILITIES.length
      || RELAY_V2_REQUIRED_CAPABILITIES.some((capability) => !offered.includes(capability))
      || required.some((capability) => !available.includes(capability as RelayV2RequiredCapability))) {
      this.drainErrorAndClose(
        route,
        frame,
        "CAPABILITY_UNAVAILABLE",
        "Relay v2 base capability intersection is incomplete",
        false,
      );
      return;
    }
    const sink: RelayV2HostRuntimeEventSink = Object.freeze({
      enqueue: (outbound: RelayV2JsonObject) => this.enqueueResourceEvent(route, frame, outbound),
      close: () => {
        if (this.isCurrent(route)) this.closeImmediately(route, "protocol_error");
      },
    });
    await this.options.resources.hello({
      subscriberId: route.subscriberId,
      requestId: stringField(frame, "requestId"),
      auth: route.auth,
      hostEpoch: identity.hostEpoch,
      hostInstanceId: identity.hostInstanceId,
      capabilities: available,
      clientCapabilities: [...offered],
      requiredCapabilities: [...required],
      resume: payload.resume === null
        ? null
        : structuredClone(payload.resume as RelayV2JsonObject),
    }, sink);
    if (!this.isCurrent(route)) return;
    if (!route.welcomeAccepted) {
      this.closeImmediately(route, "protocol_error");
    }
  }

  private enqueueResourceEvent(
    route: RouteState,
    hello: RelayV2JsonObject,
    frame: RelayV2JsonObject,
  ): boolean {
    if (!this.isCurrent(route)) return false;
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
        ))) return false;
      route.welcomeAccepted = true;
      route.phase = "ready";
    } else if (frame.type === "host.welcome"
      || (frame.type !== "scopes.changed" && frame.type !== "sessions.changed")) {
      return false;
    }
    return this.enqueueOutbound(route, frame);
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
        const resume = Object.hasOwn(payload, "resume")
          ? objectField(payload, "resume")
          : undefined;
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

  private async sendReturned(
    route: RouteState,
    request: RelayV2JsonObject,
    response: RelayV2JsonObject,
  ): Promise<void> {
    if (!this.isCurrent(route)) return;
    if (response.kind !== "response" || response.requestId !== request.requestId) {
      throw new Error("Relay v2 authority returned an uncorrelated response");
    }
    const allowed = RESPONSE_TYPES.get(String(request.type));
    if (!allowed?.has(String(response.type))) {
      throw new Error("Relay v2 authority returned another owner's response type");
    }
    if (!this.enqueueOutbound(route, response)) {
      throw new Error("Relay v2 authority response exceeded route capacity");
    }
  }

  private enqueueError(
    route: RouteState,
    request: RelayV2JsonObject,
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
      requestId: stringField(request, "requestId"),
      ...(Object.hasOwn(request, "commandId") ? { commandId: request.commandId } : {}),
      ...(Object.hasOwn(request, "hostId") ? { hostId: request.hostId } : {}),
      hostEpoch: actualHostEpoch,
      ...(Object.hasOwn(request, "scopeId") ? { scopeId: request.scopeId } : {}),
      ...(Object.hasOwn(request, "sessionId") ? { sessionId: request.sessionId } : {}),
      ...(Object.hasOwn(request, "streamId") ? { streamId: request.streamId } : {}),
      payload: null,
      error: {
        code,
        message,
        retryable,
        retryAfterMs: retryable ? 0 : null,
        commandDisposition: request.type === "command.execute"
          ? "not_accepted"
          : "not_applicable",
        details,
      },
    };
    return this.enqueueOutbound(route, frame, allowClosing);
  }

  private drainEpochMismatch(
    route: RouteState,
    request: RelayV2JsonObject,
    actualHostEpoch: string,
  ): void {
    const expected = Object.hasOwn(request, "expectedHostEpoch")
      ? String(request.expectedHostEpoch)
      : this.options.hostEpoch;
    route.accepting = false;
    route.phase = "closing";
    route.closeReason = "protocol_error";
    if (!this.enqueueError(
      route,
      request,
      "HOST_EPOCH_MISMATCH",
      "Client targets a stale host lineage",
      false,
      true,
      { expectedHostEpoch: expected, actualHostEpoch },
      actualHostEpoch,
    )) this.closeImmediately(route, "slow_consumer");
  }

  private drainErrorAndClose(
    route: RouteState,
    request: RelayV2JsonObject,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    if (request.kind !== "request") {
      this.closeImmediately(route, "protocol_error");
      return;
    }
    route.accepting = false;
    route.phase = "closing";
    route.closeReason = "protocol_error";
    if (!this.enqueueError(route, request, code, message, retryable, true)) {
      this.closeImmediately(route, "slow_consumer");
    }
  }

  private enqueueOutbound(
    route: RouteState,
    frame: RelayV2JsonObject,
    allowClosing = false,
  ): boolean {
    if (!this.isCurrent(route)
      || (!route.accepting && !allowClosing)
      || route.phase === "closed") return false;
    const frameError = frame.error;
    const frameErrorDetails = frameError
      && typeof frameError === "object"
      && !Array.isArray(frameError)
      && frameError.details
      && typeof frameError.details === "object"
      && !Array.isArray(frameError.details)
      ? frameError.details
      : null;
    const isCurrentEpochMismatch = allowClosing
      && frame.type === "error"
      && frameError
      && typeof frameError === "object"
      && !Array.isArray(frameError)
      && frameError.code === "HOST_EPOCH_MISMATCH"
      && typeof frame.hostEpoch === "string"
      && frameErrorDetails?.actualHostEpoch === frame.hostEpoch;
    if ((Object.hasOwn(frame, "hostId") && frame.hostId !== route.auth.hostId)
      || (Object.hasOwn(frame, "hostEpoch")
        && frame.hostEpoch !== this.options.hostEpoch
        && !isCurrentEpochMismatch)
      || (Object.hasOwn(frame, "hostInstanceId")
        && frame.hostInstanceId !== this.options.hostInstanceId)) {
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeRelayV2WebSocketFrame("public", frame);
    } catch {
      return false;
    }
    if (bytes.byteLength > route.binding.maxFrameBytes
      || route.outbound.length >= this.limits.maxOutboundFramesPerRoute
      || route.outboundBytes > this.limits.maxOutboundBytesPerRoute - bytes.byteLength) {
      return false;
    }
    route.outbound.push({ bytes });
    route.outboundBytes += bytes.byteLength;
    this.flushOutbound(route);
    return true;
  }

  private flushOutbound(route: RouteState): void {
    if (route.sending || !this.isCurrent(route)) return;
    const item = route.outbound[0];
    if (!item) {
      if (route.phase === "closing" && route.closeReason !== null) {
        this.finishClose(route, route.closeReason);
      }
      return;
    }
    route.sending = true;
    let receipt: boolean | Promise<boolean>;
    try {
      receipt = this.options.outbound.trySend(route.binding, item.bytes.slice());
    } catch {
      this.outboundSettled(route, item, false);
      return;
    }
    if (typeof receipt === "boolean") {
      this.outboundSettled(route, item, receipt === true);
      return;
    }
    void Promise.resolve(receipt).then(
      (accepted) => this.outboundSettled(route, item, accepted === true),
      () => this.outboundSettled(route, item, false),
    );
  }

  private outboundSettled(route: RouteState, item: OutboundItem, accepted: boolean): void {
    if (route.outbound[0] !== item) return;
    route.outbound.shift();
    route.outboundBytes -= item.bytes.byteLength;
    route.sending = false;
    if (!accepted) {
      this.closeImmediately(route, "slow_consumer");
      return;
    }
    this.flushOutbound(route);
  }

  private closeImmediately(
    route: RouteState,
    reason: "slow_consumer" | "protocol_error" | "host_shutdown",
  ): void {
    if (route.phase === "closed") return;
    this.fenceAdmission(route, reason, false);
    this.finishClose(route, reason);
  }

  private finishClose(
    route: RouteState,
    reason: "slow_consumer" | "protocol_error" | "host_shutdown",
  ): void {
    if (route.phase === "closed" || route.closeSent) return;
    route.phase = "closing";
    route.closeSent = true;
    route.outbound = [];
    route.outboundBytes = 0;
    route.sending = false;
    try { this.options.outbound.close(route.binding, reason); } catch {}
  }

  private fenceAdmission(
    route: RouteState,
    reason: "slow_consumer" | "protocol_error" | "host_shutdown",
    remove: boolean,
  ): void {
    route.accepting = false;
    route.closeReason = reason;
    if (remove) route.phase = "closed";
    try { this.options.resources.unsubscribe(route.subscriberId); } catch {}
    if (!route.terminalUnbound) {
      route.terminalUnbound = true;
      try {
        void this.options.terminals
          .unbind(terminalAuth(route), route.authorityRoute)
          .catch(() => undefined);
      } catch {}
    }
    if (remove) {
      this.routesByCarrierKey.delete(this.carrierKey(route.binding));
      this.routesByRuntimeId.delete(route.authorityRoute.runtimeBindingId);
      route.outbound = [];
      route.outboundBytes = 0;
      route.sending = false;
    }
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
      || binding.authContext.grantId !== route.binding.authContext.grantId
      || binding.authContext.jti !== route.binding.authContext.jti
      || binding.authContext.kid !== route.binding.authContext.kid
      || binding.authContext.expiresAtMs !== route.binding.authContext.expiresAtMs) return undefined;
    return route;
  }

  private isCurrent(route: RouteState): boolean {
    return route.phase !== "closed"
      && this.routesByCarrierKey.get(this.carrierKey(route.binding)) === route
      && this.routesByRuntimeId.get(route.authorityRoute.runtimeBindingId) === route;
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
