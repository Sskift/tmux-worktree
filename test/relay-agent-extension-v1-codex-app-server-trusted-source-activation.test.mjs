import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const activationModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerTrustedSourceActivation.js"
);

const OWNER = Object.freeze({ hostId: "host-activation", hostEpoch: "host-epoch-activation" });
const TARGET = Object.freeze({ scopeId: "scope-activation", sessionId: "session-activation" });
const BACKEND_INSTANCE_KEY = "backend-activation-exact";
const MANAGED_INCARNATION = `twinc2.${"a".repeat(43)}`;

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
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

function binding(overrides = {}) {
  return Object.freeze({
    ...OWNER,
    ...TARGET,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedIncarnation: MANAGED_INCARNATION,
    ...overrides,
  });
}

function controlledProcess(notificationSource, bindingValue = binding()) {
  return Object.freeze({ binding: bindingValue, notificationSource });
}

function resourceTarget(overrides = {}) {
  return {
    authorization: "evidence_only",
    hostEpoch: OWNER.hostEpoch,
    discoveryGeneration: "activation-discovery-generation",
    scopeId: TARGET.scopeId,
    processTarget: { kind: "local", targetId: "activation-process-target" },
    capabilities: [],
    sessionId: TARGET.sessionId,
    backendInstanceKey: BACKEND_INSTANCE_KEY,
    managedTarget: {
      name: "activation-managed-session",
      kind: "worktree",
      incarnation: MANAGED_INCARNATION,
    },
    ...overrides,
  };
}

function resolver(options = {}) {
  const calls = [];
  return {
    calls,
    port: {
      async captureToken(hostEpoch) {
        calls.push(["capture", hostEpoch]);
        if (options.capture !== undefined) return options.capture(hostEpoch);
        return {
          schemaVersion: 1,
          hostEpoch,
          resourceMappingDigest: "activation-resource-mapping",
          discoveryGeneration: "activation-discovery-generation",
        };
      },
      async resolveSession(token, scopeId, sessionId) {
        calls.push(["resolve", token, scopeId, sessionId]);
        if (options.resolve !== undefined) return options.resolve(token, scopeId, sessionId);
        return resourceTarget(options.target);
      },
    },
  };
}

function runtime(options = {}) {
  const calls = [];
  return {
    calls,
    value: {
      store: { owner: OWNER },
      async ingestTrustedSource(bindingValue, event) {
        calls.push([bindingValue, event]);
        if (options.ingest !== undefined) return options.ingest(bindingValue, event, calls.length);
        return { reduction: { disposition: "applied" }, delivery: null };
      },
    },
  };
}

class PushByteSource {
  iteratorCalls = 0;
  cancelCalls = 0;
  queue = [];
  pending = null;
  terminal = false;
  onIterator = null;
  onCancel = null;

  [Symbol.asyncIterator]() {
    this.iteratorCalls += 1;
    assert.equal(this.iteratorCalls, 1, "one bounded owner attaches the raw source");
    this.onIterator?.();
    return Object.freeze({ next: () => this.next() });
  }

  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.terminal) return Promise.resolve({ done: true, value: undefined });
    assert.equal(this.pending, null, "one raw read may be pending");
    this.pending = deferred();
    return this.pending.promise;
  }

  push(value) {
    const item = { done: false, value };
    if (this.pending === null) {
      this.queue.push(item);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.resolve(item);
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

  async cancel() {
    this.cancelCalls += 1;
    assert.equal(this.cancelCalls, 1, "raw source cancellation is exactly once");
    await this.onCancel?.();
    this.end();
  }
}

class FakeController {
  constructor(claim, order = null) {
    this.claim = claim;
    this.order = order;
  }

  calls = 0;

  async claimControlledProcess() {
    this.calls += 1;
    assert.equal(this.calls, 1, "activation claims the controller once");
    this.order?.push("controller.claim");
    return this.claim();
  }
}

function activationError(module, ...codes) {
  return (error) => (
    error instanceof module.CodexAppServerTrustedSourceActivationError
    && codes.includes(error.code)
  );
}

function createActivation(options = {}, module = activationModule) {
  const bytes = options.bytes ?? new PushByteSource();
  const runtimeHarness = options.runtime ?? runtime();
  const h2 = options.resolver ?? resolver();
  const controller = options.controller ?? new FakeController(
    () => controlledProcess(bytes, options.binding ?? binding()),
    options.order,
  );
  const activation = new module.CodexAppServerTrustedSourceActivation({
    controller,
    runtime: runtimeHarness.value,
    canonicalResourceResolver: h2.port,
  });
  return { activation, bytes, controller, runtime: runtimeHarness, h2 };
}

function turnStartedLine() {
  return Buffer.from(`${JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "activation-thread",
      turn: {
        id: "activation-turn",
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 1_700_000_000,
        completedAt: null,
        durationMs: null,
      },
    },
  })}\n`, "utf8");
}

test("activation is default-off, closed to caller authority input, and performs the one-shot handoff in order", async () => {
  const order = [];
  const bytes = new PushByteSource();
  bytes.onIterator = () => order.push("source.attach");
  const h2 = resolver({
    capture(hostEpoch) {
      order.push("h2.capture");
      return {
        schemaVersion: 1,
        hostEpoch,
        resourceMappingDigest: "activation-resource-mapping",
        discoveryGeneration: "activation-discovery-generation",
      };
    },
    resolve() {
      order.push("h2.resolve");
      return resourceTarget();
    },
  });
  const h = createActivation({ bytes, resolver: h2, order });

  assert.equal(h.controller.calls, 0);
  assert.equal(h.bytes.iteratorCalls, 0);
  assert.deepEqual(h.h2.calls, []);
  await assert.rejects(
    h.activation.activate(binding()),
    activationError(activationModule, "INVALID_CALL"),
  );
  assert.equal(h.controller.calls, 0, "caller binding is rejected before controller claim");

  await h.activation.activate();
  assert.deepEqual(order, [
    "controller.claim",
    "h2.capture",
    "h2.resolve",
    "source.attach",
  ]);
  assert.equal(h.bytes.iteratorCalls, 1);
  await assert.rejects(
    h.activation.activate(),
    activationError(activationModule, "ALREADY_ACTIVATED"),
  );

  const closed = h.activation.close();
  assert.equal(h.activation.close(), closed);
  await closed;
  assert.equal(h.bytes.cancelCalls, 1);
  await assert.rejects(h.activation.activate(), activationError(activationModule, "CLOSED"));

  const foreignController = new FakeController(() => controlledProcess(new PushByteSource()));
  assert.throws(() => new activationModule.CodexAppServerTrustedSourceActivation({
    controller: foreignController,
    runtime: runtime().value,
    canonicalResourceResolver: resolver().port,
    sourceEpoch: "caller-selected",
  }), TypeError);
  assert.equal(foreignController.calls, 0);
});

test("concurrent activate has one winner and never repeats controller, H2, or source admission", async () => {
  const claim = deferred();
  const bytes = new PushByteSource();
  const controller = new FakeController(() => claim.promise);
  const h = createActivation({ bytes, controller });

  const winner = h.activation.activate();
  await assert.rejects(
    h.activation.activate(),
    activationError(activationModule, "ACTIVATION_IN_PROGRESS"),
  );
  claim.resolve(controlledProcess(bytes));
  await winner;
  assert.equal(controller.calls, 1);
  assert.equal(h.h2.calls.length, 2);
  assert.equal(bytes.iteratorCalls, 1);
  await h.activation.close();
  assert.equal(bytes.cancelCalls, 1);
});

test("external close latches a pending controller and waits the late source cleanup", async () => {
  const claim = deferred();
  const bytes = new PushByteSource();
  const controller = new FakeController(() => claim.promise);
  const h = createActivation({ bytes, controller });

  const activating = h.activation.activate();
  const closing = h.activation.close();
  assert.equal(h.activation.close(), closing);
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  await nextTurn();
  assert.equal(closeSettled, false);
  assert.deepEqual(h.h2.calls, []);

  claim.resolve(controlledProcess(bytes));
  await assert.rejects(activating, activationError(activationModule, "CLOSED"));
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(bytes.iteratorCalls, 0);
  assert.equal(bytes.cancelCalls, 1);
  await assert.rejects(h.activation.activate(), activationError(activationModule, "CLOSED"));
});

test("controller, ingress, and raw-cancel callbacks may await activation close without self-wait", {
  timeout: 2_000,
}, async (t) => {
  await t.test("controller callback", async () => {
    const entered = deferred();
    const bytes = new PushByteSource();
    let activation;
    let callbackBarrier;
    const controller = new FakeController(async () => {
      const first = activation.close();
      const second = activation.close();
      assert.equal(first, second);
      callbackBarrier = first;
      await first;
      entered.resolve();
      return controlledProcess(bytes);
    });
    const h = createActivation({ bytes, controller });
    activation = h.activation;

    const activating = activation.activate();
    await entered.promise;
    const publicClose = activation.close();
    assert.notEqual(callbackBarrier, publicClose);
    await assert.rejects(activating, activationError(activationModule, "CLOSED"));
    await publicClose;
    assert.equal(bytes.cancelCalls, 1);
    assert.deepEqual(h.h2.calls, []);
  });

  await t.test("producer ingress callback", async () => {
    const entered = deferred();
    const release = deferred();
    let activation;
    let callbackBarrier;
    const runtimeHarness = runtime({
      async ingest() {
        const first = activation.close();
        const second = activation.close();
        assert.equal(first, second);
        callbackBarrier ??= first;
        await first;
        entered.resolve();
        await release.promise;
        return { reduction: { disposition: "applied" }, delivery: null };
      },
    });
    const h = createActivation({ runtime: runtimeHarness });
    activation = h.activation;
    await activation.activate();
    h.bytes.push(turnStartedLine());
    await entered.promise;

    const publicClose = activation.close();
    assert.notEqual(callbackBarrier, publicClose);
    let closeSettled = false;
    void publicClose.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await nextTurn();
    assert.equal(closeSettled, false, "external close waits the admitted producer/ingress FIFO");
    release.resolve();
    await publicClose;
    assert.equal(runtimeHarness.calls.length, 3);
    assert.equal(h.bytes.cancelCalls, 1);
  });

  await t.test("raw source cancel callback while H2 is pending", async () => {
    const capture = deferred();
    const captureEntered = deferred();
    const cancelEntered = deferred();
    let activation;
    let callbackBarrier;
    const bytes = new PushByteSource();
    bytes.onCancel = async () => {
      const first = activation.close();
      const second = activation.close();
      assert.equal(first, second);
      callbackBarrier = first;
      await first;
      cancelEntered.resolve();
    };
    const h2 = resolver({
      capture() {
        captureEntered.resolve();
        return capture.promise;
      },
    });
    const h = createActivation({ bytes, resolver: h2 });
    activation = h.activation;
    const activating = activation.activate();
    await captureEntered.promise;

    const publicClose = activation.close();
    await cancelEntered.promise;
    assert.notEqual(callbackBarrier, publicClose);
    capture.resolve({
      schemaVersion: 1,
      hostEpoch: OWNER.hostEpoch,
      resourceMappingDigest: "activation-resource-mapping",
      discoveryGeneration: "activation-discovery-generation",
    });
    await assert.rejects(activating, activationError(activationModule, "CLOSED"));
    await publicClose;
    assert.equal(bytes.iteratorCalls, 0);
    assert.equal(bytes.cancelCalls, 1);
  });

  await t.test("attach-stage close latches before the iterator can admit bytes", async () => {
    const bytes = new PushByteSource();
    let activation;
    let callbackBarrier;
    bytes.onIterator = () => {
      const first = activation.close();
      const second = activation.close();
      assert.equal(first, second);
      callbackBarrier = first;
    };
    const h = createActivation({ bytes });
    activation = h.activation;

    const activating = activation.activate();
    await assert.rejects(activating, activationError(activationModule, "CLOSED"));
    const publicClose = activation.close();
    assert.notEqual(callbackBarrier, publicClose);
    await publicClose;
    assert.equal(bytes.iteratorCalls, 1);
    assert.equal(bytes.cancelCalls, 1);
    assert.equal(h.runtime.calls.length, 0);
  });
});

test("H2 and attach failure seal once, preserve independent evidence, and drain only the current owner", async (t) => {
  await t.test("H2 mismatch never attaches and authority alone cancels", async () => {
    const h = createActivation({ resolver: resolver({
      target: { authorization: "process_authority" },
    }) });
    await assert.rejects(
      h.activation.activate(),
      activationError(activationModule, "ACTIVATION_FAILED"),
    );
    assert.deepEqual(h.h2.calls.map(([kind]) => kind), ["capture", "resolve"]);
    assert.equal(h.bytes.iteratorCalls, 0);
    assert.equal(h.bytes.cancelCalls, 1);
    await h.activation.close();
    await assert.rejects(h.activation.activate(), activationError(activationModule, "SEALED"));
  });

  await t.test("attach failure still closes both owners and never retries raw cleanup", async () => {
    class FailingAttachSource extends PushByteSource {
      [Symbol.asyncIterator]() {
        this.iteratorCalls += 1;
        throw new Error("private iterator failure");
      }
    }
    const bytes = new FailingAttachSource();
    const h = createActivation({ bytes });
    await assert.rejects(
      h.activation.activate(),
      activationError(activationModule, "ACTIVATION_FAILED"),
    );
    await assert.rejects(h.activation.close(), activationError(activationModule, "CLEANUP_FAILED"));
    assert.equal(bytes.iteratorCalls, 1);
    assert.equal(bytes.cancelCalls, 1);
    assert.equal(h.activation.close(), h.activation.close());
    await assert.rejects(h.activation.activate(), activationError(activationModule, "SEALED"));
  });
});

test("producer and source-close failure continue joint cleanup, seal permanently, and never retry cancel", async (t) => {
  await t.test("producer rejection", async () => {
    const h = createActivation();
    await h.activation.activate();
    h.bytes.push(Buffer.from("{}\n", "utf8"));
    await waitFor(() => h.bytes.cancelCalls === 1, "producer failure did not close the source");
    const closing = h.activation.close();
    assert.equal(h.activation.close(), closing);
    await closing;
    assert.equal(h.bytes.cancelCalls, 1);
    await assert.rejects(h.activation.activate(), activationError(activationModule, "SEALED"));
  });

  await t.test("raw cancel failure", async () => {
    class FailingCancelSource extends PushByteSource {
      async cancel() {
        this.cancelCalls += 1;
        assert.equal(this.cancelCalls, 1);
        this.end();
        throw new Error("private cancel failure");
      }
    }
    const bytes = new FailingCancelSource();
    const h = createActivation({ bytes });
    await h.activation.activate();
    const closing = h.activation.close();
    assert.equal(h.activation.close(), closing);
    await assert.rejects(closing, activationError(activationModule, "CLEANUP_FAILED"));
    assert.equal(bytes.cancelCalls, 1);
    assert.equal(h.activation.close(), closing);
    await assert.rejects(h.activation.activate(), activationError(activationModule, "SEALED"));
  });
});

test("isolated built activation entry shares the direct controller and raw-source registries in both directions", async (t) => {
  const isolated = mkdtempSync(join(tmpdir(), "tw-codex-trusted-activation-dist-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  const distRoot = resolve("dist/relay/extensions/agentTranscriptLifecycle/v1");
  const files = [
    "codexAppServerTrustedSourceActivation.js",
    "codexAppServerProcessControllerAuthority.js",
    "codexAppServerNotificationSource.js",
  ];
  for (const file of files) copyFileSync(join(distRoot, file), join(isolated, file));
  writeFileSync(join(isolated, "package.json"), '{"type":"module"}\n', "utf8");
  assert.deepEqual(readdirSync(isolated).sort(), [...files, "package.json"].sort());

  const isolatedActivation = await import(pathToFileURL(
    join(isolated, "codexAppServerTrustedSourceActivation.js"),
  ).href);
  const isolatedController = await import(pathToFileURL(
    join(isolated, "codexAppServerProcessControllerAuthority.js"),
  ).href);
  const isolatedSource = await import(pathToFileURL(
    join(isolated, "codexAppServerNotificationSource.js"),
  ).href);

  function directAuthority(controller) {
    return new isolatedController.CodexAppServerProcessControllerAuthority({
      controller,
      controlledSourceIssuer: { issue() { return Object.freeze(Object.create(null)); } },
      controlledSourceReceiver: Object.freeze({}),
    });
  }

  await t.test("direct controller then activation", async () => {
    const controller = new FakeController(() => controlledProcess(new PushByteSource()));
    const direct = directAuthority(controller);
    await direct.close();
    assert.throws(() => createActivation({ controller }, isolatedActivation), TypeError);
    assert.equal(controller.calls, 0);
  });

  await t.test("activation then direct controller", async () => {
    const controller = new FakeController(() => controlledProcess(new PushByteSource()));
    const h = createActivation({ controller }, isolatedActivation);
    await h.activation.close();
    assert.throws(() => directAuthority(controller), TypeError);
    assert.equal(controller.calls, 0);
  });

  await t.test("direct source then activation", async () => {
    const bytes = new PushByteSource();
    const direct = new isolatedSource.CodexAppServerNotificationSource(bytes);
    await direct.closeAndDrain();
    const h = createActivation({ bytes }, isolatedActivation);
    await assert.rejects(
      h.activation.activate(),
      activationError(isolatedActivation, "ACTIVATION_FAILED"),
    );
    assert.equal(bytes.cancelCalls, 1, "activation never recloses the direct owner's source");
    await h.activation.close();
    assert.equal(bytes.cancelCalls, 1);
  });

  await t.test("activation then direct source", async () => {
    const bytes = new PushByteSource();
    const h = createActivation({ bytes }, isolatedActivation);
    await h.activation.activate();
    await h.activation.close();
    assert.throws(
      () => new isolatedSource.CodexAppServerNotificationSource(bytes),
      (error) => (
        error instanceof isolatedSource.CodexAppServerNotificationSourceError
        && error.code === "SOURCE_ALREADY_OWNED"
      ),
    );
    assert.equal(bytes.cancelCalls, 1);
  });
});
