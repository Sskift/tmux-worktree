import { types as NODE_TYPES } from "node:util";

import {
  RELAY_V2_BROKER_LIMITS,
  type RelayV2BrokerAction,
  type RelayV2BrokerConnectionAuthorization,
  type RelayV2BrokerResult,
  type RelayV2CarrierDelivery,
} from "./brokerCore.js";
import {
  createRelayV2BrokerHostWssCaptureAuthority,
  RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES,
  type RelayV2BrokerHostWssAdapter,
  type RelayV2BrokerHostWssCaptureAuthority,
  type RelayV2BrokerHostWssSocket,
  type RelayV2BrokerHostWssTerminalEvidence,
  type RelayV2BrokerHostWssTrustedSocketBrand,
} from "./brokerHostWssAdapter.js";
import type {
  RelayV2BrokerProducerAction,
  RelayV2BrokerProducerEffectFence,
  RelayV2BrokerProducerPort,
  RelayV2BrokerProducerReceipt,
  RelayV2BrokerProducerTerminalFailure,
} from "./brokerProducerRegistry.js";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "./codec.js";

const MAX_INGRESS_BYTES = 16 * 1_048_576;
const MAX_INGRESS_FRAMES = 1_024;
const INGRESS_WATER_BYTES = 8 * 1_048_576;
const INGRESS_WATER_FRAMES = 512;
const MAX_ROUTE_BYTES = 1_048_576;
const MAX_ROUTE_FRAMES = 128;
const CONTROL_RESERVE_BYTES = 64 * 1_024;
const CONTROL_RESERVE_FRAMES = 16;

const PREPARE_KEYS = Object.freeze(["trustedAuthContext"] as const);
const ATTACH_KEYS = Object.freeze(["receipt", "alreadyUpgradedSocket"] as const);
const AUTHORIZATION_KEYS = Object.freeze([
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

type HostFrameIdentity = Readonly<{
  type: string;
  routeId: string | null;
  control: boolean;
  routeBytes: number;
}>;

type IngressEntry = {
  readonly bytes: Uint8Array;
  readonly identity: HostFrameIdentity;
  state: "pending" | "processing";
};

type DirectSend = Readonly<{
  kind: "direct";
  bytes: Uint8Array;
  deliveryId: string | null;
  registration: boolean;
}>;

type CarrierSend = Readonly<{
  kind: "carrier";
  bytes: Uint8Array;
  deliveryId: string;
}>;

type OutboundSend = DirectSend | CarrierSend;

interface RelayV2BrokerHostWssOwnerSession {
  readonly transportId: string;
  readonly connectionIncarnation: string;
  readonly producerGeneration: string;
  attach(authContext: RelayV2BrokerConnectionAuthorization): void;
  registerExpiry(): void;
  receiveHostFrame(bytes: Uint8Array, signal: AbortSignal): Promise<RelayV2BrokerProducerReceipt>;
  drainHostCarrier(options: Readonly<{
    maxFrames: number;
    maxBytes: number;
    controlOnly?: boolean;
  }>): readonly RelayV2CarrierDelivery[];
  acknowledgeHostControlDelivery(deliveryId: string): RelayV2BrokerProducerReceipt;
  rejectHostControlDelivery(deliveryId: string): RelayV2BrokerProducerReceipt;
  acknowledgeHostDelivery(deliveryId: string): RelayV2BrokerProducerReceipt;
  disconnectHost(): RelayV2BrokerProducerReceipt;
  beginProducerClose(barrier: Promise<unknown>): void;
  terminalAndUnregister(): Promise<void>;
  rollbackConstruction(): Promise<void>;
}

/** Type-only binding; the live instance never crosses the safe facade claim. */
export interface RelayV2BrokerHostWssRuntimeOwnerBinding {
  createSession(input: Readonly<{
    producerPort: RelayV2BrokerProducerPort;
    close(code: number, reason: string): unknown;
    forceDestroy(): unknown;
  }>): RelayV2BrokerHostWssOwnerSession;
}

declare const RELAY_V2_BROKER_HOST_WSS_RECEIPT: unique symbol;
export interface RelayV2BrokerHostWssAdmissionReceipt {
  readonly [RELAY_V2_BROKER_HOST_WSS_RECEIPT]: never;
}

export type RelayV2BrokerHostWssPrepareResult = Readonly<
  | { outcome: "accept"; receipt: RelayV2BrokerHostWssAdmissionReceipt }
  | { outcome: "reject"; status: 503 }
>;

export interface RelayV2BrokerHostWssConnectionHandle {
  readonly transportId: string;
  readonly connectionIncarnation: string;
  readonly producerGeneration: string;
  readonly terminal: Promise<RelayV2BrokerHostWssTerminalEvidence>;
  readonly drained: Promise<void>;
}

export interface RelayV2BrokerHostWssRuntimeFacade {
  prepareHostWss(input: Readonly<{
    trustedAuthContext: RelayV2BrokerConnectionAuthorization;
  }>): RelayV2BrokerHostWssPrepareResult;
  attachPreparedHostWss(input: Readonly<{
    receipt: RelayV2BrokerHostWssAdmissionReceipt;
    alreadyUpgradedSocket: RelayV2BrokerHostWssSocket;
  }>): RelayV2BrokerHostWssConnectionHandle;
  closeAndDrain(): Promise<void>;
}

type ReceiptRecord = {
  readonly owner: RelayV2BrokerHostWssRuntimeCompositionImpl;
  readonly authContext: RelayV2BrokerConnectionAuthorization;
  phase: "issued" | "consumed";
};

const RECEIPTS = new WeakMap<object, ReceiptRecord>();

type AttachReservation = Readonly<{
  barrier: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}>;

type FailedConstructionCleanup = Readonly<{
  retry(): Promise<void>;
}>;

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return NODE_TYPES.isProxy(value);
  } catch {
    return true;
  }
}

function ownDataValues(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
    ) return null;
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of exactKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return null;
  }
}

function captureAuthorization(value: unknown): RelayV2BrokerConnectionAuthorization | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== AUTHORIZATION_KEYS.length
      || keys.some((key) => typeof key !== "string" || !AUTHORIZATION_KEYS.includes(
        key as typeof AUTHORIZATION_KEYS[number],
      ))
    ) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      snapshot[key] = descriptor.value;
    }
    if (snapshot.role !== "host") return null;
    return Object.freeze(snapshot) as unknown as RelayV2BrokerConnectionAuthorization;
  } catch {
    return null;
  }
}

function frameIdentity(bytes: Uint8Array): HostFrameIdentity {
  const frame = decodeRelayV2WebSocketFrame("carrier", bytes, {
    opcode: "text",
    compressed: false,
  }).frame;
  const type = frame.type as string;
  return Object.freeze({
    type,
    routeId: typeof frame.routeId === "string" ? frame.routeId : null,
    control: type !== "route.data",
    routeBytes: type === "route.data"
      ? Buffer.from((frame.payload as { data: string }).data, "base64").byteLength
      : 0,
  });
}

function hostAction(action: RelayV2BrokerAction): action is RelayV2BrokerProducerAction {
  return action.kind === "host_output_ready"
    || action.kind === "send_host"
    || action.kind === "close_host"
    || action.kind === "pause_host_route"
    || action.kind === "resume_host_route";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function attachReservation(): AttachReservation {
  const state = deferred<void>();
  return Object.freeze({
    barrier: state.promise,
    resolve: () => state.resolve(undefined),
    reject: state.reject,
  });
}

function hostWssClosedError(): Error {
  return new Error("Relay v2 Broker Host WSS closed");
}

class HostWssConnection {
  readonly terminal: Promise<RelayV2BrokerHostWssTerminalEvidence>;
  readonly drained: Promise<void>;

  private phase: "attaching" | "open" | "closing" | "terminal" = "attaching";
  private frameAdmission = false;
  private actionAdmission = true;
  private ingressBytes = 0;
  private socketPaused = false;
  private ingressRunning = false;
  private ingressEntries: IngressEntry[] = [];
  private routeCursor = 0;
  private blockedRoutes = new Set<string>();
  private directQueue: DirectSend[] = [];
  private directBytes = 0;
  private outbound: OutboundSend | null = null;
  private pendingBrokerClose: Readonly<{ code: number; reason: string }> | null = null;
  private outboundWakeQueued = false;
  private receiveAbort: AbortController | null = null;
  private producerCloseStarted = false;
  private disconnectStarted = false;
  private terminalSeen = false;
  private cleanupStarted = false;
  private nativeCloseRequested = false;
  private nativeForceRequested = false;
  private constructionRolledBack = false;
  private constructionForceApplied = false;
  private readonly terminalDeferred = deferred<RelayV2BrokerHostWssTerminalEvidence>();
  private readonly drainedDeferred = deferred<void>();

  constructor(
    private readonly owner: RelayV2BrokerHostWssRuntimeCompositionImpl,
    private readonly adapter: RelayV2BrokerHostWssAdapter,
    readonly session: RelayV2BrokerHostWssOwnerSession,
    private readonly authContext: RelayV2BrokerConnectionAuthorization,
  ) {
    this.terminal = this.terminalDeferred.promise;
    this.drained = this.drainedDeferred.promise;
  }

  producerPort(): RelayV2BrokerProducerPort {
    return Object.freeze(Object.create(null, {
      apply: {
        value: (
          actions: readonly RelayV2BrokerAction[],
          fence: RelayV2BrokerProducerEffectFence,
        ) => this.applyProducerActions(actions, fence),
        enumerable: true,
      },
      forceTerminal: {
        value: (
          failure: RelayV2BrokerProducerTerminalFailure,
          fence: RelayV2BrokerProducerEffectFence,
        ) => this.forceProducerTerminal(failure, fence),
        enumerable: true,
      },
    })) as RelayV2BrokerProducerPort;
  }

  attach(mayContinue: () => boolean): void {
    this.adapter.install(Object.freeze({
      message: ({ bytes }) => this.acceptFrame(bytes),
      invalidFrame: (reason) => this.invalidFrame(reason),
      terminal: (evidence) => this.observeTerminal(evidence),
    }));
    if (this.phase !== "attaching" || !mayContinue()) {
      throw new Error("Host WSS attach was fenced");
    }
    this.session.attach(this.authContext);
    if (this.phase !== "attaching" || !mayContinue()) {
      throw new Error("Host WSS attach was fenced");
    }
    this.session.registerExpiry();
    if (this.phase !== "attaching" || !mayContinue()) {
      throw new Error("Host WSS attach was fenced");
    }
    this.phase = "open";
    this.frameAdmission = true;
  }

  rollbackConstruction(): Promise<void> {
    if (this.constructionRolledBack) return this.drained;
    this.constructionRolledBack = true;
    this.phase = "closing";
    this.frameAdmission = false;
    this.actionAdmission = false;
    this.receiveAbort?.abort();
    this.receiveAbort = null;
    this.ingressEntries = [];
    this.ingressBytes = 0;
    this.blockedRoutes.clear();
    this.directQueue = [];
    this.directBytes = 0;
    this.outbound = null;
    this.pendingBrokerClose = null;
    if (!this.producerCloseStarted) {
      this.producerCloseStarted = true;
      try { this.session.beginProducerClose(Promise.resolve()); } catch {}
    }
    if (!this.disconnectStarted) {
      this.disconnectStarted = true;
      try { this.session.disconnectHost(); } catch {}
    }
    this.constructionForceApplied = this.adapter.forceDestroy() === "applied";
    void (async () => {
      let failed = false;
      try { this.adapter.cleanup(); } catch { failed = true; }
      try { await this.session.rollbackConstruction(); } catch { failed = true; }
      if (!this.constructionForceApplied) {
        this.constructionForceApplied = this.adapter.forceDestroy() === "applied";
      }
      if (!this.constructionForceApplied) failed = true;
      if (failed) throw hostWssClosedError();
    })().then(this.drainedDeferred.resolve, this.drainedDeferred.reject);
    return this.drained;
  }

  async retryConstructionCleanup(): Promise<void> {
    let failed = false;
    try { this.adapter.cleanup(); } catch { failed = true; }
    try { await this.session.rollbackConstruction(); } catch { failed = true; }
    if (!this.constructionForceApplied) {
      this.constructionForceApplied = this.adapter.forceDestroy() === "applied";
    }
    if (!this.constructionForceApplied) failed = true;
    if (failed) throw hostWssClosedError();
  }

  shutdown(): Promise<void> {
    this.beginClose(1013, "broker_shutdown", false);
    return this.drained;
  }

  ownerRequestedClose(code: number, reason: string): unknown {
    this.beginClose(code, reason, false);
    return undefined;
  }

  ownerRequestedForceDestroy(): unknown {
    this.requestNativeForceDestroy();
    return undefined;
  }

  private acceptFrame(bytes: Uint8Array): void {
    if (!this.frameAdmission || this.phase !== "open") return;
    let identity: HostFrameIdentity;
    try {
      if (bytes.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES) {
        throw new Error("oversize");
      }
      identity = frameIdentity(bytes);
    } catch {
      this.beginClose(4400, "invalid_host_carrier_frame", false);
      return;
    }
    const route = identity.routeId === null || identity.control
      ? { bytes: 0, frames: 0 }
      : this.routeUsage(identity.routeId);
    const byteLimit = identity.control
      ? MAX_INGRESS_BYTES
      : MAX_INGRESS_BYTES - CONTROL_RESERVE_BYTES;
    const frameLimit = identity.control
      ? MAX_INGRESS_FRAMES
      : MAX_INGRESS_FRAMES - CONTROL_RESERVE_FRAMES;
    if (
      bytes.byteLength > byteLimit - this.ingressBytes
      || this.ingressEntries.length >= frameLimit
      || (!identity.control && identity.routeId !== null && (
        identity.routeBytes > MAX_ROUTE_BYTES - route.bytes
        || route.frames >= MAX_ROUTE_FRAMES
      ))
    ) {
      this.beginClose(1013, "host_ingress_saturated", false);
      return;
    }
    this.ingressEntries.push({ bytes: bytes.slice(), identity, state: "pending" });
    this.ingressBytes += bytes.byteLength;
    this.updateSocketPressure();
    this.pumpIngress();
  }

  private invalidFrame(reason: "binary" | "oversize" | "invalid"): void {
    if (!this.frameAdmission) return;
    this.beginClose(4400, reason === "binary"
      ? "binary_frame_unsupported"
      : "invalid_host_carrier_frame", false);
  }

  private routeUsage(routeId: string): { bytes: number; frames: number } {
    let bytes = 0;
    let frames = 0;
    for (const entry of this.ingressEntries) {
      if (entry.identity.routeId !== routeId || entry.identity.control) continue;
      bytes += entry.identity.routeBytes;
      frames += 1;
    }
    return { bytes, frames };
  }

  private selectIngress(): IngressEntry | undefined {
    const control = this.ingressEntries.find((entry) => (
      entry.state === "pending" && entry.identity.control
    ));
    if (control) return control;
    const routeIds: string[] = [];
    for (const entry of this.ingressEntries) {
      const routeId = entry.identity.routeId;
      if (
        entry.state !== "pending"
        || routeId === null
        || this.blockedRoutes.has(routeId)
        || routeIds.includes(routeId)
      ) continue;
      routeIds.push(routeId);
    }
    if (routeIds.length === 0) return undefined;
    if (this.routeCursor >= routeIds.length) this.routeCursor = 0;
    const routeId = routeIds[this.routeCursor]!;
    this.routeCursor = (this.routeCursor + 1) % routeIds.length;
    return this.ingressEntries.find((entry) => (
      entry.state === "pending" && entry.identity.routeId === routeId
    ));
  }

  private pumpIngress(): void {
    if (this.ingressRunning || this.phase !== "open") return;
    const entry = this.selectIngress();
    if (!entry) return;
    this.ingressRunning = true;
    entry.state = "processing";
    const abort = new AbortController();
    this.receiveAbort = abort;
    let receive: Promise<RelayV2BrokerProducerReceipt>;
    try {
      receive = this.session.receiveHostFrame(entry.bytes, abort.signal);
    } catch {
      receive = Promise.reject(error);
    }
    void receive.then(
      (receipt) => this.completeIngress(entry, receipt === "applied"),
      () => this.completeIngress(entry, false),
    );
  }

  private completeIngress(entry: IngressEntry, accepted: boolean): void {
    if (this.receiveAbort) this.receiveAbort = null;
    this.ingressRunning = false;
    const index = this.ingressEntries.indexOf(entry);
    if (index >= 0) {
      this.ingressEntries.splice(index, 1);
      this.ingressBytes -= entry.bytes.byteLength;
    }
    this.updateSocketPressure();
    if (!accepted && this.phase === "open") {
      this.beginClose(1013, "host_frame_dispatch_failed", false);
      return;
    }
    this.scheduleOutbound();
    this.pumpIngress();
  }

  private updateSocketPressure(): void {
    const pressured = this.ingressBytes >= INGRESS_WATER_BYTES
      || this.ingressEntries.length >= INGRESS_WATER_FRAMES;
    if (pressured && !this.socketPaused && this.phase === "open") {
      if (this.adapter.pause() !== "applied") {
        this.beginClose(1013, "host_socket_pause_failed", false);
        return;
      }
      this.socketPaused = true;
    } else if (!pressured && this.socketPaused && this.phase === "open") {
      if (this.adapter.resume() !== "applied") {
        this.beginClose(1013, "host_socket_resume_failed", false);
        return;
      }
      this.socketPaused = false;
    }
  }

  private applyProducerActions(
    actions: readonly RelayV2BrokerAction[],
    fence: RelayV2BrokerProducerEffectFence,
  ): RelayV2BrokerProducerReceipt {
    if (!this.actionAdmission || this.phase === "terminal") return "rejected";
    let current = false;
    try {
      current = fence.mayApply()
        && fence.target.transportId === this.session.transportId
        && fence.target.generation === this.session.producerGeneration;
    } catch {
      current = false;
    }
    if (!current) return "rejected";
    for (const action of actions) {
      if (!hostAction(action) || action.transportId !== this.session.transportId) return "rejected";
      if (
        "connectionIncarnation" in action
        && action.connectionIncarnation !== this.session.connectionIncarnation
      ) return "rejected";
      switch (action.kind) {
        case "send_host": {
          let bytes: Uint8Array;
          try {
            bytes = encodeRelayV2WebSocketFrame("carrier", action.frame);
          } catch {
            this.beginClose(4400, "invalid_broker_carrier_frame", false);
            return "rejected";
          }
          if (
            bytes.byteLength > CONTROL_RESERVE_BYTES - this.directBytes
            || this.directQueue.length + (this.outbound?.kind === "direct" ? 1 : 0)
              >= CONTROL_RESERVE_FRAMES
          ) {
            this.beginClose(1013, "host_control_reserve_saturated", false);
            return "rejected";
          }
          this.directQueue.push(Object.freeze({
            kind: "direct",
            bytes,
            deliveryId: action.deliveryId ?? null,
            registration: action.frame.type === "host.registered",
          }));
          this.directBytes += bytes.byteLength;
          break;
        }
        case "pause_host_route":
          if (this.blockedRoutes.size >= MAX_INGRESS_FRAMES
            && !this.blockedRoutes.has(action.routeId)) {
            this.beginClose(1013, "host_route_pause_saturated", false);
            return "rejected";
          }
          this.blockedRoutes.add(action.routeId);
          break;
        case "resume_host_route":
          this.blockedRoutes.delete(action.routeId);
          this.pumpIngress();
          break;
        case "close_host":
          if (this.directQueue.length > 0 || this.outbound?.kind === "direct") {
            this.pendingBrokerClose = Object.freeze({
              code: action.closeCode,
              reason: action.reason,
            });
          } else {
            this.beginClose(action.closeCode, action.reason, false);
          }
          break;
        case "host_output_ready":
          break;
      }
    }
    this.scheduleOutbound();
    return "applied";
  }

  private forceProducerTerminal(
    failure: RelayV2BrokerProducerTerminalFailure,
    fence: RelayV2BrokerProducerEffectFence,
  ): RelayV2BrokerProducerReceipt {
    let current = false;
    try {
      current = fence.mayApply()
        && failure.target.transportId === this.session.transportId
        && failure.target.generation === this.session.producerGeneration;
    } catch {}
    if (!current) return "rejected";
    this.beginClose(1013, "host_producer_failure", true);
    return "applied";
  }

  private scheduleOutbound(): void {
    if (this.outboundWakeQueued || this.outbound || this.phase !== "open") return;
    this.outboundWakeQueued = true;
    queueMicrotask(() => {
      this.outboundWakeQueued = false;
      try {
        this.pumpOutbound();
      } catch {
        this.outbound = null;
        this.beginClose(1013, "host_outbound_pump_failed", false);
      }
    });
  }

  private pumpOutbound(): void {
    if (this.outbound || this.phase !== "open") return;
    const buffered = this.adapter.bufferedAmount();
    if (buffered === null) {
      this.beginClose(1013, "invalid_host_socket_buffered_amount", false);
      return;
    }
    let next: OutboundSend | undefined = this.directQueue[0];
    if (next) {
      if (next.bytes.byteLength > RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - buffered) {
        this.beginClose(1013, "host_socket_buffer_saturated", false);
        return;
      }
      this.directQueue.shift();
    }
    if (!next) {
      if (buffered >= RELAY_V2_BROKER_LIMITS.carrierBufferedBytes) {
        return;
      }
      const [delivery] = this.session.drainHostCarrier({
        maxFrames: 1,
        maxBytes: Math.min(
          RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES,
          RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - buffered,
        ),
        controlOnly: true,
      });
      const selected = delivery ?? this.session.drainHostCarrier({
        maxFrames: 1,
        maxBytes: Math.min(
          RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES,
          RELAY_V2_BROKER_LIMITS.carrierBufferedBytes - buffered,
        ),
      })[0];
      if (selected) {
        next = Object.freeze({
          kind: "carrier",
          bytes: selected.wire,
          deliveryId: selected.deliveryId,
        });
      }
    }
    if (!next) return;
    this.outbound = next;
    const receipt = this.adapter.send(next.bytes, (completion) => {
      this.completeOutbound(next!, completion === "delivered");
    });
    if (receipt !== "applied") this.completeOutbound(next, false);
  }

  private completeOutbound(entry: OutboundSend, delivered: boolean): void {
    if (this.outbound !== entry) return;
    this.outbound = null;
    if (entry.kind === "direct") {
      this.directBytes = Math.max(0, this.directBytes - entry.bytes.byteLength);
    }
    let acknowledged: RelayV2BrokerProducerReceipt = "applied";
    try {
      if (entry.kind === "direct" && entry.deliveryId !== null) {
        acknowledged = delivered
          ? this.session.acknowledgeHostControlDelivery(entry.deliveryId)
          : this.session.rejectHostControlDelivery(entry.deliveryId);
      } else if (entry.kind === "carrier" && delivered) {
        acknowledged = this.session.acknowledgeHostDelivery(entry.deliveryId);
      }
    } catch {
      acknowledged = "rejected";
    }
    if (!delivered || acknowledged !== "applied") {
      this.beginClose(1013, "carrier_write_failed", false);
      if (this.terminalSeen) this.finishDrain();
      return;
    }
    if (this.directQueue.length === 0 && this.pendingBrokerClose) {
      const close = this.pendingBrokerClose;
      this.pendingBrokerClose = null;
      this.beginClose(close.code, close.reason, false);
      if (this.terminalSeen) this.finishDrain();
      return;
    }
    if (this.terminalSeen) {
      this.finishDrain();
      return;
    }
    this.scheduleOutbound();
  }

  private beginClose(
    code: number,
    reason: string,
    force: boolean,
    requestNative = true,
  ): void {
    if (this.phase === "terminal") return;
    if (this.phase !== "closing") {
      this.phase = "closing";
      this.frameAdmission = false;
      this.actionAdmission = false;
      this.receiveAbort?.abort();
      this.receiveAbort = null;
      this.ingressEntries = [];
      this.ingressBytes = 0;
      this.blockedRoutes.clear();
      this.pendingBrokerClose = null;
      if (!this.producerCloseStarted) {
        this.producerCloseStarted = true;
        try { this.session.beginProducerClose(this.drained); } catch {}
      }
      if (!this.disconnectStarted) {
        this.disconnectStarted = true;
        try { this.session.disconnectHost(); } catch {}
      }
    }
    if (requestNative) {
      let closeRejected = false;
      if (!this.nativeCloseRequested) {
        this.nativeCloseRequested = true;
        closeRejected = this.adapter.close(code, reason) !== "applied";
      }
      if (force || closeRejected) this.requestNativeForceDestroy();
    }
  }

  private requestNativeForceDestroy(): void {
    if (this.nativeForceRequested || this.terminalSeen) return;
    this.nativeForceRequested = this.adapter.forceDestroy() === "applied";
  }

  private observeTerminal(evidence: RelayV2BrokerHostWssTerminalEvidence): void {
    if (this.terminalSeen) return;
    this.terminalSeen = true;
    this.beginClose(1013, "native_terminal", false, false);
    this.phase = "terminal";
    const abandoned = this.outbound;
    this.outbound = null;
    this.directQueue = [];
    this.directBytes = 0;
    this.pendingBrokerClose = null;
    if (abandoned?.kind === "direct" && abandoned.deliveryId !== null) {
      try { this.session.rejectHostControlDelivery(abandoned.deliveryId); } catch {}
    }
    this.terminalDeferred.resolve(evidence);
    this.finishDrain();
  }

  private finishDrain(): void {
    if (this.cleanupStarted || !this.terminalSeen || this.outbound !== null) return;
    this.cleanupStarted = true;
    void (async () => {
      const failures: unknown[] = [];
      const ownerCleanup = await Promise.allSettled([
        this.session.terminalAndUnregister(),
      ]);
      if (ownerCleanup[0].status === "rejected") failures.push(ownerCleanup[0].reason);
      try { this.adapter.cleanup(); } catch (error) { failures.push(error); }
      this.owner.remove(this);
      if (failures.length > 0) throw hostWssClosedError();
    })().then(this.drainedDeferred.resolve, this.drainedDeferred.reject);
  }
}

class StagedHostWssLifecycleBridge {
  private connection: HostWssConnection | null = null;
  private fenced = false;

  constructor(private readonly adapter: RelayV2BrokerHostWssAdapter) {}

  bind(connection: HostWssConnection): void {
    if (this.connection !== null) throw new Error("Host WSS lifecycle bridge was already bound");
    this.connection = connection;
  }

  mayAttach(): boolean {
    return !this.fenced;
  }

  close(code: number, reason: string): unknown {
    this.fenced = true;
    if (this.connection) return this.connection.ownerRequestedClose(code, reason);
    if (this.adapter.close(code, reason) !== "applied") this.adapter.forceDestroy();
    return undefined;
  }

  forceDestroy(): unknown {
    this.fenced = true;
    if (this.connection) return this.connection.ownerRequestedForceDestroy();
    this.adapter.forceDestroy();
    return undefined;
  }
}

class RelayV2BrokerHostWssRuntimeCompositionImpl {
  private admissionOpen = true;
  private closeDrain: Promise<void> | null = null;
  private readonly connections = new Set<HostWssConnection>();
  private readonly reservations = new Set<AttachReservation>();
  private readonly failedConstructionCleanups = new Set<FailedConstructionCleanup>();
  private readonly captureAuthority: RelayV2BrokerHostWssCaptureAuthority;
  private partialDrainFailed = false;
  private partialDrainFailure: unknown;

  constructor(
    private readonly ownerBinding: RelayV2BrokerHostWssRuntimeOwnerBinding,
    trustedSocketPrototype: object,
    trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
  ) {
    this.captureAuthority = createRelayV2BrokerHostWssCaptureAuthority(
      trustedSocketPrototype,
      trustedSocketBrand,
    );
  }

  prepareHostWss(input: Readonly<{
    trustedAuthContext: RelayV2BrokerConnectionAuthorization;
  }>): RelayV2BrokerHostWssPrepareResult {
    if (!this.admissionOpen) return Object.freeze({ outcome: "reject", status: 503 });
    const values = ownDataValues(input, PREPARE_KEYS);
    const authContext = values ? captureAuthorization(values.trustedAuthContext) : null;
    if (!authContext || !this.admissionOpen) {
      return Object.freeze({ outcome: "reject", status: 503 });
    }
    const receipt = Object.freeze(Object.create(null)) as RelayV2BrokerHostWssAdmissionReceipt;
    RECEIPTS.set(receipt, { owner: this, authContext, phase: "issued" });
    return Object.freeze({ outcome: "accept", receipt });
  }

  attachPreparedHostWss(input: Readonly<{
    receipt: RelayV2BrokerHostWssAdmissionReceipt;
    alreadyUpgradedSocket: RelayV2BrokerHostWssSocket;
  }>): RelayV2BrokerHostWssConnectionHandle {
    if (!this.admissionOpen) throw new Error("Relay v2 Broker Host WSS runtime is closing");
    const values = ownDataValues(input, ATTACH_KEYS);
    if (!values || !this.admissionOpen) throw new Error("invalid Host WSS attach input");
    const receipt = values.receipt;
    const record = receipt !== null && typeof receipt === "object"
      ? RECEIPTS.get(receipt as object)
      : undefined;
    if (!record || record.owner !== this || record.phase !== "issued") {
      throw new Error("invalid Relay v2 Broker Host WSS admission receipt");
    }
    record.phase = "consumed";
    const reservation = attachReservation();
    this.reservations.add(reservation);
    let adapter: RelayV2BrokerHostWssAdapter | null = null;
    let connection: HostWssConnection | null = null;
    try {
      adapter = this.captureAuthority.capture(
        values.alreadyUpgradedSocket as RelayV2BrokerHostWssSocket,
      );
      if (adapter.validate() !== "applied") throw hostWssClosedError();
      if (!this.admissionOpen) throw new Error("Host WSS attach crossed close during capture");
      const bridge = new StagedHostWssLifecycleBridge(adapter);
      const producerPort = Object.freeze(Object.create(null, {
        apply: {
          enumerable: true,
          value: (...args: Parameters<RelayV2BrokerProducerPort["apply"]>) => (
            connection?.producerPort().apply(...args) ?? "rejected"
          ),
        },
        forceTerminal: {
          enumerable: true,
          value: (...args: Parameters<RelayV2BrokerProducerPort["forceTerminal"]>) => (
            connection?.producerPort().forceTerminal(...args) ?? "rejected"
          ),
        },
      })) as RelayV2BrokerProducerPort;
      const session = this.ownerBinding.createSession(Object.freeze({
        producerPort,
        close: (code: number, reason: string) => bridge.close(code, reason),
        forceDestroy: () => bridge.forceDestroy(),
      }));
      connection = new HostWssConnection(this, adapter, session, record.authContext);
      bridge.bind(connection);
      if (!this.admissionOpen || !bridge.mayAttach()) {
        throw new Error("Host WSS attach crossed close during owner open");
      }
      connection.attach(() => this.admissionOpen && bridge.mayAttach());
      if (!this.admissionOpen || !bridge.mayAttach()) {
        throw new Error("Host WSS attach crossed close during construction");
      }
      this.connections.add(connection);
      this.reservations.delete(reservation);
      reservation.resolve();
      return Object.freeze({
        transportId: session.transportId,
        connectionIncarnation: session.connectionIncarnation,
        producerGeneration: session.producerGeneration,
        terminal: connection.terminal,
        drained: connection.drained,
      });
    } catch {
      const failedCleanup = Object.freeze({
        retry: () => connection
          ? connection.retryConstructionCleanup()
          : this.rollbackCapturedAdapter(adapter, 1),
      });
      const rollback = connection
        ? connection.rollbackConstruction()
        : this.rollbackCapturedAdapter(adapter, 2);
      void rollback.then(
        () => {
          this.reservations.delete(reservation);
          reservation.resolve();
        },
        (rollbackError) => {
          this.recordPartialDrainFailure(rollbackError);
          this.failedConstructionCleanups.add(failedCleanup);
          this.reservations.delete(reservation);
          reservation.reject(rollbackError);
        },
      );
      throw hostWssClosedError();
    }
  }

  private sealAdmission(): void {
    this.admissionOpen = false;
  }

  closeAndDrain(): Promise<void> {
    if (this.closeDrain) return this.closeDrain;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const published = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void published.catch(() => {});
    this.closeDrain = published;
    this.sealAdmission();
    const barriers: Promise<void>[] = [];
    for (const connection of this.connections) barriers.push(connection.shutdown());
    for (const reservation of this.reservations) barriers.push(reservation.barrier);
    void this.finishClose(barriers).then(resolveClose, rejectClose);
    return published;
  }

  remove(connection: HostWssConnection): void {
    this.connections.delete(connection);
  }

  private recordPartialDrainFailure(error: unknown): void {
    if (!this.partialDrainFailed) this.partialDrainFailure = error;
    this.partialDrainFailed = true;
    this.admissionOpen = false;
  }

  private async finishClose(barriers: readonly Promise<void>[]): Promise<void> {
    const settlements = await Promise.allSettled(barriers);
    const failures = settlements
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    const failedCleanups = [...this.failedConstructionCleanups];
    const cleanupSettlements = await Promise.allSettled(
      failedCleanups.map((cleanup) => cleanup.retry()),
    );
    for (let index = 0; index < cleanupSettlements.length; index += 1) {
      if (cleanupSettlements[index]?.status === "fulfilled") {
        this.failedConstructionCleanups.delete(failedCleanups[index]!);
      }
    }
    if (this.partialDrainFailed) {
      if (failures.every((failure) => failure === this.partialDrainFailure)) {
        throw this.partialDrainFailure;
      }
      throw hostWssClosedError();
    }
    if (failures.length > 0) throw hostWssClosedError();
  }

  private async rollbackCapturedAdapter(
    adapter: RelayV2BrokerHostWssAdapter | null,
    forceAttempts: number,
  ): Promise<void> {
    if (!adapter) return;
    let failed = false;
    try { adapter.cleanup(); } catch { failed = true; }
    let forced = false;
    for (let attempt = 0; attempt < forceAttempts && !forced; attempt += 1) {
      forced = adapter.forceDestroy() === "applied";
    }
    if (!forced) failed = true;
    if (failed) throw hostWssClosedError();
  }
}

export function bindRelayV2BrokerHostWssRuntimeFacade(
  ownerBinding: RelayV2BrokerHostWssRuntimeOwnerBinding,
  trustedSocketPrototype: object,
  trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
): RelayV2BrokerHostWssRuntimeFacade {
  const runtime = new RelayV2BrokerHostWssRuntimeCompositionImpl(
    ownerBinding,
    trustedSocketPrototype,
    trustedSocketBrand,
  );
  return Object.freeze({
    prepareHostWss: runtime.prepareHostWss.bind(runtime),
    attachPreparedHostWss: runtime.attachPreparedHostWss.bind(runtime),
    closeAndDrain: runtime.closeAndDrain.bind(runtime),
  });
}
