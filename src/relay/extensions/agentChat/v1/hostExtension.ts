import type {
  AgentChatEngine,
  AgentChatTurnView,
} from "../../../agentChat.js";
import type {
  RelayV2FrameMetadata,
} from "../../../v2/codec.js";
import type {
  RelayV2HostOptionalExtensionAttachment,
  RelayV2HostOptionalExtensionDelivery,
  RelayV2HostOptionalExtensionIngressSink,
  RelayV2HostOptionalExtensionRequestDescriptor,
  RelayV2HostOptionalExtensionRouteContext,
} from "../../../v2/hostRuntime.js";
import {
  RELAY_AGENT_CHAT_CAPABILITY,
  RelayAgentChatCodecError,
  decodeRelayAgentChatFrame,
  encodeRelayAgentChatFrame,
  encodeRelayAgentChatUnavailableError,
} from "./codec.js";

/**
 * The v2 wire turn requires every status-derived field to be present (nullable)
 * so the frozen schema can enforce status/reply/error/completedAt consistency.
 * The v1 engine view omits undefined fields, so the bridge normalizes before
 * encoding.
 */
/** Sessions are `scopeId:rawName`; the event frame must carry the same scope. */
function scopeIdForSession(session: string): string {
  const index = session.indexOf(":");
  if (index <= 0) return "local";
  return session.slice(0, index);
}

function normalizeTurnView(view: AgentChatTurnView): {
  turnId: string;
  session: string;
  userMessage: string;
  status: "working" | "replied" | "failed" | "recovery-required";
  reply: string | null;
  error: string | null;
  sentAt: string;
  completedAt: string | null;
  steeredMessages: { message: string; sentAt: string }[] | null;
} {
  return {
    turnId: view.turnId,
    session: view.session,
    userMessage: view.userMessage,
    status: view.status,
    reply: view.reply ?? null,
    error: view.error ?? null,
    sentAt: view.sentAt,
    completedAt: view.completedAt ?? null,
    steeredMessages: view.steeredMessages ?? null,
  };
}

export interface RelayAgentChatHostExtensionOptions {
  /**
   * The existing AgentChatEngine is reused as-is; this attachment only adapts
   * the v2 wire frames to its startOrSteerTurn/listTurns surface.
   */
  readonly engine: AgentChatEngine;
  readonly hostId: string;
  /** Fresh identity source; the extension reads it when it builds a response. */
  readonly hostEpoch: () => string;
}

/**
 * Default-off agent.chat.v1 host attachment. It owns no terminal/lease state:
 * every request is delegated to the injected AgentChatEngine and every engine
 * event is published through the runtime ingress sink as an agent.chat.event.
 */
export function createRelayAgentChatHostExtension(
  options: RelayAgentChatHostExtensionOptions,
): RelayV2HostOptionalExtensionAttachment {
  let sink: RelayV2HostOptionalExtensionIngressSink | null = null;
  let ready = true;
  let closed = false;

  const publishEvent = async (
    session: string,
    turn: AgentChatTurnView,
  ): Promise<void> => {
    if (closed || !ready || sink === null) return;
    const frame = {
      protocolVersion: 2,
      kind: "event" as const,
      type: "agent.chat.event",
      hostId: options.hostId,
      hostEpoch: options.hostEpoch(),
      scopeId: scopeIdForSession(session),
      sessionId: session,
      payload: { session, turn: normalizeTurnView(turn) },
    };
    const bytes = encodeRelayAgentChatFrame(frame);
    await sink.publish({ frame, bytes });
  };

  return Object.freeze({
    capability: RELAY_AGENT_CHAT_CAPABILITY,
    subscribe(ingressSink) {
      sink = ingressSink;
      ingressSink.apply(ready && !closed);
      return Object.freeze({
        unsubscribe: (): void => {
          if (sink === ingressSink) sink = null;
        },
      });
    },
    inspectRequest(
      bytes: Uint8Array,
      metadata: RelayV2FrameMetadata,
    ): RelayV2HostOptionalExtensionRequestDescriptor {
      const decoded = decodeRelayAgentChatFrame(bytes, metadata);
      const type = decoded.normalized.type;
      if (type !== "agent.chat.send" && type !== "agent.chat.history") {
        throw new RelayAgentChatCodecError("INVALID_ENVELOPE", "not-a-chat-request");
      }
      const frame = decoded.frame;
      return Object.freeze({
        requestId: frame.requestId as string,
        hostId: frame.hostId as string,
        expectedHostEpoch: frame.expectedHostEpoch as string,
        scopeId: frame.scopeId as string,
        sessionId: frame.sessionId as string,
      });
    },
    async authorize(_context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean> {
      return ready && !closed;
    },
    async handleRequest(
      bytes: Uint8Array,
      metadata: RelayV2FrameMetadata,
      context: RelayV2HostOptionalExtensionRouteContext,
    ): Promise<RelayV2HostOptionalExtensionDelivery> {
      const decoded = decodeRelayAgentChatFrame(bytes, metadata);
      const frame = decoded.frame;
      const session = frame.payload.session as string;
      const hostEpoch = options.hostEpoch();
      if (frame.type === "agent.chat.send") {
        const { turnId } = await options.engine.startOrSteerTurn(
          session,
          frame.payload.message as string,
          {
            onEvent: (turn) => {
              void publishEvent(session, turn);
            },
          },
        );
        const response = {
          protocolVersion: 2,
          kind: "response" as const,
          type: "agent.chat.sent",
          requestId: frame.requestId as string,
          hostId: options.hostId,
          hostEpoch,
          scopeId: frame.scopeId as string,
          sessionId: frame.sessionId as string,
          payload: { session, turnId },
        };
        return { frame: response, bytes: encodeRelayAgentChatFrame(response) };
      }
      const turns = options.engine.listTurns(
        session,
        frame.payload.limit as number | undefined,
      ).map(normalizeTurnView);
      const response = {
        protocolVersion: 2,
        kind: "response" as const,
        type: "agent.chat.history.result",
        requestId: frame.requestId as string,
        hostId: options.hostId,
        hostEpoch,
        scopeId: frame.scopeId as string,
        sessionId: frame.sessionId as string,
        payload: { session, turns },
      };
      return { frame: response, bytes: encodeRelayAgentChatFrame(response) };
    },
    handleUnavailableRequest(
      bytes: Uint8Array,
      metadata: RelayV2FrameMetadata,
      _context: RelayV2HostOptionalExtensionRouteContext,
    ): RelayV2HostOptionalExtensionDelivery {
      const decoded = decodeRelayAgentChatFrame(bytes, metadata);
      const frame = decoded.frame;
      const bytesOut = encodeRelayAgentChatUnavailableError({
        requestId: frame.requestId as string,
        hostId: options.hostId,
        hostEpoch: options.hostEpoch(),
        scopeId: frame.scopeId as string,
        sessionId: frame.sessionId as string,
        code: "AGENT_CHAT_UNAVAILABLE",
        message: "Relay Agent chat is unavailable",
        retryable: true,
      });
      return {
        frame: decodeRelayAgentChatFrame(bytesOut).frame,
        bytes: bytesOut,
      };
    },
    isolateFailure(_error: unknown): void {
      ready = false;
    },
    async closeAndDrain(): Promise<void> {
      closed = true;
      ready = false;
      sink = null;
    },
  });
}
