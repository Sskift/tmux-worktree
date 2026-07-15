import { createHash, randomUUID } from "node:crypto";
import {
  type CanonicalDrainRecord,
  type CanonicalHandoffResult,
  type CanonicalLeaseResult,
  type CanonicalTerminalControlClient,
  type CanonicalTerminalLease,
  type CanonicalTerminalOwner,
  type CanonicalTerminalOwnership,
} from "./canonicalTerminalControlClient.js";
import {
  FeishuBridgeStore,
  type FeishuBinding,
  type FeishuHandoffRecord,
  type FeishuOutboundReply,
  type FeishuTurn,
} from "./feishuBridgeStorage.js";
import {
  type FeishuInboundEvent,
  type FeishuLarkAdapter,
} from "./larkCliBridge.js";

const TURN_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_TURN_OUTPUT_BYTES = 128 * 1024;
const MAX_REPLY_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 64 * 1024;

interface BridgeState {
  bindings: FeishuBinding[];
  eventIds: string[];
  turns: FeishuTurn[];
  replies: FeishuOutboundReply[];
}

export interface CreateFeishuBindingInput {
  chatId: string;
  chatName: string;
  sessionName: string;
  createdBy: string;
  allowedSenderIds?: string[];
  mentionOnly?: boolean;
  dashboardLease?: CanonicalTerminalLease;
}

export interface FeishuBridgeSnapshot {
  instanceId: string;
  bindings: FeishuBinding[];
  activeTurns: FeishuTurn[];
  uncertainReplies: FeishuOutboundReply[];
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

export class FeishuBridge {
  readonly instanceId: string;
  private readonly control: CanonicalTerminalControlClient;
  private readonly lark: FeishuLarkAdapter;
  private readonly store: FeishuBridgeStore;
  private readonly now: () => number;
  private botOpenId?: string;
  private botMentionIds?: Set<string>;
  private readonly leases = new Map<string, CanonicalTerminalLease>();
  private state: BridgeState;
  private mutation = Promise.resolve();

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
  }

  initializeAfterRestart(): void {
    let changed = false;
    for (const binding of this.state.bindings) {
      if (binding.status === "active" || binding.status === "pausing") {
        binding.status = "stale";
        binding.staleReason = "bridge restarted; ownership was not recreated automatically";
        changed = true;
      }
    }
    for (const turn of this.state.turns) {
      if (turn.status === "prepared" || turn.status === "awaiting" || turn.status === "replying") {
        turn.status = "recovery-required";
        turn.error = "bridge continuity was lost before the turn completed";
        turn.completedAt = nowIso(this.now);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  snapshot(): FeishuBridgeSnapshot {
    return {
      instanceId: this.instanceId,
      bindings: structuredClone(this.state.bindings),
      activeTurns: structuredClone(this.state.turns.filter((turn) =>
        turn.status === "prepared" || turn.status === "awaiting" || turn.status === "replying")),
      uncertainReplies: structuredClone(this.state.replies.filter((reply) => reply.status === "uncertain")),
    };
  }

  createBinding(input: CreateFeishuBindingInput): Promise<FeishuBinding> {
    return this.serial(async () => {
      if (input.mentionOnly !== false) await this.ensureBotOpenId();
      this.validateCreateInput(input);
      if (this.state.bindings.some((binding) => binding.chatId === input.chatId)) {
        throw new Error("this Feishu chat already has a binding");
      }
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
          replyAsCard: false,
          includeQuotedContext: false,
        },
        allowedSenderIds,
        createdAt,
        createdBy: input.createdBy,
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
      return structuredClone(binding);
    });
  }

  pauseBinding(bindingId: string, force = false): Promise<FeishuBinding> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      const turn = this.activeTurn(binding.id);
      if (turn && !force) throw new Error("binding has an active Feishu turn; force is required to cancel it");
      if (turn) {
        turn.status = "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = "cancelled by explicit force pause";
      }
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
          throw error;
        }
      }
      this.leases.delete(binding.id);
      binding.status = "paused";
      delete binding.staleReason;
      binding.lastActivityAt = nowIso(this.now);
      this.persist();
      return structuredClone(binding);
    });
  }

  resumeBinding(bindingId: string): Promise<FeishuBinding> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      if (this.activeTurn(binding.id)) throw new Error("binding still has an unresolved turn");
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
      this.persist();
      return structuredClone(binding);
    });
  }

  removeBinding(bindingId: string, force = false): Promise<void> {
    return this.serial(async () => {
      const binding = this.requireBinding(bindingId);
      const turn = this.activeTurn(binding.id);
      if (turn && !force) throw new Error("binding has an active turn; force is required to unbind");
      if (turn) {
        turn.status = "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = "cancelled by explicit unbind";
      }
      const lease = this.leases.get(binding.id);
      if (lease) {
        try {
          await this.releaseLease(lease);
        } catch (error) {
          this.leases.delete(binding.id);
          this.markBindingStale(binding, `unbind release disposition is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          this.persist();
          throw error;
        }
      }
      this.leases.delete(binding.id);
      this.state.bindings = this.state.bindings.filter((candidate) => candidate.id !== bindingId);
      this.persist();
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
      if (turn && !force) {
        throw new Error("a Feishu turn is active; wait for its certain reply or choose force takeover");
      }
      if (turn) {
        turn.status = "cancelled";
        turn.completedAt = nowIso(this.now);
        turn.error = "cancelled before explicit force takeover";
      }
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
      if (this.activeTurn(binding.id)) {
        this.rememberEvent(event.event_id);
        await this.safeInform(event.message_id, "当前终端正在处理上一条群消息，请等待回复后再试。", `busy-${event.event_id}`);
        return;
      }

      const target = await this.control.ownershipStatus(binding.controlTargetId);
      if (this.isFeishuDrainingView(binding, lease, target)) {
        this.rememberEvent(event.event_id);
        await this.safeInform(
          event.message_id,
          "当前终端正在安全交接给本地控制端，本条消息未注入终端。",
          `handoff-${event.event_id}`,
        );
        await this.reconcileBindingHandoff(binding, lease);
        return;
      }
      this.assertLeaseView(binding, lease, target);
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
        deadlineAt: new Date(this.now() + TURN_TIMEOUT_MS).toISOString(),
      };
      this.state.turns.push(turn);
      this.rememberEvent(event.event_id, false);
      this.persist();
      const text = this.formatPrompt(binding, markerNonce, senderId, detail.text || event.content);
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
      turn.status = "awaiting";
      binding.lastActivityAt = nowIso(this.now);
      this.persist();
    });
  }

  renewLeases(): Promise<void> {
    return this.serial(async () => {
      let changed = false;
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
          if (turn) {
            turn.status = "recovery-required";
            turn.completedAt = nowIso(this.now);
            turn.error = "terminal ownership lease renewal failed";
          }
          changed = true;
        }
      }
      if (changed) this.persist();
    });
  }

  pollTurns(): Promise<void> {
    return this.serial(async () => {
      const turns = this.state.turns.filter((turn) => turn.status === "awaiting");
      for (const turn of turns) await this.pollTurn(turn);
    });
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
    await this.serial(async () => {
      for (const [bindingId, lease] of [...this.leases]) {
        const binding = this.state.bindings.find((candidate) => candidate.id === bindingId);
        const turn = binding ? this.activeTurn(binding.id) : undefined;
        if (turn) {
          turn.status = "recovery-required";
          turn.completedAt = nowIso(this.now);
          turn.error = "bridge stopped before the terminal turn reached a certain disposition";
          if (binding) this.markBindingStale(binding, turn.error);
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
    });
  }

  private async pollTurn(turn: FeishuTurn): Promise<void> {
    const binding = this.state.bindings.find((candidate) => candidate.id === turn.bindingId);
    const lease = this.leases.get(turn.bindingId);
    if (!binding || binding.status !== "active" || !lease) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "binding ownership disappeared while awaiting output";
      this.persist();
      return;
    }
    if (this.now() >= Date.parse(turn.deadlineAt)) {
      await this.completeReply(turn, binding, "等待终端回复超时；本轮状态不确定，需要在本地恢复后才能继续。", "timed-out");
      if (turn.status === "timed-out") {
        this.leases.delete(binding.id);
        this.markBindingStale(binding, "terminal turn timed out without a certain drain disposition");
        this.persist();
      }
      return;
    }
    try {
      if (turn.outputGeneration === undefined || turn.cursor === undefined) {
        throw new Error("Feishu turn has no committed terminal output correlation");
      }
      const target = await this.control.ownershipStatus(turn.controlTargetId);
      this.assertTurnAuthority(turn, lease, target);
      const chunk = await this.control.tailOutput({
        controlTargetId: turn.controlTargetId,
        controlEpoch: turn.controlEpoch,
        outputGeneration: turn.outputGeneration,
        cursor: turn.cursor,
        maxBytes: OUTPUT_TAIL_BYTES,
      });
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
        turn.cursor = chunk.nextCursor;
        turn.output = boundedUtf8Tail(`${turn.output}${decoded.text}`, MAX_TURN_OUTPUT_BYTES);
        if (decoded.remainderBase64) turn.outputRemainderBase64 = decoded.remainderBase64;
        else delete turn.outputRemainderBase64;
        turn.lastOutputAt = nowIso(this.now);
        this.persist();
      }
    } catch (error) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = error instanceof Error ? error.message : String(error);
      this.markBindingStale(binding, turn.error);
      this.persist();
      return;
    }
    if (!turn.markerNonce) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "Feishu turn has no persisted marker correlation";
      this.markBindingStale(binding, turn.error);
      this.persist();
      return;
    }
    const marked = extractFeishuMarkedReply(turn.output, turn.markerNonce);
    if (marked.reply && !turn.markerSeenAt) {
      turn.markerSeenAt = nowIso(this.now);
      this.persist();
    }
    if (!marked.reply || !marked.complete) return;
    await this.completeReply(turn, binding, marked.reply, "completed");
  }

  private async completeReply(
    turn: FeishuTurn,
    binding: FeishuBinding,
    text: string,
    finalStatus: "completed" | "timed-out",
  ): Promise<void> {
    const lease = this.leases.get(binding.id);
    if (!lease) throw new Error("Feishu lease disappeared before outbound reply");
    const target = await this.control.ownershipStatus(turn.controlTargetId);
    this.assertTurnAuthority(turn, lease, target);
    let attempt = this.state.replies.find((candidate) => candidate.id === turn.outboundAttemptId);
    if (!attempt) {
      attempt = {
        id: turn.outboundAttemptId,
        turnId: turn.id,
        sourceMessageId: turn.messageId,
        idempotencyKey: `tw-${digest(turn.outboundAttemptId).slice(0, 40)}`,
        status: "prepared",
        textDigest: digest(text),
        createdAt: nowIso(this.now),
      };
      this.state.replies.push(attempt);
    }
    if (attempt.textDigest !== digest(text)) throw new Error("outbound reply payload changed after preparation");
    turn.status = "replying";
    this.persist();
    try {
      const result = await this.lark.reply(turn.messageId, text, attempt.idempotencyKey);
      const latest = await this.control.ownershipStatus(turn.controlTargetId);
      this.assertTurnAuthority(turn, lease, latest);
      attempt.status = "sent";
      attempt.completedAt = nowIso(this.now);
      if (result.messageId) attempt.replyMessageId = result.messageId;
      turn.status = finalStatus;
      turn.completedAt = nowIso(this.now);
      binding.lastActivityAt = turn.completedAt;
      this.persist();
    } catch (error) {
      attempt.status = "uncertain";
      attempt.completedAt = nowIso(this.now);
      attempt.error = error instanceof Error ? error.message : String(error);
      turn.status = "recovery-required";
      turn.completedAt = attempt.completedAt;
      turn.error = "outbound Feishu reply disposition is uncertain";
      this.markBindingStale(binding, turn.error);
      this.persist();
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
      if (turn) {
        turn.status = "recovery-required";
        turn.completedAt = nowIso(this.now);
        turn.error = `terminal ownership entered ${target.state} during Feishu handoff reconciliation`;
      }
      this.markBindingStale(binding, `terminal ownership entered ${target.state} during Feishu handoff reconciliation`);
      this.persist();
      return;
    }
    if (this.activeTurn(binding.id)) return;

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
      throw new Error("Feishu binding no longer owns the exact terminal target");
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
  ): string {
    const normalized = content.replace(/\0/g, "").replaceAll("[[", "[\u200b[").trim();
    return boundedUtf8([
      `[Feishu group: ${binding.chatName}; sender: ${senderId}]`,
      normalized,
      "Reply for the group only when ready. Build the delimiters by concatenating each quoted fragment without spaces.",
      `Open fragments: "[[" + "notify-group:" + "${markerNonce}" + "]]".`,
      `Close fragments: "[[" + "/notify-group:" + "${markerNonce}" + "]]".`,
      "Place only the public reply between the constructed delimiters.",
      "Do not place private terminal context inside those markers.",
    ].join("\n"), MAX_PROMPT_BYTES);
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

  private async safeInform(messageId: string, text: string, idempotencySeed: string): Promise<void> {
    try {
      await this.lark.reply(messageId, text, `tw-${digest(idempotencySeed).slice(0, 40)}`);
    } catch {}
  }

  private persist(): void {
    this.store.write(this.state);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
