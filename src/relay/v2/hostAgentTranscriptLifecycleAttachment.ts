import type { RelayV2FrameMetadata } from "./codec.js";
import type { RelayV2CanonicalResourceResolverPort } from "./resourceState.js";
import type { CodexAppServerProcessControllerPort } from
  "../extensions/agentTranscriptLifecycle/v1/codexAppServerProcessControllerAuthority.js";
import { CodexAppServerTrustedSourceActivation } from
  "../extensions/agentTranscriptLifecycle/v1/codexAppServerTrustedSourceActivation.js";
import {
  decodeRelayAgentTranscriptLifecycleFrame,
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
} from "../extensions/agentTranscriptLifecycle/v1/codec.js";
import {
  RelayAgentTranscriptLifecycleRuntime,
  type RelayAgentRuntimeDelivery,
  type RelayAgentTranscriptLifecycleRuntimePublicationPort,
} from "../extensions/agentTranscriptLifecycle/v1/runtime.js";
import type { RelayAgentAuthorityStore } from
  "../extensions/agentTranscriptLifecycle/v1/store.js";
import type {
  RelayV2HostOptionalExtensionAttachment,
  RelayV2HostOptionalExtensionDelivery,
  RelayV2HostOptionalExtensionIngressSink,
  RelayV2HostOptionalExtensionIngressSubscription,
  RelayV2HostOptionalExtensionRequestDescriptor,
  RelayV2HostOptionalExtensionRouteContext,
} from "./hostRuntime.js";

export interface RelayV2HostAgentTranscriptLifecycleAttachmentOptions {
  readonly store: RelayAgentAuthorityStore;
  readonly controller: CodexAppServerProcessControllerPort;
  readonly canonicalResourceResolver: RelayV2CanonicalResourceResolverPort;
}

/**
 * Canonical default-off owner for the existing durable extension runtime and
 * trusted-source activation. It adds no reducer, store, process controller,
 * continuity backend, H2 resolver, route, or fallback of its own.
 */
class RelayV2HostAgentTranscriptLifecycleAttachment
implements RelayV2HostOptionalExtensionAttachment,
RelayAgentTranscriptLifecycleRuntimePublicationPort {
  readonly capability = RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY;

  readonly #runtime: RelayAgentTranscriptLifecycleRuntime;
  readonly #activation: CodexAppServerTrustedSourceActivation;
  readonly #captureToken: RelayV2CanonicalResourceResolverPort["captureToken"];
  readonly #resolveSession: RelayV2CanonicalResourceResolverPort["resolveSession"];
  #sink: RelayV2HostOptionalExtensionIngressSink | null = null;
  #subscriptionIssued = false;
  #ready = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: RelayV2HostAgentTranscriptLifecycleAttachmentOptions) {
    this.#runtime = new RelayAgentTranscriptLifecycleRuntime(options.store, this);
    this.#activation = new CodexAppServerTrustedSourceActivation({
      controller: options.controller,
      runtime: this.#runtime,
      canonicalResourceResolver: options.canonicalResourceResolver,
      onUnavailable: (error: unknown) => this.withdraw(error),
    });
    this.#captureToken = options.canonicalResourceResolver.captureToken.bind(
      options.canonicalResourceResolver,
    );
    this.#resolveSession = options.canonicalResourceResolver.resolveSession.bind(
      options.canonicalResourceResolver,
    );
  }

  async activate(): Promise<void> {
    await this.#activation.activate();
    if (this.#closePromise !== null) throw new Error("Relay Agent attachment crossed close");
    this.#ready = true;
    this.#sink?.apply(true);
  }

  subscribe(
    sink: RelayV2HostOptionalExtensionIngressSink,
  ): RelayV2HostOptionalExtensionIngressSubscription {
    if (this.#subscriptionIssued
      || this.#closePromise !== null
      || !sink
      || typeof sink.apply !== "function"
      || typeof sink.publish !== "function"
      || typeof sink.close !== "function") {
      throw new Error("Relay Agent Host attachment ingress is unavailable");
    }
    this.#subscriptionIssued = true;
    this.#sink = sink;
    if (sink.apply(this.#ready) !== true) {
      this.#sink = null;
      throw new Error("Relay Agent Host attachment readiness was rejected");
    }
    let active = true;
    return Object.freeze({
      unsubscribe: (): void => {
        if (!active) return;
        active = false;
        if (this.#sink === sink) this.#sink = null;
      },
    });
  }

  inspectRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
  ): RelayV2HostOptionalExtensionRequestDescriptor {
    const decoded = decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata);
    if (decoded.normalized.kind !== "request") {
      throw new Error("Relay Agent Host attachment expected a request");
    }
    const frame = decoded.frame;
    return Object.freeze({
      requestId: frame.requestId as string,
      hostId: frame.hostId as string,
      expectedHostEpoch: frame.expectedHostEpoch as string,
      scopeId: frame.scopeId as string,
      sessionId: frame.sessionId as string,
    });
  }

  async handleRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<RelayV2HostOptionalExtensionDelivery> {
    const route = {
      capabilityNegotiated: true,
      ...context,
    };
    const delivery = this.#ready
      ? await this.#runtime.handleRequest(bytes, metadata, route)
      : this.#runtime.handleUnavailableRequest(bytes, metadata, route);
    return Object.freeze({ frame: delivery.frame, bytes: delivery.bytes });
  }

  handleUnavailableRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): RelayV2HostOptionalExtensionDelivery {
    const delivery = this.#runtime.handleUnavailableRequest(bytes, metadata, {
      capabilityNegotiated: true,
      ...context,
    });
    return Object.freeze({ frame: delivery.frame, bytes: delivery.bytes });
  }

  async authorize(context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean> {
    try {
      if (context.hostId !== this.#runtime.store.owner.hostId
        || context.hostEpoch !== this.#runtime.store.owner.hostEpoch) return false;
      const token = await this.#captureToken(context.hostEpoch);
      const target = await this.#resolveSession(token, context.scopeId, context.sessionId);
      return target.authorization === "evidence_only"
        && target.hostEpoch === context.hostEpoch
        && target.scopeId === context.scopeId
        && target.sessionId === context.sessionId;
    } catch (error) {
      this.withdraw(error);
      return false;
    }
  }

  isolateFailure(error: unknown): void {
    this.withdraw(error);
  }

  async publishLive(delivery: RelayAgentRuntimeDelivery): Promise<void> {
    if (!this.#ready || this.#closePromise !== null) return;
    const sink = this.#sink;
    if (sink === null) return;
    try {
      await sink.publish(Object.freeze({
        frame: delivery.frame,
        bytes: delivery.bytes,
      }));
    } catch {
      this.withdraw(new Error("Relay Agent Host route publication failed"));
    }
  }

  withdraw(_error: unknown): void {
    if (!this.#ready && this.#closePromise !== null) return;
    this.#ready = false;
    try { this.#sink?.close(); } catch {}
    this.#beginClose();
  }

  closeAndDrain(): Promise<void> {
    this.#ready = false;
    try { this.#sink?.close(); } catch {}
    this.#beginClose();
    return this.#closePromise!;
  }

  #beginClose(): void {
    if (this.#closePromise !== null) return;
    try {
      this.#closePromise = this.#activation.close();
    } catch (error) {
      this.#closePromise = Promise.reject(error);
    }
    void this.#closePromise.catch(() => undefined);
  }
}

export async function openRelayV2HostAgentTranscriptLifecycleAttachment(
  options: RelayV2HostAgentTranscriptLifecycleAttachmentOptions,
): Promise<RelayV2HostOptionalExtensionAttachment> {
  const attachment = new RelayV2HostAgentTranscriptLifecycleAttachment(options);
  try {
    await attachment.activate();
    return attachment;
  } catch (error) {
    await attachment.closeAndDrain().catch(() => undefined);
    throw error;
  }
}
