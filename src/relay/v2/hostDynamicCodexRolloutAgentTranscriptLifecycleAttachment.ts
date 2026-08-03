import { createHash } from "node:crypto";

import {
  CODEX_APP_SERVER_V2_PROVIDER,
  CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0,
  CODEX_APP_SERVER_V2_SCHEMA_VERSION,
  CodexAppServerV2EventProducer,
} from "../extensions/agentTranscriptLifecycle/v1/codexAppServerProducer.js";
import {
  CODEX_ROLLOUT_FILE_PROVIDER_VERSION,
  CodexRolloutFileSourceAuthority,
  claimCodexRolloutOpenByteSource,
  createDarwinCodexRolloutTofuInspectionAdapter,
  type CodexRolloutFollowerByteSource,
  type CodexRolloutManagedSessionSelection,
  type CodexRolloutOpenFileInspectionPort,
  type CodexRolloutProcessInspectionPort,
  type CodexRolloutTmuxInspectionPort,
} from "../extensions/agentTranscriptLifecycle/v1/codexRolloutFileSourceAuthority.js";
import {
  CODEX_ROLLOUT_JSONL_SOURCE_BUDGETS,
  createCodexRolloutJsonlNotificationByteSource,
  type CodexRolloutFileProcessBinding,
  type CodexRolloutJsonlAppend,
  type CodexRolloutJsonlAppendChannel,
} from "../extensions/agentTranscriptLifecycle/v1/codexRolloutJsonlNotificationByteSource.js";
import {
  decodeRelayAgentTranscriptLifecycleFrame,
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
} from "../extensions/agentTranscriptLifecycle/v1/codec.js";
import {
  RelayAgentTranscriptLifecycleRuntime,
  RelayAgentTrustedSourceIngressLease,
  type RelayAgentRuntimeDelivery,
  type RelayAgentTranscriptLifecycleRuntimePublicationPort,
} from "../extensions/agentTranscriptLifecycle/v1/runtime.js";
import type { RelayAgentAuthorityStore } from
  "../extensions/agentTranscriptLifecycle/v1/store.js";
import type { RelayV2FrameMetadata } from "./codec.js";
import {
  resolveRelayV2CanonicalSessionWorkingDirectory,
  type RelayV2CanonicalResourceResolverPort,
  type RelayV2CanonicalResourceResolverToken,
} from "./resourceState.js";
import type {
  RelayV2HostOptionalExtensionAttachment,
  RelayV2HostOptionalExtensionDelivery,
  RelayV2HostOptionalExtensionIngressSink,
  RelayV2HostOptionalExtensionIngressSubscription,
  RelayV2HostOptionalExtensionRequestDescriptor,
  RelayV2HostOptionalExtensionRouteContext,
} from "./hostRuntime.js";

const MAX_ACTIVE_SESSIONS = 16;
const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;

type InspectionAdapter = CodexRolloutTmuxInspectionPort
  & CodexRolloutProcessInspectionPort
  & CodexRolloutOpenFileInspectionPort;

export interface RelayV2HostDynamicCodexRolloutAttachmentOptions {
  readonly store: RelayAgentAuthorityStore;
  readonly canonicalResourceResolver: RelayV2CanonicalResourceResolverPort;
  readonly accountHome: string;
  readonly accountUid: number;
  readonly tmuxExecutablePath: string;
  /** Focused-test seam; self-hosted shipping always selects the Darwin TOFU owner. */
  readonly inspectionAdapterFactory?: (
    selection: Readonly<CodexRolloutManagedSessionSelection>,
  ) => Promise<InspectionAdapter>;
  /** Focused-test seam for a resolver whose private canonical owner is unavailable. */
  readonly resolveWorkingDirectory?: (
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
    sessionId: string,
  ) => Promise<string | null>;
  readonly pollIntervalMs?: number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
}

interface SessionEntry {
  readonly key: string;
  readonly identity: string;
  readonly target: Readonly<{ scopeId: string; sessionId: string }>;
  state: "opening" | "active" | "failed" | "closing" | "closed";
  authority: CodexRolloutFileSourceAuthority | null;
  follower: CodexRolloutFollowerByteSource | null;
  channel: RolloutAppendChannel | null;
  producer: CodexAppServerV2EventProducer | null;
  pump: Promise<void> | null;
  closePromise: Promise<void> | null;
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function opaqueDigest(...values: readonly (string | number | bigint)[]): string {
  return createHash("sha256").update(values.map(String).join("\0"), "utf8").digest("hex");
}

class RolloutAppendChannel implements CodexRolloutJsonlAppendChannel {
  readonly #binding: CodexRolloutFileProcessBinding;
  readonly #follower: CodexRolloutFollowerByteSource;
  readonly #device: bigint;
  readonly #inode: bigint;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;
  readonly #pollIntervalMs: number;
  #position: bigint;
  #cancelled = false;
  #cancelWait: (() => void) | null = null;
  #cancelTimer: (() => void) | null = null;

  constructor(
    binding: CodexRolloutFileProcessBinding,
    follower: CodexRolloutFollowerByteSource,
    device: bigint,
    inode: bigint,
    startOffset: bigint,
    pollIntervalMs: number,
    schedule: (delayMs: number, callback: () => void) => () => void,
  ) {
    this.#binding = binding;
    this.#follower = follower;
    this.#device = device;
    this.#inode = inode;
    this.#position = startOffset;
    this.#pollIntervalMs = pollIntervalMs;
    this.#schedule = schedule;
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#cancelWait?.();
    this.#cancelWait = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CodexRolloutJsonlAppend> {
    while (!this.#cancelled) {
      const cut = await this.#follower.inspectDurableCut();
      if (cut.device !== this.#device || cut.inode !== this.#inode || cut.offset < this.#position) {
        throw new Error("Codex rollout durable cut changed identity");
      }
      if (cut.offset > this.#position) {
        const remaining = cut.offset - this.#position;
        const maximumBytes = Number(remaining > BigInt(
          CODEX_ROLLOUT_JSONL_SOURCE_BUDGETS.maxAppendBytes,
        ) ? BigInt(CODEX_ROLLOUT_JSONL_SOURCE_BUDGETS.maxAppendBytes) : remaining);
        if (this.#position > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("Codex rollout offset exceeded the bounded source range");
        }
        const offset = Number(this.#position);
        const bytes = await this.#follower.read(this.#position, maximumBytes);
        if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
          throw new Error("Codex rollout follower made no bounded progress");
        }
        this.#position += BigInt(bytes.byteLength);
        yield Object.freeze({ binding: this.#binding, offset, bytes: new Uint8Array(bytes) });
        continue;
      }
      await new Promise<void>((resolve) => {
        if (this.#cancelled) {
          resolve();
          return;
        }
        const finish = (): void => {
          this.#cancelTimer = null;
          this.#cancelWait = null;
          resolve();
        };
        this.#cancelWait = finish;
        this.#cancelTimer = this.#schedule(this.#pollIntervalMs, finish);
      });
    }
  }
}

class DynamicCodexRolloutAttachment
implements RelayV2HostOptionalExtensionAttachment,
RelayAgentTranscriptLifecycleRuntimePublicationPort {
  readonly capability = RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY;
  readonly #store: RelayAgentAuthorityStore;
  readonly #runtime: RelayAgentTranscriptLifecycleRuntime;
  readonly #resolver: RelayV2CanonicalResourceResolverPort;
  readonly #accountHome: string;
  readonly #accountUid: number;
  readonly #tmuxExecutablePath: string;
  readonly #inspectionAdapterFactory: (
    selection: Readonly<CodexRolloutManagedSessionSelection>,
  ) => Promise<InspectionAdapter>;
  readonly #resolveWorkingDirectory: NonNullable<
  RelayV2HostDynamicCodexRolloutAttachmentOptions["resolveWorkingDirectory"]
  >;
  readonly #pollIntervalMs: number;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;
  readonly #entries = new Map<string, SessionEntry>();
  #operationTail: Promise<void> = Promise.resolve();
  #sink: RelayV2HostOptionalExtensionIngressSink | null = null;
  #subscriptionIssued = false;
  #ready = false;
  #closing = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: RelayV2HostDynamicCodexRolloutAttachmentOptions) {
    this.#store = options.store;
    this.#runtime = new RelayAgentTranscriptLifecycleRuntime(options.store, this);
    this.#resolver = options.canonicalResourceResolver;
    this.#accountHome = options.accountHome;
    this.#accountUid = options.accountUid;
    this.#tmuxExecutablePath = options.tmuxExecutablePath;
    this.#inspectionAdapterFactory = options.inspectionAdapterFactory
      ?? ((selection) => createDarwinCodexRolloutTofuInspectionAdapter(Object.freeze({
        tmuxExecutablePath: this.#tmuxExecutablePath,
        selection,
      })));
    this.#resolveWorkingDirectory = options.resolveWorkingDirectory
      ?? ((token, scopeId, sessionId) => resolveRelayV2CanonicalSessionWorkingDirectory(
        this.#resolver,
        token,
        scopeId,
        sessionId,
      ));
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#schedule = options.schedule ?? defaultSchedule;
    if (!Number.isSafeInteger(this.#accountUid) || this.#accountUid < 0
      || !Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 10
      || this.#pollIntervalMs > 5_000) {
      throw new TypeError("dynamic Codex rollout attachment options are invalid");
    }
  }

  activate(): void {
    if (this.#closing) throw new Error("dynamic Codex rollout attachment is closed");
    this.#ready = true;
    this.#sink?.apply(true);
  }

  subscribe(sink: RelayV2HostOptionalExtensionIngressSink): RelayV2HostOptionalExtensionIngressSubscription {
    if (this.#subscriptionIssued || this.#closing) {
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
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.#sink === sink) this.#sink = null;
      },
    });
  }

  inspectRequest(bytes: Uint8Array, metadata: RelayV2FrameMetadata): RelayV2HostOptionalExtensionRequestDescriptor {
    const decoded = decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata);
    if (decoded.normalized.kind !== "request") throw new Error("Relay Agent request expected");
    return Object.freeze({
      requestId: decoded.frame.requestId as string,
      hostId: decoded.frame.hostId as string,
      expectedHostEpoch: decoded.frame.expectedHostEpoch as string,
      scopeId: decoded.frame.scopeId as string,
      sessionId: decoded.frame.sessionId as string,
    });
  }

  async authorize(context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean> {
    if (!this.#ready || this.#closing
      || context.hostId !== this.#store.owner.hostId
      || context.hostEpoch !== this.#store.owner.hostEpoch) return false;
    try {
      const token = await this.#resolver.captureToken(context.hostEpoch);
      const target = await this.#resolver.resolveSession(token, context.scopeId, context.sessionId);
      if (target.authorization !== "evidence_only"
        || target.hostEpoch !== context.hostEpoch
        || target.scopeId !== context.scopeId
        || target.sessionId !== context.sessionId
        || target.processTarget.kind !== "local") return false;
      const cwd = await this.#resolveWorkingDirectory(token, context.scopeId, context.sessionId);
      if (cwd === null) {
        await this.#store.markUnavailable(
          { scopeId: context.scopeId, sessionId: context.sessionId },
          "session_not_agent_managed",
        );
        return true;
      }
      const identity = opaqueDigest(
        target.backendInstanceKey,
        target.managedTarget.name,
        target.managedTarget.incarnation,
        cwd,
      );
      await this.#serialize(() => this.#ensureSession(
        context.scopeId,
        context.sessionId,
        identity,
        Object.freeze({
          sessionName: target.managedTarget.name,
          managedIncarnation: target.managedTarget.incarnation,
          expectedCwd: cwd,
        }),
      ));
      return true;
    } catch {
      return false;
    }
  }

  async handleRequest(
    bytes: Uint8Array,
    metadata: RelayV2FrameMetadata,
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<RelayV2HostOptionalExtensionDelivery> {
    const delivery = await this.#runtime.handleRequest(bytes, metadata, {
      capabilityNegotiated: true,
      ...context,
    });
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

  async publishLive(delivery: RelayAgentRuntimeDelivery): Promise<void> {
    if (!this.#ready || this.#closing || this.#sink === null) return;
    try {
      await this.#sink.publish(Object.freeze({ frame: delivery.frame, bytes: delivery.bytes }));
    } catch {
      this.#withdraw();
    }
  }

  withdraw(): void {
    this.#withdraw();
  }

  isolateFailure(): void {
    this.#withdraw();
  }

  closeAndDrain(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    this.#ready = false;
    try { this.#sink?.close(); } catch {}
    this.#closePromise = this.#serialize(async () => {
      await Promise.all([...this.#entries.values()].map((entry) => this.#closeEntry(entry)));
      this.#entries.clear();
    });
    void this.#closePromise.catch(() => undefined);
    return this.#closePromise;
  }

  #withdraw(): void {
    if (this.#closing) return;
    this.#ready = false;
    try { this.#sink?.close(); } catch {}
    void this.closeAndDrain().catch(() => undefined);
  }

  #serialize(operation: () => void | Promise<void>): Promise<void> {
    const next = this.#operationTail.then(operation, operation);
    this.#operationTail = next.catch(() => undefined);
    return next;
  }

  async #ensureSession(
    scopeId: string,
    sessionId: string,
    identity: string,
    selection: Readonly<CodexRolloutManagedSessionSelection>,
  ): Promise<void> {
    if (this.#closing) throw new Error("dynamic Codex rollout attachment is closed");
    const key = `${scopeId}\0${sessionId}`;
    const existing = this.#entries.get(key);
    if (existing !== undefined
      && existing.identity === identity
      && existing.state === "active") return;
    if (existing !== undefined) {
      await this.#closeEntry(existing);
      this.#entries.delete(key);
    }
    for (const [candidateKey, candidate] of this.#entries) {
      if (candidate.state !== "failed"
        && candidate.state !== "closing"
        && candidate.state !== "closed") continue;
      await this.#closeEntry(candidate);
      if (this.#entries.get(candidateKey) === candidate) this.#entries.delete(candidateKey);
    }
    if (this.#entries.size >= MAX_ACTIVE_SESSIONS) {
      await this.#store.markUnavailable({ scopeId, sessionId }, "adapter_unavailable");
      return;
    }
    const entry: SessionEntry = {
      key,
      identity,
      target: Object.freeze({ scopeId, sessionId }),
      state: "opening",
      authority: null,
      follower: null,
      channel: null,
      producer: null,
      pump: null,
      closePromise: null,
    };
    this.#entries.set(key, entry);
    try {
      const adapter = await this.#inspectionAdapterFactory(selection);
      const authority = new CodexRolloutFileSourceAuthority(Object.freeze({
        platform: "darwin" as const,
        accountHome: this.#accountHome,
        accountUid: this.#accountUid,
        selection,
        tmux: adapter,
        processes: adapter,
        openFiles: adapter,
      }));
      entry.authority = authority;
      const opened = await authority.open();
      const replayBytes = opened.durableCut.offset - opened.firstRecordEndOffset;
      if (replayBytes < 0n || replayBytes > BigInt(MAX_REPLAY_BYTES)
        || opened.firstRecordEndOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Codex rollout replay cut is outside the bounded window");
      }
      const follower = claimCodexRolloutOpenByteSource(opened.sourceIdentity);
      entry.follower = follower;
      const sourceIdentity = `rollout-${opaqueDigest(
        opened.durableCut.device,
        opened.durableCut.inode,
        opened.threadId,
      )}`;
      const binding = Object.freeze({
        providerVersion: CODEX_ROLLOUT_FILE_PROVIDER_VERSION,
        threadId: opened.threadId,
        processIdentity: `pid-${opened.codexPid}-${opaqueDigest(identity, opened.codexPid).slice(0, 32)}`,
        sourceIdentity,
      });
      const channel = new RolloutAppendChannel(
        binding,
        follower,
        opened.durableCut.device,
        opened.durableCut.inode,
        opened.firstRecordEndOffset,
        this.#pollIntervalMs,
        this.#schedule,
      );
      entry.channel = channel;
      const source = createCodexRolloutJsonlNotificationByteSource({
        binding,
        cut: Object.freeze({ sourceIdentity, offset: Number(opened.firstRecordEndOffset) }),
        channel,
      });
      const ingress = new RelayAgentTrustedSourceIngressLease(this.#runtime);
      const producer = new CodexAppServerV2EventProducer(ingress);
      producer.enable(Object.freeze({
        binding: Object.freeze({
          hostId: this.#store.owner.hostId,
          hostEpoch: this.#store.owner.hostEpoch,
          scopeId,
          sessionId,
        }),
        source: Object.freeze({
          sourceEpoch: `rollout-${opaqueDigest(
            this.#store.owner.hostId,
            this.#store.owner.hostEpoch,
            scopeId,
            sessionId,
            identity,
            sourceIdentity,
            opened.threadId,
          )}`,
        }),
        version: Object.freeze({
          provider: CODEX_APP_SERVER_V2_PROVIDER,
          providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0,
          schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
        }),
        limits: Object.freeze({
          maxInputBytes: CODEX_ROLLOUT_JSONL_SOURCE_BUDGETS.maxLineBytes + 1,
          maxPendingEvents: 32,
          maxRememberedEvents: 10_000,
        }),
        correlation: null,
      }));
      entry.producer = producer;
      entry.state = "active";
      entry.pump = (async () => {
        try {
          for await (const notification of source) await producer.accept(notification);
        } catch {
          if (!this.#closing && entry.state === "active") {
            entry.state = "failed";
            await this.#store.markUnavailable(entry.target, "adapter_unavailable").catch(() => {
              this.#withdraw();
            });
          }
        } finally {
          channel.cancel();
          await producer.close().catch(() => undefined);
          await follower.closeAndDrain().catch(() => undefined);
          await authority.closeAndDrain().catch(() => undefined);
        }
      })();
      void entry.pump.catch(() => undefined);
    } catch {
      entry.state = "failed";
      await this.#closeEntry(entry).catch(() => undefined);
      entry.state = "failed";
      await this.#store.markUnavailable(entry.target, "adapter_unavailable");
    }
  }

  #closeEntry(entry: SessionEntry): Promise<void> {
    if (entry.closePromise !== null) return entry.closePromise;
    entry.state = "closing";
    entry.channel?.cancel();
    entry.closePromise = (async () => {
      await entry.pump?.catch(() => undefined);
      await entry.producer?.close().catch(() => undefined);
      await entry.follower?.closeAndDrain().catch(() => undefined);
      await entry.authority?.closeAndDrain().catch(() => undefined);
      entry.state = "closed";
    })();
    return entry.closePromise;
  }
}

export async function openRelayV2HostDynamicCodexRolloutAgentTranscriptLifecycleAttachment(
  options: RelayV2HostDynamicCodexRolloutAttachmentOptions,
): Promise<RelayV2HostOptionalExtensionAttachment> {
  const attachment = new DynamicCodexRolloutAttachment(options);
  attachment.activate();
  return attachment;
}
