import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const lifecycle = await import("../dist/relay/v2/materializedReconcileLifecycleOwner.js");

function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

function settledFlag(promise) {
  const flag = { settled: false };
  promise.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

async function waitFor(condition, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class QueueDiscovery {
  #scans = [];
  #fallback = null;

  push(scan) {
    this.#scans.push(structuredClone(scan));
  }

  pushDeferred(promise, onStart) {
    this.#scans.push({ promise, onStart });
  }

  setFallback(scan) {
    this.#fallback = structuredClone(scan);
  }

  async scan() {
    const item = this.#scans.shift();
    if (item === undefined) {
      if (this.#fallback === null) throw new Error("test discovery has no queued scan");
      return structuredClone(this.#fallback);
    }
    if (item.promise !== undefined) {
      item.onStart?.();
      return structuredClone(await item.promise);
    }
    return structuredClone(item);
  }
}

function terminalSession(name) {
  return {
    backendIdentity: `be:${name}`,
    kind: "terminal",
    displayName: name,
    state: "running",
    project: null,
    label: name,
    cwd: `/repo/${name}`,
    attached: false,
    windowCount: 1,
    createdAtMs: 1_783_699_000_000,
    activityAtMs: 1_783_700_000_000,
  };
}

function completeScan(backendIdentity, sessions = []) {
  return {
    coverage: "complete",
    scopes: [{
      backendIdentity,
      displayName: backendIdentity,
      kind: "local",
      reachability: "online",
      sessionsCompleteness: "complete",
      sessions,
      error: null,
      reservationCorrelationCompleteness: "unavailable",
    }],
  };
}

function unreachableScan(backendIdentity) {
  return {
    coverage: "partial",
    scopes: [{
      backendIdentity,
      displayName: backendIdentity,
      kind: "local",
      reachability: "unreachable",
      sessionsCompleteness: "partial",
      sessions: [],
      error: {
        code: "SCOPE_UNREACHABLE",
        message: "transport unavailable",
        retryable: true,
        commandDisposition: "not_applicable",
      },
      reservationCorrelationCompleteness: "unavailable",
    }],
  };
}

async function harness({ scanIntervalMs = 60_000, applyReconfiguration } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-reconcile-lifecycle-"));
  const paths = hostState.relayV2HostStatePaths(home);
  const store = await hostState.RelayV2HostStateStore.open({ paths });
  const discovery = new QueueDiscovery();
  const mutableDiscovery = {
    inner: discovery,
    scan() {
      return this.inner.scan();
    },
  };
  const readinessSink = {
    signals: [],
    apply(signal) {
      this.signals.push(structuredClone(signal));
      return true;
    },
  };
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: "host-under-test",
    discovery: mutableDiscovery,
    store,
    readinessSink,
  });
  const events = [];
  const reconcilePort = {
    calls: 0,
    async reconcile() {
      this.calls += 1;
      events.push("scan:start");
      try {
        const result = await foundation.reconcile();
        events.push("scan:settle");
        return result;
      } catch (error) {
        events.push("scan:fail");
        throw error;
      }
    },
  };
  const owner = new lifecycle.RelayV2MaterializedReconcileLifecycleOwner({
    reconcilePort,
    scanIntervalMs,
    ...(applyReconfiguration === undefined ? {} : { applyReconfiguration }),
  });
  return {
    home,
    paths,
    store,
    discovery,
    mutableDiscovery,
    readinessSink,
    foundation,
    reconcilePort,
    events,
    owner,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

async function materializedScopes(h, requestId) {
  const { hostEpoch } = await h.foundation.readiness();
  return (await h.foundation.scopesSnapshot(requestId, hostEpoch)).payload;
}

test("start scans immediately, explicit trigger applies changes, periodic trigger keeps cadence", async () => {
  const h = await harness({ scanIntervalMs: 15 });
  try {
    h.discovery.push(completeScan("scope:one", [terminalSession("alpha")]));
    h.discovery.setFallback(completeScan("scope:one", [terminalSession("alpha")]));

    const startup = await h.owner.start();
    assert.equal(startup, "reconciled");
    assert.equal(h.reconcilePort.calls, 1);
    const seeded = await materializedScopes(h, "startup");
    assert.equal(seeded.coverageComplete, true);
    assert.equal(seeded.items.length, 1);

    h.discovery.push(completeScan("scope:one", [terminalSession("alpha"), terminalSession("beta")]));
    const explicit = await h.owner.triggerScan();
    assert.equal(explicit, "reconciled");
    assert.equal(h.reconcilePort.calls, 2);
    const changed = await materializedScopes(h, "explicit");
    const scopeId = changed.items[0].scopeId;
    const { hostEpoch } = await h.foundation.readiness();
    const sessions = (await h.foundation.sessionsSnapshot("explicit-sessions", hostEpoch, [scopeId]))
      .payload.scopes[0];
    assert.equal(sessions.items.length, 2);

    await waitFor(() => h.reconcilePort.calls >= 3, "periodic scan");
  } finally {
    await h.owner.close();
    h.cleanup();
  }
});

test("partial/unreachable and rejected passes fail closed without deleting unobserved resources", async () => {
  const h = await harness();
  try {
    h.discovery.push(completeScan("scope:one", [terminalSession("alpha")]));
    assert.equal(await h.owner.start(), "reconciled");
    const { hostEpoch } = await h.foundation.readiness();
    const scopeId = (await materializedScopes(h, "seeded")).items[0].scopeId;
    const seededSessionId = (await h.foundation.sessionsSnapshot("seeded-s", hostEpoch, [scopeId]))
      .payload.scopes[0].items[0].sessionId;

    h.discovery.push(unreachableScan("scope:one"));
    assert.equal(await h.owner.triggerScan(), "reconciled");
    const readiness = await h.foundation.readiness();
    assert.equal(readiness.snapshotMaterializationReady, false);
    assert.equal(readiness.reason, "aggregate_coverage_partial");
    const afterPartial = (await h.foundation.sessionsSnapshot("partial-s", hostEpoch, [scopeId]))
      .payload.scopes[0];
    assert.equal(afterPartial.items.length, 1);
    assert.equal(afterPartial.items[0].sessionId, seededSessionId);

    h.discovery.push({
      coverage: "complete",
      scopes: [
        completeScan("scope:dup").scopes[0],
        { ...completeScan("scope:dup").scopes[0], sessions: [] },
      ],
    });
    assert.equal(await h.owner.triggerScan(), "failed");
    const afterFailure = (await h.foundation.sessionsSnapshot("failure-s", hostEpoch, [scopeId]))
      .payload.scopes[0];
    assert.equal(afterFailure.items.length, 1);
    assert.equal(afterFailure.items[0].sessionId, seededSessionId);

    h.discovery.push(completeScan("scope:one", [terminalSession("alpha")]));
    assert.equal(await h.owner.triggerScan(), "reconciled");
    assert.equal((await h.foundation.readiness()).snapshotMaterializationReady, true);
  } finally {
    await h.owner.close();
    h.cleanup();
  }
});

test("slow scans never overlap and coalesced triggers share one bounded successor outcome", async () => {
  const h = await harness();
  try {
    const first = barrier();
    const second = barrier();
    let secondScanStarted = false;
    h.discovery.pushDeferred(first.promise.then(() => completeScan("scope:one")));
    h.discovery.pushDeferred(second.promise.then(() => completeScan("scope:one")), () => {
      secondScanStarted = true;
    });

    const startup = h.owner.start();
    await waitFor(() => h.events.includes("scan:start"), "first scan start");

    const triggers = [
      h.owner.triggerScan(),
      h.owner.triggerScan(),
      h.owner.triggerScan(),
      h.owner.triggerScan(),
      h.owner.triggerScan(),
    ];
    for (const trigger of triggers.slice(1)) {
      assert.strictEqual(trigger, triggers[0]);
    }
    assert.equal(secondScanStarted, false);
    first.release();
    assert.equal(await startup, "reconciled");
    await waitFor(() => secondScanStarted, "coalesced successor start");
    assert.equal(h.reconcilePort.calls, 2);
    second.release();
    assert.deepEqual(await Promise.all(triggers), Array(5).fill("reconciled"));
    assert.equal(h.reconcilePort.calls, 2);
  } finally {
    await h.owner.close();
    h.cleanup();
  }
});

test("reconfigure drains the old generation before applying and issues exactly one new scan", async () => {
  const applyEvents = [];
  const applyReconfiguration = {
    apply() {
      applyEvents.push("apply");
    },
  };
  const h = await harness({ applyReconfiguration });
  try {
    const blocked = barrier();
    h.discovery.pushDeferred(blocked.promise.then(() => completeScan("scope:old")));
    h.discovery.push({
      coverage: "complete",
      scopes: [
        completeScan("scope:old").scopes[0],
        completeScan("scope:new").scopes[0],
      ],
    });
    const startup = h.owner.start();
    await waitFor(() => h.events.includes("scan:start"), "old-generation scan start");

    const reconfigured = h.owner.reconfigure({ scanIntervalMs: 5_000 });
    const coalescedA = h.owner.triggerScan();
    const coalescedB = h.owner.triggerScan();
    assert.strictEqual(coalescedA, coalescedB);
    blocked.release();

    assert.equal(await startup, "reconciled");
    assert.equal(await reconfigured, "reconciled");
    assert.equal(await coalescedA, "reconciled");
    assert.deepEqual(h.events, ["scan:start", "scan:settle", "scan:start", "scan:settle"]);
    assert.deepEqual(applyEvents, ["apply"]);
    assert.equal(h.reconcilePort.calls, 2);

    const scopes = await materializedScopes(h, "reconfigured");
    assert.deepEqual(
      scopes.items.map((item) => item.displayName).sort(),
      ["scope:new", "scope:old"],
    );
  } finally {
    await h.owner.close();
    h.cleanup();
  }
});

test("reconfigure snapshots the closed input and a failing swap rejects after scheduling the fenced scan", async () => {
  const swapError = new Error("swap failed");
  const applyReconfiguration = {
    apply() {
      throw swapError;
    },
  };
  const h = await harness({ applyReconfiguration });
  try {
    h.discovery.push(completeScan("scope:one"));
    assert.equal(await h.owner.start(), "reconciled");

    h.discovery.push(completeScan("scope:one"));
    const configuration = { scanIntervalMs: 7_000 };
    await assert.rejects(h.owner.reconfigure(configuration), (error) => error === swapError);
    configuration.scanIntervalMs = 1;
    await waitFor(
      () => h.events.filter((event) => event === "scan:settle").length === 2,
      "fail-closed follow-up scan",
    );
    assert.deepEqual(h.events, ["scan:start", "scan:settle", "scan:start", "scan:settle"]);

    h.discovery.push(completeScan("scope:one"));
    assert.equal(await h.owner.triggerScan(), "reconciled");
    assert.equal(h.reconcilePort.calls, 3);
  } finally {
    await h.owner.close();
    h.cleanup();
  }
});

test("close stops the timer, refuses triggers, and drains the started scan", async () => {
  const h = await harness({ scanIntervalMs: 10 });
  try {
    const blocked = barrier();
    h.discovery.pushDeferred(blocked.promise.then(() => completeScan("scope:one")));
    const startup = h.owner.start();
    await waitFor(() => h.events.includes("scan:start"), "in-flight scan start");

    const coalesced = h.owner.triggerScan();
    const closing = h.owner.close();
    const closingFlag = settledFlag(closing);
    assert.equal(await h.owner.triggerScan(), "closed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closingFlag.settled, false);
    assert.equal(h.reconcilePort.calls, 1);

    blocked.release();
    assert.equal(await startup, "reconciled");
    assert.equal(await coalesced, "closed");
    await closing;
    assert.strictEqual(h.owner.close(), closing);
    assert.equal(await h.owner.triggerScan(), "closed");
    assert.throws(() => h.owner.start(), /unavailable/);
    await assert.rejects(h.owner.reconfigure({ scanIntervalMs: 5_000 }), /unavailable/);

    const calls = h.reconcilePort.calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.reconcilePort.calls, calls);
  } finally {
    await h.owner.close();
    h.cleanup();
  }
});

test("closed own-data validation rejects non-closed configuration and misused lifecycle", async () => {
  const symbolKey = Symbol("extra");
  const accessorConfig = {};
  Object.defineProperty(accessorConfig, "scanIntervalMs", {
    enumerable: true,
    get() {
      return 1_000;
    },
  });
  const invalidConfigurations = [
    {},
    { scanIntervalMs: "1000" },
    { scanIntervalMs: 0 },
    { scanIntervalMs: -5 },
    { scanIntervalMs: 2_147_483_648 },
    { scanIntervalMs: 1_000, extra: true },
    { [symbolKey]: true, scanIntervalMs: 1_000 },
    accessorConfig,
    new Proxy({ scanIntervalMs: 1_000 }, {}),
  ];
  const h = await harness();
  try {
    h.discovery.push(completeScan("scope:one"));
    assert.equal(await h.owner.start(), "reconciled");
    for (const configuration of invalidConfigurations) {
      await assert.rejects(h.owner.reconfigure(configuration), TypeError);
    }
    assert.equal(h.reconcilePort.calls, 1);
  } finally {
    await h.owner.close();
    h.cleanup();
  }

  const fresh = await harness();
  try {
    assert.throws(() => fresh.owner.triggerScan(), /unavailable/);
    await assert.rejects(fresh.owner.reconfigure({ scanIntervalMs: 1_000 }), /unavailable/);
    const invalidOptions = [
      {},
      { scanIntervalMs: 1_000 },
      { reconcilePort: {}, scanIntervalMs: 1_000 },
      { reconcilePort: { reconcile: 1 }, scanIntervalMs: 1_000 },
      { reconcilePort: { reconcile() {} }, scanIntervalMs: 1_000, extra: true },
      new Proxy({ reconcilePort: { reconcile() {} }, scanIntervalMs: 1_000 }, {}),
      {
        reconcilePort: { reconcile() {} },
        applyReconfiguration: {},
        scanIntervalMs: 1_000,
      },
      {
        reconcilePort: { reconcile() {} },
        applyReconfiguration: { apply: 1 },
        scanIntervalMs: 1_000,
      },
    ];
    for (const options of invalidOptions) {
      assert.throws(
        () => new lifecycle.RelayV2MaterializedReconcileLifecycleOwner(options),
        TypeError,
      );
    }
    assert.equal(fresh.reconcilePort.calls, 0);
  } finally {
    fresh.cleanup();
  }
});
