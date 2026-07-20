import assert from "node:assert/strict";
import test from "node:test";

const authority = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/authority.js"
);
const runtimeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/runtime.js"
);
const producerModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerProducer.js"
);

let harnessNumber = 0;

function nextIdentity() {
  harnessNumber += 1;
  const suffix = String(harnessNumber);
  const binding = Object.freeze({
    hostId: `host-${suffix}`,
    hostEpoch: `host-epoch-${suffix}`,
    scopeId: `scope-${suffix}`,
    sessionId: `session-${suffix}`,
  });
  return {
    binding,
    authorityBinding: Object.freeze({ ...binding, timelineEpoch: `timeline-${suffix}` }),
    sourceEpoch: `codex-source-${suffix}`,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class ReducerRuntime {
  constructor(authorityBinding) {
    this.state = authority.createRelayAgentAuthorityState(authorityBinding);
  }

  calls = [];
  concurrent = 0;
  maxConcurrent = 0;
  beforeIngest = null;

  async ingestTrustedSource(binding, input) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const callNumber = this.calls.length + 1;
    this.calls.push(structuredClone(input));
    try {
      if (this.beforeIngest !== null) await this.beforeIngest(callNumber, input);
      const reduction = authority.reduceRelayAgentAuthority(this.state, input, binding);
      this.state = reduction.state;
      return { reduction, delivery: null };
    } finally {
      this.concurrent -= 1;
    }
  }
}

function freezeConfig(identity, options = {}) {
  const correlation = options.correlation === undefined
    ? null
    : Object.freeze({ commandIdForUserMessage: options.correlation });
  return Object.freeze({
    binding: Object.freeze({ ...identity.binding }),
    source: Object.freeze({ sourceEpoch: identity.sourceEpoch }),
    version: Object.freeze({
      provider: producerModule.CODEX_APP_SERVER_V2_PROVIDER,
      providerVersion: producerModule.CODEX_APP_SERVER_V2_PROVIDER_VERSION,
      schemaVersion: producerModule.CODEX_APP_SERVER_V2_SCHEMA_VERSION,
      ...options.version,
    }),
    limits: Object.freeze({
      maxInputBytes: 131_072,
      maxPendingEvents: 8,
      maxRememberedEvents: 128,
      ...options.limits,
    }),
    correlation,
  });
}

function harness(options = {}) {
  const identity = nextIdentity();
  const runtime = new ReducerRuntime(identity.authorityBinding);
  const ingress = new runtimeModule.RelayAgentTrustedSourceIngressLease(runtime);
  const producer = new producerModule.CodexAppServerV2EventProducer(ingress);
  if (options.enable !== false) producer.enable(freezeConfig(identity, options));
  return { identity, runtime, ingress, producer };
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function turn(id, status, overrides = {}) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1_700_000_000,
    completedAt: status === "inProgress" ? null : 1_700_000_001,
    durationMs: status === "inProgress" ? null : 1_000,
    ...overrides,
  };
}

function turnStarted(threadId = "thread-1", turnId = "turn-1", overrides = {}) {
  return bytes({
    method: "turn/started",
    params: { threadId, turn: turn(turnId, "inProgress", overrides) },
  });
}

function userItem(id = "user-item-1", text = "ship it", clientId = "client-message-1") {
  return {
    type: "userMessage",
    id,
    clientId,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function agentItem(id = "agent-item-1", text = "done") {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function itemCompleted(item, threadId = "thread-1", turnId = "turn-1", completedAtMs = 1_700_000_000_500) {
  return bytes({
    method: "item/completed",
    params: { item, threadId, turnId, completedAtMs },
  });
}

function turnCompleted(
  status = "completed",
  threadId = "thread-1",
  turnId = "turn-1",
  overrides = {},
) {
  return bytes({
    method: "turn/completed",
    params: {
      threadId,
      turn: turn(turnId, status, overrides),
    },
  });
}

function producerError(code) {
  return (error) => (
    error instanceof producerModule.CodexAppServerProducerError
    && error.code === code
  );
}

test("producer is default-off and freezes exact binding, source, release, and schema configuration", async () => {
  const disabled = harness({ enable: false });
  await assert.rejects(disabled.producer.accept(turnStarted()), producerError("DISABLED"));
  assert.equal(disabled.runtime.calls.length, 0);
  await disabled.producer.close();

  const enabled = harness();
  assert.deepEqual(enabled.producer.binding, enabled.identity.binding);
  assert.deepEqual(enabled.producer.source, { sourceEpoch: enabled.identity.sourceEpoch });
  assert.deepEqual(enabled.producer.version, {
    provider: "codex-app-server",
    providerVersion: "0.144.5",
    schemaVersion: 2,
  });
  assert.ok(Object.isFrozen(enabled.producer.binding));
  assert.ok(Object.isFrozen(enabled.producer.source));
  assert.ok(Object.isFrozen(enabled.producer.version));
  await enabled.producer.close();

  let getterCalls = 0;
  const getterIdentity = nextIdentity();
  const getterRuntime = new ReducerRuntime(getterIdentity.authorityBinding);
  const getterProducer = new producerModule.CodexAppServerV2EventProducer(
    new runtimeModule.RelayAgentTrustedSourceIngressLease(getterRuntime),
  );
  const getterBinding = {};
  Object.defineProperties(getterBinding, {
    hostId: { enumerable: true, configurable: false, get() { getterCalls += 1; return "host"; } },
    hostEpoch: { enumerable: true, configurable: false, value: "epoch", writable: false },
    scopeId: { enumerable: true, configurable: false, value: "scope", writable: false },
    sessionId: { enumerable: true, configurable: false, value: "session", writable: false },
  });
  Object.freeze(getterBinding);
  const getterConfig = freezeConfig(getterIdentity);
  const maliciousConfig = Object.freeze({ ...getterConfig, binding: getterBinding });
  assert.throws(() => getterProducer.enable(maliciousConfig), producerError("INVALID_CONFIG"));
  assert.equal(getterCalls, 0);
  assert.equal(getterProducer.state, "sealed");
  assert.equal(getterRuntime.calls.length, 0);

  const proxyIdentity = nextIdentity();
  const proxyRuntime = new ReducerRuntime(proxyIdentity.authorityBinding);
  const proxyProducer = new producerModule.CodexAppServerV2EventProducer(
    new runtimeModule.RelayAgentTrustedSourceIngressLease(proxyRuntime),
  );
  const proxyTarget = freezeConfig(proxyIdentity);
  assert.throws(
    () => proxyProducer.enable(new Proxy(proxyTarget, {})),
    producerError("INVALID_CONFIG"),
  );
  assert.equal(proxyProducer.state, "sealed");

  const versionIdentity = nextIdentity();
  const versionRuntime = new ReducerRuntime(versionIdentity.authorityBinding);
  const versionProducer = new producerModule.CodexAppServerV2EventProducer(
    new runtimeModule.RelayAgentTrustedSourceIngressLease(versionRuntime),
  );
  assert.throws(
    () => versionProducer.enable(freezeConfig(versionIdentity, {
      version: { providerVersion: "0.144.6" },
    })),
    producerError("INVALID_CONFIG"),
  );
  assert.equal(versionRuntime.calls.length, 0);
});

test("real Codex V2 message shapes produce one ordered run/turn and are accepted by the existing reducer", async () => {
  let correlationSeen = null;
  const h = harness({
    correlation(correlation) {
      correlationSeen = correlation;
      assert.ok(Object.isFrozen(correlation));
      return "command-1";
    },
  });
  const user = userItem();
  const agent = agentItem();

  const started = await h.producer.accept(turnStarted());
  const userResult = await h.producer.accept(itemCompleted(user));
  const duplicate = await h.producer.accept(itemCompleted(user));
  const agentResult = await h.producer.accept(itemCompleted(agent));
  const completed = await h.producer.accept(turnCompleted());

  assert.equal(started.sourceEventCount, 3);
  assert.equal(userResult.sourceEventCount, 1);
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(duplicate.firstSourceSeq, userResult.firstSourceSeq);
  assert.equal(duplicate.lastSourceSeq, userResult.lastSourceSeq);
  assert.equal(agentResult.sourceEventCount, 1);
  assert.equal(completed.sourceEventCount, 2);
  assert.equal(h.runtime.calls.length, 7);
  assert.equal(h.runtime.maxConcurrent, 1);
  assert.deepEqual(h.runtime.calls.map((event) => event.mutation.mutationType), [
    "source.started",
    "lifecycle.changed",
    "lifecycle.changed",
    "text_entry.appended",
    "text_entry.appended",
    "lifecycle.changed",
    "lifecycle.changed",
  ]);
  assert.deepEqual(h.runtime.calls.filter((event) => event.mutation.mutationType === "lifecycle.changed")
    .map((event) => [event.mutation.scope, event.mutation.state]), [
    ["run", "running"],
    ["turn", "running"],
    ["turn", "completed"],
    ["run", "completed"],
  ]);
  const entries = h.runtime.calls.filter((event) => event.mutation.mutationType === "text_entry.appended");
  assert.equal(entries[0].mutation.role, "user");
  assert.equal(entries[0].mutation.commandId, "command-1");
  assert.equal(entries[1].mutation.role, "agent");
  assert.equal(entries[1].mutation.commandId, null);
  assert.deepEqual(correlationSeen, {
    provider: "codex-app-server",
    providerVersion: "0.144.5",
    schemaVersion: 2,
    sourceEpoch: h.identity.sourceEpoch,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "user-item-1",
    clientId: "client-message-1",
  });
  assert.equal(h.runtime.state.entries.size, 2);
  assert.equal(h.runtime.state.activeTurns.size, 0);
  assert.ok(!h.runtime.calls.some((event) => event.mutation.state === "waiting_for_user"));
  const terminalJson = JSON.stringify(h.runtime.calls.slice(-2));
  assert.ok(!terminalJson.includes("ship it"));
  assert.ok(!terminalJson.includes("done"));
  await h.producer.close();
});

test("duplicate conflicts, ordering violations, cross thread or turn, schema drift, and oversize input seal", async (t) => {
  const cases = [
    {
      name: "item before turn",
      act: async (h) => h.producer.accept(itemCompleted(userItem())),
    },
    {
      name: "same upstream event id with a different fingerprint",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(turnStarted("thread-1", "turn-1", {
        startedAt: 1_700_000_002,
      })),
    },
    {
      name: "cross turn item",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(itemCompleted(userItem(), "thread-1", "turn-other")),
    },
    {
      name: "cross thread item",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(itemCompleted(userItem(), "thread-other", "turn-1")),
    },
    {
      name: "delta notification",
      act: async (h) => h.producer.accept(bytes({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "x" },
      })),
    },
    {
      name: "missing identity",
      act: async (h) => h.producer.accept(bytes({
        method: "turn/started",
        params: { turn: turn("turn-1", "inProgress") },
      })),
    },
    {
      name: "unknown turn status",
      act: async (h) => h.producer.accept(turnStarted("thread-1", "turn-1", {
        status: "futureStatus",
      })),
    },
    {
      name: "tool output",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(itemCompleted({
        type: "commandExecution",
        id: "tool-1",
        command: "print secret",
      })),
    },
    {
      name: "reasoning item",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(itemCompleted({
        type: "reasoning",
        id: "reasoning-1",
        summary: ["hidden"],
        content: ["hidden"],
      })),
    },
    {
      name: "unknown field",
      act: async (h) => h.producer.accept(bytes({
        method: "turn/started",
        params: { threadId: "thread-1", turn: turn("turn-1", "inProgress") },
        extra: true,
      })),
    },
    {
      name: "unknown item field",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(itemCompleted({
        ...userItem(),
        futureField: true,
      })),
    },
    {
      name: "non-null memory citation",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(itemCompleted({
        ...agentItem(),
        memoryCitation: { source: "unsupported" },
      })),
    },
    {
      name: "terminal payload replays items",
      prepare: async (h) => {
        await h.producer.accept(turnStarted());
        await h.producer.accept(itemCompleted(userItem()));
      },
      act: async (h) => h.producer.accept(turnCompleted(
        "completed",
        "thread-1",
        "turn-1",
        { items: [userItem()] },
      )),
    },
    {
      name: "interrupted terminal status",
      prepare: async (h) => h.producer.accept(turnStarted()),
      act: async (h) => h.producer.accept(turnCompleted("interrupted")),
    },
    {
      name: "oversize input",
      options: { limits: { maxInputBytes: 64 } },
      act: async (h) => h.producer.accept(Buffer.alloc(65, 0x20)),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = harness(scenario.options ?? {});
      if (scenario.prepare !== undefined) await scenario.prepare(h);
      const callsBefore = h.runtime.calls.length;
      await assert.rejects(scenario.act(h), (error) => (
        error instanceof producerModule.CodexAppServerProducerError
        && (error.code === "INVALID_EVENT" || error.code === "CAPACITY")
      ));
      assert.equal(h.producer.state, "sealed");
      assert.equal(h.runtime.calls.length, callsBefore);
      assert.ok(!h.runtime.calls.some((event) => event.mutation.state === "waiting_for_user"));
      await h.producer.close();
    });
  }
});

test("failed terminal mapping keeps provider error text private and never appends terminal transcript", async () => {
  const h = harness();
  const user = userItem("user-failed", "failed prompt", null);
  const agent = agentItem("agent-failed", "partial answer");
  await h.producer.accept(turnStarted());
  await h.producer.accept(itemCompleted(user));
  await h.producer.accept(itemCompleted(agent));
  await h.producer.accept(turnCompleted("failed", "thread-1", "turn-1", {
    error: {
      message: "raw provider secret message",
      codexErrorInfo: null,
      additionalDetails: "raw provider secret details",
    },
  }));

  const terminal = h.runtime.calls.slice(-2);
  assert.deepEqual(terminal.map((event) => event.mutation.state), ["failed", "failed"]);
  assert.deepEqual(terminal.map((event) => event.mutation.failure), [
    { code: "codex_turn_failed", summary: null },
    { code: "codex_turn_failed", summary: null },
  ]);
  const serialized = JSON.stringify(h.runtime.calls);
  assert.ok(!serialized.includes("raw provider secret message"));
  assert.ok(!serialized.includes("raw provider secret details"));
  const entries = h.runtime.calls.filter((event) => event.mutation.mutationType === "text_entry.appended");
  assert.equal(entries[0].mutation.role, "user");
  assert.equal(entries[0].mutation.commandId, null);
  assert.equal(h.runtime.state.entries.size, 2);
  await h.producer.close();
});

test("correlation reentry seals before the user entry reaches durable ingress", async () => {
  let producer;
  const h = harness({
    correlation() {
      void producer.accept(itemCompleted(agentItem("reentered-agent", "must not write")))
        .catch(() => undefined);
      return "command-reentered";
    },
  });
  producer = h.producer;
  await producer.accept(turnStarted());
  const callsBefore = h.runtime.calls.length;
  await assert.rejects(producer.accept(itemCompleted(userItem())), producerError("INVALID_EVENT"));
  assert.equal(producer.state, "sealed");
  assert.equal(h.runtime.calls.length, callsBefore);
  await producer.close();
});

test("close reentry from correlation seals before the user entry reaches durable ingress", async () => {
  let producer;
  let reenteredClose;
  const h = harness({
    correlation() {
      reenteredClose = producer.close();
      return "command-after-close";
    },
  });
  producer = h.producer;
  await producer.accept(turnStarted());
  const callsBefore = h.runtime.calls.length;
  await assert.rejects(producer.accept(itemCompleted(userItem())), producerError("INVALID_EVENT"));
  await reenteredClose;
  assert.equal(producer.state, "sealed");
  assert.equal(h.runtime.calls.length, callsBefore);
  await producer.close();
});

test("queue saturation and durable rejection seal with no retry", async (t) => {
  await t.test("bounded FIFO saturation", async () => {
    const entered = deferred();
    const release = deferred();
    const h = harness({ limits: { maxPendingEvents: 1 } });
    h.runtime.beforeIngest = async (callNumber) => {
      if (callNumber === 1) {
        entered.resolve();
        await release.promise;
      }
    };
    const started = h.producer.accept(turnStarted());
    await entered.promise;
    const duplicateStarted = h.producer.accept(turnStarted());
    await assert.rejects(
      h.producer.accept(itemCompleted(userItem())),
      producerError("CAPACITY"),
    );
    assert.equal(h.producer.state, "sealed");
    release.resolve();
    const [first, duplicate] = await Promise.all([started, duplicateStarted]);
    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(duplicate.firstSourceSeq, first.firstSourceSeq);
    assert.equal(duplicate.lastSourceSeq, first.lastSourceSeq);
    await h.producer.close();
    assert.equal(h.runtime.calls.length, 3);
    assert.equal(h.runtime.maxConcurrent, 1);
  });

  await t.test("durable rejection is not retried", async () => {
    const h = harness();
    h.runtime.beforeIngest = async (callNumber) => {
      if (callNumber === 2) throw new Error("durable secret");
    };
    await assert.rejects(h.producer.accept(turnStarted()), producerError("DURABLE_REJECTED"));
    assert.equal(h.producer.state, "sealed");
    await h.producer.close();
    assert.equal(h.runtime.calls.length, 2);
  });
});

test("close is a barrier for an accepted late completion and terminal mutations ingest exactly once", async () => {
  const h = harness();
  const agent = agentItem("agent-late", "late answer");
  await h.producer.accept(turnStarted());
  await h.producer.accept(itemCompleted(agent));

  const terminalEntered = deferred();
  const releaseTerminal = deferred();
  h.runtime.beforeIngest = async (callNumber) => {
    if (callNumber === 5) {
      terminalEntered.resolve();
      await releaseTerminal.promise;
    }
  };
  const completion = h.producer.accept(turnCompleted());
  await terminalEntered.promise;
  const close = h.producer.close();
  let closeSettled = false;
  void close.then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(closeSettled, false);
  await assert.rejects(h.producer.accept(turnCompleted()), producerError("CLOSING"));

  releaseTerminal.resolve();
  await Promise.all([completion, close]);
  assert.equal(h.producer.state, "closed");
  assert.equal(h.runtime.calls.length, 6);
  assert.deepEqual(h.runtime.calls.slice(-2).map((event) => event.mutation.scope), ["turn", "run"]);
  assert.equal(new Set(h.runtime.calls.map((event) => event.sourceEventId)).size, 6);
});
