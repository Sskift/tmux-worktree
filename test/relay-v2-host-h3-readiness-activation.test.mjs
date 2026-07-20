import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const backendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");
const activationModule = await import("../dist/relay/v2/hostH3ReadinessActivation.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const terminalDurable = await import("../dist/relay/v2/terminalDurableLineage.js");
const terminal = await import("../dist/relay/v2/terminalManager.js");

const HOST_ID = "mac-admin";
const TARGET = { hostId: HOST_ID, scopeId: "scope-local", sessionId: "ses_h3" };
const AUTH = { principalId: "principal-h3", clientInstanceId: "client-h3" };
const ROUTE = {
  connectorId: "connector-h3",
  routeId: "route-h3",
  routeFence: "fence-h3",
  runtimeBindingToken: "runtime-binding-h3",
};
const INCARNATION = `twinc2.${"h".repeat(43)}`;
const PROCESS_TARGET = { kind: "local", targetId: "local-h3" };
const BACKEND_KEY = backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
  processTarget: PROCESS_TARGET,
  incarnation: INCARNATION,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function readinessSink() {
  const applied = [];
  let closes = 0;
  return {
    sink: {
      apply(snapshot) {
        applied.push(structuredClone(snapshot));
        return true;
      },
      close() { closes += 1; },
    },
    applied,
    closes: () => closes,
  };
}

class FakeBackend {
  opens = [];

  async open(target, options, observer) {
    const handle = {
      closeCalls: 0,
      async pause() {},
      async resume() {},
      async setDisplaySizeHint() {},
      async close() { handle.closeCalls += 1; },
    };
    this.opens.push({ target: structuredClone(target), options: structuredClone(options), observer, handle });
    return handle;
  }
}

function managerHarness(store, identity, lineage, overrides = {}) {
  const backend = new FakeBackend();
  const sent = [];
  const binding = {
    schemaVersion: 1,
    ...TARGET,
    pane: 0,
    processTarget: PROCESS_TARGET,
    backendInstanceKey: BACKEND_KEY,
    managedTarget: { name: "managed-h3", kind: "terminal", incarnation: INCARNATION },
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: "control-h3",
      controlEpoch: "control-epoch-h3",
      targetIncarnationProof: "control-proof-h3",
    },
  };
  const resolver = {
    async resolve() {
      return {
        target: {
          ...TARGET,
          pane: 0,
          canonicalTargetId: BACKEND_KEY,
          controlTargetId: "control-h3",
        },
        binding,
        admission: {
          resourceToken: {
            schemaVersion: 1,
            hostEpoch: identity.hostEpoch,
            resourceMappingDigest: "mapping-h3",
            discoveryGeneration: "discovery-h3",
          },
          resourceTarget: {
            authorization: "evidence_only",
            hostEpoch: identity.hostEpoch,
            discoveryGeneration: "discovery-h3",
            scopeId: TARGET.scopeId,
            processTarget: PROCESS_TARGET,
            capabilities: ["terminal.stream.v1"],
            sessionId: TARGET.sessionId,
            backendInstanceKey: BACKEND_KEY,
            managedTarget: binding.managedTarget,
          },
          exactControlToken: "control-token-h3",
        },
      };
    },
    fenceSessionForAdmission() {},
  };
  const manager = new terminal.RelayV2TerminalManager({
    hostId: HOST_ID,
    hostEpoch: identity.hostEpoch,
    hostInstanceId: store.hostInstanceId,
    resolver,
    lineage,
    backend,
    terminalControl: {},
    issueToken: () => "resume-token-h3",
    async send(route, frame, responseLineage) {
      sent.push({
        route: structuredClone(route),
        frame: structuredClone(frame),
        responseLineage: responseLineage === undefined ? null : structuredClone(responseLineage),
      });
    },
  });
  Object.assign(manager, overrides);
  return { manager, backend, resolver, sent };
}

function openRequest(requestId, expectedHostEpoch) {
  return {
    auth: structuredClone(AUTH),
    route: structuredClone(ROUTE),
    requestId: requestId ?? "h3-open-attempt",
    expectedHostEpoch,
    target: structuredClone(TARGET),
    pane: 0,
    streamId: "h3-stream",
    openId: "h3-open-id",
    cols: 120,
    rows: 40,
    mode: "new",
  };
}

async function openOwner(home, overrides = {}) {
  const store = await hostState.RelayV2HostStateStore.open({ home });
  const identity = await store.read();
  const lineage = new terminalDurable.RelayV2TerminalDurableLineageAuthority({
    store,
    admissionFence: { fenceSessionForAdmission() {} },
  });
  const manager = managerHarness(store, identity, lineage, overrides);
  const candidate = await lineage.recoverForHostH3(manager.manager);
  return { store, identity, lineage, candidate, ...manager };
}

function activationFor(owner, readiness) {
  return activationModule.createRelayV2HostH3ReadinessActivation({
    hostId: HOST_ID,
    hostEpoch: owner.identity.hostEpoch,
    hostInstanceId: owner.store.hostInstanceId,
    candidate: owner.candidate,
    readinessSink: readiness.sink,
  });
}

test("H3 stays gated until exact recovery activates and then uses the same manager", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h3-ready-"));
  let owner;
  try {
    owner = await openOwner(home);
    const readiness = readinessSink();
    const activation = activationFor(owner, readiness);
    assert.equal(activation.lifecycle.apply, undefined);
    await assert.rejects(
      activation.runtimeH3.open(openRequest("before-h3-ready", owner.identity.hostEpoch)),
      (error) => error?.code === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(owner.backend.opens.length, 0);
    assert.deepEqual(readiness.applied, []);

    assert.equal(activation.lifecycle.activate(), true);
    assert.deepEqual(readiness.applied, [{
      source: "h3",
      generation: "1",
      ready: true,
    }]);
    await activation.runtimeH3.open(openRequest(undefined, owner.identity.hostEpoch));
    await activation.runtimeH3.open(openRequest("h3-open-retry", owner.identity.hostEpoch));
    assert.equal(owner.backend.opens.length, 1);
    assert.equal(owner.sent.filter(({ frame }) => frame.type === "terminal.opened").length, 2);
    await activation.dispose();
  } finally {
    owner?.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("recovery retires the old live owner and exact retry is durable stream_lost without a PTY", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h3-recovery-"));
  let first;
  let second;
  try {
    first = await openOwner(home);
    const firstReadiness = readinessSink();
    const firstActivation = activationFor(first, firstReadiness);
    assert.equal(firstActivation.lifecycle.activate(), true);
    await firstActivation.runtimeH3.open(openRequest("old-owner-open", first.identity.hostEpoch));
    assert.equal(first.backend.opens.length, 1);

    second = await openOwner(home);
    assert.equal(firstReadiness.closes(), 1, "replacement recovery synchronously withdraws old H3");
    const persisted = await second.store.read();
    const durable = Object.values(persisted.materialized).find(
      (value) => value?.authority === "relay_v2_terminal_durable_lineage",
    );
    assert.equal(durable.activeHostInstanceId, second.store.hostInstanceId);
    assert.deepEqual(durable.streamAuthorities, []);
    assert.equal(durable.lostAuthorities.length, 1);

    const secondReadiness = readinessSink();
    const secondActivation = activationFor(second, secondReadiness);
    assert.equal(secondActivation.lifecycle.activate(), true);
    await secondActivation.runtimeH3.open(openRequest(
      "new-owner-exact-retry",
      second.identity.hostEpoch,
    ));
    assert.equal(second.backend.opens.length, 0);
    const reset = second.sent.find(({ frame }) => frame.requestId === "new-owner-exact-retry")?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.reason, "stream_lost");
    await firstActivation.dispose();
    await secondActivation.dispose();
  } finally {
    first?.store.close();
    second?.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("candidate identity rejects copies, proxies, accessors, forgeries, foreign bindings, and reuse", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h3-candidate-"));
  let owner;
  let replacement;
  try {
    owner = await openOwner(home);
    const symbols = Object.getOwnPropertySymbols(owner.candidate);
    assert.equal(symbols.length, 1);
    const copied = Object.create(null);
    Object.defineProperties(copied, Object.getOwnPropertyDescriptors(owner.candidate));
    Object.freeze(copied);
    const accessor = Object.create(null);
    Object.defineProperty(accessor, symbols[0], {
      configurable: false,
      enumerable: false,
      get: () => Object.getOwnPropertyDescriptor(owner.candidate, symbols[0]).value,
    });
    Object.freeze(accessor);
    const forged = Object.freeze(Object.defineProperty(Object.create(null), symbols[0], {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ capture: () => ({}) }),
    }));
    for (const candidate of [copied, new Proxy(owner.candidate, {}), accessor, forged]) {
      assert.throws(
        () => activationModule.createRelayV2HostH3ReadinessActivation({
          hostId: HOST_ID,
          hostEpoch: owner.identity.hostEpoch,
          hostInstanceId: owner.store.hostInstanceId,
          candidate,
          readinessSink: readinessSink().sink,
        }),
        /invalid Relay v2 H3 recovery candidate/,
      );
    }
    assert.throws(
      () => activationModule.createRelayV2HostH3ReadinessActivation({
        hostId: HOST_ID,
        hostEpoch: owner.identity.hostEpoch,
        hostInstanceId: "foreign-host-instance",
        candidate: owner.candidate,
        readinessSink: readinessSink().sink,
      }),
      /invalid Relay v2 H3 recovery candidate/,
    );

    const stale = activationFor(owner, readinessSink());
    replacement = await openOwner(home);
    assert.equal(stale.lifecycle.activate(), false);
    const first = activationFor(replacement, readinessSink());
    const second = activationFor(replacement, readinessSink());
    assert.equal(first.lifecycle.activate(), true);
    assert.equal(second.lifecycle.activate(), false);
    await first.dispose();
    await second.dispose();
    await stale.dispose();
  } finally {
    owner?.store.close();
    replacement?.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("close is a synchronous withdrawal and an idempotent in-flight plus shutdown barrier", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h3-close-"));
  const operation = deferred();
  const shutdown = deferred();
  let shutdownCalls = 0;
  let owner;
  try {
    owner = await openOwner(home, {
      open: () => operation.promise,
      shutdown: () => {
        shutdownCalls += 1;
        return shutdown.promise;
      },
    });
    const readiness = readinessSink();
    let activation;
    let reentrantClose = null;
    const reentrantReadiness = {
      ...readiness,
      sink: {
        apply: readiness.sink.apply,
        close() {
          readiness.sink.close();
          reentrantClose = activation.dispose();
        },
      },
    };
    activation = activationFor(owner, reentrantReadiness);
    assert.equal(activation.lifecycle.activate(), true);
    const pending = activation.runtimeH3.open(openRequest("barrier-open", owner.identity.hostEpoch));
    const firstClose = activation.lifecycle.close();
    const secondClose = activation.dispose();
    assert.equal(reentrantClose, firstClose);
    assert.equal(firstClose, secondClose);
    assert.equal(readiness.closes(), 1);
    assert.equal(shutdownCalls, 0);
    await assert.rejects(
      activation.runtimeH3.open(openRequest("late-open", owner.identity.hostEpoch)),
      (error) => error?.code === "CAPABILITY_UNAVAILABLE",
    );

    operation.resolve();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
    let closed = false;
    void firstClose.then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    shutdown.resolve();
    await firstClose;
    assert.equal(readiness.applied.length, 1, "late completion cannot restore readiness");
    assert.equal(shutdownCalls, 1);
  } finally {
    owner?.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("dispose before activation consumes the candidate and waits for manager shutdown", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h3-idle-dispose-"));
  const shutdown = deferred();
  let shutdownCalls = 0;
  let owner;
  try {
    owner = await openOwner(home, {
      shutdown: () => {
        shutdownCalls += 1;
        return shutdown.promise;
      },
    });
    const readiness = readinessSink();
    const activation = activationFor(owner, readiness);
    const competingReadiness = readinessSink();
    const competingActivation = activationFor(owner, competingReadiness);

    const barrier = activation.dispose();
    assert.deepEqual(readiness.applied, []);
    assert.equal(competingActivation.lifecycle.activate(), false);
    assert.deepEqual(competingReadiness.applied, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);

    let closed = false;
    void barrier.then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    shutdown.resolve();
    await barrier;
    assert.equal(shutdownCalls, 1);
    assert.deepEqual(readiness.applied, []);
    await competingActivation.dispose();
  } finally {
    owner?.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
