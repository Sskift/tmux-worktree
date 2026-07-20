import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");

function harness() {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h0-readiness-"));
  const paths = hostState.relayV2HostStatePaths(home);
  let stateRenameError = null;
  let witnessRenameError = null;
  return {
    home,
    paths,
    failNextStateRename(error) { stateRenameError = error; },
    failNextWitnessRename(error) { witnessRenameError = error; },
    async open({ testH0ReadinessHooks } = {}) {
      return hostState.RelayV2HostStateStore.open({
        paths,
        testH0ReadinessHooks,
        renameFile(source, destination) {
          if (destination === paths.state && stateRenameError !== null) {
            const error = stateRenameError;
            stateRenameError = null;
            throw error;
          }
          if (destination === paths.continuity && witnessRenameError !== null) {
            const error = witnessRenameError;
            witnessRenameError = null;
            throw error;
          }
          renameSync(source, destination);
        },
      });
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

function readinessSink(behavior = () => true) {
  const observed = [];
  let closes = 0;
  let applyBehavior = behavior;
  return {
    sink: {
      apply(snapshot) {
        observed.push(structuredClone(snapshot));
        return applyBehavior(snapshot);
      },
      close() { closes += 1; },
    },
    observed,
    closes: () => closes,
    setBehavior(next) { applyBehavior = next; },
  };
}

async function activationFor(store, sink) {
  const identity = await store.read();
  return compositionModule.createRelayV2HostH0ReadinessActivation({
    hostEpoch: identity.hostEpoch,
    hostInstanceId: identity.hostInstanceId,
    h0Port: store.h0ReadinessPort,
    readinessSink: sink,
  });
}

function persistedCut(paths) {
  return {
    state: JSON.parse(readFileSync(paths.state, "utf8")),
    witness: JSON.parse(readFileSync(paths.continuity, "utf8")),
  };
}

function assertWitnessMatchesState({ state, witness }) {
  assert.equal(witness.hostEpoch, state.hostEpoch);
  assert.equal(witness.commitSeq, state.commitSeq);
  assert.equal(witness.commitId, state.commitId);
  assert.equal(witness.stateChecksum, state.checksum);
}

function leaseSink(onClose = () => undefined) {
  return Object.freeze({ close: onClose });
}

function replacePublicHostStatePrototype() {
  const prototype = hostState.RelayV2HostStateStore.prototype;
  const methods = [
    "read",
    "serialize",
    "issueReadinessReceipt",
    "consumeReadinessReceipt",
    "discardReadinessReceipt",
    "releaseReadinessLease",
  ];
  const descriptors = new Map(methods.map((method) => [
    method,
    Object.getOwnPropertyDescriptor(prototype, method),
  ]));
  let calls = 0;
  for (const method of methods) {
    const descriptor = descriptors.get(method);
    Object.defineProperty(prototype, method, {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: descriptor?.writable ?? true,
      value() {
        calls += 1;
        throw new Error(`forged public host state prototype ${method}`);
      },
    });
  }
  return {
    calls: () => calls,
    restore() {
      for (const [method, descriptor] of descriptors) {
        if (descriptor === undefined) delete prototype[method];
        else Object.defineProperty(prototype, method, descriptor);
      }
    },
  };
}

test("H0 activates only after a real no-op transaction publishes matching state and witness", async () => {
  const h = harness();
  let store;
  try {
    store = await h.open();
    const before = await store.read();
    const readiness = readinessSink();
    const activation = await activationFor(store, readiness.sink);
    assert.equal(activation.runtimeH0.transaction, undefined);
    assert.equal(activation.runtimeH0.issueReadinessReceipt, undefined);
    assert.equal(activation.lifecycle.apply, undefined);
    assert.equal(activation.h0Port, undefined);

    assert.equal(await activation.lifecycle.activate(), true);
    const after = await activation.runtimeH0.read();
    assert.equal(BigInt(after.commitSeq), BigInt(before.commitSeq) + 1n);
    assert.deepEqual(readiness.observed, [{
      source: "h0",
      generation: "1",
      ready: true,
    }]);
    assertWitnessMatchesState(persistedCut(h.paths));

    activation.lifecycle.close();
    activation.lifecycle.close();
    assert.equal(readiness.closes(), 1);
    activation.dispose();
  } finally {
    store?.close();
    h.cleanup();
  }
});

test("H0 port keeps module-initialized owner primitives across public prototype replacement", async (t) => {
  for (const timing of ["before_open", "after_open"]) {
    await t.test(timing, async () => {
      const h = harness();
      let store;
      let replacement;
      try {
        if (timing === "before_open") replacement = replacePublicHostStatePrototype();
        store = await h.open();
        const port = store.h0ReadinessPort;
        const before = await port.read();
        if (timing === "after_open") replacement = replacePublicHostStatePrototype();
        assert.equal((await port.read()).commitSeq, before.commitSeq);

        const issue = await port.issueReadinessReceipt();
        assert.equal(BigInt(issue.binding.commitSeq), BigInt(before.commitSeq) + 1n);
        const lease = port.consumeReadinessReceipt(issue.receipt, issue.binding, leaseSink());
        assert.notEqual(lease, null);
        assert.equal(port.releaseReadinessLease(lease), true);
        const discarded = await port.issueReadinessReceipt();
        assert.equal(port.discardReadinessReceipt(discarded.receipt), true);
        assert.equal(replacement.calls(), 0);
        assertWitnessMatchesState(persistedCut(h.paths));
      } finally {
        replacement?.restore();
        store?.close();
        h.cleanup();
      }
    });
  }
});

test("H0 activation never signs pre-rename or commit-uncertain transactions and recovery needs a new no-op", async (t) => {
  await t.test("state rename fails before the commit point", async () => {
    const h = harness();
    let store;
    try {
      store = await h.open();
      const before = await store.read();
      const readiness = readinessSink();
      const activation = await activationFor(store, readiness.sink);
      const injected = new Error("injected H0 state rename failure");
      h.failNextStateRename(injected);

      await assert.rejects(activation.lifecycle.activate(), (error) => error === injected);
      assert.equal((await store.read()).commitSeq, before.commitSeq);
      assert.deepEqual(readiness.observed, []);
      assert.equal(readiness.closes(), 1);

      assert.equal(await activation.lifecycle.activate(), true);
      assert.equal(BigInt((await store.read()).commitSeq), BigInt(before.commitSeq) + 1n);
      assert.deepEqual(readiness.observed, [{
        source: "h0",
        generation: "1",
        ready: true,
      }]);
      assertWitnessMatchesState(persistedCut(h.paths));
      activation.dispose();
    } finally {
      store?.close();
      h.cleanup();
    }
  });

  await t.test("witness rename is commit-uncertain until repair and another no-op", async () => {
    const h = harness();
    let store;
    try {
      store = await h.open();
      const before = await store.read();
      const readiness = readinessSink();
      const activation = await activationFor(store, readiness.sink);
      h.failNextWitnessRename(new Error("injected H0 witness rename failure"));

      await assert.rejects(
        activation.lifecycle.activate(),
        (error) => error?.code === "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN",
      );
      const uncertain = persistedCut(h.paths);
      assert.equal(BigInt(uncertain.state.commitSeq), BigInt(before.commitSeq) + 1n);
      assert.equal(uncertain.witness.commitSeq, before.commitSeq);
      assert.deepEqual(readiness.observed, []);
      assert.equal(readiness.closes(), 1);

      assert.equal(await activation.lifecycle.activate(), true);
      const recovered = persistedCut(h.paths);
      assert.equal(BigInt(recovered.state.commitSeq), BigInt(before.commitSeq) + 2n);
      assertWitnessMatchesState(recovered);
      assert.deepEqual(readiness.observed, [{
        source: "h0",
        generation: "1",
        ready: true,
      }]);
      activation.dispose();
    } finally {
      store?.close();
      h.cleanup();
    }
  });
});

test("H0 receipts and leases are exact-owner, exact-lineage, one-shot process capabilities", async () => {
  const h = harness();
  let first;
  let second;
  try {
    first = await h.open();
    second = await h.open();
    const port = first.h0ReadinessPort;
    assert.deepEqual(Object.keys(port), []);
    assert.deepEqual(Object.getOwnPropertySymbols(port), []);
    assert.equal(Object.getOwnPropertyDescriptor(first, "h0ReadinessPort").enumerable, false);
    assert.equal(first.issueReadinessReceipt, undefined);
    assert.equal(first.consumeReadinessReceipt, undefined);
    assert.equal(first.releaseReadinessLease, undefined);
    assert.deepEqual(Object.getOwnPropertySymbols(first), []);
    assert.equal(Object.values(Object.getOwnPropertyDescriptors(first)).some(({ value }) => (
      value instanceof Map || value instanceof WeakMap
    )), false);
    assert.equal(
      Object.getOwnPropertyDescriptor(
        port,
        Symbol.for("tmux-worktree.relay-v2.host-h0-readiness-authority-issuer"),
      ),
      undefined,
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(
        first,
        Symbol.for("tmux-worktree.relay-v2.host-h0-readiness-authority-capture"),
      ),
      undefined,
    );
    assert.equal(port.transaction, undefined);
    assert.equal(port.serialize, undefined);
    assert.equal(port.close, undefined);

    const stale = await port.issueReadinessReceipt();
    assert.deepEqual(Object.getOwnPropertySymbols(stale.receipt), []);
    assert.equal(stale.binding.hostInstanceId, first.hostInstanceId);
    assert.equal(
      second.h0ReadinessPort.consumeReadinessReceipt(
        stale.receipt,
        stale.binding,
        leaseSink(),
      ),
      null,
    );
    assert.equal(
      port.consumeReadinessReceipt(() => undefined, stale.binding, leaseSink()),
      null,
    );
    assert.equal(
      port.consumeReadinessReceipt(
        stale.receipt,
        { ...stale.binding, commitSeq: String(BigInt(stale.binding.commitSeq) + 1n) },
        leaseSink(),
      ),
      null,
    );

    const current = await port.issueReadinessReceipt();
    assert.equal(port.consumeReadinessReceipt(stale.receipt, stale.binding, leaseSink()), null);
    const lease = port.consumeReadinessReceipt(
      current.receipt,
      current.binding,
      leaseSink(),
    );
    assert.notEqual(lease, null);
    assert.deepEqual(Object.getOwnPropertySymbols(lease), []);
    assert.equal(
      port.consumeReadinessReceipt(current.receipt, current.binding, leaseSink()),
      null,
    );
    assert.equal(port.releaseReadinessLease(lease), true);
    assert.equal(port.releaseReadinessLease(lease), false);

    let invalidated = 0;
    const consumed = await port.issueReadinessReceipt();
    const invalidatedLease = port.consumeReadinessReceipt(
      consumed.receipt,
      consumed.binding,
      leaseSink(() => { invalidated += 1; }),
    );
    assert.notEqual(invalidatedLease, null);
    const replacement = await port.issueReadinessReceipt();
    assert.equal(invalidated, 1);
    assert.equal(port.releaseReadinessLease(invalidatedLease), false);
    assert.equal(port.consumeReadinessReceipt(consumed.receipt, consumed.binding, leaseSink()), null);
    assert.equal(port.discardReadinessReceipt(replacement.receipt), true);
    assert.equal(port.discardReadinessReceipt(replacement.receipt), false);
  } finally {
    first?.close();
    second?.close();
    h.cleanup();
  }
});

test("raw, copied, proxied, forged, and global-symbol authority paths cannot activate H0", async () => {
  const h = harness();
  let store;
  try {
    store = await h.open();
    const identity = await store.read();
    const readiness = readinessSink();
    const options = {
      hostEpoch: identity.hostEpoch,
      hostInstanceId: identity.hostInstanceId,
      readinessSink: readiness.sink,
    };

    assert.throws(
      () => compositionModule.createRelayV2HostH0ReadinessActivation({
        ...options,
        h0Port: store,
      }),
      /invalid Relay v2 H0 readiness port/,
    );
    assert.throws(
      () => compositionModule.createRelayV2HostH0ReadinessActivation({
        ...options,
        h0Port: { read: () => store.read() },
      }),
      /invalid Relay v2 H0 readiness port/,
    );

    const copied = Object.create(null);
    Object.defineProperties(copied, Object.getOwnPropertyDescriptors(store.h0ReadinessPort));
    Object.freeze(copied);
    assert.throws(
      () => compositionModule.createRelayV2HostH0ReadinessActivation({
        ...options,
        h0Port: copied,
      }),
      /invalid Relay v2 H0 readiness port/,
    );

    assert.throws(
      () => compositionModule.createRelayV2HostH0ReadinessActivation({
        ...options,
        h0Port: new Proxy(store.h0ReadinessPort, {}),
      }),
      /invalid Relay v2 H0 readiness port/,
    );
    assert.deepEqual(readiness.observed, []);
  } finally {
    store?.close();
    h.cleanup();
  }
});

test("fatal reads, lineage replacement, and owner close invalidate receipts and active leases synchronously", async () => {
  const h = harness();
  let store;
  try {
    store = await h.open();
    const port = store.h0ReadinessPort;
    const receipt = await port.issueReadinessReceipt();
    const injected = new Error("injected post-receipt H0 recovery failure");
    writeFileSync(h.paths.state, "{not-json\n", { mode: 0o600 });
    h.failNextStateRename(injected);
    await assert.rejects(port.read(), (error) => error?.original === injected);
    assert.equal(port.consumeReadinessReceipt(receipt.receipt, receipt.binding, leaseSink()), null);

    const repaired = await port.issueReadinessReceipt();
    let invalidated = 0;
    const lease = port.consumeReadinessReceipt(
      repaired.receipt,
      repaired.binding,
      leaseSink(() => { invalidated += 1; }),
    );
    assert.notEqual(lease, null);
    rmSync(h.paths.state, { force: true });
    rmSync(h.paths.continuity, { force: true });
    const replacement = await port.read();
    assert.notEqual(replacement.hostEpoch, repaired.binding.hostEpoch);
    assert.equal(invalidated, 1);
    assert.equal(port.releaseReadinessLease(lease), false);

    const closeReceipt = await port.issueReadinessReceipt();
    const closeLease = port.consumeReadinessReceipt(
      closeReceipt.receipt,
      closeReceipt.binding,
      leaseSink(() => { invalidated += 1; }),
    );
    assert.notEqual(closeLease, null);
    store.close();
    store.close();
    assert.equal(invalidated, 2);
    assert.equal(port.releaseReadinessLease(closeLease), false);
  } finally {
    store?.close();
    h.cleanup();
  }
});

test("runtime H0 read fatal withdraws before propagating and changed lineage needs a new activation", async () => {
  const h = harness();
  let store;
  try {
    store = await h.open();
    const readiness = readinessSink();
    const activation = await activationFor(store, readiness.sink);
    assert.equal(await activation.lifecycle.activate(), true);

    const injected = new Error("injected active H0 runtime read failure");
    writeFileSync(h.paths.state, "{not-json\n", { mode: 0o600 });
    h.failNextStateRename(injected);
    await assert.rejects(activation.runtimeH0.read(), (error) => error?.original === injected);
    assert.equal(readiness.closes(), 1);

    const replacement = await store.read();
    assert.equal(await activation.lifecycle.activate(), false);
    const replacementReadiness = readinessSink();
    const replacementActivation = compositionModule.createRelayV2HostH0ReadinessActivation({
      hostEpoch: replacement.hostEpoch,
      hostInstanceId: replacement.hostInstanceId,
      h0Port: store.h0ReadinessPort,
      readinessSink: replacementReadiness.sink,
    });
    assert.equal(await replacementActivation.lifecycle.activate(), true);
    assert.deepEqual(replacementReadiness.observed, [{
      source: "h0",
      generation: "1",
      ready: true,
    }]);
    replacementActivation.dispose();
    activation.dispose();
  } finally {
    store?.close();
    h.cleanup();
  }
});

test("close fences a pending activation, shields its late receipt, and requires a fresh no-op", async () => {
  const h = harness();
  let store;
  try {
    store = await h.open();
    const before = await store.read();
    const readiness = readinessSink();
    const activation = await activationFor(store, readiness.sink);
    let releaseBarrier;
    let enteredBarrier;
    const entered = new Promise((resolve) => { enteredBarrier = resolve; });
    const release = new Promise((resolve) => { releaseBarrier = resolve; });
    const barrier = store.serialize(async () => {
      enteredBarrier();
      await release;
    });
    await entered;

    const pending = activation.lifecycle.activate();
    activation.lifecycle.close();
    activation.lifecycle.close();
    releaseBarrier();
    await barrier;
    assert.equal(await pending, false);
    assert.equal(BigInt((await store.read()).commitSeq), BigInt(before.commitSeq) + 1n);
    assert.deepEqual(readiness.observed, []);
    assert.equal(readiness.closes(), 1);

    assert.equal(await activation.lifecycle.activate(), true);
    assert.equal(BigInt((await store.read()).commitSeq), BigInt(before.commitSeq) + 2n);
    assert.deepEqual(readiness.observed, [{
      source: "h0",
      generation: "1",
      ready: true,
    }]);
    activation.dispose();
  } finally {
    store?.close();
    h.cleanup();
  }
});

test("sink false, throw, thenable, and reentry fail closed before returning", async (t) => {
  for (const scenario of ["false", "throw", "thenable", "hostile_thenable", "close", "activate"]) {
    await t.test(scenario, async () => {
      const h = harness();
      let store;
      try {
        store = await h.open();
        const thrown = new Error("injected H0 sink failure");
        let activation;
        let reentrant = null;
        let thenReads = 0;
        const readiness = readinessSink(() => {
          if (scenario === "false") return false;
          if (scenario === "throw") throw thrown;
          if (scenario === "thenable") return Promise.resolve(true);
          if (scenario === "hostile_thenable") {
            return Object.defineProperty({}, "then", {
              get() { thenReads += 1; throw new Error("injected thenable getter failure"); },
            });
          }
          if (scenario === "close") activation.lifecycle.close();
          if (scenario === "activate") reentrant = activation.lifecycle.activate();
          return true;
        });
        activation = await activationFor(store, readiness.sink);

        if (scenario === "throw") {
          await assert.rejects(activation.lifecycle.activate(), (error) => error === thrown);
        } else {
          assert.equal(await activation.lifecycle.activate(), false);
        }
        if (reentrant !== null) assert.equal(await reentrant, false);
        assert.equal(thenReads, scenario === "hostile_thenable" ? 1 : 0);
        assert.equal(readiness.closes(), 1);

        readiness.setBehavior(() => true);
        assert.equal(await activation.lifecycle.activate(), true);
        assert.equal(readiness.observed.at(-1).generation, "2");
        assert.equal(await activation.lifecycle.activate(), true);
        assert.equal(readiness.observed.at(-1).generation, "3");
        assert.equal(readiness.closes(), 2);
        activation.dispose();
      } finally {
        store?.close();
        h.cleanup();
      }
    });
  }
});

test("receipt and lease protocol errors withdraw before propagating", async (t) => {
  for (const retirement of ["close", "dispose"]) {
    await t.test(`late hostile receipt is opaque after ${retirement}`, async () => {
      const h = harness();
      let store;
      let activation;
      let resolveIssue;
      const pendingIssue = new Promise((resolve) => { resolveIssue = resolve; });
      let descriptorTraps = 0;
      const hostileLateIssue = new Proxy({}, {
        ownKeys() {
          descriptorTraps += 1;
          throw new Error("late receipt ownKeys trap must be shielded");
        },
        getOwnPropertyDescriptor() {
          descriptorTraps += 1;
          throw new Error("late receipt descriptor trap must be shielded");
        },
      });
      try {
        store = await h.open({
          testH0ReadinessHooks: {
            afterReadinessReceiptIssue() { return pendingIssue; },
          },
        });
        const readiness = readinessSink();
        activation = await activationFor(store, readiness.sink);
        const pending = activation.lifecycle.activate();
        if (retirement === "close") activation.lifecycle.close();
        else activation.dispose();
        resolveIssue(hostileLateIssue);
        assert.equal(await pending, false);
        assert.equal(descriptorTraps, 0);
        assert.equal(readiness.closes(), 1);
      } finally {
        activation?.dispose();
        store?.close();
        h.cleanup();
      }
    });
  }

  await t.test("consume close reentry releases its late lease exactly once", async () => {
    const h = harness();
    let store;
    let activation;
    const events = [];
    let applyCalls = 0;
    let releaseCalls = 0;
    const readiness = {
      apply() {
        applyCalls += 1;
        return true;
      },
      close() { events.push("withdraw"); },
    };
    try {
      store = await h.open({
        testH0ReadinessHooks: {
          beforeReadinessLeaseReturn(_lease, sink) {
            sink.close();
          },
          afterReadinessLeaseRelease() {
            releaseCalls += 1;
            events.push("release");
            return true;
          },
        },
      });
      activation = await activationFor(store, readiness);
      assert.equal(await activation.lifecycle.activate(), false);
      assert.deepEqual(events, ["withdraw", "release"]);
      assert.equal(applyCalls, 0);
      assert.equal(releaseCalls, 1);
      activation.dispose();
      assert.equal(releaseCalls, 1);
    } finally {
      activation?.dispose();
      store?.close();
      h.cleanup();
    }
  });

  await t.test("consume close reentry keeps withdraw error ahead of late release error", async () => {
    const h = harness();
    let store;
    let activation;
    const withdrawFailure = new Error("injected reentrant withdraw failure");
    const releaseFailure = new Error("injected late lease release failure");
    const events = [];
    let releaseCalls = 0;
    const readiness = {
      apply() { return true; },
      close() {
        events.push("withdraw");
        throw withdrawFailure;
      },
    };
    try {
      store = await h.open({
        testH0ReadinessHooks: {
          beforeReadinessLeaseReturn(_lease, sink) { sink.close(); },
          afterReadinessLeaseRelease() {
            releaseCalls += 1;
            events.push("release");
            throw releaseFailure;
          },
        },
      });
      activation = await activationFor(store, readiness);
      await assert.rejects(activation.lifecycle.activate(), (error) => error === withdrawFailure);
      assert.deepEqual(events, ["withdraw", "release"]);
      assert.equal(releaseCalls, 1);
      activation.dispose();
      assert.equal(releaseCalls, 1);
    } finally {
      activation?.dispose();
      store?.close();
      h.cleanup();
    }
  });

  await t.test("consume throw", async () => {
    const h = harness();
    let store;
    let activation;
    const failure = new Error("injected receipt consume failure");
    const readiness = readinessSink();
    try {
      store = await h.open({
        testH0ReadinessHooks: {
          beforeReadinessReceiptConsume() { throw failure; },
        },
      });
      activation = await activationFor(store, readiness.sink);
      await assert.rejects(activation.lifecycle.activate(), (error) => error === failure);
      assert.equal(readiness.closes(), 1);
    } finally {
      activation?.dispose();
      store?.close();
      h.cleanup();
    }
  });

  await t.test("release rejection", async () => {
    const h = harness();
    let store;
    let activation;
    const events = [];
    const readiness = {
      apply() { return false; },
      close() { events.push("withdraw"); },
    };
    try {
      store = await h.open({
        testH0ReadinessHooks: {
          afterReadinessLeaseRelease() {
            events.push("release");
            return false;
          },
        },
      });
      activation = await activationFor(store, readiness);
      await assert.rejects(
        activation.lifecycle.activate(),
        /H0 readiness lease release was rejected/,
      );
      assert.deepEqual(events, ["withdraw", "release"]);
    } finally {
      activation?.dispose();
      store?.close();
      h.cleanup();
    }
  });
});
