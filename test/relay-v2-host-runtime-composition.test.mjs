import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");
const terminalDurable = await import("../dist/relay/v2/terminalDurableLineage.js");
const terminalManagerModule = await import("../dist/relay/v2/terminalManager.js");

const HOST_ID = "mac-admin";
const corpus = loadRelayV2FixtureCorpus();

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function binding(overrides = {}) {
  return Object.freeze({
    connectorGeneration: 1,
    connectorId: "composition-connector",
    routeId: "composition-route",
    routeFence: "composition-fence",
    connectionId: "composition-connection",
    clientDialect: "tw-relay.v2",
    maxFrameBytes: 1_048_576,
    authContext: Object.freeze({
      scheme: "twcap2",
      role: "client",
      hostId: HOST_ID,
      principalId: "composition-principal",
      grantId: "composition-grant",
      clientInstanceId: "composition-client",
      jti: "composition-jti",
      kid: "composition-kid",
      expiresAtMs: 1_783_703_600_000,
      ...(overrides.authContext ?? {}),
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "authContext")),
  });
}

class QueueDiscovery {
  #scans = [];

  push(scan) {
    this.#scans.push(structuredClone(scan));
  }

  async scan() {
    const scan = this.#scans.shift();
    if (!scan) throw new Error("composition test must not perform unexpected discovery");
    return structuredClone(scan);
  }
}

function terminal(backendIdentity, displayName) {
  return {
    backendIdentity,
    kind: "terminal",
    displayName,
    state: "running",
    project: null,
    label: displayName,
    cwd: `/repo/${displayName}`,
    attached: false,
    windowCount: 1,
    createdAtMs: 1_783_699_000_000,
    activityAtMs: 1_783_700_000_000,
  };
}

function scope(sessions = []) {
  return {
    backendIdentity: "local",
    displayName: "Local",
    kind: "local",
    reachability: "online",
    sessionsCompleteness: "complete",
    sessions,
    error: null,
  };
}

function firstSnapshotRequest(
  hostEpoch,
  snapshotRequestId,
  principalId = "composition-principal",
) {
  return {
    principalId,
    clientInstanceId: "composition-client",
    expectedHostEpoch: hostEpoch,
    snapshotRequestId,
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  };
}

function releaseSnapshotRequest(chunk, principalId = "composition-principal") {
  return {
    principalId,
    clientInstanceId: "composition-client",
    expectedHostEpoch: chunk.hostEpoch,
    snapshotRequestId: chunk.snapshotRequestId,
    snapshotId: chunk.snapshotId,
    reason: "completed",
  };
}

function commandExecutor(overrides = {}) {
  return {
    async resolve(request) {
      if (overrides.resolve) return overrides.resolve(request);
      throw new Error("unexpected composition command resolution");
    },
    fenceResolution(transaction, request, fence) {
      return overrides.fenceResolution?.(transaction, request, fence);
    },
    async executeTwRpc(plan) {
      if (overrides.executeTwRpc) return overrides.executeTwRpc(plan);
      throw new Error("unexpected composition TW RPC execution");
    },
    async executeTerminalControl(plan) {
      if (overrides.executeTerminalControl) return overrides.executeTerminalControl(plan);
      throw new Error("unexpected composition terminal-control execution");
    },
  };
}

function baseAuthorities(h2RecoveryCandidate, hostEpoch, hostInstanceId, overrides = {}) {
  return {
    h0: overrides.h0,
    h1RecoveryCandidate: overrides.h1RecoveryCandidate,
    h2RecoveryCandidate,
    h3RecoveryCandidate: overrides.h3RecoveryCandidate,
  };
}

function openComposition(h2RecoveryCandidate, hostEpoch, hostInstanceId, overrides = {}) {
  const authorities = baseAuthorities(h2RecoveryCandidate, hostEpoch, hostInstanceId, overrides);
  overrides.captureAuthorities?.(authorities);
  return compositionModule.openRelayV2HostRuntimeComposition({
    hostId: HOST_ID,
    hostEpoch,
    hostInstanceId,
    authorities,
    welcome: overrides.welcome ?? {
      build() { throw new Error("unexpected welcome build"); },
    },
    outbound: overrides.outbound ?? {
      trySend() { throw new Error("unexpected outbound frame"); },
      close() { throw new Error("unexpected route close"); },
    },
  });
}

function activateRemainingReadinessSources(composition, generation = "1") {
  assert.equal(composition.readiness.carrier.apply({
    source: "carrier",
    generation,
    ready: true,
  }), true);
  assert.equal(composition.readiness.h1.apply, undefined);
  assert.equal(composition.readiness.h1.execute, undefined);
  assert.equal(composition.readiness.h1.query, undefined);
  assert.equal(composition.readiness.h1.issueDedupeWindow, undefined);
  assert.equal(composition.readiness.h3.apply, undefined);
  assert.equal(composition.readiness.h3.activate(), true);
}

async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function realCompositionHarness({
  now,
  spoolLimits,
  spoolHooks,
  wrapSpool,
  compositionOverrides,
  h3ManagerOverrides,
  activateH0 = true,
  beforeCompositionOpen,
  concurrentCompositionOpen = false,
  openInitialComposition = true,
  expectCompositionFailure = false,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-host-composition-"));
  const store = await hostState.RelayV2HostStateStore.open({
    paths: hostState.relayV2HostStatePaths(home),
  });
  const discovery = new QueueDiscovery();
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: HOST_ID,
    discovery,
    store,
    readinessSink: { apply: () => true },
    now,
  });
  discovery.push({
    coverage: "complete",
    scopes: [scope([terminal("pane:a", "alpha")])],
  });
  const seeded = await foundation.reconcile();
  const wrapped = wrapSpool?.() ?? null;
  const spoolRoot = join(home, "snapshot-spool");
  const publisherSpool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
    now,
    testLimits: spoolLimits,
  });
  const recoveredPrincipalId = "composition-recovered-principal";
  const recoveredChunk = await publisherSpool.get(firstSnapshotRequest(
    seeded.snapshot.hostEpoch,
    "composition-recovered-h2",
    recoveredPrincipalId,
  ));
  await publisherSpool.close();
  const spool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
    now,
    testLimits: spoolLimits,
    testHooks: { ...spoolHooks, ...wrapped?.testHooks },
  });
  const h2RecoveryCandidate = await spool.issueRecoveredHostH2Candidate();
  assert.notEqual(h2RecoveryCandidate, null);
  const terminalLineage = new terminalDurable.RelayV2TerminalDurableLineageAuthority({ store });
  const h3Manager = new terminalManagerModule.RelayV2TerminalManager({
    hostId: HOST_ID,
    hostEpoch: seeded.snapshot.hostEpoch,
    hostInstanceId: store.hostInstanceId,
    resolver: { async resolve() { throw new Error("unexpected terminal resolve"); } },
    lineage: terminalLineage,
    backend: { async open() { throw new Error("unexpected terminal backend open"); } },
    terminalControl: {},
    async send() { throw new Error("unexpected terminal frame"); },
  });
  Object.assign(h3Manager, h3ManagerOverrides);
  const h3RecoveryCandidate = await terminalLineage.recoverForHostH3(h3Manager);
  const h1RecoveryCandidate = await commandPlane.RelayV2HostCommandPlane
    .openRecoveredAuthority({
      store,
      hostId: HOST_ID,
      executor: commandExecutor(compositionOverrides?.h1Executor),
      now: () => 1_783_700_000_000,
    });
  assert.notEqual(h1RecoveryCandidate, null);
  await beforeCompositionOpen?.({
    candidate: h2RecoveryCandidate,
    hostEpoch: seeded.snapshot.hostEpoch,
    hostInstanceId: store.hostInstanceId,
  });
  const openRecoveredComposition = () => openComposition(
    h2RecoveryCandidate,
    seeded.snapshot.hostEpoch,
    store.hostInstanceId,
    {
      ...compositionOverrides,
      h0: store.h0ReadinessPort,
      h1RecoveryCandidate,
      h3RecoveryCandidate,
    },
  );
  let compositionAttempts = null;
  let composition = null;
  let constructionError = null;
  try {
    compositionAttempts = !openInitialComposition
      ? null
      : concurrentCompositionOpen
        ? await Promise.allSettled([openRecoveredComposition(), openRecoveredComposition()])
        : null;
    composition = !openInitialComposition
      ? null
      : compositionAttempts === null
        ? await openRecoveredComposition()
        : compositionAttempts.find((attempt) => attempt.status === "fulfilled")?.value;
    if (openInitialComposition) assert.notEqual(composition, undefined);
  } catch (error) {
    if (!expectCompositionFailure) throw error;
    constructionError = error;
  }
  if (activateH0 && composition !== null) {
    assert.equal(await composition.readiness.h0.activate(), true);
  }
  if (composition !== null) wrapped?.attach?.(composition);
  let readinessPrincipalOrdinal = 0;
  return {
    home,
    store,
    discovery,
    foundation,
    seeded,
    terminalLineage,
    h3Manager,
    h3RecoveryCandidate,
    h1RecoveryCandidate,
    h2RecoveryCandidate,
    recoveredChunk,
    recoveredPrincipalId,
    spool,
    composition,
    compositionAttempts,
    constructionError,
    wrapped,
    nextReadinessPrincipalId() {
      readinessPrincipalOrdinal += 1;
      assert.ok(
        readinessPrincipalOrdinal <= 16,
        "composition harness readiness principal bound exceeded",
      );
      return `composition-readiness-principal-${readinessPrincipalOrdinal}`;
    },
    async cleanup({ closeSpool = true } = {}) {
      await composition?.dispose();
      if (closeSpool) await spool.close().catch(() => undefined);
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function controlledSpoolAdapter() {
  const releaseCounts = new Map();
  const controls = {
    beforeVerify: null,
    beforeActivate: null,
    onRelease: null,
  };
  const testHooks = {
    beforeReadinessReceiptVerify(receipt, expected) {
      const callback = controls.beforeVerify;
      controls.beforeVerify = null;
      callback?.(receipt, expected);
    },
    beforeReadinessReceiptActivation() {
      const before = controls.beforeActivate;
      controls.beforeActivate = null;
      before?.();
    },
    afterReadinessActivationRelease(lease, released) {
      assert.equal(released, true);
      releaseCounts.set(lease, (releaseCounts.get(lease) ?? 0) + 1);
      const callback = controls.onRelease;
      controls.onRelease = null;
      return callback?.(lease);
    },
  };
  return { testHooks, controls, releaseCounts };
}

function descriptorReentryProxy(target, callback) {
  let fired = false;
  return {
    proxy: new Proxy(target, {
      ownKeys(value) {
        if (!fired) {
          fired = true;
          callback();
        }
        return Reflect.ownKeys(value);
      },
    }),
    fired: () => fired,
  };
}

function delayedActivationCloseAdapter() {
  const pendingCloses = [];
  const releaseCounts = new Map();
  return {
    testHooks: {
      wrapReadinessActivationSink(sink) {
        return {
          enqueue: (event) => sink.enqueue(event),
          close(error) {
            pendingCloses.push(() => sink.close?.(error));
          },
        };
      },
      afterReadinessActivationRelease(lease, released) {
        assert.equal(released, true);
        releaseCounts.set(lease, (releaseCounts.get(lease) ?? 0) + 1);
      },
    },
    releaseCounts,
    flushLateCloses() {
      for (const close of pendingCloses.splice(0)) close();
    },
  };
}

test("async host composition returns only after exact recovered H2 activation", async () => {
  const h = await realCompositionHarness({ activateH0: false });
  try {
    assert.equal(h.composition.readiness.h0.apply, undefined);
    assert.equal(h.composition.readiness.h1.apply, undefined);
    assert.equal(h.composition.readiness.h1.execute, undefined);
    assert.equal(h.composition.readiness.h1.query, undefined);
    assert.equal(h.composition.readiness.h1.issueDedupeWindow, undefined);
    assert.equal(Object.isFrozen(h.composition.readiness.codec), true);
    assert.deepEqual(Object.keys(h.composition.readiness.codec), ["close"]);
    assert.equal(h.composition.readiness.codec.apply, undefined);
    assert.equal(h.composition.readiness.codec.activate, undefined);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    activateRemainingReadinessSources(h.composition);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.equal(
      h.composition.routeSink.onRouteBound(binding()).code,
      "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(Object.isFrozen(h.composition.readiness.h2), true);
    assert.deepEqual(Object.keys(h.composition.readiness.h2), ["close"]);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.equal(await h.composition.readiness.h0.activate(), true);
    assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
  } finally {
    await h.cleanup();
  }
});

test("production codec readiness is close-only and cannot re-enter after withdrawal", async () => {
  const h = await realCompositionHarness();
  try {
    activateRemainingReadinessSources(h.composition);
    assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
    const readyGeneration = BigInt(h.composition.readiness.current().generation);
    h.composition.readiness.codec.close();
    const withdrawn = h.composition.readiness.current();
    assert.ok(BigInt(withdrawn.generation) > readyGeneration);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    h.composition.readiness.codec.close();
    assert.equal(h.composition.readiness.current(), withdrawn);
    assert.equal(
      h.composition.routeSink.onRouteBound(binding()).code,
      "CAPABILITY_UNAVAILABLE",
    );
  } finally {
    await h.cleanup();
  }
});

test("composition burns mismatched recovered H1 and retires already-created owners", async () => {
  let shutdownCalls = 0;
  const h = await realCompositionHarness({
    activateH0: false,
    openInitialComposition: false,
  });
  try {
    const replacementLineage = new terminalDurable.RelayV2TerminalDurableLineageAuthority({
      store: h.store,
    });
    const replacementManager = new terminalManagerModule.RelayV2TerminalManager({
      hostId: HOST_ID,
      hostEpoch: h.seeded.snapshot.hostEpoch,
      hostInstanceId: h.store.hostInstanceId,
      resolver: { async resolve() { throw new Error("unexpected terminal resolve"); } },
      lineage: replacementLineage,
      backend: { async open() { throw new Error("unexpected terminal backend open"); } },
      terminalControl: {},
      async send() { throw new Error("unexpected terminal frame"); },
    });
    replacementManager.shutdown = async () => { shutdownCalls += 1; };
    const h3RecoveryCandidate = await replacementLineage
      .recoverForHostH3(replacementManager);
    const mismatchedCandidate = await commandPlane.RelayV2HostCommandPlane
      .openRecoveredAuthority({
        store: h.store,
        hostId: `${HOST_ID}-wrong`,
        executor: commandExecutor(),
        now: () => 1_783_700_000_000,
      });
    assert.notEqual(mismatchedCandidate, null);
    await assert.rejects(
      openComposition(
        h.h2RecoveryCandidate,
        h.seeded.snapshot.hostEpoch,
        h.store.hostInstanceId,
        {
          h0: h.store.h0ReadinessPort,
          h1RecoveryCandidate: mismatchedCandidate,
          h3RecoveryCandidate,
        },
      ),
      /invalid Relay v2 H1 recovery candidate/,
    );
    await settle();
    assert.equal(shutdownCalls, 1);
    const readinessState = { applied: 0, closed: 0 };
    assert.equal(compositionModule.createRelayV2HostH1ReadinessActivation({
      hostId: `${HOST_ID}-wrong`,
      hostEpoch: h.seeded.snapshot.hostEpoch,
      hostInstanceId: h.store.hostInstanceId,
      candidate: mismatchedCandidate,
      readinessSink: {
        apply() { readinessState.applied += 1; return true; },
        close() { readinessState.closed += 1; },
      },
    }), null);
    assert.deepEqual(readinessState, { applied: 0, closed: 0 });
  } finally {
    await h.cleanup();
  }
});

test("composition rejects a complete self-signing forged H0 port", async () => {
  const h = await realCompositionHarness({
    activateH0: false,
    openInitialComposition: false,
  });
  try {
    let forgedCalls = 0;
    const forgedReceipt = Object.freeze(() => undefined);
    const forgedLease = Object.freeze(() => undefined);
    const forgedBinding = Object.freeze({
      hostEpoch: h.seeded.snapshot.hostEpoch,
      hostInstanceId: h.store.hostInstanceId,
      commitSeq: "18446744073709551615",
      proofGeneration: "18446744073709551615",
    });
    const forgedPort = Object.create(null);
    for (const [name, value] of Object.entries({
      async read() {
        forgedCalls += 1;
        return h.store.read();
      },
      async issueReadinessReceipt() {
        forgedCalls += 1;
        return { receipt: forgedReceipt, binding: forgedBinding };
      },
      consumeReadinessReceipt() {
        forgedCalls += 1;
        return forgedLease;
      },
      discardReadinessReceipt() {
        forgedCalls += 1;
        return true;
      },
      releaseReadinessLease() {
        forgedCalls += 1;
        return true;
      },
    })) {
      Object.defineProperty(forgedPort, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value,
      });
    }
    Object.freeze(forgedPort);

    await assert.rejects(
      openComposition(
        h.h2RecoveryCandidate,
        h.seeded.snapshot.hostEpoch,
        h.store.hostInstanceId,
        { h0: forgedPort },
      ),
      /invalid Relay v2 H0 readiness port/,
    );
    assert.equal(forgedCalls, 0);
  } finally {
    await h.cleanup();
  }
});

test("recovered H2 candidate is bound to the canonical private composition receiver", async () => {
  let foreignResult;
  const h = await realCompositionHarness({
    concurrentCompositionOpen: true,
    async beforeCompositionOpen({ candidate }) {
      assert.equal(Object.isFrozen(candidate), true);
      assert.equal(Object.getPrototypeOf(candidate), null);
      assert.deepEqual(Reflect.ownKeys(candidate), []);
      assert.equal(candidate.receiver, undefined);
      assert.equal(candidate.activate, undefined);
      const foreignCompositionEntry = await import(new URL(
        `../dist/relay/v2/hostRuntimeComposition.js?foreign-pair=${Date.now()}`,
        import.meta.url,
      ));
      const foreignPair = foreignCompositionEntry
        .issueRelayV2RecoveredHostH2CompositionPair();
      foreignResult = await foreignCompositionEntry
        .completeRelayV2HostRuntimeCompositionFromRecoveredH2(
          foreignPair,
          candidate,
          {},
        );
    },
  });
  try {
    assert.equal(foreignResult, null);
    assert.equal(
      h.compositionAttempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    assert.equal(
      h.compositionAttempts.filter((attempt) => attempt.status === "rejected").length,
      1,
    );
    await assert.rejects(
      openComposition(
        h.h2RecoveryCandidate,
        h.seeded.snapshot.hostEpoch,
        h.store.hostInstanceId,
        {
          h0: h.store.h0ReadinessPort,
          h1RecoveryCandidate: h.h1RecoveryCandidate,
        },
      ),
      /invalid Relay v2 recovered H2 candidate or composition receiver/,
    );
  } finally {
    await h.cleanup();
  }
});

test("recovered H2 claim rejects accessors before claim and cancels once after claim", async () => {
  let cancellations = 0;
  let activationReleases = 0;
  const h = await realCompositionHarness({
    openInitialComposition: false,
    spoolHooks: {
      afterRecoveredHostH2CandidateCancel() { cancellations += 1; },
      afterReadinessActivationRelease(_activation, released) {
        if (released) activationReleases += 1;
      },
    },
  });
  try {
    const authorities = baseAuthorities(
      h.h2RecoveryCandidate,
      h.seeded.snapshot.hostEpoch,
      h.store.hostInstanceId,
      {
        h0: h.store.h0ReadinessPort,
        h1RecoveryCandidate: h.h1RecoveryCandidate,
        h3RecoveryCandidate: h.h3RecoveryCandidate,
      },
    );
    const beforeClaim = {
      hostId: HOST_ID,
      hostEpoch: h.seeded.snapshot.hostEpoch,
      hostInstanceId: h.store.hostInstanceId,
    };
    Object.defineProperty(beforeClaim, "authorities", {
      enumerable: true,
      get() { throw new Error("preclaim authority accessor"); },
    });
    await assert.rejects(
      compositionModule.openRelayV2HostRuntimeComposition(beforeClaim),
      /invalid Relay v2 recovered H2 candidate or composition receiver/,
    );
    assert.equal(cancellations, 0);
    const proxyBeforeClaim = new Proxy({
      hostId: HOST_ID,
      hostEpoch: h.seeded.snapshot.hostEpoch,
      hostInstanceId: h.store.hostInstanceId,
      authorities,
    }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "authorities") throw new Error("preclaim descriptor trap");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    await assert.rejects(
      compositionModule.openRelayV2HostRuntimeComposition(proxyBeforeClaim),
      /invalid Relay v2 recovered H2 candidate or composition receiver/,
    );
    assert.equal(cancellations, 0);

    const afterClaim = {
      hostId: HOST_ID,
      hostEpoch: h.seeded.snapshot.hostEpoch,
      hostInstanceId: h.store.hostInstanceId,
      authorities,
      outbound: { trySend() { return false; }, close() {} },
    };
    Object.defineProperty(afterClaim, "welcome", {
      enumerable: true,
      get() { throw new Error("claimed welcome accessor"); },
    });
    await assert.rejects(
      compositionModule.openRelayV2HostRuntimeComposition(afterClaim),
      /claimed welcome accessor/,
    );
    assert.equal(cancellations, 1);
    assert.equal(activationReleases, 1);
    await assert.rejects(
      compositionModule.openRelayV2HostRuntimeComposition(afterClaim),
      /invalid Relay v2 recovered H2 candidate or composition receiver/,
    );
    assert.equal(cancellations, 1);
    assert.equal(activationReleases, 1);
    const replacement = await h.spool.issueRecoveredHostH2Candidate();
    assert.notEqual(replacement, null);
    assert.deepEqual(Reflect.ownKeys(replacement), []);
  } finally {
    await h.cleanup();
  }
});

test("recovered H2 internal receipt rejects a fence wait crossing cut expiry", async () => {
  let now = 2_000;
  let cancellations = 0;
  const h = await realCompositionHarness({
    now: () => now,
    spoolLimits: { idleLeaseMs: 10, absoluteLeaseMs: 20 },
    expectCompositionFailure: true,
    spoolHooks: {
      beforeReadinessReceiptCandidateFence() { now += 10; },
      afterRecoveredHostH2CandidateCancel() { cancellations += 1; },
    },
  });
  try {
    assert.equal(h.composition, null);
    assert.match(
      String(h.constructionError),
      /invalid Relay v2 recovered H2 composition receiver/,
    );
    assert.equal(cancellations, 1);
    assert.equal(await h.spool.issueRecoveredHostH2Candidate(), null);
  } finally {
    await h.cleanup();
  }
});

test("composition derives the dedupe window only from the H1 owner fixed lifetime", async () => {
  // The composition plane clock is fixed at 1_783_700_000_000; the H1 owner
  // alone issues acceptUntilMs = now + 15min and queryUntilMs covering 7d.
  const acceptUntilMs = 1_783_700_900_000;
  const queryUntilMs = acceptUntilMs + commandPlane.RELAY_V2_COMMAND_DEDUPE_RETENTION_MS;
  const outboundFrames = [];
  const h = await realCompositionHarness({
    compositionOverrides: {
      welcome: {
        build(input) {
          assert.equal(typeof input.commandDedupeWindow.windowId, "string");
          assert.deepEqual({
            acceptUntilMs: input.commandDedupeWindow.acceptUntilMs,
            queryUntilMs: input.commandDedupeWindow.queryUntilMs,
          }, { acceptUntilMs, queryUntilMs });
          const welcome = fixture("host-welcome-snapshot-required");
          welcome.requestId = input.hello.requestId;
          welcome.hostId = HOST_ID;
          welcome.hostEpoch = input.cut.hostEpoch;
          welcome.hostInstanceId = input.cut.hostInstanceId;
          welcome.payload.eventSeq = input.cut.eventSeq;
          welcome.payload.capabilities = [...input.capabilities];
          welcome.payload.commandDedupeWindow = structuredClone(input.commandDedupeWindow);
          return welcome;
        },
      },
      outbound: {
        trySend(_route, payload, receipt) {
          outboundFrames.push(codec.decodeRelayV2WebSocketFrame("public", payload).frame);
          receipt.settle(true);
          return true;
        },
        close() {},
      },
    },
  });
  try {
    activateRemainingReadinessSources(h.composition);
    const route = binding();
    assert.equal(h.composition.routeSink.onRouteBound(route), undefined);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.authContext.clientInstanceId;
    h.composition.routeSink.onClientFrame(
      route,
      codec.encodeRelayV2WebSocketFrame("public", hello),
    );
    await settle();
    const query = fixture("command-query");
    query.expectedHostEpoch = h.seeded.snapshot.hostEpoch;
    h.composition.routeSink.onClientFrame(
      route,
      codec.encodeRelayV2WebSocketFrame("public", query),
    );
    await settle();
    assert.equal(outboundFrames.at(-1).type, "command.statuses");
    assert.equal(outboundFrames.at(-1).requestId, query.requestId);
    assert.equal(outboundFrames.at(-1).hostEpoch, h.seeded.snapshot.hostEpoch);
  } finally {
    await h.cleanup();
  }
});

test("fatal recovered H1 withdrawal fences an active route with 4406", async () => {
  const outboundFrames = [];
  const routeCloses = [];
  const h = await realCompositionHarness({
    compositionOverrides: {
      h1Executor: {
        resolve() {
          throw new commandPlane.RelayV2HostCommandPlaneStateError(
            "fatal composed H1 state",
          );
        },
      },
      welcome: {
        build(input) {
          const welcome = fixture("host-welcome-snapshot-required");
          welcome.requestId = input.hello.requestId;
          welcome.hostId = HOST_ID;
          welcome.hostEpoch = input.cut.hostEpoch;
          welcome.hostInstanceId = input.cut.hostInstanceId;
          welcome.payload.eventSeq = input.cut.eventSeq;
          welcome.payload.capabilities = [...input.capabilities];
          welcome.payload.commandDedupeWindow = structuredClone(input.commandDedupeWindow);
          return welcome;
        },
      },
      outbound: {
        trySend(_route, payload, receipt) {
          outboundFrames.push(codec.decodeRelayV2WebSocketFrame("public", payload).frame);
          receipt.settle(true);
          return true;
        },
        close(_route, close) {
          routeCloses.push(structuredClone(close));
        },
      },
    },
  });
  try {
    activateRemainingReadinessSources(h.composition);
    const route = binding();
    assert.equal(h.composition.routeSink.onRouteBound(route), undefined);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.authContext.clientInstanceId;
    h.composition.routeSink.onClientFrame(
      route,
      codec.encodeRelayV2WebSocketFrame("public", hello),
    );
    await settle();
    const welcome = outboundFrames.at(-1);
    assert.equal(welcome.type, "host.welcome");

    const execute = fixture("command-execute-send-agent-message");
    execute.expectedHostEpoch = h.seeded.snapshot.hostEpoch;
    execute.payload.dedupeWindowId = welcome.payload.commandDedupeWindow.windowId;
    h.composition.routeSink.onClientFrame(
      route,
      codec.encodeRelayV2WebSocketFrame("public", execute),
    );
    await settle();
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.deepEqual(routeCloses[0], {
      code: 4406,
      reason: "capability_withdrawn",
    });
  } finally {
    await h.cleanup();
  }
});

test("active H2 receipt authority is withdrawn by every owning lease boundary", async (t) => {
  await t.test("explicit composition close permanently fences the recovered generation", async () => {
    const h = await realCompositionHarness();
    try {
      activateRemainingReadinessSources(h.composition);
      assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
      h.composition.readiness.h2.close();
      h.composition.readiness.h2.close();
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("snapshot release closes the activation sink and withdraws H2", async () => {
    const h = await realCompositionHarness();
    try {
      activateRemainingReadinessSources(h.composition);
      await h.spool.release(releaseSnapshotRequest(
        h.recoveredChunk,
        h.recoveredPrincipalId,
      ));
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("snapshot cleanup observes expiry and withdraws H2", async () => {
    let now = 1_000;
    const h = await realCompositionHarness({
      now: () => now,
      spoolLimits: { idleLeaseMs: 10, absoluteLeaseMs: 20 },
    });
    try {
      activateRemainingReadinessSources(h.composition);
      now += 10;
      await h.spool.cleanupExpired();
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("snapshot owner takeover withdraws the predecessor H2 lease", async () => {
    const h = await realCompositionHarness();
    let successor;
    try {
      activateRemainingReadinessSources(h.composition);
      successor = await snapshotSpool.RelayV2StateSnapshotSpool.open({
        hostId: HOST_ID,
        cutSource: h.foundation.snapshotCutSource,
        root: h.spool.paths.root,
        ownerInstanceId: h.store.hostInstanceId,
        takeoverExistingOwner: true,
      });
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    } finally {
      if (successor) await successor.close().catch(() => undefined);
      await h.cleanup({ closeSpool: false });
    }
  });

  await t.test("snapshot spool close withdraws H2 before owner cleanup completes", async () => {
    const h = await realCompositionHarness();
    try {
      activateRemainingReadinessSources(h.composition);
      await h.spool.close();
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    } finally {
      await h.cleanup({ closeSpool: false });
    }
  });
});

test("composition dispose publishes one reentrant barrier and waits for H1 and H3", async () => {
  let releaseShutdown;
  let rejectH1;
  let signalH1Entered;
  const shutdownBarrier = new Promise((resolve) => { releaseShutdown = resolve; });
  const h1Entered = new Promise((resolve) => { signalH1Entered = resolve; });
  let shutdownCalls = 0;
  let issuedWindow = null;
  const h = await realCompositionHarness({
    wrapSpool: controlledSpoolAdapter,
    h3ManagerOverrides: {
      shutdown() {
        shutdownCalls += 1;
        return shutdownBarrier;
      },
    },
    compositionOverrides: {
      h1Executor: {
        resolve() {
          return new Promise((_resolve, reject) => {
            rejectH1 = reject;
            signalH1Entered();
          });
        },
      },
      welcome: {
        build(input) {
          issuedWindow = structuredClone(input.commandDedupeWindow);
          const welcome = fixture("host-welcome-snapshot-required");
          welcome.requestId = input.hello.requestId;
          welcome.hostId = HOST_ID;
          welcome.hostEpoch = input.cut.hostEpoch;
          welcome.hostInstanceId = input.cut.hostInstanceId;
          welcome.payload.eventSeq = input.cut.eventSeq;
          welcome.payload.capabilities = [...input.capabilities];
          welcome.payload.commandDedupeWindow = structuredClone(input.commandDedupeWindow);
          return welcome;
        },
      },
      outbound: {
        trySend(_route, _payload, receipt) {
          receipt.settle(true);
          return true;
        },
        close() {},
      },
    },
  });
  try {
    activateRemainingReadinessSources(h.composition);
    const route = binding();
    assert.equal(h.composition.routeSink.onRouteBound(route), undefined);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.authContext.clientInstanceId;
    h.composition.routeSink.onClientFrame(
      route,
      codec.encodeRelayV2WebSocketFrame("public", hello),
    );
    await settle();
    assert.notEqual(issuedWindow, null);
    const execute = fixture("command-execute-send-agent-message");
    execute.expectedHostEpoch = h.seeded.snapshot.hostEpoch;
    execute.payload.dedupeWindowId = issuedWindow.windowId;
    h.composition.routeSink.onClientFrame(
      route,
      codec.encodeRelayV2WebSocketFrame("public", execute),
    );
    await h1Entered;
    let reentrantDispose = null;
    h.wrapped.controls.onRelease = () => {
      reentrantDispose = h.composition.dispose();
    };

    const firstDispose = h.composition.dispose();
    const secondDispose = h.composition.dispose();
    assert.equal(reentrantDispose, firstDispose);
    assert.equal(secondDispose, firstDispose);
    let settled = false;
    void firstDispose.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
    assert.equal(settled, false);

    releaseShutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "H1 admitted command must drain before disposal settles");
    rejectH1(new TypeError("release admitted H1 command"));
    await firstDispose;
    assert.equal(settled, true);
  } finally {
    releaseShutdown?.();
    rejectH1?.(new TypeError("cleanup admitted H1 command"));
    await h.cleanup();
  }
});
