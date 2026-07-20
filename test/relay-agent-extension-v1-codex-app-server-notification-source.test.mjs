import assert from "node:assert/strict";
import test from "node:test";

const sourceModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerNotificationSource.js"
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

class PushByteSource {
  constructor() {
    this.cancelled = deferred();
  }

  iteratorCalls = 0;
  cancelCalls = 0;
  onCancel = null;
  queue = [];
  pending = null;
  terminal = false;

  [Symbol.asyncIterator]() {
    this.iteratorCalls += 1;
    if (this.iteratorCalls !== 1) throw new Error("byte source iterated twice");
    return {
      next: () => this.next(),
    };
  }

  next() {
    if (this.queue.length > 0) return this.consume(this.queue.shift());
    if (this.terminal) return Promise.resolve({ done: true, value: undefined });
    assert.equal(this.pending, null, "source permits only one pending read");
    this.pending = deferred();
    return this.pending.promise;
  }

  consume(item) {
    if (item.kind === "error") return Promise.reject(item.error);
    return Promise.resolve(item.result);
  }

  enqueue(item) {
    assert.equal(this.terminal, false, "source already ended");
    if (this.pending === null) {
      this.queue.push(item);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (item.kind === "error") pending.reject(item.error);
    else pending.resolve(item.result);
  }

  push(value) {
    this.enqueue({ kind: "result", result: { done: false, value } });
  }

  end() {
    if (this.terminal) return;
    this.terminal = true;
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve({ done: true, value: undefined });
    }
  }

  fail(error = new Error("private source failure")) {
    this.enqueue({ kind: "error", error });
  }

  async cancel() {
    this.cancelCalls += 1;
    assert.equal(this.cancelCalls, 1, "source cancellation is exactly once");
    await this.onCancel?.();
    this.end();
    this.cancelled.resolve();
  }
}

function notificationSourceError(...codes) {
  return (error) => (
    error instanceof sourceModule.CodexAppServerNotificationSourceError
    && codes.includes(error.code)
  );
}

test("source is default-off, claims one byte channel, and exposes an exact attach-compatible subscription", async () => {
  const bytes = new PushByteSource();
  const source = new sourceModule.CodexAppServerNotificationSource(bytes);
  assert.equal(source.state, "detached");
  assert.equal(bytes.iteratorCalls, 0);
  assert.equal(bytes.cancelCalls, 0);
  assert.throws(
    () => new sourceModule.CodexAppServerNotificationSource(bytes),
    notificationSourceError("SOURCE_ALREADY_OWNED"),
  );

  const subscription = source.attach(async () => {});
  assert.equal(source.state, "attached");
  assert.equal(bytes.iteratorCalls, 1);
  assert.equal(Object.isFrozen(subscription), true);
  assert.deepEqual(Reflect.ownKeys(subscription), ["closeAndDrain"]);
  assert.throws(
    () => source.attach(async () => {}),
    notificationSourceError("ALREADY_ATTACHED"),
  );
  const closing = subscription.closeAndDrain();
  assert.equal(subscription.closeAndDrain(), closing);
  await assert.rejects(closing, notificationSourceError("ALREADY_ATTACHED"));
  assert.equal(source.state, "sealed");
  assert.equal(bytes.cancelCalls, 1);
  assert.throws(
    () => source.attach(async () => {}),
    notificationSourceError("SEALED"),
  );
});

test("fragmented and coalesced LF frames reach the sink once, in order, as defensive copies", async () => {
  const bytes = new PushByteSource();
  const source = new sourceModule.CodexAppServerNotificationSource(bytes);
  const received = [];
  const subscription = source.attach(async (frame) => {
    received.push(frame);
  });

  const firstChunk = Buffer.from('{"method":"one"', "utf8");
  bytes.push(firstChunk);
  bytes.push(Buffer.from('}\n{"method":"two"}\n{"method":', "utf8"));
  const finalChunk = Buffer.from('"three"}\n', "utf8");
  bytes.push(finalChunk);
  await waitFor(() => received.length === 3);

  firstChunk.fill(0x78);
  finalChunk.fill(0x79);
  assert.deepEqual(received.map((frame) => Buffer.from(frame).toString("utf8")), [
    '{"method":"one"}',
    '{"method":"two"}',
    '{"method":"three"}',
  ]);
  assert.notEqual(received[0], received[1]);
  bytes.end();
  const closed = subscription.closeAndDrain();
  assert.equal(subscription.closeAndDrain(), closed);
  await closed;
  assert.equal(source.state, "closed");
  assert.equal(bytes.cancelCalls, 1);
});

test("the exact producer-sized frame is accepted while the next byte fails closed", async (t) => {
  const limit = sourceModule.CODEX_APP_SERVER_NOTIFICATION_SOURCE_LIMITS.maxFrameBytes;
  assert.equal(limit, 131_072);

  await t.test("exact maximum", async () => {
    const bytes = new PushByteSource();
    const source = new sourceModule.CodexAppServerNotificationSource(bytes);
    const received = [];
    const subscription = source.attach(async (frame) => { received.push(frame); });
    const chunk = new Uint8Array(limit + 1);
    chunk.fill(0x61, 0, limit);
    chunk[limit] = 0x0a;
    bytes.push(chunk);
    await waitFor(() => received.length === 1);
    assert.equal(received[0].byteLength, limit);
    bytes.end();
    await subscription.closeAndDrain();
    assert.equal(source.state, "closed");
  });

  await t.test("oversize across bounded fragments", async () => {
    const bytes = new PushByteSource();
    const source = new sourceModule.CodexAppServerNotificationSource(bytes);
    let sinkCalls = 0;
    const subscription = source.attach(async () => { sinkCalls += 1; });
    bytes.push(new Uint8Array(limit).fill(0x61));
    bytes.push(Uint8Array.from([0x62, 0x0a]));
    await waitFor(() => source.state === "sealed", "oversize frame was not sealed");
    await assert.rejects(
      subscription.closeAndDrain(),
      notificationSourceError("FRAME_TOO_LARGE"),
    );
    assert.equal(source.state, "sealed");
    assert.equal(source.failure, "FRAME_TOO_LARGE");
    assert.equal(sinkCalls, 0);
    assert.equal(bytes.cancelCalls, 1);
  });
});

test("hostile Uint8Array subclasses cannot bypass bounded intrinsic chunk normalization", async (t) => {
  const maxChunkBytes = sourceModule.CODEX_APP_SERVER_NOTIFICATION_SOURCE_LIMITS.maxChunkBytes;

  await t.test("a shadowed throwing length accessor is not consulted", async () => {
    class ThrowingLengthChunk extends Uint8Array {
      get byteLength() { throw new Error("private shadow getter"); }
    }
    const bytes = new PushByteSource();
    const source = new sourceModule.CodexAppServerNotificationSource(bytes);
    const received = [];
    const subscription = source.attach(async (frame) => { received.push(frame); });
    bytes.push(new ThrowingLengthChunk([0x6f, 0x6b, 0x0a]));
    await waitFor(() => received.length === 1);
    assert.equal(Buffer.from(received[0]).toString("utf8"), "ok");
    bytes.end();
    await subscription.closeAndDrain();
    assert.equal(source.state, "closed");
  });

  for (const scenario of [
    {
      name: "a lying length cannot admit an oversized allocation",
      makeChunk() {
        return new class extends Uint8Array {
          get byteLength() { return 1; }
        }(maxChunkBytes + 1);
      },
    },
    {
      name: "a detached source that would throw while copying fails closed",
      makeChunk() {
        const chunk = new class extends Uint8Array {
          get byteLength() { return 1; }
        }(1);
        structuredClone(chunk.buffer, { transfer: [chunk.buffer] });
        return chunk;
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const bytes = new PushByteSource();
      const source = new sourceModule.CodexAppServerNotificationSource(bytes);
      let sinkCalls = 0;
      const subscription = source.attach(async () => { sinkCalls += 1; });
      bytes.push(scenario.makeChunk());
      await waitFor(() => source.state === "sealed", `${scenario.name} was not sealed`);
      await assert.rejects(
        subscription.closeAndDrain(),
        notificationSourceError("INVALID_CHUNK"),
      );
      assert.equal(source.failure, "INVALID_CHUNK");
      assert.equal(sinkCalls, 0);
      assert.equal(bytes.cancelCalls, 1);
    });
  }
});

test("only one sink promise is in flight and close withdraws admission before cancel and drain", async () => {
  const bytes = new PushByteSource();
  const source = new sourceModule.CodexAppServerNotificationSource(bytes);
  const firstSink = deferred();
  let concurrent = 0;
  let maxConcurrent = 0;
  const received = [];
  const subscription = source.attach(async (frame) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    received.push(Buffer.from(frame).toString("utf8"));
    try {
      if (received.length === 1) await firstSink.promise;
    } finally {
      concurrent -= 1;
    }
  });

  bytes.push(Buffer.from("first\nsecond\n", "utf8"));
  await waitFor(() => received.length === 1);
  const closing = subscription.closeAndDrain();
  assert.equal(subscription.closeAndDrain(), closing);
  await bytes.cancelled.promise;
  assert.deepEqual(received, ["first"]);
  let settled = false;
  void closing.then(() => { settled = true; });
  await nextTurn();
  assert.equal(settled, false);

  firstSink.resolve();
  await closing;
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(received, ["first"]);
  assert.equal(source.state, "closed");
});

test("callback and source-cancel close reentry cannot cycle the public drain barrier", {
  timeout: 2_000,
}, async () => {
  const bytes = new PushByteSource();
  const source = new sourceModule.CodexAppServerNotificationSource(bytes);
  let subscription;
  const callbackBarriers = [];
  const cancelBarriers = [];
  bytes.onCancel = async () => {
    const first = subscription.closeAndDrain();
    const second = subscription.closeAndDrain();
    cancelBarriers.push(first, second);
    assert.equal(first, second);
    await first;
  };
  subscription = source.attach(async () => {
    const first = subscription.closeAndDrain();
    const second = subscription.closeAndDrain();
    callbackBarriers.push(first, second);
    assert.equal(first, second);
    await first;
  });

  bytes.push(Buffer.from("one\ntwo\n", "utf8"));
  await waitFor(() => callbackBarriers.length === 2);
  const publicBarrier = subscription.closeAndDrain();
  assert.equal(subscription.closeAndDrain(), publicBarrier);
  await publicBarrier;
  assert.equal(callbackBarriers.length, 2);
  assert.equal(cancelBarriers.length, 2);
  assert.equal(bytes.cancelCalls, 1);
  assert.equal(source.state, "closed");
});

test("invalid chunk, empty frame, partial EOF, and source error seal and cancel without delivery", async (t) => {
  const cases = [
    {
      name: "invalid chunk",
      expected: "INVALID_CHUNK",
      act(bytes) { bytes.push("not bytes"); },
    },
    {
      name: "zero-byte chunk",
      expected: "INVALID_CHUNK",
      act(bytes) { bytes.push(new Uint8Array()); },
    },
    {
      name: "empty LF frame",
      expected: "EMPTY_FRAME",
      act(bytes) { bytes.push(Uint8Array.from([0x0a])); },
    },
    {
      name: "partial EOF",
      expected: "PARTIAL_EOF",
      act(bytes) {
        bytes.push(Buffer.from('{"partial":true}', "utf8"));
        bytes.end();
      },
    },
    {
      name: "source error",
      expected: "SOURCE_FAILED",
      act(bytes) { bytes.fail(new Error("raw private source text")); },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const bytes = new PushByteSource();
      const source = new sourceModule.CodexAppServerNotificationSource(bytes);
      let sinkCalls = 0;
      const subscription = source.attach(async () => { sinkCalls += 1; });
      scenario.act(bytes);
      await waitFor(() => source.state === "sealed", `${scenario.name} was not sealed`);
      await assert.rejects(
        subscription.closeAndDrain(),
        notificationSourceError(scenario.expected),
      );
      assert.equal(source.state, "sealed");
      assert.equal(source.failure, scenario.expected);
      assert.equal(sinkCalls, 0);
      assert.equal(bytes.cancelCalls, 1);
    });
  }
});

test("sink rejection permanently seals with no retry, restart, fallback, or raw-byte echo", async () => {
  const bytes = new PushByteSource();
  const source = new sourceModule.CodexAppServerNotificationSource(bytes);
  const received = [];
  const subscription = source.attach(async (frame) => {
    received.push(Buffer.from(frame).toString("utf8"));
    throw new Error("sink private failure");
  });
  bytes.push(Buffer.from("raw-private-frame\nsecond-frame\n", "utf8"));

  await waitFor(() => source.state === "sealed", "sink rejection was not sealed");
  await assert.rejects(subscription.closeAndDrain(), (error) => {
    assert.equal(notificationSourceError("SINK_REJECTED")(error), true);
    assert.equal(error.message.includes("raw-private-frame"), false);
    assert.equal(error.message.includes("sink private failure"), false);
    return true;
  });
  assert.deepEqual(received, ["raw-private-frame"]);
  assert.equal(source.state, "sealed");
  assert.equal(source.failure, "SINK_REJECTED");
  assert.equal(bytes.iteratorCalls, 1);
  assert.equal(bytes.cancelCalls, 1);
  assert.throws(
    () => source.attach(async () => {}),
    notificationSourceError("SEALED"),
  );
});

test("closing before attach stops the source once and permanently rejects attach", async () => {
  const bytes = new PushByteSource();
  const source = new sourceModule.CodexAppServerNotificationSource(bytes);
  const closed = source.closeAndDrain();
  assert.equal(source.closeAndDrain(), closed);
  await closed;
  assert.equal(bytes.iteratorCalls, 0);
  assert.equal(bytes.cancelCalls, 1);
  assert.equal(source.state, "closed");
  assert.throws(
    () => source.attach(async () => {}),
    notificationSourceError("CLOSED"),
  );
});
