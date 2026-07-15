import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");

class QueueDiscovery {
  #scans = [];

  push(scan) {
    this.#scans.push(structuredClone(scan));
  }

  async scan() {
    const scan = this.#scans.shift();
    if (!scan) throw new Error("snapshot test must not perform live discovery");
    return structuredClone(scan);
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

function scope(sessions = [], overrides = {}) {
  return {
    backendIdentity: "local",
    displayName: "Local",
    kind: "local",
    reachability: "online",
    sessionsCompleteness: "complete",
    sessions,
    error: null,
    ...overrides,
  };
}

async function realHarness({ sessions = [], scopes, spoolLimits } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-spool-"));
  const paths = hostState.relayV2HostStatePaths(home);
  const store = await hostState.RelayV2HostStateStore.open({ paths });
  const discovery = new QueueDiscovery();
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: "mac-admin",
    discovery,
    store,
    readinessSink: { apply: () => true },
  });
  discovery.push({
    coverage: "complete",
    scopes: scopes ?? [scope(sessions)],
  });
  const seeded = await foundation.reconcile();
  const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
    hostId: "mac-admin",
    cutSource: foundation.snapshotCutSource,
    root: join(home, "snapshot-spool"),
    testLimits: spoolLimits,
  });
  return {
    home,
    paths,
    store,
    discovery,
    foundation,
    seeded,
    spool,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function firstRequest(hostEpoch, snapshotRequestId, overrides = {}) {
  return {
    principalId: "principal-one",
    clientInstanceId: "client-one",
    expectedHostEpoch: hostEpoch,
    snapshotRequestId,
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
    ...overrides,
  };
}

function continuation(first, overrides = {}) {
  return {
    principalId: "principal-one",
    clientInstanceId: "client-one",
    expectedHostEpoch: first.hostEpoch,
    snapshotRequestId: first.snapshotRequestId,
    snapshotId: first.snapshotId,
    cursor: first.nextCursor,
    nextChunkIndex: first.chunkIndex + 1,
    ...overrides,
  };
}

function releaseRequest(chunk, overrides = {}) {
  return {
    principalId: "principal-one",
    clientInstanceId: "client-one",
    expectedHostEpoch: chunk.hostEpoch,
    snapshotRequestId: chunk.snapshotRequestId,
    snapshotId: chunk.snapshotId,
    reason: "completed",
    ...overrides,
  };
}

async function collectCut(spool, request) {
  const chunks = [];
  let next = request;
  while (true) {
    const chunk = await spool.get(next);
    chunks.push(chunk);
    if (chunk.isLast) break;
    next = continuation(chunk);
  }
  return chunks;
}

function assertSpoolError(code) {
  return (error) => {
    assert.ok(error instanceof snapshotSpool.RelayV2StateSnapshotSpoolError);
    assert.equal(error.code, code);
    return true;
  };
}

function staticCut(records = [], hostEpoch = "authority-epoch") {
  return {
    hostEpoch,
    throughEventSeq: "7",
    scopesRevision: "3",
    records: structuredClone(records),
  };
}

function canonicalCutBytes(records) {
  return Buffer.from(
    resourceState.canonicalizeRelayV2MaterializedJson(records),
    "utf8",
  );
}

function staticSource(cut, overrides = {}) {
  const calls = { current: 0, estimate: 0, capture: 0 };
  return {
    calls,
    source: {
      async currentHostEpoch() {
        calls.current += 1;
        if (overrides.currentHostEpoch) return overrides.currentHostEpoch();
        return cut.hostEpoch;
      },
      async admissionEstimate(expectedHostEpoch) {
        calls.estimate += 1;
        if (overrides.admissionEstimate) {
          return overrides.admissionEstimate(expectedHostEpoch);
        }
        const bytes = canonicalCutBytes(cut.records);
        return {
          hostEpoch: cut.hostEpoch,
          totalRecords: cut.records.length,
          totalCanonicalBytes: bytes.byteLength,
        };
      },
      async capture(expectedHostEpoch) {
        calls.capture += 1;
        if (overrides.capture) return overrides.capture(expectedHostEpoch);
        return structuredClone(cut);
      },
    },
  };
}

async function fakeSpool({ cut = staticCut(), limits, now, source } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-fake-"));
  const fake = source ?? staticSource(cut);
  const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
    hostId: "mac-admin",
    cutSource: fake.source,
    root: join(home, "spool"),
    now,
    testLimits: limits,
  });
  return {
    home,
    fake,
    spool,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("materialized cut admission is conservative while H1 reservations never become snapshot records", async () => {
  const h = await realHarness();
  try {
    const scopes = (await h.foundation.scopesSnapshot(
      "scope-for-reservation",
      h.seeded.snapshot.hostEpoch,
    )).payload.items;
    const scopeId = scopes[0].scopeId;
    const fingerprint = {
      schemaVersion: 1,
      algorithm: "sha256-rfc8785",
      digest: "a".repeat(64),
    };
    const reserved = await h.store.transaction((transaction) => (
      h.foundation.commandResourceMutationOwner.reserve(transaction, {
        schemaVersion: 1,
        owner: "relay_v2_resource_state",
        operation: "create_terminal",
        principalId: "principal-reservation",
        hostId: "mac-admin",
        hostEpoch: h.seeded.snapshot.hostEpoch,
        commandId: "command-reservation",
        requestFingerprint: fingerprint,
        scopeId,
        reservationPlan: {
          logicalTarget: { scopeId, label: "pending" },
          session: {
            kind: "terminal",
            displayName: "pending",
            state: "running",
            project: null,
            label: "pending",
            cwd: "/repo/pending",
            attached: false,
            windowCount: 1,
            createdAtMs: 1_783_699_000_000,
            activityAtMs: 1_783_700_000_000,
          },
        },
      })
    ));
    assert.equal(reserved.value.kind, "reserved");

    const estimate = await h.foundation.snapshotCutSource.admissionEstimate(
      h.seeded.snapshot.hostEpoch,
    );
    const cut = await h.foundation.snapshotCutSource.capture(h.seeded.snapshot.hostEpoch);
    assert.equal(estimate.totalRecords, 3, "one conservative Session slot is charged");
    assert.equal(cut.records.length, 2, "only scope and sessions_scope are projected");
    assert.deepEqual(cut.records.map((record) => record.recordType), [
      "scope",
      "sessions_scope",
    ]);
    assert.ok(estimate.totalCanonicalBytes > canonicalCutBytes(cut.records).byteLength);

    const chunk = await h.spool.get(firstRequest(
      h.seeded.snapshot.hostEpoch,
      "logical-reservation-cut",
    ));
    assert.equal(chunk.totalRecords, 2);
    assert.equal(JSON.stringify(chunk.records).includes("reservation"), false);
  } finally {
    h.cleanup();
  }
});

test("exact first retry remains pinned after live materialized state changes", async () => {
  const h = await realHarness({ sessions: [terminal("pane:a", "alpha")] });
  try {
    const epoch = h.seeded.snapshot.hostEpoch;
    const request = firstRequest(epoch, "logical-pinned-cut");
    const first = await h.spool.get(request);

    h.discovery.push({
      coverage: "complete",
      scopes: [scope([
        terminal("pane:a", "alpha", 1_783_700_000_100),
        terminal("pane:b", "beta"),
      ])],
    });
    await h.foundation.reconcile();

    const retry = await h.spool.get(request);
    assert.equal(retry.snapshotId, first.snapshotId);
    assert.equal(retry.cutDigest, first.cutDigest);
    assert.equal(retry.nextCursor, first.nextCursor);
    assert.deepEqual(retry.records, first.records);
    assert.equal(retry.throughEventSeq, first.throughEventSeq);

    const newer = await h.spool.get(firstRequest(epoch, "logical-newer-cut"));
    assert.notEqual(newer.snapshotId, first.snapshotId);
    assert.notEqual(newer.cutDigest, first.cutDigest);
    assert.ok(BigInt(newer.throughEventSeq) > BigInt(first.throughEventSeq));
    assert.ok(newer.totalRecords > first.totalRecords);
  } finally {
    h.cleanup();
  }
});

test("chunking accounts for canonical array delimiters and empty cuts digest as []", async (t) => {
  await t.test("ordered multi-chunk cut", async () => {
    const h = await realHarness({
      sessions: [
        terminal("pane:c", "charlie"),
        terminal("pane:a", "alpha"),
        terminal("pane:b", "beta"),
      ],
      spoolLimits: { maxChunkRecords: 2 },
    });
    try {
      const chunks = await collectCut(
        h.spool,
        firstRequest(h.seeded.snapshot.hostEpoch, "logical-chunked"),
      );
      assert.ok(chunks.length > 1);
      const records = chunks.flatMap((chunk) => chunk.records);
      for (const [index, chunk] of chunks.entries()) {
        const chunkBytes = canonicalCutBytes(chunk.records);
        assert.ok(chunk.records.length <= 2);
        assert.ok(chunkBytes.byteLength <= 524_288);
        assert.equal(chunk.chunkIndex, index);
        assert.equal(chunk.isLast, index === chunks.length - 1);
        assert.equal(chunk.nextCursor === null, chunk.isLast);
        assert.equal(chunk.snapshotId, chunks[0].snapshotId);
        assert.equal(chunk.cutDigest, chunks[0].cutDigest);
      }
      const canonical = canonicalCutBytes(records);
      assert.equal(chunks[0].totalCanonicalBytes, canonical.byteLength);
      assert.equal(
        chunks[0].cutDigest,
        createHash("sha256").update(canonical).digest("base64url"),
      );
      assert.deepEqual(records.slice(0, 2).map((record) => record.recordType), [
        "scope",
        "sessions_scope",
      ]);
      const sessionIds = records
        .filter((record) => record.recordType === "session")
        .map((record) => record.item.sessionId);
      const sorted = [...sessionIds].sort((left, right) => (
        Buffer.compare(Buffer.from(left), Buffer.from(right))
      ));
      assert.deepEqual(sessionIds, sorted);
    } finally {
      h.cleanup();
    }
  });

  await t.test("empty materialized authority", async () => {
    const h = await realHarness({ scopes: [] });
    try {
      const chunk = await h.spool.get(firstRequest(
        h.seeded.snapshot.hostEpoch,
        "logical-empty-cut",
      ));
      assert.equal(chunk.chunkIndex, 0);
      assert.equal(chunk.isLast, true);
      assert.equal(chunk.nextCursor, null);
      assert.deepEqual(chunk.records, []);
      assert.equal(chunk.totalRecords, 0);
      assert.equal(chunk.totalCanonicalBytes, 2);
      assert.equal(
        chunk.cutDigest,
        createHash("sha256").update("[]").digest("base64url"),
      );
    } finally {
      h.cleanup();
    }
  });
});

test("host slots reach sixteen small cuts while byte quota remains independent", async (t) => {
  await t.test("sixteen principals and exact retry", async () => {
    let startedCount = 0;
    let allCapturesStarted;
    let releaseCaptures;
    const started = new Promise((resolve) => { allCapturesStarted = resolve; });
    const release = new Promise((resolve) => { releaseCaptures = resolve; });
    const cut = staticCut();
    const fake = staticSource(cut, {
      async capture() {
        startedCount += 1;
        if (startedCount === 16) allCapturesStarted();
        await release;
        return structuredClone(cut);
      },
    });
    const h = await fakeSpool({ source: fake });
    try {
      const pending = Array.from({ length: 16 }, (_, index) => (
        h.spool.get(firstRequest("authority-epoch", `logical-${index}`, {
          principalId: `principal-${index}`,
          clientInstanceId: `client-${index}`,
        }))
      ));
      await started;
      assert.equal(readdirSync(h.spool.paths.reservations).length, 16);
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-17", {
          principalId: "principal-17",
          clientInstanceId: "client-17",
        })),
        assertSpoolError("BUSY"),
      );
      const estimateCalls = h.fake.calls.estimate;
      const retryPending = h.spool.get(firstRequest("authority-epoch", "logical-0", {
        principalId: "principal-0",
        clientInstanceId: "client-0",
      }));
      releaseCaptures();
      const cuts = await Promise.all(pending);
      const retry = await retryPending;
      assert.equal(new Set(cuts.map((built) => built.snapshotId)).size, 16);
      assert.equal(retry.snapshotId, cuts[0].snapshotId);
      assert.equal(h.fake.calls.estimate, estimateCalls, "exact retry bypasses new admission");
      assert.equal(readdirSync(h.spool.paths.cuts).length, 16);
    } finally {
      releaseCaptures();
      h.cleanup();
    }
  });

  await t.test("canonical byte quota", async () => {
    const records = [
      {
        recordType: "scope",
        item: {
          scopeId: "scope-a",
          displayName: "x".repeat(180),
          kind: "local",
          reachability: "online",
        },
      },
      {
        recordType: "sessions_scope",
        scopeId: "scope-a",
        revision: "1",
        completeness: "complete",
      },
    ];
    const bytes = canonicalCutBytes(records).byteLength;
    const h = await fakeSpool({
      cut: staticCut(records),
      limits: {
        maxChunkCanonicalBytes: bytes,
        maxCutCanonicalBytes: bytes,
        maxSpoolCanonicalBytes: bytes * 2 - 1,
      },
    });
    try {
      await h.spool.get(firstRequest("authority-epoch", "byte-cut-one", {
        principalId: "byte-principal-one",
      }));
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "byte-cut-two", {
          principalId: "byte-principal-two",
          clientInstanceId: "client-two",
        })),
        assertSpoolError("BUSY"),
      );
      assert.equal(readdirSync(h.spool.paths.cuts).length, 1);
    } finally {
      h.cleanup();
    }
  });
});

test("concurrent first build reserves once and rejects estimate undercharge before publication", async (t) => {
  await t.test("same logical request waits on one BUILDING reservation", async () => {
    let captureStarted;
    let releaseCapture;
    const started = new Promise((resolve) => { captureStarted = resolve; });
    const release = new Promise((resolve) => { releaseCapture = resolve; });
    const cut = staticCut();
    const fake = staticSource(cut, {
      async capture() {
        captureStarted();
        await release;
        return structuredClone(cut);
      },
    });
    const h = await fakeSpool({
      source: fake,
      limits: { maxCutsPerHost: 1, maxCutsPerPrincipal: 1 },
    });
    try {
      const request = firstRequest("authority-epoch", "logical-concurrent");
      const first = h.spool.get(request);
      await started;
      const retry = h.spool.get(request);
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-competing", {
          principalId: "principal-two",
          clientInstanceId: "client-two",
        })),
        assertSpoolError("BUSY"),
      );
      releaseCapture();
      const [left, right] = await Promise.all([first, retry]);
      assert.equal(left.snapshotId, right.snapshotId);
      assert.equal(fake.calls.estimate, 2, "the competing logical cut alone estimates again");
      assert.equal(fake.calls.capture, 1);
      assert.deepEqual(readdirSync(h.spool.paths.reservations), []);
    } finally {
      h.cleanup();
    }
  });

  await t.test("capture larger than admission estimate", async () => {
    const actual = staticCut([
      {
        recordType: "scope",
        item: {
          scopeId: "scope-a",
          displayName: "Local",
          kind: "local",
          reachability: "online",
        },
      },
      {
        recordType: "sessions_scope",
        scopeId: "scope-a",
        revision: "1",
        completeness: "complete",
      },
    ]);
    const fake = staticSource(actual, {
      admissionEstimate: async () => ({
        hostEpoch: actual.hostEpoch,
        totalRecords: 0,
        totalCanonicalBytes: 2,
      }),
    });
    const h = await fakeSpool({ source: fake });
    try {
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-undercharged")),
        assertSpoolError("BUSY"),
      );
      assert.deepEqual(readdirSync(h.spool.paths.cuts), []);
      assert.deepEqual(readdirSync(h.spool.paths.staging), []);
      assert.deepEqual(readdirSync(h.spool.paths.reservations), []);
    } finally {
      h.cleanup();
    }
  });
});

test("idle lease extends monotonically only to absolute expiry and removes BUILDING state", async () => {
  let now = 1_000;
  const h = await fakeSpool({
    now: () => now,
    limits: { idleLeaseMs: 100, absoluteLeaseMs: 250 },
  });
  try {
    const request = firstRequest("authority-epoch", "logical-lease");
    const initial = await h.spool.get(request);
    assert.equal(initial.snapshotLeaseExpiresAtMs, 1_100);
    assert.equal(initial.snapshotAbsoluteExpiresAtMs, 1_250);

    now = 1_050;
    assert.equal((await h.spool.get(request)).snapshotLeaseExpiresAtMs, 1_150);
    now = 1_040;
    assert.equal((await h.spool.get(request)).snapshotLeaseExpiresAtMs, 1_150);
    now = 1_140;
    assert.equal((await h.spool.get(request)).snapshotLeaseExpiresAtMs, 1_240);
    now = 1_200;
    assert.equal((await h.spool.get(request)).snapshotLeaseExpiresAtMs, 1_250);
    now = 1_250;
    await assert.rejects(h.spool.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
    assert.deepEqual(readdirSync(h.spool.paths.cuts), []);

    now = 2_000;
    await h.spool.get(firstRequest("authority-epoch", "logical-idle"));
    now = 2_100;
    await assert.rejects(
      h.spool.get(firstRequest("authority-epoch", "logical-idle")),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );

    let releaseCapture;
    let captureStarted;
    const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
    const started = new Promise((resolve) => { captureStarted = resolve; });
    const delayed = staticSource(staticCut(), {
      async capture() {
        captureStarted();
        await captureGate;
        return staticCut();
      },
    });
    const delayedSpool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: delayed.source,
      root: join(h.home, "delayed-spool"),
      now: () => now,
      testLimits: { idleLeaseMs: 100, absoluteLeaseMs: 250 },
    });
    const pending = delayedSpool.get(firstRequest("authority-epoch", "logical-building-expiry"));
    await started;
    now = 2_351;
    await delayedSpool.cleanupExpired();
    assert.deepEqual(readdirSync(delayedSpool.paths.reservations), []);
    releaseCapture();
    await assert.rejects(pending, assertSpoolError("SNAPSHOT_EXPIRED"));
    assert.deepEqual(readdirSync(delayedSpool.paths.staging), []);
  } finally {
    h.cleanup();
  }
});

test("release frees the cut before ACK and tombstones only the original binding", async () => {
  let now = 10_000;
  const h = await fakeSpool({ now: () => now });
  try {
    const chunk = await h.spool.get(firstRequest("authority-epoch", "logical-release"));
    await assert.rejects(
      h.spool.release(releaseRequest(chunk, { principalId: "other-principal" })),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );
    assert.equal(readdirSync(h.spool.paths.cuts).length, 1);

    const released = await h.spool.release(releaseRequest(chunk));
    assert.deepEqual(released, {
      hostEpoch: "authority-epoch",
      snapshotRequestId: "logical-release",
      snapshotId: chunk.snapshotId,
      released: true,
      alreadyReleased: false,
      releasedAtMs: 10_000,
    });
    assert.deepEqual(readdirSync(h.spool.paths.cuts), []);

    now = 10_001;
    const replay = await h.spool.release(releaseRequest(chunk));
    assert.equal(replay.released, false);
    assert.equal(replay.alreadyReleased, true);
    assert.equal(replay.releasedAtMs, released.releasedAtMs);
    await assert.rejects(
      h.spool.release(releaseRequest(chunk, { clientInstanceId: "other-client" })),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );
    await assert.rejects(
      h.spool.release(releaseRequest(chunk, { snapshotId: "snap_unknown" })),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );

    now = released.releasedAtMs + 600_000;
    await h.spool.cleanupExpired();
    assert.deepEqual(readdirSync(h.spool.paths.tombstones), []);
    await assert.rejects(
      h.spool.release(releaseRequest(chunk)),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );
  } finally {
    h.cleanup();
  }
});

test("restart recovers valid same-epoch final cuts, cleans crash orphans, and enforces modes", async () => {
  const h = await realHarness({ sessions: [terminal("pane:a", "alpha")] });
  try {
    const epoch = h.seeded.snapshot.hostEpoch;
    const request = firstRequest(epoch, "logical-recovery");
    const first = await h.spool.get(request);
    mkdirSync(join(h.spool.paths.staging, "building.tmp"), { mode: 0o700 });
    writeFileSync(join(h.spool.paths.staging, "building.tmp", "partial"), "partial", {
      mode: 0o600,
    });
    writeFileSync(join(h.spool.paths.reservations, "building.json"), "{}\n", { mode: 0o600 });
    const corrupt = join(h.spool.paths.cuts, "snap_corrupt");
    mkdirSync(corrupt, { mode: 0o700 });
    writeFileSync(join(corrupt, "manifest-v1.json"), "{}\n", { mode: 0o600 });

    const restartedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    assert.notEqual(restartedStore.hostInstanceId, h.store.hostInstanceId);
    const restartedFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: restartedStore,
      readinessSink: { apply: () => true },
    });
    const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: restartedFoundation.snapshotCutSource,
      root: h.spool.paths.root,
    });
    assert.deepEqual(readdirSync(restarted.paths.staging), []);
    assert.deepEqual(readdirSync(restarted.paths.reservations), []);
    assert.equal(readdirSync(restarted.paths.cuts).includes("snap_corrupt"), false);
    const recovered = await restarted.get(request);
    assert.equal(recovered.snapshotId, first.snapshotId);
    assert.deepEqual(recovered.records, first.records);

    const inspectModes = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        const mode = statSync(child).mode & 0o777;
        if (entry.isDirectory()) {
          assert.equal(mode, 0o700, child);
          inspectModes(child);
        } else {
          assert.equal(mode, 0o600, child);
        }
      }
    };
    assert.equal(statSync(restarted.paths.root).mode & 0o777, 0o700);
    inspectModes(restarted.paths.root);

    const cutDirectory = join(restarted.paths.cuts, first.snapshotId);
    const chunkFile = readdirSync(cutDirectory).find((name) => name.startsWith("chunk-"));
    chmodSync(join(cutDirectory, chunkFile), 0o600);
    writeFileSync(join(cutDirectory, chunkFile), "[]", { mode: 0o600 });
    const corruptRecovery = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: restartedFoundation.snapshotCutSource,
      root: restarted.paths.root,
    });
    assert.deepEqual(readdirSync(corruptRecovery.paths.cuts), []);
    await assert.rejects(corruptRecovery.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));

    const manifestVictim = await corruptRecovery.get(firstRequest(
      epoch,
      "logical-corrupt-manifest",
    ));
    writeFileSync(
      join(corruptRecovery.paths.cuts, manifestVictim.snapshotId, "manifest-v1.json"),
      "{}\n",
      { mode: 0o600 },
    );
    const manifestRecovery = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: restartedFoundation.snapshotCutSource,
      root: restarted.paths.root,
    });
    assert.deepEqual(readdirSync(manifestRecovery.paths.cuts), []);
    await assert.rejects(
      manifestRecovery.get(firstRequest(epoch, "logical-corrupt-manifest")),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );

    const replacement = await manifestRecovery.get(firstRequest(
      epoch,
      "logical-before-epoch-loss",
    ));
    rmSync(h.paths.continuity, { force: true });
    const rotatedStore = await hostState.RelayV2HostStateStore.open({ paths: h.paths });
    const rotatedSnapshot = await rotatedStore.read();
    assert.notEqual(rotatedSnapshot.hostEpoch, epoch);
    const rotatedFoundation = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: "mac-admin",
      discovery: new QueueDiscovery(),
      store: rotatedStore,
      readinessSink: { apply: () => true },
    });
    const rotated = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: rotatedFoundation.snapshotCutSource,
      root: restarted.paths.root,
    });
    assert.deepEqual(readdirSync(rotated.paths.cuts), []);
    await assert.rejects(
      rotated.get(firstRequest(epoch, replacement.snapshotRequestId)),
      assertSpoolError("HOST_EPOCH_MISMATCH"),
    );
  } finally {
    h.cleanup();
  }
});

test("cursor, index, readiness, and source failures are structured and never return partial cuts", async (t) => {
  await t.test("cursor and identity binding", async () => {
    const h = await realHarness({
      sessions: [terminal("pane:a", "alpha")],
      spoolLimits: { maxChunkRecords: 2 },
    });
    try {
      const first = await h.spool.get(firstRequest(
        h.seeded.snapshot.hostEpoch,
        "logical-cursor",
      ));
      assert.equal(first.isLast, false);
      await assert.rejects(
        h.spool.get(continuation(first, { cursor: "forged-cursor" })),
        assertSpoolError("INVALID_ARGUMENT"),
      );
      await assert.rejects(
        h.spool.get(continuation(first, { nextChunkIndex: 99 })),
        assertSpoolError("INVALID_ARGUMENT"),
      );
      await assert.rejects(
        h.spool.get(continuation(first, { principalId: "other-principal" })),
        assertSpoolError("SNAPSHOT_EXPIRED"),
      );
      const valid = await h.spool.get(continuation(first));
      const retry = await h.spool.get(continuation(first));
      assert.deepEqual(retry.records, valid.records);
      assert.equal(retry.nextCursor, valid.nextCursor);
    } finally {
      h.cleanup();
    }
  });

  await t.test("materialized readiness", async () => {
    const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-unready-"));
    try {
      const store = await hostState.RelayV2HostStateStore.open({
        paths: hostState.relayV2HostStatePaths(home),
      });
      const foundation = new resourceState.RelayV2MaterializedStateFoundation({
        hostId: "mac-admin",
        discovery: new QueueDiscovery(),
        store,
        readinessSink: { apply: () => true },
      });
      const epoch = (await store.read()).hostEpoch;
      const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
        hostId: "mac-admin",
        cutSource: foundation.snapshotCutSource,
        root: join(home, "spool"),
      });
      await assert.rejects(
        spool.get(firstRequest(epoch, "logical-unready")),
        assertSpoolError("CAPABILITY_UNAVAILABLE"),
      );
      assert.deepEqual(readdirSync(spool.paths.reservations), []);
      assert.deepEqual(readdirSync(spool.paths.cuts), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test("materialized read failure", async () => {
    const fake = staticSource(staticCut(), {
      capture: async () => { throw new Error("injected materialized read failure"); },
    });
    const h = await fakeSpool({ source: fake });
    try {
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-read-failure")),
        assertSpoolError("INTERNAL"),
      );
      assert.deepEqual(readdirSync(h.spool.paths.staging), []);
      assert.deepEqual(readdirSync(h.spool.paths.reservations), []);
      assert.deepEqual(readdirSync(h.spool.paths.cuts), []);
    } finally {
      h.cleanup();
    }
  });

  assert.deepEqual(snapshotSpool.RELAY_V2_STATE_SNAPSHOT_LIMITS, {
    maxChunkRecords: 256,
    maxChunkCanonicalBytes: 524_288,
    maxCutRecords: 100_000,
    maxCutCanonicalBytes: 268_435_456,
    idleLeaseMs: 300_000,
    absoluteLeaseMs: 3_600_000,
    maxCutsPerPrincipal: 2,
    maxCutsPerHost: 16,
    maxSpoolCanonicalBytes: 536_870_912,
    maxMetadataBytes: 16_777_216,
    releaseTombstoneMs: 600_000,
  });
  await assert.rejects(
    snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: staticSource(staticCut()).source,
      root: join(tmpdir(), `tw-snapshot-invalid-${Date.now()}`),
      testLimits: { maxCutsPerHost: 17 },
    }),
    /widened/,
  );
});
