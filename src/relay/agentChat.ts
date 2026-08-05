import { createHash, randomUUID } from "node:crypto";
import {
  extractFeishuMarkedReply,
} from "../feishuBridge.js";
import type {
  TerminalControlLease,
  TerminalControlOwnershipView,
} from "../terminalControl/protocol.js";
import type { AgentChatTurnView } from "./v1/messages.js";

const TURN_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_TURN_OUTPUT_BYTES = 128 * 1024;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_TURNS_PER_SESSION = 200;
const POLL_INTERVAL_MS = 1_000;

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

export interface AgentChatControl {
  resolveTarget(sessionName: string): Promise<{ controlTargetId: string; controlEpoch: string }>;
  acquireLease(controlTargetId: string): Promise<TerminalControlLease>;
  sendAgentMessage(input: {
    lease: TerminalControlLease;
    operationId: string;
    pane: string;
    message: string;
    submit: boolean;
  }): Promise<{
    operationId: string;
    controlEpoch: string;
    fence: string;
    outputGeneration: string;
    outputCursor: number;
  }>;
  tailOutput(input: {
    controlTargetId: string;
    controlEpoch: string;
    outputGeneration: string;
    cursor: number;
    maxBytes?: number;
  }): Promise<{
    controlTargetId: string;
    controlEpoch: string;
    fence: string;
    ownerKind?: string;
    outputGeneration: string;
    cursor: number;
    dataBase64: string;
    nextCursor: number;
  }>;
  renderedSnapshot(input: {
    lease: TerminalControlLease;
    outputGeneration: string;
    pane: string;
    maxBytes?: number;
  }): Promise<{
    controlTargetId: string;
    controlEpoch: string;
    leaseId: string;
    fence: string;
    ownerKind: string;
    outputGeneration: string;
    pane: string;
    dataBase64: string;
    truncated: boolean;
  }>;
  ownershipStatus(controlTargetId: string): Promise<TerminalControlOwnershipView>;
}

export interface AgentChatTurnCallbacks {
  onEvent?: (turn: AgentChatTurnView) => void;
}

type AgentChatTurn = {
  turnId: string;
  session: string;
  userMessage: string;
  status: "working" | "replied" | "failed" | "recovery-required";
  reply?: string;
  error?: string;
  sentAt: string;
  completedAt?: string;
  steeredMessages: { message: string; sentAt: string }[];
  controlTargetId: string;
  controlEpoch: string;
  leaseId: string;
  fence: string;
  markerNonce: string;
  outputGeneration: string;
  cursor: number;
  output: string;
  outputRemainderBase64?: string;
  markerSeenAt?: string;
  deadlineAt: string;
  operationId: string;
  lease: TerminalControlLease;
  callbacks: AgentChatTurnCallbacks;
};

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

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

function retryableRenderedSnapshotObservation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; retryable?: unknown };
  if (typeof candidate.code === "string" && FATAL_RENDERED_SNAPSHOT_CODES.has(candidate.code)) {
    return false;
  }
  if (candidate.code === "RESOURCE_EXHAUSTED" || candidate.code === "INTERNAL") return true;
  if (candidate.code === "CONTROLLER_UNAVAILABLE") return candidate.retryable === true;
  return true;
}

function formatPrompt(
  session: string,
  markerNonce: string,
  content: string,
  mode: "start-or-steer" | "steer",
): string {
  const normalized = content.replace(/\0/g, "").replaceAll("[[", "[​[").trim();
  return boundedUtf8([
    `[Relay agent chat session: ${session}]`,
    mode === "steer"
      ? "Steering update for the current in-progress task. Incorporate it into that task; do not start a separate task."
      : "If a task is already in progress, treat this as a steering update to that task; otherwise start a new task.",
    normalized,
    "Reply only when ready. Build the delimiters by concatenating each quoted fragment without spaces.",
    `Open fragments: "[[" + "notify-group:" + "${markerNonce}" + "]]".`,
    `Close fragments: "[[" + "/notify-group:" + "${markerNonce}" + "]]".`,
    "Place only the public reply between the constructed delimiters.",
    "Do not place private terminal context inside those markers.",
  ].join("\n"), MAX_PROMPT_BYTES);
}

export class AgentChatEngine {
  private readonly control: AgentChatControl;
  private readonly sessions = new Map<string, AgentChatTurn[]>();
  private readonly pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly now: () => number;

  constructor(control: AgentChatControl, now: () => number = Date.now) {
    this.control = control;
    this.now = now;
  }

  listTurns(session: string, limit = MAX_TURNS_PER_SESSION): AgentChatTurnView[] {
    const turns = this.sessions.get(session) ?? [];
    return turns.slice(-limit).map((turn) => this.toView(turn));
  }

  disposeSession(session: string): void {
    const timer = this.pollTimers.get(session);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(session);
    }
    this.sessions.delete(session);
  }

  private toView(turn: AgentChatTurn): AgentChatTurnView {
    const view: AgentChatTurnView = {
      turnId: turn.turnId,
      session: turn.session,
      userMessage: turn.userMessage,
      status: turn.status,
      sentAt: turn.sentAt,
    };
    if (turn.reply !== undefined) view.reply = turn.reply;
    if (turn.error !== undefined) view.error = turn.error;
    if (turn.completedAt !== undefined) view.completedAt = turn.completedAt;
    if (turn.steeredMessages.length > 0) view.steeredMessages = turn.steeredMessages;
    return view;
  }

  private emit(turn: AgentChatTurn): void {
    turn.callbacks.onEvent?.(this.toView(turn));
  }

  private activeTurn(session: string): AgentChatTurn | undefined {
    const turns = this.sessions.get(session);
    if (!turns) return undefined;
    return turns.find((turn) => turn.status === "working");
  }

  private pushTurn(session: string, turn: AgentChatTurn): void {
    let turns = this.sessions.get(session);
    if (!turns) {
      turns = [];
      this.sessions.set(session, turns);
    }
    turns.push(turn);
    if (turns.length > MAX_TURNS_PER_SESSION) {
      turns.splice(0, turns.length - MAX_TURNS_PER_SESSION);
    }
  }

  async startOrSteerTurn(
    session: string,
    message: string,
    callbacks: AgentChatTurnCallbacks = {},
  ): Promise<{ turnId: string }> {
    const active = this.activeTurn(session);
    if (active) {
      return this.steerTurn(active, message, callbacks);
    }
    return this.startTurn(session, message, callbacks);
  }

  private async startTurn(
    session: string,
    message: string,
    callbacks: AgentChatTurnCallbacks,
  ): Promise<{ turnId: string }> {
    const target = await this.control.resolveTarget(session);
    const lease = await this.control.acquireLease(target.controlTargetId);
    const turnId = `turn-${digest(`${session}:${this.now()}:${randomUUID()}`).slice(0, 32)}`;
    const operationId = `relay-agent-chat-${digest(turnId).slice(0, 32)}`;
    const markerNonce = randomUUID().replaceAll("-", "");
    const turn: AgentChatTurn = {
      turnId,
      session,
      userMessage: message,
      status: "working",
      sentAt: nowIso(this.now),
      steeredMessages: [],
      controlTargetId: target.controlTargetId,
      controlEpoch: target.controlEpoch,
      leaseId: lease.leaseId,
      fence: lease.fence,
      markerNonce,
      outputGeneration: "",
      cursor: 0,
      output: "",
      deadlineAt: new Date(this.now() + TURN_IDLE_TIMEOUT_MS).toISOString(),
      operationId,
      lease,
      callbacks,
    };
    this.pushTurn(session, turn);
    callbacks.onEvent?.(this.toView(turn));

    const prompt = formatPrompt(session, markerNonce, message, "start-or-steer");
    try {
      const accepted = await this.control.sendAgentMessage({
        lease,
        operationId,
        pane: "0",
        message: prompt,
        submit: true,
      });
      if (accepted.operationId !== operationId
        || accepted.controlEpoch !== lease.controlEpoch
        || accepted.fence !== lease.fence) {
        const error = new Error("terminal input/output correlation was fenced before the turn started");
        Object.assign(error, { code: "RECOVERY_REQUIRED" });
        throw error;
      }
      turn.controlEpoch = accepted.controlEpoch;
      turn.fence = accepted.fence;
      turn.outputGeneration = accepted.outputGeneration;
      turn.cursor = accepted.outputCursor;
    } catch (error) {
      if (hasCode(error, "HANDOFF_PENDING")) {
        turn.status = "failed";
        turn.completedAt = nowIso(this.now);
        turn.error = "terminal input was not accepted because a controlled handoff started first";
      } else {
        turn.status = "recovery-required";
        turn.completedAt = nowIso(this.now);
        turn.error = error instanceof Error ? error.message : String(error);
      }
      callbacks.onEvent?.(this.toView(turn));
      throw error;
    }

    this.ensurePolling(session);
    return { turnId };
  }

  private async steerTurn(
    turn: AgentChatTurn,
    message: string,
    callbacks: AgentChatTurnCallbacks,
  ): Promise<{ turnId: string }> {
    if (turn.outputGeneration === undefined || turn.cursor === undefined) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "the active turn has no complete marker/output correlation for steering";
      callbacks.onEvent?.(this.toView(turn));
      throw new Error(turn.error);
    }
    const steeredAt = this.now();
    turn.steeredMessages.push({ message, sentAt: new Date(steeredAt).toISOString() });
    turn.deadlineAt = new Date(steeredAt + TURN_IDLE_TIMEOUT_MS).toISOString();

    const operationId = `relay-agent-chat-steer-${digest(`${turn.turnId}:${steeredAt}`).slice(0, 32)}`;
    const prompt = formatPrompt(turn.session, turn.markerNonce, message, "steer");
    try {
      const accepted = await this.control.sendAgentMessage({
        lease: turn.lease,
        operationId,
        pane: "0",
        message: prompt,
        submit: true,
      });
      if (accepted.operationId !== operationId
        || accepted.controlEpoch !== turn.controlEpoch
        || accepted.fence !== turn.fence
        || accepted.outputGeneration !== turn.outputGeneration
        || accepted.outputCursor < turn.cursor) {
        const error = new Error("terminal input/output correlation changed while steering the turn");
        Object.assign(error, { code: "RECOVERY_REQUIRED" });
        throw error;
      }
    } catch (error) {
      if (hasCode(error, "HANDOFF_PENDING")) {
        turn.status = "failed";
        turn.completedAt = nowIso(this.now);
        turn.error = "steering input was not accepted because a controlled handoff started first";
      } else {
        turn.status = "recovery-required";
        turn.completedAt = nowIso(this.now);
        turn.error = error instanceof Error ? error.message : String(error);
      }
      callbacks.onEvent?.(this.toView(turn));
      throw error;
    }

    callbacks.onEvent?.(this.toView(turn));
    return { turnId: turn.turnId };
  }

  private ensurePolling(session: string): void {
    if (this.pollTimers.has(session)) return;
    const timer = setInterval(() => {
      void this.pollSession(session).catch((error) => {
        process.stderr.write(`[agent-chat] poll failed for ${session}: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, POLL_INTERVAL_MS);
    this.pollTimers.set(session, timer);
  }

  private async pollSession(session: string): Promise<void> {
    const turns = this.sessions.get(session);
    if (!turns) return;
    const working = turns.filter((turn) => turn.status === "working");
    if (working.length === 0) {
      const timer = this.pollTimers.get(session);
      if (timer) {
        clearInterval(timer);
        this.pollTimers.delete(session);
      }
      return;
    }
    for (const turn of working) {
      await this.pollTurn(turn);
    }
  }

  private async pollTurn(turn: AgentChatTurn): Promise<void> {
    try {
      if (!turn.outputGeneration || turn.cursor === undefined) {
        throw new Error("turn has no committed terminal output correlation");
      }
      const target = await this.control.ownershipStatus(turn.controlTargetId);
      this.assertTurnAuthority(turn, target);
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
        this.assertTurnAuthority(turn, latest);
        const retainedCursor = Math.max(
          0,
          latest.outputCursor - 4 * 1024 * 1024,
        );
        if (retainedCursor <= turn.cursor) throw error;
        turn.cursor = retainedCursor;
        turn.output = "";
        delete turn.outputRemainderBase64;
        delete turn.markerSeenAt;
        const observedAt = this.now();
        turn.deadlineAt = new Date(observedAt + TURN_IDLE_TIMEOUT_MS).toISOString();
        return;
      }
      if (chunk.controlEpoch !== turn.controlEpoch
        || chunk.controlTargetId !== turn.controlTargetId
        || chunk.fence !== turn.fence
        || chunk.outputGeneration !== turn.outputGeneration
        || chunk.cursor !== turn.cursor) {
        throw new Error("terminal output correlation changed while polling the turn");
      }
      const raw = Buffer.from(chunk.dataBase64, "base64");
      if (raw.byteLength > 0) {
        const decoded = decodeUtf8Incrementally(turn.outputRemainderBase64, raw);
        const observedAt = this.now();
        turn.cursor = chunk.nextCursor;
        turn.output = boundedUtf8Tail(`${turn.output}${decoded.text}`, MAX_TURN_OUTPUT_BYTES);
        if (decoded.remainderBase64) turn.outputRemainderBase64 = decoded.remainderBase64;
        else delete turn.outputRemainderBase64;
        turn.deadlineAt = new Date(observedAt + TURN_IDLE_TIMEOUT_MS).toISOString();
      }
    } catch (error) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = error instanceof Error ? error.message : String(error);
      this.emit(turn);
      return;
    }

    if (this.now() >= Date.parse(turn.deadlineAt)) {
      turn.status = "recovery-required";
      turn.completedAt = nowIso(this.now);
      turn.error = "terminal has been idle without a complete reply; recovery required";
      this.emit(turn);
      return;
    }

    const rawMarked = extractFeishuMarkedReply(turn.output, turn.markerNonce);
    if (rawMarked.complete && !turn.markerSeenAt) {
      turn.markerSeenAt = nowIso(this.now);
    }
    if (!rawMarked.complete && !turn.markerSeenAt) return;

    let renderedMarked: ReturnType<typeof extractFeishuMarkedReply>;
    try {
      const snapshot = await this.control.renderedSnapshot({
        lease: turn.lease,
        outputGeneration: turn.outputGeneration,
        pane: "0",
        maxBytes: MAX_TURN_OUTPUT_BYTES,
      });
      if (snapshot.controlTargetId !== turn.controlTargetId
        || snapshot.controlEpoch !== turn.controlEpoch
        || snapshot.leaseId !== turn.leaseId
        || snapshot.fence !== turn.fence
        || snapshot.outputGeneration !== turn.outputGeneration
        || snapshot.pane !== "0") {
        throw new Error("rendered snapshot correlation changed while polling the turn");
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
      this.emit(turn);
      return;
    }

    if (!renderedMarked.reply || !renderedMarked.complete) return;
    turn.status = "replied";
    turn.reply = renderedMarked.reply;
    turn.completedAt = nowIso(this.now);
    this.emit(turn);
  }

  private assertTurnAuthority(turn: AgentChatTurn, target: TerminalControlOwnershipView): void {
    const stateAllowsSettling = target.state === "HELD"
      || (target.state === "DRAINING"
        && target.ownerKind === turn.lease.owner.kind
        && (target.nextOwnerKind === "dashboard" || target.nextOwnerKind === "local-cli")
        && !!target.handoffId);
    if (target.controlTargetId !== turn.controlTargetId
      || turn.lease.controlTargetId !== turn.controlTargetId
      || turn.lease.controlEpoch !== turn.controlEpoch
      || turn.controlEpoch !== target.controlEpoch
      || turn.leaseId !== turn.lease.leaseId
      || turn.fence !== turn.lease.fence
      || target.fence !== turn.lease.fence
      || !stateAllowsSettling
      || target.ownerKind !== turn.lease.owner.kind
      || target.outputGeneration !== turn.outputGeneration) {
      throw new Error("turn was fenced by ownership or output generation change");
    }
  }
}
