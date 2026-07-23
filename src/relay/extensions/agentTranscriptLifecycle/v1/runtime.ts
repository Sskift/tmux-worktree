import type { RelayV2FrameMetadata } from "../../../v2/codec.js";
import type { RelayV2JsonObject } from "../../../v2/codecSchema.js";
import {
  decodeRelayAgentTranscriptLifecycleFrame,
  encodeRelayAgentTranscriptLifecycleFrame,
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
} from "./codec.js";
/*
 * Binding normalization stays in the authority trust boundary. This runtime
 * owns only the process-local publication attempt and ingest admission.
 */
import {
  normalizeRelayAgentTrustedAdapterBinding,
  type RelayAgentAuthorityPublicEvent,
  type RelayAgentAuthorityReduction,
  type RelayAgentTrustedAdapterBinding,
} from "./authority.js";
import {
  RelayAgentAuthorityStore,
  type RelayAgentAuthorityTarget,
  type RelayAgentReplayEvent,
  type RelayAgentTimelineReset,
} from "./store.js";

export interface RelayAgentExtensionRouteContext {
  capabilityNegotiated: boolean;
  principalId: string;
  clientInstanceId: string;
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
}

export type RelayAgentDeliveryProvenance = "CONTROL" | "SNAPSHOT" | "LIVE" | "REPLAY";

export interface RelayAgentRuntimeDelivery {
  provenance: RelayAgentDeliveryProvenance;
  frame: RelayV2JsonObject;
  bytes: Uint8Array;
  replayEvents: readonly {
    provenance: "REPLAY";
    event: RelayAgentReplayEvent;
  }[];
}

export interface RelayAgentTrustedIngestResult {
  reduction: RelayAgentAuthorityReduction;
  delivery: RelayAgentRuntimeDelivery | null;
}

export interface RelayAgentTranscriptLifecycleRuntimePublicationPort {
  publishLive(delivery: RelayAgentRuntimeDelivery): Promise<void>;
  withdraw(error: unknown): void;
}

export type RelayAgentTrustedSourceIngressLeaseErrorCode =
  | "DISABLED"
  | "ALREADY_ENABLED"
  | "BUSY"
  | "SEALED"
  | "CLOSED";

export class RelayAgentTrustedSourceIngressLeaseError extends Error {
  constructor(readonly code: RelayAgentTrustedSourceIngressLeaseErrorCode) {
    super({
      DISABLED: "Relay Agent trusted-source ingress is disabled",
      ALREADY_ENABLED: "Relay Agent trusted-source ingress is already enabled",
      BUSY: "Relay Agent trusted-source ingress already has a durable ingest in progress",
      SEALED: "Relay Agent trusted-source ingress was sealed by a failed durable ingest",
      CLOSED: "Relay Agent trusted-source ingress is closed",
    }[code]);
    this.name = "RelayAgentTrustedSourceIngressLeaseError";
  }
}

export class RelayAgentExtensionNotNegotiatedError extends Error {
  readonly code = "AGENT_EXTENSION_NOT_NEGOTIATED" as const;
  constructor() {
    super("Relay Agent transcript/lifecycle extension was not negotiated");
    this.name = "RelayAgentExtensionNotNegotiatedError";
  }
}

export class RelayAgentExtensionRouteBindingError extends Error {
  readonly code = "AGENT_EXTENSION_ROUTE_BINDING_MISMATCH" as const;
  constructor() {
    super("Relay Agent extension request does not match the authorized route");
    this.name = "RelayAgentExtensionRouteBindingError";
  }
}

function jsonFrame(value: unknown): RelayV2JsonObject {
  return value as RelayV2JsonObject;
}

function targetFromContext(context: RelayAgentExtensionRouteContext): RelayAgentAuthorityTarget {
  return { scopeId: context.scopeId, sessionId: context.sessionId };
}

function publicEventFrame(event: RelayAgentAuthorityPublicEvent): RelayV2JsonObject {
  return jsonFrame({
    protocolVersion: 2,
    kind: "event",
    type: "agent.timeline.event",
    hostId: event.hostId,
    hostEpoch: event.hostEpoch,
    scopeId: event.scopeId,
    sessionId: event.sessionId,
    payload: {
      capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      timelineEpoch: event.timelineEpoch,
      agentEventSeq: event.agentEventSeq,
      eventId: event.eventId,
      occurredAtMs: event.occurredAtMs,
      mutation: event.mutation,
    },
  });
}

function resetFrame(reset: RelayAgentTimelineReset): RelayV2JsonObject {
  return jsonFrame({
    protocolVersion: 2,
    kind: "event",
    type: "agent.timeline.reset",
    hostId: reset.hostId,
    hostEpoch: reset.hostEpoch,
    scopeId: reset.scopeId,
    sessionId: reset.sessionId,
    payload: {
      capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      previousTimelineEpoch: reset.previousTimelineEpoch,
      newTimelineEpoch: reset.newTimelineEpoch,
      reason: reset.reason,
    },
  });
}

function delivery(
  provenance: RelayAgentDeliveryProvenance,
  frame: RelayV2JsonObject,
  replayEvents: RelayAgentRuntimeDelivery["replayEvents"] = [],
): RelayAgentRuntimeDelivery {
  return Object.freeze({
    provenance,
    frame,
    bytes: encodeRelayAgentTranscriptLifecycleFrame(frame),
    replayEvents: Object.freeze([...replayEvents]),
  });
}

type ExtensionWireErrorCode =
  | "AGENT_TIMELINE_UNAVAILABLE"
  | "AGENT_CURSOR_EXPIRED"
  | "AGENT_CURSOR_AHEAD"
  | "AGENT_SNAPSHOT_EXPIRED"
  | "AGENT_TIMELINE_EPOCH_MISMATCH"
  | "HOST_EPOCH_MISMATCH";

function errorFrame(
  request: RelayV2JsonObject,
  hostEpoch: string,
  code: ExtensionWireErrorCode,
  retryable: boolean,
  details?: { expectedHostEpoch: string; actualHostEpoch: string },
): RelayV2JsonObject {
  return jsonFrame({
    protocolVersion: 2,
    kind: "response",
    type: "error",
    requestId: request.requestId,
    hostId: request.hostId,
    hostEpoch,
    scopeId: request.scopeId,
    sessionId: request.sessionId,
    payload: null,
    error: {
      code,
      message: code === "HOST_EPOCH_MISMATCH"
        ? "The requested host epoch is no longer current"
        : "The Relay Agent timeline request cannot be satisfied",
      retryable,
      commandDisposition: "not_applicable",
      ...(details ? { details } : {}),
    },
  });
}

function storeFailureCode(error: unknown): {
  code: Exclude<ExtensionWireErrorCode, "HOST_EPOCH_MISMATCH">;
  retryable: boolean;
} | null {
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (code === "AGENT_TIMELINE_UNAVAILABLE"
    || code === "AGENT_CURSOR_EXPIRED"
    || code === "AGENT_CURSOR_AHEAD"
    || code === "AGENT_SNAPSHOT_EXPIRED"
    || code === "AGENT_TIMELINE_EPOCH_MISMATCH") {
    return {
      code,
      retryable: code === "AGENT_TIMELINE_UNAVAILABLE",
    };
  }
  if (code === "AGENT_AUTHORITY_STORE_CAPACITY_EXCEEDED"
    || code === "AGENT_AUTHORITY_STORE_COMMIT_UNCERTAIN"
    || code === "AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE"
    || code === "AGENT_AUTHORITY_STORE_CORRUPT"
    || code === "AGENT_AUTHORITY_STORE_OWNERSHIP_UNKNOWN") {
    return { code: "AGENT_TIMELINE_UNAVAILABLE", retryable: false };
  }
  return null;
}

function isUnavailableStoreFailure(error: unknown): boolean {
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return code === "AGENT_AUTHORITY_STORE_CORRUPT"
    || code === "AGENT_AUTHORITY_STORE_OWNERSHIP_UNKNOWN"
    || code === "AGENT_AUTHORITY_STORE_COMMIT_UNCERTAIN"
    || code === "AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE"
    || code === "AGENT_AUTHORITY_STORE_CAPACITY_EXCEEDED";
}

/**
 * Standalone, capability-gated composition foundation. It deliberately has no
 * HostRuntime import, capability advertisement, broker state, or production
 * relay-host registration.
 */
export class RelayAgentTranscriptLifecycleRuntime {
  constructor(
    readonly store: RelayAgentAuthorityStore,
    private readonly publication: RelayAgentTranscriptLifecycleRuntimePublicationPort | null = null,
  ) {
    if (publication !== null
      && (typeof publication !== "object"
        || typeof publication.publishLive !== "function"
        || typeof publication.withdraw !== "function")) {
      throw new TypeError("Relay Agent runtime publication port is invalid");
    }
  }

  private assertRoute(request: RelayV2JsonObject, context: RelayAgentExtensionRouteContext): void {
    if (!context.capabilityNegotiated) throw new RelayAgentExtensionNotNegotiatedError();
    if (context.hostId !== this.store.owner.hostId
      || context.hostEpoch !== this.store.owner.hostEpoch
      || request.hostId !== context.hostId
      || request.scopeId !== context.scopeId
      || request.sessionId !== context.sessionId) {
      throw new RelayAgentExtensionRouteBindingError();
    }
  }

  async handleRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayAgentExtensionRouteContext,
  ): Promise<RelayAgentRuntimeDelivery> {
    if (!context.capabilityNegotiated) throw new RelayAgentExtensionNotNegotiatedError();
    const decoded = decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata);
    const request = decoded.frame;
    if (decoded.normalized.kind !== "request") throw new RelayAgentExtensionRouteBindingError();
    this.assertRoute(request, context);
    if (request.expectedHostEpoch !== context.hostEpoch) {
      return delivery("CONTROL", errorFrame(
        request,
        context.hostEpoch,
        "HOST_EPOCH_MISMATCH",
        false,
        {
          expectedHostEpoch: request.expectedHostEpoch as string,
          actualHostEpoch: context.hostEpoch,
        },
      ));
    }

    const target = targetFromContext(context);
    try {
      switch (request.type) {
        case "agent.timeline.status.get": {
          let status;
          try {
            status = await this.store.status(target);
          } catch (error) {
            if (!isUnavailableStoreFailure(error)) throw error;
            this.withdrawPublication(error);
            status = {
              support: "unavailable" as const,
              reason: "store_unavailable" as const,
              liveSource: "absent" as const,
              activeSourceEpoch: null,
              timelineEpoch: null,
              currentAgentSeq: null,
              earliestReplaySeq: null,
              limits: null,
            };
          }
          return delivery("CONTROL", jsonFrame({
            protocolVersion: 2,
            kind: "response",
            type: "agent.timeline.status",
            requestId: request.requestId,
            hostId: context.hostId,
            hostEpoch: context.hostEpoch,
            scopeId: context.scopeId,
            sessionId: context.sessionId,
            payload: {
              capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
              ...status,
            },
          }));
        }
        case "agent.timeline.snapshot.get": {
          const payload = request.payload as RelayV2JsonObject;
          const page = await this.store.snapshot({
            principalId: context.principalId,
            clientInstanceId: context.clientInstanceId,
            target,
            snapshotRequestId: payload.snapshotRequestId as string,
            snapshotId: payload.snapshotId as string | null,
            cursor: payload.cursor as string | null,
            nextPageIndex: payload.nextPageIndex as number,
          });
          return delivery("SNAPSHOT", jsonFrame({
            protocolVersion: 2,
            kind: "response",
            type: "agent.timeline.snapshot.page",
            requestId: request.requestId,
            hostId: context.hostId,
            hostEpoch: context.hostEpoch,
            scopeId: context.scopeId,
            sessionId: context.sessionId,
            payload: {
              capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
              ...page,
            },
          }));
        }
        case "agent.timeline.replay.get": {
          const payload = request.payload as RelayV2JsonObject;
          const page = await this.store.replay({
            principalId: context.principalId,
            clientInstanceId: context.clientInstanceId,
            target,
            timelineEpoch: payload.timelineEpoch as string,
            afterAgentSeq: payload.afterAgentSeq as string,
            cursor: payload.cursor as string | null,
            limit: payload.limit as number,
          });
          const frame = jsonFrame({
            protocolVersion: 2,
            kind: "response",
            type: "agent.timeline.replay.page",
            requestId: request.requestId,
            hostId: context.hostId,
            hostEpoch: context.hostEpoch,
            scopeId: context.scopeId,
            sessionId: context.sessionId,
            payload: {
              capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
              ...page,
            },
          });
          return delivery("REPLAY", frame, page.events.map((event) => ({ provenance: "REPLAY", event })));
        }
        default:
          throw new RelayAgentExtensionRouteBindingError();
      }
    } catch (error) {
      const wireError = storeFailureCode(error);
      if (!wireError) throw error;
      if (isUnavailableStoreFailure(error)) this.withdrawPublication(error);
      return delivery("CONTROL", errorFrame(
        request,
        context.hostEpoch,
        wireError.code,
        wireError.retryable,
      ));
    }
  }

  handleUnavailableRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayAgentExtensionRouteContext,
  ): RelayAgentRuntimeDelivery {
    const decoded = decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata);
    const request = decoded.frame;
    if (decoded.normalized.kind !== "request") throw new RelayAgentExtensionRouteBindingError();
    this.assertRoute(request, context);
    if (request.expectedHostEpoch !== context.hostEpoch) {
      return delivery("CONTROL", errorFrame(
        request,
        context.hostEpoch,
        "HOST_EPOCH_MISMATCH",
        false,
        {
          expectedHostEpoch: request.expectedHostEpoch as string,
          actualHostEpoch: context.hostEpoch,
        },
      ));
    }
    if (request.type === "agent.timeline.status.get") {
      return delivery("CONTROL", jsonFrame({
        protocolVersion: 2,
        kind: "response",
        type: "agent.timeline.status",
        requestId: request.requestId,
        hostId: context.hostId,
        hostEpoch: context.hostEpoch,
        scopeId: context.scopeId,
        sessionId: context.sessionId,
        payload: {
          capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
          support: "unavailable",
          reason: "store_unavailable",
          liveSource: "absent",
          activeSourceEpoch: null,
          timelineEpoch: null,
          currentAgentSeq: null,
          earliestReplaySeq: null,
          limits: null,
        },
      }));
    }
    return delivery("CONTROL", errorFrame(
      request,
      context.hostEpoch,
      "AGENT_TIMELINE_UNAVAILABLE",
      false,
    ));
  }

  async ingestTrustedSource(
    binding: RelayAgentTrustedAdapterBinding,
    sourceInput: unknown,
  ): Promise<RelayAgentTrustedIngestResult> {
    let reduction: RelayAgentAuthorityReduction;
    try {
      reduction = await this.store.ingest(binding, sourceInput);
    } catch (error) {
      if (isUnavailableStoreFailure(error)) this.withdrawPublication(error);
      throw error;
    }
    const result: RelayAgentTrustedIngestResult = {
      reduction,
      delivery: reduction.publicEvent === null
        ? null
        : delivery("LIVE", publicEventFrame(reduction.publicEvent)),
    };
    if (result.delivery !== null && this.publication !== null) {
      // Durable commit is the source ACK boundary. Network fanout is bounded
      // best effort and cannot turn a slow/stale route into a producer failure.
      void this.publication.publishLive(result.delivery).catch(() => undefined);
    }
    return result;
  }

  async deleteTimeline(target: RelayAgentAuthorityTarget): Promise<RelayAgentRuntimeDelivery> {
    try {
      const deleted = delivery("LIVE", resetFrame(await this.store.deleteTimeline(target)));
      if (this.publication !== null) {
        void this.publication.publishLive(deleted).catch(() => undefined);
      }
      return deleted;
    } catch (error) {
      if (isUnavailableStoreFailure(error)) this.withdrawPublication(error);
      throw error;
    }
  }

  private withdrawPublication(error: unknown): void {
    try { this.publication?.withdraw(error); } catch {}
  }
}

type RelayAgentTrustedSourceIngressState =
  | "disabled"
  | "enabling"
  | "enabled"
  | "sealed"
  | "closed";

/**
 * Process-local admission owner for one authenticated trusted-source adapter.
 * It is deliberately default-off and owns neither parsing nor durable state.
 */
export class RelayAgentTrustedSourceIngressLease {
  readonly #runtime: RelayAgentTranscriptLifecycleRuntime;
  #state: RelayAgentTrustedSourceIngressState = "disabled";
  #binding: Readonly<RelayAgentTrustedAdapterBinding> | null = null;
  #enablingAttempt: object | null = null;
  #operationPending = false;
  #inFlightBarrier: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(runtime: RelayAgentTranscriptLifecycleRuntime) {
    this.#runtime = runtime;
  }

  enable(binding: RelayAgentTrustedAdapterBinding): void {
    if (this.#state === "closed") {
      throw new RelayAgentTrustedSourceIngressLeaseError("CLOSED");
    }
    if (this.#state === "sealed") {
      throw new RelayAgentTrustedSourceIngressLeaseError("SEALED");
    }
    if (this.#state === "enabled") {
      throw new RelayAgentTrustedSourceIngressLeaseError("ALREADY_ENABLED");
    }
    if (this.#state === "enabling") {
      this.#state = "sealed";
      this.#enablingAttempt = null;
      this.#binding = null;
      throw new RelayAgentTrustedSourceIngressLeaseError("SEALED");
    }

    const attempt = Object.freeze({});
    this.#state = "enabling";
    this.#enablingAttempt = attempt;
    let normalized: Readonly<RelayAgentTrustedAdapterBinding>;
    try {
      normalized = normalizeRelayAgentTrustedAdapterBinding(binding);
    } catch (error) {
      if (this.#state === "enabling" && this.#enablingAttempt === attempt) {
        this.#state = "sealed";
        this.#enablingAttempt = null;
      }
      throw error;
    }
    if (this.#state !== "enabling" || this.#enablingAttempt !== attempt) {
      throw new RelayAgentTrustedSourceIngressLeaseError(
        this.#state === "closed" ? "CLOSED" : "SEALED",
      );
    }
    this.#binding = normalized;
    this.#enablingAttempt = null;
    this.#state = "enabled";
  }

  ingestTrustedSource(sourceInput: unknown): Promise<RelayAgentTrustedIngestResult> {
    if (this.#state === "disabled") {
      return Promise.reject(new RelayAgentTrustedSourceIngressLeaseError("DISABLED"));
    }
    if (this.#state === "closed") {
      return Promise.reject(new RelayAgentTrustedSourceIngressLeaseError("CLOSED"));
    }
    if (this.#state === "sealed") {
      return Promise.reject(new RelayAgentTrustedSourceIngressLeaseError("SEALED"));
    }
    if (this.#state === "enabling") {
      this.#state = "sealed";
      this.#enablingAttempt = null;
      return Promise.reject(new RelayAgentTrustedSourceIngressLeaseError("SEALED"));
    }
    if (this.#operationPending) {
      return Promise.reject(new RelayAgentTrustedSourceIngressLeaseError("BUSY"));
    }

    const binding = this.#binding!;
    let settleBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      settleBarrier = resolve;
    });
    this.#operationPending = true;
    this.#inFlightBarrier = barrier;

    const settle = (failed: boolean): void => {
      if (!this.#operationPending) return;
      this.#operationPending = false;
      this.#inFlightBarrier = null;
      if (failed && this.#state !== "closed") this.#state = "sealed";
      settleBarrier();
    };

    let operation: Promise<RelayAgentTrustedIngestResult>;
    try {
      operation = Promise.resolve(this.#runtime.ingestTrustedSource(binding, sourceInput));
    } catch (error) {
      settle(true);
      return Promise.reject(error);
    }
    void operation.then(
      () => settle(false),
      () => settle(true),
    );
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#state = "closed";
    this.#enablingAttempt = null;
    this.#binding = null;
    this.#closePromise = this.#inFlightBarrier ?? Promise.resolve();
    return this.#closePromise;
  }
}
