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
const relayV2Corpus = loadRelayV2FixtureCorpus();

const handshakeFixture = JSON.parse(readFileSync(
  new URL("../contracts/relay/v2/golden-public-handshake.json", import.meta.url),
  "utf8",
));
const welcomeTemplate = handshakeFixture.find((item) => (
  item.name === "host-welcome-snapshot-required"
)).frame;

class QueueDiscovery {
  #scans = [];

  push(scan) {
    this.#scans.push(structuredClone(scan));
  }

  pushDeferred(scan, onStart) {
    this.#scans.push({ deferredScan: scan, onStart });
  }

  async scan() {
    const scan = this.#scans.shift();
    if (!scan) throw new Error("test discovery has no queued scan");
    if (scan.deferredScan) {
      scan.onStart?.();
      return structuredClone(await scan.deferredScan);
    }
    return structuredClone(scan);
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
  const calls = { resolve: [], execute: [] };
  return {
    calls,
    executor: {
      async resolve(request) {
        calls.resolve.push(structuredClone(request));
        if (overrides.resolve) return overrides.resolve(request);
        const displayName = request.arguments.label ?? "terminal";
        return {
          kind: "executable",
          adapterState: {
            executionTarget: { scopeId: request.scopeId },
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

async function seedLocalScope(h) {
  h.discovery.push({
    coverage: "complete",
    scopes: [scope({ backendIdentity: "local", displayName: "Local", kind: "local" })],
  });
  const seeded = await h.foundation.reconcile();
  const scopeId = payload(
    await h.foundation.scopesSnapshot("joint-scope", seeded.snapshot.hostEpoch),
  ).items[0].scopeId;
  return { seeded, scopeId };
}

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
    const { seeded, scopeId } = await seedLocalScope(h);
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
      resolve: async () => ({
        kind: "executable",
        adapterState: { executionTarget: "invalid-plan" },
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
