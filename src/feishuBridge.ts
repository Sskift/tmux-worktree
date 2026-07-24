import { createHash, randomUUID } from "node:crypto";
import {
  CANONICAL_TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES,
  CanonicalTerminalControlError,
  type CanonicalAgentStatusResult,
  type CanonicalDrainRecord,
  type CanonicalHandoffResult,
  type CanonicalLeaseResult,
  type CanonicalAgentResultResult,
  type CanonicalTerminalControlClient,
  type CanonicalTerminalLease,
  type CanonicalTerminalOwner,
  type CanonicalTerminalOwnership,
} from "./canonicalTerminalControlClient.js";
import {
  FeishuBridgeStore,
  type FeishuActivityWatch,
  type FeishuBinding,
  type FeishuHandoffRecord,
  type FeishuOutboundReply,
  type FeishuReplyMode,
  type FeishuTurn,
} from "./feishuBridgeStorage.js";
import {
  type FeishuInboundEvent,
  type FeishuLarkAdapter,
} from "./larkCliBridge.js";
import {
  buildFeishuBindingLifecycleCard,
  buildFeishuLocalTaskResultCard,
  buildFeishuReplyCard,
  type FeishuBindingLifecycleCardKind,
  type FeishuBindingRemovalOrigin,
} from "./feishuReplyCard.js";

const TURN_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_TURN_OUTPUT_BYTES = 128 * 1024;
const MAX_REPLY_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const PROCESSING_REACTION_CACHE_SIZE = 1024;
const ACTIVITY_STOP_DEBOUNCE_MS = 1_000;
const ACTIVITY_POLL_INTERVAL_MS = 1_000;

interface BridgeState {
  bindings: FeishuBinding[];
  eventIds: string[];
  turns: FeishuTurn[];
  replies: FeishuOutboundReply[];
}

type PendingProcessingReaction =
  | { state: "unknown" }
  | { state: "created"; reactionId: string };

export interface CreateFeishuBindingInput {
  chatId: string;
  chatName: string;
  sessionName: string;
  createdBy: string;
  sessionSummary?: string;
  allowedSenderIds?: string[];
  mentionOnly?: boolean;
  replyMode?: FeishuReplyMode;
  dashboardLease?: CanonicalTerminalLease;
}

export interface FeishuBridgeSnapshot {
  instanceId: string;
  bindings: FeishuBinding[];
  activeTurns: FeishuTurn[];
  uncertainReplies: Array<Pick<
    FeishuOutboundReply,
    "id" | "turnId" | "status" | "completedAt" | "replyMessageId" | "error"
  >>;
  eventConsumer?: {
    state: "starting" | "running" | "backoff";
    updatedAt: string;
    error?: string;
  };
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const characters = [...value];
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const size = Buffer.byteLength(characters[start - 1], "utf8");
    if (bytes + size > maxBytes) break;
    start -= 1;
    bytes += size;
  }
  return characters.slice(start).join("");
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u0080-\uffff]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function feishuTurnMarkers(markerNonce: string): { open: string; close: string } {
  return {
    open: `[[notify-group:${markerNonce}]]`,
    close: `[[/notify-group:${markerNonce}]]`,
  };
}

export function extractFeishuMarkedReply(
  output: string,
  markerNonce: string,
): { reply?: string; complete: boolean } {
  const clean = sanitizeTerminalText(output);
  const markers = feishuTurnMarkers(markerNonce);
  const start = clean.indexOf(markers.open);
  if (start < 0) return { complete: false };
  const bodyStart = start + markers.open.length;
  const end = clean.indexOf(markers.close, bodyStart);
  const reply = boundedUtf8(clean.slice(bodyStart, end < 0 ? undefined : end).trim(), MAX_REPLY_BYTES);
  return { reply: reply || undefined, complete: end >= 0 };
}

function decodeUtf8Incrementally(
  previousRemainderBase64: string | undefined,
  chunk: Buffer,
): { text: string; remainderBase64?: string } {
  const previous = previousRemainderBase64
    ? Buffer.from(previousRemainderBase64, "base64")
    : Buffer.alloc(0);
  const combined = Buffer.concat([previous, chunk]);
  for (let remainderBytes = 0; remainderBytes <= Math.min(3, combined.byteLength); remainderBytes += 1) {
    const complete = combined.subarray(0, combined.byteLength - remainderBytes);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
      const remainder = combined.subarray(combined.byteLength - remainderBytes);
      return {
        text,
        ...(remainder.byteLength === 0 ? {} : { remainderBase64: remainder.toString("base64") }),
      };
    } catch {
      // A valid UTF-8 sequence can leave at most three bytes incomplete at a chunk boundary.
    }
  }
  return { text: combined.toString("utf8") };
}

function normalizedSenderType(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

class RenderedSnapshotCorrelationError extends Error {
  constructor() {
    super("terminal rendered snapshot correlation changed while polling a Feishu turn");
    this.name = "RenderedSnapshotCorrelationError";
  }
}

const FATAL_RENDERED_SNAPSHOT_CODES = new Set([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "TARGET_NOT_FOUND",
  "TARGET_GONE",
  "PERMISSION_DENIED",
  "HANDOFF_PENDING",
  "RECOVERY_REQUIRED",
  "STALE_OUTPUT_CURSOR",
  "OPERATION_IN_DOUBT",
]);

function retryableRenderedSnapshotObservation(error: unknown): boolean {
  if (error instanceof RenderedSnapshotCorrelationError) return false;
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; retryable?: unknown };
  if (typeof candidate.code === "string" && FATAL_RENDERED_SNAPSHOT_CODES.has(candidate.code)) {
    return false;
  }
  if (candidate.code === "RESOURCE_EXHAUSTED" || candidate.code === "INTERNAL") return true;
  if (candidate.code === "CONTROLLER_UNAVAILABLE") return candidate.retryable === true;
  // Socket timeouts/resets may not be normalized by the canonical client. The
  // snapshot is read-only, so an ordinary transport Error can wait for the
  // next fenced authority check instead of invalidating the binding now.
  return !(error instanceof CanonicalTerminalControlError);
}

export class FeishuBridge {
  readonly instanceId: string;
  private readonly control: CanonicalTerminalControlClient;
  private readonly lark: FeishuLarkAdapter;
  private readonly store: FeishuBridgeStore;
  private readonly now: () => number;
  private botOpenId?: string;
  private botMentionIds?: Set<string>;
  private readonly leases = new Map<string, CanonicalTerminalLease>();
  private readonly pendingProcessingReactions = new Map<string, PendingProcessingReaction>();
  private readonly activityPollAfter = new Map<string, number>();
  private readonly recoveryNoticeTurnIds = new Set<string>();
  private readonly recoveryNoticeActivityIds = new Set<string>();
  private readonly queuedOutboundAttemptIds = new Set<string>();
  private lastActivityPolledBindingId?: string;
  private eventConsumer: NonNullable<FeishuBridgeSnapshot["eventConsumer"]>;
  private state: BridgeState;
  private mutation = Promise.resolve();
  private reactionMutation = Promise.resolve();
  private lifecycleMutation = Promise.resolve();
  private activityCompletionMutation = Promise.resolve();
  private outboundMutation = Promise.resolve();

  constructor(options: {
    control: CanonicalTerminalControlClient;
    lark: FeishuLarkAdapter;
    store?: FeishuBridgeStore;
    instanceId?: string;
    now?: () => number;
    botOpenId?: string;
  }) {
    this.control = options.control;
    this.lark = options.lark;
    this.store = options.store ?? new FeishuBridgeStore();
    this.instanceId = options.instanceId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.botOpenId = options.botOpenId;
    this.state = this.store.read();
    for (const turn of this.state.turns) {
      if (turn.status === "recovery-required") this.recoveryNoticeTurnIds.add(turn.id);
    }
    for (const binding of this.state.bindings) {
      const watch = binding.activityWatch;
      if (watch?.status === "uncertain" || watch?.status === "recovery-required") {
        this.recoveryNoticeActivityIds.add(watch.id);
      }
    }
    this.eventConsumer = {
      state: "starting",
      updatedAt: nowIso(this.now),
    };
  }

  setEventConsumerHealth(
    state: "starting" | "running" | "backoff",
    error?: string,
  ): void {
    this.eventConsumer = {
      state,
      updatedAt: nowIso(this.now),
      ...(error ? { error: boundedUtf8(error, 4096) } : {}),
    };
  }

  initializeAfterRestart(): void {
    let changed = false;
    for (const binding of this.state.bindings) {
      if (!binding.options.replyAsCard) {
        binding.options.replyAsCard = true;
        changed = true;
      }
      if (binding.status === "active" || binding.status === "pausing") {
        binding.status = "stale";
        binding.staleReason = "bridge restarted; ownership was not recreated automatically";
        changed = true;
      }
      if (binding.activityWatch?.status === "sending") {
        binding.activityWatch.status = "uncertain";
        binding.activityWatch.completedAt = nowIso(this.now);
        binding.activityWatch.error = "bridge restarted while the completion card disposition was unknown";
        changed = true;
      }
    }
    for (const turn of this.state.turns) {
      const durablePreparedReply = turn.status === "replying"
        ? this.state.replies.find((reply) =>
          reply.id === turn.outboundAttemptId
          && reply.status === "prepared"
          && this.hasDurableOutboundPayload(reply))
        : undefined;
      if ((turn.status === "prepared" || turn.status === "awaiting" || turn.status === "replying")
        && !durablePreparedReply) {
        turn.status = "recovery-required";
        turn.error = "bridge continuity was lost before the turn completed";
        turn.completedAt = nowIso(this.now);
        changed = true;
      }
    }
    for (const reply of this.state.replies) {
      if (reply.status === "prepared" && !this.hasDurableOutboundPayload(reply)) {
        reply.status = "uncertain";
        reply.completedAt = nowIso(this.now);
        reply.error = "legacy prepared reply omitted the durable payload required for recovery";
        changed = true;
      }
    }
    if (changed) this.persist();
    else this.queuePreparedOutboundAttempts();
  }

  snapshot(): FeishuBridgeSnapshot {
    return {
      instanceId: this.instanceId,
      bindings: structuredClone(this.state.bindings),
      activeTurns: structuredClone(this.state.turns.filter((turn) =>
        turn.status === "prepared" || turn.status === "awaiting" || turn.status === "replying")),
      uncertainReplies: this.state.replies
        .filter((reply) => reply.status === "uncertain")
        .map((reply) => ({
          id: reply.id,
          turnId: reply.turnId,
          status: reply.status,
          ...(reply.completedAt ? { completedAt: reply.completedAt } : {}),
          ...(reply.replyMessageId ? { replyMessageId: reply.replyMessageId } : {}),
          ...(reply.error ? { error: reply.error } : {}),
        })),
      eventConsumer: structuredClone(this.eventConsumer),
    };
  }

  createBinding(input: CreateFeishuBindingInput): Promise<FeishuBinding> {
    return this.serial(async () => {
      if (input.mentionOnly !== false) await this.ensureBotOpenId();
      this.validateCreateInput(input);
      if (this.state.bindings.some((binding) => binding.chatId === input.chatId)) {
        throw new Error("this Feishu chat already has a binding");
      }
      await this.requireBindingCapabilities();
      const target = await this.control.resolveTarget(input.sessionName);
      if (this.state.bindings.some((binding) =>
        binding.controlTargetId === target.controlTargetId && binding.status !== "stale")) {
        throw new Error("this terminal already has a Feishu binding");
      }
      const id = `bind-${randomUUID()}`;
      const createdAt = nowIso(this.now);
      // An explicitly empty list is the Dashboard's group-wide policy. Keep
      // the legacy omitted-field fallback for older CLI callers that used
      // createdBy as their single allowed sender.
      const allowedSenderIds = [...new Set(input.allowedSenderIds ?? [input.createdBy])];
      const binding: FeishuBinding = {
        version: 1,
        id,
        chatId: input.chatId,
        chatName: input.chatName,
        controlTargetId: target.controlTargetId,
        sessionName: target.managedSession.name,
        status: input.dashboardLease ? "pausing" : "active",
        options: {
          mentionOnly: input.mentionOnly !== false,
          replyAsCard: true,
          includeQuotedContext: false,
          replyMode: input.replyMode ?? "topic",
        },
        allowedSenderIds,
        createdAt,
        createdBy: input.createdBy,
        ...(input.sessionSummary?.trim() ? { sessionSummary: input.sessionSummary.trim() } : {}),
        lastActivityAt: createdAt,
      };
      const feishuOwner = this.feishuOwner(id);
      let lease: CanonicalTerminalLease;
      if (input.dashboardLease) {
        const dashboardLease = input.dashboardLease;
        if (dashboardLease.controlTargetId !== target.controlTargetId
          || dashboardLease.controlEpoch !== target.controlEpoch
          || dashboardLease.fence !== target.ownership.fence
          || dashboardLease.owner.kind !== "dashboard"
          || target.ownership.state !== "HELD"
          || !target.ownership.ownerKind
          || target.ownership.ownerKind === "feishu") {
          throw new Error("Dashboard no longer has a valid interactive lease for the selected terminal");
        }
        this.state.bindings.push(binding);
        try {
          this.persist();
        } catch (error) {
          this.state.bindings = this.state.bindings.filter((candidate) => candidate.id !== id);
          throw error;
        }
        try {
          const draining = await this.control.beginHandoff(
            target.controlTargetId,
            feishuOwner,
            dashboardLease,
          );
          const handoffId = draining.ownership.handoffId;
          if (!handoffId) throw new Error("terminal controller omitted handoff identity");
          const drain: CanonicalDrainRecord = {
            disposition: "drained",
            recordId: `binding:${id}:dashboard-drained`,
            recordedAt: nowIso(this.now),
          };
          binding.handoff = this.preparedHandoffRecord(
            handoffId,
            dashboardLease,
            "feishu",
            "next",
            drain,
          );
          try {
            this.persist();
          } catch (error) {
            await this.bestEffortAbortHandoff(
              "next",
              handoffId,
              dashboardLease,
              feishuOwner,
            );
            throw error;
          }
          lease = this.requireGrantedLease(
            await this.control.commitHandoff(handoffId, dashboardLease, drain),
            target.controlTargetId,
            feishuOwner,
          );
          binding.handoff.status = "committed";
          binding.handoff.completedAt = nowIso(this.now);
        } catch (error) {
          this.markPreparedHandoffUncertain(binding, error);
          this.markBindingStale(binding, `binding handoff requires inspection: ${error instanceof Error ? error.message : String(error)}`);
          this.persist();
          throw error;
        }
        binding.status = "active";
        binding.lastActivityAt = nowIso(this.now);
        this.leases.set(id, lease);
        this.persist();
      } else {
        lease = this.requireGrantedLease(
          await this.control.acquireLease(target.controlTargetId, feishuOwner),
          target.controlTargetId,
          feishuOwner,
        );
        this.leases.set(id, lease);
        this.state.bindings.push(binding);
        try {
          this.persist();
        } catch (error) {
          this.leases.delete(id);
          await this.bestEffortReleaseLease(lease);
          throw error;
        }
      }
      await this.activateActivityWatchOrStale(binding, lease, "binding activation");
      this.persist();
      this.queueBindingLifecycle(binding, "linked", {
        sessionKind: target.managedSession.kind,
        sessionSummary: input.sessionSummary?.trim(),
      });
      return structuredClone(binding);
    });
  }

  updateBinding(bindingId: string, replyMode: FeishuReplyMode): Promise<FeishuBinding> {
    return this.serial(async () => {
      if (replyMode !== "topic" && replyMode !== "direct") {
        throw new Error("invalid Feishu reply mode");
      }
      const binding = this.requireBinding(bindingId);
      if (this.activeTurn(binding.id)) {
        throw new Error("binding has an active Feishu turn; wait for it to finish before changing reply mode");
      }
      const previousReplyMode = binding.options.replyMode;
      binding.options.replyMode = replyMode;
      try {
        this.persist();
      } catch (error) {
        binding.options.replyMode = previousReplyMode;
        throw error;
      }
      return structuredClone(binding);
    });
  }

  pauseBinding(bindingId: string, force = false): Promise<FeishuBinding> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      const turn = this.activeTurn(binding.id);
      const watch = this.activeActivityWatch(binding);
      if (turn?.status === "replying") {
        throw new Error("the Feishu reply card is being delivered; wait for its disposition before pausing");
      }
      if (watch?.status === "sending") {
        throw new Error("the local Agent completion card is being delivered; wait for its disposition before pausing");
      }
      if ((turn || watch) && !force) {
        throw new Error("binding has active Agent work; force is required to cancel it");
      }
      if (turn) {
        turn.status = "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = "cancelled by explicit force pause";
      }
      if (watch) this.cancelActivityWatch(binding, "cancelled by explicit force pause");
      binding.status = "pausing";
      this.persist();
      const lease = this.leases.get(binding.id);
      if (lease) {
        try {
          await this.releaseLease(lease);
        } catch (error) {
          this.leases.delete(binding.id);
          this.markBindingStale(binding, `lease release disposition is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          this.persist();
          if (turn) this.queueProcessingReactionSettlement(turn.messageId, "cancelled");
          throw error;
        }
      }
      this.leases.delete(binding.id);
      binding.status = "paused";
      delete binding.staleReason;
      binding.lastActivityAt = nowIso(this.now);
      this.persist();
      if (turn) this.queueProcessingReactionSettlement(turn.messageId, "cancelled");
      return structuredClone(binding);
    });
  }

  resumeBinding(bindingId: string): Promise<FeishuBinding> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      if (this.activeTurn(binding.id)) throw new Error("binding still has an unresolved turn");
      await this.requireBindingCapabilities();
      const target = await this.control.resolveTarget(binding.sessionName);
      if (target.controlTargetId !== binding.controlTargetId) {
        binding.status = "stale";
        binding.staleReason = "the exact terminal lifecycle no longer exists";
        this.persist();
        throw new Error(binding.staleReason);
      }
      const owner = this.feishuOwner(binding.id);
      const lease = this.requireGrantedLease(
        await this.control.acquireLease(binding.controlTargetId, owner),
        binding.controlTargetId,
        owner,
      );
      this.leases.set(binding.id, lease);
      binding.status = "active";
      delete binding.staleReason;
      binding.lastActivityAt = nowIso(this.now);
      await this.activateActivityWatchOrStale(binding, lease, "binding resume");
      this.persist();
      return structuredClone(binding);
    });
  }

  repairBinding(bindingId: string): Promise<FeishuBinding> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      if (binding.status !== "stale") throw new Error("only a stale binding requires repair");
      const exact = await this.control.resolveTarget(binding.sessionName);
      if (exact.controlTargetId !== binding.controlTargetId) {
        throw new Error("the bound terminal lifecycle is gone; unbind and select the replacement explicitly");
      }
      const target = await this.control.ownershipStatus(binding.controlTargetId);
      const owner = this.feishuOwner(binding.id);
      let lease: CanonicalTerminalLease;
      if (target.state === "RECOVERY_REQUIRED") {
        binding.staleReason = "terminal recovery requires a controlled local owner; recover locally, then use Return to Feishu";
        binding.lastActivityAt = nowIso(this.now);
        this.persist();
        return structuredClone(binding);
      } else if (target.state === "FREE") {
        await this.requireBindingCapabilities();
        lease = this.requireGrantedLease(
          await this.control.acquireLease(binding.controlTargetId, owner),
          binding.controlTargetId,
          owner,
        );
      } else {
        binding.staleReason = target.ownerKind === "dashboard" || target.ownerKind === "local-cli"
          ? "a controlled local owner now holds the terminal; use Return to Feishu with its canonical lease"
          : "terminal ownership is not recoverable by Feishu; complete local recovery before returning it";
        binding.lastActivityAt = nowIso(this.now);
        this.persist();
        return structuredClone(binding);
      }
      this.leases.set(binding.id, lease);
      binding.status = "active";
      delete binding.staleReason;
      binding.lastActivityAt = nowIso(this.now);
      await this.activateActivityWatchOrStale(binding, lease, "binding repair");
      this.persist();
      return structuredClone(binding);
    });
  }

  removeBinding(
    bindingId: string,
    force = false,
    removalOrigin: FeishuBindingRemovalOrigin = "unknown-local-client",
  ): Promise<void> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      const turn = this.activeTurn(binding.id);
      const watch = this.activeActivityWatch(binding);
      if (turn?.status === "replying") {
        throw new Error("the Feishu reply card is being delivered; wait for its disposition before unlinking");
      }
      if (watch?.status === "sending") {
        throw new Error("the local Agent completion card is being delivered; wait for its disposition before unlinking");
      }
      if ((turn || watch) && !force) {
        throw new Error("binding has active Agent work; force is required to unbind");
      }
      if (turn) {
        turn.status = "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = "cancelled by explicit unbind";
      }
      if (watch) this.cancelActivityWatch(binding, "cancelled by explicit unbind");
      const lease = this.leases.get(binding.id);
      if (lease) {
        try {
          await this.releaseLease(lease);
        } catch (error) {
          this.leases.delete(binding.id);
          this.markBindingStale(binding, `unbind release disposition is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          this.persist();
          if (turn) this.queueProcessingReactionSettlement(turn.messageId, "cancelled");
          throw error;
        }
      } else {
        await this.assertUnleasedBindingCanBeRemoved(binding);
      }
      this.leases.delete(binding.id);
      this.state.bindings = this.state.bindings.filter((candidate) => candidate.id !== bindingId);
      this.persist();
      if (turn) this.queueProcessingReactionSettlement(turn.messageId, "cancelled");
      this.queueBindingLifecycle(binding, "manual-unlink", { removalOrigin });
    });
  }

  takeoverBinding(
    bindingId: string,
    dashboardOwnerInstance: string,
    force = false,
  ): Promise<CanonicalTerminalLease> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      const lease = this.leases.get(binding.id);
      if (!lease || binding.status !== "active") {
        throw new Error("Feishu binding does not hold a transferable lease");
      }
      const turn = this.activeTurn(binding.id);
      const watch = this.activeActivityWatch(binding);
      if (turn?.status === "replying") {
        throw new Error("the Feishu reply card is being delivered; wait for its disposition before takeover");
      }
      if (watch?.status === "sending") {
        throw new Error("the local Agent completion card is being delivered; wait for its disposition before takeover");
      }
      if (turn && !force) {
        throw new Error("a Feishu turn is active; wait for its certain reply or choose force takeover");
      }
      if (watch && !force) {
        throw new Error("a bound local Agent task is active; wait for completion or choose force takeover");
      }
      if (turn) {
        turn.status = "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = "cancelled before explicit force takeover";
      }
      if (watch) this.cancelActivityWatch(binding, "cancelled before explicit force takeover");
      binding.status = "pausing";
      binding.lastActivityAt = nowIso(this.now);
      this.persist();
      try {
        const dashboardOwner: CanonicalTerminalOwner = {
          kind: "dashboard",
          instanceId: dashboardOwnerInstance,
        };
        const draining = await this.control.beginHandoff(
          binding.controlTargetId,
          dashboardOwner,
          lease,
        );
        const handoffId = draining.ownership.handoffId;
        if (!handoffId) throw new Error("terminal controller omitted handoff identity");
        const drain: CanonicalDrainRecord = {
          disposition: force ? "cancelled" : "drained",
          recordId: force && turn
            ? `feishu-turn:${turn.id}:cancelled`
            : force && watch
              ? `activity-watch:${watch.id}:cancelled`
            : `binding:${binding.id}:feishu-drained`,
          recordedAt: turn?.completedAt ?? nowIso(this.now),
        };
        binding.handoff = this.preparedHandoffRecord(
          handoffId,
          lease,
          "dashboard",
          "current",
          drain,
        );
        try {
          this.persist();
        } catch (error) {
          await this.bestEffortAbortHandoff("current", handoffId, lease, dashboardOwner);
          throw error;
        }
        const dashboardLease = this.requireGrantedLease(
          await this.control.commitHandoff(handoffId, lease, drain),
          binding.controlTargetId,
          dashboardOwner,
        );
        binding.handoff.status = "committed";
        binding.handoff.completedAt = nowIso(this.now);
        this.leases.delete(binding.id);
        binding.status = "paused";
        delete binding.staleReason;
        binding.lastActivityAt = nowIso(this.now);
        this.persist();
        return dashboardLease;
      } catch (error) {
        this.markPreparedHandoffUncertain(binding, error);
        this.leases.delete(binding.id);
        this.markBindingStale(binding, `takeover disposition requires inspection: ${error instanceof Error ? error.message : String(error)}`);
        this.persist();
        throw error;
      } finally {
        if (turn) this.queueProcessingReactionSettlement(turn.messageId, "cancelled");
      }
    });
  }

  returnBinding(
    bindingId: string,
    dashboardLease: CanonicalTerminalLease,
  ): Promise<FeishuBinding> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      if (binding.status !== "paused" && binding.status !== "stale") {
        throw new Error("only a paused or locally recovered stale binding can return to Feishu");
      }
      if (dashboardLease.controlTargetId !== binding.controlTargetId) {
        throw new Error("Dashboard lease targets a different terminal");
      }
      const target = await this.control.ownershipStatus(binding.controlTargetId);
      if (target.controlEpoch !== dashboardLease.controlEpoch
        || target.fence !== dashboardLease.fence
        || target.state !== "HELD"
        || (dashboardLease.owner.kind !== "dashboard" && dashboardLease.owner.kind !== "local-cli")
        || target.ownerKind !== dashboardLease.owner.kind) {
        throw new Error("the controlled local owner no longer owns the exact binding target");
      }
      await this.requireBindingCapabilities();
      try {
        const feishuOwner = this.feishuOwner(binding.id);
        const draining = await this.control.beginHandoff(
          binding.controlTargetId,
          feishuOwner,
          dashboardLease,
        );
        const handoffId = draining.ownership.handoffId;
        if (!handoffId) throw new Error("terminal controller omitted handoff identity");
        const drain: CanonicalDrainRecord = {
          disposition: "drained",
          recordId: `binding:${binding.id}:dashboard-return-drained`,
          recordedAt: nowIso(this.now),
        };
        binding.handoff = this.preparedHandoffRecord(
          handoffId,
          dashboardLease,
          "feishu",
          "next",
          drain,
        );
        try {
          this.persist();
        } catch (error) {
          await this.bestEffortAbortHandoff(
            "next",
            handoffId,
            dashboardLease,
            feishuOwner,
          );
          throw error;
        }
        const feishuLease = this.requireGrantedLease(
          await this.control.commitHandoff(handoffId, dashboardLease, drain),
          binding.controlTargetId,
          feishuOwner,
        );
        binding.handoff.status = "committed";
        binding.handoff.completedAt = nowIso(this.now);
        this.leases.set(binding.id, feishuLease);
        binding.status = "active";
        delete binding.staleReason;
        binding.lastActivityAt = nowIso(this.now);
        await this.activateActivityWatchOrStale(binding, feishuLease, "binding return");
        this.persist();
        return structuredClone(binding);
      } catch (error) {
        this.markPreparedHandoffUncertain(binding, error);
        this.markBindingStale(binding, `return disposition requires inspection: ${error instanceof Error ? error.message : String(error)}`);
        this.persist();
        throw error;
      }
    });
  }

  handleEvent(event: FeishuInboundEvent): Promise<void> {
    return this.serial(async () => {
      if (this.state.eventIds.includes(event.event_id)) return;
      const binding = this.state.bindings.find((candidate) => candidate.chatId === event.chat_id);
      if (!binding || binding.status !== "active" || event.chat_type !== "group") return;
      if (event.message_type !== "text" && event.message_type !== "post") return;

      const detail = await this.lark.messageDetail(event.message_id);
      if (binding.options.mentionOnly) await this.ensureBotOpenId();
      const senderId = detail.senderId || event.sender_id;
      const senderType = normalizedSenderType(detail.senderType);
      if ((senderType && senderType !== "user")
        || senderId === this.botOpenId
        || (binding.allowedSenderIds.length > 0 && !binding.allowedSenderIds.includes(senderId))) {
        this.rememberEvent(event.event_id);
        return;
      }
      if (binding.options.mentionOnly
        && !detail.mentionedIds.some((id) => this.botMentionIds!.has(id))) {
        this.rememberEvent(event.event_id);
        return;
      }
      const lease = this.leases.get(binding.id);
      if (!lease) {
        this.markBindingStale(binding, "active binding has no live bridge ownership lease");
        this.rememberEvent(event.event_id);
        return;
      }
      const activityWatch = this.activeActivityWatch(binding);
      if (activityWatch?.status === "sending") {
        this.rememberEvent(event.event_id);
        await this.safeInform(
          binding,
          event.message_id,
          "当前 Agent 的完成通知正在发送，本条消息未注入终端；请在通知送达后重试。",
          `activity-sending-${event.event_id}`,
        );
        return;
      }

      await this.requireRenderedSnapshotCapability();
      const target = await this.control.ownershipStatus(binding.controlTargetId);
      if (this.isFeishuDrainingView(binding, lease, target)) {
        this.rememberEvent(event.event_id);
        await this.safeInform(
          binding,
          event.message_id,
          "当前终端正在安全交接给本地控制端，本条消息未注入终端。",
          `handoff-${event.event_id}`,
        );
        await this.reconcileBindingHandoff(binding, lease);
        return;
      }
      this.assertLeaseView(binding, lease, target);
      const activeTurn = this.activeTurn(binding.id);
      if (activeTurn) {
        await this.steerActiveTurn(
          binding,
          lease,
          target,
          activeTurn,
          event.event_id,
          event.message_id,
          senderId,
          detail.text || event.content,
        );
        return;
      }
      const turnId = `turn-${digest(`${binding.id}:${event.event_id}`).slice(0, 32)}`;
      const operationId = `feishu-turn-${digest(turnId).slice(0, 32)}`;
      const markerNonce = randomUUID().replaceAll("-", "");
      const turn: FeishuTurn = {
        id: turnId,
        bindingId: binding.id,
        chatId: binding.chatId,
        eventId: event.event_id,
        messageId: event.message_id,
        senderId,
        status: "prepared",
        controlTargetId: binding.controlTargetId,
        controlEpoch: target.controlEpoch,
        leaseId: lease.leaseId,
        fence: lease.fence,
        markerNonce,
        output: "",
        operationId,
        outboundAttemptId: `reply-${digest(turnId).slice(0, 32)}`,
        createdAt: nowIso(this.now),
        deadlineAt: new Date(this.now() + TURN_IDLE_TIMEOUT_MS).toISOString(),
      };
      this.state.turns.push(turn);
      this.rememberEvent(event.event_id, false);
      this.persist();
      const text = this.formatPrompt(
        binding,
        markerNonce,
        senderId,
        detail.text || event.content,
        "start-or-steer",
      );
      try {
        const accepted = await this.control.sendAgentMessage({
          lease,
          operationId,
          pane: "0",
          message: text,
          submit: true,
        });
        if (accepted.operationId !== operationId
          || accepted.controlEpoch !== lease.controlEpoch
          || accepted.fence !== lease.fence) {
          const error = new Error("terminal input output correlation was fenced before the Feishu turn started");
          Object.assign(error, { code: "RECOVERY_REQUIRED" });
          throw error;
        }
        turn.controlEpoch = accepted.controlEpoch;
        turn.fence = accepted.fence;
        turn.outputGeneration = accepted.outputGeneration;
        turn.cursor = accepted.outputCursor;
      } catch (error) {
        if (hasCode(error, "HANDOFF_PENDING")) {
          turn.status = "cancelled";
          turn.completedAt = nowIso(this.now);
          turn.error = "terminal input was not accepted because a controlled local handoff started first";
          this.persist();
          await this.reconcileBindingHandoff(binding, lease, {
            disposition: "cancelled",
            recordId: `feishu-turn:${turn.id}:cancelled-before-input`,
            recordedAt: turn.completedAt,
          });
          return;
        }
        turn.status = this.controlContinuityLost(error) ? "recovery-required" : "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = error instanceof Error ? error.message : String(error);
        if (turn.status === "recovery-required") this.markBindingStale(binding, turn.error);
        this.persist();
        throw error;
      }
      if (activityWatch && this.activeActivityWatch(binding)?.id === activityWatch.id) {
        this.cancelActivityWatch(
          binding,
          "the inherited local task was converted into a marker-correlated Feishu steering turn",
        );
      }
      turn.status = "awaiting";
      binding.lastActivityAt = nowIso(this.now);
      this.persist();
      this.queueProcessingReactionStart(turn.messageId);
    });
  }

  renewLeases(): Promise<void> {
    return this.serial(async () => {
      let changed = false;
      const failedTurnMessageIds: string[] = [];
      for (const [bindingId, lease] of [...this.leases]) {
        const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
        if (!binding || binding.status !== "active") continue;
        try {
          const result = await this.control.renewLease(lease);
          const renewed = this.requireGrantedLease(
            result,
            lease.controlTargetId,
            lease.owner,
            ["HELD", "DRAINING"],
          );
          if (renewed.controlEpoch !== lease.controlEpoch
            || renewed.leaseId !== lease.leaseId
            || renewed.fence !== lease.fence) {
            throw new Error("canonical lease renewal changed terminal ownership identity");
          }
          this.leases.set(bindingId, renewed);
        } catch (error) {
          this.leases.delete(bindingId);
          this.markBindingStale(binding, error instanceof Error ? error.message : String(error));
          const turn = this.activeTurn(bindingId);
          const watch = this.activeActivityWatch(binding);
          if (turn) {
            turn.status = "recovery-required";
            turn.completedAt = nowIso(this.now);
            turn.error = "terminal ownership lease renewal failed";
            failedTurnMessageIds.push(turn.messageId);
          }
          if (watch) {
            watch.status = "recovery-required";
            watch.completedAt = nowIso(this.now);
            watch.error = "terminal ownership lease renewal failed";
            this.activityPollAfter.delete(watch.id);
          }
          changed = true;
        }
      }
      if (changed) this.persist();
      for (const messageId of failedTurnMessageIds) {
        this.queueProcessingReactionSettlement(messageId, "failure");
      }
    });
  }

  /**
   * Reconcile every persisted binding against its exact canonical target.
   * This includes paused/stale bindings, which have no lease to renew. Only a
   * certain ended/replaced lifecycle removes a binding; recovery and transport
   * failures remain fail-closed for local inspection.
   */
  reconcileBindingTargets(): Promise<void> {
    return this.serial(async () => {
      for (const candidate of [...this.state.bindings]) {
        const binding = this.state.bindings.find((item) => item.id === candidate.id);
        if (!binding) continue;
        let exactTargetEnded = false;
        try {
          const ownership = await this.control.ownershipStatus(binding.controlTargetId);
          exactTargetEnded = ownership.state === "TARGET_GONE";
        } catch (error) {
          if (hasCode(error, "TARGET_GONE")) exactTargetEnded = true;
        }

        const reason = await this.bindingLifecycleEndReason(binding, exactTargetEnded);
        if (!reason) continue;
        await this.invalidateBinding(binding, reason);
      }
    });
  }

  async pollTurns(): Promise<void> {
    await this.serial(async () => {
      const turns = this.state.turns.filter((turn) => turn.status === "awaiting");
      for (const turn of turns) await this.pollTurn(turn);
      const bindings = this.state.bindings.filter((binding) =>
        binding.status === "active" && this.activeActivityWatch(binding));
      if (bindings.length > 0) {
        const previousIndex = this.lastActivityPolledBindingId
          ? bindings.findIndex((binding) => binding.id === this.lastActivityPolledBindingId)
          : -1;
        const binding = bindings[(previousIndex + 1) % bindings.length];
        this.lastActivityPolledBindingId = binding.id;
        await this.pollActivityWatch(binding);
      }
    });
    // Completion delivery has its own lane so a slow Feishu API cannot hold
    // terminal ownership mutations or lease renewal. Callers may still await
    // the observable completion result without occupying that lane.
    await Promise.all([this.activityCompletionMutation, this.drainOutboundEffects()]);
  }

  reconcileHandoffs(): Promise<void> {
    return this.serial(async () => {
      for (const [bindingId, lease] of [...this.leases]) {
        const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
        if (!binding || (binding.status !== "active" && binding.status !== "pausing")) continue;
        await this.reconcileBindingHandoff(binding, lease);
      }
    });
  }

  async close(): Promise<void> {
    // Let a completion Card that already crossed the outbound boundary settle
    // before releasing authority. A crash still recovers persisted `sending`
    // as uncertain, but a clean shutdown does not manufacture that ambiguity.
    await Promise.all([this.activityCompletionMutation, this.drainOutboundEffects()]);
    await this.serial(async () => {
      const failedTurnMessageIds: string[] = [];
      for (const [bindingId, lease] of [...this.leases]) {
        const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
        const turn = binding ? this.activeTurn(binding.id) : undefined;
        if (turn) {
          turn.status = "recovery-required";
          turn.completedAt = nowIso(this.now);
          turn.error = "bridge stopped before the terminal turn reached a certain disposition";
          if (binding) this.markBindingStale(binding, turn.error);
          failedTurnMessageIds.push(turn.messageId);
          continue;
        }
        if (binding?.status === "stale") {
          // Keep the old lease fenced until canonical TTL recovery; FREE would permit competing input.
          continue;
        }
        try {
          await this.releaseLease(lease);
          if (binding) binding.status = "paused";
        } catch (error) {
          if (binding) {
            this.markBindingStale(binding, `shutdown release disposition is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (binding) binding.lastActivityAt = nowIso(this.now);
      }
      this.leases.clear();
      this.persist();
      for (const messageId of failedTurnMessageIds) {
        this.queueProcessingReactionSettlement(messageId, "failure");
      }
    });
    // Terminal authority is already persisted/released above. Drain the
    // independent best-effort UX lanes before a clean shutdown reports done so
    // known reactions and lifecycle notices are not abandoned merely because
    // the daemon stopped.
    await Promise.all([
      this.reactionMutation,
      this.lifecycleMutation,
      this.activityCompletionMutation,
      this.drainOutboundEffects(),
    ]);
  }

  private async pollTurn(turn: FeishuTurn): Promise<void> {
    const binding = this.state.bindings.find((candidate) => candidate.id === turn.bindingId);
    const lease = this.leases.get(turn.bindingId);
    if (!binding || binding.status !== "active" || !lease) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "binding ownership disappeared while awaiting output";
      this.persist();
      this.queueProcessingReactionSettlement(turn.messageId, "failure");
      return;
    }
    try {
      if (turn.outputGeneration === undefined || turn.cursor === undefined) {
        throw new Error("Feishu turn has no committed terminal output correlation");
      }
      const target = await this.control.ownershipStatus(turn.controlTargetId);
      this.assertTurnAuthority(turn, lease, target);
      let chunk;
      try {
        chunk = await this.control.tailOutput({
          controlTargetId: turn.controlTargetId,
          controlEpoch: turn.controlEpoch,
          outputGeneration: turn.outputGeneration,
          cursor: turn.cursor,
          maxBytes: OUTPUT_TAIL_BYTES,
        });
      } catch (error) {
        if (!hasCode(error, "STALE_OUTPUT_CURSOR")) throw error;
        const latest = await this.control.ownershipStatus(turn.controlTargetId);
        this.assertTurnAuthority(turn, lease, latest);
        const retainedCursor = Math.max(
          0,
          latest.outputCursor - CANONICAL_TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES,
        );
        if (retainedCursor <= turn.cursor) throw error;
        // A fast command can emit more than the bounded correlation window
        // between Bridge polls. The current authority view proves the same
        // Feishu lease/generation, so resume at the minimum guaranteed
        // retained cursor and rebuild only the read-only marker parser. Input
        // is never replayed, and generation/fence staleness still fails closed.
        turn.cursor = retainedCursor;
        turn.output = "";
        delete turn.outputRemainderBase64;
        delete turn.markerSeenAt;
        const observedAt = this.now();
        turn.lastOutputAt = new Date(observedAt).toISOString();
        turn.deadlineAt = new Date(observedAt + TURN_IDLE_TIMEOUT_MS).toISOString();
        this.persist();
        return;
      }
      if (chunk.controlEpoch !== turn.controlEpoch
        || chunk.controlTargetId !== turn.controlTargetId
        || chunk.fence !== turn.fence
        || chunk.ownerKind !== "feishu"
        || chunk.outputGeneration !== turn.outputGeneration
        || chunk.cursor !== turn.cursor) {
        throw new Error("terminal output correlation changed while polling a Feishu turn");
      }
      const raw = Buffer.from(chunk.dataBase64, "base64");
      if (raw.byteLength > 0) {
        const decoded = decodeUtf8Incrementally(turn.outputRemainderBase64, raw);
        const observedAt = this.now();
        turn.cursor = chunk.nextCursor;
        turn.output = boundedUtf8Tail(`${turn.output}${decoded.text}`, MAX_TURN_OUTPUT_BYTES);
        if (decoded.remainderBase64) turn.outputRemainderBase64 = decoded.remainderBase64;
        else delete turn.outputRemainderBase64;
        turn.lastOutputAt = new Date(observedAt).toISOString();
        turn.deadlineAt = new Date(observedAt + TURN_IDLE_TIMEOUT_MS).toISOString();
        this.persist();
      }
    } catch (error) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = error instanceof Error ? error.message : String(error);
      this.markBindingStale(binding, turn.error);
      this.persist();
      this.queueProcessingReactionSettlement(turn.messageId, "failure");
      return;
    }
    // deadlineAt is an inactivity deadline, not a wall-clock budget for the
    // whole Agent run. Always perform one final fenced output observation
    // first: output that arrives at the old boundary proves the same turn is
    // still making progress and slides the deadline without replaying input.
    if (this.now() >= Date.parse(turn.deadlineAt)) {
      await this.completeReply(
        turn,
        binding,
        "终端已连续 10 分钟没有新输出，且尚未形成完整回复；本轮状态不确定，需要在本地恢复后才能继续。",
        "timed-out",
      );
      if (turn.status === "timed-out") {
        this.leases.delete(binding.id);
        this.markBindingStale(binding, "terminal turn was idle for 10 minutes without a certain drain disposition");
        this.persist();
      }
      return;
    }
    if (!turn.markerNonce) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "Feishu turn has no persisted marker correlation";
      this.markBindingStale(binding, turn.error);
      this.persist();
      this.queueProcessingReactionSettlement(turn.messageId, "failure");
      return;
    }
    const rawMarked = extractFeishuMarkedReply(turn.output, turn.markerNonce);
    if (rawMarked.complete && !turn.markerSeenAt) {
      turn.markerSeenAt = nowIso(this.now);
      this.persist();
    }
    // markerSeenAt is a persisted closed-marker latch. It keeps snapshot
    // retries alive across later polls if TUI repaint bytes push the raw
    // opening marker out of the bounded parser tail.
    if (!rawMarked.complete && !turn.markerSeenAt) return;

    let renderedMarked: ReturnType<typeof extractFeishuMarkedReply>;
    try {
      const snapshot = await this.control.renderedSnapshot({
        lease,
        outputGeneration: turn.outputGeneration,
        pane: "0",
        maxBytes: MAX_TURN_OUTPUT_BYTES,
      });
      if (snapshot.controlTargetId !== turn.controlTargetId
        || snapshot.controlEpoch !== turn.controlEpoch
        || snapshot.leaseId !== turn.leaseId
        || snapshot.fence !== turn.fence
        || snapshot.ownerKind !== "feishu"
        || snapshot.outputGeneration !== turn.outputGeneration
        || snapshot.pane !== "0") {
        throw new RenderedSnapshotCorrelationError();
      }
      renderedMarked = extractFeishuMarkedReply(
        Buffer.from(snapshot.dataBase64, "base64").toString("utf8"),
        turn.markerNonce,
      );
    } catch (error) {
      if (retryableRenderedSnapshotObservation(error)) return;
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = error instanceof Error ? error.message : String(error);
      this.markBindingStale(binding, turn.error);
      this.persist();
      this.queueProcessingReactionSettlement(turn.messageId, "failure");
      return;
    }
    // Raw pipe-pane bytes prove only that the nonce reached the terminal. A
    // fullscreen TUI may repaint its composer and footer between those raw
    // markers, so only tmux's fenced rendered view is allowed to become public
    // card content. A transiently incomplete snapshot is retried on the next
    // poll and never falls back to the raw byte stream.
    if (!renderedMarked.reply || !renderedMarked.complete) return;
    await this.completeReply(turn, binding, renderedMarked.reply, "completed");
  }

  private async pollActivityWatch(binding: FeishuBinding): Promise<void> {
    const watch = this.activeActivityWatch(binding);
    const lease = this.leases.get(binding.id);
    if (!watch || !lease || binding.status !== "active") return;
    if (watch.status === "sending") return;
    if (this.now() < (this.activityPollAfter.get(watch.id) ?? 0)) return;
    this.activityPollAfter.set(watch.id, this.now() + ACTIVITY_POLL_INTERVAL_MS);
    let agentRunning: boolean;
    let observedSource: CanonicalAgentStatusResult["source"];
    try {
      const observation = await this.control.agentStatus({
        lease,
        outputGeneration: watch.outputGeneration,
        pane: "0",
      });
      this.assertActivityWatchCorrelation(binding, watch, lease, observation);
      agentRunning = observation.agentRunning;
      observedSource = observation.source;
    } catch (error) {
      if (!this.fatalActivityObservation(error)) return;
      watch.status = "recovery-required";
      watch.completedAt = nowIso(this.now);
      watch.error = error instanceof Error ? error.message : String(error);
      this.markBindingStale(binding, `Agent activity continuity was lost: ${watch.error}`);
      this.activityPollAfter.delete(watch.id);
      this.persist();
      return;
    }

    const observedAt = nowIso(this.now);
    if (agentRunning) {
      if (!observedSource) {
        watch.status = "recovery-required";
        watch.completedAt = observedAt;
        watch.error = "the running Agent has no exact structured result correlation";
        this.markBindingStale(binding, `Agent activity continuity was lost: ${watch.error}`);
        this.activityPollAfter.delete(watch.id);
        this.persist();
        return;
      }
      const sourceChanged = watch.source?.sourceId !== observedSource.sourceId;
      if (watch.status !== "armed" || watch.stopCandidateAt || sourceChanged) {
        watch.status = "armed";
        watch.observedRunningAt = observedAt;
        watch.source = observedSource;
        delete watch.stopCandidateAt;
        this.persist();
      }
      return;
    }
    if (!watch.observedRunningAt) {
      watch.status = "cancelled";
      watch.completedAt = observedAt;
      watch.error = "the Agent was not observed running after Feishu ownership became active";
      this.activityPollAfter.delete(watch.id);
      this.persist();
      return;
    }
    if (watch.status !== "stop-candidate" || !watch.stopCandidateAt) {
      watch.status = "stop-candidate";
      watch.stopCandidateAt = observedAt;
      this.persist();
      return;
    }
    if (this.now() - Date.parse(watch.stopCandidateAt) < ACTIVITY_STOP_DEBOUNCE_MS) return;
    await this.prepareActivityCompletion(binding, watch, lease);
  }

  private async prepareActivityCompletion(
    binding: FeishuBinding,
    watch: FeishuActivityWatch,
    lease: CanonicalTerminalLease,
  ): Promise<void> {
    let result: CanonicalAgentResultResult;
    try {
      const before = await this.control.ownershipStatus(binding.controlTargetId);
      if (this.isFeishuDrainingView(binding, lease, before)) return;
      this.assertLeaseView(binding, lease, before);
      if (before.outputGeneration !== watch.outputGeneration) {
        throw new CanonicalTerminalControlError(
          "STALE_OUTPUT_CURSOR",
          "Agent activity completion was fenced by an output generation change",
        );
      }
      if (!watch.source) {
        throw new CanonicalTerminalControlError(
          "CONTROLLER_UNAVAILABLE",
          "Agent activity watch has no exact structured result source",
        );
      }
      result = await this.control.agentResult({
        lease,
        outputGeneration: watch.outputGeneration,
        pane: "0",
        source: watch.source,
        maxBytes: MAX_REPLY_BYTES,
      });
      this.assertActivityResultCorrelation(binding, watch, lease, result);
    } catch (error) {
      if (!this.fatalActivityObservation(error)) return;
      watch.status = "recovery-required";
      watch.completedAt = nowIso(this.now);
      watch.error = error instanceof Error ? error.message : String(error);
      this.markBindingStale(binding, `Agent activity continuity was lost before completion: ${watch.error}`);
      this.persist();
      return;
    }
    const completedAt = result.completedAt;
    const idempotencyKey = `tw-${digest(`activity-result:${watch.id}:${result.source.sourceId}`).slice(0, 40)}`;
    watch.status = "sending";
    watch.completedAt = completedAt;
    delete watch.error;
    this.persist();
    this.queueActivityCompletion(binding, watch, lease, result, idempotencyKey);
  }

  private queueActivityCompletion(
    binding: FeishuBinding,
    watch: FeishuActivityWatch,
    lease: CanonicalTerminalLease,
    activityResult: CanonicalAgentResultResult,
    idempotencyKey: string,
  ): void {
    const bindingSnapshot = structuredClone(binding);
    const watchSnapshot = structuredClone(watch);
    const leaseSnapshot = structuredClone(lease);
    // Binding lifecycle cards are ordered before completion cards, but their
    // network I/O stays outside the terminal mutation lane.
    const lifecycleBarrier = this.lifecycleMutation;
    const effect = async () => {
      await lifecycleBarrier;
      await this.deliverActivityCompletion(
        bindingSnapshot,
        watchSnapshot,
        leaseSnapshot,
        activityResult,
        idempotencyKey,
      );
    };
    const queued = this.activityCompletionMutation.then(effect, effect);
    this.activityCompletionMutation = queued.then(
      () => undefined,
      (error) => {
        process.stderr.write(`[feishu-bridge] activity completion effect failed: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    );
  }

  private async deliverActivityCompletion(
    binding: FeishuBinding,
    watch: FeishuActivityWatch,
    lease: CanonicalTerminalLease,
    activityResult: CanonicalAgentResultResult,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      const before = await this.control.ownershipStatus(binding.controlTargetId);
      if (this.isFeishuDrainingView(binding, lease, before)) {
        await this.deferActivityCompletion(binding.id, watch.id);
        return;
      }
      this.assertLeaseView(binding, lease, before);
      if (before.outputGeneration !== watch.outputGeneration) {
        throw new CanonicalTerminalControlError(
          "STALE_OUTPUT_CURSOR",
          "Agent activity completion was fenced by an output generation change",
        );
      }
    } catch (error) {
      if (this.fatalActivityObservation(error)) {
        await this.failActivityCompletionBeforeSend(binding.id, watch.id, error);
      } else {
        await this.deferActivityCompletion(binding.id, watch.id);
      }
      return;
    }

    try {
      const sendResult = await this.lark.sendCard(
        binding.chatId,
        buildFeishuLocalTaskResultCard({
          sessionName: binding.sessionName,
          sessionSummary: binding.sessionSummary,
          text: activityResult.text,
          truncated: activityResult.truncated,
        }),
        idempotencyKey,
      );
      await this.serial(async () => {
        const currentBinding = this.state.bindings.find((candidate) => candidate.id === binding.id);
        const currentWatch = currentBinding?.activityWatch;
        if (!currentBinding || currentWatch?.id !== watch.id
          || currentWatch.status === "cancelled" || currentWatch.status === "uncertain") return;
        currentWatch.status = "sent";
        currentWatch.completedAt = activityResult.completedAt;
        delete currentWatch.error;
        this.activityPollAfter.delete(currentWatch.id);
        if (sendResult.messageId) currentWatch.messageId = sendResult.messageId;
        currentBinding.lastActivityAt = activityResult.completedAt;
        this.persist();
      });
    } catch (error) {
      await this.serial(async () => {
        const currentBinding = this.state.bindings.find((candidate) => candidate.id === binding.id);
        const currentWatch = currentBinding?.activityWatch;
        if (!currentBinding || currentWatch?.id !== watch.id || currentWatch.status === "sent") return;
        currentWatch.status = "uncertain";
        currentWatch.completedAt = activityResult.completedAt;
        this.activityPollAfter.delete(currentWatch.id);
        currentWatch.error = error instanceof Error ? error.message : String(error);
        this.markBindingStale(currentBinding, "local Agent completion card disposition is uncertain");
        this.persist();
      });
    }
  }

  private deferActivityCompletion(bindingId: string, watchId: string): Promise<void> {
    return this.serial(async () => {
      const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
      const watch = binding?.activityWatch;
      if (!binding || watch?.id !== watchId || watch.status !== "sending") return;
      watch.status = "stop-candidate";
      delete watch.completedAt;
      delete watch.error;
      this.activityPollAfter.set(watch.id, this.now() + ACTIVITY_POLL_INTERVAL_MS);
      this.persist();
    });
  }

  private failActivityCompletionBeforeSend(
    bindingId: string,
    watchId: string,
    error: unknown,
  ): Promise<void> {
    return this.serial(async () => {
      const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
      const watch = binding?.activityWatch;
      if (!binding || watch?.id !== watchId || watch.status !== "sending") return;
      watch.status = "recovery-required";
      watch.completedAt = nowIso(this.now);
      watch.error = error instanceof Error ? error.message : String(error);
      this.activityPollAfter.delete(watch.id);
      this.markBindingStale(binding, `Agent activity continuity was lost before completion: ${watch.error}`);
      this.persist();
    });
  }

  private async completeReply(
    turn: FeishuTurn,
    binding: FeishuBinding,
    text: string,
    finalStatus: "completed" | "timed-out",
  ): Promise<void> {
    try {
      const currentLease = this.leases.get(binding.id);
      if (!currentLease) throw new Error("Feishu lease disappeared before outbound reply");
      const target = await this.control.ownershipStatus(turn.controlTargetId);
      this.assertTurnAuthority(turn, currentLease, target);
      const existing = this.state.replies.find((candidate) => candidate.id === turn.outboundAttemptId);
      const attempt: FeishuOutboundReply = existing ?? {
        id: turn.outboundAttemptId,
        turnId: turn.id,
        sourceMessageId: turn.messageId,
        idempotencyKey: `tw-${digest(turn.outboundAttemptId).slice(0, 40)}`,
        status: "prepared",
        textDigest: digest(text),
        createdAt: nowIso(this.now),
        deliveryKind: "turn-reply",
        text,
        sessionName: binding.sessionName,
        tone: finalStatus === "timed-out" ? "status" : "answer",
        replyMode: binding.options.replyMode,
        finalTurnStatus: finalStatus,
      };
      if (!existing) this.state.replies.push(attempt);
      if (attempt.textDigest !== digest(text)) throw new Error("outbound reply payload changed after preparation");
      if (!this.hasDurableOutboundPayload(attempt)) {
        throw new Error("outbound reply attempt omitted its durable delivery payload");
      }
      turn.status = "replying";
      this.persist();
    } catch (error) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = `outbound Feishu reply was not started: ${error instanceof Error ? error.message : String(error)}`;
      this.markBindingStale(binding, turn.error);
      try {
        this.persist();
      } finally {
        this.queueProcessingReactionSettlement(turn.messageId, "failure");
      }
      return;
    }
  }

  private async reconcileBindingHandoff(
    binding: FeishuBinding,
    lease: CanonicalTerminalLease,
    preferredDrain?: CanonicalDrainRecord,
  ): Promise<void> {
    const target = await this.control.ownershipStatus(binding.controlTargetId);
    const stillHeldByFeishu = target.controlTargetId === binding.controlTargetId
      && target.controlEpoch === lease.controlEpoch
      && target.fence === lease.fence
      && target.state === "HELD"
      && target.ownerKind === "feishu";
    if (stillHeldByFeishu) {
      if (binding.handoff?.status === "prepared") {
        binding.handoff.status = binding.handoff.bridgeRole === "next" ? "cancelled" : "withdrawn";
        binding.handoff.completedAt = nowIso(this.now);
        binding.status = "active";
        binding.lastActivityAt = binding.handoff.completedAt;
        this.persist();
      }
      return;
    }
    if (!this.isFeishuDrainingView(binding, lease, target)) {
      this.leases.delete(binding.id);
      const turn = this.activeTurn(binding.id);
      const watch = this.activeActivityWatch(binding);
      if (turn) {
        turn.status = "recovery-required";
        turn.completedAt = nowIso(this.now);
        turn.error = `terminal ownership entered ${target.state} during Feishu handoff reconciliation`;
      }
      if (watch) {
        watch.status = "recovery-required";
        watch.completedAt = nowIso(this.now);
        watch.error = `terminal ownership entered ${target.state} during Feishu handoff reconciliation`;
        this.activityPollAfter.delete(watch.id);
      }
      this.markBindingStale(binding, `terminal ownership entered ${target.state} during Feishu handoff reconciliation`);
      this.persist();
      if (turn) this.queueProcessingReactionSettlement(turn.messageId, "failure");
      return;
    }
    // A lease-less local handoff may be initiated outside the Bridge. Keep the
    // canonical target DRAINING until both Feishu turns and inherited local
    // task completion delivery have reached a certain disposition. Explicit
    // force takeover cancels the watch before beginning its handoff.
    if (this.activeTurn(binding.id) || this.activeActivityWatch(binding)) return;

    const handoffId = target.handoffId!;
    const nextOwnerKind = target.nextOwnerKind as "dashboard" | "local-cli";
    const lastTurn = [...this.state.turns].reverse().find((turn) =>
      turn.bindingId === binding.id && !!turn.completedAt);
    const drain: CanonicalDrainRecord = preferredDrain ?? {
      disposition: lastTurn?.status === "cancelled" ? "cancelled" : "drained",
      recordId: lastTurn
        ? `feishu-turn:${lastTurn.id}:${lastTurn.status === "cancelled" ? "cancelled" : "drained"}`
        : `binding:${binding.id}:feishu-drained`,
      recordedAt: lastTurn?.completedAt ?? nowIso(this.now),
    };
    if (drain.disposition === "uncertain") {
      this.leases.delete(binding.id);
      this.markBindingStale(binding, "handoff drain disposition is uncertain and requires local recovery");
      this.persist();
      return;
    }
    binding.handoff = {
      handoffId,
      controlEpoch: lease.controlEpoch,
      fence: lease.fence,
      nextOwnerKind,
      bridgeRole: "current",
      status: "prepared",
      drain: {
        disposition: drain.disposition,
        recordId: drain.recordId,
        recordedAt: drain.recordedAt,
      },
    };
    binding.status = "pausing";
    binding.lastActivityAt = nowIso(this.now);
    this.persist();

    try {
      const committed = await this.control.commitHandoff(handoffId, lease, drain);
      const nextLease = committed.lease;
      if (!nextLease
        || committed.ownership.controlTargetId !== binding.controlTargetId
        || committed.ownership.controlEpoch !== lease.controlEpoch
        || committed.ownership.state !== "HELD"
        || committed.ownership.ownerKind !== nextOwnerKind
        || committed.ownership.fence !== nextLease.fence
        || nextLease.controlTargetId !== binding.controlTargetId
        || nextLease.controlEpoch !== lease.controlEpoch
        || nextLease.owner.kind !== nextOwnerKind
        || Date.parse(nextLease.expiresAt) <= this.now()) {
        throw new Error("canonical terminal-control returned an incompatible local-owner handoff result");
      }
      binding.handoff.status = "committed";
      binding.handoff.completedAt = nowIso(this.now);
      binding.status = "paused";
      delete binding.staleReason;
      binding.lastActivityAt = binding.handoff.completedAt;
      this.leases.delete(binding.id);
      this.persist();
    } catch (error) {
      let latest: CanonicalTerminalOwnership | undefined;
      try { latest = await this.control.ownershipStatus(binding.controlTargetId); } catch {}
      if (latest?.controlEpoch === lease.controlEpoch
        && latest.state === "HELD"
        && latest.ownerKind === "feishu"
        && latest.fence === lease.fence) {
        binding.handoff.status = "withdrawn";
        binding.handoff.completedAt = nowIso(this.now);
        binding.handoff.error = error instanceof Error ? error.message : String(error);
        binding.status = "active";
        binding.lastActivityAt = binding.handoff.completedAt;
        this.persist();
        return;
      }
      if (latest?.controlEpoch === lease.controlEpoch
        && latest.state === "HELD"
        && latest.ownerKind === nextOwnerKind
        && latest.fence !== lease.fence) {
        binding.handoff.status = "committed";
        binding.handoff.completedAt = nowIso(this.now);
        binding.handoff.error = "commit acknowledgement was lost; ownership status confirmed transfer";
        binding.status = "paused";
        binding.lastActivityAt = binding.handoff.completedAt;
        this.leases.delete(binding.id);
        this.persist();
        return;
      }
      binding.handoff.status = "uncertain";
      binding.handoff.completedAt = nowIso(this.now);
      binding.handoff.error = error instanceof Error ? error.message : String(error);
      this.leases.delete(binding.id);
      this.markBindingStale(binding, `handoff commit disposition is uncertain: ${binding.handoff.error}`);
      this.persist();
    }
  }

  private assertLeaseView(
    binding: FeishuBinding,
    lease: CanonicalTerminalLease,
    target: CanonicalTerminalOwnership,
  ): void {
    if (target.controlTargetId !== binding.controlTargetId
      || target.controlEpoch !== lease.controlEpoch
      || target.state !== "HELD"
      || target.ownerKind !== lease.owner.kind
      || target.fence !== lease.fence) {
      throw new CanonicalTerminalControlError(
        "PERMISSION_DENIED",
        "Feishu binding no longer owns the exact terminal target",
      );
    }
  }

  private assertTurnAuthority(
    turn: FeishuTurn,
    lease: CanonicalTerminalLease,
    target: CanonicalTerminalOwnership,
  ): void {
    const stateAllowsSettling = target.state === "HELD"
      || (target.state === "DRAINING"
        && target.ownerKind === "feishu"
        && (target.nextOwnerKind === "dashboard" || target.nextOwnerKind === "local-cli")
        && !!target.handoffId);
    if (target.controlTargetId !== turn.controlTargetId
      || lease.controlTargetId !== turn.controlTargetId
      || lease.controlEpoch !== turn.controlEpoch
      || turn.controlEpoch !== target.controlEpoch
      || turn.leaseId !== lease.leaseId
      || turn.fence !== lease.fence
      || target.fence !== lease.fence
      || !stateAllowsSettling
      || target.ownerKind !== lease.owner.kind
      || target.outputGeneration !== turn.outputGeneration) {
      throw new Error("late Feishu callback was fenced by ownership or output generation change");
    }
  }

  private isFeishuDrainingView(
    binding: FeishuBinding,
    lease: CanonicalTerminalLease,
    target: CanonicalTerminalOwnership,
  ): boolean {
    return target.controlTargetId === binding.controlTargetId
      && lease.controlTargetId === binding.controlTargetId
      && target.controlEpoch === lease.controlEpoch
      && target.fence === lease.fence
      && target.state === "DRAINING"
      && target.ownerKind === "feishu"
      && lease.owner.kind === "feishu"
      && (target.nextOwnerKind === "dashboard" || target.nextOwnerKind === "local-cli")
      && !!target.handoffId;
  }

  private formatPrompt(
    binding: FeishuBinding,
    markerNonce: string,
    senderId: string,
    content: string,
    mode: "start-or-steer" | "steer",
  ): string {
    const normalized = content.replace(/\0/g, "").replaceAll("[[", "[\u200b[").trim();
    return boundedUtf8([
      `[Feishu group: ${binding.chatName}; sender: ${senderId}]`,
      mode === "steer"
        ? "Steering update for the current in-progress task. Incorporate it into that task; do not start a separate task."
        : "If a task is already in progress, treat this as a steering update to that task; otherwise start a new task.",
      normalized,
      "Reply for the group only when ready. Build the delimiters by concatenating each quoted fragment without spaces.",
      `Open fragments: "[[" + "notify-group:" + "${markerNonce}" + "]]".`,
      `Close fragments: "[[" + "/notify-group:" + "${markerNonce}" + "]]".`,
      "Place only the public reply between the constructed delimiters.",
      "Do not place private terminal context inside those markers.",
    ].join("\n"), MAX_PROMPT_BYTES);
  }

  private async steerActiveTurn(
    binding: FeishuBinding,
    lease: CanonicalTerminalLease,
    target: CanonicalTerminalOwnership,
    turn: FeishuTurn,
    eventId: string,
    messageId: string,
    senderId: string,
    content: string,
  ): Promise<void> {
    if (!turn.markerNonce || turn.outputGeneration === undefined || turn.cursor === undefined) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "the active Feishu turn has no complete marker/output correlation for steering";
      this.markBindingStale(binding, turn.error);
      this.rememberEvent(eventId, false);
      this.persist();
      this.queueProcessingReactionSettlement(turn.messageId, "failure");
      return;
    }
    try {
      this.assertTurnAuthority(turn, lease, target);
    } catch (error) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = error instanceof Error ? error.message : String(error);
      this.markBindingStale(binding, turn.error);
      this.rememberEvent(eventId, false);
      this.persist();
      this.queueProcessingReactionSettlement(turn.messageId, "failure");
      throw error;
    }

    const operationId = `feishu-steer-${digest(`${turn.id}:${eventId}`).slice(0, 32)}`;
    this.rememberEvent(eventId, false);
    this.persist();
    try {
      const accepted = await this.control.sendAgentMessage({
        lease,
        operationId,
        pane: "0",
        message: this.formatPrompt(
          binding,
          turn.markerNonce,
          senderId,
          content,
          "steer",
        ),
        submit: true,
      });
      if (accepted.operationId !== operationId
        || accepted.controlEpoch !== turn.controlEpoch
        || accepted.fence !== turn.fence
        || accepted.outputGeneration !== turn.outputGeneration
        || accepted.outputCursor < turn.cursor) {
        const error = new Error("terminal input/output correlation changed while steering the Feishu turn");
        Object.assign(error, { code: "RECOVERY_REQUIRED" });
        throw error;
      }
    } catch (error) {
      if (hasCode(error, "HANDOFF_PENDING")) {
        await this.safeInform(
          binding,
          messageId,
          "当前终端正在安全交接给本地控制端，本条 steering 消息未注入终端。",
          `steer-handoff-${eventId}`,
        );
        await this.reconcileBindingHandoff(binding, lease);
        return;
      }
      if (this.controlContinuityLost(error)) {
        turn.status = "recovery-required";
        turn.completedAt = nowIso(this.now);
        turn.error = `steering input disposition is uncertain: ${error instanceof Error ? error.message : String(error)}`;
        this.markBindingStale(binding, turn.error);
        this.persist();
        this.queueProcessingReactionSettlement(turn.messageId, "failure");
      }
      throw error;
    }
    const steeredAt = this.now();
    turn.deadlineAt = new Date(steeredAt + TURN_IDLE_TIMEOUT_MS).toISOString();
    binding.lastActivityAt = new Date(steeredAt).toISOString();
    this.persist();
    await this.safeInform(
      binding,
      messageId,
      "已将这条消息 steer 到当前 Agent；本轮最终回复仍发送到最初触发消息。",
      `steered-${eventId}`,
    );
  }

  private validateCreateInput(input: CreateFeishuBindingInput): void {
    for (const [name, value] of Object.entries({
      chatId: input.chatId,
      chatName: input.chatName,
      sessionName: input.sessionName,
      createdBy: input.createdBy,
    })) {
      if (typeof value !== "string" || !value.trim() || value.includes("\0")
        || Buffer.byteLength(value, "utf8") > 1024) throw new Error(`invalid ${name}`);
    }
    if (input.sessionName.includes(":")) {
      throw new Error("remote Feishu targets are not supported in this version");
    }
    if (input.sessionSummary !== undefined
      && (typeof input.sessionSummary !== "string"
        || !input.sessionSummary.trim()
        || input.sessionSummary.includes("\0")
        || Buffer.byteLength(input.sessionSummary, "utf8") > 1024)) {
      throw new Error("invalid sessionSummary");
    }
    if (input.replyMode !== undefined
      && input.replyMode !== "topic"
      && input.replyMode !== "direct") {
      throw new Error("invalid replyMode");
    }
  }

  private async ensureBotOpenId(): Promise<string> {
    this.botOpenId ||= await this.lark.botOpenId();
    if (!this.botMentionIds) {
      const mentionIds = this.lark.botMentionIds
        ? await this.lark.botMentionIds()
        : [this.botOpenId];
      if (!mentionIds.includes(this.botOpenId)) {
        throw new Error("Feishu bot identity aliases do not include its open_id");
      }
      this.botMentionIds = new Set(mentionIds);
    }
    return this.botOpenId;
  }

  private requireBinding(bindingId: string): FeishuBinding {
    const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
    if (!binding) throw new Error("Feishu binding not found");
    return binding;
  }

  private activeTurn(bindingId: string): FeishuTurn | undefined {
    return this.state.turns.find((turn) => turn.bindingId === bindingId
      && (turn.status === "prepared" || turn.status === "awaiting" || turn.status === "replying"));
  }

  private activeActivityWatch(binding: FeishuBinding): FeishuActivityWatch | undefined {
    const watch = binding.activityWatch;
    return watch && (watch.status === "probing"
      || watch.status === "armed"
      || watch.status === "stop-candidate"
      || watch.status === "sending")
      ? watch
      : undefined;
  }

  private cancelActivityWatch(binding: FeishuBinding, reason: string): void {
    const watch = this.activeActivityWatch(binding);
    if (!watch) return;
    watch.status = "cancelled";
    watch.completedAt = nowIso(this.now);
    watch.error = boundedUtf8(reason, 4096);
    this.activityPollAfter.delete(watch.id);
  }

  private async activateActivityWatchOrStale(
    binding: FeishuBinding,
    lease: CanonicalTerminalLease,
    operation: string,
  ): Promise<void> {
    try {
      await this.startOrResumeActivityWatch(binding, lease);
    } catch (error) {
      const watch = this.activeActivityWatch(binding);
      if (watch) {
        watch.status = "recovery-required";
        watch.completedAt = nowIso(this.now);
        watch.error = error instanceof Error ? error.message : String(error);
        this.activityPollAfter.delete(watch.id);
      }
      this.markBindingStale(
        binding,
        `${operation} could not establish Agent activity continuity: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.persist();
      throw error;
    }
  }

  private async startOrResumeActivityWatch(
    binding: FeishuBinding,
    lease: CanonicalTerminalLease,
  ): Promise<void> {
    const target = await this.control.ownershipStatus(binding.controlTargetId);
    this.assertLeaseView(binding, lease, target);
    const previous = this.activeActivityWatch(binding);
    const watch: FeishuActivityWatch = previous ?? {
      id: `activity-${randomUUID()}`,
      status: "probing",
      controlEpoch: lease.controlEpoch,
      leaseId: lease.leaseId,
      fence: lease.fence,
      outputGeneration: target.outputGeneration,
      createdAt: nowIso(this.now),
    };
    watch.controlEpoch = lease.controlEpoch;
    watch.leaseId = lease.leaseId;
    watch.fence = lease.fence;
    watch.outputGeneration = target.outputGeneration;
    watch.status = watch.observedRunningAt ? "armed" : "probing";
    delete watch.stopCandidateAt;
    delete watch.completedAt;
    delete watch.messageId;
    delete watch.error;
    this.activityPollAfter.delete(watch.id);
    binding.activityWatch = watch;
    try {
      const observation = await this.control.agentStatus({
        lease,
        outputGeneration: watch.outputGeneration,
        pane: "0",
      });
      this.assertActivityWatchCorrelation(binding, watch, lease, observation);
      const observedAt = nowIso(this.now);
      if (observation.agentRunning) {
        if (!observation.source) {
          throw new CanonicalTerminalControlError(
            "CONTROLLER_UNAVAILABLE",
            "the running Agent has no exact structured result correlation",
          );
        }
        watch.status = "armed";
        watch.observedRunningAt = observedAt;
        watch.source = observation.source;
      } else if (watch.observedRunningAt) {
        watch.status = "stop-candidate";
        watch.stopCandidateAt = observedAt;
      } else {
        watch.status = "cancelled";
        watch.completedAt = observedAt;
        watch.error = "the Agent was not running when Feishu ownership became active";
      }
    } catch (error) {
      if (this.fatalActivityObservation(error)) throw error;
      // A transient read-only observation leaves the durable probe armed. The
      // normal poll loop retries without replaying terminal input.
    }
  }

  private assertActivityWatchCorrelation(
    binding: FeishuBinding,
    watch: FeishuActivityWatch,
    lease: CanonicalTerminalLease,
    observation: Awaited<ReturnType<CanonicalTerminalControlClient["agentStatus"]>>,
  ): void {
    if (observation.controlTargetId !== binding.controlTargetId
      || observation.controlEpoch !== watch.controlEpoch
      || observation.controlEpoch !== lease.controlEpoch
      || observation.leaseId !== watch.leaseId
      || observation.leaseId !== lease.leaseId
      || observation.fence !== watch.fence
      || observation.fence !== lease.fence
      || observation.ownerKind !== "feishu"
      || observation.outputGeneration !== watch.outputGeneration
      || observation.pane !== "0") {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned mismatched Agent activity correlation",
      );
    }
  }

  private assertActivityResultCorrelation(
    binding: FeishuBinding,
    watch: FeishuActivityWatch,
    lease: CanonicalTerminalLease,
    result: CanonicalAgentResultResult,
  ): void {
    if (result.controlTargetId !== binding.controlTargetId
      || result.controlEpoch !== watch.controlEpoch
      || result.controlEpoch !== lease.controlEpoch
      || result.leaseId !== watch.leaseId
      || result.leaseId !== lease.leaseId
      || result.fence !== watch.fence
      || result.fence !== lease.fence
      || result.ownerKind !== "feishu"
      || result.outputGeneration !== watch.outputGeneration
      || result.pane !== "0"
      || !watch.source
      || result.source.sourceId !== watch.source.sourceId
      || result.source.provider !== watch.source.provider
      || result.source.boundary !== watch.source.boundary
      || result.source.sessionId !== watch.source.sessionId
      || result.source.turnId !== watch.source.turnId
      || result.source.startedAt !== watch.source.startedAt) {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned mismatched Agent final response correlation",
      );
    }
  }

  private fatalActivityObservation(error: unknown): boolean {
    if (!(error instanceof Error)) return true;
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (candidate.code === "RESOURCE_EXHAUSTED" || candidate.code === "INTERNAL") return false;
    if (candidate.code === "CONTROLLER_UNAVAILABLE") return candidate.retryable !== true;
    if (typeof candidate.code === "string") return true;
    return false;
  }

  private rememberEvent(eventId: string, persist = true): void {
    if (!this.state.eventIds.includes(eventId)) this.state.eventIds.push(eventId);
    if (persist) this.persist();
  }

  private markBindingStale(binding: FeishuBinding, reason: string): void {
    binding.status = "stale";
    binding.staleReason = boundedUtf8(reason || "unknown bridge failure", 4096);
    binding.lastActivityAt = nowIso(this.now);
  }

  private feishuOwner(bindingId: string): CanonicalTerminalOwner {
    return {
      kind: "feishu",
      instanceId: `feishu-binding:${bindingId}:${this.instanceId}`,
    };
  }

  private preparedHandoffRecord(
    handoffId: string,
    currentLease: CanonicalTerminalLease,
    nextOwnerKind: "feishu" | "dashboard" | "local-cli",
    bridgeRole: "current" | "next",
    drain: CanonicalDrainRecord,
  ): FeishuHandoffRecord {
    if (drain.disposition === "uncertain") {
      throw new Error("Feishu bridge cannot prepare an uncertain automatic handoff");
    }
    return {
      handoffId,
      controlEpoch: currentLease.controlEpoch,
      fence: currentLease.fence,
      nextOwnerKind,
      bridgeRole,
      status: "prepared",
      drain: {
        disposition: drain.disposition,
        recordId: drain.recordId,
        recordedAt: drain.recordedAt,
      },
    };
  }

  private markPreparedHandoffUncertain(binding: FeishuBinding, error: unknown): void {
    if (binding.handoff?.status !== "prepared") return;
    binding.handoff.status = "uncertain";
    binding.handoff.completedAt = nowIso(this.now);
    binding.handoff.error = error instanceof Error ? error.message : String(error);
  }

  private async bestEffortAbortHandoff(
    bridgeRole: "current" | "next",
    handoffId: string,
    currentLease: CanonicalTerminalLease,
    nextOwner: CanonicalTerminalOwner,
  ): Promise<void> {
    try {
      if (bridgeRole === "current") {
        await this.control.cancelHandoff(handoffId, currentLease);
      } else {
        await this.control.withdrawHandoff(currentLease.controlTargetId, handoffId, nextOwner);
      }
    } catch {
      // This is only used before commit is sent. Failure leaves the binding fail-closed for inspection.
    }
  }

  private requireGrantedLease(
    result: CanonicalLeaseResult | CanonicalHandoffResult,
    controlTargetId: string,
    expectedOwner: CanonicalTerminalOwner,
    allowedStates: CanonicalTerminalOwnership["state"][] = ["HELD"],
  ): CanonicalTerminalLease {
    const lease = result.lease;
    if (!lease
      || lease.controlTargetId !== controlTargetId
      || result.ownership.controlTargetId !== controlTargetId
      || result.ownership.controlEpoch !== lease.controlEpoch
      || result.ownership.fence !== lease.fence
      || !allowedStates.includes(result.ownership.state)
      || lease.owner.kind !== expectedOwner.kind
      || lease.owner.instanceId !== expectedOwner.instanceId
      || result.ownership.ownerKind !== expectedOwner.kind
      || Date.parse(lease.expiresAt) <= this.now()) {
      throw new Error("canonical terminal-control did not grant the expected owner lease");
    }
    return lease;
  }

  private controlContinuityLost(error: unknown): boolean {
    return [
      "OPERATION_IN_DOUBT",
      "RECOVERY_REQUIRED",
      "TARGET_GONE",
      "PERMISSION_DENIED",
      "CONTROLLER_UNAVAILABLE",
    ].some((code) => hasCode(error, code));
  }

  private async releaseLease(lease: CanonicalTerminalLease): Promise<void> {
    const released = await this.control.releaseLease(lease);
    if (released.controlTargetId !== lease.controlTargetId
      || released.controlEpoch !== lease.controlEpoch
      || released.state !== "FREE") {
      const error = new Error("canonical terminal-control did not confirm a free released target");
      Object.assign(error, { code: "RECOVERY_REQUIRED" });
      throw error;
    }
  }

  private async bestEffortReleaseLease(lease: CanonicalTerminalLease): Promise<void> {
    try { await this.releaseLease(lease); } catch {
      // Rollback is best effort, but no caller treats this as proof that ownership is free.
    }
  }

  private async bindingLifecycleEndReason(
    binding: FeishuBinding,
    exactTargetEnded: boolean,
  ): Promise<"session-deleted" | "target-ended" | "target-replaced" | undefined> {
    try {
      const current = await this.control.resolveTarget(binding.sessionName);
      if (current.controlTargetId !== binding.controlTargetId) {
        if (exactTargetEnded) return "target-replaced";
        try {
          const oldTarget = await this.control.ownershipStatus(binding.controlTargetId);
          if (oldTarget.state === "TARGET_GONE") return "target-replaced";
        } catch (error) {
          if (hasCode(error, "TARGET_GONE")) return "target-replaced";
        }
        // A controller state reset can mint a new controlTargetId for the same
        // backend lifecycle. Without proof that the old target ended, retain
        // the binding for controlled local inspection.
        return undefined;
      }
      return exactTargetEnded ? "target-ended" : undefined;
    } catch (error) {
      if (hasCode(error, "TARGET_NOT_FOUND")) return "session-deleted";
      return exactTargetEnded ? "target-ended" : undefined;
    }
  }

  private async assertUnleasedBindingCanBeRemoved(binding: FeishuBinding): Promise<void> {
    let ownership: CanonicalTerminalOwnership;
    try {
      ownership = await this.control.ownershipStatus(binding.controlTargetId);
    } catch (error) {
      if (hasCode(error, "TARGET_GONE")) return;
      if (hasCode(error, "TARGET_NOT_FOUND")) {
        try {
          const current = await this.control.resolveTarget(binding.sessionName);
          if (current.controlTargetId !== binding.controlTargetId) {
            try {
              const oldTarget = await this.control.ownershipStatus(binding.controlTargetId);
              if (oldTarget.state === "TARGET_GONE") return;
            } catch (oldTargetError) {
              if (hasCode(oldTargetError, "TARGET_GONE")) return;
            }
          }
        } catch (resolutionError) {
          if (hasCode(resolutionError, "TARGET_NOT_FOUND")) return;
        }
      }
      const unavailable = new Error(
        "binding has no live Feishu lease; recover terminal ownership locally before unlinking",
      );
      Object.assign(unavailable, { code: "RECOVERY_REQUIRED" });
      throw unavailable;
    }
    if (ownership.state === "FREE" || ownership.state === "TARGET_GONE") return;
    if (ownership.state === "HELD"
      && (ownership.ownerKind === "dashboard" || ownership.ownerKind === "local-cli")) return;
    const unavailable = new Error(
      "binding has no live Feishu lease; recover terminal ownership locally before unlinking",
    );
    Object.assign(unavailable, { code: "RECOVERY_REQUIRED" });
    throw unavailable;
  }

  private async invalidateBinding(
    binding: FeishuBinding,
    reason: "session-deleted" | "target-ended" | "target-replaced",
  ): Promise<void> {
    const current = this.state.bindings.find((candidate) => candidate.id === binding.id);
    if (!current || current.controlTargetId !== binding.controlTargetId) return;
    const turn = this.activeTurn(binding.id);
    if (turn) {
      turn.status = "cancelled";
      turn.completedAt = nowIso(this.now);
      turn.error = reason === "session-deleted"
        ? "the bound TW session was deleted"
        : "the exact bound TW lifecycle no longer exists";
    }
    if (this.activeActivityWatch(binding)) {
      this.cancelActivityWatch(binding, "the bound terminal lifecycle ended");
    }
    this.leases.delete(binding.id);
    this.state.bindings = this.state.bindings.filter((candidate) => candidate.id !== binding.id);
    this.persist();
    if (turn) this.queueProcessingReactionSettlement(turn.messageId, "failure");
    this.queueBindingLifecycle(binding, reason);
  }

  private queueBindingLifecycle(
    binding: FeishuBinding,
    kind: FeishuBindingLifecycleCardKind,
    details: {
      sessionKind?: "worktree" | "terminal";
      sessionSummary?: string;
      removalOrigin?: FeishuBindingRemovalOrigin;
    } = {},
  ): void {
    const snapshot = structuredClone(binding);
    const snapshotDetails = structuredClone(details);
    const effect = async () => {
      await this.safeSendBindingLifecycle(snapshot, kind, snapshotDetails);
    };
    const result = this.lifecycleMutation.then(effect, effect);
    this.lifecycleMutation = result.then(
      () => undefined,
      (error) => {
        process.stderr.write(`[feishu-bridge] lifecycle effect failed: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    );
  }

  private async safeSendBindingLifecycle(
    binding: FeishuBinding,
    kind: FeishuBindingLifecycleCardKind,
    details: {
      sessionKind?: "worktree" | "terminal";
      sessionSummary?: string;
      removalOrigin?: FeishuBindingRemovalOrigin;
    },
  ): Promise<void> {
    try {
      await this.lark.sendCard(
        binding.chatId,
        buildFeishuBindingLifecycleCard({
          kind,
          sessionName: binding.sessionName,
          controlTargetId: binding.controlTargetId,
          ...details,
        }),
        `tw-${digest(`binding-lifecycle:${binding.id}:${kind}:${binding.controlTargetId}`).slice(0, 40)}`,
      );
    } catch (error) {
      process.stderr.write(
        `[feishu-bridge] ${kind} group card failed for ${binding.id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private async safeInform(
    binding: FeishuBinding,
    messageId: string,
    text: string,
    idempotencySeed: string,
  ): Promise<void> {
    try {
      await this.lark.replyCard(
        messageId,
        buildFeishuReplyCard(text, binding.sessionName, "status"),
        `tw-${digest(idempotencySeed).slice(0, 40)}`,
        binding.options.replyMode,
      );
    } catch {}
  }

  private queueProcessingReactionStart(messageId: string): void {
    if (this.pendingProcessingReactions.has(messageId)) return;
    if (this.pendingProcessingReactions.size >= PROCESSING_REACTION_CACHE_SIZE) return;
    // Creation may reach Feishu even if its acknowledgement is lost. Keep an
    // explicit unknown handle before the call so a later failure never stacks
    // CrossMark on top of a Typing reaction that we cannot identify/delete.
    this.pendingProcessingReactions.set(messageId, { state: "unknown" });
    this.enqueueReactionEffect(() => this.createProcessingReaction(messageId));
  }

  private async createProcessingReaction(messageId: string): Promise<void> {
    try {
      const result = await this.lark.addReaction(messageId, "Typing");
      if (!result.reactionId) return;
      this.pendingProcessingReactions.set(messageId, {
        state: "created",
        reactionId: result.reactionId,
      });
    } catch (error) {
      process.stderr.write(`[feishu-bridge] add Typing reaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private queueProcessingReactionSettlement(
    messageId: string,
    outcome: "success" | "failure" | "cancelled",
  ): void {
    // A start may be skipped when the bounded cache is full. In that case the
    // entire reaction lifecycle is skipped rather than growing an unbounded
    // settlement backlog or adding CrossMark without a known Typing state.
    if (!this.pendingProcessingReactions.has(messageId)) return;
    this.enqueueReactionEffect(() => this.settleProcessingReaction(messageId, outcome));
  }

  private async settleProcessingReaction(
    messageId: string,
    outcome: "success" | "failure" | "cancelled",
  ): Promise<void> {
    const pending = this.pendingProcessingReactions.get(messageId);
    if (pending?.state === "unknown") {
      this.pendingProcessingReactions.delete(messageId);
      return;
    }
    if (pending?.state === "created") {
      try {
        await this.lark.deleteReaction(messageId, pending.reactionId);
        this.pendingProcessingReactions.delete(messageId);
      } catch (error) {
        process.stderr.write(`[feishu-bridge] remove Typing reaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return;
      }
    }
    if (outcome !== "failure") return;
    try {
      await this.lark.addReaction(messageId, "CrossMark");
    } catch (error) {
      process.stderr.write(`[feishu-bridge] add CrossMark reaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private enqueueReactionEffect(effect: () => Promise<void>): void {
    const result = this.reactionMutation.then(effect, effect);
    this.reactionMutation = result.then(
      () => undefined,
      (error) => {
        process.stderr.write(`[feishu-bridge] reaction effect failed: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    );
  }

  private async requireRenderedSnapshotCapability(): Promise<void> {
    const capabilities = await this.control.capabilities();
    if (capabilities.renderedSnapshot) return;
    const error = new Error(
      "terminal controller must be upgraded before Feishu can own or write to this terminal: missing output.rendered-snapshot capability",
    ) as Error & { code?: string };
    error.code = "FEISHU_BRIDGE_UPGRADE_REQUIRED";
    throw error;
  }

  private async requireBindingCapabilities(): Promise<void> {
    const capabilities = await this.control.capabilities();
    const missing = [
      ...(capabilities.renderedSnapshot ? [] : ["output.rendered-snapshot"]),
      ...(capabilities.agentStatus ? [] : ["activity.agent-status"]),
      ...(capabilities.agentResult ? [] : ["activity.agent-result"]),
    ];
    if (missing.length === 0) return;
    const error = new Error(
      `terminal controller must be upgraded before Feishu can own this terminal: missing ${missing.join(", ")} capability`,
    ) as Error & { code?: string };
    error.code = "FEISHU_BRIDGE_UPGRADE_REQUIRED";
    throw error;
  }

  private hasDurableOutboundPayload(reply: FeishuOutboundReply): boolean {
    if (!reply.text || !reply.sessionName || !reply.deliveryKind || !reply.tone) return false;
    if (reply.deliveryKind === "turn-reply") {
      return (reply.replyMode === "topic" || reply.replyMode === "direct")
        && (reply.finalTurnStatus === "completed" || reply.finalTurnStatus === "timed-out")
        && reply.tone === (reply.finalTurnStatus === "completed" ? "answer" : "status")
        && reply.chatId === undefined;
    }
    return reply.deliveryKind === "recovery-notice"
      && reply.tone === "status"
      && !!reply.chatId
      && reply.replyMode === undefined
      && reply.finalTurnStatus === undefined;
  }

  private ensureRecoveryNoticeAttempts(): void {
    for (const turn of this.state.turns) {
      if (turn.status !== "recovery-required" || this.recoveryNoticeTurnIds.has(turn.id)) continue;
      this.recoveryNoticeTurnIds.add(turn.id);
      const binding = this.state.bindings.find((candidate) => candidate.id === turn.bindingId);
      if (!binding) continue;
      const id = `recovery-${digest(turn.id).slice(0, 32)}`;
      if (this.state.replies.some((reply) => reply.id === id)) continue;
      const text = "本轮未能完成可确认的回复投递，Agent 内容没有在不确定状态下继续发送。请先在本地检查并恢复终端控制，再从群里重新发起。";
      this.state.replies.push({
        id,
        turnId: turn.id,
        sourceMessageId: turn.messageId,
        idempotencyKey: `tw-${digest(id).slice(0, 40)}`,
        status: "prepared",
        textDigest: digest(text),
        createdAt: nowIso(this.now),
        deliveryKind: "recovery-notice",
        text,
        sessionName: binding.sessionName,
        tone: "status",
        chatId: binding.chatId,
      });
    }
    for (const binding of this.state.bindings) {
      const watch = binding.activityWatch;
      if (!watch
        || (watch.status !== "uncertain" && watch.status !== "recovery-required")
        || this.recoveryNoticeActivityIds.has(watch.id)) continue;
      this.recoveryNoticeActivityIds.add(watch.id);
      const id = `activity-recovery-${digest(watch.id).slice(0, 32)}`;
      if (this.state.replies.some((reply) => reply.id === id)) continue;
      const text = watch.status === "uncertain"
        ? "本地 Agent 已停止，但完成卡片的投递结果无法确认。为避免重复发送 Agent 内容，请先在本地检查终端和群消息，再恢复绑定。"
        : "本地 Agent 的运行连续性已经丢失，未发送无法确认归属的 Agent 内容。请先在本地检查并恢复终端控制。";
      this.state.replies.push({
        id,
        turnId: `activity:${watch.id}`,
        sourceMessageId: watch.messageId ?? binding.chatId,
        idempotencyKey: `tw-${digest(id).slice(0, 40)}`,
        status: "prepared",
        textDigest: digest(text),
        createdAt: nowIso(this.now),
        deliveryKind: "recovery-notice",
        text,
        sessionName: binding.sessionName,
        tone: "status",
        chatId: binding.chatId,
      });
    }
  }

  private queuePreparedOutboundAttempts(): void {
    for (const attempt of this.state.replies) {
      if (attempt.status !== "prepared"
        || !this.hasDurableOutboundPayload(attempt)
        || this.queuedOutboundAttemptIds.has(attempt.id)) continue;
      this.queuedOutboundAttemptIds.add(attempt.id);
      const deliver = async () => {
        await this.deliverOutboundAttempt(attempt.id);
      };
      const queued = this.outboundMutation.then(deliver, deliver);
      this.outboundMutation = queued.then(
        () => {
          this.queuedOutboundAttemptIds.delete(attempt.id);
        },
        (error) => {
          this.queuedOutboundAttemptIds.delete(attempt.id);
          process.stderr.write(
            `[feishu-bridge] durable outbound effect failed for ${attempt.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        },
      );
    }
  }

  private async deliverOutboundAttempt(attemptId: string): Promise<void> {
    const prepared = await this.serial(async (): Promise<FeishuOutboundReply | undefined> => {
      const attempt = this.state.replies.find((candidate) => candidate.id === attemptId);
      if (!attempt || attempt.status !== "prepared") return;
      if (!this.hasDurableOutboundPayload(attempt)) {
        attempt.status = "uncertain";
        attempt.completedAt = nowIso(this.now);
        attempt.error = "durable outbound payload is unavailable";
        const turn = this.state.turns.find((candidate) => candidate.id === attempt.turnId);
        if (attempt.deliveryKind === "turn-reply" && turn?.status === "replying") {
          turn.status = "recovery-required";
          turn.completedAt = attempt.completedAt;
          turn.error = attempt.error;
          const binding = this.state.bindings.find((candidate) => candidate.id === turn.bindingId);
          if (binding) this.markBindingStale(binding, turn.error);
        }
        this.persist();
        return;
      }
      const turn = this.state.turns.find((candidate) => candidate.id === attempt.turnId);
      if (attempt.deliveryKind === "turn-reply" && turn?.status !== "replying") {
        attempt.status = "uncertain";
        attempt.completedAt = nowIso(this.now);
        attempt.error = "turn state changed before its prepared reply was delivered";
        this.persist();
        return;
      }
      return structuredClone(attempt);
    });
    if (!prepared) return;

    try {
      const card = buildFeishuReplyCard(prepared.text!, prepared.sessionName!, prepared.tone!);
      const result = prepared.deliveryKind === "turn-reply"
        ? await this.lark.replyCard(
          prepared.sourceMessageId,
          card,
          prepared.idempotencyKey,
          prepared.replyMode!,
        )
        : await this.lark.sendCard(prepared.chatId!, card, prepared.idempotencyKey);
      await this.serial(async () => {
        const attempt = this.state.replies.find((candidate) => candidate.id === attemptId);
        if (!attempt || attempt.status !== "prepared") return;
        const turn = this.state.turns.find((candidate) => candidate.id === attempt.turnId);
        attempt.status = "sent";
        attempt.completedAt = nowIso(this.now);
        delete attempt.error;
        if (result.messageId) attempt.replyMessageId = result.messageId;
        if (attempt.deliveryKind === "turn-reply" && turn?.status === "replying") {
          turn.status = attempt.finalTurnStatus!;
          turn.completedAt = attempt.completedAt;
          const binding = this.state.bindings.find((candidate) => candidate.id === turn.bindingId);
          if (binding) {
            binding.lastActivityAt = attempt.completedAt;
            if (attempt.finalTurnStatus === "timed-out") {
              this.leases.delete(binding.id);
              this.markBindingStale(
                binding,
                "terminal turn was idle for 10 minutes without a certain drain disposition",
              );
            }
          }
        }
        this.persist();
        if (attempt.deliveryKind === "turn-reply" && turn) {
          this.queueProcessingReactionSettlement(
            turn.messageId,
            attempt.finalTurnStatus === "completed" ? "success" : "failure",
          );
        }
      });
    } catch (error) {
      await this.serial(async () => {
        const attempt = this.state.replies.find((candidate) => candidate.id === attemptId);
        if (!attempt || attempt.status !== "prepared") return;
        const turn = this.state.turns.find((candidate) => candidate.id === attempt.turnId);
        attempt.status = "uncertain";
        attempt.completedAt = nowIso(this.now);
        attempt.error = error instanceof Error ? error.message : String(error);
        if (attempt.deliveryKind === "turn-reply" && turn?.status === "replying") {
          turn.status = "recovery-required";
          turn.completedAt = attempt.completedAt;
          turn.error = "outbound Feishu reply disposition is uncertain";
          const binding = this.state.bindings.find((candidate) => candidate.id === turn.bindingId);
          if (binding) this.markBindingStale(binding, turn.error);
        }
        this.persist();
        if (attempt.deliveryKind === "turn-reply" && turn) {
          this.queueProcessingReactionSettlement(turn.messageId, "cancelled");
        }
      });
    }
  }

  private async drainOutboundEffects(): Promise<void> {
    while (true) {
      const pending = this.outboundMutation;
      await pending;
      if (pending === this.outboundMutation) return;
    }
  }

  private persist(): void {
    this.ensureRecoveryNoticeAttempts();
    this.store.write(this.state);
    this.queuePreparedOutboundAttempts();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
