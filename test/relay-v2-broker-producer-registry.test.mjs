import assert from "node:assert/strict";
import test from "node:test";

const producerModule = await import("../dist/relay/v2/brokerProducerRegistry.js");

function brokerResult(actions = []) {
  return { accepted: true, actions };
}

function hostAction(transportId, reason = "test_close") {
  return {
    kind: "close_host",
    transportId,
    closeCode: 1013,
    reason,
  };
}

function sendHostAction(transportId, frame) {
  return {
    kind: "send_host",
    transportId,
    frame,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function createPort(overrides = {}) {
  const calls = { apply: [], forceTerminal: [] };
  const port = Object.create(null);
  Object.defineProperties(port, {
    apply: {
      configurable: true,
      writable: true,
      value: function apply(actions, fence) {
        const call = { receiver: this, actions, fence };
        calls.apply.push(call);
        return overrides.apply
          ? overrides.apply.call(this, actions, fence, call)
          : fence.mayApply() ? "applied" : "rejected";
      },
    },
    forceTerminal: {
      configurable: true,
      writable: true,
      value: function forceTerminal(failure, fence) {
        const call = { receiver: this, failure, fence };
        calls.forceTerminal.push(call);
        return overrides.forceTerminal
          ? overrides.forceTerminal.call(this, failure, fence, call)
          : fence.mayApply() ? "applied" : "rejected";
      },
    },
  });
  return { port, calls };
}

function applyFromInternal(registry, target, actions = [hostAction(target.transportId)]) {
  return registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.apply(target, actions),
  );
}

test("registration captures exactly two own data methods once and preserves their receiver", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  let getterReads = 0;
  const accessor = Object.create(null);
  Object.defineProperties(accessor, {
    apply: {
      get() {
        getterReads += 1;
        return () => "applied";
      },
    },
    forceTerminal: { value: () => "applied" },
  });
  assert.throws(
    () => registry.registerHostProducer("accessor", accessor),
    /invalid .* producer port/i,
  );
  assert.equal(getterReads, 0);

  const extra = createPort().port;
  Object.defineProperty(extra, "extra", { value: true });
  assert.throws(() => registry.registerHostProducer("extra", extra));

  const symbol = createPort().port;
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  assert.throws(() => registry.registerHostProducer("symbol", symbol));

  class PrototypePort {
    apply() { return "applied"; }
    forceTerminal() { return "applied"; }
  }
  assert.throws(() => registry.registerHostProducer("prototype", new PrototypePort()));

  const transparentProxy = new Proxy(createPort().port, {});
  assert.throws(
    () => registry.registerHostProducer("proxy", transparentProxy),
    /invalid .* producer port/i,
  );
  const proxiedMethod = createPort().port;
  proxiedMethod.apply = new Proxy(proxiedMethod.apply, {});
  assert.throws(
    () => registry.registerHostProducer("proxy-method", proxiedMethod),
    /invalid .* producer port/i,
  );

  const observedReceivers = new WeakSet();
  const valid = createPort({
    apply(actions, fence) {
      observedReceivers.add(this);
      assert.equal(Object.isFrozen(actions), true);
      assert.equal(Object.isFrozen(actions[0]), true);
      return fence.mayApply() ? "applied" : "rejected";
    },
  });
  const registration = registry.registerHostProducer("captured", valid.port);
  valid.port.apply = () => {
    throw new Error("replacement method must not be read");
  };

  assert.equal(applyFromInternal(registry, registration.target), "applied");
  assert.equal(valid.calls.apply.length, 1);
  assert.equal(observedReceivers.has(valid.port), true);
  assert.equal(valid.calls.apply[0].receiver, valid.port);
});

test("pending close closes target admission but keeps the exact producer source until settlement", async () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const sourcePort = createPort();
  const targetPort = createPort();
  const source = registry.registerHostProducer("source", sourcePort.port);
  const target = registry.registerHostProducer("target", targetPort.port);
  const barrier = deferred();

  source.beginClose(barrier.promise);
  assert.equal(
    applyFromInternal(registry, source.target, [hostAction("source")]),
    "rejected",
    "ordinary target admission closes synchronously",
  );

  let pendingInvokeCount = 0;
  assert.equal(source.runBrokerCall(
    () => {
      pendingInvokeCount += 1;
      return brokerResult();
    },
    (_result, handoff) => handoff.apply(target.target, [hostAction("target")]),
  ), "applied");
  assert.equal(pendingInvokeCount, 1);
  assert.throws(() => registry.registerHostProducer("source", createPort().port));

  barrier.resolve();
  await settlePromises();
  assert.equal(source.runBrokerCall(
    () => {
      pendingInvokeCount += 1;
      return brokerResult();
    },
    () => "applied",
  ), "rejected");
  assert.equal(pendingInvokeCount, 1, "settled close rejects before invoke");

  const replacement = registry.registerHostProducer("source", createPort().port);
  assert.notEqual(replacement.target.generation, source.target.generation);
  assert.equal(applyFromInternal(registry, source.target), "rejected");
  assert.equal(applyFromInternal(registry, replacement.target), "applied");
});

test("settled close waits for an already-active source partition before retirement", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const producerPort = createPort();
  const producer = registry.registerHostProducer("closing-source", producerPort.port);
  let nestedInvoked = false;

  assert.equal(producer.runBrokerCall(
    () => brokerResult(),
    (_result, handoff) => {
      assert.throws(
        () => producer.beginClose({}),
        /native Promise/,
        "an invalid external barrier settles fail-closed",
      );
      assert.equal(producer.runBrokerCall(
        () => {
          nestedInvoked = true;
          return brokerResult();
        },
        () => "applied",
      ), "rejected");
      assert.equal(nestedInvoked, false);
      assert.throws(() => (
        registry.registerHostProducer("closing-source", createPort().port)
      ));
      assert.equal(handoff.forceTerminal({
        kind: "producer_failure",
        reason: "close_barrier_invalid",
      }), "applied", "the already-active exact source may finish terminal cleanup");
      return "applied";
    },
  ), "applied");

  const replacement = registry.registerHostProducer("closing-source", createPort().port);
  assert.notEqual(replacement.target.generation, producer.target.generation);
});

test("an admitted exact target effect may establish its own close barrier", async () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const barrier = deferred();
  let registration;
  let nestedInvoked = false;
  const producerPort = createPort({
    apply(_actions, fence) {
      assert.equal(fence.mayApply(), true);
      registration.beginClose(barrier.promise);
      assert.equal(
        fence.mayApply(),
        true,
        "the installed exact effect remains valid across its own close cut",
      );
      assert.equal(registration.runBrokerCall(
        () => {
          nestedInvoked = true;
          return brokerResult();
        },
        (_result, handoff) => handoff.apply(
          registration.target,
          [hostAction("effect-close")],
        ),
      ), "rejected", "closing rejects new ordinary target admission");
      assert.equal(nestedInvoked, true, "the pending barrier keeps exact source cleanup alive");
      assert.throws(() => registry.registerHostProducer("effect-close", createPort().port));
      assert.equal(fence.mayApply(), true);
      return "applied";
    },
  });
  registration = registry.registerHostProducer("effect-close", producerPort.port);
  const firstGeneration = registration.target.generation;

  assert.equal(applyFromInternal(registry, registration.target), "applied");
  assert.throws(() => registry.registerHostProducer("effect-close", createPort().port));

  barrier.resolve();
  await settlePromises();
  const replacement = registry.registerHostProducer("effect-close", createPort().port);
  assert.ok(BigInt(replacement.target.generation) > BigInt(firstGeneration));
});

test("internal Broker calls allocate before invoke and retire on every exit path", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const targetPort = createPort();
  const target = registry.registerHostProducer("internal-target", targetPort.port);
  let outerPartitionId;
  let nestedPartitionId;
  assert.equal(registry.runInternalBrokerCall(
    () => {
      assert.equal(registry.runInternalBrokerCall(
        () => brokerResult(),
        (_nestedResult, nestedHandoff) => {
          nestedPartitionId = nestedHandoff.source.partitionId;
          return "applied";
        },
      ), "applied");
      return brokerResult();
    },
    (_outerResult, outerHandoff) => {
      outerPartitionId = outerHandoff.source.partitionId;
      return "applied";
    },
  ), "applied");
  assert.ok(
    BigInt(outerPartitionId) < BigInt(nestedPartitionId),
    "outer source partition is allocated before its invoke callback reenters",
  );

  let invoked = false;
  let captured;

  assert.equal(registry.runInternalBrokerCall(
    () => {
      invoked = true;
      return brokerResult();
    },
    (result, handoff) => {
      assert.equal(invoked, true);
      assert.equal(result.accepted, true);
      assert.equal(handoff.source.kind, "internal");
      captured = handoff;
      return handoff.apply(target.target, [hostAction("internal-target")]);
    },
  ), "applied");
  assert.equal(captured.apply(target.target, [hostAction("internal-target")]), "rejected");
  assert.equal(targetPort.calls.apply.length, 1, "captured handoff is not replayable");

  assert.throws(() => registry.runInternalBrokerCall(
    () => { throw new Error("invoke failed"); },
    () => "applied",
  ), /invoke failed/);

  let thrownHandoff;
  assert.throws(() => registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => {
      thrownHandoff = handoff;
      throw new Error("partition failed");
    },
  ), /partition failed/);
  assert.equal(
    thrownHandoff.apply(target.target, [hostAction("internal-target")]),
    "rejected",
  );

  let asyncHandoff;
  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    async (_result, handoff) => {
      asyncHandoff = handoff;
      return "applied";
    },
  ), "rejected", "Promise partition receipts are never assimilated");
  assert.equal(asyncHandoff.apply(target.target, [hostAction("internal-target")]), "rejected");
  assert.equal(applyFromInternal(registry, target.target), "applied");
});

test("opaque invoke results must be synchronous plain data before handoff is exposed", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  let thenGetterReads = 0;
  const ownThenable = brokerResult();
  Object.defineProperty(ownThenable, "then", {
    get() {
      thenGetterReads += 1;
      return () => undefined;
    },
  });
  const inheritedThenable = Object.create({ then() {} });
  inheritedThenable.accepted = true;
  inheritedThenable.actions = [];
  const throwingProxy = new Proxy(brokerResult(), {
    ownKeys() { throw new Error("opaque result trap"); },
  });
  const accessorResult = {};
  Object.defineProperty(accessorResult, "accepted", {
    get() { throw new Error("opaque result getter"); },
  });
  Object.defineProperty(accessorResult, "actions", { value: [] });
  const invalidResults = [
    Promise.resolve(brokerResult()),
    ownThenable,
    inheritedThenable,
    new Proxy(brokerResult(), {}),
    throwingProxy,
    accessorResult,
    [],
    null,
    () => brokerResult(),
  ];
  let partitionCalls = 0;
  for (const invalid of invalidResults) {
    assert.equal(registry.runInternalBrokerCall(
      () => invalid,
      () => {
        partitionCalls += 1;
        return "applied";
      },
    ), "rejected");
  }
  assert.equal(partitionCalls, 0);
  assert.equal(thenGetterReads, 0, "thenable detection never reads the property");

  const opaque = Object.assign(Object.create(null), { arbitrary: "caller-owned" });
  assert.equal(registry.runInternalBrokerCall(
    () => opaque,
    (received) => {
      partitionCalls += 1;
      assert.equal(received, opaque);
      return "applied";
    },
  ), "applied", "registry does not semantically parse an otherwise safe result");
  assert.equal(partitionCalls, 1);
});

test("rejected native Promises are observed at every synchronous return boundary", async () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const unhandled = [];
  const recordUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", recordUnhandled);
  try {
    let partitionCalls = 0;
    assert.equal(registry.runInternalBrokerCall(
      () => Promise.reject(new Error("invoke rejected asynchronously")),
      () => {
        partitionCalls += 1;
        return "applied";
      },
    ), "rejected");
    assert.equal(partitionCalls, 0);

    assert.equal(registry.runInternalBrokerCall(
      () => brokerResult(),
      () => Promise.reject(new Error("partition rejected asynchronously")),
    ), "rejected");

    let portMode = "promise";
    let thenGetterReads = 0;
    const customThenable = {};
    Object.defineProperty(customThenable, "then", {
      get() {
        thenGetterReads += 1;
        return () => undefined;
      },
    });
    const targetPort = createPort({
      apply() {
        return portMode === "promise"
          ? Promise.reject(new Error("port rejected asynchronously"))
          : customThenable;
      },
    });
    const target = registry.registerHostProducer("promise-boundary", targetPort.port);
    assert.equal(applyFromInternal(registry, target.target), "rejected");

    assert.equal(registry.runInternalBrokerCall(
      () => customThenable,
      () => {
        partitionCalls += 1;
        return "applied";
      },
    ), "rejected");
    assert.equal(registry.runInternalBrokerCall(
      () => brokerResult(),
      () => customThenable,
    ), "rejected");
    portMode = "thenable";
    assert.equal(applyFromInternal(registry, target.target), "rejected");

    await settlePromises();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(partitionCalls, 0);
    assert.equal(thenGetterReads, 0, "custom thenables are rejected without assimilation");
  } finally {
    process.off("unhandledRejection", recordUnhandled);
  }
});

test("one opaque Broker result can hand off independently to multiple exact Host targets", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const firstPort = createPort();
  const secondPort = createPort();
  const first = registry.registerHostProducer("multi-first", firstPort.port);
  const second = registry.registerHostProducer("multi-second", secondPort.port);
  const result = brokerResult([
    hostAction("multi-first", "first"),
    { kind: "close_client", connectionId: "client", closeCode: 1013, reason: "client" },
    hostAction("multi-second", "second"),
  ]);
  const sources = [];

  assert.equal(registry.runInternalBrokerCall(
    () => result,
    (received, handoff) => {
      assert.equal(received, result, "registry does not parse, clone, or own BrokerResult");
      const firstReceipt = handoff.apply(first.target, [received.actions[0]]);
      const secondReceipt = handoff.apply(second.target, [received.actions[2]]);
      sources.push(
        firstPort.calls.apply[0].fence.source,
        secondPort.calls.apply[0].fence.source,
      );
      return firstReceipt === "applied" && secondReceipt === "applied"
        ? "applied"
        : "rejected";
    },
  ), "applied");

  assert.equal(firstPort.calls.apply.length, 1);
  assert.equal(secondPort.calls.apply.length, 1);
  assert.equal(sources[0].partitionId, sources[1].partitionId);
  assert.notEqual(
    firstPort.calls.apply[0].fence.leaseId,
    secondPort.calls.apply[0].fence.leaseId,
  );

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_received, handoff) => handoff.apply(
      { transportId: "missing", generation: first.target.generation },
      [hostAction("missing")],
    ),
  ), "rejected", "there is no implicit source or default target port");
});

test("target batches are nonempty, hard bounded, dense, data-only, and exact", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const targetPort = createPort();
  const target = registry.registerHostProducer("batch-target", targetPort.port);
  const max = producerModule.RELAY_V2_BROKER_PRODUCER_MAX_ACTIONS;

  const rejectedBatches = [
    [],
    Array.from({ length: max + 1 }, () => hostAction("batch-target")),
    [hostAction("batch-target"), hostAction("different-target")],
    new Proxy([hostAction("batch-target")], {}),
    [new Proxy(hostAction("batch-target"), {})],
    [sendHostAction("batch-target", new Proxy({ type: "proxied.frame" }, {}))],
    [{
      kind: "close_client",
      transportId: "batch-target",
      connectionId: "client-with-forged-host-target",
      closeCode: 1013,
      reason: "not_host_owned",
    }],
    [{ kind: "future.unknown", transportId: "batch-target" }],
    Object.assign(new Array(1), { extra: true }),
    [Object.create({ transportId: "batch-target" })],
  ];
  const accessorAction = { kind: "close_host", closeCode: 1013, reason: "accessor" };
  Object.defineProperty(accessorAction, "transportId", {
    get() { throw new Error("target getter must not run"); },
  });
  rejectedBatches.push([accessorAction]);
  const revokedArray = Proxy.revocable([hostAction("batch-target")], {});
  revokedArray.revoke();
  rejectedBatches.push(revokedArray.proxy);

  for (const batch of rejectedBatches) {
    assert.equal(applyFromInternal(registry, target.target, batch), "rejected");
  }
  assert.equal(targetPort.calls.apply.length, 0);

  const original = hostAction("batch-target", "snapshot");
  const fullBatch = Array.from({ length: max }, (_, index) => (
    index === 0 ? original : hostAction("batch-target", `item-${index}`)
  ));
  assert.equal(applyFromInternal(registry, target.target, fullBatch), "applied");
  assert.equal(targetPort.calls.apply.length, 1);
  assert.equal(targetPort.calls.apply[0].actions.length, max);
  assert.notEqual(targetPort.calls.apply[0].actions[0], original);
  assert.equal(targetPort.calls.apply[0].actions[0].transportId, "batch-target");

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.apply(
      new Proxy(target.target, {}),
      [hostAction("batch-target")],
    ),
  ), "rejected", "transparent target proxies are not captured");
  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.forceTerminal(new Proxy({
      kind: "target_failure",
      target: target.target,
      reason: "proxied_request",
    }, {})),
  ), "rejected", "transparent terminal request proxies are not captured");
  assert.equal(targetPort.calls.apply.length, 1);
  assert.equal(targetPort.calls.forceTerminal.length, 0);
});

test("Host action snapshots recursively copy and freeze bounded plain JSON values", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const targetPort = createPort();
  const target = registry.registerHostProducer("deep-snapshot", targetPort.port);
  const frame = {
    type: "host.example",
    payload: {
      labels: ["before", { state: "stable" }],
      nested: { enabled: true },
    },
  };
  const action = {
    ...sendHostAction("deep-snapshot", frame),
    deliveryId: "delivery-before",
  };

  assert.equal(applyFromInternal(registry, target.target, [action]), "applied");
  const retained = targetPort.calls.apply[0].actions[0];
  assert.notEqual(retained, action);
  assert.notEqual(retained.frame, frame);
  assert.notEqual(retained.frame.payload, frame.payload);
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(Object.isFrozen(retained.frame), true);
  assert.equal(Object.isFrozen(retained.frame.payload), true);
  assert.equal(Object.isFrozen(retained.frame.payload.labels), true);
  assert.equal(Object.isFrozen(retained.frame.payload.labels[1]), true);

  action.deliveryId = "delivery-after";
  frame.payload.labels[0] = "after";
  frame.payload.labels[1].state = "mutated";
  frame.payload.nested.enabled = false;
  frame.payload.added = "later";
  assert.equal(retained.deliveryId, "delivery-before");
  assert.equal(retained.frame.payload.labels[0], "before");
  assert.equal(retained.frame.payload.labels[1].state, "stable");
  assert.equal(retained.frame.payload.nested.enabled, true);
  assert.equal(Object.hasOwn(retained.frame.payload, "added"), false);

  const cyclic = {};
  cyclic.self = cyclic;
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "never";
    },
  });
  const withSymbol = { value: true };
  withSymbol[Symbol("extra")] = true;
  const overDepth = {};
  let cursor = overDepth;
  for (let depth = 0; depth < 24; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const overNodes = {
    values: Array.from({ length: 16_384 }, () => null),
  };
  const invalidFrames = [
    cyclic,
    accessor,
    withSymbol,
    { value: new Date(0) },
    overDepth,
    overNodes,
  ];
  for (const invalidFrame of invalidFrames) {
    assert.equal(applyFromInternal(
      registry,
      target.target,
      [sendHostAction("deep-snapshot", invalidFrame)],
    ), "rejected");
  }
  assert.equal(getterReads, 0, "nested accessors are rejected without being read");
  assert.equal(targetPort.calls.apply.length, 1);
});

test("one rejected target does not starve later independent cleanup targets", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const rejectedPort = createPort({ apply: () => "rejected" });
  const cleanupPort = createPort();
  const rejected = registry.registerHostProducer("reject-first", rejectedPort.port);
  const cleanup = registry.registerHostProducer("cleanup-second", cleanupPort.port);

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => {
      assert.equal(handoff.apply(
        rejected.target,
        [hostAction("reject-first")],
      ), "rejected");
      assert.equal(handoff.apply(
        cleanup.target,
        [hostAction("cleanup-second")],
      ), "applied");
      return "applied";
    },
  ), "rejected", "the source failure latch controls the final partition receipt");
  assert.equal(rejectedPort.calls.apply.length, 1);
  assert.equal(cleanupPort.calls.apply.length, 1);
});

test("the cumulative source action budget is spent before port calls and never refunded", () => {
  const max = producerModule.RELAY_V2_BROKER_PRODUCER_MAX_ACTIONS;
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const firstPort = createPort();
  const secondPort = createPort();
  const overBudgetPort = createPort();
  const first = registry.registerHostProducer("budget-first", firstPort.port);
  const second = registry.registerHostProducer("budget-second", secondPort.port);
  const overBudget = registry.registerHostProducer(
    "budget-over",
    overBudgetPort.port,
  );

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => {
      assert.equal(handoff.apply(
        first.target,
        Array.from({ length: max - 1 }, () => hostAction("budget-first")),
      ), "applied");
      assert.equal(handoff.apply(
        second.target,
        [hostAction("budget-second")],
      ), "applied", "an independent target still runs within the shared budget");
      assert.equal(handoff.apply(
        overBudget.target,
        [hostAction("budget-over")],
      ), "rejected");
      return "applied";
    },
  ), "rejected");
  assert.equal(firstPort.calls.apply.length, 1);
  assert.equal(secondPort.calls.apply.length, 1);
  assert.equal(overBudgetPort.calls.apply.length, 0);

  for (const failureMode of ["reject", "throw"]) {
    const failureRegistry = new producerModule.RelayV2BrokerProducerRegistry();
    const exhaustedPort = createPort({
      apply() {
        if (failureMode === "throw") throw new Error("budget port failed");
        return "rejected";
      },
    });
    const laterPort = createPort();
    const exhausted = failureRegistry.registerHostProducer(
      `budget-${failureMode}`,
      exhaustedPort.port,
    );
    const later = failureRegistry.registerHostProducer(
      `budget-later-${failureMode}`,
      laterPort.port,
    );
    assert.equal(failureRegistry.runInternalBrokerCall(
      () => brokerResult(),
      (_result, handoff) => {
        assert.equal(handoff.apply(
          exhausted.target,
          Array.from(
            { length: max },
            () => hostAction(`budget-${failureMode}`),
          ),
        ), "rejected");
        assert.equal(handoff.apply(
          later.target,
          [hostAction(`budget-later-${failureMode}`)],
        ), "rejected", "failed port effects do not refund the action budget");
        return "applied";
      },
    ), "rejected");
    assert.equal(exhaustedPort.calls.apply.length, 1);
    assert.equal(laterPort.calls.apply.length, 0);
  }
});

test("proxied action batches fail before traps and never invoke a target port", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const stalePort = createPort();
  const stale = registry.registerHostProducer("decode-target", stalePort.port);
  let trapCalls = 0;
  const batch = new Proxy([hostAction("decode-target")], {
    ownKeys() {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    },
  });

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.apply(stale.target, batch),
  ), "rejected");
  assert.equal(trapCalls, 0);
  assert.equal(stalePort.calls.apply.length, 0);
  assert.equal(applyFromInternal(registry, stale.target), "applied");
});

test("effect epochs are per-generation monotonic and lease IDs are registry-wide unique", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const firstPort = createPort();
  const secondPort = createPort();
  const first = registry.registerHostProducer("epoch-first", firstPort.port);
  const second = registry.registerHostProducer("epoch-second", secondPort.port);

  assert.equal(applyFromInternal(registry, first.target), "applied");
  const firstFence = firstPort.calls.apply[0].fence;
  assert.equal(firstFence.mayApply(), false, "effect fence retires at method return");
  assert.equal(applyFromInternal(registry, first.target), "applied");
  assert.equal(applyFromInternal(registry, second.target), "applied");

  const fences = [
    firstPort.calls.apply[0].fence,
    firstPort.calls.apply[1].fence,
    secondPort.calls.apply[0].fence,
  ];
  assert.ok(BigInt(fences[1].effectEpoch) > BigInt(fences[0].effectEpoch));
  assert.equal(new Set(fences.map((fence) => fence.leaseId)).size, fences.length);
  assert.deepEqual(fences[0].target, first.target);
  assert.deepEqual(fences[2].target, second.target);
});

test("reentrant A to B to A replaces the current target lease and invalidates old A", () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  let activeHandoff;
  let first;
  let second;
  let firstCalls = 0;
  let outerFence;

  const firstPort = createPort({
    apply(_actions, fence) {
      firstCalls += 1;
      assert.equal(fence.mayApply(), true);
      if (firstCalls === 1) {
        outerFence = fence;
        assert.equal(activeHandoff.apply(
          second.target,
          [hostAction("reentrant-second")],
        ), "applied");
        assert.equal(fence.mayApply(), false, "new A lease permanently fences old A");
      }
      return "applied";
    },
  });
  const secondPort = createPort({
    apply(_actions, fence) {
      assert.equal(fence.mayApply(), true);
      return activeHandoff.apply(first.target, [hostAction("reentrant-first", "inner")]);
    },
  });
  first = registry.registerHostProducer("reentrant-first", firstPort.port);
  second = registry.registerHostProducer("reentrant-second", secondPort.port);

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => {
      activeHandoff = handoff;
      return handoff.apply(first.target, [hostAction("reentrant-first", "outer")]);
    },
  ), "rejected");
  assert.equal(firstCalls, 2);
  assert.equal(firstPort.calls.apply.length, 2);
  assert.equal(secondPort.calls.apply.length, 1);
  assert.ok(
    BigInt(firstPort.calls.apply[1].fence.effectEpoch)
      > BigInt(firstPort.calls.apply[0].fence.effectEpoch),
  );
  assert.equal(outerFence.mayApply(), false);
});

test("terminal force distinguishes producer failure from exact target failure", async () => {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const sourcePort = createPort();
  const targetPort = createPort();
  const source = registry.registerHostProducer("force-source", sourcePort.port);
  const target = registry.registerHostProducer("force-target", targetPort.port);

  assert.equal(source.runBrokerCall(
    () => brokerResult(),
    (_result, handoff) => {
      assert.equal(handoff.forceTerminal({
        kind: "producer_failure",
        reason: "producer_failed",
      }), "applied");
      return handoff.forceTerminal({
        kind: "target_failure",
        target: target.target,
        reason: "target_failed",
      });
    },
  ), "applied");

  assert.equal(sourcePort.calls.forceTerminal[0].failure.kind, "producer_failure");
  assert.deepEqual(sourcePort.calls.forceTerminal[0].failure.target, source.target);
  assert.equal(sourcePort.calls.forceTerminal[0].failure.source.kind, "host");
  assert.equal(targetPort.calls.forceTerminal[0].failure.kind, "target_failure");
  assert.deepEqual(targetPort.calls.forceTerminal[0].failure.target, target.target);
  assert.equal(targetPort.calls.forceTerminal[0].failure.source.transportId, "force-source");

  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.forceTerminal({
      kind: "producer_failure",
      reason: "forged_internal_producer",
    }),
  ), "rejected");
  assert.equal(sourcePort.calls.forceTerminal.length, 1);

  const barrier = deferred();
  target.beginClose(barrier.promise);
  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.forceTerminal({
      kind: "target_failure",
      target: target.target,
      reason: "closing_target",
    }),
  ), "applied", "closing targets still accept terminal force");
  barrier.resolve();
  await settlePromises();
  assert.equal(registry.runInternalBrokerCall(
    () => brokerResult(),
    (_result, handoff) => handoff.forceTerminal({
      kind: "target_failure",
      target: target.target,
      reason: "retired_target",
    }),
  ), "rejected");
});

test("throwing, nonliteral, Promise, and thenable port receipts fail closed without stale effects", () => {
  const modes = ["throw", "object", "promise", "thenable", "rejected"];
  for (const initialMode of modes) {
    let mode = initialMode;
    let thenReads = 0;
    const thenable = {};
    Object.defineProperty(thenable, "then", {
      get() {
        thenReads += 1;
        return () => undefined;
      },
    });
    const targetPort = createPort({
      apply(_actions, fence) {
        assert.equal(fence.mayApply(), true);
        if (mode === "throw") throw new Error("port failed");
        if (mode === "object") return { outcome: "applied" };
        if (mode === "promise") return Promise.resolve("applied");
        if (mode === "thenable") return thenable;
        if (mode === "rejected") return "rejected";
        return "applied";
      },
      forceTerminal(_failure, fence) {
        assert.equal(fence.mayApply(), true);
        return mode === "applied" ? "applied" : Promise.resolve("applied");
      },
    });
    const registry = new producerModule.RelayV2BrokerProducerRegistry();
    const target = registry.registerHostProducer(`receipt-${initialMode}`, targetPort.port);

    assert.equal(applyFromInternal(registry, target.target), "rejected", initialMode);
    assert.equal(targetPort.calls.apply.at(-1).fence.mayApply(), false);
    assert.equal(thenReads, 0, "receipt thenables are not inspected or assimilated");

    assert.equal(registry.runInternalBrokerCall(
      () => brokerResult(),
      (_result, handoff) => handoff.forceTerminal({
        kind: "target_failure",
        target: target.target,
        reason: "receipt_failure",
      }),
    ), "rejected");
    assert.equal(targetPort.calls.forceTerminal.at(-1).fence.mayApply(), false);

    mode = "applied";
    assert.equal(applyFromInternal(registry, target.target), "applied");
    assert.equal(
      targetPort.calls.apply.at(-1).fence.effectEpoch,
      String(targetPort.calls.apply.length + targetPort.calls.forceTerminal.length),
      "failed effects were cleaned without restoring an older lease",
    );
  }
});
