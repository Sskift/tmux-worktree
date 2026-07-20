import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const compositionModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexTrustedSourceComposition.js"
);
const runtimeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/runtime.js"
);
const storeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/store.js"
);
const continuityModule = await import("../dist/relay/v2/continuityAnchor.js");

const OWNER = Object.freeze({ hostId: "host-codex", hostEpoch: "host-epoch-codex" });
const TARGET = Object.freeze({ scopeId: "scope-codex", sessionId: "session-codex" });
const BACKEND_INSTANCE_KEY = "backend-codex-controlled-process";
const MANAGED_INCARNATION = `twinc2.${"c".repeat(43)}`;
const RETENTION_MS = 86_400_000;

function clone(value) {
  return structuredClone(value);
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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sequentialIds(prefix) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

class MemoryMonotonicCasAuthority {
  constructor(anchorId) {
    this.anchorId = anchorId;
    this.tokenSequence = 0;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "uninitialized",
      anchorId,
      casToken: "cas-0",
    };
    this.onCas = null;
  }

  async read(request) {
    assert.equal(request.anchorId, this.anchorId);
    assert.equal(request.signal instanceof AbortSignal, true);
    return clone(this.current);
  }

  async compareAndSwap(request) {
    assert.equal(request.anchorId, this.anchorId);
    assert.equal(request.signal instanceof AbortSignal, true);
    if (this.onCas !== null) return this.onCas(request, () => this.defaultCas(request));
    return this.defaultCas(request);
  }

  defaultCas(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        outcome: "conflict",
        current: clone(this.current),
      };
    }
    this.tokenSequence += 1;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "committed",
      anchorId: this.anchorId,
      casToken: `cas-${this.tokenSequence}`,
      checkpoint: clone(request.next),
    };
    return {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      outcome: "swapped",
      current: clone(this.current),
    };
  }
}

function resourceTarget(overrides = {}) {
  return {
    authorization: "evidence_only",
    hostEpoch: OWNER.hostEpoch,
    discoveryGeneration: "codex-discovery-generation",
    scopeId: TARGET.scopeId,
    processTarget: { kind: "local", targetId: "codex-process-target" },
    capabilities: [],
    sessionId: TARGET.sessionId,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedTarget: {
      name: "codex-managed-session",
      kind: "worktree",
      incarnation: MANAGED_INCARNATION,
    },
    ...overrides,
  };
}

function resolver(overrides = {}) {
  const calls = [];
  const port = {
    async captureToken(hostEpoch) {
      calls.push(["capture", hostEpoch]);
      if (overrides.captureError) throw overrides.captureError;
      return {
        schemaVersion: 1,
        hostEpoch,
        resourceMappingDigest: "codex-resource-mapping",
        discoveryGeneration: "codex-discovery-generation",
      };
    },
    async resolveSession(token, scopeId, sessionId) {
      calls.push(["resolve", clone(token), scopeId, sessionId]);
      if (overrides.resolveError) throw overrides.resolveError;
      return resourceTarget(overrides.target);
    },
  };
  return { calls, port };
}

function controlledSourceDescriptor(overrides = {}, behavior = {}) {
  const controller = {
    attachCalls: 0,
    closeCalls: 0,
    sink: null,
    lateCallback: null,
    async emit(notification) {
      assert.notEqual(this.sink, null, "controlled source must be attached before emit");
      return this.sink(notification);
    },
  };
  const descriptor = Object.freeze({
    ...OWNER,
    ...TARGET,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedIncarnation: MANAGED_INCARNATION,
    provider: "codex-app-server",
    providerVersion: "0.144.5",
    schemaVersion: 2,
    attach(eventSink) {
      controller.attachCalls += 1;
      controller.sink = eventSink;
      behavior.onAttach?.(eventSink, controller);
      if (behavior.subscription !== undefined) return behavior.subscription;
      return Object.freeze({
        async closeAndDrain() {
          controller.closeCalls += 1;
          await behavior.onClose?.(eventSink, controller);
          if (behavior.closeError !== undefined) throw behavior.closeError;
        },
      });
    },
    ...overrides,
  });
  return { descriptor, controller };
}

async function harness(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-codex-trusted-composition-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const anchorId = storeModule.relayAgentAuthorityContinuityAnchorId(OWNER);
  const continuityAuthority = new MemoryMonotonicCasAuthority(anchorId);
  const store = await storeModule.RelayAgentAuthorityStore.open({
    ...OWNER,
    home,
    eventReplayRetentionMs: RETENTION_MS,
    randomId: sequentialIds("codex-durable-id"),
    randomCursor: sequentialIds("codex-cursor"),
    continuityAnchor: {
      anchorId,
      authority: continuityAuthority,
      operationTimeoutMs: 500,
      maxPendingOperations: 16,
    },
  });
  const runtime = new runtimeModule.RelayAgentTranscriptLifecycleRuntime(store);
  const h2 = resolver(options.resolver);
  const issuer = options.issuer ?? new compositionModule.CodexControlledSourceLeaseIssuer();
  const receiver = options.receiver ?? issuer.createReceiver();
  const composition = new compositionModule.CodexTrustedSourceComposition({
    runtime,
    canonicalResourceResolver: h2.port,
    controlledSourceIssuer: issuer,
    controlledSourceReceiver: receiver,
  });
  return {
    home,
    continuityAuthority,
    store,
    runtime,
    h2,
    issuer,
    receiver,
    composition,
    issueSource(overrides = {}, behavior = {}) {
      const source = controlledSourceDescriptor(overrides, behavior);
      return {
        ...source,
        lease: issuer.issue(receiver, source.descriptor),
      };
    },
  };
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

function turnStarted(threadId = "thread-1", turnId = "turn-1") {
  return bytes({
    method: "turn/started",
    params: { threadId, turn: turn(turnId, "inProgress") },
  });
}

function userItem(id = "user-item-1", text = "ship it") {
  return {
    type: "userMessage",
    id,
    clientId: null,
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

function itemCompleted(item, threadId = "thread-1", turnId = "turn-1") {
  return bytes({
    method: "item/completed",
    params: { item, threadId, turnId, completedAtMs: 1_700_000_000_500 },
  });
}

function turnCompleted(threadId = "thread-1", turnId = "turn-1") {
  return bytes({
    method: "turn/completed",
    params: { threadId, turn: turn(turnId, "completed", { items: [] }) },
  });
}

function compositionError(...codes) {
  return (error) => (
    error instanceof compositionModule.CodexTrustedSourceCompositionError
    && codes.includes(error.code)
  );
}

async function records(store, suffix = "default") {
  const page = await store.snapshot({
    principalId: `principal-${suffix}`,
    clientInstanceId: `client-${suffix}`,
    target: TARGET,
    snapshotRequestId: `snapshot-${suffix}`,
    snapshotId: null,
    cursor: null,
    nextPageIndex: 0,
  });
  assert.equal(page.isLast, true);
  return page.records;
}

async function completeTurn(controller, ids = {}) {
  const threadId = ids.threadId ?? "thread-1";
  const turnId = ids.turnId ?? "turn-1";
  await controller.emit(turnStarted(threadId, turnId));
  await controller.emit(itemCompleted(
    userItem(ids.userId ?? "user-item-1", ids.userText ?? "ship it"),
    threadId,
    turnId,
  ));
  await controller.emit(itemCompleted(
    agentItem(ids.agentId ?? "agent-item-1", ids.agentText ?? "done"),
    threadId,
    turnId,
  ));
  await controller.emit(turnCompleted(threadId, turnId));
}

test("composition is default-off and construction performs no attach or durable ingest", async (t) => {
  const h = await harness(t);
  const source = h.issueSource();

  assert.equal(h.composition.state, "disabled");
  assert.equal(source.controller.attachCalls, 0);
  assert.deepEqual(await h.store.status(TARGET), {
    support: "unavailable",
    reason: "session_not_agent_managed",
    liveSource: "absent",
    activeSourceEpoch: null,
    timelineEpoch: null,
    currentAgentSeq: null,
    earliestReplaySeq: null,
    limits: null,
  });
  const closed = h.composition.close();
  assert.equal(h.composition.close(), closed);
  await closed;
  assert.equal(h.composition.state, "closed");
  assert.equal(source.controller.attachCalls, 0);
  await assert.rejects(h.composition.enable(source.lease), compositionError("CLOSED"));
});

test("host, session, backend, incarnation, and provider mismatches fail closed before attach", async (t) => {
  const cases = [
    { name: "host lineage", lease: { hostId: "other-host" } },
    { name: "host epoch", lease: { hostEpoch: "other-host-epoch" } },
    { name: "scope", lease: { scopeId: "other-scope" } },
    { name: "session", lease: { sessionId: "other-session" } },
    { name: "backend", lease: { backendInstanceKey: "other-backend" } },
    { name: "managed incarnation", lease: { managedIncarnation: `twinc2.${"d".repeat(43)}` } },
    { name: "provider", lease: { provider: "other-provider" } },
    { name: "provider version", lease: { providerVersion: "0.144.6" } },
    { name: "provider schema", lease: { schemaVersion: 3 } },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const h = await harness(subtest);
      const source = h.issueSource(scenario.lease);
      await assert.rejects(h.composition.enable(source.lease), compositionError(
        "INVALID_SOURCE_LEASE",
        "SOURCE_BINDING_MISMATCH",
      ));
      assert.equal(h.composition.state, "sealed");
      assert.equal(source.controller.attachCalls, 0);
      assert.equal((await h.store.status(TARGET)).support, "unavailable");
      await h.composition.close();
    });
  }
});

test("only an exact issuer- and receiver-bound opaque lease is accepted", async (t) => {
  await t.test("structurally identical descriptor is not a lease", async (subtest) => {
    const h = await harness(subtest);
    const source = controlledSourceDescriptor();
    await assert.rejects(
      h.composition.enable(source.descriptor),
      compositionError("INVALID_SOURCE_LEASE"),
    );
    assert.equal(source.controller.attachCalls, 0);
  });

  await t.test("copy and proxy cannot preserve opaque identity", async (subtest) => {
    const copiedHarness = await harness(subtest);
    const copiedSource = copiedHarness.issueSource();
    await assert.rejects(
      copiedHarness.composition.enable(Object.freeze({ ...copiedSource.lease })),
      compositionError("INVALID_SOURCE_LEASE"),
    );
    assert.equal(copiedSource.controller.attachCalls, 0);

    const proxyHarness = await harness(subtest);
    const proxySource = proxyHarness.issueSource();
    await assert.rejects(
      proxyHarness.composition.enable(new Proxy(proxySource.lease, {})),
      compositionError("INVALID_SOURCE_LEASE"),
    );
    assert.equal(proxySource.controller.attachCalls, 0);
  });

  await t.test("receiver and lease are one-shot", async (subtest) => {
    const h = await harness(subtest);
    assert.throws(() => new compositionModule.CodexTrustedSourceComposition({
      runtime: h.runtime,
      canonicalResourceResolver: resolver().port,
      controlledSourceIssuer: h.issuer,
      controlledSourceReceiver: h.receiver,
    }), TypeError);
    const source = h.issueSource();
    await h.composition.enable(source.lease);
    await assert.rejects(
      h.composition.enable(source.lease),
      compositionError("ALREADY_ENABLED"),
    );
    assert.equal(source.controller.attachCalls, 1);
    await h.composition.close();
  });

  await t.test("foreign receiver is rejected before attach", async (subtest) => {
    const h = await harness(subtest);
    const foreignReceiver = h.issuer.createReceiver();
    const foreignComposition = new compositionModule.CodexTrustedSourceComposition({
      runtime: h.runtime,
      canonicalResourceResolver: resolver().port,
      controlledSourceIssuer: h.issuer,
      controlledSourceReceiver: foreignReceiver,
    });
    const source = controlledSourceDescriptor();
    const foreignLease = h.issuer.issue(foreignReceiver, source.descriptor);
    await assert.rejects(
      h.composition.enable(foreignLease),
      compositionError("INVALID_SOURCE_LEASE"),
    );
    assert.equal(source.controller.attachCalls, 0);
    await foreignComposition.close();
  });

  await t.test("foreign issuer is rejected before attach", async (subtest) => {
    const h = await harness(subtest);
    const foreignIssuer = new compositionModule.CodexControlledSourceLeaseIssuer();
    const foreignReceiver = foreignIssuer.createReceiver();
    const foreignComposition = new compositionModule.CodexTrustedSourceComposition({
      runtime: h.runtime,
      canonicalResourceResolver: resolver().port,
      controlledSourceIssuer: foreignIssuer,
      controlledSourceReceiver: foreignReceiver,
    });
    const source = controlledSourceDescriptor();
    const foreignLease = foreignIssuer.issue(foreignReceiver, source.descriptor);
    await assert.rejects(
      h.composition.enable(foreignLease),
      compositionError("INVALID_SOURCE_LEASE"),
    );
    assert.equal(source.controller.attachCalls, 0);
    await foreignComposition.close();
  });

  await t.test("descriptor accessors and extra sourceEpoch never become receipts", async (subtest) => {
    const accessorHarness = await harness(subtest);
    const source = controlledSourceDescriptor();
    let getterCalls = 0;
    const descriptors = Object.getOwnPropertyDescriptors(source.descriptor);
    descriptors.sessionId = {
      enumerable: true,
      configurable: false,
      get() {
        getterCalls += 1;
        return TARGET.sessionId;
      },
    };
    const accessorDescriptor = Object.freeze(Object.defineProperties({}, descriptors));
    assert.throws(
      () => accessorHarness.issuer.issue(accessorHarness.receiver, accessorDescriptor),
      compositionError("INVALID_SOURCE_LEASE"),
    );
    assert.equal(getterCalls, 0);

    const extraHarness = await harness(subtest);
    const extra = controlledSourceDescriptor({ sourceEpoch: "caller-selected-source" });
    assert.throws(
      () => extraHarness.issuer.issue(extraHarness.receiver, extra.descriptor),
      compositionError("INVALID_SOURCE_LEASE"),
    );
  });

  await t.test("malformed subscription seals after the one allowed attach", async (subtest) => {
    const h = await harness(subtest);
    const source = h.issueSource({}, {
      subscription: Object.freeze({
        closeAndDrain: async () => {},
        extra: true,
      }),
    });
    await assert.rejects(h.composition.enable(source.lease), compositionError("ATTACH_FAILED"));
    assert.equal(source.controller.attachCalls, 1);
    assert.equal(h.composition.state, "sealed");
    await h.composition.close();
  });
});

test("exact binding persists the real Codex turn and entries through producer, ingress, runtime, and reducer", async (t) => {
  const h = await harness(t);
  const synchronousFirst = deferred();
  const source = h.issueSource({}, {
    onAttach(eventSink) {
      synchronousFirst.resolve(eventSink(turnStarted()));
    },
  });

  await h.composition.enable(source.lease);
  await synchronousFirst.promise;
  await source.controller.emit(itemCompleted(userItem()));
  await source.controller.emit(itemCompleted(agentItem()));
  await source.controller.emit(turnCompleted());

  const status = await h.store.status(TARGET);
  assert.equal(status.support, "available");
  assert.equal(status.currentAgentSeq, "7");
  assert.equal(status.activeSourceEpoch, h.composition.sourceEpoch);
  const materialized = await records(h.store, "exact");
  const entries = materialized.filter((record) => record.recordType === "text_entry");
  assert.deepEqual(entries.map((entry) => [entry.role, entry.text, entry.commandId]), [
    ["user", "ship it", null],
    ["agent", "done", null],
  ]);
  const lifecycle = materialized.filter((record) => record.recordType === "lifecycle");
  assert.deepEqual(Object.fromEntries(
    lifecycle.map((record) => [record.scope, record.state]),
  ), { run: "completed", turn: "completed" });
  assert.equal(source.controller.attachCalls, 1);
  await h.composition.close();
});

test("sourceEpoch is composition-generated, stable for one lease, and replaced with a new lease", async (t) => {
  const h = await harness(t);
  const firstSource = h.issueSource();
  await h.composition.enable(firstSource.lease);
  const firstEpoch = h.composition.sourceEpoch;
  assert.match(firstEpoch, /^[A-Za-z0-9_-]{43}$/);
  await completeTurn(firstSource.controller);
  assert.equal((await h.store.status(TARGET)).activeSourceEpoch, firstEpoch);
  assert.equal(h.composition.sourceEpoch, firstEpoch);
  await h.composition.close();

  const replacementResolver = resolver();
  const replacementReceiver = h.issuer.createReceiver();
  const replacement = new compositionModule.CodexTrustedSourceComposition({
    runtime: h.runtime,
    canonicalResourceResolver: replacementResolver.port,
    controlledSourceIssuer: h.issuer,
    controlledSourceReceiver: replacementReceiver,
  });
  const replacementDescriptor = controlledSourceDescriptor();
  const replacementSource = {
    ...replacementDescriptor,
    lease: h.issuer.issue(replacementReceiver, replacementDescriptor.descriptor),
  };
  await replacement.enable(replacementSource.lease);
  const replacementEpoch = replacement.sourceEpoch;
  assert.match(replacementEpoch, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(replacementEpoch, firstEpoch);
  await completeTurn(replacementSource.controller, {
    threadId: "thread-2",
    turnId: "turn-2",
    userId: "user-item-2",
    agentId: "agent-item-2",
  });
  assert.equal((await h.store.status(TARGET)).activeSourceEpoch, replacementEpoch);
  assert.equal(replacement.sourceEpoch, replacementEpoch);
  await replacement.close();
});

test("close withdraws callbacks before source drain and waits the producer/ingress durable FIFO barrier", async (t) => {
  const h = await harness(t);
  const late = { promise: null };
  const source = h.issueSource({}, {
    onClose(eventSink) {
      late.promise = eventSink(turnCompleted());
      void late.promise.catch(() => undefined);
    },
  });
  await h.composition.enable(source.lease);

  const durableEntered = deferred();
  const releaseDurable = deferred();
  h.continuityAuthority.onCas = async (request, commit) => {
    h.continuityAuthority.onCas = null;
    durableEntered.resolve();
    await releaseDurable.promise;
    return commit();
  };
  const accepted = source.controller.emit(turnStarted());
  await durableEntered.promise;

  const closing = h.composition.close();
  assert.equal(h.composition.close(), closing);
  let closeSettled = false;
  void closing.then(
    () => { closeSettled = true; },
    () => { closeSettled = true; },
  );
  await nextTurn();
  assert.equal(source.controller.closeCalls, 1);
  assert.equal(closeSettled, false);
  await assert.rejects(late.promise, compositionError("CLOSING", "CLOSED", "SEALED"));

  releaseDurable.resolve();
  await accepted;
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(source.controller.closeCalls, 1);
  assert.equal(h.composition.state, "closed");
  assert.equal((await h.store.status(TARGET)).currentAgentSeq, "3");
});

test("source close may await or then reentrant close without cycling the public barrier", {
  timeout: 2_000,
}, async (t) => {
  for (const style of ["await", "then"]) {
    await t.test(style, async (subtest) => {
      const h = await harness(subtest);
      const reentrantBarriers = [];
      const source = h.issueSource({}, {
        onClose() {
          const first = h.composition.close();
          const second = h.composition.close();
          reentrantBarriers.push(first, second);
          assert.equal(second, first);
          if (style === "then") return first.then(() => undefined);
          return (async () => {
            await first;
          })();
        },
      });
      await h.composition.enable(source.lease);

      const publicBarrier = h.composition.close();
      assert.equal(h.composition.close(), publicBarrier);
      await publicBarrier;

      assert.equal(reentrantBarriers.length, 2);
      assert.equal(source.controller.closeCalls, 1);
      assert.equal(h.composition.state, "closed");
      assert.equal(h.composition.close(), publicBarrier);
    });
  }
});

test("source close failure still drains the producer FIFO and permanently seals", async (t) => {
  const h = await harness(t);
  const source = h.issueSource({}, { closeError: new Error("private source failure") });
  await h.composition.enable(source.lease);

  const durableEntered = deferred();
  const releaseDurable = deferred();
  h.continuityAuthority.onCas = async (request, commit) => {
    h.continuityAuthority.onCas = null;
    durableEntered.resolve();
    await releaseDurable.promise;
    return commit();
  };
  const accepted = source.controller.emit(turnStarted());
  await durableEntered.promise;

  const closing = h.composition.close();
  const closingAssertion = assert.rejects(closing, compositionError("SOURCE_CLOSE_FAILED"));
  assert.equal(h.composition.close(), closing);
  await nextTurn();
  assert.equal(source.controller.closeCalls, 1);
  assert.equal(h.composition.state, "closing");

  releaseDurable.resolve();
  await accepted;
  await closingAssertion;
  assert.equal(source.controller.closeCalls, 1);
  assert.equal(h.composition.state, "sealed");
  assert.equal((await h.store.status(TARGET)).currentAgentSeq, "3");
  await assert.rejects(h.composition.enable(source.lease), compositionError("SEALED"));
});

test("H2 remains evidence-only and cannot substitute another authorization shape", async (t) => {
  const h = await harness(t, {
    resolver: { target: { authorization: "process_authority" } },
  });
  const source = h.issueSource();
  await assert.rejects(
    h.composition.enable(source.lease),
    compositionError("SOURCE_BINDING_MISMATCH"),
  );
  assert.deepEqual(h.h2.calls.map(([kind]) => kind), ["capture", "resolve"]);
  assert.equal(source.controller.attachCalls, 0);
  assert.equal(h.composition.state, "sealed");
  await h.composition.close();
});

test("attach-time close reentry returns one barrier, rejects the late callback, and terminates", async (t) => {
  const h = await harness(t);
  let reenteredClose = null;
  let lateCallback = null;
  const source = h.issueSource({}, {
    onAttach(eventSink) {
      reenteredClose = h.composition.close();
      assert.equal(h.composition.close(), reenteredClose);
      lateCallback = eventSink(turnStarted());
    },
  });

  await assert.rejects(h.composition.enable(source.lease), compositionError("CLOSED"));
  await assert.rejects(lateCallback, compositionError("CLOSING", "CLOSED", "SEALED"));
  await reenteredClose;
  assert.equal(source.controller.closeCalls, 1);
  assert.equal(h.composition.state, "closed");
});
