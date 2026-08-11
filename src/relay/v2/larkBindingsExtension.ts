import { FeishuBridgeClient } from "../../feishuBridgeServer.js";
import type { FeishuBinding } from "../../feishuBridgeStorage.js";
import {
  decodeRelayLarkBindingsFrame,
  encodeRelayLarkBindingsError,
  encodeRelayLarkBindingsFrame,
  RELAY_LARK_BINDINGS_CAPABILITY,
  RELAY_LARK_BINDINGS_MAX_BINDINGS,
  type RelayLarkBindingProjection,
  type RelayLarkBindingReplyMode,
} from "../extensions/larkBindings/v2/codec.js";
import type { RelayV2FrameMetadata } from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import type {
  RelayV2HostOptionalExtensionAttachment,
  RelayV2HostOptionalExtensionDelivery,
  RelayV2HostOptionalExtensionIngressSink,
  RelayV2HostOptionalExtensionRouteContext,
} from "./hostRuntime.js";

type LarkBridgeOperation = "bridge.snapshot" | "binding.update" | "binding.remove";

export interface RelayV2LarkBindingsBridgePort {
  request<T = unknown>(
    operation: LarkBridgeOperation,
    params: Record<string, unknown>,
  ): Promise<T>;
}

export interface RelayV2LarkBindingsAuthorizationPort {
  authorize(context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean>;
}

export interface RelayV2LarkBindingsAttachmentOptions {
  readonly authorization: RelayV2LarkBindingsAuthorizationPort;
  readonly bridge?: RelayV2LarkBindingsBridgePort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxBytes: number): string | null {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function projectBinding(value: unknown): RelayLarkBindingProjection | null {
  if (!isRecord(value) || !isRecord(value.options)) return null;
  const id = boundedText(value.id, 128);
  const chatName = boundedText(value.chatName, 1_024);
  const sessionName = boundedText(value.sessionName, 1_024);
  const statuses = new Set(["active", "pausing", "paused", "stale"]);
  const modes = new Set(["topic", "direct"]);
  if (id === null || chatName === null || sessionName === null
    || !statuses.has(String(value.status))
    || !modes.has(String(value.options.replyMode))) return null;
  return Object.freeze({
    id,
    chatName,
    sessionName,
    status: value.status as RelayLarkBindingProjection["status"],
    replyMode: value.options.replyMode as RelayLarkBindingReplyMode,
  });
}

function projectBindingsSnapshot(value: unknown): readonly RelayLarkBindingProjection[] | null {
  if (!isRecord(value) || !Array.isArray(value.bindings)
    || value.bindings.length > RELAY_LARK_BINDINGS_MAX_BINDINGS) return null;
  const projected: RelayLarkBindingProjection[] = [];
  const ids = new Set<string>();
  for (const raw of value.bindings) {
    const binding = projectBinding(raw);
    if (binding === null || ids.has(binding.id)) return null;
    ids.add(binding.id);
    projected.push(binding);
  }
  return Object.freeze(projected);
}

function descriptor(frame: RelayV2JsonObject) {
  return Object.freeze({
    requestId: frame.requestId as string,
    hostId: frame.hostId as string,
    expectedHostEpoch: frame.expectedHostEpoch as string,
    scopeId: frame.scopeId as string,
    sessionId: frame.sessionId as string,
  });
}

function delivery(frame: RelayV2JsonObject): RelayV2HostOptionalExtensionDelivery {
  return Object.freeze({ frame, bytes: encodeRelayLarkBindingsFrame(frame) });
}

function errorDelivery(
  request: RelayV2JsonObject,
  context: RelayV2HostOptionalExtensionRouteContext,
  code: "LARK_BINDINGS_UNAVAILABLE" | "LARK_BINDING_INVALID",
): RelayV2HostOptionalExtensionDelivery {
  const bytes = encodeRelayLarkBindingsError({
    requestId: request.requestId as string,
    hostId: context.hostId,
    hostEpoch: context.hostEpoch,
    scopeId: context.scopeId,
    sessionId: context.sessionId,
    code,
    message: code === "LARK_BINDING_INVALID"
      ? "The Lark binding is invalid or no longer exists"
      : "Lark bindings are unavailable on the selected Host",
    retryable: code === "LARK_BINDINGS_UNAVAILABLE",
  });
  return Object.freeze({ frame: decodeRelayLarkBindingsFrame(bytes).frame, bytes });
}

function bridgeFailureCode(error: unknown):
  "LARK_BINDINGS_UNAVAILABLE" | "LARK_BINDING_INVALID" {
  const message = error instanceof Error ? error.message : "";
  return /binding not found|invalid Feishu reply mode|invalid bindingId/i.test(message)
    ? "LARK_BINDING_INVALID"
    : "LARK_BINDINGS_UNAVAILABLE";
}

class RelayV2LarkBindingsAttachment implements RelayV2HostOptionalExtensionAttachment {
  readonly capability = RELAY_LARK_BINDINGS_CAPABILITY;

  private accepting = true;
  private sink: RelayV2HostOptionalExtensionIngressSink | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly authorization: RelayV2LarkBindingsAuthorizationPort,
    private readonly bridge: RelayV2LarkBindingsBridgePort,
  ) {}

  subscribe(sink: RelayV2HostOptionalExtensionIngressSink) {
    if (this.sink !== null) throw new Error("Relay Lark bindings attachment is already subscribed");
    this.sink = sink;
    sink.apply(this.accepting);
    let active = true;
    return Object.freeze({
      unsubscribe: (): void => {
        if (!active) return;
        active = false;
        if (this.sink === sink) this.sink = null;
      },
    });
  }

  inspectRequest(bytes: Uint8Array, metadata: RelayV2FrameMetadata) {
    const decoded = decodeRelayLarkBindingsFrame(bytes, metadata);
    if (decoded.normalized.kind !== "request") {
      throw new Error("Relay Lark bindings extension received a non-request");
    }
    return descriptor(decoded.frame);
  }

  authorize(context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean> {
    return this.authorization.authorize(context);
  }

  handleRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<RelayV2HostOptionalExtensionDelivery> {
    const request = decodeRelayLarkBindingsFrame(bytes, metadata).frame;
    if (!this.accepting) return Promise.resolve(
      errorDelivery(request, context, "LARK_BINDINGS_UNAVAILABLE"),
    );
    const operation = this.dispatch(request, context).catch((error) => (
      errorDelivery(request, context, bridgeFailureCode(error))
    ));
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
    return operation;
  }

  handleUnavailableRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): RelayV2HostOptionalExtensionDelivery {
    const request = decodeRelayLarkBindingsFrame(bytes, metadata).frame;
    return errorDelivery(request, context, "LARK_BINDINGS_UNAVAILABLE");
  }

  isolateFailure(): void {
    this.accepting = false;
  }

  async closeAndDrain(): Promise<void> {
    this.accepting = false;
    this.sink?.close();
    this.sink = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private async dispatch(
    request: RelayV2JsonObject,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<RelayV2HostOptionalExtensionDelivery> {
    const common = {
      protocolVersion: 2,
      kind: "response",
      requestId: request.requestId,
      hostId: context.hostId,
      hostEpoch: context.hostEpoch,
      scopeId: context.scopeId,
      sessionId: context.sessionId,
    } as const;
    if (request.type === "lark.bindings.get") {
      const snapshot = await this.bridge.request("bridge.snapshot", {});
      const bindings = projectBindingsSnapshot(snapshot);
      if (bindings === null) throw new Error("Lark bridge returned an invalid snapshot");
      return delivery({
        ...common,
        type: "lark.bindings.result",
        payload: { bindings: [...bindings] },
      });
    }
    const payload = request.payload as RelayV2JsonObject;
    const bindingId = payload.bindingId as string;
    if (request.type === "lark.binding.reply_mode.update") {
      const updated = await this.bridge.request<FeishuBinding>("binding.update", {
        bindingId,
        replyMode: payload.replyMode,
      });
      const binding = projectBinding(updated);
      if (binding === null || binding.id !== bindingId) {
        throw new Error("Lark bridge returned an invalid binding");
      }
      return delivery({
        ...common,
        type: "lark.binding.updated",
        payload: { binding },
      });
    }
    await this.bridge.request("binding.remove", {
      bindingId,
      force: true,
      origin: "unknown-local-client",
    });
    return delivery({
      ...common,
      type: "lark.binding.unlinked",
      payload: { bindingId },
    });
  }
}

export function createRelayV2LarkBindingsAttachment(
  options: RelayV2LarkBindingsAttachmentOptions,
): RelayV2HostOptionalExtensionAttachment {
  return new RelayV2LarkBindingsAttachment(
    options.authorization,
    options.bridge ?? new FeishuBridgeClient(),
  );
}
