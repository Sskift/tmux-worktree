import type { RelayV2FrameMetadata } from "../../../v2/codec.js";
import type { RelayV2JsonObject } from "../../../v2/codecSchema.js";
import {
  decodeRelayAgentTranscriptLifecycleFrame,
  encodeRelayAgentTranscriptLifecycleFrame,
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
} from "./codec.js";
import type {
  RelayAgentAuthorityPublicEvent,
  RelayAgentAuthorityReduction,
  RelayAgentTrustedAdapterBinding,
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
    || code === "AGENT_AUTHORITY_STORE_CAPACITY_EXCEEDED";
}

/**
 * Standalone, capability-gated composition foundation. It deliberately has no
 * HostRuntime import, capability advertisement, broker state, or production
 * relay-host registration.
 */
export class RelayAgentTranscriptLifecycleRuntime {
  constructor(readonly store: RelayAgentAuthorityStore) {}

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

  handleRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayAgentExtensionRouteContext,
  ): RelayAgentRuntimeDelivery {
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
            status = this.store.status(target);
          } catch (error) {
            if (!isUnavailableStoreFailure(error)) throw error;
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
          const page = this.store.snapshot({
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
          const page = this.store.replay({
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
      return delivery("CONTROL", errorFrame(
        request,
        context.hostEpoch,
        wireError.code,
        wireError.retryable,
      ));
    }
  }

  ingestTrustedSource(
    binding: RelayAgentTrustedAdapterBinding,
    sourceInput: unknown,
  ): RelayAgentTrustedIngestResult {
    const reduction = this.store.ingest(binding, sourceInput);
    return {
      reduction,
      delivery: reduction.publicEvent === null
        ? null
        : delivery("LIVE", publicEventFrame(reduction.publicEvent)),
    };
  }

  deleteTimeline(target: RelayAgentAuthorityTarget): RelayAgentRuntimeDelivery {
    return delivery("LIVE", resetFrame(this.store.deleteTimeline(target)));
  }
}
