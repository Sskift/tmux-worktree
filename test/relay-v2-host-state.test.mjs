import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const hostState = await import("../dist/relay/v2/hostState.js");
const canonicalBackendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");
const terminalLineage = await import("../dist/relay/v2/terminalDurableLineage.js");

const TERMINAL_TARGET = {
  hostId: "mac-admin",
  scopeId: "scope-local",
  sessionId: "ses_01JOPAQUE",
};
const TOKEN_HASH_ONE = "1".repeat(64);
const TOKEN_HASH_TWO = "2".repeat(64);
const EMPTY_RETAINED_AUTHORITY_DIGEST =
  "efecf7d026a4a0aae2adaf877573c868b79ded287d83ccca4a9a1d429020ccae";
const TERMINAL_INCARNATION = `twinc2.${"b".repeat(43)}`;
const TERMINAL_PROCESS_TARGET = { kind: "local", targetId: "host-state-local" };
const TERMINAL_BACKEND_INSTANCE_KEY =
  canonicalBackendIdentity.issueRelayV2CanonicalBackendInstanceKey({
    processTarget: TERMINAL_PROCESS_TARGET,
    incarnation: TERMINAL_INCARNATION,
  });

function canonicalBinding(target = TERMINAL_TARGET, pane = 0, overrides = {}) {
  return {
    schemaVersion: 1,
    ...target,
    pane,
    processTarget: { ...TERMINAL_PROCESS_TARGET },
    backendInstanceKey: TERMINAL_BACKEND_INSTANCE_KEY,
    managedTarget: {
      name: "host-state-managed-terminal",
      kind: "terminal",
      incarnation: TERMINAL_INCARNATION,
    },
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: "host-state-control-target",
      controlEpoch: "host-state-control-epoch",
      targetIncarnationProof: "host-state-target-incarnation-proof",
    },
    ...overrides,
  };
}

function terminalResolution(target = TERMINAL_TARGET, pane = 0, binding = canonicalBinding(target, pane)) {
  return {
    target: {
      ...target,
      pane,
      canonicalTargetId: binding.backendInstanceKey,
      controlTargetId: binding.exactControlIdentity.controlTargetId,
    },
    binding,
    admission: {
      resourceToken: {
        schemaVersion: 1,
        hostEpoch: "authority-epoch-placeholder",
        resourceMappingDigest: "host-state-resource-digest",
        discoveryGeneration: "host-state-discovery-generation",
      },
      resourceTarget: {
        authorization: "evidence_only",
        hostEpoch: "authority-epoch-placeholder",
        discoveryGeneration: "host-state-discovery-generation",
        scopeId: target.scopeId,
        processTarget: { ...binding.processTarget },
        capabilities: ["terminal.stream.v1"],
        sessionId: target.sessionId,
        backendInstanceKey: binding.backendInstanceKey,
        managedTarget: { ...binding.managedTarget },
      },
      exactControlToken: "host-state-exact-control-token",
    },
  };
}

const NOOP_ADMISSION_FENCE = {
  fenceSessionForAdmission() {},
};

function terminalOpenClaim(overrides = {}) {
  return {
    key: "terminal-open:one",
    streamKey: "terminal-stream:one",
    fingerprint: "a".repeat(64),
    hostInstanceId: "host-process-one",
    target: { ...TERMINAL_TARGET },
    pane: 0,
    resumeTokenHash: null,
    mode: "new",
    previousGeneration: null,
    requestedOffset: null,
    expiresAtMs: 1_600_000,
    ...overrides,
  };
}

function terminalAuthority(store, options = {}) {
  let issued = 0;
  return new terminalLineage.RelayV2TerminalDurableLineageAuthority({
    store,
    now: () => 1_000_000,
    issueAuthorityId: (kind) => `${kind}-${store.hostInstanceId}-${++issued}`,
    admissionFence: NOOP_ADMISSION_FENCE,
    ...options,
  });
}

function terminalState(snapshot) {
  const matches = Object.values(snapshot.materialized).filter((value) => (
    value?.authority === "relay_v2_terminal_durable_lineage"
  ));
  assert.equal(matches.length, 1);
  return matches[0];
}

async function commitTerminalOpen(
  authority,
  claim = terminalOpenClaim({ hostInstanceId: authority.hostInstanceId }),
  outcome,
) {
  const winner = await authority.claimOpen(claim);
  assert.equal(winner.status, "claimed");
  const prepared = await authority.prepareOpen({
    key: claim.key,
    fingerprint: claim.fingerprint,
    hostInstanceId: claim.hostInstanceId,
    claimToken: winner.claimToken,
    fence: winner.fence,
    preparation: claim.mode === "resume"
      ? { kind: "retained", binding: winner.streamAuthority.canonicalBinding }
      : { kind: "current", resolution: terminalResolution(claim.target, claim.pane) },
  });
  assert.equal(prepared.status, "prepared");
  const proposed = {
    kind: "opened",
    generation: winner.issuedGeneration,
    resumeTokenHash: TOKEN_HASH_ONE,
    disposition: claim.mode === "new" ? "new" : "reset",
    replayFromOffset: "0",
    ...outcome,
    generation: winner.issuedGeneration,
  };
  const committed = await authority.completeOpen({
    key: claim.key,
    fingerprint: claim.fingerprint,
    hostInstanceId: claim.hostInstanceId,
    claimToken: winner.claimToken,
    fence: winner.fence,
    outcome: proposed,
  });
  assert.equal(committed.status, "committed");
  return { winner, committed, generation: winner.issuedGeneration };
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-host-state-"));
  const paths = hostState.relayV2HostStatePaths(home);
  return {
    home,
    paths,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

async function seed(paths) {
  const store = await hostState.RelayV2HostStateStore.open({ paths });
  const initial = await store.read();
  await store.transaction((transaction) => {
    const revision = transaction.allocateRevision("sessions:scope-local");
    const eventSeq = transaction.allocateEventSeq();
    transaction.putCommandRecord("command:seed", { state: "succeeded", eventSeq });
    transaction.putMaterializedRecord("session:seed", { revision, displayName: "seed" });
  });
  return { store, initial, committed: await store.read() };
}

test("Relay v2 host lineage survives restart while process identity and file modes do not leak across lifetimes", async () => {
  const h = harness();
  try {
    const first = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const before = await first.read();
    const committed = await first.transaction((transaction) => {
      const revision = transaction.allocateRevision("scopes");
      const eventSeq = transaction.allocateEventSeq();
      const scopeId = transaction.issueOpaqueId("scope");
      transaction.putMaterializedRecord(`scope:${scopeId}`, { scopeId, revision });
      return { revision, eventSeq, scopeId };
    });

    assert.deepEqual(committed.value, {
      revision: "1",
      eventSeq: "1",
      scopeId: committed.value.scopeId,
    });
    assert.match(committed.value.scopeId, /^scope_[0-9a-f]{32}$/);
    assert.equal(committed.snapshot.hostEpoch, before.hostEpoch);
    assert.equal(committed.snapshot.hostInstanceId, before.hostInstanceId);

    const restarted = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const after = await restarted.read();
    assert.equal(after.hostEpoch, before.hostEpoch);
    assert.notEqual(after.hostInstanceId, before.hostInstanceId);
    assert.equal(after.eventSeq, "1");
    assert.equal(after.revisions.scopes, "1");

    assert.equal(statSync(h.paths.state).mode & 0o777, 0o600);
    assert.equal(statSync(h.paths.continuity).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(h.paths.state)).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(h.paths.continuity)).mode & 0o777, 0o700);

    const persisted = JSON.parse(readFileSync(h.paths.state, "utf8"));
    assert.equal(Object.hasOwn(persisted, "hostInstanceId"), false);
    assert.deepEqual(Object.keys(persisted).sort(), [
      "checksum",
      "commands",
      "commitId",
      "commitSeq",
      "eventSeq",
      "hostEpoch",
      "materialized",
      "materializedReadinessFence",
      "parentCommitId",
      "revisions",
      "version",
    ]);
  } finally {
    h.cleanup();
  }
});

test("loss, corruption, rollback, and partial recovery never reuse the previous host lineage", async (t) => {
  const cases = [
    {
      name: "complete database loss",
      damage: async ({ paths }) => {
        rmSync(paths.state, { force: true });
        rmSync(paths.continuity, { force: true });
      },
    },
    {
      name: "database loss with surviving witness",
      damage: async ({ paths }) => rmSync(paths.state, { force: true }),
    },
    {
      name: "corrupt database",
      damage: async ({ paths }) => writeFileSync(paths.state, "{not-json\n", { mode: 0o600 }),
    },
    {
      name: "partial restore without witness",
      damage: async ({ paths }) => rmSync(paths.continuity, { force: true }),
    },
    {
      name: "rollback to an older valid database commit",
      damage: async ({ paths, store }) => {
        const older = `${paths.state}.older`;
        copyFileSync(paths.state, older);
        await store.transaction((transaction) => {
          transaction.allocateRevision("sessions:scope-local");
          transaction.allocateEventSeq();
          transaction.putCommandRecord("command:newer", { state: "succeeded" });
        });
        copyFileSync(older, paths.state);
        rmSync(older, { force: true });
      },
    },
    {
      name: "partial schema restore",
      damage: async ({ paths }) => {
        const parsed = JSON.parse(readFileSync(paths.state, "utf8"));
        delete parsed.materialized;
        writeFileSync(paths.state, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = harness();
      try {
        const seeded = await seed(h.paths);
        await scenario.damage({ ...h, store: seeded.store });
        const recovered = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
        const snapshot = await recovered.read();
        assert.notEqual(snapshot.hostEpoch, seeded.initial.hostEpoch);
        assert.equal(snapshot.commitSeq, "0");
        assert.equal(snapshot.eventSeq, "0");
        assert.deepEqual({ ...snapshot.revisions }, {});
        assert.deepEqual({ ...snapshot.commands }, {});
        assert.deepEqual({ ...snapshot.materialized }, {});
      } finally {
        h.cleanup();
      }
    });
  }
});

test("serialized concurrent transactions allocate unique canonical revisions, events, and opaque IDs", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const competingStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    assert.notEqual(competingStore.hostInstanceId, store.hostInstanceId);
    let releaseBarrier;
    let barrierEntered;
    const entered = new Promise((resolve) => { barrierEntered = resolve; });
    const release = new Promise((resolve) => { releaseBarrier = resolve; });
    const barrier = store.serialize(async (section) => {
      const captured = section.read().eventSeq;
      barrierEntered();
      await release;
      return captured;
    });
    await entered;

    let completed = 0;
    const pending = Array.from({ length: 40 }, (_, index) => (
      index % 2 === 0 ? store : competingStore
    ).transaction((transaction) => {
      const revision = transaction.allocateRevision("sessions:scope-local");
      const eventSeq = transaction.allocateEventSeq();
      const sessionId = transaction.issueOpaqueId("ses");
      transaction.putMaterializedRecord(`session:${sessionId}`, { index, revision, eventSeq });
      transaction.putCommandRecord(`command:${index}`, { state: "succeeded", sessionId });
      return { revision, eventSeq, sessionId };
    }).finally(() => { completed += 1; }));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, 0, "transactions must remain behind the state/event serializer barrier");
    releaseBarrier();
    assert.equal(await barrier, "0");

    const commits = await Promise.all(pending);
    const revisions = commits.map(({ value }) => value.revision);
    const events = commits.map(({ value }) => value.eventSeq);
    const ids = commits.map(({ value }) => value.sessionId);
    const expectedCounters = Array.from({ length: 40 }, (_, index) => String(index + 1));
    const counterOrder = (left, right) => Number(BigInt(left) - BigInt(right));
    assert.deepEqual([...revisions].sort(counterOrder), expectedCounters);
    assert.deepEqual([...events].sort(counterOrder), expectedCounters);
    assert.equal(new Set(ids).size, 40);
    assert.ok(ids.every((id) => /^ses_[0-9a-f]{32}$/.test(id)));

    const snapshot = await store.read();
    assert.equal(snapshot.commitSeq, "40");
    assert.equal(snapshot.eventSeq, "40");
    assert.equal(snapshot.revisions["sessions:scope-local"], "40");
    assert.equal(Object.keys(snapshot.commands).length, 40);
    assert.equal(Object.keys(snapshot.materialized).length, 40);
  } finally {
    h.cleanup();
  }
});

test("the exact full-root persisted budget rejects before rename and remains restart-readable", async () => {
  const h = harness();
  try {
    const bootstrap = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    await bootstrap.transaction((transaction) => {
      transaction.putCommandRecord("command:sentinel", {
        state: "succeeded",
        retainedLedgerBytes: "l".repeat(256),
      });
      transaction.putMaterializedRecord("resource:sentinel", {
        backendIdentity: "backend:sentinel",
        originReservation: { principalId: "principal-sentinel" },
      });
    });
    const initialBytes = statSync(h.paths.state).size;
    const budget = initialBytes + 2_048;
    const constrained = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      testMaxPersistedBytes: budget,
    });
    await constrained.transaction((transaction) => {
      transaction.putMaterializedRecord("resource:near-budget", {
        backendIdentity: "backend:near-budget",
        payload: "n".repeat(256),
      });
    });
    assert.ok(statSync(h.paths.state).size <= budget);
    const before = await constrained.read();
    const beforeContents = readFileSync(h.paths.state, "utf8");

    await assert.rejects(
      constrained.transaction((transaction) => {
        transaction.putMaterializedRecord("resource:over-budget", {
          backendIdentity: "backend:over-budget",
          payload: "x".repeat(8_192),
        });
      }),
      (error) => error instanceof hostState.RelayV2HostStateCapacityError
        && error.code === "RELAY_V2_HOST_STATE_CAPACITY_EXCEEDED"
        && error.actualBytes > error.maxBytes,
    );
    assert.equal(readFileSync(h.paths.state, "utf8"), beforeContents);

    const restarted = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      testMaxPersistedBytes: budget,
    });
    const after = await restarted.read();
    assert.equal(after.hostEpoch, before.hostEpoch);
    assert.equal(after.commitSeq, before.commitSeq);
    assert.deepEqual(after.commands["command:sentinel"], before.commands["command:sentinel"]);
    assert.deepEqual(after.materialized, before.materialized);
  } finally {
    h.cleanup();
  }
});

test("commit faults expose either the previous cut or the complete associated cut, never partial state", async (t) => {
  await t.test("failure before the state rename preserves the previous cut", async () => {
    const h = harness();
    try {
      await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      let failStateRename = true;
      const failing = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        renameFile: (source, destination) => {
          if (failStateRename && destination === h.paths.state) {
            failStateRename = false;
            throw new Error("injected state rename failure");
          }
          renameSync(source, destination);
        },
      });

      await assert.rejects(failing.transaction((transaction) => {
        const revision = transaction.allocateRevision("sessions:scope-local");
        const eventSeq = transaction.allocateEventSeq();
        transaction.putMaterializedRecord("session:atomic", { revision, eventSeq });
        transaction.putCommandRecord("command:atomic", { state: "succeeded", revision, eventSeq });
      }), /injected state rename failure/);

      const reopened = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const snapshot = await reopened.read();
      assert.equal(snapshot.eventSeq, "0");
      assert.equal(snapshot.revisions["sessions:scope-local"], undefined);
      assert.equal(snapshot.commands["command:atomic"], undefined);
      assert.equal(snapshot.materialized["session:atomic"], undefined);
    } finally {
      h.cleanup();
    }
  });

  await t.test("failure after the state commit repairs and exposes the complete cut", async () => {
    const h = harness();
    try {
      await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      let failWitnessRename = true;
      const failing = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        renameFile: (source, destination) => {
          if (failWitnessRename && destination === h.paths.continuity) {
            failWitnessRename = false;
            throw new Error("injected witness rename failure");
          }
          renameSync(source, destination);
        },
      });

      await assert.rejects(failing.transaction((transaction) => {
        const revision = transaction.allocateRevision("sessions:scope-local");
        const eventSeq = transaction.allocateEventSeq();
        transaction.putMaterializedRecord("session:atomic", { revision, eventSeq });
        transaction.putCommandRecord("command:atomic", { state: "succeeded", revision, eventSeq });
      }), (error) => error.code === "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN");

      const reopened = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const snapshot = await reopened.read();
      assert.equal(snapshot.eventSeq, "1");
      assert.equal(snapshot.revisions["sessions:scope-local"], "1");
      assert.deepEqual(snapshot.commands["command:atomic"], {
        state: "succeeded",
        revision: "1",
        eventSeq: "1",
      });
      assert.deepEqual(snapshot.materialized["session:atomic"], {
        revision: "1",
        eventSeq: "1",
      });
    } finally {
      h.cleanup();
    }
  });
});

test("HostState terminal lineage persists exact binding, monotonic issuance, and restart loss", async () => {
  const h = harness();
  let issued = 0;
  const issueAuthorityId = (kind) => `${kind}-durable-${++issued}`;
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const authority = terminalAuthority(store, { issueAuthorityId });
    const original = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
    const claimed = await authority.claimOpen(original);
    assert.deepEqual(claimed, {
      status: "claimed",
      claimToken: "claim-durable-1",
      fence: "fence-durable-2",
      issuedGeneration: claimed.issuedGeneration,
      streamAuthority: { status: "absent" },
    });

    const pending = terminalState(await store.read());
    assert.equal(pending.schemaVersion, 3);
    assert.deepEqual(pending.openRecords[0], {
      status: "pending",
      key: original.key,
      streamKey: original.streamKey,
      fingerprint: original.fingerprint,
      ownerHostInstanceId: original.hostInstanceId,
      claimToken: claimed.claimToken,
      fence: claimed.fence,
      target: TERMINAL_TARGET,
      pane: 0,
      resumeTokenHash: null,
      mode: "new",
      previousGeneration: null,
      requestedOffset: null,
      streamAuthority: { status: "absent" },
      retainedAuthorityDigest: EMPTY_RETAINED_AUTHORITY_DIGEST,
      reservesStreamSlot: true,
      issuedGeneration: claimed.issuedGeneration,
      preparedBinding: null,
      expiresAtMs: original.expiresAtMs,
      outcome: null,
    });

    assert.deepEqual(await authority.prepareOpen({
      key: original.key,
      fingerprint: original.fingerprint,
      hostInstanceId: original.hostInstanceId,
      claimToken: claimed.claimToken,
      fence: claimed.fence,
      preparation: { kind: "current", resolution: terminalResolution() },
    }), { status: "prepared", binding: canonicalBinding() });

    const openedOutcome = {
      kind: "opened",
      generation: claimed.issuedGeneration,
      resumeTokenHash: TOKEN_HASH_ONE,
      disposition: "new",
      replayFromOffset: "0",
    };
    assert.deepEqual(await authority.completeOpen({
      key: original.key,
      fingerprint: original.fingerprint,
      hostInstanceId: original.hostInstanceId,
      claimToken: claimed.claimToken,
      fence: claimed.fence,
      outcome: openedOutcome,
    }), { status: "committed", outcome: openedOutcome });

    const persisted = terminalState(await store.read());
    assert.equal(persisted.generationHighWater, "1");
    assert.deepEqual(persisted.streamAuthorities, [{
      status: "live",
      streamKey: original.streamKey,
      generation: claimed.issuedGeneration,
      hostInstanceId: original.hostInstanceId,
      target: TERMINAL_TARGET,
      pane: 0,
      resumeTokenHash: TOKEN_HASH_ONE,
      canonicalBinding: canonicalBinding(),
      closeSlotReserved: true,
      closedExpiresAtMs: null,
    }]);
    assert.equal(JSON.stringify(persisted).includes("plaintext-resume-token"), false);

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const restarted = terminalAuthority(restartedStore, { issueAuthorityId });
    assert.deepEqual(await restarted.claimOpen({
      ...original,
      hostInstanceId: restartedStore.hostInstanceId,
    }), {
      status: "replay",
      outcome: openedOutcome,
      preparedBinding: canonicalBinding(),
    });

    const reconciled = terminalState(await restartedStore.read());
    assert.deepEqual(reconciled.streamAuthorities, []);
    assert.equal(reconciled.lostAuthorities.length, 1);
    assert.equal(reconciled.lostAuthorities[0].generation, claimed.issuedGeneration);

    const replacement = await restarted.claimOpen(terminalOpenClaim({
      key: "terminal-open:replacement",
      streamKey: "terminal-stream:replacement",
      fingerprint: "c".repeat(64),
      hostInstanceId: restartedStore.hostInstanceId,
    }));
    assert.equal(replacement.status, "claimed");
  } finally {
    h.cleanup();
  }
});

test("persisted pending terminal claim remains readable across a fresh transaction and rebuilt authority", async () => {
  const h = harness();
  let issued = 0;
  const issueAuthorityId = (kind) => `${kind}-restart-regression-${++issued}`;
  try {
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore, { issueAuthorityId });
    const claim = terminalOpenClaim({
      key: "terminal-open:persisted-pending",
      streamKey: "terminal-stream:persisted-pending",
      fingerprint: "8".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
    });
    const winner = await firstAuthority.claimOpen(claim);
    assert.equal(winner.status, "claimed");
    const pendingSnapshot = await firstStore.read();
    const pendingRecord = terminalState(pendingSnapshot).openRecords[0];
    assert.equal(pendingRecord.status, "pending");
    assert.equal(pendingRecord.claimToken, winner.claimToken);
    assert.equal(pendingRecord.fence, winner.fence);

    const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const secondAuthority = terminalAuthority(secondStore, { issueAuthorityId });
    const expectedReplay = {
      status: "replay",
      outcome: {
        kind: "reset",
        generation: winner.issuedGeneration,
        reason: "stream_lost",
        requestedOffset: null,
        bufferStartOffset: null,
        tailOffset: null,
      },
      preparedBinding: null,
    };
    assert.deepEqual(await secondAuthority.claimOpen({
      ...claim,
      hostInstanceId: secondStore.hostInstanceId,
    }), expectedReplay);
    const reconciledSnapshot = await secondStore.read();
    assert.equal(
      BigInt(reconciledSnapshot.commitSeq),
      BigInt(pendingSnapshot.commitSeq) + 1n,
    );
    const reconciledRecord = terminalState(reconciledSnapshot).openRecords[0];
    assert.equal(reconciledRecord.status, "final");
    assert.equal(reconciledRecord.claimToken, winner.claimToken);
    assert.equal(reconciledRecord.fence, winner.fence);
    assert.deepEqual(reconciledRecord.outcome, expectedReplay.outcome);

    const thirdStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const thirdAuthority = terminalAuthority(thirdStore, { issueAuthorityId });
    assert.deepEqual(await thirdAuthority.claimOpen({
      ...claim,
      hostInstanceId: thirdStore.hostInstanceId,
    }), expectedReplay);
    const stable = terminalState(await thirdStore.read());
    assert.deepEqual(stable.streamAuthorities, []);
    assert.equal(stable.openRecords[0].claimToken, winner.claimToken);
    assert.equal(stable.openRecords[0].fence, winner.fence);
  } finally {
    h.cleanup();
  }
});

test("terminal prepare rejects asynchronous fences without persisting a binding", async (t) => {
  const cases = [
    {
      name: "resolved promise",
      fenceResult: () => Promise.resolve("unsafe asynchronous fence"),
    },
    {
      name: "throwing then getter",
      fenceResult: () => Object.defineProperty({}, "then", {
        get() {
          throw new Error("unsafe then getter");
        },
      }),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = harness();
      try {
        const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
        let fenceCalls = 0;
        const authority = terminalAuthority(store, {
          admissionFence: {
            fenceSessionForAdmission() {
              fenceCalls += 1;
              return scenario.fenceResult();
            },
          },
        });
        const claim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
        const winner = await authority.claimOpen(claim);
        assert.equal(winner.status, "claimed");
        await assert.rejects(authority.prepareOpen({
          key: claim.key,
          fingerprint: claim.fingerprint,
          hostInstanceId: store.hostInstanceId,
          claimToken: winner.claimToken,
          fence: winner.fence,
          preparation: { kind: "current", resolution: terminalResolution() },
        }), (error) => (
          error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE"
        ));
        assert.equal(fenceCalls, 1);
        const record = terminalState(await store.read()).openRecords[0];
        assert.equal(record.status, "pending");
        assert.equal(record.preparedBinding, null);
      } finally {
        h.cleanup();
      }
    });
  }
});

test("terminal prepare requires an explicit H0 admission fence", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    let issued = 0;
    const authority = new terminalLineage.RelayV2TerminalDurableLineageAuthority({
      store,
      now: () => 1_000_000,
      issueAuthorityId: (kind) => `${kind}-${store.hostInstanceId}-${++issued}`,
    });
    const claim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
    const winner = await authority.claimOpen(claim);
    assert.equal(winner.status, "claimed");
    await assert.rejects(authority.prepareOpen({
      key: claim.key,
      fingerprint: claim.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      preparation: { kind: "current", resolution: terminalResolution() },
    }), (error) => (
      error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CAPABILITY_UNAVAILABLE"
    ));
    const record = terminalState(await store.read()).openRecords[0];
    assert.equal(record.status, "pending");
    assert.equal(record.preparedBinding, null);
  } finally {
    h.cleanup();
  }
});

test("terminal prepare replay returns the closed durable proof shape", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const authority = terminalAuthority(store);
    const openedClaim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
    const winner = await authority.claimOpen(openedClaim);
    const owner = {
      key: openedClaim.key,
      fingerprint: openedClaim.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
    };
    const preparation = {
      ...owner,
      preparation: { kind: "current", resolution: terminalResolution() },
    };
    await authority.prepareOpen(preparation);
    const openedOutcome = {
      kind: "opened",
      generation: winner.issuedGeneration,
      resumeTokenHash: TOKEN_HASH_ONE,
      disposition: "new",
      replayFromOffset: "0",
    };
    assert.equal((await authority.completeOpen({ ...owner, outcome: openedOutcome })).status, "committed");
    assert.deepEqual(await authority.prepareOpen(preparation), {
      status: "replay",
      outcome: openedOutcome,
      preparedBinding: canonicalBinding(),
    });

    const failedClaim = terminalOpenClaim({
      key: "terminal-open:prepared-failure-proof",
      streamKey: "terminal-stream:prepared-failure-proof",
      fingerprint: "b".repeat(64),
      hostInstanceId: store.hostInstanceId,
    });
    const failedWinner = await authority.claimOpen(failedClaim);
    const failedOwner = {
      key: failedClaim.key,
      fingerprint: failedClaim.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: failedWinner.claimToken,
      fence: failedWinner.fence,
    };
    const failedPreparation = {
      ...failedOwner,
      preparation: { kind: "current", resolution: terminalResolution() },
    };
    await authority.prepareOpen(failedPreparation);
    const failureOutcome = {
      kind: "error",
      code: "CAPABILITY_UNAVAILABLE",
      message: "backend rejected after exact preparation",
    };
    await authority.failOpen({
      ...failedOwner,
      outcome: failureOutcome,
      streamEffect: { kind: "preserve" },
    });
    assert.deepEqual(await authority.prepareOpen(failedPreparation), {
      status: "replay",
      outcome: failureOutcome,
      preparedBinding: canonicalBinding(),
    });
  } finally {
    h.cleanup();
  }
});

test("terminal prepare reuses one exact binding but rejects cross-mode or control-identity changes", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    let fenceCalls = 0;
    const authority = terminalAuthority(store, {
      admissionFence: {
        fenceSessionForAdmission() {
          fenceCalls += 1;
        },
      },
    });
    const claim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
    const winner = await authority.claimOpen(claim);
    const prepare = {
      key: claim.key,
      fingerprint: claim.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
    };
    const current = { kind: "current", resolution: terminalResolution() };
    assert.deepEqual(await authority.prepareOpen({ ...prepare, preparation: current }), {
      status: "prepared",
      binding: canonicalBinding(),
    });
    assert.deepEqual(await authority.prepareOpen({ ...prepare, preparation: current }), {
      status: "prepared",
      binding: canonicalBinding(),
    });
    assert.equal(fenceCalls, 1);

    await assert.rejects(authority.prepareOpen({
      ...prepare,
      preparation: { kind: "retained", binding: canonicalBinding() },
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");
    const changedControlBinding = canonicalBinding(TERMINAL_TARGET, 0, {
      exactControlIdentity: {
        ...canonicalBinding().exactControlIdentity,
        controlEpoch: "changed-control-epoch",
      },
    });
    await assert.rejects(authority.prepareOpen({
      ...prepare,
      preparation: {
        kind: "current",
        resolution: terminalResolution(TERMINAL_TARGET, 0, changedControlBinding),
      },
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");
    assert.equal(fenceCalls, 1);
  } finally {
    h.cleanup();
  }
});

test("reset prepare rejects cleanup of claim-time retained lost authority before fencing", async () => {
  const h = harness();
  try {
    let now = 1_000_000;
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore, { now: () => now });
    const original = terminalOpenClaim({
      key: "terminal-open:retained-race-source",
      streamKey: "terminal-stream:retained-race",
      fingerprint: "5".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
    });
    await commitTerminalOpen(firstAuthority, original);

    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    let fenceCalls = 0;
    const authority = terminalAuthority(store, {
      now: () => now,
      admissionFence: {
        fenceSessionForAdmission() {
          fenceCalls += 1;
        },
      },
    });
    const activation = terminalOpenClaim({
      key: "terminal-open:retained-race-activation",
      streamKey: "terminal-stream:retained-race-activation",
      fingerprint: "4".repeat(64),
      hostInstanceId: store.hostInstanceId,
    });
    const activationWinner = await authority.claimOpen(activation);
    await authority.failOpen({
      key: activation.key,
      fingerprint: activation.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: activationWinner.claimToken,
      fence: activationWinner.fence,
      outcome: { kind: "error", code: "BUSY", message: "activation only" },
      streamEffect: { kind: "preserve" },
    });
    now += 100_000;
    const reset = terminalOpenClaim({
      key: "terminal-open:reset-retained-close-race",
      streamKey: original.streamKey,
      fingerprint: "6".repeat(64),
      hostInstanceId: store.hostInstanceId,
      mode: "reset",
      expiresAtMs: now + 600_000,
    });
    const winner = await authority.claimOpen(reset);
    assert.equal(winner.status, "claimed");
    const claimedState = terminalState(await store.read());
    assert.equal(claimedState.lostAuthorities.length, 1);
    now = claimedState.lostAuthorities[0].expiresAtMs + 1;
    await assert.rejects(authority.prepareOpen({
      key: reset.key,
      fingerprint: reset.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      preparation: { kind: "current", resolution: terminalResolution() },
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");
    assert.equal(fenceCalls, 0);
    assert.equal(
      terminalState(await store.read()).openRecords.find(({ key }) => key === reset.key)
        .preparedBinding,
      null,
    );
  } finally {
    h.cleanup();
  }
});

test("resume prepare rejects release of its captured current authority", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const authority = terminalAuthority(store);
    const original = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
    const opened = await commitTerminalOpen(authority, original);
    const resume = terminalOpenClaim({
      key: "terminal-open:resume-release-race",
      fingerprint: "8".repeat(64),
      hostInstanceId: store.hostInstanceId,
      mode: "resume",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_ONE,
    });
    const winner = await authority.claimOpen(resume);
    assert.equal(winner.status, "claimed");
    assert.deepEqual(await authority.releaseStreamReservation({
      streamKey: original.streamKey,
      generation: opened.generation,
      hostInstanceId: store.hostInstanceId,
    }), { status: "released" });
    await assert.rejects(authority.prepareOpen({
      key: resume.key,
      fingerprint: resume.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      preparation: {
        kind: "retained",
        binding: winner.streamAuthority.canonicalBinding,
      },
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");
  } finally {
    h.cleanup();
  }
});

test("host restart atomically retires executable terminal lineage and requires explicit reset", async () => {
  const h = harness();
  try {
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore);
    const original = terminalOpenClaim({ hostInstanceId: firstStore.hostInstanceId });
    const opened = await commitTerminalOpen(firstAuthority, original);

    const sameProcessResume = terminalOpenClaim({
      key: "terminal-open:same-process-resume",
      fingerprint: "3".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
      mode: "resume",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_ONE,
    });
    const sameProcessWinner = await firstAuthority.claimOpen(sameProcessResume);
    assert.equal(sameProcessWinner.status, "claimed");
    assert.equal(sameProcessWinner.issuedGeneration, null);
    assert.equal((await firstAuthority.prepareOpen({
      key: sameProcessResume.key,
      fingerprint: sameProcessResume.fingerprint,
      hostInstanceId: firstStore.hostInstanceId,
      claimToken: sameProcessWinner.claimToken,
      fence: sameProcessWinner.fence,
      preparation: {
        kind: "retained",
        binding: sameProcessWinner.streamAuthority.canonicalBinding,
      },
    })).status, "prepared");
    assert.deepEqual(await firstAuthority.completeOpen({
      key: sameProcessResume.key,
      fingerprint: sameProcessResume.fingerprint,
      hostInstanceId: firstStore.hostInstanceId,
      claimToken: sameProcessWinner.claimToken,
      fence: sameProcessWinner.fence,
      outcome: {
        kind: "opened",
        generation: opened.generation,
        resumeTokenHash: TOKEN_HASH_ONE,
        disposition: "resumed",
        replayFromOffset: "0",
      },
    }), {
      status: "committed",
      outcome: {
        kind: "opened",
        generation: opened.generation,
        resumeTokenHash: TOKEN_HASH_ONE,
        disposition: "resumed",
        replayFromOffset: "0",
      },
    });

    const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const secondAuthority = terminalAuthority(secondStore);
    const crossProcessResume = {
      ...sameProcessResume,
      key: "terminal-open:cross-process-resume",
      fingerprint: "4".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
    };
    const lost = {
      status: "replay",
      outcome: {
        kind: "reset",
        generation: opened.generation,
        reason: "stream_lost",
        requestedOffset: "0",
        bufferStartOffset: null,
        tailOffset: null,
      },
      preparedBinding: null,
    };
    assert.deepEqual(await secondAuthority.claimOpen(crossProcessResume), lost);
    assert.deepEqual(await secondAuthority.claimOpen(crossProcessResume), lost);

    const retired = terminalState(await secondStore.read());
    assert.deepEqual(retired.streamAuthorities, []);
    assert.equal(retired.lostAuthorities.length, 1);
    assert.equal(retired.lostAuthorities[0].generation, opened.generation);
    await assert.rejects(firstAuthority.markStreamClosed({
      streamKey: original.streamKey,
      generation: opened.generation,
      hostInstanceId: firstStore.hostInstanceId,
      expiresAtMs: 1_600_000,
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");

    const reset = terminalOpenClaim({
      key: "terminal-open:explicit-reset-after-restart",
      fingerprint: "5".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "reset",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_ONE,
    });
    const resetWinner = await secondAuthority.claimOpen(reset);
    assert.equal(resetWinner.status, "claimed");
    assert.notEqual(resetWinner.issuedGeneration, opened.generation);
    assert.deepEqual(resetWinner.streamAuthority, { status: "absent" });
    assert.equal((await secondAuthority.prepareOpen({
      key: reset.key,
      fingerprint: reset.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: resetWinner.claimToken,
      fence: resetWinner.fence,
      preparation: { kind: "current", resolution: terminalResolution() },
    })).status, "prepared");
    await secondAuthority.completeOpen({
      key: reset.key,
      fingerprint: reset.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: resetWinner.claimToken,
      fence: resetWinner.fence,
      outcome: {
        kind: "opened",
        generation: resetWinner.issuedGeneration,
        resumeTokenHash: TOKEN_HASH_TWO,
        disposition: "reset",
        replayFromOffset: "0",
      },
    });
    const replaced = terminalState(await secondStore.read());
    assert.equal(replaced.generationHighWater, "2");
    assert.equal(replaced.streamAuthorities[0].generation, resetWinner.issuedGeneration);
    assert.deepEqual(replaced.lostAuthorities, []);

    const thirdStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const thirdAuthority = terminalAuthority(thirdStore);
    const retiredReset = {
      status: "replay",
      outcome: {
        kind: "opened",
        generation: resetWinner.issuedGeneration,
        resumeTokenHash: TOKEN_HASH_TWO,
        disposition: "reset",
        replayFromOffset: "0",
      },
      preparedBinding: canonicalBinding(),
    };
    const resetRetry = {
      ...reset,
      hostInstanceId: thirdStore.hostInstanceId,
    };
    assert.deepEqual(await thirdAuthority.claimOpen(resetRetry), retiredReset);
    assert.deepEqual(await thirdAuthority.claimOpen(resetRetry), retiredReset);
    const retained = terminalState(await thirdStore.read());
    assert.deepEqual(retained.streamAuthorities, []);
    assert.equal(retained.generationHighWater, "2");
    assert.equal(retained.lostAuthorities.length, 1);
    assert.equal(retained.lostAuthorities[0].generation, resetWinner.issuedGeneration);
    assert.deepEqual(
      retained.openRecords.find((record) => record.key === reset.key).outcome,
      retiredReset.outcome,
    );
  } finally {
    h.cleanup();
  }
});

test("restart-lost reset admits all-null recovery but rejects wrong or partial old tuples", async () => {
  const h = harness();
  try {
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore);
    const original = terminalOpenClaim({ hostInstanceId: firstStore.hostInstanceId });
    const opened = await commitTerminalOpen(firstAuthority, original);

    const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const secondAuthority = terminalAuthority(secondStore);
    await assert.rejects(secondAuthority.claimOpen(terminalOpenClaim({
      key: "terminal-open:partial-reset-after-restart",
      fingerprint: "6".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "reset",
      previousGeneration: opened.generation,
      requestedOffset: null,
      resumeTokenHash: TOKEN_HASH_ONE,
    })), (error) => (
      error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_INVALID_INPUT"
    ));

    const wrongOldTuple = terminalOpenClaim({
      key: "terminal-open:wrong-lost-reset-after-restart",
      fingerprint: "7".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "reset",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_TWO,
    });
    assert.deepEqual(await secondAuthority.claimOpen(wrongOldTuple), {
      status: "conflict",
      reason: "stream_conflict",
    });
    const retired = terminalState(await secondStore.read());
    assert.deepEqual(retired.streamAuthorities, []);
    assert.equal(retired.lostAuthorities.length, 1);
    assert.equal(retired.lostAuthorities[0].generation, opened.generation);

    const nonExactResume = terminalOpenClaim({
      key: "terminal-open:non-exact-lost-resume",
      fingerprint: "9".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "resume",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_TWO,
    });
    const nonExactResumeWinner = await secondAuthority.claimOpen(nonExactResume);
    assert.equal(nonExactResumeWinner.status, "claimed");
    assert.deepEqual(nonExactResumeWinner.streamAuthority, { status: "absent" });
    const nonExactReset = {
      kind: "reset",
      generation: opened.generation,
      reason: "stream_lost",
      requestedOffset: "0",
      bufferStartOffset: null,
      tailOffset: null,
    };
    assert.deepEqual(await secondAuthority.failOpen({
      key: nonExactResume.key,
      fingerprint: nonExactResume.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: nonExactResumeWinner.claimToken,
      fence: nonExactResumeWinner.fence,
      outcome: nonExactReset,
      streamEffect: { kind: "preserve" },
    }), {
      status: "committed",
      outcome: nonExactReset,
    });

    const allNullReset = terminalOpenClaim({
      key: "terminal-open:all-null-reset-after-restart",
      fingerprint: "8".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "reset",
    });
    const winner = await secondAuthority.claimOpen(allNullReset);
    assert.equal(winner.status, "claimed");
    assert.notEqual(winner.issuedGeneration, opened.generation);
    assert.deepEqual(winner.streamAuthority, { status: "absent" });
    let state = terminalState(await secondStore.read());
    assert.deepEqual(
      state.openRecords.find(({ key }) => key === allNullReset.key).streamAuthority,
      { status: "absent" },
    );
    assert.equal(state.lostAuthorities[0].generation, opened.generation);

    const outcome = {
      kind: "opened",
      generation: winner.issuedGeneration,
      resumeTokenHash: TOKEN_HASH_TWO,
      disposition: "reset",
      replayFromOffset: "0",
    };
    assert.equal((await secondAuthority.prepareOpen({
      key: allNullReset.key,
      fingerprint: allNullReset.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      preparation: { kind: "current", resolution: terminalResolution() },
    })).status, "prepared");
    assert.deepEqual(await secondAuthority.completeOpen({
      key: allNullReset.key,
      fingerprint: allNullReset.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      outcome,
    }), { status: "committed", outcome });
    state = terminalState(await secondStore.read());
    assert.equal(state.generationHighWater, "2");
    assert.equal(state.streamAuthorities.length, 1);
    assert.equal(state.streamAuthorities[0].generation, winner.issuedGeneration);
    assert.equal(state.lostAuthorities.length, 1);
    assert.equal(state.lostAuthorities[0].generation, opened.generation);

    const currentResume = terminalOpenClaim({
      key: "terminal-open:resume-current-beside-old-lost",
      fingerprint: "b".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "resume",
      previousGeneration: winner.issuedGeneration,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_TWO,
    });
    const currentResumeWinner = await secondAuthority.claimOpen(currentResume);
    assert.equal(currentResumeWinner.status, "claimed");
    assert.equal(currentResumeWinner.issuedGeneration, null);
    assert.deepEqual(currentResumeWinner.streamAuthority, {
      status: "live",
      generation: winner.issuedGeneration,
      target: TERMINAL_TARGET,
      pane: 0,
      resumeTokenHash: TOKEN_HASH_TWO,
      canonicalBinding: canonicalBinding(),
    });
    const resumed = {
      kind: "opened",
      generation: winner.issuedGeneration,
      resumeTokenHash: TOKEN_HASH_TWO,
      disposition: "resumed",
      replayFromOffset: "0",
    };
    assert.equal((await secondAuthority.prepareOpen({
      key: currentResume.key,
      fingerprint: currentResume.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: currentResumeWinner.claimToken,
      fence: currentResumeWinner.fence,
      preparation: {
        kind: "retained",
        binding: currentResumeWinner.streamAuthority.canonicalBinding,
      },
    })).status, "prepared");
    assert.deepEqual(await secondAuthority.completeOpen({
      key: currentResume.key,
      fingerprint: currentResume.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      claimToken: currentResumeWinner.claimToken,
      fence: currentResumeWinner.fence,
      outcome: resumed,
    }), { status: "committed", outcome: resumed });
    state = terminalState(await secondStore.read());
    assert.equal(state.streamAuthorities[0].generation, winner.issuedGeneration);
    assert.equal(state.lostAuthorities[0].generation, opened.generation);
  } finally {
    h.cleanup();
  }
});

test("HostState terminal lineage admits one stream mutation, enforces quotas, and retires only exact reset binding", async (t) => {
  await t.test("pending stream owner and hard quotas are atomic", async () => {
    const h = harness();
    try {
      const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const authority = terminalAuthority(store, {
        testLimits: { maxControlRecords: 2, maxStreams: 1 },
      });
      const first = await authority.claimOpen(terminalOpenClaim({
        hostInstanceId: store.hostInstanceId,
      }));
      assert.equal(first.status, "claimed");
      assert.deepEqual(await authority.claimOpen(terminalOpenClaim({
        key: "terminal-open:competing",
        fingerprint: "b".repeat(64),
        hostInstanceId: store.hostInstanceId,
      })), { status: "conflict", reason: "stream_conflict" });
      assert.deepEqual(await authority.claimOpen(terminalOpenClaim({
        key: "terminal-open:over-quota",
        streamKey: "terminal-stream:over-quota",
        fingerprint: "c".repeat(64),
        hostInstanceId: store.hostInstanceId,
      })), { status: "busy", reason: "control_record_quota" });
      assert.equal(terminalState(await store.read()).openRecords.length, 1);
    } finally {
      h.cleanup();
    }
  });

  await t.test("retained closed rows do not consume live quota but closed reset does", async () => {
    const h = harness();
    try {
      const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const authority = terminalAuthority(store, {
        testLimits: { maxControlRecords: 20, maxStreams: 1 },
      });
      const closedClaim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
      const closed = await commitTerminalOpen(authority, closedClaim);
      assert.deepEqual(await authority.markStreamClosed({
        streamKey: closedClaim.streamKey,
        generation: closed.generation,
        hostInstanceId: store.hostInstanceId,
        expiresAtMs: 1_600_000,
      }), { status: "closed" });

      const liveClaim = terminalOpenClaim({
        key: "terminal-open:live-beside-retained-closed",
        streamKey: "terminal-stream:live-beside-retained-closed",
        fingerprint: "c".repeat(64),
        hostInstanceId: store.hostInstanceId,
      });
      const live = await commitTerminalOpen(authority, liveClaim, {
        resumeTokenHash: TOKEN_HASH_TWO,
      });
      let state = terminalState(await store.read());
      assert.deepEqual(state.streamAuthorities.map(({ status }) => status).sort(), [
        "closed",
        "live",
      ]);

      const resetClosed = terminalOpenClaim({
        key: "terminal-open:reset-retained-closed-at-live-limit",
        fingerprint: "d".repeat(64),
        hostInstanceId: store.hostInstanceId,
        mode: "reset",
        previousGeneration: closed.generation,
        requestedOffset: "0",
        resumeTokenHash: TOKEN_HASH_ONE,
      });
      assert.deepEqual(await authority.claimOpen(resetClosed), {
        status: "busy",
        reason: "control_record_quota",
      });
      state = terminalState(await store.read());
      assert.equal(state.generationHighWater, "2");
      assert.equal(state.streamAuthorities.find(
        ({ streamKey }) => streamKey === liveClaim.streamKey,
      ).generation, live.generation);
      assert.equal(state.openRecords.some(({ key }) => key === resetClosed.key), false);
    } finally {
      h.cleanup();
    }
  });

  await t.test("reset retirement requires exact target, pane, token hash, and generation", async () => {
    const h = harness();
    try {
      const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const authority = terminalAuthority(store);
      const opened = await commitTerminalOpen(authority);
      const mismatched = terminalOpenClaim({
        key: "terminal-open:mismatched-reset",
        fingerprint: "d".repeat(64),
        hostInstanceId: store.hostInstanceId,
        target: { ...TERMINAL_TARGET, sessionId: "ses_DIFFERENT" },
        resumeTokenHash: TOKEN_HASH_ONE,
        mode: "reset",
        previousGeneration: opened.generation,
        requestedOffset: "0",
      });
      assert.deepEqual(await authority.claimOpen(mismatched), {
        status: "conflict",
        reason: "stream_conflict",
      });
      const state = terminalState(await store.read());
      assert.equal(state.streamAuthorities.length, 1);
      assert.equal(state.streamAuthorities[0].generation, opened.generation);
      assert.deepEqual(state.streamAuthorities[0].target, TERMINAL_TARGET);
      assert.equal(state.streamAuthorities[0].pane, 0);
      assert.equal(state.streamAuthorities[0].resumeTokenHash, TOKEN_HASH_ONE);
    } finally {
      h.cleanup();
    }
  });
});

test("HostState terminal close, natural-close, finalize, release, and uncertain commits reconcile durably", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const authority = terminalAuthority(store);
    const opened = await commitTerminalOpen(authority);
    const closeIntent = {
      key: "terminal-close:one",
      streamKey: "terminal-stream:one",
      fingerprint: "e".repeat(64),
      hostInstanceId: store.hostInstanceId,
      target: { ...TERMINAL_TARGET },
      streamId: "stream-one",
      closeId: "close-one",
      requestId: "request-close-one",
      requestRoute: {
        connectorId: "connector-one",
        routeId: "route-one",
        routeFence: "route-fence-one",
      },
      generation: opened.generation,
      finalOffset: "23",
      reason: "client_closed",
      exitCode: null,
      expiresAtMs: 1_600_000,
    };
    const closeClaim = await authority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: closeIntent.hostInstanceId,
      intent: closeIntent,
    });
    assert.equal(closeClaim.status, "claimed");
    assert.deepEqual(closeClaim.intent, closeIntent);
    let state = terminalState(await store.read());
    assert.equal(state.streamAuthorities[0].status, "closed");
    assert.equal(state.streamAuthorities[0].closeSlotReserved, false);
    assert.equal(state.closeRecords[0].status, "intent");

    assert.deepEqual(await authority.finalizeClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: closeIntent.hostInstanceId,
      ownerFence: closeClaim.ownerFence,
    }), closeIntent);
    assert.deepEqual(await authority.releaseStreamReservation({
      streamKey: closeIntent.streamKey,
      generation: closeIntent.generation,
      hostInstanceId: closeIntent.hostInstanceId,
    }), { status: "released" });
    state = terminalState(await store.read());
    assert.deepEqual(state.streamAuthorities, []);
    assert.equal(state.closeRecords[0].status, "final");

    const secondClaim = terminalOpenClaim({
      key: "terminal-open:natural-close",
      streamKey: "terminal-stream:natural-close",
      fingerprint: "f".repeat(64),
      hostInstanceId: "replaced-below",
    });

    let failWitnessRename = false;
    const uncertainStore = await hostState.RelayV2HostStateStore.open({
      paths: h.paths,
      renameFile: (source, destination) => {
        if (failWitnessRename && destination === h.paths.continuity) {
          failWitnessRename = false;
          throw new Error("injected terminal lineage witness failure");
        }
        renameSync(source, destination);
      },
    });
    const uncertainAuthority = terminalAuthority(uncertainStore);
    assert.deepEqual(await uncertainAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: uncertainStore.hostInstanceId,
    }), { status: "final", tombstone: closeIntent });
    secondClaim.hostInstanceId = uncertainStore.hostInstanceId;
    const secondOpened = await commitTerminalOpen(uncertainAuthority, secondClaim, {
      resumeTokenHash: TOKEN_HASH_TWO,
    });
    failWitnessRename = true;
    assert.deepEqual(await uncertainAuthority.markStreamClosed({
      streamKey: secondClaim.streamKey,
      generation: secondOpened.generation,
      hostInstanceId: secondClaim.hostInstanceId,
      expiresAtMs: 1_600_000,
    }), { status: "closed" });
    const reopened = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const afterUncertain = terminalState(await reopened.read());
    const naturallyClosed = afterUncertain.streamAuthorities.find(
      ({ streamKey }) => streamKey === secondClaim.streamKey,
    );
    assert.equal(naturallyClosed.status, "closed");
    assert.equal(naturallyClosed.closedExpiresAtMs, 1_600_000);
  } finally {
    h.cleanup();
  }
});

test("terminal authority freezes ten-minute retention after entering the HostState critical section", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    let now = 1_000_000;
    let delayed = false;
    const delayedStore = {
      hostInstanceId: store.hostInstanceId,
      serialize: (callback) => store.serialize((section) => {
        if (!delayed) {
          delayed = true;
          now = 1_100_000;
        }
        return callback(section);
      }),
    };
    const authority = terminalAuthority(delayedStore, { now: () => now });
    const claim = terminalOpenClaim({
      hostInstanceId: store.hostInstanceId,
      expiresAtMs: 1_000_001,
    });
    const opened = await commitTerminalOpen(authority, claim);
    let state = terminalState(await store.read());
    assert.equal(state.openRecords[0].expiresAtMs, 1_700_000);

    assert.deepEqual(await authority.markStreamClosed({
      streamKey: claim.streamKey,
      generation: opened.generation,
      hostInstanceId: store.hostInstanceId,
      expiresAtMs: 1_100_001,
    }), { status: "closed" });
    state = terminalState(await store.read());
    assert.equal(state.streamAuthorities[0].closedExpiresAtMs, 1_700_000);

    const closeIntent = {
      key: "terminal-close:short-caller-retention",
      streamKey: claim.streamKey,
      fingerprint: "7".repeat(64),
      hostInstanceId: store.hostInstanceId,
      target: { ...TERMINAL_TARGET },
      streamId: "stream-short-caller-retention",
      closeId: "close-short-caller-retention",
      requestId: "request-short-caller-retention",
      requestRoute: {
        connectorId: "connector-short-caller-retention",
        routeId: "route-short-caller-retention",
        routeFence: "route-fence-short-caller-retention",
      },
      generation: opened.generation,
      finalOffset: "0",
      reason: "client_closed",
      exitCode: null,
      expiresAtMs: 1_100_001,
    };
    const close = await authority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: store.hostInstanceId,
      intent: closeIntent,
    });
    assert.equal(close.status, "claimed");
    assert.equal(close.intent.expiresAtMs, 1_700_000);
    assert.equal(closeIntent.expiresAtMs, 1_100_001);
    state = terminalState(await store.read());
    assert.equal(state.closeRecords[0].value.expiresAtMs, 1_700_000);
    assert.equal(state.streamAuthorities[0].closedExpiresAtMs, 1_700_000);
  } finally {
    h.cleanup();
  }
});

test("rebuilt authority atomically adopts an exact pending close owner before finalization", async () => {
  const h = harness();
  try {
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore);
    const original = terminalOpenClaim({ hostInstanceId: firstStore.hostInstanceId });
    const opened = await commitTerminalOpen(firstAuthority, original);
    const closeIntent = {
      key: "terminal-close:pending-owner-transfer",
      streamKey: original.streamKey,
      fingerprint: "e".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
      target: { ...TERMINAL_TARGET },
      streamId: "stream-pending-owner-transfer",
      closeId: "close-pending-owner-transfer",
      requestId: "request-pending-owner-transfer",
      requestRoute: {
        connectorId: "connector-pending-owner-transfer",
        routeId: "route-pending-owner-transfer",
        routeFence: "route-fence-pending-owner-transfer",
      },
      generation: opened.generation,
      finalOffset: "23",
      reason: "client_closed",
      exitCode: null,
      expiresAtMs: 1_600_000,
    };
    const originalCloseClaim = await firstAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: firstStore.hostInstanceId,
      intent: closeIntent,
    });
    assert.equal(originalCloseClaim.status, "claimed");
    assert.deepEqual(originalCloseClaim.intent, closeIntent);

    const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    assert.notEqual(secondStore.hostInstanceId, firstStore.hostInstanceId);
    const secondAuthority = terminalAuthority(secondStore);
    const retryIntent = {
      ...closeIntent,
      hostInstanceId: secondStore.hostInstanceId,
      requestId: "request-pending-owner-transfer-retry",
      requestRoute: {
        connectorId: "connector-pending-owner-transfer-retry",
        routeId: "route-pending-owner-transfer-retry",
        routeFence: "route-fence-pending-owner-transfer-retry",
      },
      finalOffset: "99",
      reason: "backend_error",
      exitCode: null,
      expiresAtMs: 1_400_000,
    };
    assert.deepEqual(await secondAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: "f".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
    }), { status: "close_conflict" });
    assert.deepEqual(await secondAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      intent: {
        ...retryIntent,
        target: { ...TERMINAL_TARGET, sessionId: "ses_DIFFERENT" },
      },
    }), { status: "close_conflict" });
    assert.equal(
      terminalState(await secondStore.read()).closeRecords[0].value.hostInstanceId,
      firstStore.hostInstanceId,
    );

    const adopted = await secondAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      intent: retryIntent,
    });
    assert.deepEqual(adopted, {
      status: "existing_intent",
      intent: closeIntent,
      ownerFence: adopted.ownerFence,
    });
    await assert.rejects(firstAuthority.finalizeClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: firstStore.hostInstanceId,
      ownerFence: originalCloseClaim.ownerFence,
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");

    const finalized = await secondAuthority.finalizeClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: secondStore.hostInstanceId,
      ownerFence: adopted.ownerFence,
    });
    assert.deepEqual(finalized, adopted.intent);
    const thirdStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const thirdAuthority = terminalAuthority(thirdStore);
    assert.deepEqual(await thirdAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: thirdStore.hostInstanceId,
      intent: {
        ...finalized,
        hostInstanceId: thirdStore.hostInstanceId,
        generation: "terminal-generation-other",
      },
    }), { status: "close_conflict" });
    assert.deepEqual(await thirdAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: thirdStore.hostInstanceId,
      intent: {
        ...retryIntent,
        hostInstanceId: thirdStore.hostInstanceId,
        requestId: "request-pending-owner-transfer-final-retry",
        requestRoute: {
          connectorId: "connector-pending-owner-transfer-final-retry",
          routeId: "route-pending-owner-transfer-final-retry",
          routeFence: "route-fence-pending-owner-transfer-final-retry",
        },
        expiresAtMs: 1_300_000,
      },
    }), { status: "final", tombstone: finalized });
    await assert.rejects(thirdAuthority.finalizeClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: thirdStore.hostInstanceId,
      ownerFence: adopted.ownerFence,
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");
    assert.deepEqual(
      terminalState(await thirdStore.read()).closeRecords[0],
      {
        status: "final",
        ownerHostInstanceId: secondStore.hostInstanceId,
        ownerFence: adopted.ownerFence,
        value: finalized,
      },
    );
  } finally {
    h.cleanup();
  }
});

test("retained close identity blocks new and resume after restart while all-null reset signs a fresh generation", async () => {
  const h = harness();
  try {
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore);
    const original = terminalOpenClaim({ hostInstanceId: firstStore.hostInstanceId });
    const opened = await commitTerminalOpen(firstAuthority, original);
    const closeIntent = {
      key: "terminal-close:retained-stream-identity",
      streamKey: original.streamKey,
      fingerprint: "6".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
      target: { ...TERMINAL_TARGET },
      streamId: "stream-retained-stream-identity",
      closeId: "close-retained-stream-identity",
      requestId: "request-retained-stream-identity",
      requestRoute: {
        connectorId: "connector-retained-stream-identity",
        routeId: "route-retained-stream-identity",
        routeFence: "route-fence-retained-stream-identity",
      },
      generation: opened.generation,
      finalOffset: "5",
      reason: "client_closed",
      exitCode: null,
      expiresAtMs: 1_600_000,
    };
    const close = await firstAuthority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: firstStore.hostInstanceId,
      intent: closeIntent,
    });
    assert.equal(close.status, "claimed");
    await firstAuthority.finalizeClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: firstStore.hostInstanceId,
      ownerFence: close.ownerFence,
    });

    const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const secondAuthority = terminalAuthority(secondStore);
    assert.deepEqual(await secondAuthority.claimOpen(terminalOpenClaim({
      key: "terminal-open:new-over-retained-close",
      fingerprint: "7".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
    })), { status: "conflict", reason: "stream_conflict" });

    const resume = terminalOpenClaim({
      key: "terminal-open:resume-over-retained-close",
      fingerprint: "8".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "resume",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_ONE,
    });
    const lost = {
      status: "replay",
      outcome: {
        kind: "reset",
        generation: opened.generation,
        reason: "stream_lost",
        requestedOffset: "0",
        bufferStartOffset: null,
        tailOffset: null,
      },
      preparedBinding: null,
    };
    assert.deepEqual(await secondAuthority.claimOpen(resume), lost);
    assert.deepEqual(await secondAuthority.claimOpen(resume), lost);

    const reset = terminalOpenClaim({
      key: "terminal-open:reset-over-retained-close",
      fingerprint: "9".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
      mode: "reset",
    });
    const replacement = await secondAuthority.claimOpen(reset);
    assert.equal(replacement.status, "claimed");
    assert.notEqual(replacement.issuedGeneration, opened.generation);
    assert.deepEqual(replacement.streamAuthority, { status: "absent" });
    const retained = terminalState(await secondStore.read());
    assert.deepEqual(retained.streamAuthorities, []);
    assert.deepEqual(retained.lostAuthorities, []);
    assert.equal(retained.closeRecords[0].value.generation, opened.generation);
  } finally {
    h.cleanup();
  }
});

test("host-owner retirement is durable before BUSY and definite publish failure does not poison retry", async (t) => {
  await t.test("full control quota still retires the abandoned process", async () => {
    const h = harness();
    try {
      const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const firstAuthority = terminalAuthority(firstStore, {
        testLimits: { maxControlRecords: 2, maxStreams: 1 },
      });
      const original = terminalOpenClaim({ hostInstanceId: firstStore.hostInstanceId });
      const opened = await commitTerminalOpen(firstAuthority, original);

      const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const secondAuthority = terminalAuthority(secondStore, {
        testLimits: { maxControlRecords: 2, maxStreams: 1 },
      });
      const blocked = terminalOpenClaim({
        key: "terminal-open:busy-after-retirement",
        streamKey: "terminal-stream:busy-after-retirement",
        fingerprint: "6".repeat(64),
        hostInstanceId: secondStore.hostInstanceId,
      });
      assert.deepEqual(await secondAuthority.claimOpen(blocked), {
        status: "busy",
        reason: "control_record_quota",
      });
      const retired = terminalState(await secondStore.read());
      assert.equal(retired.activeHostInstanceId, secondStore.hostInstanceId);
      assert.deepEqual(retired.streamAuthorities, []);
      assert.equal(retired.lostAuthorities[0].generation, opened.generation);
      assert.equal(retired.openRecords[0].outcome.kind, "opened");
      assert.equal(retired.openRecords[0].outcome.generation, opened.generation);
      assert.deepEqual(await secondAuthority.claimOpen(blocked), {
        status: "busy",
        reason: "control_record_quota",
      });
      await assert.rejects(firstAuthority.releaseStreamReservation({
        streamKey: original.streamKey,
        generation: opened.generation,
        hostInstanceId: firstStore.hostInstanceId,
      }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CONFLICT");
    } finally {
      h.cleanup();
    }
  });

  await t.test("failure before state publication leaves the authority retryable", async () => {
    const h = harness();
    try {
      const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const firstAuthority = terminalAuthority(firstStore);
      const original = terminalOpenClaim({ hostInstanceId: firstStore.hostInstanceId });
      const opened = await commitTerminalOpen(firstAuthority, original);
      let failStateRename = true;
      const secondStore = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        renameFile: (source, destination) => {
          if (failStateRename && destination === h.paths.state) {
            failStateRename = false;
            throw new Error("injected prepublish owner-retirement failure");
          }
          renameSync(source, destination);
        },
      });
      const secondAuthority = terminalAuthority(secondStore);
      const resume = terminalOpenClaim({
        key: "terminal-open:retry-owner-retirement",
        fingerprint: "7".repeat(64),
        hostInstanceId: secondStore.hostInstanceId,
        mode: "resume",
        previousGeneration: opened.generation,
        requestedOffset: "0",
        resumeTokenHash: TOKEN_HASH_ONE,
      });
      await assert.rejects(secondAuthority.claimOpen(resume), /prepublish owner-retirement/);
      const afterFailure = terminalState(await firstStore.read());
      assert.equal(afterFailure.activeHostInstanceId, firstStore.hostInstanceId);
      assert.equal(afterFailure.streamAuthorities[0].generation, opened.generation);
      const retry = await secondAuthority.claimOpen(resume);
      assert.equal(retry.status, "replay");
      assert.equal(retry.outcome.reason, "stream_lost");
      assert.equal(terminalState(await secondStore.read()).activeHostInstanceId, secondStore.hostInstanceId);
    } finally {
      h.cleanup();
    }
  });
});

test("open admission reconciliation reuses exact post-retirement quota math", async (t) => {
  await t.test("control max-minus-one new claim remains BUSY after uncertain commit", async () => {
    const h = harness();
    try {
      const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
      const firstAuthority = terminalAuthority(firstStore, {
        testLimits: { maxControlRecords: 3, maxStreams: 1 },
      });
      await commitTerminalOpen(firstAuthority, terminalOpenClaim({
        hostInstanceId: firstStore.hostInstanceId,
      }));
      let failWitnessRename = true;
      const secondStore = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        renameFile: (source, destination) => {
          if (failWitnessRename && destination === h.paths.continuity) {
            failWitnessRename = false;
            throw new Error("injected BUSY witness failure");
          }
          renameSync(source, destination);
        },
      });
      const secondAuthority = terminalAuthority(secondStore, {
        testLimits: { maxControlRecords: 3, maxStreams: 1 },
      });
      assert.deepEqual(await secondAuthority.claimOpen(terminalOpenClaim({
        key: "terminal-open:uncertain-control-busy",
        streamKey: "terminal-stream:uncertain-control-busy",
        fingerprint: "8".repeat(64),
        hostInstanceId: secondStore.hostInstanceId,
      })), { status: "busy", reason: "control_record_quota" });
      const state = terminalState(await secondStore.read());
      assert.equal(state.activeHostInstanceId, secondStore.hostInstanceId);
      assert.equal(state.lostAuthorities.length, 1);
    } finally {
      h.cleanup();
    }
  });

  await t.test("closed reset remains live-quota BUSY after uncertain commit", async () => {
    const h = harness();
    try {
      let failWitnessRename = false;
      const store = await hostState.RelayV2HostStateStore.open({
        paths: h.paths,
        renameFile: (source, destination) => {
          if (failWitnessRename && destination === h.paths.continuity) {
            failWitnessRename = false;
            throw new Error("injected stream BUSY witness failure");
          }
          renameSync(source, destination);
        },
      });
      const authority = terminalAuthority(store, {
        testLimits: { maxControlRecords: 20, maxStreams: 1 },
      });
      const closedClaim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
      const closed = await commitTerminalOpen(authority, closedClaim);
      await authority.markStreamClosed({
        streamKey: closedClaim.streamKey,
        generation: closed.generation,
        hostInstanceId: store.hostInstanceId,
        expiresAtMs: 1_600_000,
      });
      const liveClaim = terminalOpenClaim({
        key: "terminal-open:uncertain-live-beside-closed",
        streamKey: "terminal-stream:uncertain-live-beside-closed",
        fingerprint: "9".repeat(64),
        hostInstanceId: store.hostInstanceId,
      });
      await commitTerminalOpen(authority, liveClaim, {
        resumeTokenHash: TOKEN_HASH_TWO,
      });
      const resetClosed = terminalOpenClaim({
        key: "terminal-open:uncertain-reset-closed",
        fingerprint: "a".repeat(64),
        hostInstanceId: store.hostInstanceId,
        mode: "reset",
        previousGeneration: closed.generation,
        requestedOffset: "0",
        resumeTokenHash: TOKEN_HASH_ONE,
      });
      failWitnessRename = true;
      assert.deepEqual(await authority.claimOpen(resetClosed), {
        status: "busy",
        reason: "control_record_quota",
      });
      assert.equal(failWitnessRename, false);
      const state = terminalState(await store.read());
      assert.deepEqual(state.streamAuthorities.map(({ status }) => status).sort(), [
        "closed",
        "live",
      ]);
      assert.equal(state.openRecords.some(({ key }) => key === resetClosed.key), false);
    } finally {
      h.cleanup();
    }
  });
});

test("reset completion and parsing preserve the full captured recovery tuple", async () => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const authority = terminalAuthority(store);
    const opened = await commitTerminalOpen(authority);
    const reset = terminalOpenClaim({
      key: "terminal-open:reset-tuple",
      fingerprint: "b".repeat(64),
      hostInstanceId: store.hostInstanceId,
      mode: "reset",
      previousGeneration: opened.generation,
      requestedOffset: "0",
      resumeTokenHash: TOKEN_HASH_ONE,
    });
    const winner = await authority.claimOpen(reset);
    assert.equal(winner.status, "claimed");
    assert.equal((await authority.prepareOpen({
      key: reset.key,
      fingerprint: reset.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      preparation: { kind: "current", resolution: terminalResolution() },
    })).status, "prepared");
    const snapshot = await store.read();
    const [key, value] = Object.entries(snapshot.materialized).find(([, candidate]) => (
      candidate?.authority === "relay_v2_terminal_durable_lineage"
    ));
    const damaged = structuredClone(value);
    damaged.openRecords.find((record) => record.key === reset.key).requestedOffset = "1";
    await store.transaction((transaction) => transaction.putMaterializedRecord(key, damaged));
    await assert.rejects(authority.completeOpen({
      key: reset.key,
      fingerprint: reset.fingerprint,
      hostInstanceId: store.hostInstanceId,
      claimToken: winner.claimToken,
      fence: winner.fence,
      outcome: {
        kind: "opened",
        generation: winner.issuedGeneration,
        resumeTokenHash: TOKEN_HASH_TWO,
        disposition: "reset",
        replayFromOffset: "0",
      },
    }), (error) => error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT");
    assert.equal(terminalState(await store.read()).streamAuthorities[0].generation, opened.generation);
  } finally {
    h.cleanup();
  }
});

test("generation high-water crosses the former history threshold without reuse", async () => {
  const h = harness();
  try {
    const firstStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const firstAuthority = terminalAuthority(firstStore);
    const seed = await firstAuthority.claimOpen(terminalOpenClaim({
      hostInstanceId: firstStore.hostInstanceId,
    }));
    assert.equal(seed.status, "claimed");
    await firstAuthority.failOpen({
      key: "terminal-open:one",
      fingerprint: "a".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
      claimToken: seed.claimToken,
      fence: seed.fence,
      outcome: { kind: "error", code: "BUSY", message: "seed" },
      streamEffect: { kind: "preserve" },
    });
    const snapshot = await firstStore.read();
    const [key, value] = Object.entries(snapshot.materialized).find(([, candidate]) => (
      candidate?.authority === "relay_v2_terminal_durable_lineage"
    ));
    await firstStore.transaction((transaction) => transaction.putMaterializedRecord(key, {
      ...value,
      generationHighWater: "4095",
    }));
    const atThreshold = await firstAuthority.claimOpen(terminalOpenClaim({
      key: "terminal-open:generation-4096",
      streamKey: "terminal-stream:generation-4096",
      fingerprint: "c".repeat(64),
      hostInstanceId: firstStore.hostInstanceId,
    }));
    assert.equal(atThreshold.status, "claimed");
    assert.ok(atThreshold.issuedGeneration.endsWith("-4096"));

    const secondStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const secondAuthority = terminalAuthority(secondStore);
    const afterRestart = await secondAuthority.claimOpen(terminalOpenClaim({
      key: "terminal-open:generation-4097",
      streamKey: "terminal-stream:generation-4097",
      fingerprint: "d".repeat(64),
      hostInstanceId: secondStore.hostInstanceId,
    }));
    assert.equal(afterRestart.status, "claimed");
    assert.ok(afterRestart.issuedGeneration.endsWith("-4097"));
    assert.notEqual(afterRestart.issuedGeneration, atThreshold.issuedGeneration);
  } finally {
    h.cleanup();
  }
});

test("HostState terminal parser rejects generation reuse across incompatible durable lineages", async (t) => {
  const h = harness();
  try {
    const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const authority = terminalAuthority(store);
    const firstClaim = terminalOpenClaim({ hostInstanceId: store.hostInstanceId });
    const first = await commitTerminalOpen(authority, firstClaim);
    const secondClaim = terminalOpenClaim({
      key: "terminal-open:generation-lineage-two",
      streamKey: "terminal-stream:generation-lineage-two",
      fingerprint: "2".repeat(64),
      hostInstanceId: store.hostInstanceId,
    });
    const second = await commitTerminalOpen(authority, secondClaim, {
      resumeTokenHash: TOKEN_HASH_TWO,
    });
    const closeIntent = {
      key: "terminal-close:generation-lineage-one",
      streamKey: firstClaim.streamKey,
      fingerprint: "3".repeat(64),
      hostInstanceId: store.hostInstanceId,
      target: { ...TERMINAL_TARGET },
      streamId: "stream-generation-lineage-one",
      closeId: "close-generation-lineage-one",
      requestId: "request-generation-lineage-one",
      requestRoute: {
        connectorId: "connector-generation-lineage-one",
        routeId: "route-generation-lineage-one",
        routeFence: "route-fence-generation-lineage-one",
      },
      generation: first.generation,
      finalOffset: "7",
      reason: "client_closed",
      exitCode: null,
      expiresAtMs: 1_600_000,
    };
    assert.equal((await authority.claimClose({
      key: closeIntent.key,
      fingerprint: closeIntent.fingerprint,
      hostInstanceId: store.hostInstanceId,
      intent: closeIntent,
    })).status, "claimed");

    const snapshot = await store.read();
    const [key, value] = Object.entries(snapshot.materialized).find(([, candidate]) => (
      candidate?.authority === "relay_v2_terminal_durable_lineage"
    ));
    const base = structuredClone(value);
    const cases = [
      {
        name: "pending unused issued generation overlaps executable authority",
        damage: (state) => {
          const record = state.openRecords.find(
            (candidate) => candidate.key === secondClaim.key,
          );
          record.status = "pending";
          record.outcome = null;
          record.reservesStreamSlot = true;
          return state;
        },
      },
      {
        name: "final reset unused issued generation overlaps executable authority",
        damage: (state) => {
          const record = state.openRecords.find(
            (candidate) => candidate.key === secondClaim.key,
          );
          record.outcome = {
            kind: "reset",
            generation: record.issuedGeneration,
            reason: "stream_lost",
            requestedOffset: null,
            bufferStartOffset: null,
            tailOffset: null,
          };
          return state;
        },
      },
      {
        name: "executable and lost authorities reuse one generation",
        damage: (state) => {
          const stream = state.streamAuthorities.find(
            (candidate) => candidate.streamKey === secondClaim.streamKey,
          );
          state.lostAuthorities.push({
            streamKey: "terminal-stream:incompatible-lost-lineage",
            generation: stream.generation,
            ownerHostInstanceId: stream.hostInstanceId,
            target: { ...stream.target },
            pane: stream.pane,
            resumeTokenHash: stream.resumeTokenHash,
            canonicalBinding: structuredClone(stream.canonicalBinding),
            expiresAtMs: 1_600_000,
          });
          return state;
        },
      },
      {
        name: "issued and opened generation is reused by another stream",
        damage: (state) => {
          const record = state.openRecords.find(
            (candidate) => candidate.key === secondClaim.key,
          );
          record.issuedGeneration = first.generation;
          record.outcome.generation = first.generation;
          return state;
        },
      },
      {
        name: "opened outcome disagrees with the authority token binding",
        damage: (state) => {
          const record = state.openRecords.find(
            (candidate) => candidate.key === secondClaim.key,
          );
          record.outcome.resumeTokenHash = TOKEN_HASH_ONE;
          return state;
        },
      },
      {
        name: "opened preparation and current stream fork the canonical binding",
        damage: (state) => {
          const record = state.openRecords.find(
            (candidate) => candidate.key === secondClaim.key,
          );
          record.preparedBinding.exactControlIdentity.controlEpoch =
            "forked-prepared-control-epoch";
          return state;
        },
      },
      {
        name: "close binding reuses another stream generation",
        damage: (state) => {
          const close = structuredClone(state.closeRecords[0]);
          close.value.key = "terminal-close:incompatible-generation-lineage";
          close.value.streamKey = secondClaim.streamKey;
          close.value.fingerprint = "4".repeat(64);
          close.value.streamId = "stream-incompatible-generation-lineage";
          close.value.closeId = "close-incompatible-generation-lineage";
          close.value.requestId = "request-incompatible-generation-lineage";
          state.closeRecords.push(close);
          return state;
        },
      },
      {
        name: "live executable authority contradicts its exact committed close",
        damage: (state) => {
          const stream = state.streamAuthorities.find(
            (candidate) => candidate.streamKey === firstClaim.streamKey,
          );
          stream.status = "live";
          stream.closedExpiresAtMs = null;
          return state;
        },
      },
      {
        name: "exact committed close claims a different process owner",
        damage: (state) => {
          state.closeRecords[0].value.hostInstanceId = "different-close-stream-owner";
          return state;
        },
      },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const damaged = scenario.damage(structuredClone(base));
        await store.transaction((transaction) => {
          transaction.putMaterializedRecord(key, damaged);
        });
        const before = await store.read();
        await assert.rejects(authority.claimOpen(terminalOpenClaim({
          key: "terminal-open:after-generation-reuse",
          streamKey: "terminal-stream:after-generation-reuse",
          fingerprint: "9".repeat(64),
          hostInstanceId: store.hostInstanceId,
        })), (error) => (
          error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT"
        ));
        const after = await store.read();
        assert.equal(after.commitSeq, before.commitSeq);
        assert.deepEqual(after.materialized[key], damaged);
        await store.transaction((transaction) => {
          transaction.putMaterializedRecord(key, base);
        });
      });
    }
    assert.notEqual(first.generation, second.generation);
  } finally {
    h.cleanup();
  }
});

test("HostState terminal nested corrupt and future schemas fail closed without repair", async (t) => {
  const cases = [
    {
      name: "future schema",
      damage: (value) => ({ ...value, schemaVersion: 4 }),
    },
    {
      name: "retired weaker schema",
      damage: (value) => ({ ...value, schemaVersion: 2 }),
    },
    {
      name: "unknown field",
      damage: (value) => ({ ...value, unexpected: true }),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = harness();
      try {
        const store = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
        const authority = terminalAuthority(store);
        await authority.claimOpen(terminalOpenClaim({
          hostInstanceId: store.hostInstanceId,
        }));
        const snapshot = await store.read();
        const [key, value] = Object.entries(snapshot.materialized).find(([, candidate]) => (
          candidate?.authority === "relay_v2_terminal_durable_lineage"
        ));
        const damaged = scenario.damage(structuredClone(value));
        await store.transaction((transaction) => {
          transaction.putMaterializedRecord(key, damaged);
        });
        const before = await store.read();
        await assert.rejects(authority.claimOpen(terminalOpenClaim({
          key: "terminal-open:after-damage",
          streamKey: "terminal-stream:after-damage",
          fingerprint: "9".repeat(64),
          hostInstanceId: store.hostInstanceId,
        })), (error) => (
          error.code === "RELAY_V2_TERMINAL_DURABLE_LINEAGE_CORRUPT"
        ));
        const after = await store.read();
        assert.equal(after.commitSeq, before.commitSeq);
        assert.deepEqual(after.materialized[key], damaged);
      } finally {
        h.cleanup();
      }
    });
  }
});
