import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexRolloutJsonlSourceError,
  createCodexRolloutJsonlNotificationByteSource,
} from "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexRolloutJsonlNotificationByteSource.js";

class FakeAppendChannel {
  #queue = [];
  #waiter = null;
  #closed = false;
  cancelCount = 0;

  append(value) {
    assert.equal(this.#closed, false);
    if (this.#waiter !== null) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter({ done: false, value });
      return;
    }
    this.#queue.push(value);
  }

  cancel() {
    this.cancelCount += 1;
    this.#closed = true;
    if (this.#waiter !== null) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter({ done: true, value: undefined });
    }
  }

  get pendingWaiters() {
    return this.#waiter === null ? 0 : 1;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        assert.equal(this.#waiter, null);
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
    };
  }
}

function record(timestamp, payload) {
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}

test("the rollout follower maps a fragmented exact binding once and drains on binding drift", async () => {
  const binding = Object.freeze({
    providerVersion: "0.146.0",
    threadId: "thread-1",
    processIdentity: "pid:731:birth:99",
    sourceIdentity: "dev:7:ino:41",
  });
  const cut = Object.freeze({ sourceIdentity: binding.sourceIdentity, offset: 4_096 });
  const channel = new FakeAppendChannel();
  const source = createCodexRolloutJsonlNotificationByteSource({ binding, cut, channel });
  const iterator = source[Symbol.asyncIterator]();

  const jsonl = Buffer.from(
    [
      JSON.stringify({ timestamp: "2026-08-03T01:02:03.000Z", type: "session_meta", payload: {} }),
      record("2026-08-03T01:02:03.100Z", {
        type: "task_started",
        turn_id: "turn-9",
        started_at: Date.parse("2026-08-03T01:02:03.000Z") / 1_000,
        model_context_window: 258_400,
        collaboration_mode_kind: "default",
        bounded_future_field: "accepted",
      }),
      record("2026-08-03T01:02:03.200Z", {
        type: "agent_message",
        message: "working",
        phase: "commentary",
        memory_citation: null,
        bounded_future_field: 1,
      }),
      record("2026-08-03T01:02:03.300Z", {
        type: "agent_message",
        message: "done",
        phase: "final_answer",
        memory_citation: null,
      }),
      record("2026-08-03T01:10:18.158Z", {
        type: "task_complete",
        turn_id: "turn-9",
        started_at: Date.parse("2026-08-03T01:02:03.000Z") / 1_000,
        completed_at: Date.parse("2026-08-03T01:10:18.000Z") / 1_000,
        duration_ms: 495_158,
        time_to_first_token_ms: 100,
        last_agent_message: "done",
        bounded_future_field: { version: 1 },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  const split = 37;
  const first = jsonl.subarray(0, split);
  const second = jsonl.subarray(split);
  channel.append({ binding, offset: cut.offset, bytes: first });
  channel.append({ binding, offset: cut.offset, bytes: first });
  channel.append({ binding, offset: cut.offset + first.byteLength, bytes: second });
  const notifications = [];
  for (let index = 0; index < 4; index += 1) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    notifications.push(JSON.parse(Buffer.from(next.value).toString("utf8")));
  }

  const nextOffset = cut.offset + jsonl.byteLength;
  channel.append({
    binding: Object.freeze({ ...binding }),
    offset: nextOffset,
    bytes: Buffer.from("{}\n", "utf8"),
  });
  await assert.rejects(iterator.next(), (error) => {
    assert.ok(error instanceof CodexRolloutJsonlSourceError);
    assert.equal(error.code, "BINDING_DRIFT");
    return true;
  });

  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ["turn/started", "item/completed", "item/completed", "turn/completed"],
  );
  assert.equal(notifications[0].params.threadId, binding.threadId);
  assert.equal(notifications[0].params.turn.id, "turn-9");
  assert.equal(
    notifications[0].params.turn.startedAt,
    Date.parse("2026-08-03T01:02:03.000Z") / 1_000,
  );
  assert.equal(notifications[1].params.turnId, "turn-9");
  assert.equal(notifications[1].params.item.type, "agentMessage");
  assert.equal(notifications[1].params.item.phase, "commentary");
  assert.equal(notifications[2].params.item.phase, "final_answer");
  assert.notEqual(notifications[1].params.item.id, notifications[2].params.item.id);
  assert.equal(notifications[3].params.turn.status, "completed");
  assert.equal(
    notifications[3].params.turn.completedAt,
    Date.parse("2026-08-03T01:10:18.000Z") / 1_000,
  );
  assert.equal(notifications[3].params.turn.durationMs, 495_158);
  assert.equal(channel.cancelCount, 1);
  assert.equal(channel.pendingWaiters, 0);
});
