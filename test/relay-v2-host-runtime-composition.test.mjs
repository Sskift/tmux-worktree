import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");

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

function baseAuthorities(snapshotAuthority, hostEpoch, hostInstanceId, overrides = {}) {
  return {
    h0: overrides.h0 ?? {
      async read() { return { hostEpoch, hostInstanceId }; },
    },
    h1: overrides.h1 ?? {
      async execute() { throw new Error("unexpected H1 execute"); },
      async query() { throw new Error("unexpected H1 query"); },
      async issueDedupeWindow() { throw new Error("unexpected H1 window"); },
    },
    h2SnapshotAuthority: snapshotAuthority,
    h3: {
      async open() { throw new Error("unexpected H3 open"); },
      async requestReplay() { throw new Error("unexpected H3 replay"); },
      async acknowledgeOutput() { throw new Error("unexpected H3 ack"); },
      async input() { throw new Error("unexpected H3 input"); },
      async resize() { throw new Error("unexpected H3 resize"); },
      async close() { throw new Error("unexpected H3 close"); },
      async unbind() {},
    },
    nextDedupeWindowBounds: overrides.nextDedupeWindowBounds ?? function () {
      throw new Error("unexpected dedupe policy");
    },
  };
}

function createComposition(snapshotAuthority, hostEpoch, hostInstanceId, overrides = {}) {
  const authorities = baseAuthorities(snapshotAuthority, hostEpoch, hostInstanceId, overrides);
  overrides.captureAuthorities?.(authorities);
  return compositionModule.createRelayV2HostRuntimeComposition({
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

function applyFiveReadySources(composition, generation = "1") {
  for (const source of ["codec", "carrier", "h0", "h1", "h3"]) {
    assert.equal(composition.readiness[source].apply({
      source,
      generation,
      ready: true,
    }), true);
  }
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
  const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
    hostId: HOST_ID,
    materializedStateAuthority: foundation.snapshotAuthorityBundle,
    root: join(home, "snapshot-spool"),
    ownerInstanceId: store.hostInstanceId,
    now,
    testLimits: spoolLimits,
    testHooks: { ...spoolHooks, ...wrapped?.testHooks },
  });
  assert.notEqual(spool.hostH2Authority, null);
  const composition = createComposition(
    spool.hostH2Authority,
    seeded.snapshot.hostEpoch,
    store.hostInstanceId,
    { ...compositionOverrides, h0: store },
  );
  wrapped?.attach?.(composition);
  let readinessPrincipalOrdinal = 0;
  return {
    home,
    store,
    discovery,
    foundation,
    seeded,
    spool,
    composition,
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
      composition.dispose();
      if (closeSpool) await spool.close().catch(() => undefined);
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

async function issueReadiness(harness, snapshotRequestId) {
  const principalId = harness.nextReadinessPrincipalId();
  const chunk = await harness.spool.get(firstSnapshotRequest(
    harness.seeded.snapshot.hostEpoch,
    snapshotRequestId,
    principalId,
  ));
  return {
    chunk,
    principalId,
    issue: await harness.spool.issueReadinessReceipt(chunk.snapshotId),
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

function forgeOpaqueAuthority(authority, { issuerMode = "same", fields = {} } = {}) {
  const issuerKey = Object.getOwnPropertySymbols(authority).find((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(authority, key);
    return descriptor
      && Object.hasOwn(descriptor, "value")
      && ((typeof descriptor.value === "object" && descriptor.value !== null)
        || typeof descriptor.value === "function");
  });
  assert.notEqual(issuerKey, undefined);
  const issuerDescriptor = Object.getOwnPropertyDescriptor(authority, issuerKey);
  const exactIssuer = issuerDescriptor.value;
  let issuer = exactIssuer;
  if (issuerMode === "proxy") issuer = new Proxy(exactIssuer, {});
  if (issuerMode === "copied_verifier") {
    const verifierKey = Object.getOwnPropertySymbols(exactIssuer).find((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(exactIssuer, key);
      return descriptor && Object.hasOwn(descriptor, "value")
        && typeof descriptor.value === "function";
    });
    assert.notEqual(verifierKey, undefined);
    issuer = {};
    Object.defineProperty(
      issuer,
      verifierKey,
      Object.getOwnPropertyDescriptor(exactIssuer, verifierKey),
    );
    Object.freeze(issuer);
  }
  const forged = () => undefined;
  Object.defineProperty(forged, issuerKey, {
    ...issuerDescriptor,
    value: issuer,
  });
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(forged, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  return Object.freeze(forged);
}

test("default-off host composition cannot advertise before exact H2 activation", async () => {
  const h = await realCompositionHarness();
  try {
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    applyFiveReadySources(h.composition);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.equal(
      h.composition.routeSink.onRouteBound(binding()).code,
      "CAPABILITY_UNAVAILABLE",
    );
  } finally {
    await h.cleanup();
  }
});

test("cross-entry H2 authority accepts only both exact issuer bundles", async () => {
  const h = await realCompositionHarness();
  try {
    const independentH2 = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: HOST_ID,
      discovery: new QueueDiscovery(),
      store: h.store,
      readinessSink: { apply: () => true },
    });
    const materializedForgeries = [
      forgeOpaqueAuthority(h.foundation.snapshotAuthorityBundle),
      forgeOpaqueAuthority(h.foundation.snapshotAuthorityBundle, {
        issuerMode: "copied_verifier",
      }),
      forgeOpaqueAuthority(h.foundation.snapshotAuthorityBundle, { issuerMode: "proxy" }),
      forgeOpaqueAuthority(h.foundation.snapshotAuthorityBundle, {
        fields: { runtimeH2: independentH2 },
      }),
      new Proxy(h.foundation.snapshotAuthorityBundle, {}),
    ];
    for (const [index, materializedStateAuthority] of materializedForgeries.entries()) {
      await assert.rejects(
        snapshotSpool.RelayV2StateSnapshotSpool.open({
          hostId: HOST_ID,
          materializedStateAuthority,
          root: join(h.home, `forged-materialized-${index}`),
          ownerInstanceId: h.store.hostInstanceId,
        }),
        (error) => error?.code === "INVALID_ARGUMENT",
      );
    }

    const hostForgeries = [
      forgeOpaqueAuthority(h.spool.hostH2Authority),
      forgeOpaqueAuthority(h.spool.hostH2Authority, { issuerMode: "copied_verifier" }),
      forgeOpaqueAuthority(h.spool.hostH2Authority, { issuerMode: "proxy" }),
      forgeOpaqueAuthority(h.spool.hostH2Authority, {
        fields: { runtimeH2: independentH2 },
      }),
      new Proxy(h.spool.hostH2Authority, {}),
    ];
    for (const hostAuthority of hostForgeries) {
      assert.throws(
        () => createComposition(
          hostAuthority,
          h.seeded.snapshot.hostEpoch,
          h.store.hostInstanceId,
          { h0: h.store },
        ),
        /invalid Relay v2 bound H2 snapshot authority/,
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("composition preserves the exact top-level dedupe policy receiver", async () => {
  let expectedReceiver = null;
  let observedReceiver = null;
  let policyCalls = 0;
  const acceptUntilMs = 1_783_786_400_000;
  const queryUntilMs = 1_784_391_200_000;
  const h = await realCompositionHarness({
    compositionOverrides: {
      captureAuthorities(authorities) {
        expectedReceiver = authorities;
      },
      nextDedupeWindowBounds() {
        observedReceiver = this;
        policyCalls += 1;
        return { acceptUntilMs, queryUntilMs };
      },
      h1: {
        async execute() { throw new Error("unexpected H1 execute"); },
        async query() { throw new Error("unexpected H1 query"); },
        async issueDedupeWindow(bounds) {
          assert.deepEqual(bounds, { acceptUntilMs, queryUntilMs });
          return {
            windowId: "composition-dedupe-window",
            windowSeq: "1",
            acceptUntilMs,
            queryUntilMs,
          };
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
        trySend(_route, _payload, receipt) {
          receipt.settle(true);
          return true;
        },
        close() {},
      },
    },
  });
  try {
    applyFiveReadySources(h.composition);
    const active = await issueReadiness(h, "composition-dedupe-receiver");
    assert.equal(await h.composition.readiness.h2.activate(active.issue), true);
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
    assert.equal(policyCalls, 1);
    assert.equal(observedReceiver, expectedReceiver);
  } finally {
    await h.cleanup();
  }
});

test("H2 readiness accepts only the exact same-spool owner receipt and completed activation", async () => {
  const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
  try {
    applyFiveReadySources(h.composition);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.equal(await h.composition.readiness.h2.activate(null), false);

    let { issue } = await issueReadiness(h, "composition-exact-receipt");
    const copiedReceipt = () => undefined;
    Object.setPrototypeOf(copiedReceipt, Object.getPrototypeOf(issue.receipt));
    assert.equal(await h.composition.readiness.h2.activate({
      receipt: copiedReceipt,
      binding: issue.binding,
    }), false);
    assert.equal(await h.composition.readiness.h2.activate({
      receipt: Object.create(issue.receipt),
      binding: issue.binding,
    }), false);

    const foreignSpool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: HOST_ID,
      cutSource: h.foundation.snapshotCutSource,
      root: join(h.home, "foreign-snapshot-spool"),
      ownerInstanceId: h.store.hostInstanceId,
    });
    try {
      const foreignChunk = await foreignSpool.get(firstSnapshotRequest(
        h.seeded.snapshot.hostEpoch,
        "composition-foreign-spool",
      ));
      const foreignIssue = await foreignSpool.issueReadinessReceipt(foreignChunk.snapshotId);
      assert.deepEqual(foreignIssue.binding, issue.binding);
      assert.equal(await h.composition.readiness.h2.activate(foreignIssue), false);
    } finally {
      await foreignSpool.close();
    }

    ({ issue } = await issueReadiness(h, "composition-fresh-local-after-foreign"));

    let outerAccessorRead = false;
    const accessorIssue = { binding: issue.binding };
    Object.defineProperty(accessorIssue, "receipt", {
      enumerable: true,
      get() { outerAccessorRead = true; return issue.receipt; },
    });
    assert.equal(await h.composition.readiness.h2.activate(accessorIssue), false);
    assert.equal(outerAccessorRead, false);

    let bindingAccessorRead = false;
    const accessorBinding = { ...issue.binding };
    Object.defineProperty(accessorBinding, "hostId", {
      enumerable: true,
      get() { bindingAccessorRead = true; return issue.binding.hostId; },
    });
    assert.equal(await h.composition.readiness.h2.activate({
      receipt: issue.receipt,
      binding: accessorBinding,
    }), false);
    assert.equal(bindingAccessorRead, false);

    let reentrantProxyActivation = null;
    const outerProxy = descriptorReentryProxy(issue, () => {
      reentrantProxyActivation = h.composition.readiness.h2.activate(null);
    });
    assert.equal(await h.composition.readiness.h2.activate(outerProxy.proxy), false);
    assert.equal(await reentrantProxyActivation, false);
    assert.equal(outerProxy.fired(), true);

    const bindingProxy = descriptorReentryProxy(issue.binding, () => {
      h.composition.readiness.h2.close();
    });
    assert.equal(await h.composition.readiness.h2.activate({
      receipt: issue.receipt,
      binding: bindingProxy.proxy,
    }), false);
    assert.equal(bindingProxy.fired(), true);

    const receiptProxy = descriptorReentryProxy(issue.receipt, () => {
      h.composition.readiness.h2.close();
    });
    h.wrapped.controls.beforeVerify = (receipt) => {
      Object.getOwnPropertyDescriptors(receipt);
    };
    assert.equal(await h.composition.readiness.h2.activate({
      receipt: receiptProxy.proxy,
      binding: issue.binding,
    }), false);
    assert.equal(receiptProxy.fired(), true);

    for (const field of Object.keys(issue.binding)) {
      assert.equal(await h.composition.readiness.h2.activate({
        receipt: issue.receipt,
        binding: { ...issue.binding, [field]: `${issue.binding[field]}-mismatch` },
      }), false, `${field} mismatch was accepted`);
    }
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);

    h.spool.verifyReadinessReceipt = async () => {
      throw new Error("mutated spool method must not replace the captured primitive");
    };
    assert.equal(await h.composition.readiness.h2.activate(issue), true);
    assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
    assert.equal(
      Object.values(h.composition.readiness.current().capabilities).every(Boolean),
      true,
    );

    const disposeProxy = descriptorReentryProxy(issue.receipt, () => {
      h.composition.dispose();
    });
    h.wrapped.controls.beforeVerify = (receipt) => {
      Object.getOwnPropertyDescriptors(receipt);
    };
    assert.equal(await h.composition.readiness.h2.activate({
      receipt: disposeProxy.proxy,
      binding: issue.binding,
    }), false);
    assert.equal(disposeProxy.fired(), true);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
  } finally {
    await h.cleanup();
  }
});

test("H2 activation rolls back when its exact attempt is lost before drain or after attach", async (t) => {
  await t.test("before drain", async () => {
    const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
    try {
      applyFiveReadySources(h.composition);
      const active = await issueReadiness(h, "composition-before-drain-reentry");
      h.discovery.push({
        coverage: "complete",
        scopes: [scope([
          terminal("pane:a", "alpha"),
          terminal("pane:b", "beta"),
        ])],
      });
      await h.foundation.reconcile();
      h.wrapped.controls.beforeActivate = () => {
        h.composition.readiness.h2.close();
      };
      assert.equal(await h.composition.readiness.h2.activate(active.issue), false);
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      assert.deepEqual([...h.wrapped.releaseCounts.values()], []);
      assert.equal(
        await h.spool.verifyReadinessReceipt(active.issue.receipt, active.issue.binding),
        false,
      );
    } finally {
      await h.cleanup();
    }
  });

  await t.test("after attach but before spool commit", async () => {
    let composition;
    const h = await realCompositionHarness({
      wrapSpool: controlledSpoolAdapter,
      spoolHooks: {
        afterReadinessActivationAttached() {
          composition.readiness.h2.close();
        },
      },
    });
    composition = h.composition;
    try {
      applyFiveReadySources(h.composition);
      const active = await issueReadiness(h, "composition-after-attach-reentry");
      assert.equal(await h.composition.readiness.h2.activate(active.issue), false);
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      assert.deepEqual([...h.wrapped.releaseCounts.values()], [1]);
      assert.equal(
        await h.spool.verifyReadinessReceipt(active.issue.receipt, active.issue.binding),
        false,
      );
    } finally {
      await h.cleanup();
    }
  });
});

test("H2 replacement rejects stale success under reentrant release callbacks", async (t) => {
  for (const action of ["close", "dispose", "activate"]) {
    await t.test(action, async () => {
      const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
      let reentrantActivation = null;
      try {
        applyFiveReadySources(h.composition);
        const first = await issueReadiness(h, `composition-release-${action}-first`);
        assert.equal(await h.composition.readiness.h2.activate(first.issue), true);
        const replacement = await issueReadiness(
          h,
          `composition-release-${action}-replacement`,
        );
        const reentrant = action === "activate"
          ? await issueReadiness(h, "composition-release-reentrant-activation")
          : null;
        h.wrapped.controls.onRelease = () => {
          assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
          if (action === "close") h.composition.readiness.h2.close();
          if (action === "dispose") h.composition.dispose();
          if (action === "activate") {
            reentrantActivation = h.composition.readiness.h2.activate(reentrant.issue);
          }
        };

        assert.equal(await h.composition.readiness.h2.activate(replacement.issue), false);
        if (reentrantActivation !== null) assert.equal(await reentrantActivation, false);
        assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
        assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
      } finally {
        await h.cleanup();
      }
    });
  }
});

test("release authority failures poison the whole H2 owner without retry", async (t) => {
  await t.test("synchronous throw", async () => {
    const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
    try {
      applyFiveReadySources(h.composition);
      const first = await issueReadiness(h, "composition-release-throw-first");
      const replacement = await issueReadiness(h, "composition-release-throw-replacement");
      assert.equal(await h.composition.readiness.h2.activate(first.issue), true);
      h.wrapped.controls.onRelease = () => {
        assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
        throw new Error("injected release failure");
      };
      assert.equal(await h.composition.readiness.h2.activate(replacement.issue), false);
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
      const afterFailure = await issueReadiness(h, "composition-release-throw-poisoned");
      assert.equal(await h.composition.readiness.h2.activate(afterFailure.issue), false);
      assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("hostile thenable getter and reentry", async () => {
    const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
    let getterReads = 0;
    let reentrantActivation = null;
    try {
      applyFiveReadySources(h.composition);
      const first = await issueReadiness(h, "composition-release-thenable-first");
      const replacement = await issueReadiness(h, "composition-release-thenable-replacement");
      const reentrant = await issueReadiness(h, "composition-release-thenable-reentrant");
      assert.equal(await h.composition.readiness.h2.activate(first.issue), true);
      const hostileThenable = {};
      Object.defineProperty(hostileThenable, "then", {
        get() {
          getterReads += 1;
          throw new Error("hostile then getter must not run");
        },
      });
      h.wrapped.controls.onRelease = () => {
        assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
        reentrantActivation = h.composition.readiness.h2.activate(reentrant.issue);
        return hostileThenable;
      };
      assert.equal(await h.composition.readiness.h2.activate(replacement.issue), false);
      assert.equal(await reentrantActivation, false);
      assert.equal(getterReads, 0);
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("previous lease native Promise rejects after replacement", async () => {
    const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let rejectRelease;
    try {
      applyFiveReadySources(h.composition);
      const first = await issueReadiness(h, "composition-release-async-first");
      const replacement = await issueReadiness(h, "composition-release-async-replacement");
      assert.equal(await h.composition.readiness.h2.activate(first.issue), true);
      const releaseResult = new Promise((_resolve, reject) => {
        rejectRelease = reject;
      });
      h.wrapped.controls.onRelease = () => {
        assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
        return releaseResult;
      };
      assert.equal(await h.composition.readiness.h2.activate(replacement.issue), true);
      assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
      rejectRelease(new Error("injected late release rejection"));
      await settle(8);
      assert.deepEqual(unhandled, []);
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
      const afterFailure = await issueReadiness(h, "composition-release-async-poisoned");
      assert.equal(await h.composition.readiness.h2.activate(afterFailure.issue), false);
      assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await h.cleanup();
    }
  });
});

test("H2 close rejects activation reentered from activation-lease release", async () => {
  const h = await realCompositionHarness({ wrapSpool: controlledSpoolAdapter });
  let reentrantActivation = null;
  try {
    applyFiveReadySources(h.composition);
    const active = await issueReadiness(h, "composition-close-active");
    const rejected = await issueReadiness(h, "composition-close-reentrant");
    assert.equal(await h.composition.readiness.h2.activate(active.issue), true);
    h.wrapped.controls.onRelease = () => {
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      reentrantActivation = h.composition.readiness.h2.activate(rejected.issue);
    };
    h.composition.readiness.h2.close();
    assert.equal(await reentrantActivation, false);
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.deepEqual([...h.wrapped.releaseCounts.values()], [1]);
  } finally {
    await h.cleanup();
  }
});

test("active H2 receipt authority is withdrawn by every owning lease boundary", async (t) => {
  await t.test("explicit composition release fences the old generation and permits a new cut", async () => {
    const h = await realCompositionHarness();
    try {
      applyFiveReadySources(h.composition);
      const first = await issueReadiness(h, "composition-release-first");
      assert.equal(await h.composition.readiness.h2.activate(first.issue), true);
      h.composition.readiness.h2.close();
      h.composition.readiness.h2.close();
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
      assert.equal(await h.composition.readiness.h2.activate(first.issue), false);

      const replacement = await issueReadiness(h, "composition-release-replacement");
      assert.equal(await h.composition.readiness.h2.activate(replacement.issue), true);
      assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("snapshot release closes the activation sink and withdraws H2", async () => {
    const h = await realCompositionHarness();
    try {
      applyFiveReadySources(h.composition);
      const active = await issueReadiness(h, "composition-snapshot-release");
      assert.equal(await h.composition.readiness.h2.activate(active.issue), true);
      await h.spool.release(releaseSnapshotRequest(active.chunk, active.principalId));
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
      applyFiveReadySources(h.composition);
      const active = await issueReadiness(h, "composition-snapshot-expiry");
      assert.equal(await h.composition.readiness.h2.activate(active.issue), true);
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
      applyFiveReadySources(h.composition);
      const active = await issueReadiness(h, "composition-owner-takeover");
      assert.equal(await h.composition.readiness.h2.activate(active.issue), true);
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
      applyFiveReadySources(h.composition);
      const active = await issueReadiness(h, "composition-spool-close");
      assert.equal(await h.composition.readiness.h2.activate(active.issue), true);
      await h.spool.close();
      assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    } finally {
      await h.cleanup({ closeSpool: false });
    }
  });
});

test("replacement generation ignores old late close and dispose releases each lease once", async () => {
  const h = await realCompositionHarness({ wrapSpool: delayedActivationCloseAdapter });
  try {
    applyFiveReadySources(h.composition);
    const first = await issueReadiness(h, "composition-replacement-first");
    const second = await issueReadiness(h, "composition-replacement-second");
    assert.equal(await h.composition.readiness.h2.activate(first.issue), true);
    assert.equal(await h.composition.readiness.h2.activate(second.issue), true);
    assert.equal(h.composition.readiness.advertisedCapabilities().length, 6);
    assert.equal(
      [...h.wrapped.releaseCounts.values()].reduce((sum, count) => sum + count, 0),
      1,
    );

    h.wrapped.flushLateCloses();
    assert.equal(
      h.composition.readiness.advertisedCapabilities().length,
      6,
      "the superseded activation's late close must not withdraw its replacement",
    );

    h.composition.dispose();
    h.composition.dispose();
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
    h.wrapped.flushLateCloses();
    assert.deepEqual(h.composition.readiness.advertisedCapabilities(), []);
    assert.deepEqual([...h.wrapped.releaseCounts.values()].sort(), [1, 1]);
  } finally {
    await h.cleanup();
  }
});
