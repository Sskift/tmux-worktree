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
