import { createHash } from "node:crypto";

const MAX_APPEND_BYTES = 131_072;
const MAX_LINE_BYTES = 131_072;
const MAX_RECORDS_PER_APPEND = 256;
const MAX_REMEMBERED_APPENDS = 256;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_KEYS = 2_048;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 65_536;
const MAX_ABORT_REASON_BYTES = 1_024;

export const CODEX_ROLLOUT_JSONL_SOURCE_BUDGETS = Object.freeze({
  maxAppendBytes: MAX_APPEND_BYTES,
  maxLineBytes: MAX_LINE_BYTES,
  maxRecordsPerAppend: MAX_RECORDS_PER_APPEND,
  maxRememberedAppends: MAX_REMEMBERED_APPENDS,
  maxQueuedNotifications: 1,
  maxJsonDepth: MAX_JSON_DEPTH,
  maxJsonNodes: MAX_JSON_NODES,
  maxJsonKeys: MAX_JSON_KEYS,
});

export interface CodexRolloutFileProcessBinding {
  readonly providerVersion: "0.146.0";
  readonly threadId: string;
  readonly processIdentity: string;
  readonly sourceIdentity: string;
}

export interface CodexRolloutJsonlCut {
  readonly sourceIdentity: string;
  readonly offset: number;
}

export interface CodexRolloutJsonlAppend {
  readonly binding: CodexRolloutFileProcessBinding;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface CodexRolloutJsonlAppendChannel
  extends AsyncIterable<CodexRolloutJsonlAppend> {
  cancel(): void | Promise<void>;
}

export type CodexRolloutJsonlSourceErrorCode =
  | "BINDING_INVALID"
  | "BINDING_DRIFT"
  | "OFFSET_INVALID"
  | "OFFSET_GAP"
  | "REPLAY_MISMATCH"
  | "REPLAY_OUTSIDE_WINDOW"
  | "APPEND_LIMIT"
  | "LINE_LIMIT"
  | "PARTIAL_EOF"
  | "JSON_INVALID"
  | "JSON_LIMIT"
  | "RECORD_INVALID"
  | "TURN_ORDER_INVALID"
  | "OUTPUT_LIMIT";

export class CodexRolloutJsonlSourceError extends Error {
  readonly code: CodexRolloutJsonlSourceErrorCode;

  constructor(code: CodexRolloutJsonlSourceErrorCode) {
    super(code);
    this.name = "CodexRolloutJsonlSourceError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

interface ActiveTurn {
  readonly id: string;
  readonly startedAtSeconds: number;
}

interface RememberedAppend {
  readonly offset: number;
  readonly length: number;
  readonly digest: string;
}

function fail(code: CodexRolloutJsonlSourceErrorCode): never {
  throw new CodexRolloutJsonlSourceError(code);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function milliseconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("RECORD_INVALID");
  }
  return value as number;
}

function epochSeconds(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    fail("RECORD_INVALID");
  }
  return value as number;
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    !/[\0\r\n]/u.test(value)
  );
}

function timestampMs(value: unknown): number {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    fail("RECORD_INVALID");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("RECORD_INVALID");
  }
  return parsed;
}

function validateJsonBudget(root: unknown): void {
  let nodes = 0;
  let keys = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      fail("JSON_LIMIT");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isPlainObject(current.value)) {
      const entries = Object.entries(current.value);
      keys += entries.length;
      if (keys > MAX_JSON_KEYS) fail("JSON_LIMIT");
      for (const [, child] of entries) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeNotification(value: JsonObject): Uint8Array {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded.byteLength > MAX_LINE_BYTES + 1) fail("OUTPUT_LIMIT");
  return encoded;
}

export class CodexRolloutJsonlNotificationByteSource
  implements AsyncIterable<Uint8Array>
{
  readonly #binding: CodexRolloutFileProcessBinding;
  readonly #cut: CodexRolloutJsonlCut;
  readonly #channel: CodexRolloutJsonlAppendChannel;
  readonly #remembered = new Map<string, RememberedAppend>();
  readonly #rememberedOrder: string[] = [];
  #expectedOffset: number;
  #pending = Buffer.alloc(0);
  #pendingOffset: number;
  #activeTurn: ActiveTurn | null = null;
  #iteratorClaimed = false;
  #cancelled = false;
  #cancelPromise: Promise<void> | null = null;

  constructor(input: {
    readonly binding: CodexRolloutFileProcessBinding;
    readonly cut: CodexRolloutJsonlCut;
    readonly channel: CodexRolloutJsonlAppendChannel;
  }) {
    if (
      input.binding.providerVersion !== "0.146.0" ||
      !boundedIdentity(input.binding.threadId) ||
      !boundedIdentity(input.binding.processIdentity) ||
      !boundedIdentity(input.binding.sourceIdentity) ||
      input.cut.sourceIdentity !== input.binding.sourceIdentity ||
      !Number.isSafeInteger(input.cut.offset) ||
      input.cut.offset < 0 ||
      typeof input.channel?.[Symbol.asyncIterator] !== "function" ||
      typeof input.channel.cancel !== "function"
    ) {
      fail("BINDING_INVALID");
    }
    this.#binding = input.binding;
    this.#cut = Object.freeze({ ...input.cut });
    this.#channel = input.channel;
    this.#expectedOffset = this.#cut.offset;
    this.#pendingOffset = this.#cut.offset;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#iteratorClaimed) fail("BINDING_INVALID");
    this.#iteratorClaimed = true;
    return this.#run();
  }

  cancel(): Promise<void> {
    if (this.#cancelPromise !== null) return this.#cancelPromise;
    this.#cancelled = true;
    this.#cancelPromise = Promise.resolve().then(() => this.#channel.cancel());
    return this.#cancelPromise;
  }

  async *#run(): AsyncGenerator<Uint8Array> {
    try {
      for await (const append of this.#channel) {
        if (this.#cancelled) return;
        const lines = this.#admitAppend(append);
        if (lines === null) continue;
        for (const line of lines) {
          const notification = this.#mapRecord(line.bytes, line.offset);
          if (notification !== null) yield notification;
          if (this.#cancelled) return;
        }
      }
      if (!this.#cancelled && this.#pending.byteLength !== 0) fail("PARTIAL_EOF");
      if (!this.#cancelled && this.#activeTurn !== null) fail("TURN_ORDER_INVALID");
    } finally {
      await this.cancel();
    }
  }

  #admitAppend(
    append: CodexRolloutJsonlAppend,
  ): Array<{ readonly bytes: Uint8Array; readonly offset: number }> | null {
    if (append.binding !== this.#binding) fail("BINDING_DRIFT");
    if (!Number.isSafeInteger(append.offset) || append.offset < this.#cut.offset) {
      fail("OFFSET_INVALID");
    }
    if (!(append.bytes instanceof Uint8Array) || append.bytes.byteLength < 1) {
      fail("APPEND_LIMIT");
    }
    if (append.bytes.byteLength > MAX_APPEND_BYTES) fail("APPEND_LIMIT");

    const key = `${this.#binding.sourceIdentity}:${append.offset}`;
    const appendDigest = digest(append.bytes);
    if (append.offset < this.#expectedOffset) {
      const remembered = this.#remembered.get(key);
      if (remembered === undefined) fail("REPLAY_OUTSIDE_WINDOW");
      if (remembered.length !== append.bytes.byteLength || remembered.digest !== appendDigest) {
        fail("REPLAY_MISMATCH");
      }
      return null;
    }
    if (append.offset !== this.#expectedOffset) fail("OFFSET_GAP");

    this.#remembered.set(key, {
      offset: append.offset,
      length: append.bytes.byteLength,
      digest: appendDigest,
    });
    this.#rememberedOrder.push(key);
    if (this.#rememberedOrder.length > MAX_REMEMBERED_APPENDS) {
      const oldest = this.#rememberedOrder.shift();
      if (oldest !== undefined) this.#remembered.delete(oldest);
    }
    this.#expectedOffset += append.bytes.byteLength;

    const combined = Buffer.concat([this.#pending, Buffer.from(append.bytes)]);
    const lines: Array<{ bytes: Uint8Array; offset: number }> = [];
    let cursor = 0;
    while (cursor < combined.byteLength) {
      const lf = combined.indexOf(0x0a, cursor);
      if (lf < 0) break;
      if (lines.length >= MAX_RECORDS_PER_APPEND) fail("APPEND_LIMIT");
      const length = lf - cursor;
      if (length < 1 || length > MAX_LINE_BYTES) fail("LINE_LIMIT");
      lines.push({ bytes: combined.subarray(cursor, lf), offset: this.#pendingOffset + cursor });
      cursor = lf + 1;
    }
    this.#pending = combined.subarray(cursor);
    this.#pendingOffset += cursor;
    if (this.#pending.byteLength > MAX_LINE_BYTES) fail("LINE_LIMIT");
    return lines;
  }

  #mapRecord(bytes: Uint8Array, sourceOffset: number): Uint8Array | null {
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text) as unknown;
    } catch {
      fail("JSON_INVALID");
    }
    validateJsonBudget(parsed);
    if (!isPlainObject(parsed)) fail("RECORD_INVALID");
    if (parsed.type !== "event_msg") return null;
    if (!exactKeys(parsed, ["timestamp", "type", "payload"]) || !isPlainObject(parsed.payload)) {
      fail("RECORD_INVALID");
    }

    const payload = parsed.payload;
    if (payload.type === "task_started") {
      if (
        !boundedIdentity(payload.turn_id) ||
        !Number.isSafeInteger(payload.model_context_window) ||
        (payload.model_context_window as number) < 1 ||
        (payload.model_context_window as number) > 10_000_000 ||
        !boundedIdentity(payload.collaboration_mode_kind)
      ) {
        fail("RECORD_INVALID");
      }
      if (this.#activeTurn !== null) fail("TURN_ORDER_INVALID");
      timestampMs(parsed.timestamp);
      const startedAtSeconds = epochSeconds(payload.started_at);
      this.#activeTurn = { id: payload.turn_id, startedAtSeconds };
      return encodeNotification({
        method: "turn/started",
        params: {
          threadId: this.#binding.threadId,
          turn: {
            id: payload.turn_id,
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: startedAtSeconds,
            completedAt: null,
            durationMs: null,
          },
        },
      });
    }

    if (payload.type === "agent_message") {
      if (
        typeof payload.message !== "string" ||
        payload.message.length > MAX_TEXT_LENGTH ||
        /\0/u.test(payload.message) ||
        (payload.phase !== "commentary" && payload.phase !== "final_answer") ||
        payload.memory_citation !== null
      ) {
        fail("RECORD_INVALID");
      }
      if (this.#activeTurn === null) fail("TURN_ORDER_INVALID");
      const completedAtMs = timestampMs(parsed.timestamp);
      if (completedAtMs < this.#activeTurn.startedAtSeconds * 1_000) {
        fail("TURN_ORDER_INVALID");
      }
      const itemId = `rollout-${createHash("sha256")
        .update(this.#binding.sourceIdentity)
        .update("\0")
        .update(String(sourceOffset))
        .digest("hex")}`;
      return encodeNotification({
        method: "item/completed",
        params: {
          threadId: this.#binding.threadId,
          turnId: this.#activeTurn.id,
          item: {
            type: "agentMessage",
            id: itemId,
            text: payload.message,
            phase: payload.phase,
            memoryCitation: null,
          },
          completedAtMs,
        },
      });
    }

    if (payload.type === "task_complete") {
      if (
        !boundedIdentity(payload.turn_id) ||
        typeof payload.last_agent_message !== "string" ||
        payload.last_agent_message.length > MAX_TEXT_LENGTH ||
        /\0/u.test(payload.last_agent_message)
      ) {
        fail("RECORD_INVALID");
      }
      if (this.#activeTurn === null || payload.turn_id !== this.#activeTurn.id) {
        fail("TURN_ORDER_INVALID");
      }
      timestampMs(parsed.timestamp);
      const startedAtSeconds = epochSeconds(payload.started_at);
      const completedAtSeconds = epochSeconds(payload.completed_at);
      const durationMs = milliseconds(payload.duration_ms);
      const timeToFirstTokenMs = milliseconds(payload.time_to_first_token_ms);
      if (
        startedAtSeconds !== this.#activeTurn.startedAtSeconds ||
        completedAtSeconds < startedAtSeconds ||
        Math.abs(durationMs - (completedAtSeconds - startedAtSeconds) * 1_000) >= 1_000 ||
        timeToFirstTokenMs > durationMs
      ) {
        fail("TURN_ORDER_INVALID");
      }
      const active = this.#activeTurn;
      this.#activeTurn = null;
      return encodeNotification({
        method: "turn/completed",
        params: {
          threadId: this.#binding.threadId,
          turn: {
            id: active.id,
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: active.startedAtSeconds,
            completedAt: completedAtSeconds,
            durationMs,
          },
        },
      });
    }

    if (payload.type === "turn_aborted") {
      if (
        !exactKeys(payload, [
          "type", "turn_id", "reason", "started_at", "completed_at", "duration_ms",
        ])
        || !boundedIdentity(payload.turn_id)
        || typeof payload.reason !== "string"
        || payload.reason.length < 1
        || /\0/u.test(payload.reason)
        || Buffer.byteLength(payload.reason, "utf8") > MAX_ABORT_REASON_BYTES
      ) {
        fail("RECORD_INVALID");
      }
      if (this.#activeTurn === null || payload.turn_id !== this.#activeTurn.id) {
        fail("TURN_ORDER_INVALID");
      }
      timestampMs(parsed.timestamp);
      const startedAtSeconds = epochSeconds(payload.started_at);
      const completedAtSeconds = epochSeconds(payload.completed_at);
      const durationMs = milliseconds(payload.duration_ms);
      if (
        startedAtSeconds !== this.#activeTurn.startedAtSeconds
        || completedAtSeconds < startedAtSeconds
        || Math.abs(durationMs - (completedAtSeconds - startedAtSeconds) * 1_000) >= 1_000
      ) {
        fail("TURN_ORDER_INVALID");
      }
      const active = this.#activeTurn;
      this.#activeTurn = null;
      return encodeNotification({
        method: "turn/completed",
        params: {
          threadId: this.#binding.threadId,
          turn: {
            id: active.id,
            items: [],
            itemsView: "full",
            status: "failed",
            error: {
              message: "Codex rollout turn aborted",
              codexErrorInfo: null,
              additionalDetails: null,
            },
            startedAt: active.startedAtSeconds,
            completedAt: completedAtSeconds,
            durationMs,
          },
        },
      });
    }

    return null;
  }
}

export function createCodexRolloutJsonlNotificationByteSource(input: {
  readonly binding: CodexRolloutFileProcessBinding;
  readonly cut: CodexRolloutJsonlCut;
  readonly channel: CodexRolloutJsonlAppendChannel;
}): CodexRolloutJsonlNotificationByteSource {
  return new CodexRolloutJsonlNotificationByteSource(input);
}
