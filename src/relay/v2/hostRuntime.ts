import { randomBytes } from "node:crypto";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
  type RelayV2FrameMetadata,
} from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import { RELAY_V2_REQUIRED_CAPABILITIES } from "./brokerCore.js";
import type {
  RelayV2HostCarrierRouteSink,
  RelayV2HostLocalUnbindReason,
  RelayV2HostRouteBindingRejection,
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
  isRelayV2MaterializedStateError,
  RelayV2MaterializedStateError,
} from "./resourceState.js";
import type {
  RelayV2MaterializedStateFoundation,
  RelayV2StateEventSink,
  RelayV2WelcomeCut,
} from "./resourceState.js";
import {
  isRelayV2StateSnapshotSpoolError,
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
  RelayV2TerminalOpenResponseLineage,
  RelayV2TerminalOutputAck,
  RelayV2TerminalReplayRequest,
  RelayV2TerminalResize,
  RelayV2TerminalRuntimeBinding,
} from "./terminalManager.js";
import {
  createRelayV2TerminalRuntimeBinding,
  isRelayV2TerminalManagerError,
} from "./terminalManager.js";

export const RELAY_V2_HOST_RUNTIME_LIMITS = Object.freeze({
  maxRoutes: 256,
  maxInFlightRequestsPerRoute: 64,
  maxPendingOperationsPerRoute: 128,
  maxOutboundFramesPerRoute: 128,
  maxOutboundBytesPerRoute: 1_048_576,
  maxTerminalLineagesPerRoute: 256,
  maxConnectorFences: 1_024,
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
  capabilities: readonly string[];
}

export interface RelayV2HostRuntimeWelcomeSerializer {
  /** Must be pure and synchronous; it runs inside H2's H0 serializer. */
  build(input: RelayV2HostRuntimeHelloBuildInput): RelayV2JsonObject;
}

export interface RelayV2HostOptionalExtensionRequestDescriptor {
  readonly requestId: string;
  readonly hostId: string;
  readonly expectedHostEpoch: string;
  readonly scopeId: string;
  readonly sessionId: string;
}

export interface RelayV2HostOptionalExtensionRouteContext {
  readonly principalId: string;
  readonly clientInstanceId: string;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly scopeId: string;
  readonly sessionId: string;
}

export interface RelayV2HostOptionalExtensionDelivery {
  readonly frame: RelayV2JsonObject;
  readonly bytes: Uint8Array;
}

export interface RelayV2HostOptionalExtensionIngressSink {
  /** A close withdraws only this optional extension, never base readiness. */
  apply(ready: boolean): true;
  publish(delivery: RelayV2HostOptionalExtensionDelivery): Promise<void>;
  close(): void;
}

export interface RelayV2HostOptionalExtensionIngressSubscription {
  /** Synchronously fences late producer callbacks; the owner drains separately. */
  unsubscribe(): void;
}

/**
 * Narrow, default-off attachment for one already-owned optional extension.
 * HostRuntime owns route admission/delivery; the attachment owns its durable
 * reducer/store/source lifecycle and must never manufacture base readiness.
 */
export interface RelayV2HostOptionalExtensionAttachment {
  readonly capability: string;
  subscribe(
    sink: RelayV2HostOptionalExtensionIngressSink,
  ): RelayV2HostOptionalExtensionIngressSubscription;
  inspectRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
  ): RelayV2HostOptionalExtensionRequestDescriptor;
  authorize(context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean>;
  handleRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<RelayV2HostOptionalExtensionDelivery>;
  /** Pure, owner-free correlated response after this attachment withdraws. */
  handleUnavailableRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): RelayV2HostOptionalExtensionDelivery;
  isolateFailure(error: unknown): void;
  closeAndDrain(): Promise<void>;
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
  unbind(auth: RelayV2TerminalAuthContext, route: RelayV2TerminalRuntimeBinding): Promise<void>;
}

export type RelayV2HostRuntimeAuthorityRoute = RelayV2TerminalRuntimeBinding;

export type RelayV2HostRuntimeClose = Readonly<{
  code: 4400 | 4406 | 4409 | 1011 | 1013;
  reason:
    | "protocol_error"
    | "event_cursor_ahead"
    | "route_unavailable"
    | "capability_withdrawn"
    | "host_superseded"
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

type RuntimeLimits = Readonly<{
  [Key in keyof typeof RELAY_V2_HOST_RUNTIME_LIMITS]: number;
}>;

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
  optionalExtension?: RelayV2HostOptionalExtensionAttachment;
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
      unbind: (auth: RelayV2TerminalAuthContext, route: RelayV2TerminalRuntimeBinding) => (
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
  | "PERMISSION_DENIED"
  | "SCOPE_NOT_FOUND"
  | "SNAPSHOT_EXPIRED"
  | "SNAPSHOT_TOO_LARGE"
  | "TERMINAL_STREAM_NOT_FOUND"
  | "TERMINAL_STREAM_CONFLICT"
  | "TERMINAL_OPEN_CONFLICT"
  | "TERMINAL_CLOSE_CONFLICT"
  | "TERMINAL_ROUTE_STALE"
  | "TERMINAL_GENERATION_STALE"
  | "TERMINAL_OFFSET_EXPIRED"
  | "TERMINAL_INVALID_ACK"
  | "TERMINAL_INPUT_GAP"
  | "TERMINAL_INPUT_CONFLICT"
  | "TERMINAL_RESIZE_GAP"
  | "TERMINAL_RESIZE_CONFLICT";

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

/** Internal control signal carried out of H2's synchronous H0 serializer. */
class RelayV2HostRuntimeHostSuperseded extends Error {}

type RequestOwner = "hello" | "command" | "resource" | "snapshot" | "terminal" | "extension";

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
  openId: string | null;
  openMode: "new" | "resume" | "reset" | null;
  closeId: string | null;
  generation: string | null;
  nextOffset: string | null;
  fromOffset: string | null;
  resetOrigin: "open" | "replay" | null;
  openResponseMetadata: {
    resetLineage: RelayV2TerminalOpenResponseLineage | null;
  } | null;
}

interface OutboundItem {
  bytes: Uint8Array;
  receiptTimer: ReturnType<typeof setTimeout> | null;
  receiptSettled: boolean;
  admissionKnown: boolean;
  admitted: boolean;
  earlyReceipt: boolean | null;
}

/**
 * Capacity already owned by H2 before it commits a subscriber/materialization
 * barrier. The encoded bytes move exactly once into the transport-owned queue.
 */
interface OutboundReservation {
  bytes: Uint8Array;
  held: boolean;
}

interface ResourceDelivery {
  completion: Promise<void>;
  reservation: OutboundReservation;
}

interface RouteState {
  binding: RelayV2HostRouteBinding;
  authorityRoute: RelayV2HostRuntimeAuthorityRoute;
  auth: RelayV2CommandAuthContext;
  subscriberId: string;
  phase: "bound" | "hello_pending" | "ready" | "closing" | "closed";
  accepting: boolean;
  welcomeAccepted: boolean;
  negotiatedCapabilities: readonly string[] | null;
  extensionNegotiated: boolean;
  resourceUnsubscribed: boolean;
  terminalUnbound: boolean;
  closeSent: boolean;
  closeAfterDrain: RelayV2HostRuntimeClose | null;
  pendingOperations: number;
  pendingRequests: Map<string, PendingRequest>;
  /** Routing lineage only: H3 remains the terminal lifecycle/state authority. */
  terminalLineages: Map<string, string>;
  /** Inbound carrier order is the exact order in which authorities are entered. */
  operationTail: Promise<void>;
  /** H2/H3 callbacks and transport receipts are validated and delivered FIFO. */
  callbackTail: Promise<void>;
  terminalUnbindPending: boolean;
  terminalUnbindFailed: boolean;
  /** False while an obsolete H3 route token is being synchronously fenced. */
  terminalAdmissionReady: boolean;
  /** Old H3 detach work remains charged after route/token replacement. */
  terminalDetachPending: number;
  outbound: OutboundItem[];
  outboundBytes: number;
  outboundReservations: Set<OutboundReservation>;
  reservedOutboundBytes: number;
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
  "terminal.reset_required",
  "terminal.closed",
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
  PERMISSION_DENIED: "Relay v2 terminal request is not permitted",
  SCOPE_NOT_FOUND: "Relay v2 scope was not found",
  SNAPSHOT_EXPIRED: "Relay v2 snapshot is unavailable",
  SNAPSHOT_TOO_LARGE: "Relay v2 convenience snapshot is too large; use state.snapshot",
  TERMINAL_STREAM_NOT_FOUND: "Relay v2 terminal stream was not found",
  TERMINAL_STREAM_CONFLICT: "Relay v2 terminal stream conflicts with retained state",
  TERMINAL_OPEN_CONFLICT: "Relay v2 terminal open conflicts with retained state",
  TERMINAL_CLOSE_CONFLICT: "Relay v2 terminal close conflicts with retained state",
  TERMINAL_ROUTE_STALE: "Relay v2 terminal route is stale",
  TERMINAL_GENERATION_STALE: "Relay v2 terminal generation is stale",
  TERMINAL_OFFSET_EXPIRED: "Relay v2 terminal offset is unavailable",
  TERMINAL_INVALID_ACK: "Relay v2 terminal acknowledgement is invalid",
  TERMINAL_INPUT_GAP: "Relay v2 terminal input sequence has a gap",
  TERMINAL_INPUT_CONFLICT: "Relay v2 terminal input conflicts with retained state",
  TERMINAL_RESIZE_GAP: "Relay v2 terminal resize sequence has a gap",
  TERMINAL_RESIZE_CONFLICT: "Relay v2 terminal resize conflicts with retained state",
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
    maxTerminalLineagesPerRoute: positiveLimit(
      input.maxTerminalLineagesPerRoute,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxTerminalLineagesPerRoute,
      "maxTerminalLineagesPerRoute",
    ),
    maxConnectorFences: positiveLimit(
      input.maxConnectorFences,
      RELAY_V2_HOST_RUNTIME_LIMITS.maxConnectorFences,
      "maxConnectorFences",
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
  const payload = objectField(frame, "payload");
  const resume = type === "terminal.open" && Object.hasOwn(payload, "resume")
    ? objectField(payload, "resume")
    : null;
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
    openId: type === "terminal.open" ? optionalString(payload, "openId") : null,
    openMode: type === "terminal.open"
      ? stringField(payload, "mode") as "new" | "resume" | "reset"
      : null,
    closeId: type === "terminal.close" ? optionalString(payload, "closeId") : null,
    generation: type === "terminal.replay_request" || type === "terminal.close"
      ? optionalString(payload, "generation")
      : optionalString(resume ?? {}, "generation"),
    nextOffset: type === "terminal.open" && payload.mode === "resume"
      ? optionalString(resume ?? {}, "nextOffset")
      : null,
    fromOffset: type === "terminal.replay_request"
      ? optionalString(payload, "fromOffset")
      : null,
    resetOrigin: type === "terminal.open"
      ? "open"
      : type === "terminal.replay_request"
        ? "replay"
        : null,
    openResponseMetadata: type === "terminal.open"
      ? { resetLineage: null }
      : null,
  });
}

function optionalExtensionPendingRequest(
  descriptor: RelayV2HostOptionalExtensionRequestDescriptor,
): PendingRequest {
  return Object.freeze({
    requestId: descriptor.requestId,
    owner: "extension",
    requestType: "optional.extension",
    allowedResponseTypes: new Set(["error"]),
    hostId: descriptor.hostId,
    commandId: null,
    scopeId: descriptor.scopeId,
    sessionId: descriptor.sessionId,
    streamId: null,
    openId: null,
    openMode: null,
    closeId: null,
    generation: null,
    nextOffset: null,
    fromOffset: null,
    resetOrigin: null,
    openResponseMetadata: null,
  });
}

function structuredAuthorityError(error: unknown): {
  code: RelayV2HostRuntimeAuthorityErrorCode;
  details: Readonly<Record<string, unknown>> | null;
} | null {
  if (error instanceof RelayV2HostRuntimeAuthorityError
    || isRelayV2MaterializedStateError(error)
    || isRelayV2StateSnapshotSpoolError(error)
    || isRelayV2TerminalManagerError(error)) {
    const code = error.code as RelayV2HostRuntimeAuthorityErrorCode;
    if (!Object.hasOwn(AUTHORITY_ERROR_MESSAGES, code)) return null;
    const details = Object.hasOwn(error, "details")
      ? (error as { details?: Readonly<Record<string, unknown>> | null }).details ?? null
      : null;
    return { code, details };
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
  if (code === "SNAPSHOT_TOO_LARGE") {
    if (!details
      || details.useStateSnapshot !== true
      || Object.keys(details).length !== 1) return null;
    return { useStateSnapshot: true };
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
 * every business transition remains in H0/H1/H2/spool/H3. Each route has two
 * bounded FIFO lanes: inbound authority work and validated callback delivery.
 * Both lanes share the route pending-operation limit and remain charged while
 * asynchronous work drains after a fence.
 */
export class RelayV2HostRuntime implements RelayV2HostCarrierRouteSink {
  readonly limits: RuntimeLimits;

  private readonly routesByCarrierKey = new Map<string, RouteState>();
  private readonly routesByRuntimeToken = new Map<string, RouteState>();
  /** Active and asynchronously draining routes share one hard admission budget. */
  private readonly routeRegistry = new Set<RouteState>();
  /** Accepted connector generations remain observed even after their last route unbinds. */
  private readonly observedConnectorGenerations = new Set<string>();
  private readonly withdrawnConnectorGenerations = new Set<string>();
  private readonly readinessSubscription: RelayV2HostReadinessSubscription;
  private readonly optionalExtension: RelayV2HostOptionalExtensionAttachment | null;
  private optionalExtensionSubscription:
    RelayV2HostOptionalExtensionIngressSubscription | null = null;
  private activeCapabilities: readonly RelayV2RequiredCapability[] | null = null;
  private optionalExtensionReady = false;
  private optionalExtensionIngressActive = false;
  private readinessObserved = false;
  private allConnectorGenerationsFenced = false;
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
    this.optionalExtension = options.optionalExtension ?? null;
    if (this.optionalExtension !== null) {
      if (!isOpaque(this.optionalExtension.capability)
        || (RELAY_V2_REQUIRED_CAPABILITIES as readonly string[]).includes(
          this.optionalExtension.capability,
        )
        || typeof this.optionalExtension.subscribe !== "function"
        || typeof this.optionalExtension.inspectRequest !== "function"
        || typeof this.optionalExtension.authorize !== "function"
        || typeof this.optionalExtension.handleRequest !== "function"
        || typeof this.optionalExtension.handleUnavailableRequest !== "function"
        || typeof this.optionalExtension.isolateFailure !== "function"
        || typeof this.optionalExtension.closeAndDrain !== "function") {
        throw new Error("Relay v2 optional Host extension attachment is invalid");
      }
      const extensionSink: RelayV2HostOptionalExtensionIngressSink = Object.freeze({
        apply: (ready: boolean): true => {
          if (this.optionalExtensionIngressActive) {
            this.optionalExtensionReady = ready === true;
          }
          return true;
        },
        publish: (delivery: RelayV2HostOptionalExtensionDelivery) => (
          this.publishOptionalExtensionDelivery(delivery)
        ),
        close: () => this.fenceOptionalExtensionIngress(),
      });
      this.optionalExtensionIngressActive = true;
      let subscription: RelayV2HostOptionalExtensionIngressSubscription | null = null;
      let subscribeFailed = false;
      try {
        subscription = this.optionalExtension.subscribe(extensionSink);
      } catch (error) {
        subscribeFailed = true;
        this.isolateOptionalExtensionFailure(error);
      }
      if (!subscribeFailed
        && (!subscription || typeof subscription.unsubscribe !== "function")) {
        this.isolateOptionalExtensionFailure(
          new Error("Relay v2 optional Host extension did not establish ingress"),
        );
      } else if (subscription !== null) {
        if (!this.optionalExtensionIngressActive) {
          try { subscription.unsubscribe(); } catch {}
        } else {
          this.optionalExtensionSubscription = subscription;
        }
      }
    }
    const sink: RelayV2HostReadinessSink = Object.freeze({
      apply: (snapshot: RelayV2HostReadinessSnapshot) => this.applyReadiness(snapshot),
      close: () => this.withdrawReadiness(),
    });
    this.readinessSubscription = options.capabilityIntersection.subscribe(sink);
    if (!this.readinessObserved
      || !this.readinessSubscription
      || typeof this.readinessSubscription.unsubscribe !== "function") {
      try { this.readinessSubscription?.unsubscribe(); } catch {}
      this.fenceOptionalExtensionIngress();
      throw new Error("Relay v2 readiness source did not synchronously establish bounded state");
    }
  }

  advertisedCapabilities(): string[] {
    if (this.activeCapabilities === null) return [];
    return [
      ...this.activeCapabilities,
      ...(this.optionalExtension !== null && this.optionalExtensionReady
        ? [this.optionalExtension.capability]
        : []),
    ];
  }

  advertisedOptionalCapabilities(): string[] {
    return this.optionalExtension !== null
      && this.optionalExtensionIngressActive
      && this.optionalExtensionReady
      ? [this.optionalExtension.capability]
      : [];
  }

  dispose(): void {
    this.fenceOptionalExtensionIngress();
    this.activeCapabilities = null;
    for (const route of [...this.routesByCarrierKey.values()]) {
      this.closeImmediately(route, { code: 1011, reason: "host_shutdown" });
    }
    try { this.readinessSubscription.unsubscribe(); } catch {}
  }

  fenceOptionalExtensionIngress(): void {
    this.optionalExtensionIngressActive = false;
    this.optionalExtensionReady = false;
    const subscription = this.optionalExtensionSubscription;
    this.optionalExtensionSubscription = null;
    try { subscription?.unsubscribe(); } catch {}
  }

  onRouteBound(input: RelayV2HostRouteBinding): void | RelayV2HostRouteBindingRejection {
    const connectorGenerationKey = this.connectorGenerationKey(input);
    if (this.allConnectorGenerationsFenced
      || this.withdrawnConnectorGenerations.has(connectorGenerationKey)) {
      return this.bindingRejection(
        "CAPABILITY_UNAVAILABLE",
        "Relay v2 capability was withdrawn for this connector generation",
        false,
      );
    }
    // A carrier generation is observable admission state even if this route is
    // later rejected for dialect, auth, readiness, duplicate, or route quota.
    if (!this.rememberConnectorGeneration(input)) {
      return this.bindingRejection(
        "BUSY",
        "Relay v2 connector generation fence capacity is exhausted",
        false,
      );
    }
    if (input.clientDialect !== "tw-relay.v2"
      || input.authContext.scheme !== "twcap2") {
      return this.bindingRejection(
        "HOST_DIALECT_UNAVAILABLE",
        "Requested Relay dialect is unavailable",
        false,
      );
    }
    if (input.authContext.role !== "client"
      || input.authContext.hostId !== this.options.hostId) {
      return this.bindingRejection(
        "PERMISSION_DENIED",
        "Route authorization does not match this host",
        false,
      );
    }
    if (this.activeCapabilities === null
      || this.activeCapabilities.length !== RELAY_V2_REQUIRED_CAPABILITIES.length) {
      // A generation first observed while readiness is withdrawn belongs to
      // that irreversible withdrawal, even though it never reached bind.
      this.observedConnectorGenerations.delete(connectorGenerationKey);
      this.fenceConnectorGenerationKey(connectorGenerationKey);
      return this.bindingRejection(
        "CAPABILITY_UNAVAILABLE",
        "Relay v2 host capability intersection is unavailable",
        false,
      );
    }
    if (this.routeRegistry.size >= this.limits.maxRoutes) {
      return this.bindingRejection(
        "BUSY",
        "Relay v2 host route capacity is exhausted",
        true,
      );
    }
    const binding = immutableBinding(input);
    const key = this.carrierKey(binding);
    if (this.routesByCarrierKey.has(key)) {
      return this.bindingRejection(
        "BUSY",
        "Relay v2 route binding is already active",
        true,
      );
    }
    const subscriberId = `host-route-${++this.nextBindingId}`;
    const runtimeBindingToken = randomBytes(32).toString("base64url");
    const authorityRoute = createRelayV2TerminalRuntimeBinding(binding, runtimeBindingToken);
    const route: RouteState = {
      binding,
      authorityRoute,
      auth: Object.freeze({
        principalId: input.authContext.principalId,
        clientInstanceId: input.authContext.clientInstanceId,
        hostId: input.authContext.hostId,
      }),
      subscriberId,
      phase: "bound",
      accepting: true,
      welcomeAccepted: false,
      negotiatedCapabilities: null,
      extensionNegotiated: false,
      resourceUnsubscribed: false,
      terminalUnbound: false,
      closeSent: false,
      closeAfterDrain: null,
      pendingOperations: 0,
      pendingRequests: new Map(),
      terminalLineages: new Map(),
      operationTail: Promise.resolve(),
      callbackTail: Promise.resolve(),
      terminalUnbindPending: false,
      terminalUnbindFailed: false,
      terminalAdmissionReady: true,
      terminalDetachPending: 0,
      outbound: [],
      outboundBytes: 0,
      outboundReservations: new Set(),
      reservedOutboundBytes: 0,
      sending: false,
      validatingReceipt: false,
    };
    this.routesByCarrierKey.set(key, route);
    this.routesByRuntimeToken.set(runtimeBindingToken, route);
    this.routeRegistry.add(route);
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
      if (!this.admitOptionalExtensionRequest(route, payload)) {
        this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      }
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
    if (pending) route.pendingRequests.set(pending.requestId, pending);
    const operation = this.scheduleRouteTask(route, "operationTail", async () => {
      try {
        await this.dispatch(route, frame, pending);
      } catch (error) {
        try {
          // Failure handling stays in the inbound FIFO lane so a later frame
          // cannot enter an authority before this result is fenced or emitted.
          await this.handleAuthorityFailure(route, pending, error);
        } catch {
          if (this.isAdmitted(route)) {
            this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
          }
        }
      }
    });
    if (!operation) {
      if (pending) route.pendingRequests.delete(pending.requestId);
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
    void operation.catch(() => {
      if (this.isAdmitted(route)) {
        this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      }
    });
  }

  private admitOptionalExtensionRequest(route: RouteState, payload: Uint8Array): boolean {
    const extension = this.optionalExtension;
    if (extension === null
      || route.phase !== "ready"
      || !route.extensionNegotiated
      || !this.isAdmitted(route)) return false;
    const metadata = Object.freeze({ opcode: "text" as const, compressed: false });
    let descriptor: RelayV2HostOptionalExtensionRequestDescriptor;
    try {
      descriptor = extension.inspectRequest(payload, metadata);
    } catch {
      return false;
    }
    if (descriptor.hostId !== route.auth.hostId
      || descriptor.expectedHostEpoch !== this.options.hostEpoch
      || !isOpaque(descriptor.requestId)
      || !isOpaque(descriptor.scopeId)
      || !isOpaque(descriptor.sessionId)) return false;
    const pending = optionalExtensionPendingRequest(descriptor);
    if (route.pendingRequests.has(pending.requestId)
      || route.pendingRequests.size >= this.limits.maxInFlightRequestsPerRoute) return false;
    route.pendingRequests.set(pending.requestId, pending);
    const operation = this.scheduleRouteTask(route, "operationTail", async () => {
      try {
        await this.dispatchOptionalExtensionRequest(
          route,
          pending,
          descriptor,
          payload,
          metadata,
        );
      } catch (error) {
        // Optional extension faults withdraw only that attachment. Its pure
        // unavailable encoder then owns the correlated terminal response.
        this.isolateOptionalExtensionFailure(error);
        await this.dispatchOptionalExtensionUnavailable(
          route,
          pending,
          descriptor,
          payload,
          metadata,
        );
      }
    });
    if (operation === null) {
      if (!this.enqueueError(
        route,
        pending,
        "BUSY",
        "Relay v2 route operation capacity is exhausted",
        true,
      )) {
        route.pendingRequests.delete(pending.requestId);
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      } else {
        this.consumePending(route, pending);
      }
      return true;
    }
    void operation.catch(() => undefined);
    return true;
  }

  private async dispatchOptionalExtensionRequest(
    route: RouteState,
    pending: PendingRequest,
    descriptor: RelayV2HostOptionalExtensionRequestDescriptor,
    payload: Uint8Array,
    metadata: RelayV2FrameMetadata,
  ): Promise<void> {
    const extension = this.optionalExtension;
    if (extension === null || route.pendingRequests.get(pending.requestId) !== pending) return;
    const identity = await this.verifyCurrentIdentity(route, pending, false);
    if (!identity || route.phase !== "ready" || !route.extensionNegotiated) return;
    const context = Object.freeze({
      principalId: route.auth.principalId,
      clientInstanceId: route.auth.clientInstanceId,
      hostId: route.auth.hostId,
      hostEpoch: identity.hostEpoch,
      scopeId: descriptor.scopeId,
      sessionId: descriptor.sessionId,
    });
    if (!this.optionalExtensionReady) {
      await this.dispatchOptionalExtensionUnavailable(
        route,
        pending,
        descriptor,
        payload,
        metadata,
      );
      return;
    }
    const authorized = await extension.authorize(context);
    if (!authorized || !this.optionalExtensionReady) {
      await this.dispatchOptionalExtensionUnavailable(
        route,
        pending,
        descriptor,
        payload,
        metadata,
      );
      return;
    }
    const delivery = await extension.handleRequest(payload.slice(), metadata, context);
    if (!this.optionalExtensionReady) {
      await this.dispatchOptionalExtensionUnavailable(
        route,
        pending,
        descriptor,
        payload,
        metadata,
      );
      return;
    }
    const current = await this.verifyCurrentIdentity(route, pending, true);
    if (!current
      || route.phase !== "ready"
      || !route.extensionNegotiated
      || route.pendingRequests.get(pending.requestId) !== pending) return;
    this.assertOptionalExtensionResponse(delivery, descriptor, current);
    if (!this.enqueueOutboundBytes(route, delivery.bytes)) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      return;
    }
    this.consumePending(route, pending);
  }

  private async dispatchOptionalExtensionUnavailable(
    route: RouteState,
    pending: PendingRequest,
    descriptor: RelayV2HostOptionalExtensionRequestDescriptor,
    payload: Uint8Array,
    metadata: RelayV2FrameMetadata,
  ): Promise<void> {
    const extension = this.optionalExtension;
    if (extension === null || route.pendingRequests.get(pending.requestId) !== pending) return;
    const identity = await this.verifyCurrentIdentity(route, pending, true);
    if (!identity || route.phase !== "ready" || !route.extensionNegotiated) return;
    const context = Object.freeze({
      principalId: route.auth.principalId,
      clientInstanceId: route.auth.clientInstanceId,
      hostId: route.auth.hostId,
      hostEpoch: identity.hostEpoch,
      scopeId: descriptor.scopeId,
      sessionId: descriptor.sessionId,
    });
    try {
      const delivery = extension.handleUnavailableRequest(payload.slice(), metadata, context);
      const current = await this.verifyCurrentIdentity(route, pending, true);
      if (!current
        || route.phase !== "ready"
        || !route.extensionNegotiated
        || route.pendingRequests.get(pending.requestId) !== pending) return;
      this.assertOptionalExtensionResponse(delivery, descriptor, current);
      if (!this.enqueueOutboundBytes(route, delivery.bytes)) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
        return;
      }
    } catch {
      if (!this.enqueueError(
        route,
        pending,
        "CAPABILITY_UNAVAILABLE",
        "Relay v2 optional capability is unavailable",
        false,
      )) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
        return;
      }
    }
    if (route.pendingRequests.get(pending.requestId) === pending) {
      this.consumePending(route, pending);
    }
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
    responseLineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void> {
    const route = this.exactAuthorityRoute(authorityRoute);
    if (!route || route.phase !== "ready" || !this.isAdmitted(route)) {
      throw new Error("Relay v2 terminal callback targets a stale route binding");
    }
    const delivery = this.scheduleRouteTask(route, "callbackTail", async () => {
      if (this.exactAuthorityRoute(authorityRoute) !== route
        || route.phase !== "ready"
        || !this.isAdmitted(route)) {
        throw new Error("Relay v2 terminal callback targets a stale route binding");
      }
      const identity = await this.verifyCurrentIdentity(route, null, true);
      if (!identity) throw new Error("Relay v2 terminal callback lost its route fence");
      this.assertPublicFrameSchema(frame);
      let pending: PendingRequest | undefined;
      if (frame.kind === "response") {
        const requestId = optionalString(frame, "requestId");
        pending = requestId === null ? undefined : route.pendingRequests.get(requestId);
        if (!pending || pending.owner !== "terminal") {
          throw new Error("Relay v2 terminal callback is not owned by a terminal request");
        }
        this.recordTerminalResponseLineage(pending, frame, responseLineage);
        this.assertCorrelatedResponse(route, pending, frame, identity);
      } else if (frame.kind === "event") {
        if (responseLineage !== undefined) {
          throw new Error("Relay v2 terminal event carried response-only lineage");
        }
        if (!TERMINAL_OUTBOUND_EVENT_TYPES.has(String(frame.type))) {
          throw new Error("Relay v2 terminal callback returned another authority's event");
        }
        this.assertTerminalEventLineage(route, frame);
      } else {
        throw new Error("Relay v2 terminal callback returned an invalid frame kind");
      }
      if (!this.enqueueOutbound(route, frame)) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
        throw new Error("Relay v2 terminal callback exceeded bounded route capacity");
      }
      if (pending) {
        this.applyTerminalResponseLineage(route, pending, frame);
        this.consumePending(route, pending);
      } else {
        this.applyTerminalEventLineage(route, frame);
      }
      if (frame.type === "terminal.reset_required") {
        this.fenceTerminalLineage(route, authorityRoute);
      }
      const afterCallback = await this.verifyCurrentIdentity(route, null, true);
      if (!afterCallback) throw new Error("Relay v2 terminal callback lost its post-send fence");
    });
    if (!delivery) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      throw new Error("Relay v2 terminal callback exceeded bounded route capacity");
    }
    await delivery;
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
    for (const key of this.observedConnectorGenerations) {
      this.fenceConnectorGenerationKey(key);
    }
    this.observedConnectorGenerations.clear();
    for (const route of [...this.routesByCarrierKey.values()]) {
      this.closeImmediately(route, { code: 4406, reason: "capability_withdrawn" });
    }
  }

  private rememberConnectorGeneration(binding: RelayV2HostRouteBinding): boolean {
    const key = this.connectorGenerationKey(binding);
    if (this.observedConnectorGenerations.has(key)) return true;
    if (this.allConnectorGenerationsFenced
      || this.withdrawnConnectorGenerations.has(key)
      || this.observedConnectorGenerations.size + this.withdrawnConnectorGenerations.size
        >= this.limits.maxConnectorFences) return false;
    this.observedConnectorGenerations.add(key);
    return true;
  }

  private fenceConnectorGenerationKey(key: string): void {
    if (this.allConnectorGenerationsFenced) return;
    if (this.withdrawnConnectorGenerations.has(key)) return;
    if (this.withdrawnConnectorGenerations.size >= this.limits.maxConnectorFences) {
      this.withdrawnConnectorGenerations.clear();
      this.allConnectorGenerationsFenced = true;
      return;
    }
    this.withdrawnConnectorGenerations.add(key);
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
    const selected = available.filter((capability) => offered.includes(capability));
    if (available.length < RELAY_V2_REQUIRED_CAPABILITIES.length
      || RELAY_V2_REQUIRED_CAPABILITIES.some((capability) => !offered.includes(capability))
      || required.some((capability) => !selected.includes(capability))) {
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

    const welcomeState: { delivery: ResourceDelivery | null } = { delivery: null };
    const sink: RelayV2StateEventSink<RelayV2JsonObject> = Object.freeze({
      enqueue: (outbound: RelayV2JsonObject) => {
        if (!route.welcomeAccepted
          && outbound.type === "host.welcome"
          && welcomeState.delivery !== null) return false;
        const delivery = this.enqueueResourceEvent(route, pending, outbound, selected);
        if (!delivery) return false;
        if (!route.welcomeAccepted && outbound.type === "host.welcome") {
          welcomeState.delivery = delivery;
        } else {
          void delivery.completion.catch((error) => this.handleResourceCallbackFailure(route, error));
        }
        return true;
      },
      close: (error: RelayV2MaterializedStateError) => {
        if (!this.isAdmitted(route)) return;
        if (error.code === "BUSY"
          && route.phase === "hello_pending"
          && !route.welcomeAccepted
          && route.pendingRequests.get(pending.requestId) === pending) {
          // H2 has not committed host.welcome. Its subsequent typed throw owns
          // the correlated request result; fencing here would erase that owner.
          return;
        }
        const close = error.code === "CAPABILITY_UNAVAILABLE"
          ? { code: 4406, reason: "capability_withdrawn" } as const
          : error.code === "BUSY"
            ? { code: 1013, reason: "slow_consumer" } as const
            : { code: 4400, reason: "protocol_error" } as const;
        this.closeImmediately(route, close);
      },
    });
    try {
      await this.options.resources.linearizeWelcome(
        route.subscriberId,
        sink,
        (cut) => {
          if (!this.isAdmitted(route)) {
            throw new RelayV2HostRuntimeAuthorityError("INTERNAL");
          }
          if (cut.hostEpoch !== identity.hostEpoch) {
            throw new RelayV2HostRuntimeAuthorityError("HOST_EPOCH_MISMATCH", {
              expectedHostEpoch: identity.hostEpoch,
              actualHostEpoch: cut.hostEpoch,
            });
          }
          if (cut.hostInstanceId !== identity.hostInstanceId) {
            throw new RelayV2HostRuntimeHostSuperseded();
          }
          const welcome = this.options.welcome.build({
            hello: structuredClone(frame),
            cut: structuredClone(cut),
            commandDedupeWindow: structuredClone(commandDedupeWindow),
            capabilities: [...selected],
          });
          if (welcome && typeof (welcome as { then?: unknown }).then === "function") {
            throw new RelayV2HostRuntimeAuthorityError("INTERNAL");
          }
          return welcome;
        },
      );
    } catch (error) {
      if (welcomeState.delivery !== null) {
        this.releaseOutboundReservation(route, welcomeState.delivery.reservation);
      }
      if (error instanceof RelayV2HostRuntimeHostSuperseded) {
        this.closeImmediately(route, { code: 4409, reason: "host_superseded" });
        return;
      }
      throw error;
    }
    if (welcomeState.delivery === null) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      return;
    }
    await welcomeState.delivery.completion;
    const afterWelcome = await this.verifyCurrentIdentity(route, pending, true);
    if (afterWelcome && !route.welcomeAccepted) {
      this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
    }
  }

  private enqueueResourceEvent(
    route: RouteState,
    hello: PendingRequest,
    frame: RelayV2JsonObject,
    selectedCapabilities: readonly string[],
  ): ResourceDelivery | null {
    if (!this.isAdmitted(route)) return null;
    const reservation = this.reserveOutbound(route, frame);
    if (!reservation) return null;
    const completion = this.scheduleRouteTask(route, "callbackTail", async () => {
      try {
        const identity = await this.verifyCurrentIdentity(route, null, true);
        if (!identity || !this.isAdmitted(route)) {
          this.releaseOutboundReservation(route, reservation);
          return;
        }
        if (!route.welcomeAccepted) {
          const payload = frame.payload as RelayV2JsonObject | undefined;
          if (route.phase !== "hello_pending"
            || frame.type !== "host.welcome"
            || frame.kind !== "response"
            || frame.requestId !== hello.requestId
            || frame.hostId !== route.auth.hostId
            || frame.hostEpoch !== identity.hostEpoch
            || frame.hostInstanceId !== identity.hostInstanceId
            || !payload
            || !Array.isArray(payload.capabilities)
            || payload.capabilities.length !== selectedCapabilities.length
            || selectedCapabilities.some((capability) => (
              !(payload.capabilities as string[]).includes(capability)
            ))) {
            throw new Error("Relay v2 H2 welcome crossed its route lineage");
          }
        } else if (frame.type === "host.welcome"
          || (frame.type !== "scopes.changed" && frame.type !== "sessions.changed")) {
          throw new Error("Relay v2 H2 callback returned an unsupported frame");
        } else {
          this.assertRouteFrameIdentity(route, frame, identity);
        }
        if (!this.consumeOutboundReservation(route, reservation)) return;
        if (!route.welcomeAccepted) {
          route.welcomeAccepted = true;
          route.negotiatedCapabilities = Object.freeze([...selectedCapabilities]);
          route.extensionNegotiated = this.optionalExtension !== null
            && selectedCapabilities.includes(this.optionalExtension.capability);
          route.phase = "ready";
          this.consumePending(route, hello);
        }
        await this.verifyCurrentIdentity(route, null, true);
      } catch (error) {
        this.releaseOutboundReservation(route, reservation);
        throw error;
      }
    });
    if (!completion) {
      this.releaseOutboundReservation(route, reservation);
      return null;
    }
    return { completion, reservation };
  }

  private async dispatchTerminal(route: RouteState, frame: RelayV2JsonObject): Promise<void> {
    if (!route.terminalAdmissionReady) {
      throw new RelayV2HostRuntimeAuthorityError("BUSY");
    }
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
        const mode = stringField(payload, "mode") as "new" | "resume" | "reset";
        await this.options.terminals.open({
          ...common,
          requestId: stringField(frame, "requestId"),
          expectedHostEpoch: stringField(frame, "expectedHostEpoch"),
          target: terminalTarget(frame),
          openId: stringField(payload, "openId"),
          pane: payload.pane as number,
          cols: payload.cols as number,
          rows: payload.rows as number,
          mode,
          ...(resume === undefined ? {} : {
            resume: {
              generation: stringField(resume, "generation"),
              ...(mode === "resume"
                ? { nextOffset: stringField(resume, "nextOffset") }
                : {}),
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
    this.assertPublicFrameSchema(response);
    this.assertCorrelatedResponse(route, pending, response, identity);
    if (!this.enqueueOutbound(route, response)) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      return;
    }
    this.consumePending(route, pending);
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
      ["hostId", pending.hostId],
      ["commandId", pending.commandId],
      ["scopeId", pending.scopeId],
      ["sessionId", pending.sessionId],
      ["streamId", pending.streamId],
    ] as const) {
      const present = Object.hasOwn(response, field);
      if ((expected === null && present)
        || (expected !== null && (!present || response[field] !== expected))) {
        throw new Error(`Relay v2 authority response ${field} does not match its request owner`);
      }
    }
    this.assertTerminalCorrelatedMetadata(route, pending, response);
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

  private assertTerminalCorrelatedMetadata(
    route: RouteState,
    pending: PendingRequest,
    response: RelayV2JsonObject,
  ): void {
    if (pending.owner !== "terminal" || response.type === "error") return;
    const payload = objectField(response, "payload");
    if (response.type === "terminal.opened") {
      if (payload.openId !== pending.openId) {
        throw new Error("Relay v2 terminal.opened does not match its openId owner");
      }
      const expectedDisposition = pending.openMode === "resume" ? "resumed" : pending.openMode;
      const expectedReplayFromOffset = pending.openMode === "resume" ? pending.nextOffset : "0";
      if (expectedDisposition === null
        || expectedReplayFromOffset === null
        || !Object.hasOwn(payload, "generation")
        || !Object.hasOwn(payload, "replayFromOffset")
        || payload.disposition !== expectedDisposition
        || payload.replayFromOffset !== expectedReplayFromOffset
        || (pending.openMode === "resume" && payload.generation !== pending.generation)
        || (pending.openMode === "reset"
          && pending.generation !== null
          && payload.generation === pending.generation)) {
        throw new Error("Relay v2 terminal.opened crossed its open mode lineage");
      }
    }
    if (response.type === "terminal.opened"
      && pending.streamId !== null
      && !route.terminalLineages.has(pending.streamId)
      && route.terminalLineages.size >= this.limits.maxTerminalLineagesPerRoute) {
      throw new Error("Relay v2 terminal lineage capacity is exhausted");
    }
    if (response.type === "terminal.reset_required") {
      if (payload.origin !== pending.resetOrigin) {
        throw new Error("Relay v2 terminal.reset_required has the wrong request origin");
      }
      const durableReset = pending.openResponseMetadata?.resetLineage ?? null;
      if (pending.resetOrigin === "open"
        && (!Object.hasOwn(payload, "generation")
          || !Object.hasOwn(payload, "requestedOffset")
          || payload.generation !== (durableReset ? durableReset.generation : pending.generation)
          || payload.requestedOffset !== (durableReset
            ? durableReset.requestedOffset
            : pending.nextOffset))) {
        throw new Error("Relay v2 terminal open reset crossed its generation or offset owner");
      }
      if (pending.resetOrigin === "replay"
        && (payload.generation !== pending.generation
          || payload.requestedOffset !== pending.fromOffset)) {
        throw new Error("Relay v2 terminal replay reset crossed its generation or offset owner");
      }
    }
    if (response.type === "terminal.replay_started"
      && (payload.generation !== pending.generation
        || payload.fromOffset !== pending.fromOffset)) {
      throw new Error("Relay v2 terminal replay response crossed its generation or offset owner");
    }
    if (response.type === "terminal.replay_started"
      && route.terminalLineages.get(pending.streamId!) !== pending.generation) {
      throw new Error("Relay v2 terminal replay response targets an inactive stream lineage");
    }
    if (response.type === "terminal.closed"
      && (payload.closeId !== pending.closeId
        || payload.generation !== pending.generation)) {
      throw new Error("Relay v2 terminal close response crossed its close owner");
    }
  }

  private recordTerminalResponseLineage(
    pending: PendingRequest,
    frame: RelayV2JsonObject,
    lineage: RelayV2TerminalOpenResponseLineage | undefined,
  ): void {
    if (lineage === undefined) return;
    const keys = Reflect.ownKeys(lineage).map(String).sort();
    if (keys.join("\0") !== [
      "generation",
      "mode",
      "openId",
      "owner",
      "requestId",
      "requestedOffset",
    ].join("\0")
      || lineage.owner !== "terminal.open"
      || lineage.requestId !== pending.requestId
      || lineage.openId !== pending.openId
      || lineage.mode !== pending.openMode
      || !(lineage.generation === null || isOpaque(lineage.generation))
      || !(lineage.requestedOffset === null || isCounter(lineage.requestedOffset))
      || frame.type !== "terminal.reset_required"
      || objectField(frame, "payload").origin !== "open") {
      throw new Error("Relay v2 terminal callback carried invalid durable open lineage");
    }
    if (pending.openMode === "resume"
      && (lineage.generation !== pending.generation
        || lineage.requestedOffset !== pending.nextOffset)) {
      throw new Error("Relay v2 terminal callback changed resume request lineage");
    }
    const payload = objectField(frame, "payload");
    if (payload.generation !== lineage.generation
      || payload.requestedOffset !== lineage.requestedOffset) {
      throw new Error("Relay v2 terminal reset response crossed its durable open lineage");
    }
    const metadata = pending.openResponseMetadata;
    if (!metadata || metadata.resetLineage !== null) {
      throw new Error("Relay v2 terminal response lineage was already consumed");
    }
    metadata.resetLineage = Object.freeze({ ...lineage });
  }

  private assertTerminalEventLineage(route: RouteState, frame: RelayV2JsonObject): void {
    const streamId = stringField(frame, "streamId");
    const generation = stringField(objectField(frame, "payload"), "generation");
    if (route.terminalLineages.get(streamId) !== generation) {
      throw new Error("Relay v2 terminal event crossed its stream lineage");
    }
  }

  private applyTerminalResponseLineage(
    route: RouteState,
    pending: PendingRequest,
    response: RelayV2JsonObject,
  ): void {
    if (response.type === "terminal.opened") {
      const generation = stringField(objectField(response, "payload"), "generation");
      route.terminalLineages.set(pending.streamId!, generation);
    } else if (response.type === "terminal.closed") {
      route.terminalLineages.delete(pending.streamId!);
    }
  }

  private applyTerminalEventLineage(route: RouteState, frame: RelayV2JsonObject): void {
    if (frame.type === "terminal.reset_required" || frame.type === "terminal.closed") {
      route.terminalLineages.delete(stringField(frame, "streamId"));
    }
  }

  /**
   * A correlated reset is terminal for the exact open/replay route lineage.
   * Replace the process-local token before asking H3 to detach so every late
   * callback from the old route is rejected even while H3 is still draining.
   */
  private fenceTerminalLineage(
    route: RouteState,
    authorityRoute: RelayV2HostRuntimeAuthorityRoute,
  ): void {
    if (this.exactAuthorityRoute(authorityRoute) !== route) return;
    const replaceBinding = this.isAdmitted(route) && !route.terminalUnbound;
    this.routesByRuntimeToken.delete(authorityRoute.runtimeBindingToken);
    route.terminalLineages.clear();
    for (const [requestId, pending] of route.pendingRequests) {
      if (pending.owner === "terminal") route.pendingRequests.delete(requestId);
    }
    route.terminalAdmissionReady = false;
    if (!replaceBinding) return;
    route.terminalDetachPending += 1;
    const replacement = createRelayV2TerminalRuntimeBinding(
      route.binding,
      randomBytes(32).toString("base64url"),
    );
    route.authorityRoute = replacement;
    this.routesByRuntimeToken.set(replacement.runtimeBindingToken, route);
    try {
      void Promise.resolve(
        this.options.terminals.unbind(terminalAuth(route), authorityRoute),
      ).then(
        () => {
          route.terminalDetachPending = Math.max(0, route.terminalDetachPending - 1);
          if (route.terminalDetachPending === 0 && this.isAdmitted(route)) {
            route.terminalAdmissionReady = true;
          }
          this.maybeRetireRoute(route);
        },
        () => this.failTerminalDetach(route),
      );
    } catch {
      this.failTerminalDetach(route);
    }
  }

  private failTerminalDetach(route: RouteState): void {
    // The obsolete H3 binding may still be live. Keep its detach charged in
    // the draining registry and fence the replacement route without retrying.
    route.terminalAdmissionReady = false;
    this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
  }

  private consumePending(route: RouteState, pending: PendingRequest): void {
    if (route.pendingRequests.get(pending.requestId) !== pending) {
      throw new Error("Relay v2 response attempted to consume an inactive request owner");
    }
    route.pendingRequests.delete(pending.requestId);
  }

  private assertPublicFrameSchema(frame: RelayV2JsonObject): void {
    encodeRelayV2WebSocketFrame("public", frame);
  }

  private handleResourceCallbackFailure(route: RouteState, _error: unknown): void {
    if (!this.isAdmitted(route)) return;
    this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
  }

  private scheduleRouteTask(
    route: RouteState,
    lane: "operationTail" | "callbackTail",
    task: () => Promise<void>,
    allowClosing = false,
  ): Promise<void> | null {
    const eligible = allowClosing
      ? this.isCurrent(route) && route.phase !== "closed"
      : this.isAdmitted(route);
    if (!eligible || route.pendingOperations >= this.limits.maxPendingOperationsPerRoute) {
      return null;
    }
    route.pendingOperations += 1;
    const execution = route[lane].then(task);
    const tracked = execution.finally(() => {
      route.pendingOperations = Math.max(0, route.pendingOperations - 1);
      this.maybeRetireRoute(route);
    });
    route[lane] = tracked.catch(() => undefined);
    return tracked;
  }

  private async handleAuthorityFailure(
    route: RouteState,
    pending: PendingRequest | null,
    error: unknown,
  ): Promise<void> {
    if (!this.isAdmitted(route)) return;
    if (pending && route.pendingRequests.get(pending.requestId) !== pending) {
      this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      return;
    }
    // H1/H3 may already have crossed a mutation boundary. A thrown error can
    // never be converted into not_accepted, retryable, or an invented result.
    if (!pending || pending.owner === "command") {
      this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      return;
    }
    const structured = structuredAuthorityError(error);
    if (!structured) {
      this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      return;
    }
    if (structured.code === "INTERNAL") {
      this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      return;
    }
    const identity = await this.verifyCurrentIdentity(route, pending, true);
    if (!identity || !this.isAdmitted(route)) return;
    if (pending.owner === "terminal") {
      const details = structured.code === "HOST_EPOCH_MISMATCH"
        ? {
            expectedHostEpoch: this.options.hostEpoch,
            actualHostEpoch: identity.hostEpoch,
          }
        : null;
      if (!this.enqueueError(
        route,
        pending,
        structured.code,
        AUTHORITY_ERROR_MESSAGES[structured.code],
        structured.code === "BUSY",
        false,
        details,
        identity.hostEpoch,
      )) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
        return;
      }
      this.consumePending(route, pending);
      return;
    }
    const exactDetails = exactErrorDetails(structured.code, structured.details);
    if ((structured.code === "HOST_EPOCH_MISMATCH"
      || structured.code === "EVENT_CURSOR_AHEAD"
      || structured.code === "SNAPSHOT_TOO_LARGE") && exactDetails === null) {
      this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
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
          : structured.code === "BUSY" && pending.owner === "hello"
            ? { code: 1013, reason: "slow_consumer" } as const
          : pending.owner === "hello"
            ? { code: 1011, reason: "authority_failure" } as const
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
    )) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
    } else {
      this.consumePending(route, pending);
    }
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
    )) {
      this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
    } else if (route.pendingRequests.get(pending.requestId) === pending) {
      this.consumePending(route, pending);
    }
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
      if (this.isAdmitted(route)) {
        this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      }
      return null;
    }
    if (!this.isCurrent(route)
      || this.activeCapabilities === null
      || (!route.accepting && !allowClosing)) return null;
    if (!identity) {
      this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      return null;
    }
    if (identity.hostEpoch !== this.options.hostEpoch) {
      if (!ownerInvoked && pending && isOpaque(identity?.hostEpoch)) {
        this.drainEpochMismatch(route, pending, this.options.hostEpoch, identity.hostEpoch);
      } else {
        this.closeImmediately(route, { code: 4400, reason: "protocol_error" });
      }
      return null;
    }
    if (identity.hostInstanceId !== this.options.hostInstanceId) {
      this.closeImmediately(route, { code: 4409, reason: "host_superseded" });
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
      throw new Error("Relay v2 authority returned a frame outside the frozen schema");
    }
    return this.enqueueOutboundBytes(route, bytes, allowClosing);
  }

  private enqueueOutboundBytes(
    route: RouteState,
    bytesInput: Uint8Array,
    allowClosing = false,
  ): boolean {
    if (!(bytesInput instanceof Uint8Array)) return false;
    const bytes = bytesInput.slice();
    if (!this.isCurrent(route)
      || (!route.accepting && !allowClosing)
      || route.phase === "closed") return false;
    if (bytes.byteLength > Math.min(MAX_PUBLIC_FRAME_BYTES, route.binding.maxFrameBytes)
      || route.outbound.length + route.outboundReservations.size
        >= this.limits.maxOutboundFramesPerRoute
      || route.outboundBytes + route.reservedOutboundBytes
        > this.limits.maxOutboundBytesPerRoute - bytes.byteLength) {
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

  private assertOptionalExtensionResponse(
    delivery: RelayV2HostOptionalExtensionDelivery,
    request: RelayV2HostOptionalExtensionRequestDescriptor,
    identity: RelayV2HostRuntimeIdentity,
  ): void {
    const frame = delivery?.frame;
    if (!(delivery?.bytes instanceof Uint8Array)
      || !frame
      || frame.kind !== "response"
      || frame.requestId !== request.requestId
      || frame.hostId !== request.hostId
      || frame.hostEpoch !== identity.hostEpoch
      || frame.scopeId !== request.scopeId
      || frame.sessionId !== request.sessionId
      || !Buffer.from(delivery.bytes).equals(Buffer.from(JSON.stringify(frame), "utf8"))) {
      throw new Error("Relay v2 optional extension returned a mismatched response");
    }
  }

  private publishOptionalExtensionDelivery(
    delivery: RelayV2HostOptionalExtensionDelivery,
  ): Promise<void> {
    if (!this.optionalExtensionIngressActive || !this.optionalExtensionReady) {
      return Promise.resolve();
    }
    const extension = this.optionalExtension;
    if (extension === null) return Promise.resolve();
    const frame = delivery?.frame;
    if (!(delivery?.bytes instanceof Uint8Array)
      || !frame
      || frame.kind !== "event"
      || frame.hostId !== this.options.hostId
      || frame.hostEpoch !== this.options.hostEpoch
      || !isOpaque(frame.scopeId)
      || !isOpaque(frame.sessionId)
      || !Buffer.from(delivery.bytes).equals(Buffer.from(JSON.stringify(frame), "utf8"))) {
      this.isolateOptionalExtensionFailure(
        new Error("Relay v2 optional extension published an invalid frame"),
      );
      return Promise.resolve();
    }
    const admitted: Promise<void>[] = [];
    for (const route of this.routesByCarrierKey.values()) {
      if (route.phase !== "ready" || !route.extensionNegotiated || !this.isAdmitted(route)) {
        continue;
      }
      const task = this.scheduleRouteTask(route, "callbackTail", async () => {
        if (!this.optionalExtensionIngressActive
          || !this.optionalExtensionReady
          || route.phase !== "ready"
          || !route.extensionNegotiated
          || !this.isAdmitted(route)) return;
        const identity = await this.verifyCurrentIdentity(route, null, true);
        if (!identity || frame.hostEpoch !== identity.hostEpoch) return;
        // The client grant is host-wide, but an extension event is target
        // scoped. Reuse the exact current H2 resolver cut for every route and
        // event; do not infer authorization from the route grant alone.
        const authorized = await extension.authorize(Object.freeze({
          principalId: route.auth.principalId,
          clientInstanceId: route.auth.clientInstanceId,
          hostId: route.auth.hostId,
          hostEpoch: identity.hostEpoch,
          scopeId: frame.scopeId as string,
          sessionId: frame.sessionId as string,
        }));
        if (!authorized || !this.optionalExtensionReady) return;
        if (!this.enqueueOutboundBytes(route, delivery.bytes)) {
          this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
        }
      });
      if (task !== null) {
        admitted.push(task.catch((error) => {
          this.isolateOptionalExtensionFailure(error);
        }));
      }
    }
    return Promise.all(admitted).then(() => undefined);
  }

  private isolateOptionalExtensionFailure(error: unknown): void {
    // Host owns the permanent ingress fence. The attachment callback is
    // untrusted and cannot retain or recover ingress even if it throws or
    // attempts to re-apply readiness through its old sink.
    this.fenceOptionalExtensionIngress();
    try { this.optionalExtension?.isolateFailure(error); } catch {}
  }

  /**
   * H2's synchronous enqueue is its public commit point, so it must own the
   * real encoded frame and route capacity before returning true.
   */
  private reserveOutbound(
    route: RouteState,
    frame: RelayV2JsonObject,
  ): OutboundReservation | null {
    if (!this.isAdmitted(route)) return null;
    let bytes: Uint8Array;
    try {
      bytes = encodeRelayV2WebSocketFrame("public", frame);
    } catch {
      throw new Error("Relay v2 authority returned a frame outside the frozen schema");
    }
    if (bytes.byteLength > Math.min(MAX_PUBLIC_FRAME_BYTES, route.binding.maxFrameBytes)
      || route.outbound.length + route.outboundReservations.size
        >= this.limits.maxOutboundFramesPerRoute
      || route.outboundBytes + route.reservedOutboundBytes
        > this.limits.maxOutboundBytesPerRoute - bytes.byteLength) {
      return null;
    }
    const reservation: OutboundReservation = { bytes, held: true };
    route.outboundReservations.add(reservation);
    route.reservedOutboundBytes += bytes.byteLength;
    return reservation;
  }

  private releaseOutboundReservation(
    route: RouteState,
    reservation: OutboundReservation,
  ): void {
    if (!reservation.held || !route.outboundReservations.delete(reservation)) return;
    reservation.held = false;
    route.reservedOutboundBytes = Math.max(
      0,
      route.reservedOutboundBytes - reservation.bytes.byteLength,
    );
    this.maybeRetireRoute(route);
  }

  private consumeOutboundReservation(
    route: RouteState,
    reservation: OutboundReservation,
  ): boolean {
    if (!reservation.held || !route.outboundReservations.has(reservation)) return false;
    if (!this.isAdmitted(route)) {
      this.releaseOutboundReservation(route, reservation);
      return false;
    }
    route.outboundReservations.delete(reservation);
    route.reservedOutboundBytes = Math.max(
      0,
      route.reservedOutboundBytes - reservation.bytes.byteLength,
    );
    reservation.held = false;
    route.outbound.push({
      bytes: reservation.bytes,
      receiptTimer: null,
      receiptSettled: false,
      admissionKnown: false,
      admitted: false,
      earlyReceipt: null,
    });
    route.outboundBytes += reservation.bytes.byteLength;
    this.flushOutbound(route);
    // A synchronous transport rejection may have fenced the route while the
    // locally committed reservation was being handed off. Never advance the
    // hello/event state after that fence.
    return this.isAdmitted(route);
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
    if (route.phase === "closed") {
      this.maybeRetireRoute(route);
      return;
    }
    if (!accepted) {
      if (this.isAdmitted(route)) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      }
      return;
    }
    route.validatingReceipt = true;
    const validation = this.scheduleRouteTask(route, "callbackTail", async () => {
      const identity = await this.verifyCurrentIdentity(route, null, true, true);
      route.validatingReceipt = false;
      if (!this.isCurrent(route)) return;
      if (!identity) {
        if (route.closeAfterDrain) this.finishClose(route, route.closeAfterDrain);
        return;
      }
      this.flushOutbound(route);
    }, true);
    if (!validation) {
      route.validatingReceipt = false;
      if (route.closeAfterDrain) {
        this.finishClose(route, route.closeAfterDrain);
      } else if (this.isAdmitted(route)) {
        this.closeImmediately(route, { code: 1013, reason: "slow_consumer" });
      }
      return;
    }
    void validation.catch(() => {
      route.validatingReceipt = false;
      if (route.closeAfterDrain) {
        this.finishClose(route, route.closeAfterDrain);
      } else if (this.isAdmitted(route)) {
        this.closeImmediately(route, { code: 1011, reason: "authority_failure" });
      }
    });
  }

  private closeImmediately(route: RouteState, close: RelayV2HostRuntimeClose): void {
    if (route.phase === "closed") return;
    this.finishClose(route, close);
  }

  private finishClose(route: RouteState, close: RelayV2HostRuntimeClose): void {
    if (route.phase === "closed" || route.closeSent) return;
    route.phase = "closing";
    route.closeSent = true;
    // Fence synchronous admission before exposing the selected close, but
    // publish that close before H3 detach can fail synchronously and compete.
    route.accepting = false;
    route.terminalAdmissionReady = false;
    route.closeAfterDrain = null;
    this.closeBinding(route.binding, close);
    this.fenceAdmission(route, false);
  }

  private closeBinding(binding: RelayV2HostRouteBinding, close: RelayV2HostRuntimeClose): void {
    try { this.options.outbound.close(binding, close); } catch {}
  }

  private fenceAdmission(route: RouteState, remove: boolean): void {
    route.accepting = false;
    route.terminalAdmissionReady = false;
    route.closeAfterDrain = null;
    if (remove) route.phase = "closed";
    if (!route.resourceUnsubscribed) {
      route.resourceUnsubscribed = true;
      try { this.options.resources.unsubscribe(route.subscriberId); } catch {}
    }
    route.pendingRequests.clear();
    route.terminalLineages.clear();
    if (!route.terminalUnbound) {
      route.terminalUnbound = true;
      route.terminalUnbindPending = true;
      try {
        void Promise.resolve(
          this.options.terminals.unbind(terminalAuth(route), route.authorityRoute),
        ).then(
          () => {
            route.terminalUnbindPending = false;
            this.maybeRetireRoute(route);
          },
          () => this.failTerminalUnbind(route),
        );
      } catch {
        this.failTerminalUnbind(route);
      }
    }
    this.fenceOutbound(route);
    if (remove) {
      this.routesByCarrierKey.delete(this.carrierKey(route.binding));
      this.routesByRuntimeToken.delete(route.authorityRoute.runtimeBindingToken);
    }
    this.maybeRetireRoute(route);
  }

  private failTerminalUnbind(route: RouteState): void {
    if (route.terminalUnbindFailed) return;
    route.terminalUnbindFailed = true;
    // No retry: the old H3 binding/backend may still be live authority. Keep
    // this route charged in the global draining registry until runtime teardown
    // and signal the exact connector fail-closed without pretending detach.
    if (!route.closeSent) {
      route.closeSent = true;
      this.closeBinding(route.binding, { code: 1011, reason: "authority_failure" });
    }
  }

  private fenceOutbound(route: RouteState): void {
    for (const reservation of [...route.outboundReservations]) {
      this.releaseOutboundReservation(route, reservation);
    }
    const inTransport = route.outbound[0];
    const retainTransport = !!inTransport
      && !inTransport.receiptSettled
      && route.sending
      && (!inTransport.admissionKnown || inTransport.admitted);
    for (const item of retainTransport ? route.outbound.slice(1) : route.outbound) {
      if (item.receiptTimer) clearTimeout(item.receiptTimer);
      item.receiptSettled = true;
    }
    route.outbound = retainTransport ? [inTransport] : [];
    route.outboundBytes = retainTransport ? inTransport.bytes.byteLength : 0;
    if (!retainTransport) route.sending = false;
    route.validatingReceipt = false;
  }

  private maybeRetireRoute(route: RouteState): void {
    if (route.phase !== "closed"
      || route.pendingOperations !== 0
      || route.terminalUnbindPending
      || route.terminalDetachPending !== 0
      || route.outboundReservations.size !== 0
      || route.outbound.length !== 0
      || route.validatingReceipt) return;
    this.routeRegistry.delete(route);
  }

  private exactAuthorityRoute(
    authorityRoute: RelayV2HostRuntimeAuthorityRoute,
  ): RouteState | undefined {
    if (!authorityRoute || typeof authorityRoute !== "object") return undefined;
    const route = this.routesByRuntimeToken.get(authorityRoute.runtimeBindingToken);
    if (!route
      || authorityRoute.runtimeBindingToken !== route.authorityRoute.runtimeBindingToken
      || authorityRoute.connectorId !== route.authorityRoute.connectorId
      || authorityRoute.routeId !== route.authorityRoute.routeId
      || authorityRoute.routeFence !== route.authorityRoute.routeFence) return undefined;
    return route;
  }

  private bindingRejection(
    code: RelayV2HostRouteBindingRejection["code"],
    message: string,
    retryable: boolean,
  ): RelayV2HostRouteBindingRejection {
    return Object.freeze({ accepted: false, code, message, retryable });
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
      && this.routesByRuntimeToken.get(route.authorityRoute.runtimeBindingToken) === route;
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

  private connectorGenerationKey(binding: Pick<
    RelayV2HostRouteBinding,
    "connectorGeneration" | "connectorId"
  >): string {
    return JSON.stringify([binding.connectorGeneration, binding.connectorId]);
  }
}
