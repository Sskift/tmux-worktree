import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  TerminalControlAgentSource,
  TerminalControlLease,
  TerminalControlOwner,
} from "../../terminalControl/protocol.js";
import { TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES } from
  "../../terminalControl/protocol.js";
import {
  decodeRelayAgentChatFrame,
  encodeRelayAgentChatFrame,
  encodeRelayAgentChatUnavailableError,
  RELAY_AGENT_CHAT_CAPABILITY,
  RELAY_AGENT_CHAT_IMAGE_CHUNK_BYTES,
  RELAY_AGENT_CHAT_MAX_IMAGE_BYTES,
} from "../extensions/agentChat/v2/codec.js";
import {
  decodeRelayAgentTranscriptLifecycleFrame,
  encodeRelayAgentTranscriptLifecycleFrame,
  RELAY_AGENT_DEFAULT_REPLAY_RETENTION_MS,
  RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS,
  RELAY_AGENT_MAX_PAGE_RECORDS,
  RELAY_AGENT_MAX_TEXT_UTF8_BYTES,
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
} from "../extensions/agentTranscriptLifecycle/v1/codec.js";
import type { RelayV2FrameMetadata } from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import type {
  RelayV2HostOptionalExtensionAttachment,
  RelayV2HostOptionalExtensionDelivery,
  RelayV2HostOptionalExtensionIngressSink,
  RelayV2HostOptionalExtensionRequestDescriptor,
  RelayV2HostOptionalExtensionRouteContext,
} from "./hostRuntime.js";
import type { RelayV2HostStateStore } from "./hostState.js";
import {
  resolveRelayV2CanonicalSessionWorkingDirectory,
  type RelayV2CanonicalResourceResolverPort,
} from "./resourceState.js";
import type { RelayV2CanonicalTerminalTargetResolverAdapter } from
  "./canonicalTerminalTargetResolverAdapter.js";
import type { RelayV2RemoteExactTerminalControlCompoundAdapterV1 } from
  "./remoteExactTerminalControlCompoundV1.js";

const STORE_SCHEMA_VERSION = 2;
const STORE_PREFIX = "agent-conversation:v2:";
const MAX_CHAT_TURNS = 32;
const MAX_TIMELINE_EVENTS = 128;
const MAX_REPLY_IMAGES = 6;
const POLL_INTERVAL_MS = 1_000;
const LEASE_RENEW_INTERVAL_MS = 20_000;
const TURN_TIMEOUT_MS = 10 * 60_000;

type ChatContentPart =
  | { type: "markdown"; text: string }
  | {
      type: "image";
      imageId: string;
      mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      altText: string;
      byteLength: number;
      sha256: string;
    };

type ChatTurn = {
  turnId: string;
  session: string;
  userMessage: string;
  status: "working" | "replied" | "failed" | "recovery-required";
  content: ChatContentPart[] | null;
  error: string | null;
  sentAt: string;
  completedAt: string | null;
  steeredMessages: Array<{ message: string; sentAt: string }> | null;
};

type StoredImage = {
  imageId: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  byteLength: number;
  sha256: string;
};

type StoredConversation = {
  schemaVersion: 2;
  scopeId: string;
  sessionId: string;
  timelineEpoch: string;
  sourceEpoch: string;
  liveSource: "connected" | "interrupted";
  runId: string;
  agentEventSeq: string;
  turns: ChatTurn[];
  records: RelayV2JsonObject[];
  events: RelayV2JsonObject[];
  requests: Array<{ requestId: string; turnId: string }>;
  pendingSteered: Array<{
    turnId: string;
    messages: Array<{ message: string; sentAt: string }>;
  }>;
  images: StoredImage[];
  activeSource: TerminalControlAgentSource | null;
};

type ControlSession = {
  lease: TerminalControlLease;
  outputGeneration: string;
};

type ActiveTurn = {
  key: string;
  context: RelayV2HostOptionalExtensionRouteContext;
  control: ControlSession;
  turnId: string | null;
  source: TerminalControlAgentSource | null;
  deadlineAtMs: number;
  renewAtMs: number;
  controlRebind: "available" | "pending" | "used";
  timer: ReturnType<typeof setTimeout> | null;
};

type ExtensionState = {
  sink: RelayV2HostOptionalExtensionIngressSink | null;
  ready: boolean;
  closed: boolean;
};

export interface RelayV2AgentConversationAuthorityOptions {
  hostId: string;
  hostEpoch: string;
  hostState: RelayV2HostStateStore;
  resourceResolver: RelayV2CanonicalResourceResolverPort;
  resolver: RelayV2CanonicalTerminalTargetResolverAdapter;
  exactTargets: RelayV2RemoteExactTerminalControlCompoundAdapterV1;
  now?: () => number;
}

function opaque(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !/[\0\r\n]/.test(value)
    && Buffer.byteLength(value, "utf8") <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storedConversation(value: unknown, scopeId: string, sessionId: string): StoredConversation {
  if (!isRecord(value)
    || value.schemaVersion !== STORE_SCHEMA_VERSION
    || value.scopeId !== scopeId
    || value.sessionId !== sessionId
    || !opaque(value.timelineEpoch)
    || !opaque(value.sourceEpoch)
    || (value.liveSource !== "connected" && value.liveSource !== "interrupted")
    || !opaque(value.runId)
    || typeof value.agentEventSeq !== "string"
    || !/^[1-9][0-9]*$/.test(value.agentEventSeq)
    || !Array.isArray(value.turns)
    || !Array.isArray(value.records)
    || !Array.isArray(value.events)
    || !Array.isArray(value.requests)
    || !Array.isArray(value.pendingSteered)
    || !Array.isArray(value.images)
    || (value.activeSource !== null && !isRecord(value.activeSource))) {
    throw new Error("Relay v2 Agent conversation state is invalid");
  }
  return structuredClone(value) as StoredConversation;
}

function stateKey(scopeId: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(scopeId, "utf8")
    .update("\0")
    .update(sessionId, "utf8")
    .digest("base64url");
  return `${STORE_PREFIX}${digest}`;
}

function timestamp(now: number): string {
  return new Date(now).toISOString();
}

function nextSequence(state: StoredConversation): string {
  state.agentEventSeq = (BigInt(state.agentEventSeq) + 1n).toString(10);
  return state.agentEventSeq;
}

function trimState(state: StoredConversation): void {
  if (state.turns.length > MAX_CHAT_TURNS) {
    const removed = new Set(
      state.turns.splice(0, state.turns.length - MAX_CHAT_TURNS).map((turn) => turn.turnId),
    );
    state.requests = state.requests.filter((item) => !removed.has(item.turnId));
    state.pendingSteered = state.pendingSteered.filter((item) => !removed.has(item.turnId));
  }
  if (state.events.length > MAX_TIMELINE_EVENTS) {
    state.events.splice(0, state.events.length - MAX_TIMELINE_EVENTS);
  }
  if (state.records.length > RELAY_AGENT_MAX_PAGE_RECORDS) {
    state.records.splice(0, state.records.length - RELAY_AGENT_MAX_PAGE_RECORDS);
  }
  if (state.requests.length > MAX_CHAT_TURNS * 2) {
    state.requests.splice(0, state.requests.length - MAX_CHAT_TURNS * 2);
  }
  const retainedImages = new Set(state.turns.flatMap((turn) => (
    turn.content?.flatMap((part) => part.type === "image" ? [part.imageId] : []) ?? []
  )));
  state.images = state.images.filter((image) => retainedImages.has(image.imageId));
}

function detectImageMime(bytes: Uint8Array): StoredImage["mimeType"] | null {
  if (bytes.byteLength >= 8
    && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))) return "image/png";
  if (bytes.byteLength >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.byteLength >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.byteLength >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function readBoundedImage(path: string): Promise<{
  bytes: Buffer;
  mimeType: StoredImage["mimeType"];
  sha256: string;
}> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > RELAY_AGENT_CHAT_MAX_IMAGE_BYTES) {
    throw new Error("Agent image is not a supported bounded file");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error("Agent image changed while reading");
  const mimeType = detectImageMime(bytes);
  if (mimeType === null) throw new Error("Agent image format is unsupported");
  return {
    bytes,
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function localImagePath(rawTarget: string, workingDirectory: string | null): string | null {
  const target = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (target.length === 0 || target.length > 4_096 || target.includes("\0")) return null;
  if (target.startsWith("file://")) {
    try {
      return fileURLToPath(target);
    } catch {
      return null;
    }
  }
  if (isAbsolute(target)) return target;
  return workingDirectory === null ? null : resolve(workingDirectory, target);
}

function appendTimelineEvent(
  state: StoredConversation,
  mutation: RelayV2JsonObject,
  occurredAtMs: number,
): RelayV2JsonObject {
  const agentEventSeq = nextSequence(state);
  const eventId = `agent-event-${randomUUID()}`;
  const normalizedMutation = structuredClone(mutation);
  if (normalizedMutation.mutationType === "lifecycle.changed") {
    const lifecycle = normalizedMutation.lifecycle as RelayV2JsonObject;
    lifecycle.lifecycleEventId = eventId;
    lifecycle.occurredAtMs = occurredAtMs;
    lifecycle.agentEventSeq = agentEventSeq;
    const existing = state.records.findIndex((record) => (
      record.recordType === "lifecycle"
      && record.scope === lifecycle.scope
      && record.runId === lifecycle.runId
      && record.turnId === lifecycle.turnId
    ));
    if (existing >= 0) state.records.splice(existing, 1);
    state.records.push(structuredClone(lifecycle));
  } else if (normalizedMutation.mutationType === "text_entry.appended") {
    const entry = normalizedMutation.entry as RelayV2JsonObject;
    entry.createdAtMs = occurredAtMs;
    entry.createdAgentSeq = agentEventSeq;
    entry.lastModifiedAgentSeq = agentEventSeq;
    state.records.push(structuredClone(entry));
  }
  const event: RelayV2JsonObject = {
    agentEventSeq,
    eventId,
    occurredAtMs,
    mutation: normalizedMutation,
  };
  state.events.push(event);
  trimState(state);
  return event;
}

function currentRunState(
  state: StoredConversation,
): "running" | "waiting_for_user" | "failed" | "completed" | null {
  const record = state.records.find((item) => (
    item.recordType === "lifecycle"
    && item.scope === "run"
    && item.runId === state.runId
    && item.turnId === null
  ));
  return record?.state === "running"
    || record?.state === "waiting_for_user"
    || record?.state === "failed"
    || record?.state === "completed"
    ? record.state
    : null;
}

function lifecycleMutation(
  state: StoredConversation,
  scope: "run" | "turn",
  lifecycleState: "running" | "waiting_for_user" | "failed" | "completed",
  turnId: string | null,
  failure: RelayV2JsonObject | null = null,
): RelayV2JsonObject {
  return {
    mutationType: "lifecycle.changed",
    lifecycle: {
      recordType: "lifecycle",
      lifecycleEventId: "pending",
      sourceEpoch: state.sourceEpoch,
      scope,
      runId: state.runId,
      turnId,
      state: lifecycleState,
      failure,
      occurredAtMs: 0,
      agentEventSeq: "1",
    },
  };
}

function textMutation(
  state: StoredConversation,
  turnId: string,
  role: "user" | "agent",
  text: string,
  commandId: string | null,
): RelayV2JsonObject {
  return {
    mutationType: "text_entry.appended",
    entry: {
      recordType: "text_entry",
      entryId: `agent-entry-${randomUUID()}`,
      runId: state.runId,
      turnId,
      role,
      state: "visible",
      text,
      redactionReason: null,
      commandId,
      createdAtMs: 0,
      createdAgentSeq: "1",
      lastModifiedAgentSeq: "1",
    },
  };
}

function initialState(
  scopeId: string,
  sessionId: string,
  liveSource: "connected" | "interrupted",
  sourceEpoch: string,
  now: number,
): { state: StoredConversation; events: RelayV2JsonObject[] } {
  const state: StoredConversation = {
    schemaVersion: STORE_SCHEMA_VERSION,
    scopeId,
    sessionId,
    timelineEpoch: `agent-timeline-${randomUUID()}`,
    sourceEpoch,
    liveSource,
    runId: `agent-run-${randomUUID()}`,
    agentEventSeq: "1",
    turns: [],
    records: [],
    events: [],
    requests: [],
    pendingSteered: [],
    images: [],
    activeSource: null,
  };
  const first: RelayV2JsonObject = {
    agentEventSeq: "1",
    eventId: `agent-event-${randomUUID()}`,
    occurredAtMs: now,
    mutation: {
      mutationType: "source.availability",
      state: liveSource,
      sourceEpoch,
      reason: liveSource === "connected" ? null : "source_disconnected",
    },
  };
  state.events.push(first);
  return { state, events: [first] };
}

function parseOwnership(value: unknown, lease: TerminalControlLease): string {
  if (!isRecord(value)
    || value.controlTargetId !== lease.controlTargetId
    || value.controlEpoch !== lease.controlEpoch
    || typeof value.outputGeneration !== "string"
    || !opaque(value.outputGeneration)) {
    throw new Error("Relay v2 Agent control ownership is invalid");
  }
  return value.outputGeneration;
}

function parseAgentStatus(value: unknown, control: ControlSession): {
  agentSupported: boolean;
  agentRunning: boolean;
  source: TerminalControlAgentSource | null;
} {
  if (!isRecord(value)
    || value.controlTargetId !== control.lease.controlTargetId
    || value.controlEpoch !== control.lease.controlEpoch
    || value.leaseId !== control.lease.leaseId
    || value.fence !== control.lease.fence
    || value.ownerKind !== "relay-v2"
    || value.outputGeneration !== control.outputGeneration
    || value.pane !== "0"
    || typeof value.agentSupported !== "boolean"
    || typeof value.agentRunning !== "boolean"
    || (!value.agentSupported && value.agentRunning)
    || value.agentRunning !== isRecord(value.source)) {
    throw new Error("Relay v2 Agent status is invalid");
  }
  return {
    agentSupported: value.agentSupported,
    agentRunning: value.agentRunning,
    source: value.agentRunning ? structuredClone(value.source) as TerminalControlAgentSource : null,
  };
}

function boundedError(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "INTERNAL";
  if (code === "PERMISSION_DENIED"
    && isRecord(error)
    && error.message === "Agent authentication is required") {
    return "Agent authentication is required";
  }
  return `Agent conversation failed (${code})`;
}

function observationControlInvalidated(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") return false;
  return error.code === "STALE_OUTPUT_CURSOR"
    || (error.code === "PERMISSION_DENIED"
      && error.message !== "Agent authentication is required");
}

export class RelayV2AgentConversationAuthority {
  private readonly hostId: string;
  private readonly hostEpoch: string;
  private readonly hostState: RelayV2HostStateStore;
  private readonly resourceResolver: RelayV2CanonicalResourceResolverPort;
  private readonly resolver: RelayV2CanonicalTerminalTargetResolverAdapter;
  private readonly exactTargets: RelayV2RemoteExactTerminalControlCompoundAdapterV1;
  private readonly owner: TerminalControlOwner & { kind: "relay-v2" };
  private readonly now: () => number;
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly chat: ExtensionState = { sink: null, ready: true, closed: false };
  private readonly timeline: ExtensionState = { sink: null, ready: true, closed: false };
  private closeBarrier: Promise<void> | null = null;

  constructor(options: RelayV2AgentConversationAuthorityOptions) {
    if (!opaque(options.hostId)
      || !opaque(options.hostEpoch)
      || !options.hostState
      || !options.resourceResolver
      || !options.resolver
      || !options.exactTargets) {
      throw new TypeError("Relay v2 Agent conversation authority options are invalid");
    }
    this.hostId = options.hostId;
    this.hostEpoch = options.hostEpoch;
    this.hostState = options.hostState;
    this.resourceResolver = options.resourceResolver;
    this.resolver = options.resolver;
    this.exactTargets = options.exactTargets;
    this.owner = Object.freeze({
      kind: "relay-v2",
      instanceId: `relay-v2-host-${options.hostState.hostInstanceId}`,
    });
    this.now = options.now ?? Date.now;
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.lanes.set(key, current);
    return previous.catch(() => undefined).then(operation).finally(() => {
      release();
      if (this.lanes.get(key) === current) this.lanes.delete(key);
    });
  }

  private async readState(scopeId: string, sessionId: string): Promise<StoredConversation | null> {
    const key = stateKey(scopeId, sessionId);
    const value = (await this.hostState.read()).materialized[key];
    if (value === undefined) return null;
    if (isRecord(value) && value.schemaVersion === 1) {
      await this.hostState.transaction((transaction) => {
        if (transaction.hostEpoch !== this.hostEpoch) {
          throw new Error("Relay v2 Agent Host epoch changed");
        }
        transaction.deleteMaterializedRecord(key);
      });
      return null;
    }
    return storedConversation(value, scopeId, sessionId);
  }

  private async writeState(state: StoredConversation): Promise<void> {
    trimState(state);
    await this.hostState.transaction((transaction) => {
      if (transaction.hostEpoch !== this.hostEpoch) {
        throw new Error("Relay v2 Agent Host epoch changed");
      }
      transaction.putMaterializedRecord(
        stateKey(state.scopeId, state.sessionId),
        structuredClone(state) as unknown as RelayV2JsonObject,
      );
    });
  }

  private async materializeReply(
    context: RelayV2HostOptionalExtensionRouteContext,
    reply: string,
  ): Promise<{ content: ChatContentPart[]; images: StoredImage[] }> {
    let workingDirectory: string | null = null;
    try {
      const token = await this.resourceResolver.captureToken(context.hostEpoch);
      const target = await this.resourceResolver.resolveSession(
        token,
        context.scopeId,
        context.sessionId,
      );
      if (target.processTarget.kind !== "local") {
        return { content: [{ type: "markdown", text: reply }], images: [] };
      }
      workingDirectory = await resolveRelayV2CanonicalSessionWorkingDirectory(
        this.resourceResolver,
        token,
        context.scopeId,
        context.sessionId,
      );
    } catch {
      return { content: [{ type: "markdown", text: reply }], images: [] };
    }

    const content: ChatContentPart[] = [];
    const images: StoredImage[] = [];
    let cursor = 0;
    const pattern = /!\[([^\]\r\n]{0,256})\]\((<[^>\r\n]{1,4096}>|[^)\r\n]{1,4096})\)/g;
    for (const match of reply.matchAll(pattern)) {
      if (images.length >= MAX_REPLY_IMAGES) break;
      const index = match.index;
      const path = localImagePath(match[2]!, workingDirectory);
      if (path === null) continue;
      try {
        const image = await readBoundedImage(path);
        const imageId = `image-${image.sha256}`;
        const markdown = reply.slice(cursor, index);
        if (markdown.length > 0) content.push({ type: "markdown", text: markdown });
        content.push({
          type: "image",
          imageId,
          mimeType: image.mimeType,
          altText: match[1]!,
          byteLength: image.bytes.byteLength,
          sha256: image.sha256,
        });
        images.push({
          imageId,
          path,
          mimeType: image.mimeType,
          byteLength: image.bytes.byteLength,
          sha256: image.sha256,
        });
        cursor = index + match[0].length;
      } catch {
        // Preserve unreadable or unsupported image markup as ordinary Markdown.
      }
    }
    const markdown = reply.slice(cursor);
    if (markdown.length > 0) content.push({ type: "markdown", text: markdown });
    return content.length > 0
      ? { content, images }
      : { content: [{ type: "markdown", text: reply }], images: [] };
  }

  async authorize(context: RelayV2HostOptionalExtensionRouteContext): Promise<boolean> {
    if (this.closeBarrier !== null
      || context.hostId !== this.hostId
      || context.hostEpoch !== this.hostEpoch) return false;
    try {
      const token = await this.resourceResolver.captureToken(context.hostEpoch);
      const target = await this.resourceResolver.resolveSession(
        token,
        context.scopeId,
        context.sessionId,
      );
      return target.hostEpoch === context.hostEpoch
        && target.scopeId === context.scopeId
        && target.sessionId === context.sessionId;
    } catch {
      return false;
    }
  }

  private async openControl(
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<ControlSession> {
    const resolution = await this.resolver.resolve({
      auth: {
        principalId: context.principalId,
        clientInstanceId: context.clientInstanceId,
      },
      hostEpoch: context.hostEpoch,
      target: {
        hostId: context.hostId,
        scopeId: context.scopeId,
        sessionId: context.sessionId,
      },
      pane: 0,
    });
    await this.hostState.transaction((transaction) => {
      this.resolver.fenceSessionForAdmission(transaction, resolution);
    });
    const lease = await this.exactTargets.consumePreparedLeaseForBinding(
      resolution.binding,
      this.owner,
    );
    try {
      const ownership = await this.exactTargets.request({
        type: "ownership.status",
        controlTargetId: lease.controlTargetId,
      });
      return { lease, outputGeneration: parseOwnership(ownership, lease) };
    } catch (error) {
      await this.exactTargets.request({ type: "lease.release", lease }).catch(() => undefined);
      throw error;
    }
  }

  private async releaseControl(control: ControlSession): Promise<void> {
    await this.exactTargets.request({
      type: "lease.release",
      lease: control.lease,
    }).catch(() => undefined);
  }

  private async rebindControl(active: ActiveTurn): Promise<void> {
    await this.releaseControl(active.control);
    active.control = await this.openControl(active.context);
    active.renewAtMs = this.now() + LEASE_RENEW_INTERVAL_MS;
  }

  private async observeStatus(control: ControlSession): Promise<ReturnType<typeof parseAgentStatus>> {
    const raw = await this.exactTargets.request({
      type: "activity.agent-status",
      lease: control.lease,
      outputGeneration: control.outputGeneration,
      pane: "0",
    });
    return parseAgentStatus(raw, control);
  }

  private async publishTimeline(
    state: StoredConversation,
    events: readonly RelayV2JsonObject[],
  ): Promise<void> {
    const sink = this.timeline.sink;
    if (!sink || !this.timeline.ready || this.timeline.closed) return;
    for (const event of events) {
      const frame: RelayV2JsonObject = {
        protocolVersion: 2,
        kind: "event",
        type: "agent.timeline.event",
        hostId: this.hostId,
        hostEpoch: this.hostEpoch,
        scopeId: state.scopeId,
        sessionId: state.sessionId,
        payload: {
          capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
          timelineEpoch: state.timelineEpoch,
          ...structuredClone(event),
        },
      };
      await sink.publish({ frame, bytes: encodeRelayAgentTranscriptLifecycleFrame(frame) });
    }
  }

  private async publishChat(state: StoredConversation, turn: ChatTurn): Promise<void> {
    const sink = this.chat.sink;
    if (!sink || !this.chat.ready || this.chat.closed) return;
    const frame: RelayV2JsonObject = {
      protocolVersion: 2,
      kind: "event",
      type: "agent.chat.event",
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: state.scopeId,
      sessionId: state.sessionId,
      payload: { session: state.sessionId, turn: structuredClone(turn) },
    };
    await sink.publish({ frame, bytes: encodeRelayAgentChatFrame(frame) });
  }

  private async ensureState(
    context: RelayV2HostOptionalExtensionRouteContext,
  ): Promise<StoredConversation | null> {
    const existing = await this.readState(context.scopeId, context.sessionId);
    if (existing !== null) return existing;
    const control = await this.openControl(context);
    let observed: ReturnType<typeof parseAgentStatus>;
    try {
      observed = await this.observeStatus(control);
    } catch (error) {
      await this.releaseControl(control);
      throw error;
    }
    if (!observed.agentSupported) {
      await this.releaseControl(control);
      return null;
    }
    const created = initialState(
      context.scopeId,
      context.sessionId,
      "connected",
      `agent-source-${randomUUID()}`,
      this.now(),
    );
    let recoveredActive: ActiveTurn | null = null;
    if (observed.agentRunning && observed.source !== null) {
      created.state.activeSource = observed.source;
      const runEvent = appendTimelineEvent(
        created.state,
        lifecycleMutation(created.state, "run", "running", null),
        this.now(),
      );
      const turnEvent = appendTimelineEvent(
        created.state,
        lifecycleMutation(created.state, "turn", "running", observed.source.turnId),
        this.now(),
      );
      created.events.push(runEvent, turnEvent);
      recoveredActive = {
        key: stateKey(context.scopeId, context.sessionId),
        context,
        control,
        turnId: null,
        source: observed.source,
        deadlineAtMs: this.now() + TURN_TIMEOUT_MS,
        renewAtMs: this.now() + LEASE_RENEW_INTERVAL_MS,
        controlRebind: "available",
        timer: null,
      };
    } else {
      const runEvent = appendTimelineEvent(
        created.state,
        lifecycleMutation(created.state, "run", "running", null),
        this.now(),
      );
      const waitingEvent = appendTimelineEvent(
        created.state,
        lifecycleMutation(created.state, "run", "waiting_for_user", null),
        this.now(),
      );
      created.events.push(runEvent, waitingEvent);
      await this.releaseControl(control);
    }
    await this.writeState(created.state);
    await this.publishTimeline(created.state, created.events);
    if (recoveredActive !== null) this.startPolling(recoveredActive);
    return created.state;
  }

  async send(
    requestId: string,
    context: RelayV2HostOptionalExtensionRouteContext,
    message: string,
  ): Promise<string> {
    const key = stateKey(context.scopeId, context.sessionId);
    return this.serialize(key, async () => {
      let state = await this.ensureState(context);
      if (state === null) throw Object.assign(new Error("Agent session is unsupported"), {
        code: "AGENT_CHAT_SESSION_UNAVAILABLE",
      });
      const replay = state.requests.find((item) => item.requestId === requestId);
      if (replay) return replay.turnId;

      let active = this.activeTurns.get(key) ?? null;
      const working = [...state.turns].reverse().find((turn) => turn.status === "working") ?? null;
      if (active === null) {
        const control = await this.openControl(context);
        active = {
          key,
          context,
          control,
          turnId: working?.turnId ?? null,
          source: state.activeSource,
          deadlineAtMs: this.now() + TURN_TIMEOUT_MS,
          renewAtMs: this.now() + LEASE_RENEW_INTERVAL_MS,
          controlRebind: "available",
          timer: null,
        };
      }
      const operationId = `agent-chat-${createHash("sha256")
        .update(requestId)
        .digest("hex").slice(0, 32)}`;
      const accepted = await this.exactTargets.request({
        type: "input.agent-message",
        lease: active.control.lease,
        operationId,
        pane: "0",
        message,
        submit: true,
      });
      if (!isRecord(accepted)
        || accepted.accepted !== true
        || accepted.controlEpoch !== active.control.lease.controlEpoch
        || accepted.fence !== active.control.lease.fence
        || typeof accepted.outputGeneration !== "string") {
        await this.releaseControl(active.control);
        throw new Error("Relay v2 Agent input acknowledgement is invalid");
      }
      active.control.outputGeneration = accepted.outputGeneration;
      const now = this.now();
      const events: RelayV2JsonObject[] = [];
      let turn: ChatTurn;
      if (working !== null) {
        turn = working;
        active.deadlineAtMs = now + TURN_TIMEOUT_MS;
        const steered = state.pendingSteered.find((item) => item.turnId === turn.turnId)
          ?? { turnId: turn.turnId, messages: [] };
        if (!state.pendingSteered.includes(steered)) state.pendingSteered.push(steered);
        steered.messages.push({ message, sentAt: timestamp(now) });
        events.push(appendTimelineEvent(
          state,
          textMutation(state, turn.turnId, "user", message, requestId),
          now,
        ));
      } else {
        const turnId = `agent-turn-${randomUUID()}`;
        turn = {
          turnId,
          session: context.sessionId,
          userMessage: message,
          status: "working",
          content: null,
          error: null,
          sentAt: timestamp(now),
          completedAt: null,
          steeredMessages: null,
        };
        state.turns.push(turn);
        if (currentRunState(state) !== "running") {
          events.push(appendTimelineEvent(
            state,
            lifecycleMutation(state, "run", "running", null),
            now,
          ));
        }
        events.push(appendTimelineEvent(
          state,
          textMutation(state, turnId, "user", message, requestId),
          now,
        ));
        events.push(appendTimelineEvent(
          state,
          lifecycleMutation(state, "turn", "running", turnId),
          now,
        ));
        active.turnId = turnId;
      }
      state.liveSource = "connected";
      state.requests.push({ requestId, turnId: turn.turnId });
      trimState(state);
      await this.writeState(state);
      await this.publishTimeline(state, events);
      await this.publishChat(state, turn);
      this.startPolling(active);
      return turn.turnId;
    });
  }

  private startPolling(active: ActiveTurn): void {
    const previous = this.activeTurns.get(active.key);
    if (previous?.timer) clearTimeout(previous.timer);
    this.activeTurns.set(active.key, active);
    active.timer = setTimeout(() => {
      active.timer = null;
      void this.poll(active);
    }, POLL_INTERVAL_MS);
    active.timer.unref?.();
  }

  private async poll(active: ActiveTurn): Promise<void> {
    if (this.closeBarrier !== null || this.activeTurns.get(active.key) !== active) return;
    await this.serialize(active.key, async () => {
      if (this.activeTurns.get(active.key) !== active) return;
      try {
        if (active.controlRebind === "pending") {
          if (this.now() >= active.deadlineAtMs) {
            throw Object.assign(new Error("Agent turn timed out"), { code: "TURN_TIMEOUT" });
          }
          await this.rebindControl(active);
          active.controlRebind = "used";
        }
        if (this.now() >= active.renewAtMs) {
          const renewed = await this.exactTargets.request({
            type: "lease.renew",
            lease: active.control.lease,
          });
          if (!isRecord(renewed) || !isRecord(renewed.lease)) {
            throw new Error("Relay v2 Agent lease renewal is invalid");
          }
          active.control.lease = renewed.lease as unknown as TerminalControlLease;
          active.renewAtMs = this.now() + LEASE_RENEW_INTERVAL_MS;
        }
        const status = await this.observeStatus(active.control);
        if (!status.agentSupported) throw Object.assign(new Error("Agent is unsupported"), {
          code: "AGENT_UNSUPPORTED",
        });
        if (status.agentRunning) {
          active.source = status.source;
          const state = await this.readState(active.context.scopeId, active.context.sessionId);
          if (state && status.source && state.activeSource?.sourceId !== status.source.sourceId) {
            const events: RelayV2JsonObject[] = [];
            state.activeSource = status.source;
            events.push(appendTimelineEvent(state, {
              mutationType: "source.availability",
              state: "connected",
              sourceEpoch: state.sourceEpoch,
              reason: "source_restarted",
            }, this.now()));
            await this.writeState(state);
            await this.publishTimeline(state, events);
          }
          if (this.now() >= active.deadlineAtMs) {
            throw Object.assign(new Error("Agent turn timed out"), { code: "TURN_TIMEOUT" });
          }
          this.startPolling(active);
          return;
        }
        if (active.source === null) {
          if (this.now() >= active.deadlineAtMs) {
            throw Object.assign(new Error("Agent result source is unavailable"), {
              code: "RESULT_SOURCE_UNAVAILABLE",
            });
          }
          this.startPolling(active);
          return;
        }
        const result = await this.exactTargets.request({
          type: "activity.agent-result",
          lease: active.control.lease,
          outputGeneration: active.control.outputGeneration,
          pane: "0",
          source: active.source,
          maxBytes: TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES,
        });
        if (!isRecord(result)
          || result.ownerKind !== "relay-v2"
          || result.controlTargetId !== active.control.lease.controlTargetId
          || result.leaseId !== active.control.lease.leaseId
          || typeof result.text !== "string"
          || result.text.length === 0
          || typeof result.completedAt !== "string") {
          throw new Error("Relay v2 Agent final response is invalid");
        }
        await this.completeActive(active, result.text, result.completedAt);
      } catch (error) {
        const failure = error;
        if (active.controlRebind === "available"
          && observationControlInvalidated(failure)
          && this.now() < active.deadlineAtMs) {
          active.controlRebind = "pending";
          this.startPolling(active);
          return;
        }
        const retryable = isRecord(failure) && failure.retryable === true;
        if (retryable && this.now() < active.deadlineAtMs) {
          this.startPolling(active);
          return;
        }
        await this.failActive(active, failure);
      }
    });
  }

  private async completeActive(active: ActiveTurn, reply: string, completedAt: string): Promise<void> {
    const state = await this.readState(active.context.scopeId, active.context.sessionId);
    if (state === null) throw new Error("Relay v2 Agent conversation state disappeared");
    const materialized = await this.materializeReply(active.context, reply);
    const now = this.now();
    const events: RelayV2JsonObject[] = [];
    let chatTurn: ChatTurn | null = null;
    if (active.turnId !== null) {
      chatTurn = state.turns.find((turn) => turn.turnId === active.turnId) ?? null;
      if (chatTurn) {
        const steered = state.pendingSteered.find((item) => item.turnId === chatTurn!.turnId);
        chatTurn.status = "replied";
        chatTurn.content = materialized.content;
        chatTurn.error = null;
        chatTurn.completedAt = completedAt;
        chatTurn.steeredMessages = steered?.messages.length ? steered.messages : null;
        state.pendingSteered = state.pendingSteered.filter((item) => item.turnId !== chatTurn!.turnId);
      }
      events.push(appendTimelineEvent(
        state,
        textMutation(state, active.turnId, "agent", reply, null),
        now,
      ));
      events.push(appendTimelineEvent(
        state,
        lifecycleMutation(state, "turn", "completed", active.turnId),
        now,
      ));
    } else {
      const turnId = active.source?.turnId ?? `agent-turn-${randomUUID()}`;
      events.push(appendTimelineEvent(
        state,
        textMutation(state, turnId, "agent", reply, null),
        now,
      ));
      events.push(appendTimelineEvent(
        state,
        lifecycleMutation(state, "turn", "completed", turnId),
        now,
      ));
    }
    for (const image of materialized.images) {
      const existing = state.images.findIndex((item) => item.imageId === image.imageId);
      if (existing >= 0) state.images[existing] = image;
      else state.images.push(image);
    }
    events.push(appendTimelineEvent(
      state,
      lifecycleMutation(state, "run", "waiting_for_user", null),
      now,
    ));
    state.activeSource = null;
    await this.writeState(state);
    this.activeTurns.delete(active.key);
    await this.releaseControl(active.control);
    await this.publishTimeline(state, events);
    if (chatTurn) await this.publishChat(state, chatTurn);
  }

  private async failActive(active: ActiveTurn, error: unknown): Promise<void> {
    const state = await this.readState(active.context.scopeId, active.context.sessionId);
    this.activeTurns.delete(active.key);
    await this.releaseControl(active.control);
    if (state === null) return;
    const now = this.now();
    const events: RelayV2JsonObject[] = [];
    let chatTurn: ChatTurn | null = null;
    const lifecycleTurnId = active.turnId ?? active.source?.turnId ?? null;
    if (active.turnId !== null) {
      chatTurn = state.turns.find((turn) => turn.turnId === active.turnId) ?? null;
      if (chatTurn) {
        chatTurn.status = "failed";
        chatTurn.error = boundedError(error);
        chatTurn.completedAt = timestamp(now);
        chatTurn.content = null;
        const steered = state.pendingSteered.find((item) => item.turnId === chatTurn!.turnId);
        chatTurn.steeredMessages = steered?.messages.length ? steered.messages : null;
        state.pendingSteered = state.pendingSteered.filter(
          (item) => item.turnId !== chatTurn!.turnId,
        );
      }
    }
    if (lifecycleTurnId !== null) {
      events.push(appendTimelineEvent(state, lifecycleMutation(
        state,
        "turn",
        "failed",
        lifecycleTurnId,
        { code: "agent_turn_failed", summary: boundedError(error) },
      ), now));
      events.push(appendTimelineEvent(
        state,
        lifecycleMutation(state, "run", "waiting_for_user", null),
        now,
      ));
    }
    state.activeSource = null;
    await this.writeState(state);
    await this.publishTimeline(state, events);
    if (chatTurn) await this.publishChat(state, chatTurn);
  }

  async history(
    context: RelayV2HostOptionalExtensionRouteContext,
    limit: number | undefined,
  ): Promise<ChatTurn[]> {
    const key = stateKey(context.scopeId, context.sessionId);
    return this.serialize(key, async () => {
      const state = await this.ensureState(context);
      if (state === null) throw Object.assign(new Error("Agent session is unsupported"), {
        code: "AGENT_CHAT_SESSION_UNAVAILABLE",
      });
      return state.turns.slice(-(limit ?? MAX_CHAT_TURNS)).map((turn) => structuredClone(turn));
    });
  }

  async imageChunk(
    context: RelayV2HostOptionalExtensionRouteContext,
    imageId: string,
    offset: number,
  ): Promise<RelayV2JsonObject> {
    const key = stateKey(context.scopeId, context.sessionId);
    return this.serialize(key, async () => {
      const state = await this.readState(context.scopeId, context.sessionId);
      const stored = state?.images.find((image) => image.imageId === imageId) ?? null;
      if (stored === null || offset < 0 || offset >= stored.byteLength) {
        throw Object.assign(new Error("Agent image is unavailable"), {
          code: "AGENT_CHAT_SESSION_UNAVAILABLE",
        });
      }
      const image = await readBoundedImage(stored.path);
      if (image.mimeType !== stored.mimeType
        || image.bytes.byteLength !== stored.byteLength
        || image.sha256 !== stored.sha256) {
        throw Object.assign(new Error("Agent image changed after publication"), {
          code: "AGENT_CHAT_SESSION_UNAVAILABLE",
        });
      }
      const end = Math.min(offset + RELAY_AGENT_CHAT_IMAGE_CHUNK_BYTES, image.bytes.byteLength);
      return {
        session: context.sessionId,
        imageId: stored.imageId,
        mimeType: stored.mimeType,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        offset,
        dataBase64: image.bytes.subarray(offset, end).toString("base64"),
        nextOffset: end === image.bytes.byteLength ? null : end,
      };
    });
  }

  async status(context: RelayV2HostOptionalExtensionRouteContext): Promise<RelayV2JsonObject> {
    const key = stateKey(context.scopeId, context.sessionId);
    return this.serialize(key, async () => {
      let state: StoredConversation | null;
      try {
        state = await this.ensureState(context);
      } catch {
        return this.unavailableStatus("adapter_unavailable");
      }
      if (state === null) return this.unavailableStatus("agent_unsupported");
      const earliest = state.events[0]?.agentEventSeq as string | undefined
        ?? state.agentEventSeq;
      return {
        capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
        support: "available",
        reason: null,
        liveSource: state.liveSource,
        activeSourceEpoch: state.sourceEpoch,
        timelineEpoch: state.timelineEpoch,
        currentAgentSeq: state.agentEventSeq,
        earliestReplaySeq: earliest,
        limits: {
          maxTextUtf8Bytes: RELAY_AGENT_MAX_TEXT_UTF8_BYTES,
          maxPageRecords: RELAY_AGENT_MAX_PAGE_RECORDS,
          eventReplayRetentionMs: RELAY_AGENT_DEFAULT_REPLAY_RETENTION_MS,
          snapshotLeaseMs: RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS,
        },
      };
    });
  }

  private unavailableStatus(
    reason: "agent_unsupported" | "adapter_unavailable" | "store_unavailable",
  ): RelayV2JsonObject {
    return {
      capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      support: "unavailable",
      reason,
      liveSource: "absent",
      activeSourceEpoch: null,
      timelineEpoch: null,
      currentAgentSeq: null,
      earliestReplaySeq: null,
      limits: null,
    };
  }

  async snapshot(
    context: RelayV2HostOptionalExtensionRouteContext,
    payload: RelayV2JsonObject,
  ): Promise<RelayV2JsonObject> {
    const key = stateKey(context.scopeId, context.sessionId);
    return this.serialize(key, async () => {
      const state = await this.ensureState(context);
      if (state === null) throw Object.assign(new Error("Agent timeline is unavailable"), {
        code: "AGENT_TIMELINE_UNAVAILABLE",
      });
      if (payload.snapshotId !== null || payload.cursor !== null || payload.nextPageIndex !== 0) {
        throw Object.assign(new Error("Agent snapshot continuation is unavailable"), {
          code: "AGENT_SNAPSHOT_EXPIRED",
        });
      }
      const earliest = state.events[0]?.agentEventSeq as string | undefined
        ?? state.agentEventSeq;
      return {
        capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
        timelineEpoch: state.timelineEpoch,
        snapshotRequestId: payload.snapshotRequestId,
        snapshotId: `agent-snapshot-${randomUUID()}`,
        pageIndex: 0,
        isLast: true,
        nextCursor: null,
        throughAgentSeq: state.agentEventSeq,
        earliestRetainedSeq: earliest,
        records: structuredClone(state.records),
      };
    });
  }

  async replay(
    context: RelayV2HostOptionalExtensionRouteContext,
    payload: RelayV2JsonObject,
  ): Promise<RelayV2JsonObject> {
    const key = stateKey(context.scopeId, context.sessionId);
    return this.serialize(key, async () => {
      const state = await this.ensureState(context);
      if (state === null) throw Object.assign(new Error("Agent timeline is unavailable"), {
        code: "AGENT_TIMELINE_UNAVAILABLE",
      });
      if (payload.timelineEpoch !== state.timelineEpoch) {
        throw Object.assign(new Error("Agent timeline lineage changed"), {
          code: "AGENT_TIMELINE_EPOCH_MISMATCH",
        });
      }
      const afterValue = payload.afterAgentSeq as string;
      const after = BigInt(afterValue);
      const earliest = BigInt(state.events[0]?.agentEventSeq as string ?? state.agentEventSeq);
      if (after + 1n < earliest) {
        throw Object.assign(new Error("Agent replay cursor expired"), {
          code: "AGENT_CURSOR_EXPIRED",
        });
      }
      if (after > BigInt(state.agentEventSeq)) {
        throw Object.assign(new Error("Agent replay cursor is ahead"), {
          code: "AGENT_CURSOR_AHEAD",
        });
      }
      let pinnedThrough = state.agentEventSeq;
      let pageAfter = afterValue;
      const cursor = payload.cursor;
      if (cursor !== null) {
        if (typeof cursor !== "string") {
          throw Object.assign(new Error("Agent replay cursor is invalid"), {
            code: "AGENT_CURSOR_EXPIRED",
          });
        }
        const match = /^agent-replay-([0-9]+)-([0-9]+)-([0-9]+)$/.exec(cursor);
        if (match === null || match[1] !== afterValue) {
          throw Object.assign(new Error("Agent replay cursor is invalid"), {
            code: "AGENT_CURSOR_EXPIRED",
          });
        }
        pinnedThrough = match[2];
        pageAfter = match[3];
        if (BigInt(pageAfter) < after
          || BigInt(pageAfter) > BigInt(pinnedThrough)
          || BigInt(pinnedThrough) > BigInt(state.agentEventSeq)) {
          throw Object.assign(new Error("Agent replay cursor is invalid"), {
            code: "AGENT_CURSOR_EXPIRED",
          });
        }
      }
      const limit = payload.limit as number;
      const events = state.events.filter((event) => {
        const sequence = BigInt(event.agentEventSeq as string);
        return sequence > BigInt(pageAfter) && sequence <= BigInt(pinnedThrough);
      }).slice(0, limit);
      if (BigInt(pageAfter) + 1n < earliest || (events.length === 0 && pageAfter !== pinnedThrough)) {
        throw Object.assign(new Error("Agent replay cursor expired"), {
          code: "AGENT_CURSOR_EXPIRED",
        });
      }
      const deliveredThrough = events.length === 0
        ? pageAfter
        : events[events.length - 1].agentEventSeq as string;
      const isLast = deliveredThrough === pinnedThrough;
      return {
        capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
        timelineEpoch: state.timelineEpoch,
        afterAgentSeq: afterValue,
        replayThroughAgentSeq: pinnedThrough,
        isLast,
        nextCursor: isLast
          ? null
          : `agent-replay-${afterValue}-${pinnedThrough}-${deliveredThrough}`,
        events: structuredClone(events),
      };
    });
  }

  subscribe(kind: "chat" | "timeline", sink: RelayV2HostOptionalExtensionIngressSink): void {
    const state = kind === "chat" ? this.chat : this.timeline;
    state.sink = sink;
    sink.apply(state.ready && !state.closed && this.closeBarrier === null);
  }

  unsubscribe(kind: "chat" | "timeline", sink: RelayV2HostOptionalExtensionIngressSink): void {
    const state = kind === "chat" ? this.chat : this.timeline;
    if (state.sink === sink) state.sink = null;
  }

  isolate(kind: "chat" | "timeline"): void {
    const state = kind === "chat" ? this.chat : this.timeline;
    state.ready = false;
    state.sink?.apply(false);
  }

  closeAndDrain(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.chat.closed = true;
    this.timeline.closed = true;
    this.chat.ready = false;
    this.timeline.ready = false;
    this.chat.sink = null;
    this.timeline.sink = null;
    const active = [...this.activeTurns.values()];
    this.activeTurns.clear();
    for (const item of active) if (item.timer) clearTimeout(item.timer);
    this.closeBarrier = Promise.allSettled(
      active.map((item) => this.releaseControl(item.control)),
    ).then(() => undefined);
    return this.closeBarrier;
  }
}

function descriptor(frame: RelayV2JsonObject): RelayV2HostOptionalExtensionRequestDescriptor {
  return Object.freeze({
    requestId: frame.requestId as string,
    hostId: frame.hostId as string,
    expectedHostEpoch: frame.expectedHostEpoch as string,
    scopeId: frame.scopeId as string,
    sessionId: frame.sessionId as string,
  });
}

function responseDelivery(
  frame: RelayV2JsonObject,
  encode: (frame: RelayV2JsonObject) => Uint8Array,
): RelayV2HostOptionalExtensionDelivery {
  return { frame, bytes: encode(frame) };
}

type LifecycleErrorCode =
  | "AGENT_TIMELINE_UNAVAILABLE"
  | "AGENT_CURSOR_EXPIRED"
  | "AGENT_CURSOR_AHEAD"
  | "AGENT_SNAPSHOT_EXPIRED"
  | "AGENT_TIMELINE_EPOCH_MISMATCH";

function lifecycleError(
  request: RelayV2JsonObject,
  context: RelayV2HostOptionalExtensionRouteContext,
  code: LifecycleErrorCode,
): RelayV2HostOptionalExtensionDelivery {
  const frame: RelayV2JsonObject = {
    protocolVersion: 2,
    kind: "response",
    type: "error",
    requestId: request.requestId,
    hostId: context.hostId,
    hostEpoch: context.hostEpoch,
    scopeId: context.scopeId,
    sessionId: context.sessionId,
    payload: null,
    error: {
      code,
      message: "Relay Agent timeline request is unavailable",
      retryable: code === "AGENT_TIMELINE_UNAVAILABLE",
      commandDisposition: "not_applicable",
    },
  };
  return responseDelivery(frame, encodeRelayAgentTranscriptLifecycleFrame);
}

function chatError(
  request: RelayV2JsonObject,
  context: RelayV2HostOptionalExtensionRouteContext,
  code: "AGENT_CHAT_UNAVAILABLE" | "AGENT_CHAT_SESSION_UNAVAILABLE",
): RelayV2HostOptionalExtensionDelivery {
  const bytes = encodeRelayAgentChatUnavailableError({
    requestId: request.requestId as string,
    hostId: context.hostId,
    hostEpoch: context.hostEpoch,
    scopeId: context.scopeId,
    sessionId: context.sessionId,
    code,
    message: "Relay Agent chat is unavailable",
    retryable: code === "AGENT_CHAT_UNAVAILABLE",
  });
  return { frame: decodeRelayAgentChatFrame(bytes).frame, bytes };
}

export function createRelayV2AgentConversationAttachments(
  authority: RelayV2AgentConversationAuthority,
): readonly RelayV2HostOptionalExtensionAttachment[] {
  const attachment = (
    kind: "chat" | "timeline",
    capability: string,
  ): RelayV2HostOptionalExtensionAttachment => {
    const result: RelayV2HostOptionalExtensionAttachment = {
    capability,
    subscribe(sink) {
      authority.subscribe(kind, sink);
      return Object.freeze({ unsubscribe: () => authority.unsubscribe(kind, sink) });
    },
    inspectRequest(bytes: Uint8Array, metadata: RelayV2FrameMetadata) {
      const decoded = kind === "chat"
        ? decodeRelayAgentChatFrame(bytes, metadata)
        : decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata);
      if (decoded.normalized.kind !== "request") {
        throw new Error("Relay v2 Agent extension received a non-request");
      }
      return descriptor(decoded.frame);
    },
    authorize(context) {
      return authority.authorize(context);
    },
    async handleRequest(bytes, metadata, context) {
      if (kind === "chat") {
        const frame = decodeRelayAgentChatFrame(bytes, metadata).frame;
        if ((frame.payload as RelayV2JsonObject).session !== context.sessionId) {
          return chatError(frame, context, "AGENT_CHAT_SESSION_UNAVAILABLE");
        }
        try {
          if (frame.type === "agent.chat.send") {
            const turnId = await authority.send(
              frame.requestId as string,
              context,
              (frame.payload as RelayV2JsonObject).message as string,
            );
            const response: RelayV2JsonObject = {
              protocolVersion: 2,
              kind: "response",
              type: "agent.chat.sent",
              requestId: frame.requestId,
              hostId: context.hostId,
              hostEpoch: context.hostEpoch,
              scopeId: context.scopeId,
              sessionId: context.sessionId,
              payload: { session: context.sessionId, turnId },
            };
            return responseDelivery(response, encodeRelayAgentChatFrame);
          }
          if (frame.type === "agent.chat.image.get") {
            const payload = frame.payload as RelayV2JsonObject;
            const chunk = await authority.imageChunk(
              context,
              payload.imageId as string,
              payload.offset as number,
            );
            const response: RelayV2JsonObject = {
              protocolVersion: 2,
              kind: "response",
              type: "agent.chat.image.chunk",
              requestId: frame.requestId,
              hostId: context.hostId,
              hostEpoch: context.hostEpoch,
              scopeId: context.scopeId,
              sessionId: context.sessionId,
              payload: chunk,
            };
            return responseDelivery(response, encodeRelayAgentChatFrame);
          }
          const turns = await authority.history(
            context,
            (frame.payload as RelayV2JsonObject).limit as number | undefined,
          );
          const response: RelayV2JsonObject = {
            protocolVersion: 2,
            kind: "response",
            type: "agent.chat.history.result",
            requestId: frame.requestId,
            hostId: context.hostId,
            hostEpoch: context.hostEpoch,
            scopeId: context.scopeId,
            sessionId: context.sessionId,
            payload: { session: context.sessionId, turns },
          };
          return responseDelivery(response, encodeRelayAgentChatFrame);
        } catch (error) {
          const code = isRecord(error) && error.code === "AGENT_CHAT_SESSION_UNAVAILABLE"
            ? "AGENT_CHAT_SESSION_UNAVAILABLE"
            : "AGENT_CHAT_UNAVAILABLE";
          return chatError(frame, context, code);
        }
      }
      const frame = decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata).frame;
      try {
        const payload = frame.payload as RelayV2JsonObject;
        const responsePayload = frame.type === "agent.timeline.status.get"
          ? await authority.status(context)
          : frame.type === "agent.timeline.snapshot.get"
            ? await authority.snapshot(context, payload)
            : await authority.replay(context, payload);
        const response: RelayV2JsonObject = {
          protocolVersion: 2,
          kind: "response",
          type: frame.type === "agent.timeline.status.get"
            ? "agent.timeline.status"
            : frame.type === "agent.timeline.snapshot.get"
              ? "agent.timeline.snapshot.page"
              : "agent.timeline.replay.page",
          requestId: frame.requestId,
          hostId: context.hostId,
          hostEpoch: context.hostEpoch,
          scopeId: context.scopeId,
          sessionId: context.sessionId,
          payload: responsePayload,
        };
        return responseDelivery(response, encodeRelayAgentTranscriptLifecycleFrame);
      } catch (error) {
        const candidate = isRecord(error) && typeof error.code === "string"
          ? error.code
          : "AGENT_TIMELINE_UNAVAILABLE";
        const allowed = new Set([
          "AGENT_TIMELINE_UNAVAILABLE", "AGENT_CURSOR_EXPIRED", "AGENT_CURSOR_AHEAD",
          "AGENT_SNAPSHOT_EXPIRED", "AGENT_TIMELINE_EPOCH_MISMATCH",
        ]);
        const code = (allowed.has(candidate)
          ? candidate
          : "AGENT_TIMELINE_UNAVAILABLE") as LifecycleErrorCode;
        return lifecycleError(frame, context, code);
      }
    },
    handleUnavailableRequest(bytes, metadata, context) {
      if (kind === "chat") {
        const frame = decodeRelayAgentChatFrame(bytes, metadata).frame;
        return chatError(frame, context, "AGENT_CHAT_UNAVAILABLE");
      }
      const frame = decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata).frame;
      return lifecycleError(frame, context, "AGENT_TIMELINE_UNAVAILABLE");
    },
    isolateFailure() {
      authority.isolate(kind);
    },
    closeAndDrain() {
      return authority.closeAndDrain();
    },
    };
    return Object.freeze(result);
  };
  return Object.freeze([
    attachment("timeline", RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
    attachment("chat", RELAY_AGENT_CHAT_CAPABILITY),
  ]);
}
