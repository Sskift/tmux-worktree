import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const codec = await import("../dist/relay/v2/codec.js");
const canonicalDiscovery = await import("../dist/relay/v2/canonicalTwRpcDiscovery.js");
const canonicalBackendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");
const { RPC_V2_CAPABILITIES } = await import("../dist/rpcV2.js");
const relayV2Corpus = loadRelayV2FixtureCorpus();
const backendIdentityFixture = JSON.parse(readFileSync(
  new URL("./fixtures/relay-v2-canonical-backend-identity-v1.json", import.meta.url),
  "utf8",
));

const handshakeFixture = JSON.parse(readFileSync(
  new URL("../contracts/relay/v2/golden-public-handshake.json", import.meta.url),
  "utf8",
));
const welcomeTemplate = handshakeFixture.find((item) => (
  item.name === "host-welcome-snapshot-required"
)).frame;

function cloneDiscoveryScan(scan) {
  const cloned = structuredClone(scan);
  const resolverCut = scan[resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT];
  if (resolverCut !== undefined) {
    Object.defineProperty(cloned, resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT, {
      value: {
        generation: resolverCut.generation,
        scopeTargets: structuredClone(resolverCut.scopeTargets),
        sessionTargets: structuredClone(resolverCut.sessionTargets),
        isCurrent: resolverCut.isCurrent,
      },
      enumerable: false,
    });
  }
  return cloned;
}

class QueueDiscovery {
  #scans = [];

  push(scan) {
    this.#scans.push(cloneDiscoveryScan(scan));
  }

  pushDeferred(scan, onStart) {
    this.#scans.push({ deferredScan: scan, onStart });
  }

  async scan() {
    const scan = this.#scans.shift();
    if (!scan) throw new Error("test discovery has no queued scan");
    if (scan.deferredScan) {
      scan.onStart?.();
      return cloneDiscoveryScan(await scan.deferredScan);
    }
    return cloneDiscoveryScan(scan);
  }
}

class ReadinessSink {
  signals = [];
  accept = true;

  apply(signal) {
    this.signals.push(structuredClone(signal));
    return this.accept;
  }
}

class QueueSettlementAuthority {
  #evidence = [];
  calls = [];

  push(evidence) {
    this.#evidence.push(structuredClone(evidence));
  }

  async fencedNegativeEvidence(candidates) {
    this.calls.push(structuredClone(candidates));
    return this.#evidence.shift() ?? [];
  }
}

function terminal(backendIdentity, displayName, activityAtMs = 1_783_700_000_000) {
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
    activityAtMs,
  };
}

function worktree(backendIdentity, displayName, activityAtMs = 1_783_700_000_000) {
  return {
    backendIdentity,
    kind: "worktree",
    displayName,
    state: "running",
    project: displayName,
    label: null,
    cwd: `/repo/${displayName}`,
    attached: false,
    windowCount: 1,
    createdAtMs: 1_783_699_000_000,
    activityAtMs,
  };
}

function prospectiveTerminal(displayName, activityAtMs = 1_783_700_000_000) {
  const { backendIdentity: _backendIdentity, ...session } = terminal(
    "reservation-only",
    displayName,
    activityAtMs,
  );
  return session;
}

function scope({
  backendIdentity,
  displayName,
  kind = "ssh",
  reachability = "online",
  sessionsCompleteness = "complete",
  sessions = [],
  error = null,
  reservationCorrelationCompleteness,
}) {
  const result = {
    backendIdentity,
    displayName,
    kind,
    reachability,
    sessionsCompleteness,
    sessions,
    error,
  };
  if (reservationCorrelationCompleteness !== undefined) {
    result.reservationCorrelationCompleteness = reservationCorrelationCompleteness;
  }
  return result;
}

function resolverProcessTarget(kind, targetId) {
  return { kind, targetId };
}

function commandResolutionFence(resourceFence, overrides = {}) {
  const base = {
    schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
    outcome: resourceFence.result.kind,
    authority: "tw_rpc",
    operation: resourceFence.expectedSessionId === null ? "create_terminal" : "kill_session",
    expectedScopeId: resourceFence.expectedScopeId,
    expectedSessionId: resourceFence.expectedSessionId,
    evidence: { resourceCut: structuredClone(resourceFence) },
  };
  if (resourceFence.result.kind === "complete_negative") {
    return { ...base, code: resourceFence.result.code, ...overrides };
  }
  const resourceTarget = resourceFence.result.target;
  const target = {
    authority: "tw_rpc",
    operation: resourceFence.expectedSessionId === null ? "create_terminal" : "kill_session",
    processTarget: {
      ...structuredClone(resourceTarget.processTarget),
      scopeId: resourceFence.expectedScopeId,
    },
    capabilities: structuredClone(resourceTarget.capabilities),
    ...(resourceFence.expectedSessionId === null
      ? {}
      : { managedTarget: structuredClone(resourceTarget.managedTarget) }),
  };
  return { ...base, target, ...overrides };
}

function partialScope({
  backendIdentity,
  displayName,
  reachability = "unreachable",
  sessions = [],
}) {
  return scope({
    backendIdentity,
    displayName,
    reachability,
    sessionsCompleteness: "partial",
    sessions,
    error: {
      code: reachability === "unreachable" ? "SCOPE_UNREACHABLE" : "BUSY",
      message: reachability === "unreachable" ? "SSH unavailable" : "scan incomplete",
      retryable: true,
      commandDisposition: "not_applicable",
    },
  });
}

function buildWelcome(cut, mutate) {
  const frame = structuredClone(welcomeTemplate);
  frame.hostEpoch = cut.hostEpoch;
  frame.hostInstanceId = cut.hostInstanceId;
  frame.payload.eventSeq = cut.eventSeq;
  frame.payload.capabilities = [];
  if (cut.requiresSnapshot) {
    frame.payload.resumeDisposition = "snapshot_required";
    frame.payload.resumeReason = "cursor_behind";
  }
  mutate?.(frame);
  return frame;
}

async function harness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-materialized-"));
  const paths = hostState.relayV2HostStatePaths(home);
  const store = await hostState.RelayV2HostStateStore.open({ paths });
  const discovery = new QueueDiscovery();
  const readinessSink = new ReadinessSink();
  let now = 1_783_700_000_000;
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: "mac-admin",
    discovery,
    store,
    readinessSink,
    reservationSettlementAuthority: options.settlementAuthority,
    testCapacityLimits: options.capacityLimits,
    testReservationLimits: options.reservationLimits,
    testSnapshotCandidateLimits: options.snapshotCandidateLimits,
    now: () => now,
    testHooks: options.testHooks,
  });
  return {
    home,
    paths,
    store,
    discovery,
    readinessSink,
    now: () => now,
    setNow: (value) => { now = value; },
    foundation,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function payload(frame) {
  return frame.payload;
}

function assertMaterializedError(code) {
  return (error) => {
    assert.ok(error instanceof resourceState.RelayV2MaterializedStateError);
    assert.equal(error.code, code);
    return true;
  };
}

test("H2 materializes the canonical discovery key from the shared backend identity fixture", async () => {
  const h = await harness();
  try {
    const vector = backendIdentityFixture.vectors[0];
    const discovered = canonicalDiscovery.projectRelayV2CanonicalTwRpcDiscoveredSession({
      processTarget: vector.processTarget,
      session: {
        name: "raw-terminal-backend-7",
        kind: "terminal",
        profile: "dashboard",
        project: null,
        label: "Public terminal-2",
        repoPath: null,
        worktreePath: null,
        branch: null,
        baseBranch: null,
        cwd: "/repo/demo",
        createdAt: "2026-07-12T00:00:01.000Z",
        attached: false,
        windows: 1,
        created: 1_783_700_010,
        activity: 1_783_700_020,
        incarnation: vector.incarnation,
        lifecycleMarked: true,
        reservationCorrelation: null,
      },
    });
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: vector.processTarget.targetId,
        displayName: "Local",
        kind: vector.processTarget.kind,
        sessions: [discovered],
      })],
    });

    const reconciled = await h.foundation.reconcile();
    const persisted = materializedRoot(reconciled.snapshot).scopes[0].sessions[0];
    assert.equal(discovered.backendIdentity, vector.expected);
    assert.equal(persisted.backendIdentity, vector.expected);
    assert.equal(persisted.item.displayName, "Public terminal-2");
    assert.equal(JSON.stringify(persisted).includes("raw-terminal-backend-7"), false);
  } finally {
    h.cleanup();
  }
});

test("resolver reconcile rejects forged managed incarnation evidence without publishing a target", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-forged-resolver-"));
  try {
    const paths = hostState.relayV2HostStatePaths(home);
    const store = await hostState.RelayV2HostStateStore.open({ paths });
    const vector = backendIdentityFixture.vectors.find((item) => (
      item.name === "configured SSH target identity"
    ));
    assert.ok(vector);
    const incarnationB = `twinc2.${"B".repeat(43)}`;
    const forgedScan = {
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "scope:forged",
        displayName: "Configured forged target",
        sessions: [terminal(vector.expected, "Public terminal A")],
      })],
    };
    Object.defineProperty(forgedScan, resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT, {
      value: {
        generation: "forged",
        scopeTargets: [{
          scopeBackendIdentity: "scope:forged",
          processTarget: resolverProcessTarget(
            vector.processTarget.kind,
            vector.processTarget.targetId,
          ),
          capabilities: ["session.list"],
        }],
        sessionTargets: [{
          scopeBackendIdentity: "scope:forged",
          sessionBackendIdentity: vector.expected,
          backendKind: "terminal",
          processTarget: resolverProcessTarget(
            vector.processTarget.kind,
            vector.processTarget.targetId,
          ),
          capabilities: ["session.list"],
          managedTarget: {
            name: "managed-terminal-b",
            kind: "terminal",
            incarnation: incarnationB,
          },
        }],
        isCurrent: () => true,
      },
      enumerable: false,
    });
    const foundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: { async scan() { return forgedScan; } },
      store,
      readinessSink: new ReadinessSink(),
    });
    const before = await store.read();

    await assert.rejects(
      foundation.reconcile(),
      assertMaterializedError("INTERNAL"),
    );
    assert.deepEqual((await store.read()).materialized, before.materialized);
    await assert.rejects(
      foundation.canonicalTargetResolver.captureToken(before.hostEpoch),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession({
        schemaVersion: 1,
        hostEpoch: before.hostEpoch,
        resourceMappingDigest: `twrmap1.${"A".repeat(43)}`,
        discoveryGeneration: "forged",
      }, "scope-forged", "session-forged"),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver admission fence binds command-expected IDs and rejects persisted readiness withdrawal", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-admission-fence-"));
  try {
    const store = await hostState.RelayV2HostStateStore.open({
      paths: hostState.relayV2HostStatePaths(home),
    });
    const processA = resolverProcessTarget("local", "configured-a");
    const processB = resolverProcessTarget("local", "configured-b");
    const incarnationA = `twinc2.${"A".repeat(43)}`;
    const incarnationB = `twinc2.${"B".repeat(43)}`;
    const backendA = canonicalBackendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: processA,
      incarnation: incarnationA,
    });
    const backendB = canonicalBackendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: processA,
      incarnation: incarnationB,
    });
    const scan = {
      coverage: "complete",
      scopes: [
        scope({
          backendIdentity: "scope:a",
          displayName: "Scope A",
          kind: "local",
          sessions: [terminal(backendA, "Session A"), terminal(backendB, "Session B")],
        }),
        scope({ backendIdentity: "scope:b", displayName: "Scope B", kind: "local" }),
      ],
    };
    Object.defineProperty(scan, resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT, {
      value: {
        generation: "admission-fence-cut",
        scopeTargets: [
          { scopeBackendIdentity: "scope:a", processTarget: processA, capabilities: ["session.list"] },
          { scopeBackendIdentity: "scope:b", processTarget: processB, capabilities: ["session.list"] },
        ],
        sessionTargets: [
          {
            scopeBackendIdentity: "scope:a",
            sessionBackendIdentity: backendA,
            backendKind: "terminal",
            processTarget: processA,
            capabilities: ["session.list"],
            managedTarget: { name: "raw-a", kind: "terminal", incarnation: incarnationA },
          },
          {
            scopeBackendIdentity: "scope:a",
            sessionBackendIdentity: backendB,
            backendKind: "terminal",
            processTarget: processA,
            capabilities: ["session.list"],
            managedTarget: { name: "raw-b", kind: "terminal", incarnation: incarnationB },
          },
        ],
        isCurrent: () => true,
      },
      enumerable: false,
    });
    const discovery = new QueueDiscovery();
    discovery.push(scan);
    const foundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store,
      readinessSink: new ReadinessSink(),
    });
    const reconciled = await foundation.reconcile();
    const token = await foundation.canonicalTargetResolver.captureToken(
      reconciled.snapshot.hostEpoch,
    );
    const scopes = payload(await foundation.scopesSnapshot(
      "admission-fence-scopes",
      reconciled.snapshot.hostEpoch,
    )).items;
    const scopeA = scopes.find((item) => item.displayName === "Scope A");
    const scopeB = scopes.find((item) => item.displayName === "Scope B");
    const sessions = payload(await foundation.sessionsSnapshot(
      "admission-fence-sessions",
      reconciled.snapshot.hostEpoch,
      [scopeA.scopeId],
    )).scopes[0].items;
    const targetScopeB = await foundation.canonicalTargetResolver.resolveScope(token, scopeB.scopeId);
    const targetSessionB = await foundation.canonicalTargetResolver.resolveSession(
      token,
      scopeA.scopeId,
      sessions[1].sessionId,
    );
    const fenceScopeA = await foundation.canonicalTargetResolver.resolveScopeForAdmission(
      token,
      scopeA.scopeId,
    );
    const fenceSessionA = await foundation.canonicalTargetResolver.resolveSessionForAdmission(
      token,
      scopeA.scopeId,
      sessions[0].sessionId,
    );
    const negativeFence = await foundation.canonicalTargetResolver.resolveSessionForAdmission(
      token,
      scopeA.scopeId,
      "ses_missing_from_complete_cut",
    );
    assert.equal(negativeFence.result.kind, "complete_negative");
    await store.transaction((transaction) => {
      foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
        transaction,
        negativeFence,
      );
    });
    await assert.rejects(
      store.transaction((transaction) => {
        transaction.latchMaterializedReadinessFence("materialized_authority_conflict");
        foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
          transaction,
          fenceSessionA,
        );
      }),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    const resourceSwaps = [
      {
        ...structuredClone(fenceScopeA),
        result: { kind: "positive", target: targetScopeB },
      },
      {
        ...structuredClone(fenceSessionA),
        result: { kind: "positive", target: targetSessionB },
      },
      {
        ...structuredClone(fenceScopeA),
        expectedScopeId: scopeB.scopeId,
      },
      {
        ...structuredClone(fenceSessionA),
        expectedSessionId: sessions[1].sessionId,
      },
      {
        ...structuredClone(fenceScopeA),
        result: {
          kind: "positive",
          target: {
            ...structuredClone(fenceScopeA.result.target),
            processTarget: structuredClone(targetScopeB.processTarget),
          },
        },
      },
      {
        ...structuredClone(fenceScopeA),
        result: {
          kind: "positive",
          target: {
            ...structuredClone(fenceScopeA.result.target),
            capabilities: [...fenceScopeA.result.target.capabilities, "future.capability"],
          },
        },
      },
      {
        ...structuredClone(fenceSessionA),
        result: {
          kind: "positive",
          target: {
            ...structuredClone(fenceSessionA.result.target),
            managedTarget: {
              ...structuredClone(fenceSessionA.result.target.managedTarget),
              incarnation: targetSessionB.managedTarget.incarnation,
            },
          },
        },
      },
      {
        ...structuredClone(negativeFence),
        result: { kind: "complete_negative", code: "SCOPE_NOT_FOUND" },
      },
      {
        ...structuredClone(negativeFence),
        expectedSessionId: sessions[0].sessionId,
      },
    ];
    for (const swapped of resourceSwaps) {
      await assert.rejects(
        store.transaction((transaction) => (
          foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
            transaction,
            swapped,
          )
        )),
        assertMaterializedError("CAPABILITY_UNAVAILABLE"),
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("canonical resolver publishes only an accepted exact reconcile and fences rebuild, config, restart, and partial cuts", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-canonical-resolver-"));
  try {
    const paths = hostState.relayV2HostStatePaths(home);
    const store = await hostState.RelayV2HostStateStore.open({ paths });
    const incarnationA = `twinc2.${"A".repeat(43)}`;
    const incarnationB = `twinc2.${"B".repeat(43)}`;
    const canonicalSession = (incarnation) => ({
      name: "managed-terminal",
      kind: "terminal",
      profile: "cli",
      project: null,
      label: "Stable public label",
      repoPath: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      cwd: "/repo/terminal",
      createdAt: "2026-07-18T01:00:00.000Z",
      attached: false,
      windows: 1,
      created: 1_752_804_000,
      activity: 1_752_804_001,
      incarnation,
      lifecycleMarked: true,
      reservationCorrelation: null,
    });
    const capabilities = {
      protocolVersion: 2,
      app: "tmux-worktree",
      capabilities: [...RPC_V2_CAPABILITIES],
    };
    const scopeConfig = (targetId, backendIdentity, queryPort) => ({
      scopes: [{
        backendIdentity,
        displayName: `Configured ${targetId}`,
        kind: "ssh",
        processTarget: resolverProcessTarget("ssh", targetId),
      }],
      queryPort,
    });
    let currentIncarnation = incarnationA;
    let blockNextList = false;
    let announceConcurrentScan;
    let releaseConcurrentScan;
    let initialPortCalls = 0;
    const concurrentScanStarted = new Promise((resolve) => { announceConcurrentScan = resolve; });
    const concurrentScanBarrier = new Promise((resolve) => { releaseConcurrentScan = resolve; });
    const initialPort = {
      async query(request) {
        initialPortCalls += 1;
        if (request.command === "list" && blockNextList) {
          announceConcurrentScan();
          await concurrentScanBarrier;
        }
        return request.command === "capabilities"
          ? capabilities
          : { protocolVersion: 2, sessions: [canonicalSession(currentIncarnation)] };
      },
    };
    const discovery = new canonicalDiscovery.RelayV2CanonicalTwRpcDiscoveryAdapter(
      scopeConfig("configured-a", "scope:configured-a", initialPort),
    );
    const resolverReadinessSink = new ReadinessSink();
    const foundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store,
      readinessSink: resolverReadinessSink,
    });

    const initial = await foundation.reconcile();
    const initialScopes = payload(await foundation.scopesSnapshot(
      "resolver-scopes-a",
      initial.snapshot.hostEpoch,
    )).items;
    const initialSessions = payload(await foundation.sessionsSnapshot(
      "resolver-sessions-a",
      initial.snapshot.hostEpoch,
      null,
    )).scopes[0].items;
    const scopeIdA = initialScopes[0].scopeId;
    const sessionIdA = initialSessions[0].sessionId;
    const tokenA = await foundation.canonicalTargetResolver.captureToken(
      initial.snapshot.hostEpoch,
    );
    const scopeTargetA = await foundation.canonicalTargetResolver.resolveScope(
      tokenA,
      scopeIdA,
    );
    assert.equal(scopeTargetA.authorization, "evidence_only");
    assert.deepEqual(
      scopeTargetA.processTarget,
      resolverProcessTarget("ssh", "configured-a"),
    );
    const targetA = await foundation.canonicalTargetResolver.resolveSession(
      tokenA,
      scopeIdA,
      sessionIdA,
    );
    assert.deepEqual(targetA.processTarget, resolverProcessTarget("ssh", "configured-a"));
    assert.deepEqual(targetA.managedTarget, {
      name: "managed-terminal",
      kind: "terminal",
      incarnation: incarnationA,
    });
    const admissionFenceA = await foundation.canonicalTargetResolver.resolveSessionForAdmission(
      tokenA,
      scopeIdA,
      sessionIdA,
    );
    await store.transaction((transaction) => {
      foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
        transaction,
        admissionFenceA,
      );
    });
    await assert.rejects(
      store.transaction((transaction) => {
        foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
          transaction,
          {
            ...structuredClone(admissionFenceA),
            result: {
              kind: "positive",
              target: {
                ...structuredClone(targetA),
                managedTarget: {
                  ...structuredClone(targetA.managedTarget),
                  incarnation: incarnationB,
                },
              },
            },
          },
        );
      }),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );

    blockNextList = true;
    const callsBeforeConcurrent = initialPortCalls;
    const firstConcurrent = foundation.reconcile();
    const secondConcurrent = foundation.reconcile();
    assert.equal(firstConcurrent, secondConcurrent, "concurrent reconciles must share one H0 winner");
    await concurrentScanStarted;
    assert.deepEqual(
      await foundation.canonicalTargetResolver.resolveSession(tokenA, scopeIdA, sessionIdA),
      targetA,
      "a running scan must not withdraw the last completed winner",
    );
    releaseConcurrentScan();
    const [firstWinner, secondWinner] = await Promise.all([firstConcurrent, secondConcurrent]);
    blockNextList = false;
    assert.equal(firstWinner.snapshot.commitSeq, secondWinner.snapshot.commitSeq);
    assert.equal(initialPortCalls - callsBeforeConcurrent, 2, "one scan must query one exact winner");
    assert.equal((await store.read()).materializedReadinessFence, null);
    const concurrentToken = await foundation.canonicalTargetResolver.captureToken(
      firstWinner.snapshot.hostEpoch,
    );
    assert.notEqual(concurrentToken.discoveryGeneration, tokenA.discoveryGeneration);
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession(tokenA, scopeIdA, sessionIdA),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );

    resolverReadinessSink.accept = false;
    const refused = await foundation.reconcile();
    assert.equal(refused.readiness.snapshotMaterializationReady, true);
    await assert.rejects(
      foundation.canonicalTargetResolver.captureToken(refused.snapshot.hostEpoch),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession(concurrentToken, scopeIdA, sessionIdA),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    resolverReadinessSink.accept = true;

    const beforeRebuild = await foundation.reconcile();
    const beforeRebuildToken = await foundation.canonicalTargetResolver.captureToken(
      beforeRebuild.snapshot.hostEpoch,
    );
    const beforeRebuildFence = await foundation.canonicalTargetResolver
      .resolveSessionForAdmission(beforeRebuildToken, scopeIdA, sessionIdA);
    currentIncarnation = incarnationB;
    const rebuilt = await foundation.reconcile();
    const rebuiltSessions = payload(await foundation.sessionsSnapshot(
      "resolver-sessions-rebuilt",
      rebuilt.snapshot.hostEpoch,
      null,
    )).scopes[0].items;
    const sessionIdB = rebuiltSessions[0].sessionId;
    const tokenB = await foundation.canonicalTargetResolver.captureToken(
      rebuilt.snapshot.hostEpoch,
    );
    assert.notEqual(sessionIdB, sessionIdA, "same-name backend rebuild needs a new opaque Session ID");
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession(beforeRebuildToken, scopeIdA, sessionIdA),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      store.transaction((transaction) => {
        foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
          transaction,
          beforeRebuildFence,
        );
      }),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession(tokenB, scopeIdA, sessionIdA),
      assertMaterializedError("SESSION_NOT_FOUND"),
    );
    const targetB = await foundation.canonicalTargetResolver.resolveSession(
      tokenB,
      scopeIdA,
      sessionIdB,
    );
    const fenceB = await foundation.canonicalTargetResolver.resolveSessionForAdmission(
      tokenB,
      scopeIdA,
      sessionIdB,
    );
    assert.equal(targetB.managedTarget.incarnation, incarnationB);
    assert.notEqual(tokenA.discoveryGeneration, tokenB.discoveryGeneration);

    let announceStaleScan;
    let releaseStaleScan;
    const staleScanStarted = new Promise((resolve) => { announceStaleScan = resolve; });
    const staleScanBarrier = new Promise((resolve) => { releaseStaleScan = resolve; });
    const stalePort = {
      async query(request) {
        if (request.command === "capabilities") return capabilities;
        announceStaleScan();
        await staleScanBarrier;
        return { protocolVersion: 2, sessions: [canonicalSession(incarnationB)] };
      },
    };
    discovery.reconfigure(scopeConfig("configured-a", "scope:configured-a", stalePort));
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession(tokenB, scopeIdA, sessionIdB),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      store.transaction((transaction) => {
        foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
          transaction,
          fenceB,
        );
      }),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    const pendingReconcile = foundation.reconcile();
    await staleScanStarted;
    const configuredBPort = {
      async query(request) {
        return request.command === "capabilities"
          ? capabilities
          : { protocolVersion: 2, sessions: [canonicalSession(incarnationB)] };
      },
    };
    discovery.reconfigure(scopeConfig(
      "configured-b",
      "scope:configured-b",
      configuredBPort,
    ));
    releaseStaleScan();
    const configWinner = await pendingReconcile;
    const winnerScopes = payload(await foundation.scopesSnapshot(
      "resolver-config-winner-scopes",
      configWinner.snapshot.hostEpoch,
    )).items;
    const winnerSessions = payload(await foundation.sessionsSnapshot(
      "resolver-config-winner-sessions",
      configWinner.snapshot.hostEpoch,
      null,
    )).scopes[0].items;
    const winnerToken = await foundation.canonicalTargetResolver.captureToken(
      configWinner.snapshot.hostEpoch,
    );
    const winnerTarget = await foundation.canonicalTargetResolver.resolveSession(
      winnerToken,
      winnerScopes[0].scopeId,
      winnerSessions[0].sessionId,
    );
    assert.deepEqual(winnerTarget.processTarget, resolverProcessTarget("ssh", "configured-b"));
    assert.notEqual(winnerToken.discoveryGeneration, tokenB.discoveryGeneration);

    resolverReadinessSink.accept = false;
    await assert.rejects(
      foundation.linearizeWelcome(
        "resolver-welcome-readiness-rejected",
        { enqueue: () => true },
        buildWelcome,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      foundation.canonicalTargetResolver.captureToken(configWinner.snapshot.hostEpoch),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      foundation.canonicalTargetResolver.resolveSession(
        winnerToken,
        winnerScopes[0].scopeId,
        winnerSessions[0].sessionId,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths });
    const restarted = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store: restartedStore,
      readinessSink: { apply: () => true },
    });
    await assert.rejects(
      restarted.canonicalTargetResolver.captureToken(configWinner.snapshot.hostEpoch),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await restarted.reconcile();
    const restartedToken = await restarted.canonicalTargetResolver.captureToken(
      configWinner.snapshot.hostEpoch,
    );
    assert.notEqual(restartedToken.discoveryGeneration, winnerToken.discoveryGeneration);

    discovery.reconfigure(scopeConfig("configured-b", "scope:configured-b", {
      async query() { throw new Error("configured host unavailable"); },
    }));
    const partial = await restarted.reconcile();
    assert.equal(partial.readiness.snapshotMaterializationReady, false);
    assert.equal(partial.events.some((event) => event.payload?.change?.op === "delete"), false);
    const retained = payload(await restarted.sessionsSnapshot(
      "resolver-partial-retained",
      partial.snapshot.hostEpoch,
      null,
    )).scopes[0].items;
    assert.equal(retained[0].sessionId, winnerSessions[0].sessionId);
    await assert.rejects(
      restarted.canonicalTargetResolver.resolveSession(
        restartedToken,
        winnerScopes[0].scopeId,
        winnerSessions[0].sessionId,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      restarted.canonicalTargetResolver.resolveScope(
        restartedToken,
        winnerScopes[0].scopeId,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    await assert.rejects(
      restarted.canonicalTargetResolver.captureToken(partial.snapshot.hostEpoch),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("materialized reconciliation persists opaque identities and only complete coverage deletes", async () => {
  const h = await harness();
  try {
    const completeScan = {
      coverage: "complete",
      scopes: [
        scope({
          backendIdentity: "ssh:devbox",
          displayName: "Devbox",
          sessions: [terminal("pane:remote", "remote-shell")],
        }),
        scope({
          backendIdentity: "local",
          displayName: "Local",
          kind: "local",
          sessions: [terminal("pane:local", "local-shell")],
        }),
      ],
    };
    h.discovery.push(completeScan);
    const initial = await h.foundation.reconcile();
    assert.equal(initial.readiness.snapshotMaterializationReady, true);
    assert.deepEqual(initial.events.map((event) => event.eventSeq), ["1", "2", "3", "4"]);

    const epoch = initial.snapshot.hostEpoch;
    const scopes = payload(await h.foundation.scopesSnapshot("scopes-a", epoch)).items;
    const remote = scopes.find((item) => item.displayName === "Devbox");
    const local = scopes.find((item) => item.displayName === "Local");
    assert.match(remote.scopeId, /^scope_[0-9a-f]{32}$/);
    assert.notEqual(remote.scopeId, "ssh:devbox");
    const remoteSessions = payload(
      await h.foundation.sessionsSnapshot("sessions-a", epoch, [remote.scopeId]),
    ).scopes[0];
    const originalSessionId = remoteSessions.items[0].sessionId;
    assert.match(originalSessionId, /^ses_[0-9a-f]{32}$/);
    assert.notEqual(originalSessionId, "pane:remote");

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restarted = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: restartedStore,
      readinessSink: new ReadinessSink(),
    });
    const persisted = payload(
      await restarted.sessionsSnapshot("sessions-restart", epoch, [remote.scopeId]),
    ).scopes[0];
    assert.equal((await restartedStore.read()).hostEpoch, epoch);
    assert.equal(persisted.items[0].sessionId, originalSessionId);

    h.discovery.push(completeScan);
    const unchanged = await h.foundation.reconcile();
    assert.deepEqual(unchanged.events, []);
    assert.equal(unchanged.snapshot.eventSeq, initial.snapshot.eventSeq);
    assert.deepEqual(unchanged.snapshot.revisions, initial.snapshot.revisions);

    h.discovery.push({
      coverage: "partial",
      scopes: [partialScope({ backendIdentity: "ssh:devbox", displayName: "Devbox" })],
    });
    const partial = await h.foundation.reconcile();
    assert.equal(partial.readiness.snapshotMaterializationReady, false);
    assert.equal(partial.readiness.reason, "aggregate_coverage_partial");
    assert.equal(partial.events.length, 1);
    assert.equal(partial.events[0].type, "scopes.changed");
    const afterPartialScopes = payload(await h.foundation.scopesSnapshot("scopes-b", epoch));
    assert.equal(afterPartialScopes.coverageComplete, false);
    assert.deepEqual(
      afterPartialScopes.items.map((item) => item.scopeId).sort(),
      [local.scopeId, remote.scopeId].sort(),
    );
    const afterPartialSessions = payload(
      await h.foundation.sessionsSnapshot("sessions-b", epoch, [remote.scopeId]),
    ).scopes[0];
    assert.equal(
      afterPartialSessions.completeness,
      "complete",
      "an unreachable SSH scope preserves its last-known complete materialized cut",
    );
    assert.equal(afterPartialSessions.revision, "1");
    assert.equal(afterPartialSessions.items[0].sessionId, originalSessionId);

    const partialRestartStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const partialRestart = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: partialRestartStore,
      readinessSink: new ReadinessSink(),
    });
    assert.equal((await partialRestart.readiness(epoch)).reason, "aggregate_coverage_partial");
    assert.deepEqual(
      payload(await partialRestart.scopesSnapshot("scopes-partial-restart", epoch))
        .items.map((item) => item.scopeId).sort(),
      [local.scopeId, remote.scopeId].sort(),
      "partial coverage preserves the authoritative scope set across restart",
    );

    h.discovery.push({
      coverage: "complete",
      scopes: [
        scope({ backendIdentity: "ssh:devbox", displayName: "Devbox", sessions: [] }),
        scope({
          backendIdentity: "local",
          displayName: "Local",
          kind: "local",
          sessions: [terminal("pane:local", "local-shell")],
        }),
      ],
    });
    const completeDelete = await h.foundation.reconcile();
    assert.equal(completeDelete.readiness.snapshotMaterializationReady, true);
    assert.ok(completeDelete.events.some((event) => (
      event.type === "sessions.changed"
      && event.payload.change.op === "delete"
      && event.payload.change.sessionId === originalSessionId
    )));

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:local", "local-shell")],
      })],
    });
    const scopeDelete = await h.foundation.reconcile();
    assert.ok(scopeDelete.events.some((event) => (
      event.type === "scopes.changed"
      && event.payload.change.op === "delete"
      && event.payload.change.scopeId === remote.scopeId
    )));
  } finally {
    h.cleanup();
  }
});

test("backend authority includes kind and rebuilds delete-before-upsert without reusing lineage IDs", async () => {
  const h = await harness();
  try {
    const backendInstanceKey = "backend:same-instance-key";
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [worktree(backendInstanceKey, "project-a")],
      })],
    });
    const initial = await h.foundation.reconcile();
    const originalScope = payload(await h.foundation.scopesSnapshot(
      "tuple-scope-initial",
      initial.snapshot.hostEpoch,
    )).items[0];
    const originalSession = payload(await h.foundation.sessionsSnapshot(
      "tuple-session-initial",
      initial.snapshot.hostEpoch,
      [originalScope.scopeId],
    )).scopes[0].items[0];
    assert.equal(originalSession.kind, "worktree");

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal(backendInstanceKey, "terminal-a")],
      })],
    });
    const rebuilt = await h.foundation.reconcile();
    const sessionEvents = rebuilt.events.filter((event) => event.type === "sessions.changed");
    assert.deepEqual(sessionEvents.map((event) => event.payload.change.op), ["delete", "upsert"]);
    assert.equal(sessionEvents[0].payload.change.sessionId, originalSession.sessionId);
    const replacement = sessionEvents[1].payload.change.item;
    assert.equal(replacement.kind, "terminal");
    assert.notEqual(replacement.sessionId, originalSession.sessionId);
    let root = materializedRoot(await h.store.read());
    assert.ok(root.usedSessionIds.includes(originalSession.sessionId));
    assert.ok(root.usedSessionIds.includes(replacement.sessionId));

    h.discovery.push({ coverage: "complete", scopes: [] });
    await h.foundation.reconcile();
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({ backendIdentity: "local", displayName: "Local", kind: "local" })],
    });
    const reappeared = await h.foundation.reconcile();
    const replacementScope = payload(await h.foundation.scopesSnapshot(
      "tuple-scope-reappeared",
      reappeared.snapshot.hostEpoch,
    )).items[0];
    assert.notEqual(replacementScope.scopeId, originalScope.scopeId);
    root = materializedRoot(await h.store.read());
    assert.ok(root.usedScopeIds.includes(originalScope.scopeId));
    assert.ok(root.usedScopeIds.includes(replacementScope.scopeId));

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restartedRoot = materializedRoot(await restartedStore.read());
    assert.deepEqual(restartedRoot.usedScopeIds, root.usedScopeIds);
    assert.deepEqual(restartedRoot.usedSessionIds, root.usedSessionIds);
  } finally {
    h.cleanup();
  }
});

test("aggregate discovery authority and latest coverage survive partial scans and restart", async () => {
  const h = await harness();
  try {
    h.discovery.push({ coverage: "partial", scopes: [] });
    const initialPartial = await h.foundation.reconcile();
    assert.equal(initialPartial.readiness.reason, "aggregate_authority_not_established");
    assert.equal(initialPartial.readiness.snapshotMaterializationReady, false);

    const beforeAuthorityStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const beforeAuthority = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: beforeAuthorityStore,
      readinessSink: new ReadinessSink(),
    });
    assert.equal(
      (await beforeAuthority.readiness(initialPartial.snapshot.hostEpoch)).reason,
      "aggregate_authority_not_established",
    );

    h.discovery.push({ coverage: "complete", scopes: [] });
    const authoritative = await h.foundation.reconcile();
    assert.equal(authoritative.readiness.snapshotMaterializationReady, true);

    h.discovery.push({ coverage: "partial", scopes: [] });
    const laterEmptyPartial = await h.foundation.reconcile();
    assert.equal(laterEmptyPartial.readiness.reason, "aggregate_coverage_partial");
    assert.equal(laterEmptyPartial.readiness.snapshotMaterializationReady, false);

    const partialRestartStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const partialRestart = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: partialRestartStore,
      readinessSink: new ReadinessSink(),
    });
    assert.equal(
      (await partialRestart.readiness(authoritative.snapshot.hostEpoch)).reason,
      "aggregate_coverage_partial",
    );

    const completeScopes = [
      scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [],
      }),
      scope({
        backendIdentity: "ssh:devbox",
        displayName: "Devbox",
        sessions: [],
      }),
    ];
    h.discovery.push({ coverage: "partial", scopes: completeScopes });
    const mixed = await h.foundation.reconcile();
    assert.equal(mixed.readiness.reason, "aggregate_coverage_partial");
    assert.equal(mixed.readiness.snapshotMaterializationReady, false);
    assert.equal(
      payload(await h.foundation.sessionsSnapshot(
        "mixed-complete-scopes",
        mixed.snapshot.hostEpoch,
        null,
      )).scopes.every((item) => item.completeness === "complete"),
      true,
      "complete included scopes cannot upgrade a partial aggregate scan",
    );

    h.discovery.push({ coverage: "complete", scopes: completeScopes });
    const recovered = await h.foundation.reconcile();
    assert.equal(recovered.readiness.snapshotMaterializationReady, true);
  } finally {
    h.cleanup();
  }
});

function commandAuth(principalId = "principal-one") {
  return { principalId, clientInstanceId: `client-${principalId}`, hostId: "mac-admin" };
}

function createTerminalFrame(hostEpoch, windowId, scopeId, commandId = "cmd-h1-h2") {
  const frame = structuredClone(
    relayV2Corpus.goldenByName.get("command-execute-create-terminal").frame,
  );
  frame.expectedHostEpoch = hostEpoch;
  frame.payload.dedupeWindowId = windowId;
  frame.commandId = commandId;
  frame.scopeId = scopeId;
  return frame;
}

function killSessionFrame(hostEpoch, windowId, scopeId, sessionId, commandId) {
  const frame = structuredClone(
    relayV2Corpus.goldenByName.get("command-execute-kill-session").frame,
  );
  frame.expectedHostEpoch = hostEpoch;
  frame.payload.dedupeWindowId = windowId;
  frame.commandId = commandId;
  frame.scopeId = scopeId;
  frame.sessionId = sessionId;
  return frame;
}

function commandSession(displayName, overrides = {}) {
  return {
    ...prospectiveTerminal(displayName),
    ...overrides,
  };
}

function successfulCreate(plan, backendInstanceKey, overrides = {}) {
  return {
    state: "succeeded",
    backendOutcome: {
      schemaVersion: commandPlane.RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
      backendInstanceKey,
      evidence: {
        session: commandSession(plan.arguments.label ?? "terminal", overrides),
      },
    },
    commitIntent: { operation: "create_terminal" },
  };
}

function commandExecutor(overrides = {}) {
  const calls = { resolve: [], fence: [], execute: [] };
  return {
    calls,
    executor: {
      async resolve(request) {
        calls.resolve.push(structuredClone(request));
        const displayName = request.arguments.label ?? "terminal";
        const admission = overrides.resolve ? await overrides.resolve(request) : {
          kind: "executable",
          adapterState: {
            executionTarget: { scopeId: request.scopeId },
          },
          resolutionFence: {
            schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
            outcome: "positive",
            authority: request.authority,
            operation: request.operation,
            expectedScopeId: request.scopeId,
            expectedSessionId: request.sessionId,
            target: { testTarget: request.scopeId },
            evidence: { testResolver: "joint-h1-h2" },
          },
          resourceReservationPlan: {
            logicalTarget: {
              authority: "tw_rpc",
              principalId: request.principalId,
              scopeId: request.scopeId,
              terminalLabel: displayName,
            },
            session: commandSession(displayName),
          },
        };
        return admission;
      },
      fenceResolution(transaction, request, fence) {
        calls.fence.push({
          hostEpoch: transaction.hostEpoch,
          request: structuredClone(request),
          fence: structuredClone(fence),
        });
        if (overrides.fenceResolution) {
          return overrides.fenceResolution(transaction, request, fence);
        }
      },
      async executeTwRpc(plan) {
        calls.execute.push(structuredClone(plan));
        if (overrides.executeTwRpc) return overrides.executeTwRpc(plan);
        return successfulCreate(
          plan,
          `incarnation:post-create:${plan.resourceReservation.reservationId}`,
        );
      },
      async executeTerminalControl() {
        throw new Error("joint H1/H2 tests only execute canonical TW RPC");
      },
    },
  };
}

function materializedRoot(snapshot) {
  const root = Object.values(snapshot.materialized).find((value) => (
    value?.version === 1
    && Array.isArray(value.scopes)
    && Array.isArray(value.capacityReservations)
    && Array.isArray(value.negativeSettlements)
  ));
  assert.ok(root, "H2 materialized root must be persistent");
  return root;
}

function fencedNegativeEvidence(reservation) {
  return {
    schemaVersion: 1,
    authority: "canonical_executor",
    disposition: "fenced_no_side_effect",
    reservationId: reservation.reservationId,
    hostEpoch: reservation.hostEpoch,
    principalId: reservation.principalId,
    hostId: reservation.hostId,
    commandId: reservation.commandId,
    requestFingerprint: structuredClone(reservation.requestFingerprint),
    operation: reservation.operation,
    scopeId: reservation.scopeId,
    boundBackendInstanceKey: null,
  };
}

function invalidSynchronousSinkResult(mode, h) {
  if (mode === "nonboolean") return 1;
  if (mode === "rejected-promise") return Promise.reject(new Error("rejected sink promise"));
  if (mode === "custom-rejecting-thenable") {
    return { then(_resolve, reject) { reject(new Error("custom thenable rejected")); } };
  }
  if (mode === "hung-promise") return new Promise(() => {});
  if (mode === "reentrant-read") return h.store.read();
  throw new Error("sink threw synchronously");
}

async function seedLocalScope(h, { withResolver = false, withSession = false } = {}) {
  const seededIncarnation = `twinc2.${"S".repeat(43)}`;
  const seededSession = terminal(
    canonicalBackendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: resolverProcessTarget("local", "configured-local"),
      incarnation: seededIncarnation,
    }),
    "managed-terminal",
  );
  const scan = {
    coverage: "complete",
    scopes: [scope({
      backendIdentity: "local",
      displayName: "Local",
      kind: "local",
      sessions: withSession ? [seededSession] : [],
    })],
  };
  if (withResolver) {
    Object.defineProperty(scan, resourceState.RELAY_V2_RESOURCE_RESOLVER_CUT, {
      value: {
        generation: "test-local-complete",
        scopeTargets: [{
          scopeBackendIdentity: "local",
          processTarget: resolverProcessTarget("local", "configured-local"),
          capabilities: ["session.list"],
        }],
        sessionTargets: withSession ? [{
          scopeBackendIdentity: "local",
          sessionBackendIdentity: seededSession.backendIdentity,
          backendKind: "terminal",
          processTarget: resolverProcessTarget("local", "configured-local"),
          capabilities: ["session.list"],
          managedTarget: {
            name: "managed-terminal",
            kind: "terminal",
            incarnation: seededIncarnation,
          },
        }] : [],
        isCurrent: () => true,
      },
      enumerable: false,
    });
  }
  h.discovery.push(scan);
  const seeded = await h.foundation.reconcile();
  const scopeId = payload(
    await h.foundation.scopesSnapshot("joint-scope", seeded.snapshot.hostEpoch),
  ).items[0].scopeId;
  const sessionId = withSession
    ? payload(await h.foundation.sessionsSnapshot(
        "joint-session",
        seeded.snapshot.hostEpoch,
        [scopeId],
      )).scopes[0].items[0].sessionId
    : null;
  return {
    seeded,
    scopeId,
    sessionId,
    resolverToken: withResolver
      ? await h.foundation.canonicalTargetResolver.captureToken(seeded.snapshot.hostEpoch)
      : null,
  };
}

test("oversized convenience session snapshots direct clients to state.snapshot", async () => {
  const h = await harness();
  try {
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "large-local",
        displayName: "Large local",
        kind: "local",
        sessions: Array.from({ length: 300 }, (_, index) => terminal(
          `pane:large:${index}`,
          `large-${index}`,
        )).map((item, index) => ({
          ...item,
          cwd: `/${String(index).padStart(4, "0")}/${"x".repeat(4_000)}`,
        })),
      })],
    });
    const reconciled = await h.foundation.reconcile();
    await assert.rejects(
      h.foundation.sessionsSnapshot(
        "oversized-convenience-snapshot",
        reconciled.snapshot.hostEpoch,
        null,
      ),
      (error) => {
        assert.ok(error instanceof resourceState.RelayV2MaterializedStateError);
        assert.equal(error.code, "SNAPSHOT_TOO_LARGE");
        assert.deepEqual({ ...error.details }, { useStateSnapshot: true });
        return true;
      },
    );
  } finally {
    h.cleanup();
  }
});

async function openCommandPlane(h, executor, options = {}) {
  return commandPlane.RelayV2HostCommandPlane.open({
    store: options.store ?? h.store,
    hostId: "mac-admin",
    executor,
    resourceMutationOwner: options.owner
      ?? options.foundation?.commandResourceMutationOwner
      ?? h.foundation.commandResourceMutationOwner,
    now: h.now,
    recover: options.recover ?? true,
  });
}

async function issueWindow(h, plane) {
  return plane.issueDedupeWindow({
    acceptUntilMs: h.now() + 60_000,
    queryUntilMs: h.now() + 60_000 + commandPlane.RELAY_V2_COMMAND_DEDUPE_RETENTION_MS,
  });
}

test("H2 resolution cuts are re-fenced inside H1 final admission", async (t) => {
  for (const outcome of ["positive", "complete_negative"]) {
    await t.test(outcome, async () => {
      const h = await harness();
      try {
        const { seeded, scopeId, resolverToken } = await seedLocalScope(
          h,
          { withResolver: true },
        );
        const missingSessionId = "ses_missing_from_complete_cut";
        const h2Fence = outcome === "positive"
          ? await h.foundation.canonicalTargetResolver.resolveScopeForAdmission(
              resolverToken,
              scopeId,
            )
          : await h.foundation.canonicalTargetResolver.resolveSessionForAdmission(
              resolverToken,
              scopeId,
              missingSessionId,
            );
        assert.equal(h2Fence.result.kind, outcome);
        await h.store.transaction((transaction) => {
          h.foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
            transaction,
            h2Fence,
          );
        });

        let invalidatedSnapshot;
        const fake = commandExecutor({
          resolve: async (request) => {
            h.discovery.push({
              coverage: "complete",
              scopes: [scope({
                backendIdentity: "local",
                displayName: "Local",
                kind: "local",
              })],
            });
            await h.foundation.reconcile();
            invalidatedSnapshot = await h.store.read();
            if (outcome === "complete_negative") {
              return {
                kind: "immutable_business_failure",
                resolutionFence: commandResolutionFence(h2Fence),
                authorityEvidence: {
                  schemaVersion: commandPlane.RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION,
                  coverage: "complete",
                  authority: request.authority,
                  hostId: request.hostId,
                  hostEpoch: request.hostEpoch,
                  scopeId: request.scopeId,
                  sessionId: request.sessionId,
                  evidence: { resolver: "h2-complete-cut" },
                },
                error: {
                  code: "SESSION_NOT_FOUND",
                  message: "Session is absent from the complete authority cut",
                  retryable: false,
                  commandDisposition: "completed",
                  details: null,
                },
              };
            }
            const displayName = request.arguments.label ?? "terminal";
            return {
              kind: "executable",
              resolutionFence: commandResolutionFence(h2Fence),
              adapterState: { executionTarget: { scopeId: request.scopeId } },
              resourceReservationPlan: {
                logicalTarget: { scopeId: request.scopeId },
                session: commandSession(displayName),
              },
            };
          },
          fenceResolution: (transaction, request, fence) => {
            const resourceCut = fence.evidence.resourceCut;
            assert.equal(fence.expectedScopeId, request.scopeId);
            assert.equal(fence.expectedSessionId, request.sessionId);
            assert.equal(resourceCut.result.kind, fence.outcome);
            if (fence.outcome === "complete_negative") {
              assert.equal(resourceCut.result.code, fence.code);
            }
            h.foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
              transaction,
              resourceCut,
            );
          },
        });
        const plane = await openCommandPlane(h, fake.executor);
        const window = await issueWindow(h, plane);
        const commandId = `cmd-stale-${outcome}`;
        const frame = outcome === "positive"
          ? createTerminalFrame(seeded.snapshot.hostEpoch, window.windowId, scopeId, commandId)
          : killSessionFrame(
              seeded.snapshot.hostEpoch,
              window.windowId,
              scopeId,
              missingSessionId,
              commandId,
            );
        const response = await plane.execute(commandAuth(), frame);
        assert.equal(response.type, "error");
        assert.equal(response.commandId, commandId);
        assert.equal(response.error.code, "CAPABILITY_UNAVAILABLE");
        assert.equal(response.error.commandDisposition, "not_accepted");
        assert.equal(fake.calls.fence.length, 1);
        assert.equal(fake.calls.execute.length, 0);
        const after = await h.store.read();
        assert.deepEqual(after.commands, invalidatedSnapshot.commands);
        assert.equal(materializedRoot(after).capacityReservations.length, 0);
      } finally {
        h.cleanup();
      }
    });
  }
});

test("H1 ACCEPTED and H2 reservation roll back together on the H0 state rename", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const fake = commandExecutor();
    const normalPlane = await openCommandPlane(h, fake.executor, { recover: false });
    const window = await issueWindow(h, normalPlane);
    const before = await h.store.read();
    let failRename = true;
    const failingStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (failRename && destination === h.paths.state) {
          failRename = false;
          throw new Error("injected joint admission rename failure");
        }
        renameSync(source, destination);
      },
    });
    const failingFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: failingStore,
      readinessSink: new ReadinessSink(),
    });
    const failingPlane = await openCommandPlane(h, fake.executor, {
      store: failingStore,
      foundation: failingFoundation,
      recover: false,
    });
    const frame = createTerminalFrame(
      seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-atomic",
    );
    await assert.rejects(
      failingPlane.execute(commandAuth(), frame),
      /injected joint admission rename failure/,
    );
    const after = await h.store.read();
    assert.deepEqual(after.commands, before.commands);
    assert.equal(materializedRoot(after).capacityReservations.length, 0);
    assert.equal(fake.calls.execute.length, 0);
  } finally {
    h.cleanup();
  }
});

test("an uncertain H1 resource commit fences before queued reconcile and welcome leave H0", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const bootstrap = await openCommandPlane(h, commandExecutor().executor, { recover: false });
    const window = await issueWindow(h, bootstrap);
    let continuityRenames = 0;
    let stateRenames = 0;
    let failingFoundation;
    let queuedReconciliation;
    let queuedWelcome;
    let welcomeObservedClosed = -1;
    const failingStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (destination === h.paths.state) {
          stateRenames += 1;
          renameSync(source, destination);
          if (stateRenames === 3) {
            queuedReconciliation = failingFoundation.reconcile();
            queuedWelcome = failingFoundation.linearizeWelcome(
              "queued-after-uncertain-commit",
              {
                enqueue: () => {
                  welcomeObservedClosed = closed.length;
                  return true;
                },
              },
              buildWelcome,
            );
          }
          return;
        }
        if (destination === h.paths.continuity) {
          continuityRenames += 1;
          if (continuityRenames === 3) {
            throw new Error("injected final resource witness failure");
          }
        }
        renameSync(source, destination);
      },
    });
    const readinessSink = new ReadinessSink();
    const discovery = new QueueDiscovery();
    failingFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store: failingStore,
      readinessSink,
    });
    const closed = [];
    const delivered = [];
    await failingFoundation.linearizeWelcome(
      "before-h1-uncertain",
      {
        enqueue(item) { delivered.push(structuredClone(item)); return true; },
        close(error) { closed.push(error); },
      },
      buildWelcome,
    );
    const backendInstanceKey = "incarnation:uncertain-final";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => successfulCreate(plan, backendInstanceKey),
    });
    const plane = await openCommandPlane(h, fake.executor, {
      store: failingStore,
      foundation: failingFoundation,
      recover: false,
    });
    const commandId = "cmd-witness-uncertain";
    const frame = createTerminalFrame(
      seeded.snapshot.hostEpoch, window.windowId, scopeId, commandId,
    );
    discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [{
          backendIdentity: backendInstanceKey,
          ...commandSession(frame.payload.arguments.label),
        }],
      })],
    });
    const response = await plane.execute(
      commandAuth(),
      frame,
    );
    assert.equal(response.payload.state, "succeeded");
    const [reconciled, welcome] = await Promise.all([queuedReconciliation, queuedWelcome]);
    assert.equal(closed.length, 1);
    assert.deepEqual(delivered.map((item) => item.type), ["host.welcome"]);
    assert.equal(welcomeObservedClosed, 1, "the queued welcome runs only after the fence closes old cuts");
    assert.equal(welcome.payload.resumeDisposition, "snapshot_required");
    assert.equal(
      BigInt(welcome.payload.eventSeq),
      BigInt(seeded.snapshot.eventSeq) + 1n,
      "the queued welcome captures the committed resource cut under the active fence",
    );
    assert.ok(BigInt(reconciled.snapshot.eventSeq) >= BigInt(welcome.payload.eventSeq));
    const fenceSignal = readinessSink.signals.findIndex((signal) => (
      signal.reason === "commit_uncertain" && signal.closeV2Routes
    ));
    assert.ok(fenceSignal >= 0);
    assert.ok(fenceSignal < readinessSink.signals.length - 1);
    assert.equal(
      materializedRoot(await failingStore.read()).capacityReservations.length,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test("H1 restart runner consumes the persisted H2 binding without an H2 worker", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const fake = commandExecutor();
    const bootstrap = await openCommandPlane(h, fake.executor, { recover: false });
    const window = await issueWindow(h, bootstrap);
    let stateRenames = 0;
    let blockRunning = true;
    let sawRunningFailure;
    const runningFailure = new Promise((resolve) => { sawRunningFailure = resolve; });
    const failingStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (destination === h.paths.state) {
          stateRenames += 1;
          if (stateRenames >= 2 && blockRunning) {
            sawRunningFailure();
            throw new Error("injected pre-RUNNING rename failure");
          }
        }
        renameSync(source, destination);
      },
    });
    const failingFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: failingStore,
      readinessSink: new ReadinessSink(),
    });
    const firstPlane = await openCommandPlane(h, fake.executor, {
      store: failingStore,
      foundation: failingFoundation,
      recover: false,
    });
    const pending = firstPlane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-restart-runner",
      ),
    );
    await runningFailure;
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 1);
    blockRunning = false;
    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restartedFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: restartedStore,
      readinessSink: new ReadinessSink(),
    });
    await openCommandPlane(h, fake.executor, {
      store: restartedStore,
      foundation: restartedFoundation,
      recover: true,
    });
    const response = await pending;
    assert.equal(response.payload.state, "succeeded");
    assert.equal(fake.calls.execute.length, 1);
    assert.equal(materializedRoot(await restartedStore.read()).capacityReservations.length, 0);
  } finally {
    h.cleanup();
  }
});

test("an exact persisted reservation replay precedes later partial-readiness rejection", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId, resolverToken } = await seedLocalScope(h, { withResolver: true });
    const resolverTarget = await h.foundation.canonicalTargetResolver.resolveScope(
      resolverToken,
      scopeId,
    );
    const resolverFence = await h.foundation.canonicalTargetResolver.resolveScopeForAdmission(
      resolverToken,
      scopeId,
    );
    let releaseExecution;
    let executionStarted;
    const started = new Promise((resolve) => { executionStarted = resolve; });
    const release = new Promise((resolve) => { releaseExecution = resolve; });
    const fake = commandExecutor({
      executeTwRpc: async (plan) => {
        executionStarted();
        await release;
        return successfulCreate(plan, "incarnation:replayed-reservation");
      },
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const pending = plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-reservation-replay",
      ),
    );
    await started;
    assert.deepEqual(
      await h.foundation.canonicalTargetResolver.captureToken(seeded.snapshot.hostEpoch),
      resolverToken,
      "reservation ledger writes must not rotate the resource mapping cut",
    );
    assert.deepEqual(
      await h.foundation.canonicalTargetResolver.resolveScope(resolverToken, scopeId),
      resolverTarget,
    );
    await h.store.transaction((transaction) => {
      h.foundation.canonicalTargetResolver.fenceResourceCutForAdmission(
        transaction,
        resolverFence,
      );
    });
    const snapshot = await h.store.read();
    const record = Object.values(snapshot.commands).find((item) => (
      item.commandId === "cmd-reservation-replay"
    ));
    assert.ok(record);
    const reservation = materializedRoot(snapshot).capacityReservations[0];
    h.discovery.push({
      coverage: "partial",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        reachability: "online",
        sessionsCompleteness: "partial",
        error: {
          code: "BUSY",
          message: "scan incomplete",
          retryable: true,
          commandDisposition: "not_applicable",
        },
      })],
    });
    assert.equal((await h.foundation.reconcile()).readiness.reason, "aggregate_coverage_partial");
    const replay = await h.store.transaction((transaction) => (
      h.foundation.commandResourceMutationOwner.reserve(transaction, {
        schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
        owner: "relay_v2_resource_state",
        operation: record.operation,
        principalId: record.principalId,
        hostId: record.hostId,
        hostEpoch: record.hostEpoch,
        commandId: record.commandId,
        requestFingerprint: structuredClone(record.fingerprint),
        scopeId: record.scopeId,
        reservationPlan: {
          logicalTarget: {
            authority: "tw_rpc",
            principalId: record.principalId,
            scopeId: record.scopeId,
            terminalLabel: record.arguments.label,
          },
          session: commandSession(record.arguments.label),
        },
      })
    ));
    assert.equal(replay.value.kind, "reserved");
    assert.equal(replay.value.binding.reservationId, reservation.reservationId);
    releaseExecution();
    assert.equal((await pending).payload.state, "succeeded");
  } finally {
    h.cleanup();
  }
});

test("same commandId under different principals keeps isolated reservations and Session identities", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const fake = commandExecutor();
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const frame = createTerminalFrame(
      seeded.snapshot.hostEpoch, window.windowId, scopeId, "shared-command-id",
    );
    const first = await plane.execute(commandAuth("principal-a"), frame);
    const second = await plane.execute(commandAuth("principal-b"), {
      ...structuredClone(frame),
      requestId: "principal-b-request",
    });
    assert.equal(first.payload.state, "succeeded");
    assert.equal(second.payload.state, "succeeded");
    assert.notEqual(first.payload.result.session.sessionId, second.payload.result.session.sessionId);
    const records = Object.values((await h.store.read()).commands)
      .filter((record) => record.commandId === frame.commandId);
    assert.deepEqual(records.map((record) => record.principalId).sort(), ["principal-a", "principal-b"]);
    assert.equal(payload(await h.foundation.sessionsSnapshot(
      "principal-isolation", seeded.snapshot.hostEpoch, [scopeId],
    )).scopes[0].items.length, 2);
  } finally {
    h.cleanup();
  }
});

test("a scan from an old H2 generation retries instead of deleting a concurrently committed Session", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    let releaseOldScan;
    let scanStarted;
    const oldScan = new Promise((resolve) => { releaseOldScan = resolve; });
    const started = new Promise((resolve) => { scanStarted = resolve; });
    h.discovery.pushDeferred(oldScan, scanStarted);
    const reconciliation = h.foundation.reconcile();
    await started;

    const backendInstanceKey = "incarnation:during-old-scan";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => successfulCreate(plan, backendInstanceKey),
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const commandId = "cmd-during-old-scan";
    const response = await plane.execute(
      commandAuth(),
      createTerminalFrame(seeded.snapshot.hostEpoch, window.windowId, scopeId, commandId),
    );
    assert.equal(response.payload.state, "succeeded");
    const created = response.payload.result.session;
    const afterCommandRoot = materializedRoot(await h.store.read());
    assert.ok(BigInt(afterCommandRoot.generation) > BigInt(materializedRoot(seeded.snapshot).generation));
    assert.equal(
      afterCommandRoot.scopes.flatMap((item) => item.sessions)
        .find((item) => item.item.sessionId === created.sessionId).backendIdentity,
      backendInstanceKey,
    );
    const { scopeId: _scopeId, sessionId: _sessionId, ...observed } = created;
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [{
          backendIdentity: backendInstanceKey,
          ...observed,
        }],
      })],
    });
    releaseOldScan({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [],
      })],
    });
    await reconciliation;

    const sessions = payload(await h.foundation.sessionsSnapshot(
      "after-old-scan-retry",
      seeded.snapshot.hostEpoch,
      [scopeId],
    )).scopes[0].items;
    assert.deepEqual(sessions.map((item) => item.sessionId), [created.sessionId]);
  } finally {
    h.cleanup();
  }
});

test("a stale complete scan retries without releasing a reservation created during I/O", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    let releaseOldScan;
    let scanStarted;
    const oldScan = new Promise((resolve) => { releaseOldScan = resolve; });
    const started = new Promise((resolve) => { scanStarted = resolve; });
    h.discovery.pushDeferred(oldScan, scanStarted);
    const reconciliation = h.foundation.reconcile();
    await started;

    const inDoubt = commandExecutor({ executeTwRpc: async () => ({ state: "in_doubt" }) });
    const plane = await openCommandPlane(h, inDoubt.executor);
    const window = await issueWindow(h, plane);
    assert.equal((await plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch,
        window.windowId,
        scopeId,
        "cmd-created-during-proof-scan",
      ),
    )).payload.state, "in_doubt");
    const reservationId = materializedRoot(await h.store.read()).capacityReservations[0].reservationId;
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [],
      })],
    });
    releaseOldScan({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [],
      })],
    });
    await reconciliation;
    assert.equal(
      materializedRoot(await h.store.read()).capacityReservations[0].reservationId,
      reservationId,
    );
  } finally {
    h.cleanup();
  }
});

test("reconciliation bounds repeated generation conflicts and withdraws readiness", async () => {
  const h = await harness();
  try {
    const { seeded } = await seedLocalScope(h);
    const scan = {
      coverage: "complete",
      scopes: [scope({ backendIdentity: "local", displayName: "Local", kind: "local" })],
    };
    let scanCalls = 0;
    const readinessSink = new ReadinessSink();
    const conflicted = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      store: h.store,
      readinessSink,
      discovery: {
        async scan() {
          scanCalls += 1;
          h.discovery.push(scan);
          await h.foundation.reconcile();
          return structuredClone(scan);
        },
      },
    });
    await assert.rejects(
      conflicted.reconcile(),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    assert.equal(scanCalls, 3);
    assert.equal(readinessSink.signals.at(-1).reason, "reconcile_generation_conflict");
    assert.equal(readinessSink.signals.at(-1).closeV2Routes, true);
    assert.equal((await h.store.read()).hostEpoch, seeded.snapshot.hostEpoch);
    assert.equal(
      (await h.store.read()).materializedReadinessFence.reason,
      "reconcile_generation_conflict",
    );
    assert.equal((await conflicted.readiness()).reason, "reconcile_generation_conflict");
    await assert.rejects(
      conflicted.linearizeWelcome(
        "generation-conflict-fenced",
        { enqueue: () => true },
        buildWelcome,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restarted = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: restartedStore,
      readinessSink: new ReadinessSink(),
    });
    assert.equal((await restarted.readiness()).reason, "reconcile_generation_conflict");

    h.discovery.push(scan);
    const recovered = await h.foundation.reconcile();
    assert.equal(recovered.snapshot.materializedReadinessFence, null);
    assert.equal(recovered.readiness.reason, "ready");
  } finally {
    h.cleanup();
  }
});

test("synchronous H1 resource enqueue precedes a queued welcome cut and preserves W+1", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const delivered = [];
    let welcomePending;
    const baseOwner = h.foundation.commandResourceMutationOwner;
    const synchronousOwner = {
      ...baseOwner,
      publishCommitted(snapshot, evidence) {
        welcomePending = h.foundation.linearizeWelcome(
          "queued-during-command-resource-publication",
          { enqueue(item) { delivered.push(structuredClone(item)); return true; } },
          buildWelcome,
        );
        baseOwner.publishCommitted(snapshot, evidence);
      },
    };
    const backendInstanceKey = "incarnation:synchronous-publication";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => successfulCreate(plan, backendInstanceKey),
    });
    const plane = await openCommandPlane(h, fake.executor, { owner: synchronousOwner });
    const window = await issueWindow(h, plane);
    const response = await plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-published-resource",
      ),
    );
    const welcome = await welcomePending;
    assert.equal(response.payload.state, "succeeded");
    assert.deepEqual(delivered.map((item) => item.type), ["host.welcome"]);
    assert.equal(welcome.payload.eventSeq, (await h.store.read()).eventSeq);

    const created = response.payload.result.session;
    const { scopeId: _scopeId, sessionId: _sessionId, ...observed } = created;
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [{
          backendIdentity: backendInstanceKey,
          ...observed,
          activityAtMs: observed.activityAtMs + 1,
        }],
      })],
    });
    await h.foundation.reconcile();
    assert.deepEqual(delivered.map((item) => item.type), ["host.welcome", "sessions.changed"]);
    assert.equal(BigInt(delivered[1].eventSeq), BigInt(welcome.payload.eventSeq) + 1n);
    assert.equal(delivered[1].payload.change.item.sessionId, created.sessionId);
  } finally {
    h.cleanup();
  }
});

test("open or failing H1 publication callbacks fence immediately without freezing H0", async () => {
  const modes = [
    ["reentrant-read", (h) => h.store.read()],
    ["thenable", () => ({ then() {} })],
    ["custom-rejecting-thenable", () => ({
      then(_resolve, reject) { reject(new Error("publication thenable rejected")); },
    })],
    ["rejected-promise", () => Promise.reject(new Error("publication rejected"))],
    ["hung-promise", () => new Promise(() => {})],
    ["throw", () => { throw new Error("publication failed"); }],
  ];
  for (const [mode, publication] of modes) {
    const h = await harness();
    try {
      const { seeded, scopeId } = await seedLocalScope(h);
      const oldDelivered = [];
      const oldClosed = [];
      await h.foundation.linearizeWelcome(
        `before-invalid-publication-${mode}`,
        {
          enqueue(item) { oldDelivered.push(structuredClone(item)); return true; },
          close(error) { oldClosed.push(error); },
        },
        buildWelcome,
      );
      const baseOwner = h.foundation.commandResourceMutationOwner;
      const invalidOwner = {
        ...baseOwner,
        publishCommitted() { return publication(h); },
      };
      const fake = commandExecutor({
        executeTwRpc: async (plan) => successfulCreate(plan, `incarnation:${mode}`),
      });
      const plane = await openCommandPlane(h, fake.executor, { owner: invalidOwner });
      const window = await issueWindow(h, plane);
      let timeout;
      const response = await Promise.race([
        plane.execute(
          commandAuth(`principal-${mode}`),
          createTerminalFrame(
            seeded.snapshot.hostEpoch, window.windowId, scopeId, `cmd-${mode}`,
          ),
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${mode} froze the H0 serializer`)), 1_000);
        }),
      ]).finally(() => clearTimeout(timeout));
      assert.equal(response.payload.state, "succeeded", mode);
      assert.deepEqual(oldDelivered.map((item) => item.type), ["host.welcome"], mode);
      assert.equal(oldClosed.length, 1, mode);

      const reconnected = [];
      const welcome = await h.foundation.linearizeWelcome(
        `after-invalid-publication-${mode}`,
        { enqueue(item) { reconnected.push(structuredClone(item)); return true; } },
        buildWelcome,
      );
      assert.equal(welcome.payload.resumeDisposition, "snapshot_required", mode);
      assert.equal(welcome.payload.eventSeq, (await h.store.read()).eventSeq, mode);
      assert.deepEqual(reconnected, [welcome], mode);
    } finally {
      h.cleanup();
    }
  }
});

test("production readiness, welcome, and event sinks require strict synchronous true", async () => {
  const modes = [
    "nonboolean",
    "rejected-promise",
    "custom-rejecting-thenable",
    "hung-promise",
    "reentrant-read",
    "throw",
  ];
  for (const [index, mode] of modes.entries()) {
    const h = await harness();
    try {
      const { seeded } = await seedLocalScope(h);
      const backendInstanceKey = `incarnation:sink:${mode}`;
      const readinessDiscovery = new QueueDiscovery();
      let readinessCalls = 0;
      const readinessClosed = [];
      const readinessFoundation = new resourceState.RelayV2MaterializedStateFoundation({
        hostId: "mac-admin",
        discovery: readinessDiscovery,
        store: h.store,
        readinessSink: {
          apply() {
            readinessCalls += 1;
            return readinessCalls === 1
              ? true
              : invalidSynchronousSinkResult(mode, h);
          },
        },
      });
      await readinessFoundation.linearizeWelcome(
        `readiness-sink-${mode}`,
        {
          enqueue: () => true,
          close(error) {
            readinessClosed.push(error);
            return invalidSynchronousSinkResult(mode, h);
          },
        },
        buildWelcome,
      );
      readinessDiscovery.push({
        coverage: "complete",
        scopes: [scope({
          backendIdentity: "local",
          displayName: "Local",
          kind: "local",
          sessions: [terminal(backendInstanceKey, `sink-${mode}`, 1_783_700_001_000 + index)],
        })],
      });
      await readinessFoundation.reconcile();
      assert.equal(readinessClosed.length, 1, `${mode} readiness must close the route`);
      await assert.rejects(
        readinessFoundation.linearizeWelcome(
          `readiness-reopen-${mode}`,
          { enqueue: () => true },
          buildWelcome,
        ),
        assertMaterializedError("CAPABILITY_UNAVAILABLE"),
      );

      const welcomeFoundation = new resourceState.RelayV2MaterializedStateFoundation({
        hostId: "mac-admin",
        discovery: new QueueDiscovery(),
        store: h.store,
        readinessSink: { apply: () => true },
      });
      await assert.rejects(
        welcomeFoundation.linearizeWelcome(
          `welcome-sink-${mode}`,
          {
            enqueue: () => invalidSynchronousSinkResult(mode, h),
            close: () => invalidSynchronousSinkResult(mode, h),
          },
          buildWelcome,
        ),
        assertMaterializedError("BUSY"),
      );

      const eventDiscovery = new QueueDiscovery();
      const eventFoundation = new resourceState.RelayV2MaterializedStateFoundation({
        hostId: "mac-admin",
        discovery: eventDiscovery,
        store: h.store,
        readinessSink: { apply: () => true },
      });
      const eventAttempts = [];
      const eventClosed = [];
      await eventFoundation.linearizeWelcome(
        `event-sink-${mode}`,
        {
          enqueue(item) {
            eventAttempts.push(item.type);
            return item.type === "host.welcome"
              ? true
              : invalidSynchronousSinkResult(mode, h);
          },
          close(error) {
            eventClosed.push(error);
            return invalidSynchronousSinkResult(mode, h);
          },
        },
        buildWelcome,
      );
      eventDiscovery.push({
        coverage: "complete",
        scopes: [scope({
          backendIdentity: "local",
          displayName: "Local",
          kind: "local",
          sessions: [terminal(backendInstanceKey, `sink-${mode}`, 1_783_700_002_000 + index)],
        })],
      });
      await eventFoundation.reconcile();
      assert.deepEqual(eventAttempts, ["host.welcome", "sessions.changed"], mode);
      assert.equal(eventClosed.length, 1, `${mode} event must drop the subscriber`);
      assert.equal((await h.store.read()).hostEpoch, seeded.snapshot.hostEpoch);
    } finally {
      h.cleanup();
    }
  }
});

test("concurrent H1 resource finalizations publish in their H0 commit order", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const delivered = [];
    await h.foundation.linearizeWelcome(
      "before-concurrent-finalize",
      { enqueue(item) { delivered.push(structuredClone(item)); return true; } },
      buildWelcome,
    );

    let startA;
    let startB;
    let releaseA;
    let releaseB;
    const startedA = new Promise((resolve) => { startA = resolve; });
    const startedB = new Promise((resolve) => { startB = resolve; });
    const executionA = new Promise((resolve) => { releaseA = resolve; });
    const executionB = new Promise((resolve) => { releaseB = resolve; });
    const fake = commandExecutor({
      executeTwRpc: async (plan) => {
        if (plan.principalId === "principal-finalize-a") {
          startA();
          await executionA;
        } else {
          startB();
          await executionB;
        }
        return successfulCreate(
          plan,
          `incarnation:ordered:${plan.principalId}`,
        );
      },
    });
    const committedSeqs = [];
    const publishedSeqs = [];
    const baseOwner = h.foundation.commandResourceMutationOwner;
    const orderedOwner = {
      ...baseOwner,
      commit(transaction, intent) {
        const evidence = baseOwner.commit(transaction, intent);
        committedSeqs.push(evidence.events[0].eventSeq);
        return evidence;
      },
      publishCommitted(snapshot, evidence) {
        publishedSeqs.push(evidence.events[0].eventSeq);
        baseOwner.publishCommitted(snapshot, evidence);
      },
    };
    const plane = await openCommandPlane(h, fake.executor, { owner: orderedOwner });
    const window = await issueWindow(h, plane);
    const pendingA = plane.execute(
      commandAuth("principal-finalize-a"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-finalize-a",
      ),
    );
    const pendingB = plane.execute(
      commandAuth("principal-finalize-b"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-finalize-b",
      ),
    );
    await Promise.all([startedA, startedB]);
    releaseA();
    releaseB();
    const [responseA, responseB] = await Promise.all([pendingA, pendingB]);
    assert.equal(responseA.payload.state, "succeeded");
    assert.equal(responseB.payload.state, "succeeded");
    assert.equal(committedSeqs.length, 2);
    assert.equal(publishedSeqs.length, 2);
    assert.deepEqual(publishedSeqs, committedSeqs);
    assert.equal(BigInt(committedSeqs[1]), BigInt(committedSeqs[0]) + 1n);
    const deliveredEvents = delivered.filter((item) => item.type === "sessions.changed");
    assert.deepEqual(deliveredEvents.map((item) => item.eventSeq), committedSeqs);
  } finally {
    h.cleanup();
  }
});

test("duplicate post-create backend authority retains one unbound IN_DOUBT reservation and sticky-fences H2", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const closed = [];
    await h.foundation.linearizeWelcome(
      "before-backend-authority-collision",
      {
        enqueue: () => true,
        close(error) { closed.push(error); },
      },
      buildWelcome,
    );
    let startedCount = 0;
    let bothStarted;
    let releaseBoth;
    const started = new Promise((resolve) => { bothStarted = resolve; });
    const release = new Promise((resolve) => { releaseBoth = resolve; });
    const backendInstanceKey = "incarnation:duplicate-post-create";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => {
        startedCount += 1;
        if (startedCount === 2) bothStarted();
        await release;
        return successfulCreate(plan, backendInstanceKey);
      },
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const frameA = createTerminalFrame(
      seeded.snapshot.hostEpoch,
      window.windowId,
      scopeId,
      "cmd-backend-collision-a",
    );
    frameA.requestId = "attempt-backend-collision-a";
    frameA.payload.arguments.label = "collision-a";
    const frameB = createTerminalFrame(
      seeded.snapshot.hostEpoch,
      window.windowId,
      scopeId,
      "cmd-backend-collision-b",
    );
    frameB.requestId = "attempt-backend-collision-b";
    frameB.payload.arguments.label = "collision-b";
    const pending = [
      plane.execute(commandAuth("principal-collision-a"), frameA),
      plane.execute(commandAuth("principal-collision-b"), frameB),
    ];
    await started;
    releaseBoth();
    const responses = await Promise.all(pending);
    assert.deepEqual(
      responses.map((response) => response.payload.state).sort(),
      ["in_doubt", "succeeded"],
    );
    assert.equal(closed.length, 1);

    const snapshot = await h.store.read();
    assert.equal(
      snapshot.materializedReadinessFence.reason,
      "materialized_authority_conflict",
    );
    const root = materializedRoot(snapshot);
    assert.equal(root.scopes[0].sessions.length, 1);
    assert.equal(root.scopes[0].sessions[0].backendIdentity, backendInstanceKey);
    assert.equal(root.capacityReservations.length, 1);
    assert.equal(root.capacityReservations[0].uncertain, true);
    assert.equal(root.capacityReservations[0].boundBackendIdentity, null);

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restarted = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: restartedStore,
      readinessSink: new ReadinessSink(),
    });
    assert.equal(
      (await restarted.readiness(snapshot.hostEpoch)).reason,
      "materialized_authority_conflict",
    );
  } finally {
    h.cleanup();
  }
});

test("concurrent H1 admissions cannot both pass the last H2 reservation slot", async () => {
  const h = await harness({ capacityLimits: { maxSnapshotRecords: 3 } });
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    let releaseFirst;
    let firstStarted;
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const fake = commandExecutor({
      executeTwRpc: async (plan) => {
        firstStarted();
        await release;
        return successfulCreate(plan, "incarnation:capacity-winner");
      },
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const firstPending = plane.execute(
      commandAuth("principal-capacity-a"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-capacity-a",
      ),
    );
    await started;
    const rejected = await plane.execute(
      commandAuth("principal-capacity-b"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-capacity-b",
      ),
    );
    assert.equal(rejected.type, "error");
    assert.equal(rejected.error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(rejected.error.commandDisposition, "not_accepted");
    assert.equal(fake.calls.execute.length, 1);
    releaseFirst();
    assert.equal((await firstPending).payload.state, "succeeded");
    const snapshot = await h.store.read();
    assert.equal(Object.values(snapshot.commands).some((record) => (
      record.commandId === "cmd-capacity-b"
    )), false);
  } finally {
    h.cleanup();
  }
});

test("H1 finalization reuses an exact backend incarnation materialized by reconciliation", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    let releaseExecution;
    let executionStarted;
    const started = new Promise((resolve) => { executionStarted = resolve; });
    const release = new Promise((resolve) => { releaseExecution = resolve; });
    const backendInstanceKey = "incarnation:post-create:one";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => {
        executionStarted();
        await release;
        return successfulCreate(plan, backendInstanceKey);
      },
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const pending = plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-reconcile-first",
      ),
    );
    await started;
    const reservation = materializedRoot(await h.store.read()).capacityReservations[0];
    assert.equal(reservation.boundBackendIdentity, null);
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal(backendInstanceKey, reservation.plannedSession.displayName)],
      })],
    });
    await h.foundation.reconcile();
    const external = payload(await h.foundation.sessionsSnapshot(
      "uncorrelated-external", seeded.snapshot.hostEpoch, [scopeId],
    )).scopes[0].items[0];
    assert.notEqual(external.sessionId, reservation.reservedSessionId);
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 1);
    releaseExecution();
    const response = await pending;
    assert.equal(response.payload.state, "succeeded");
    assert.equal(response.payload.result.session.sessionId, external.sessionId);
    const finalSessions = payload(await h.foundation.sessionsSnapshot(
      "correlated-final", seeded.snapshot.hostEpoch, [scopeId],
    )).scopes[0].items;
    assert.deepEqual(finalSessions.map((item) => item.sessionId), [external.sessionId]);
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 0);
  } finally {
    h.cleanup();
  }
});

test("late authority correlation consumes IN_DOUBT while discovery absence alone retains capacity", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const inDoubt = commandExecutor({ executeTwRpc: async () => ({ state: "in_doubt" }) });
    const plane = await openCommandPlane(h, inDoubt.executor);
    const window = await issueWindow(h, plane);
    const frame = createTerminalFrame(
      seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-late-side-effect",
    );
    const response = await plane.execute(commandAuth(), frame);
    assert.equal(response.payload.state, "in_doubt");
    const reservation = materializedRoot(await h.store.read()).capacityReservations[0];
    assert.equal(reservation.uncertain, true);
    assert.equal(reservation.boundBackendIdentity, null);

    const late = terminal("incarnation:late-side-effect", reservation.plannedSession.displayName);
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({ backendIdentity: "local", displayName: "Local", kind: "local", sessions: [late] })],
    });
    await h.foundation.reconcile();
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 1);
    const externalSessionId = payload(await h.foundation.sessionsSnapshot(
      "late-external", seeded.snapshot.hostEpoch, [scopeId],
    )).scopes[0].items[0].sessionId;
    assert.notEqual(externalSessionId, reservation.reservedSessionId);
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        reservationCorrelationCompleteness: "complete",
        sessions: [{
          ...late,
          reservationCorrelation: {
            schemaVersion: 1,
            reservationId: reservation.reservationId,
            hostEpoch: reservation.hostEpoch,
            principalId: reservation.principalId,
            hostId: reservation.hostId,
            commandId: reservation.commandId,
            requestFingerprint: structuredClone(reservation.requestFingerprint),
          },
        }],
      })],
    });
    await h.foundation.reconcile();
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 0);
    assert.equal(payload(await h.foundation.sessionsSnapshot(
      "late-correlated", seeded.snapshot.hostEpoch, [scopeId],
    )).scopes[0].items[0].sessionId, externalSessionId);

    const absentFrame = createTerminalFrame(
      seeded.snapshot.hostEpoch,
      window.windowId,
      scopeId,
      "cmd-complete-absence",
    );
    assert.equal((await plane.execute(commandAuth(), absentFrame)).payload.state, "in_doubt");
    const absentReservation = materializedRoot(await h.store.read()).capacityReservations[0];
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        reservationCorrelationCompleteness: "complete",
        sessions: [{
          ...late,
          reservationCorrelation: {
            schemaVersion: 1,
            reservationId: reservation.reservationId,
            hostEpoch: reservation.hostEpoch,
            principalId: reservation.principalId,
            hostId: reservation.hostId,
            commandId: reservation.commandId,
            requestFingerprint: structuredClone(reservation.requestFingerprint),
          },
        }],
      })],
    });
    await h.foundation.reconcile();
    const finalRoot = materializedRoot(await h.store.read());
    assert.equal(finalRoot.capacityReservations.some((item) => (
      item.reservationId === absentReservation.reservationId
    )), true);
  } finally {
    h.cleanup();
  }
});

test("a pre-rename H1 finalization failure binds positive backend evidence and forbids negative release", async () => {
  const settlementAuthority = new QueueSettlementAuthority();
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    let stateRenames = 0;
    const failingStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (destination === h.paths.state) {
          stateRenames += 1;
          if (stateRenames === 3) {
            throw new Error("injected pre-rename H1 finalization failure");
          }
        }
        renameSync(source, destination);
      },
    });
    const discovery = new QueueDiscovery();
    const foundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store: failingStore,
      readinessSink: new ReadinessSink(),
      reservationSettlementAuthority: settlementAuthority,
    });
    const backendInstanceKey = "incarnation:positive-after-finalization-failure";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => successfulCreate(plan, backendInstanceKey),
    });
    const plane = await openCommandPlane(h, fake.executor, {
      store: failingStore,
      foundation,
      recover: false,
    });
    const window = await issueWindow(h, plane);
    stateRenames = 0;
    const response = await plane.execute(
      commandAuth("principal-positive-evidence"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch,
        window.windowId,
        scopeId,
        "cmd-positive-evidence",
      ),
    );
    assert.equal(response.payload.state, "in_doubt");
    const reservation = structuredClone(
      materializedRoot(await failingStore.read()).capacityReservations[0],
    );
    assert.equal(reservation.uncertain, true);
    assert.equal(reservation.boundBackendIdentity, backendInstanceKey);

    discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [],
      })],
    });
    await foundation.reconcile();
    assert.deepEqual(settlementAuthority.calls, []);
    assert.equal(
      materializedRoot(await failingStore.read()).capacityReservations[0].reservationId,
      reservation.reservationId,
    );

    const correlation = {
      schemaVersion: 1,
      reservationId: reservation.reservationId,
      hostEpoch: reservation.hostEpoch,
      principalId: reservation.principalId,
      hostId: reservation.hostId,
      commandId: reservation.commandId,
      requestFingerprint: structuredClone(reservation.requestFingerprint),
    };
    discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [{
          ...terminal(backendInstanceKey, reservation.plannedSession.displayName),
          reservationCorrelation: correlation,
        }],
      })],
    });
    await foundation.reconcile();
    const settled = materializedRoot(await failingStore.read());
    assert.equal(settled.capacityReservations.length, 0);
    assert.equal(
      settled.scopes[0].sessions[0].item.sessionId,
      reservation.reservedSessionId,
    );
  } finally {
    h.cleanup();
  }
});

test("canonical negative settlement survives restart and fences contradictory late positive evidence", async () => {
  const settlementAuthority = new QueueSettlementAuthority();
  const h = await harness({ settlementAuthority });
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const inDoubt = commandExecutor({ executeTwRpc: async () => ({ state: "in_doubt" }) });
    const plane = await openCommandPlane(h, inDoubt.executor);
    const window = await issueWindow(h, plane);
    assert.equal((await plane.execute(
      commandAuth(),
      createTerminalFrame(seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-proof-cut"),
    )).payload.state, "in_doubt");
    const reservationId = materializedRoot(await h.store.read()).capacityReservations[0].reservationId;
    const reservation = materializedRoot(await h.store.read()).capacityReservations[0];
    const proofScan = {
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        reservationCorrelationCompleteness: "complete",
        sessions: [],
      })],
    };

    let failStateRename = false;
    const failingStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (failStateRename && destination === h.paths.state) {
          failStateRename = false;
          throw new Error("injected fenced-negative state rename failure");
        }
        renameSync(source, destination);
      },
    });
    const failingDiscovery = new QueueDiscovery();
    const failingFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: failingDiscovery,
      store: failingStore,
      readinessSink: new ReadinessSink(),
      reservationSettlementAuthority: settlementAuthority,
    });
    failingDiscovery.push(proofScan);
    settlementAuthority.push([fencedNegativeEvidence(reservation)]);
    failStateRename = true;
    await assert.rejects(
      failingFoundation.reconcile(),
      /injected fenced-negative state rename failure/,
    );
    assert.equal(
      settlementAuthority.calls.at(-1)[0].boundBackendInstanceKey,
      null,
      "the negative authority only receives an explicit no-positive-evidence schema",
    );
    assert.equal(
      materializedRoot(await h.store.read()).capacityReservations[0].reservationId,
      reservationId,
      "a failed proof cut retains the reservation and its capacity charge",
    );

    h.discovery.push(proofScan);
    settlementAuthority.push([fencedNegativeEvidence(reservation)]);
    const released = await h.foundation.reconcile();
    assert.equal(
      materializedRoot(released.snapshot).capacityReservations.some((item) => (
        item.reservationId === reservationId
      )),
      false,
    );
    const negative = materializedRoot(released.snapshot).negativeSettlements[0];
    assert.equal(negative.reservationId, reservationId);
    assert.equal(negative.hostEpoch, reservation.hostEpoch);
    assert.equal(negative.scopeId, reservation.scopeId);
    assert.equal(negative.backendKind, reservation.plannedSession.kind);

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restartedDiscovery = new QueueDiscovery();
    const restarted = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: restartedDiscovery,
      store: restartedStore,
      readinessSink: new ReadinessSink(),
    });
    restartedDiscovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [{
          ...terminal(
            "incarnation:late-after-negative",
            reservation.plannedSession.displayName,
          ),
          reservationCorrelation: {
            schemaVersion: 1,
            reservationId: reservation.reservationId,
            hostEpoch: reservation.hostEpoch,
            principalId: reservation.principalId,
            hostId: reservation.hostId,
            commandId: reservation.commandId,
            requestFingerprint: structuredClone(reservation.requestFingerprint),
          },
        }],
      })],
    });
    await assert.rejects(
      restarted.reconcile(),
      assertMaterializedError("INTERNAL"),
    );
    const contradicted = await restartedStore.read();
    assert.equal(
      contradicted.materializedReadinessFence.reason,
      "materialized_authority_conflict",
    );
    assert.equal(materializedRoot(contradicted).negativeSettlements[0].reservationId, reservationId);
    assert.equal(materializedRoot(contradicted).scopes[0].sessions.length, 0);
  } finally {
    h.cleanup();
  }
});

test("an IN_DOUBT tombstone is retained until canonical fenced-negative evidence settles it", async () => {
  const settlementAuthority = new QueueSettlementAuthority();
  const h = await harness({ settlementAuthority });
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const inDoubt = commandExecutor({ executeTwRpc: async () => ({ state: "in_doubt" }) });
    const plane = await openCommandPlane(h, inDoubt.executor);
    const window = await issueWindow(h, plane);
    const commandId = "cmd-tombstone-proof";
    assert.equal((await plane.execute(
      commandAuth(),
      createTerminalFrame(seeded.snapshot.hostEpoch, window.windowId, scopeId, commandId),
    )).payload.state, "in_doubt");
    let snapshot = await h.store.read();
    const reservationId = materializedRoot(snapshot).capacityReservations[0].reservationId;
    let ledger = Object.values(snapshot.commands).find((record) => record.commandId === commandId);
    h.setNow(ledger.resultUntilMs + 1);
    await plane.compact();
    snapshot = await h.store.read();
    ledger = Object.values(snapshot.commands).find((record) => record.commandId === commandId);
    assert.equal(ledger.recordType, "command_tombstone");
    assert.equal(ledger.finalState, "in_doubt");

    h.setNow(ledger.dedupeUntilMs + 1);
    await plane.compact();
    snapshot = await h.store.read();
    assert.ok(
      Object.values(snapshot.commands).some((record) => (
        record.commandId === commandId && record.recordType === "command_tombstone"
      )),
      "uncertain reservations have no TTL-based release or ledger deletion",
    );
    assert.equal(materializedRoot(snapshot).capacityReservations[0].reservationId, reservationId);

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        reservationCorrelationCompleteness: "complete",
        sessions: [],
      })],
    });
    settlementAuthority.push([
      fencedNegativeEvidence(materializedRoot(snapshot).capacityReservations[0]),
    ]);
    await h.foundation.reconcile();
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 0);
    await plane.compact();
    assert.equal(
      Object.values((await h.store.read()).commands).some((record) => record.commandId === commandId),
      false,
    );
  } finally {
    h.cleanup();
  }
});

test("reservation correlations are globally unique and bound to their materialized scope", async () => {
  const h = await harness();
  try {
    h.discovery.push({
      coverage: "complete",
      scopes: [
        scope({ backendIdentity: "local:a", displayName: "Scope A", kind: "local" }),
        scope({ backendIdentity: "ssh:b", displayName: "Scope B" }),
      ],
    });
    const seeded = await h.foundation.reconcile();
    const scopes = payload(await h.foundation.scopesSnapshot(
      "correlation-scopes",
      seeded.snapshot.hostEpoch,
    )).items;
    const scopeA = scopes.find((item) => item.displayName === "Scope A");
    const scopeB = scopes.find((item) => item.displayName === "Scope B");
    const inDoubt = commandExecutor({ executeTwRpc: async () => ({ state: "in_doubt" }) });
    const plane = await openCommandPlane(h, inDoubt.executor);
    const window = await issueWindow(h, plane);
    assert.equal((await plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch,
        window.windowId,
        scopeA.scopeId,
        "cmd-cross-scope-correlation",
      ),
    )).payload.state, "in_doubt");
    const reservation = structuredClone(
      materializedRoot(await h.store.read()).capacityReservations[0],
    );
    const correlation = {
      schemaVersion: 1,
      reservationId: reservation.reservationId,
      hostEpoch: reservation.hostEpoch,
      principalId: reservation.principalId,
      hostId: reservation.hostId,
      commandId: reservation.commandId,
      requestFingerprint: structuredClone(reservation.requestFingerprint),
    };
    const before = await h.store.read();
    h.discovery.push({
      coverage: "complete",
      scopes: [
        scope({ backendIdentity: "local:a", displayName: "Scope A", kind: "local", sessions: [] }),
        scope({
          backendIdentity: "ssh:b",
          displayName: "Scope B",
          sessions: [{
            ...terminal("incarnation:wrong-scope", "wrong-scope"),
            reservationCorrelation: correlation,
          }],
        }),
      ],
    });
    await assert.rejects(
      h.foundation.reconcile(),
      assertMaterializedError("INTERNAL"),
    );
    const wrongScopeFenced = await h.store.read();
    assert.equal(
      wrongScopeFenced.materializedReadinessFence.reason,
      "materialized_authority_conflict",
    );
    assert.deepEqual(wrongScopeFenced.materialized, before.materialized);
    assert.equal(wrongScopeFenced.eventSeq, before.eventSeq);

    h.discovery.push({
      coverage: "complete",
      scopes: [
        scope({
          backendIdentity: "local:a",
          displayName: "Scope A",
          kind: "local",
          sessions: [{
            ...terminal("incarnation:duplicate-a", "duplicate-a"),
            reservationCorrelation: correlation,
          }],
        }),
        scope({
          backendIdentity: "ssh:b",
          displayName: "Scope B",
          sessions: [{
            ...terminal("incarnation:duplicate-b", "duplicate-b"),
            reservationCorrelation: correlation,
          }],
        }),
      ],
    });
    await assert.rejects(h.foundation.reconcile(), assertMaterializedError("INTERNAL"));
    assert.deepEqual(await h.store.read(), wrongScopeFenced);

    const correct = terminal("incarnation:correct-scope", reservation.plannedSession.displayName);
    h.discovery.push({
      coverage: "complete",
      scopes: [
        scope({
          backendIdentity: "local:a",
          displayName: "Scope A",
          kind: "local",
          sessions: [{ ...correct, reservationCorrelation: correlation }],
        }),
        scope({ backendIdentity: "ssh:b", displayName: "Scope B", sessions: [] }),
      ],
    });
    await h.foundation.reconcile();
    const finalRoot = materializedRoot(await h.store.read());
    assert.equal(finalRoot.capacityReservations.length, 0);
    assert.equal(payload(await h.foundation.sessionsSnapshot(
      "correct-correlation-scope",
      seeded.snapshot.hostEpoch,
      [scopeA.scopeId, scopeB.scopeId],
    )).scopes.find((item) => item.scopeId === scopeA.scopeId).items[0].sessionId,
    reservation.reservedSessionId);

    const beforeUnknown = await h.store.read();
    h.discovery.push({
      coverage: "complete",
      scopes: [
        scope({
          backendIdentity: "local:a",
          displayName: "Scope A",
          kind: "local",
          sessions: [{
            ...terminal("incarnation:unknown-correlation", "unknown"),
            reservationCorrelation: {
              ...correlation,
              reservationId: "res_00000000000000000000000000000000",
            },
          }],
        }),
        scope({ backendIdentity: "ssh:b", displayName: "Scope B", sessions: [] }),
      ],
    });
    await assert.rejects(
      h.foundation.reconcile(),
      assertMaterializedError("INTERNAL"),
    );
    const unknownFenced = await h.store.read();
    assert.equal(
      unknownFenced.materializedReadinessFence.reason,
      "materialized_authority_conflict",
    );
    assert.deepEqual(unknownFenced.materialized, beforeUnknown.materialized);
  } finally {
    h.cleanup();
  }
});

test("H2 INVALID_ARGUMENT reservation rejection remains non-retryable through H1", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const fake = commandExecutor({
      resolve: async (request) => ({
        kind: "executable",
        adapterState: { executionTarget: "invalid-plan" },
        resolutionFence: {
          schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
          outcome: "positive",
          authority: request.authority,
          operation: request.operation,
          expectedScopeId: request.scopeId,
          expectedSessionId: request.sessionId,
          target: { testTarget: request.scopeId },
          evidence: { testResolver: "invalid-resource-plan" },
        },
        resourceReservationPlan: null,
      }),
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const response = await plane.execute(
      commandAuth("principal-invalid-plan"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch,
        window.windowId,
        scopeId,
        "cmd-invalid-reservation-plan",
      ),
    );
    assert.equal(response.type, "error");
    assert.equal(response.error.code, "INVALID_ARGUMENT");
    assert.equal(response.error.retryable, false);
    assert.equal(response.error.commandDisposition, "not_accepted");
    assert.equal(fake.calls.execute.length, 0);
    assert.equal(Object.values((await h.store.read()).commands).some((record) => (
      record.commandId === "cmd-invalid-reservation-plan"
    )), false);
  } finally {
    h.cleanup();
  }
});

test("conservative reservation rejects an oversized plan before executor side effects", async () => {
  const h = await harness({ reservationLimits: { maxSessionCanonicalBytes: 512 } });
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const fake = commandExecutor({
      resolve: async (request) => ({
        kind: "executable",
        adapterState: {},
        resourceReservationPlan: {
          logicalTarget: { terminalLabel: request.arguments.label },
          session: commandSession(request.arguments.label, { cwd: `/${"x".repeat(1_000)}` }),
        },
      }),
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const before = await h.store.read();
    const response = await plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-plan-bound",
      ),
    );
    assert.equal(response.type, "error");
    assert.equal(response.error.commandDisposition, "not_accepted");
    assert.equal(fake.calls.execute.length, 0);
    const after = await h.store.read();
    assert.deepEqual(after.commands, before.commands);
    assert.equal(materializedRoot(after).capacityReservations.length, 0);
  } finally {
    h.cleanup();
  }
});

test("a canonical no-side-effect FAILED terminal transaction releases its H2 reservation", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const fake = commandExecutor({
      executeTwRpc: async () => ({
        state: "failed",
        sideEffect: "not_applied",
        error: {
          code: "COMMAND_FAILED",
          message: "canonical create rejected before mutation",
          retryable: false,
          commandDisposition: "completed",
          details: null,
        },
      }),
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    const response = await plane.execute(
      commandAuth(),
      createTerminalFrame(
        seeded.snapshot.hostEpoch, window.windowId, scopeId, "cmd-proven-failed",
      ),
    );
    assert.equal(response.payload.state, "failed");
    assert.equal(response.error.code, "COMMAND_FAILED");
    assert.equal(materializedRoot(await h.store.read()).capacityReservations.length, 0);
  } finally {
    h.cleanup();
  }
});

test("linearized welcome is codec-valid, bound to the captured cut, and followed by W+1", async () => {
  const h = await harness();
  try {
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:local", "shell")],
      })],
    });
    const seeded = await h.foundation.reconcile();

    await assert.rejects(
      h.foundation.linearizeWelcome(
        "invalid-welcome",
        { enqueue: () => true },
        (cut) => buildWelcome(cut, (frame) => { frame.payload.eventSeq = "0"; }),
      ),
      assertMaterializedError("INVALID_ARGUMENT"),
    );

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:local", "shell", 1_783_700_000_100)],
      })],
    });
    const delivered = [];
    let concurrentCommit;
    const welcome = await h.foundation.linearizeWelcome(
      "valid-welcome",
      {
        enqueue(item) {
          delivered.push(structuredClone(item));
          if (item.type === "host.welcome") concurrentCommit = h.foundation.reconcile();
          return true;
        },
      },
      buildWelcome,
    );
    const committed = await concurrentCommit;
    const decoded = codec.decodeRelayV2WebSocketFrame(
      "public",
      Buffer.from(JSON.stringify(welcome), "utf8"),
    );
    assert.equal(decoded.normalized.type, "host.welcome");
    assert.equal(welcome.payload.eventSeq, seeded.snapshot.eventSeq);
    assert.deepEqual(delivered.map((item) => item.type), ["host.welcome", "sessions.changed"]);
    assert.equal(BigInt(delivered[1].eventSeq), BigInt(welcome.payload.eventSeq) + 1n);
    assert.equal(committed.events[0].eventSeq, delivered[1].eventSeq);
  } finally {
    h.cleanup();
  }
});

test("snapshot candidate is owner-issued at W and its provisional queue closes the W+1 gap", async () => {
  const h = await harness();
  try {
    const { seeded } = await seedLocalScope(h, { withSession: true });
    const source = h.foundation.snapshotCutSource;
    const lease = await source.captureCandidate(seeded.snapshot.hostEpoch);
    const captured = source.inspectCandidate(lease);

    assert.equal(typeof lease, "function");
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(JSON.stringify(lease), undefined);
    assert.throws(() => structuredClone(lease));
    assert.equal(captured.hostId, "mac-admin");
    assert.equal(captured.hostEpoch, seeded.snapshot.hostEpoch);
    assert.equal(captured.hostInstanceId, h.store.hostInstanceId);
    assert.equal(captured.cut.throughEventSeq, seeded.snapshot.eventSeq);
    assert.equal(captured.cutRecordCount, captured.cut.records.length);
    assert.equal(
      captured.cutCanonicalBytes,
      Buffer.byteLength(resourceState.canonicalizeRelayV2MaterializedJson(captured.cut.records)),
    );

    const forgedFunction = () => undefined;
    Object.setPrototypeOf(forgedFunction, Object.getPrototypeOf(lease));
    await assert.rejects(
      source.withCandidateFence(forgedFunction, () => undefined),
      assertMaterializedError("INVALID_ARGUMENT"),
    );
    assert.throws(
      () => source.inspectCandidate(Object.create(Object.getPrototypeOf(lease))),
      assertMaterializedError("INVALID_ARGUMENT"),
    );

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:next", "next")],
      })],
    });
    const committed = await h.foundation.reconcile();
    assert.ok(BigInt(committed.snapshot.eventSeq) > BigInt(captured.cut.throughEventSeq));
    const fenced = await source.withCandidateFence(lease, (candidate) => candidate);
    assert.equal(fenced.materializedCutIdentity, captured.materializedCutIdentity);
    assert.equal(fenced.subscriptionQueueGeneration, captured.subscriptionQueueGeneration);

    const restartedOwner = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: h.store,
      readinessSink: new ReadinessSink(),
    });
    assert.throws(
      () => restartedOwner.snapshotCutSource.inspectCandidate(lease),
      assertMaterializedError("INVALID_ARGUMENT"),
    );

    source.releaseCandidate(lease);
    await assert.rejects(
      source.withCandidateFence(lease, () => undefined),
      assertMaterializedError("INVALID_ARGUMENT"),
    );
    assert.equal(h.foundation.snapshotAuthorityBundle, undefined);
    assert.equal(source.linearizeWelcome, undefined);
    assert.equal(source.scopesSnapshot, undefined);
    assert.equal(source.sessionsSnapshot, undefined);
    const spool = await h.foundation.openStateSnapshotSpool({
      hostId: "mac-admin",
      root: join(h.home, "bound-snapshot-spool"),
      ownerInstanceId: h.store.hostInstanceId,
    });
    assert.equal(spool.issueReadinessReceipt, undefined);
    assert.equal(spool.verifyReadinessReceipt, undefined);
    assert.equal(spool.activateReadinessReceipt, undefined);
    assert.equal(spool.releaseReadinessActivation, undefined);
    await spool.close();
  } finally {
    h.cleanup();
  }
});

test("snapshot candidate hands buffered W+1 and future events to one exact sink without a gap", async () => {
  const h = await harness();
  try {
    const { seeded } = await seedLocalScope(h, { withSession: true });
    const source = h.foundation.snapshotCutSource;
    const candidate = await source.captureCandidate(seeded.snapshot.hostEpoch);
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [
          terminal("pane:seeded", "seeded"),
          terminal("pane:buffered", "buffered"),
        ],
      })],
    });
    const bufferedCommit = await h.foundation.reconcile();
    const delivered = [];
    const closed = [];
    const phases = [];
    const activation = await source.activateCandidate(
      candidate,
      {
        enqueue(event) { delivered.push(structuredClone(event)); return true; },
        close(error) { closed.push(error); },
      },
      (cut) => { phases.push(["before", cut.cut.throughEventSeq]); return true; },
      (cut, exactActivation) => {
        phases.push(["after", cut.subscriptionQueueGeneration]);
        assert.equal(typeof exactActivation, "function");
        return true;
      },
    );
    assert.deepEqual(
      delivered.map((event) => event.eventSeq),
      bufferedCommit.events.map((event) => event.eventSeq),
    );
    assert.deepEqual(phases.map(([phase]) => phase), ["before", "after"]);
    await assert.rejects(
      source.withCandidateFence(candidate, () => undefined),
      assertMaterializedError("INVALID_ARGUMENT"),
    );

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local live",
        kind: "local",
        sessions: [terminal("pane:live", "live")],
      })],
    });
    const liveCommit = await h.foundation.reconcile();
    assert.deepEqual(
      delivered.slice(bufferedCommit.events.length).map((event) => event.eventSeq),
      liveCommit.events.map((event) => event.eventSeq),
    );

    const forged = () => undefined;
    Object.setPrototypeOf(forged, Object.getPrototypeOf(activation));
    source.releaseCandidateActivation(forged);
    assert.equal(closed.length, 0);
    source.releaseCandidateActivation(activation);
    source.releaseCandidateActivation(activation);
    assert.equal(closed.length, 1);
  } finally {
    h.cleanup();
  }
});

test("snapshot activation rejection rolls back the exact sink and consumes failed authority", async (t) => {
  for (const failure of [
    "owner_before_drain",
    "enqueue_false",
    "enqueue_throw",
    "owner_after_attach",
  ]) {
    await t.test(failure, async () => {
      const h = await harness();
      try {
        const { seeded } = await seedLocalScope(h, { withSession: true });
        const source = h.foundation.snapshotCutSource;
        const candidate = await source.captureCandidate(seeded.snapshot.hostEpoch);
        h.discovery.push({
          coverage: "complete",
          scopes: [scope({
            backendIdentity: "local",
            displayName: "Changed",
            kind: "local",
            sessions: [terminal(`pane:${failure}`, failure)],
          })],
        });
        await h.foundation.reconcile();
        const delivered = [];
        const closed = [];
        await assert.rejects(
          source.activateCandidate(
            candidate,
            {
              enqueue(event) {
                delivered.push(event.eventSeq);
                if (failure === "enqueue_throw") throw new Error("injected enqueue failure");
                return failure !== "enqueue_false";
              },
              close(error) { closed.push(error); },
            },
            () => {
              if (failure === "owner_before_drain") {
                throw new Error("injected owner pre-drain failure");
              }
              return true;
            },
            () => {
              if (failure === "owner_after_attach") {
                throw new Error("injected owner recheck failure");
              }
              return true;
            },
          ),
          failure === "owner_before_drain"
            ? /injected owner pre-drain failure/
            : failure === "owner_after_attach"
              ? /injected owner recheck failure/
              : assertMaterializedError("BUSY"),
        );
        assert.equal(closed.length, 1);
        if (failure === "owner_before_drain") {
          assert.equal(delivered.length, 0, "pre-drain failure delivered a buffered event");
        }
        await assert.rejects(
          source.withCandidateFence(candidate, () => undefined),
          assertMaterializedError("INVALID_ARGUMENT"),
        );
        const deliveredAtFailure = delivered.length;
        h.discovery.push({ coverage: "complete", scopes: [] });
        await h.foundation.reconcile();
        assert.equal(delivered.length, deliveredAtFailure, "failed activation left a live subscriber");
      } finally {
        h.cleanup();
      }
    });
  }
});

test("snapshot candidate install, buffer, count, bytes, TTL, and readiness fences fail closed", async () => {
  let failInstall = true;
  const h = await harness({
    snapshotCandidateLimits: {
      maxCandidates: 1,
      maxBufferedEventsPerCandidate: 1,
      candidateTtlMs: 10,
    },
    testHooks: {
      afterSnapshotCandidateSubscriptionInstall() {
        if (failInstall) {
          failInstall = false;
          throw new Error("injected provisional subscription install failure");
        }
      },
    },
  });
  try {
    const { seeded } = await seedLocalScope(h);
    const source = h.foundation.snapshotCutSource;
    await assert.rejects(
      source.captureCandidate(seeded.snapshot.hostEpoch),
      /injected provisional subscription install failure/,
    );
    const lease = await source.captureCandidate(seeded.snapshot.hostEpoch);
    await assert.rejects(
      source.captureCandidate(seeded.snapshot.hostEpoch),
      assertMaterializedError("BUSY"),
    );

    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local updated",
        kind: "local",
        sessions: [terminal("pane:overflow", "overflow")],
      })],
    });
    await h.foundation.reconcile();
    await assert.rejects(
      source.withCandidateFence(lease, () => undefined),
      assertMaterializedError("INVALID_ARGUMENT"),
    );

    const ttlLease = await source.captureCandidate(seeded.snapshot.hostEpoch);
    h.setNow(h.now() + 10);
    await assert.rejects(
      source.withCandidateFence(ttlLease, () => undefined),
      assertMaterializedError("INVALID_ARGUMENT"),
    );

    h.setNow(h.now() + 1);
    const uncertainLease = await source.captureCandidate(seeded.snapshot.hostEpoch);
    h.foundation.commandResourceMutationOwner.fenceCommitUncertain(await h.store.read());
    await assert.rejects(
      source.withCandidateFence(uncertainLease, () => undefined),
      assertMaterializedError("INVALID_ARGUMENT"),
    );
  } finally {
    h.cleanup();
  }

  const byteBound = await harness({
    snapshotCandidateLimits: { maxCandidates: 2, maxRetainedBytes: 2 },
  });
  try {
    byteBound.discovery.push({ coverage: "complete", scopes: [] });
    const seeded = await byteBound.foundation.reconcile();
    const first = await byteBound.foundation.snapshotCutSource.captureCandidate(
      seeded.snapshot.hostEpoch,
    );
    await assert.rejects(
      byteBound.foundation.snapshotCutSource.captureCandidate(seeded.snapshot.hostEpoch),
      assertMaterializedError("BUSY"),
    );
    byteBound.foundation.snapshotCutSource.releaseCandidate(first);
    const afterRelease = await byteBound.foundation.snapshotCutSource.captureCandidate(
      seeded.snapshot.hostEpoch,
    );
    byteBound.foundation.snapshotCutSource.releaseCandidate(afterRelease);
  } finally {
    byteBound.cleanup();
  }
});

test("commit-uncertain fences old subscribers and the next welcome captures the committed W", async () => {
  const h = await harness();
  try {
    h.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:local", "shell")],
      })],
    });
    const seeded = await h.foundation.reconcile();

    let failWitnessRename = true;
    const failingStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (failWitnessRename && destination === h.paths.continuity) {
          failWitnessRename = false;
          throw new Error("injected witness publication failure");
        }
        renameSync(source, destination);
      },
    });
    const discovery = new QueueDiscovery();
    const readinessSink = new ReadinessSink();
    const foundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store: failingStore,
      readinessSink,
    });
    const delivered = [];
    const closed = [];
    await foundation.linearizeWelcome(
      "before-uncertain",
      {
        enqueue(item) { delivered.push(structuredClone(item)); return true; },
        close(error) { closed.push(error); },
      },
      buildWelcome,
    );

    discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:local", "shell", 1_783_700_000_100)],
      })],
    });
    await assert.rejects(
      foundation.reconcile(),
      (error) => error.code === "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN",
    );
    assert.deepEqual(delivered.map((item) => item.type), ["host.welcome"]);
    assert.equal(closed.length, 1);
    assert.equal(readinessSink.signals.at(-1).reason, "commit_uncertain");
    assert.equal(readinessSink.signals.at(-1).closeV2Routes, true);

    const after = [];
    const recoveredWelcome = await foundation.linearizeWelcome(
      "after-uncertain",
      { enqueue(item) { after.push(structuredClone(item)); return true; } },
      buildWelcome,
    );
    assert.equal(after.length, 1);
    assert.equal(recoveredWelcome.payload.resumeDisposition, "snapshot_required");
    assert.equal(
      BigInt(recoveredWelcome.payload.eventSeq),
      BigInt(seeded.snapshot.eventSeq) + 1n,
      "the committed-but-unacknowledged event is included in the next W",
    );
  } finally {
    h.cleanup();
  }
});

test("public H2 reads detect H0 epoch rotation and synchronously fence old subscribers", async () => {
  for (const trigger of ["readiness", "snapshot"]) {
    const h = await harness();
    try {
      h.discovery.push({
        coverage: "complete",
        scopes: [scope({
          backendIdentity: "local",
          displayName: "Local",
          kind: "local",
          sessions: [],
        })],
      });
      const seeded = await h.foundation.reconcile();
      const closed = [];
      await h.foundation.linearizeWelcome(
        `before-rotation-${trigger}`,
        {
          enqueue: () => true,
          close(error) { closed.push(error); },
        },
        buildWelcome,
      );

      rmSync(h.paths.continuity, { force: true });
      if (trigger === "readiness") {
        const result = await h.foundation.readiness();
        assert.equal(result.reason, "host_epoch_changed");
        assert.equal(result.closeV2Routes, true);
      } else {
        await assert.rejects(
          h.foundation.scopesSnapshot("after-epoch-rotation", seeded.snapshot.hostEpoch),
          assertMaterializedError("HOST_EPOCH_MISMATCH"),
        );
      }
      const rotated = await h.store.read();
      assert.notEqual(rotated.hostEpoch, seeded.snapshot.hostEpoch);
      assert.equal(closed.length, 1);
      assert.equal(closed[0].code, "HOST_EPOCH_MISMATCH");
      assert.equal(h.readinessSink.signals.at(-1).reason, "host_epoch_changed");
      assert.equal(h.readinessSink.signals.at(-1).closeV2Routes, true);
      assert.equal((await h.foundation.readiness(rotated.hostEpoch)).reason, "host_epoch_changed");
      if (trigger === "readiness") {
        h.discovery.push({
          coverage: "complete",
          scopes: [scope({
            backendIdentity: "local",
            displayName: "Local",
            kind: "local",
            sessions: [],
          })],
        });
        const rematerialized = await h.foundation.reconcile();
        assert.equal(rematerialized.readiness.reason, "host_epoch_changed");
        const welcome = await h.foundation.linearizeWelcome(
          "after-epoch-rotation",
          { enqueue: () => true },
          buildWelcome,
        );
        assert.equal(welcome.hostEpoch, rotated.hostEpoch);
        assert.equal(welcome.payload.resumeDisposition, "snapshot_required");
        assert.equal((await h.foundation.readiness(rotated.hostEpoch)).reason, "ready");
      }
    } finally {
      h.cleanup();
    }
  }
});

test("the H0 full-root budget preserves authority and latches readiness until a fresh reconcile", async () => {
  const h = await harness();
  try {
    const { seeded, scopeId } = await seedLocalScope(h);
    const backendInstanceKey = "incarnation:persisted-budget";
    const fake = commandExecutor({
      executeTwRpc: async (plan) => successfulCreate(plan, backendInstanceKey),
    });
    const plane = await openCommandPlane(h, fake.executor);
    const window = await issueWindow(h, plane);
    assert.equal((await plane.execute(
      commandAuth("principal-persisted-budget"),
      createTerminalFrame(
        seeded.snapshot.hostEpoch,
        window.windowId,
        scopeId,
        "cmd-persisted-budget",
      ),
    )).payload.state, "succeeded");

    const beforeFile = readFileSync(h.paths.state);
    const constrainedStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      testMaxPersistedBytes: beforeFile.byteLength + 1_024,
    });
    const before = await constrainedStore.read();
    const persistedScope = materializedRoot(before).scopes[0];
    const persistedSession = persistedScope.sessions[0];
    const {
      scopeId: _scopeId,
      sessionId: _sessionId,
      ...existingSession
    } = persistedSession.item;
    const discovery = new QueueDiscovery();
    const readinessSink = new ReadinessSink();
    const constrainedFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery,
      store: constrainedStore,
      readinessSink,
    });
    discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: persistedScope.backendIdentity,
        displayName: persistedScope.item.displayName,
        kind: persistedScope.item.kind,
        sessions: [
          { backendIdentity: persistedSession.backendIdentity, ...existingSession },
          {
            ...terminal("incarnation:too-large-for-persisted-root", "oversized"),
            cwd: `/${"x".repeat(4_095)}`,
          },
        ],
      })],
    });
    await assert.rejects(
      constrainedFoundation.reconcile(),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
    assert.equal(readinessSink.signals.at(-1).reason, "persisted_capacity_exceeded");
    assert.equal(readinessSink.signals.at(-1).closeV2Routes, true);
    const fenced = await constrainedStore.read();
    assert.equal(fenced.hostEpoch, before.hostEpoch);
    assert.deepEqual(fenced.commands, before.commands);
    assert.deepEqual(fenced.materialized, before.materialized);
    assert.equal(fenced.materializedReadinessFence.reason, "persisted_capacity_exceeded");
    assert.equal((await constrainedFoundation.readiness()).reason, "persisted_capacity_exceeded");
    await assert.rejects(
      constrainedFoundation.linearizeWelcome(
        "persisted-capacity-fenced",
        { enqueue: () => true },
        buildWelcome,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );

    const restartedStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      testMaxPersistedBytes: beforeFile.byteLength + 1_024,
    });
    const restarted = await restartedStore.read();
    assert.equal(restarted.hostEpoch, before.hostEpoch);
    assert.deepEqual(restarted.commands, before.commands);
    assert.deepEqual(restarted.materialized, before.materialized);
    assert.equal(restarted.materializedReadinessFence.reason, "persisted_capacity_exceeded");
    const restartedFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: restartedStore,
      readinessSink: new ReadinessSink(),
    });
    assert.equal((await restartedFoundation.readiness()).reason, "persisted_capacity_exceeded");

    discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: persistedScope.backendIdentity,
        displayName: persistedScope.item.displayName,
        kind: persistedScope.item.kind,
        sessions: [{ backendIdentity: persistedSession.backendIdentity, ...existingSession }],
      })],
    });
    const recovered = await constrainedFoundation.reconcile();
    assert.equal(recovered.snapshot.materializedReadinessFence, null);
    assert.equal(recovered.readiness.reason, "ready");
  } finally {
    h.cleanup();
  }
});

test("H1 admission and finalization root-capacity failures persist the global H2 fence", async (t) => {
  await t.test("admission rejects before side effects and closes an existing route", async () => {
    const h = await harness();
    try {
      const { seeded, scopeId } = await seedLocalScope(h);
      const bootstrap = await openCommandPlane(h, commandExecutor().executor, { recover: false });
      const window = await issueWindow(h, bootstrap);
      const beforeFile = readFileSync(h.paths.state);
      const constrainedStore = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        testMaxPersistedBytes: beforeFile.byteLength + 1_024,
      });
      const discovery = new QueueDiscovery();
      const readinessSink = new ReadinessSink();
      const foundation = new resourceState.RelayV2MaterializedStateFoundation({
        hostId: "mac-admin",
        discovery,
        store: constrainedStore,
        readinessSink,
      });
      const closed = [];
      await foundation.linearizeWelcome(
        "before-h1-admission-capacity",
        { enqueue: () => true, close(error) { closed.push(error); } },
        buildWelcome,
      );
      const fake = commandExecutor();
      const plane = await openCommandPlane(h, fake.executor, {
        store: constrainedStore,
        foundation,
        recover: false,
      });
      const response = await plane.execute(
        commandAuth("principal-admission-capacity"),
        createTerminalFrame(
          seeded.snapshot.hostEpoch,
          window.windowId,
          scopeId,
          "cmd-admission-root-capacity",
        ),
      );
      assert.equal(response.type, "error");
      assert.equal(response.error.code, "CAPABILITY_UNAVAILABLE");
      assert.equal(response.error.commandDisposition, "not_accepted");
      assert.equal(fake.calls.execute.length, 0);
      assert.equal(closed.length, 1);
      const snapshot = await constrainedStore.read();
      assert.equal(snapshot.materializedReadinessFence.reason, "persisted_capacity_exceeded");
      assert.equal(Object.values(snapshot.commands).some((record) => (
        record.commandId === "cmd-admission-root-capacity"
      )), false);
      assert.equal((await h.foundation.readiness()).reason, "persisted_capacity_exceeded");
    } finally {
      h.cleanup();
    }
  });

  await t.test("post-side-effect finalization retains an IN_DOUBT binding and closes the route", async () => {
    const h = await harness();
    try {
      const { seeded, scopeId } = await seedLocalScope(h);
      let activeStore = h.store;
      const switchingStore = {
        serialize: (operation) => activeStore.serialize(operation),
        transaction: (mutation) => activeStore.transaction(mutation),
        read: () => activeStore.read(),
      };
      const discovery = new QueueDiscovery();
      const readinessSink = new ReadinessSink();
      const foundation = new resourceState.RelayV2MaterializedStateFoundation({
        hostId: "mac-admin",
        discovery,
        store: switchingStore,
        readinessSink,
      });
      const closed = [];
      await foundation.linearizeWelcome(
        "before-h1-finalization-capacity",
        { enqueue: () => true, close(error) { closed.push(error); } },
        buildWelcome,
      );
      let executionStarted;
      let releaseExecution;
      const started = new Promise((resolve) => { executionStarted = resolve; });
      const release = new Promise((resolve) => { releaseExecution = resolve; });
      const backendInstanceKey = "incarnation:finalization-root-capacity";
      const fake = commandExecutor({
        executeTwRpc: async (plan) => {
          executionStarted();
          await release;
          return successfulCreate(plan, backendInstanceKey, {
            cwd: `/${"f".repeat(4_095)}`,
          });
        },
      });
      const plane = await openCommandPlane(h, fake.executor, {
        store: switchingStore,
        foundation,
        recover: false,
      });
      const window = await issueWindow(h, plane);
      const pending = plane.execute(
        commandAuth("principal-finalization-capacity"),
        createTerminalFrame(
          seeded.snapshot.hostEpoch,
          window.windowId,
          scopeId,
          "cmd-finalization-root-capacity",
        ),
      );
      await started;
      const runningBytes = readFileSync(h.paths.state).byteLength;
      activeStore = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        testMaxPersistedBytes: runningBytes + 1_536,
      });
      releaseExecution();
      const response = await pending;
      assert.equal(response.payload.state, "in_doubt");
      assert.equal(closed.length, 1);
      const snapshot = await activeStore.read();
      assert.equal(snapshot.materializedReadinessFence.reason, "persisted_capacity_exceeded");
      const reservation = materializedRoot(snapshot).capacityReservations[0];
      assert.equal(reservation.uncertain, true);
      assert.equal(reservation.boundBackendIdentity, backendInstanceKey);
      assert.equal((await foundation.readiness()).reason, "persisted_capacity_exceeded");
    } finally {
      h.cleanup();
    }
  });
});

test("capacity and incomplete online authority synchronously withdraw readiness and close routes", async () => {
  const constrained = await harness({ capacityLimits: { maxSnapshotRecords: 2 } });
  try {
    constrained.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "local",
        displayName: "Local",
        kind: "local",
        sessions: [terminal("pane:local", "shell")],
      })],
    });
    const overCapacity = await constrained.foundation.reconcile();
    assert.equal(overCapacity.readiness.snapshotMaterializationReady, false);
    assert.equal(overCapacity.readiness.reason, "capacity_exceeded");
    assert.equal(overCapacity.readiness.closeV2Routes, true);
    assert.equal(constrained.readinessSink.signals.at(-1).reason, "capacity_exceeded");
    assert.equal(
      payload(await constrained.foundation.sessionsSnapshot(
        "capacity-observation",
        overCapacity.snapshot.hostEpoch,
        null,
      )).scopes[0].items.length,
      1,
      "external truth remains materialized even while capability readiness is withdrawn",
    );
    await assert.rejects(
      constrained.foundation.linearizeWelcome(
        "capacity-welcome",
        { enqueue: () => true },
        buildWelcome,
      ),
      assertMaterializedError("CAPABILITY_UNAVAILABLE"),
    );
  } finally {
    constrained.cleanup();
  }

  assert.throws(
    () => new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: {},
      readinessSink: new ReadinessSink(),
      testCapacityLimits: {
        maxSnapshotRecords: resourceState.RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords + 1,
      },
    }),
    /cannot be widened/,
  );

  const partial = await harness();
  try {
    partial.discovery.push({
      coverage: "complete",
      scopes: [scope({
        backendIdentity: "ssh:devbox",
        displayName: "Devbox",
        sessions: [terminal("pane:remote", "shell")],
      })],
    });
    await partial.foundation.reconcile();
    const closed = [];
    await partial.foundation.linearizeWelcome(
      "online-partial-route",
      {
        enqueue: () => true,
        close(error) { closed.push(error); },
      },
      buildWelcome,
    );
    partial.discovery.push({
      coverage: "complete",
      scopes: [partialScope({
        backendIdentity: "ssh:devbox",
        displayName: "Devbox",
        reachability: "online",
      })],
    });
    const onlinePartial = await partial.foundation.reconcile();
    assert.equal(onlinePartial.readiness.reason, "partial_online_scope");
    assert.equal(closed.length, 1);

    partial.discovery.push({
      coverage: "complete",
      scopes: [partialScope({
        backendIdentity: "ssh:devbox",
        displayName: "Devbox",
        reachability: "unreachable",
      })],
    });
    const unreachable = await partial.foundation.reconcile();
    assert.equal(unreachable.readiness.snapshotMaterializationReady, true);
    const unreachableCut = payload(await partial.foundation.sessionsSnapshot(
      "unreachable-last-known",
      unreachable.snapshot.hostEpoch,
      null,
    ));
    assert.equal(unreachableCut.coverageComplete, true);
    assert.equal(unreachableCut.scopes[0].completeness, "complete");
    assert.equal(unreachableCut.scopes[0].error, null);
    assert.equal(unreachableCut.scopes[0].items.length, 1);
  } finally {
    partial.cleanup();
  }

  const neverComplete = await harness();
  try {
    neverComplete.discovery.push({
      coverage: "complete",
      scopes: [partialScope({
        backendIdentity: "ssh:new",
        displayName: "Never reached",
      })],
    });
    const result = await neverComplete.foundation.reconcile();
    assert.equal(result.readiness.reason, "scope_without_complete_authority");
    assert.equal(result.readiness.snapshotMaterializationReady, false);
  } finally {
    neverComplete.cleanup();
  }
});
