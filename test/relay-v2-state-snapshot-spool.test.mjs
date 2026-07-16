import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");
const snapshotSpoolChild = fileURLToPath(new URL(
  "./fixtures/relay-v2-state-snapshot-spool-child.mjs",
  import.meta.url,
));

function spawnSnapshotSpoolChild(root, options = {}) {
  const child = fork(snapshotSpoolChild, [], {
    env: {
      ...process.env,
      ...options.environment,
      HOME: dirname(root),
      SNAPSHOT_SPOOL_ROOT: root,
      SNAPSHOT_SPOOL_CHILD_MODE: options.mode ?? "worker",
      SNAPSHOT_SPOOL_OWNER: options.owner ?? `owner-${Math.random()}`,
      SNAPSHOT_SPOOL_TAKEOVER: options.takeover ? "1" : "0",
      SNAPSHOT_SPOOL_HOLD_FIRST: options.holdFirst ? "1" : "0",
      SNAPSHOT_SPOOL_HOLD_STALE: options.holdStale ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const queued = [];
  const waiters = [];
  child.on("message", (message) => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message?.type);
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  const message = (type) => {
    const queuedIndex = queued.findIndex((item) => item?.type === type);
    if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject };
      waiters.push(waiter);
      child.once("exit", (code) => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new Error(`snapshot spool child exited ${code} before ${type}`));
        }
      });
    });
  };
  return {
    child,
    message,
    send: (value) => child.send(value),
    exit: () => child.exitCode === null
      ? once(child, "exit")
      : Promise.resolve([child.exitCode, child.signalCode]),
  };
}

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
  const calls = { current: 0, fence: 0, estimate: 0, capture: 0 };
  return {
    calls,
    source: {
      async currentHostEpoch() {
        calls.current += 1;
        if (overrides.currentHostEpoch) return overrides.currentHostEpoch();
        return cut.hostEpoch;
      },
      async withHostEpochFence(expectedHostEpoch, operation) {
        calls.fence += 1;
        if (overrides.withHostEpochFence) {
          return overrides.withHostEpochFence(expectedHostEpoch, operation);
        }
        if (expectedHostEpoch !== cut.hostEpoch) {
          const error = new Error("host epoch changed");
          error.code = "HOST_EPOCH_MISMATCH";
          throw error;
        }
        return operation();
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

async function fakeSpool({ cut = staticCut(), limits, now, source, options = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-fake-"));
  const fake = source ?? staticSource(cut);
  const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
    hostId: "mac-admin",
    cutSource: fake.source,
    root: join(home, "spool"),
    now,
    testLimits: limits,
    ...options,
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
      const request = firstRequest(h.seeded.snapshot.hostEpoch, "logical-chunked");
      const chunks = await collectCut(h.spool, request);
      assert.ok(chunks.length > 1);
      const records = chunks.flatMap((chunk) => chunk.records);
      const frozenHeaderFields = [
        "hostEpoch",
        "coverageComplete",
        "snapshotId",
        "snapshotRequestId",
        "snapshotCreatedAtMs",
        "snapshotAbsoluteExpiresAtMs",
        "throughEventSeq",
        "scopesRevision",
        "totalRecords",
        "totalCanonicalBytes",
        "cutDigest",
      ];
      for (const [index, chunk] of chunks.entries()) {
        const chunkBytes = canonicalCutBytes(chunk.records);
        assert.ok(chunk.records.length <= 2);
        assert.ok(chunkBytes.byteLength <= 524_288);
        assert.equal(chunk.chunkIndex, index);
        assert.equal(chunk.isLast, index === chunks.length - 1);
        assert.equal(chunk.nextCursor === null, chunk.isLast);
        for (const field of frozenHeaderFields) {
          assert.equal(chunk[field], chunks[0][field], `${field} changed across chunks`);
        }
        const retryRequest = index === 0
          ? request
          : {
              ...request,
              snapshotId: chunks[0].snapshotId,
              cursor: chunks[index - 1].nextCursor,
              nextChunkIndex: index,
            };
        const retry = await h.spool.get(retryRequest);
        for (const field of frozenHeaderFields) {
          assert.equal(retry[field], chunk[field], `${field} changed on retry`);
        }
        assert.deepEqual(retry.records, chunk.records);
        assert.equal(retry.nextCursor, chunk.nextCursor);
        assert.ok(retry.snapshotLeaseExpiresAtMs >= chunk.snapshotLeaseExpiresAtMs);
        assert.ok(retry.snapshotLeaseExpiresAtMs <= retry.snapshotAbsoluteExpiresAtMs);
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

test("canonical non-empty golden fixes bytes, digest, and the exact chunk boundary", async () => {
  const records = [
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
  ];
  const golden = "[{\"item\":{\"displayName\":\"Local\",\"kind\":\"local\",\"reachability\":\"online\",\"scopeId\":\"scope-a\"},\"recordType\":\"scope\"},{\"completeness\":\"complete\",\"recordType\":\"sessions_scope\",\"revision\":\"1\",\"scopeId\":\"scope-a\"}]";
  assert.equal(Buffer.byteLength(golden), 207);
  const exact = await fakeSpool({
    cut: staticCut(records),
    limits: { maxChunkCanonicalBytes: 207 },
  });
  try {
    const chunk = await exact.spool.get(firstRequest("authority-epoch", "golden-exact"));
    assert.equal(chunk.isLast, true);
    assert.equal(chunk.totalCanonicalBytes, 207);
    assert.equal(chunk.cutDigest, "oorMU9KEP4q1VZqcT9W8pbSygXbBLPH72VlS5KLrgnE");
    const chunkFile = readdirSync(join(exact.spool.paths.cuts, chunk.snapshotId))
      .find((name) => name.startsWith("chunk-"));
    assert.equal(readFileSync(
      join(exact.spool.paths.cuts, chunk.snapshotId, chunkFile),
      "utf8",
    ), golden);
  } finally {
    exact.cleanup();
  }

  const plusOneRecords = structuredClone(records);
  plusOneRecords[0].item.displayName = "Localx";
  const plusOne = await fakeSpool({
    cut: staticCut(plusOneRecords),
    limits: { maxChunkCanonicalBytes: 207 },
  });
  try {
    const chunks = await collectCut(
      plusOne.spool,
      firstRequest("authority-epoch", "golden-plus-one"),
    );
    assert.equal(chunks.length, 2, "one extra canonical byte must start a new chunk");
    assert.equal(chunks[0].totalCanonicalBytes, 208);
    assert.equal(chunks[0].cutDigest, "LO56zMmk6eCzq9MWQj0dZI9ehwtuOrdy79Cqbe8TrK4");
  } finally {
    plusOne.cleanup();
  }

  const unicodeRecords = [
    {
      recordType: "scope",
      item: {
        scopeId: "scope-ü",
        displayName: "本地😀",
        kind: "local",
        reachability: "online",
      },
    },
    {
      recordType: "sessions_scope",
      scopeId: "scope-ü",
      revision: "2",
      completeness: "complete",
    },
    {
      recordType: "session",
      scopeId: "scope-ü",
      item: {
        scopeId: "scope-ü",
        sessionId: "会话😀",
        label: null,
        count: 7,
        attached: false,
      },
    },
  ];
  const unicodeGolden = "[{\"item\":{\"displayName\":\"本地😀\",\"kind\":\"local\",\"reachability\":\"online\",\"scopeId\":\"scope-ü\"},\"recordType\":\"scope\"},{\"completeness\":\"complete\",\"recordType\":\"sessions_scope\",\"revision\":\"2\",\"scopeId\":\"scope-ü\"},{\"item\":{\"attached\":false,\"count\":7,\"label\":null,\"scopeId\":\"scope-ü\",\"sessionId\":\"会话😀\"},\"recordType\":\"session\",\"scopeId\":\"scope-ü\"}]";
  assert.equal(Buffer.byteLength(unicodeGolden), 355);
  const unicode = await fakeSpool({ cut: staticCut(unicodeRecords) });
  try {
    const chunk = await unicode.spool.get(firstRequest(
      "authority-epoch",
      "golden-unicode-scalars",
    ));
    assert.equal(chunk.totalCanonicalBytes, 355);
    assert.equal(chunk.cutDigest, "7qXCROKD4tmhhWDcvtU_dPC7XNQdQ6hAqEyfTboDCoM");
    const chunkFile = readdirSync(join(unicode.spool.paths.cuts, chunk.snapshotId))
      .find((name) => name.startsWith("chunk-"));
    assert.equal(readFileSync(
      join(unicode.spool.paths.cuts, chunk.snapshotId, chunkFile),
      "utf8",
    ), unicodeGolden);
  } finally {
    unicode.cleanup();
  }
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
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-17-after-publish", {
          principalId: "principal-17-after-publish",
          clientInstanceId: "client-17-after-publish",
        })),
        assertSpoolError("BUSY"),
      );
    } finally {
      releaseCaptures();
      h.cleanup();
    }
  });

  await t.test("a principal cannot pin a third cut", async () => {
    const h = await fakeSpool();
    try {
      await h.spool.get(firstRequest("authority-epoch", "principal-cut-one"));
      await h.spool.get(firstRequest("authority-epoch", "principal-cut-two"));
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "principal-cut-three")),
        assertSpoolError("BUSY"),
      );
      assert.equal(readdirSync(h.spool.paths.cuts).length, 2);
    } finally {
      h.cleanup();
    }
  });

  await t.test("runtime tombstone capacity remains restartable at the exact entry cap", async () => {
    const h = await fakeSpool({ limits: { maxTombstones: 2 } });
    try {
      const first = await h.spool.get(firstRequest("authority-epoch", "tombstone-cap-one"));
      const second = await h.spool.get(firstRequest("authority-epoch", "tombstone-cap-two"));
      const firstRelease = await h.spool.release(releaseRequest(first));
      const secondRelease = await h.spool.release(releaseRequest(second));
      const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
        hostId: "mac-admin",
        cutSource: h.fake.source,
        root: h.spool.paths.root,
        testLimits: { maxTombstones: 2 },
        takeoverExistingOwner: true,
      });
      assert.equal((await restarted.release(releaseRequest(first))).releasedAtMs,
        firstRelease.releasedAtMs);
      assert.equal((await restarted.release(releaseRequest(second))).releasedAtMs,
        secondRelease.releasedAtMs);
      const diskBefore = {
        cuts: readdirSync(restarted.paths.cuts),
        reservations: readdirSync(restarted.paths.reservations),
        tombstones: readdirSync(restarted.paths.tombstones).sort(),
      };
      await assert.rejects(
        restarted.get(firstRequest("authority-epoch", "tombstone-cap-overflow")),
        assertSpoolError("BUSY"),
      );
      assert.deepEqual({
        cuts: readdirSync(restarted.paths.cuts),
        reservations: readdirSync(restarted.paths.reservations),
        tombstones: readdirSync(restarted.paths.tombstones).sort(),
      }, diskBefore);
    } finally {
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
    const exact = await fakeSpool({
      cut: staticCut(records),
      limits: {
        maxChunkCanonicalBytes: bytes,
        maxCutCanonicalBytes: bytes,
        maxSpoolCanonicalBytes: bytes * 2,
      },
    });
    const short = await fakeSpool({
      cut: staticCut(records),
      limits: {
        maxChunkCanonicalBytes: bytes,
        maxCutCanonicalBytes: bytes,
        maxSpoolCanonicalBytes: bytes * 2 - 1,
      },
    });
    try {
      await exact.spool.get(firstRequest("authority-epoch", "byte-exact-one", {
        principalId: "byte-principal-one",
      }));
      await exact.spool.get(firstRequest("authority-epoch", "byte-exact-two", {
        principalId: "byte-principal-two",
        clientInstanceId: "client-two",
      }));
      assert.equal(readdirSync(exact.spool.paths.cuts).length, 2);

      await short.spool.get(firstRequest("authority-epoch", "byte-short-one", {
        principalId: "byte-principal-one",
      }));
      await assert.rejects(
        short.spool.get(firstRequest("authority-epoch", "byte-short-two", {
          principalId: "byte-principal-two",
          clientInstanceId: "client-two",
        })),
        assertSpoolError("BUSY"),
      );
      assert.equal(readdirSync(short.spool.paths.cuts).length, 1);
    } finally {
      exact.cleanup();
      short.cleanup();
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
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-undercharged")),
        assertSpoolError("SNAPSHOT_EXPIRED"),
      );
    } finally {
      h.cleanup();
    }
  });

  await t.test("undercharge after durable chunk writes still removes the whole staging cut", async () => {
    const records = [
      {
        recordType: "scope",
        item: { scopeId: "scope-a", displayName: "Local", kind: "local", reachability: "online" },
      },
      {
        recordType: "sessions_scope",
        scopeId: "scope-a",
        revision: "1",
        completeness: "complete",
      },
      {
        recordType: "session",
        scopeId: "scope-a",
        item: { scopeId: "scope-a", sessionId: "session-a" },
      },
      {
        recordType: "session",
        scopeId: "scope-a",
        item: { scopeId: "scope-a", sessionId: "session-b" },
      },
    ];
    const cut = staticCut(records);
    const reservedPrefix = records.slice(0, 3);
    const fake = staticSource(cut, {
      admissionEstimate: async () => ({
        hostEpoch: cut.hostEpoch,
        totalRecords: reservedPrefix.length,
        totalCanonicalBytes: canonicalCutBytes(reservedPrefix).byteLength,
      }),
    });
    let writtenChunks = 0;
    const h = await fakeSpool({
      source: fake,
      limits: { maxChunkRecords: 1 },
      options: { testHooks: { afterChunkWrite: () => { writtenChunks += 1; } } },
    });
    try {
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-late-undercharge")),
        assertSpoolError("BUSY"),
      );
      assert.ok(writtenChunks >= 2, "the failure is injected after earlier chunks reached staging");
      assert.deepEqual(readdirSync(h.spool.paths.cuts), []);
      assert.deepEqual(readdirSync(h.spool.paths.staging), []);
      assert.deepEqual(readdirSync(h.spool.paths.reservations), []);
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-late-undercharge")),
        assertSpoolError("SNAPSHOT_EXPIRED"),
      );
    } finally {
      h.cleanup();
    }
  });
});

test("cross-process lock initialization, dead takeover, and release ABA never overlap", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-process-lock-"));
  const root = join(home, "spool");
  const marker = `${root}.metadata-critical`;
  const children = [];
  try {
    const incompleteRoot = join(home, "incomplete-spool");
    mkdirSync(incompleteRoot, { mode: 0o700 });
    const incompleteLock = join(incompleteRoot, ".metadata-lock-v2.json");
    writeFileSync(incompleteLock, "", { mode: 0o600 });
    utimesSync(incompleteLock, 0, 0);
    const initializer = spawnSnapshotSpoolChild(incompleteRoot, {
      mode: "open-close-exit",
      owner: "incomplete-holder-successor",
    });
    children.push(initializer);
    assert.match((await initializer.message("stale-observed")).identity, /^inode-/);
    await initializer.message("opened");
    await initializer.message("auto-closed");
    assert.deepEqual(await initializer.exit(), [0, null]);

    const quarantineCrashRoot = join(home, "quarantine-crash-spool");
    const quarantineHolder = spawnSnapshotSpoolChild(quarantineCrashRoot, {
      mode: "crash-lock",
      owner: "quarantine-stale-holder",
    });
    children.push(quarantineHolder);
    await quarantineHolder.message("lock-enter");
    assert.deepEqual(await quarantineHolder.exit(), [83, null]);
    rmSync(`${quarantineCrashRoot}.metadata-critical`, { force: true });
    const quarantineCrasher = spawnSnapshotSpoolChild(quarantineCrashRoot, {
      mode: "crash-after-quarantine",
      owner: "quarantine-crasher",
      takeover: true,
    });
    children.push(quarantineCrasher);
    await quarantineCrasher.message("stale-observed");
    await quarantineCrasher.message("quarantine-persisted");
    assert.deepEqual(await quarantineCrasher.exit(), [86, null]);
    const quarantineDirectory = join(
      quarantineCrashRoot,
      ".metadata-lock-quarantine-v1",
    );
    const quarantineMarker = join(
      quarantineDirectory,
      readdirSync(quarantineDirectory)[0],
    );
    const fixedAfterCrash = statSync(join(quarantineCrashRoot, ".metadata-lock-v2.json"));
    const markerAfterCrash = statSync(quarantineMarker);
    assert.deepEqual(
      [fixedAfterCrash.dev, fixedAfterCrash.ino],
      [markerAfterCrash.dev, markerAfterCrash.ino],
      "the durable quarantine hard link proves the exact stale inode",
    );
    const quarantineSuccessor = spawnSnapshotSpoolChild(quarantineCrashRoot, {
      mode: "open-close-exit",
      owner: "quarantine-successor",
      takeover: true,
    });
    children.push(quarantineSuccessor);
    await quarantineSuccessor.message("stale-observed");
    await quarantineSuccessor.message("opened");
    await quarantineSuccessor.message("auto-closed");
    assert.deepEqual(await quarantineSuccessor.exit(), [0, null]);

    const crashed = spawnSnapshotSpoolChild(root, {
      mode: "crash-lock",
      owner: "crashed-lock-owner",
    });
    children.push(crashed);
    await crashed.message("lock-enter");
    assert.deepEqual(await crashed.exit(), [83, null]);
    rmSync(marker, { force: true });

    const staleObserver = spawnSnapshotSpoolChild(root, {
      owner: "stale-observer-owner",
      takeover: true,
      holdStale: true,
    });
    children.push(staleObserver);
    const stale = await staleObserver.message("stale-observed");
    assert.match(stale.identity, /^(?:token|inode)-/);

    const winner = spawnSnapshotSpoolChild(root, {
      owner: "winner-owner",
      takeover: true,
      holdFirst: true,
    });
    children.push(winner);
    await winner.message("lock-enter");
    winner.send({ type: "release-acquire" });
    await winner.message("lock-exit");
    await winner.message("opened");

    staleObserver.send({ type: "release-stale" });
    await staleObserver.message("lock-enter");
    await staleObserver.message("lock-exit");
    await staleObserver.message("opened");

    winner.send({ type: "cleanup" });
    assert.deepEqual(await winner.message("cleanup-result"), {
      type: "cleanup-result",
      ok: false,
      code: "INTERNAL",
    });
    staleObserver.send({ type: "close" });
    assert.equal((await staleObserver.message("close-result")).ok, true);
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null) child.send({ type: "exit" });
    }
    await Promise.all(children.map(async (child) => {
      if (child.child.exitCode === null) await child.exit();
    }));
    rmSync(home, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

test("PID reuse cannot keep a stale metadata lock or spool owner live", async () => {
  const h = await fakeSpool({
    options: {
      ownerInstanceId: "pid-reuse-old-owner",
      testHooks: { processIncarnationForPid: () => "incarnation-old" },
    },
  });
  try {
    const replacement = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: h.fake.source,
      root: h.spool.paths.root,
      ownerInstanceId: "pid-reuse-new-owner",
      testHooks: { processIncarnationForPid: () => "incarnation-new" },
    });
    await assert.rejects(h.spool.cleanupExpired(), assertSpoolError("INTERNAL"));
    await replacement.close();

    writeFileSync(
      replacement.paths.lock,
      `${JSON.stringify({
        version: 2,
        token: "stale-reused-pid-lock",
        pid: process.pid,
        processIncarnation: "incarnation-old",
      })}\n`,
      { mode: 0o600 },
    );
    const afterStaleLock = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: h.fake.source,
      root: h.spool.paths.root,
      ownerInstanceId: "pid-reuse-lock-successor",
      testHooks: { processIncarnationForPid: () => "incarnation-new" },
    });
    await afterStaleLock.close();
  } finally {
    h.cleanup();
  }
});

test(
  "production process witness keeps a live metadata lock fenced across caller locale and timezone",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-process-witness-"));
    const root = join(home, "spool");
    const holder = spawnSnapshotSpoolChild(root, {
      owner: "process-witness-holder",
      holdFirst: true,
      environment: {
        LC_ALL: "C",
        LANG: "C",
        TZ: "Pacific/Honolulu",
      },
    });
    const children = [holder];
    try {
      await holder.message("lock-enter");
      const contender = spawnSnapshotSpoolChild(root, {
        owner: "process-witness-contender",
        environment: {
          LC_ALL: "en_US.UTF-8",
          LANG: "en_US.UTF-8",
          TZ: "Asia/Tokyo",
        },
      });
      children.push(contender);
      const rejected = await contender.message("open-error");
      assert.equal(rejected.code, "BUSY");
      assert.equal(
        readdirSync(join(root, ".metadata-lock-quarantine-v1")).length,
        0,
        "a live lock must not be quarantined under a different caller environment",
      );
      contender.send({ type: "exit" });
      await contender.exit();

      holder.send({ type: "release-acquire" });
      await holder.message("lock-exit");
      await holder.message("opened");
      holder.send({ type: "close" });
      assert.equal((await holder.message("close-result")).ok, true);
    } finally {
      for (const child of children) {
        if (child.child.exitCode === null) child.send({ type: "exit" });
      }
      await Promise.all(children.map(async (child) => {
        if (child.child.exitCode === null) await child.exit();
      }));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("boot-session changes fence the same pid and production process-start witness", async () => {
  const firstBoot = "00000000-0000-4000-8000-000000000001";
  const secondBoot = "00000000-0000-4000-8000-000000000002";
  const h = await fakeSpool({
    options: {
      ownerInstanceId: "boot-session-old-owner",
      testHooks: { bootSessionIdentity: () => firstBoot },
    },
  });
  try {
    const previousOwner = JSON.parse(readFileSync(h.spool.paths.owner, "utf8"));
    assert.equal(previousOwner.pid, process.pid);

    const replacement = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: h.fake.source,
      root: h.spool.paths.root,
      ownerInstanceId: "boot-session-new-owner",
      testHooks: { bootSessionIdentity: () => secondBoot },
    });
    const currentOwner = JSON.parse(readFileSync(replacement.paths.owner, "utf8"));
    assert.equal(currentOwner.pid, previousOwner.pid);
    assert.notEqual(currentOwner.processIncarnation, previousOwner.processIncarnation);
    await assert.rejects(h.spool.cleanupExpired(), assertSpoolError("INTERNAL"));
    await replacement.close();
  } finally {
    h.cleanup();
  }
});

test("owner takeover fences an accepted BUILDING request instead of rebuilding it", async () => {
  let captureStarted;
  let releaseCapture;
  const started = new Promise((resolve) => { captureStarted = resolve; });
  const release = new Promise((resolve) => { releaseCapture = resolve; });
  const cut = staticCut();
  const oldSource = staticSource(cut, {
    async capture() {
      captureStarted();
      await release;
      return structuredClone(cut);
    },
  });
  const h = await fakeSpool({
    source: oldSource,
    options: { ownerInstanceId: "snapshot-owner-old" },
  });
  try {
    const request = firstRequest("authority-epoch", "logical-owner-overlap");
    const oldBuild = h.spool.get(request);
    await started;
    const reservationPath = join(
      h.spool.paths.reservations,
      readdirSync(h.spool.paths.reservations)[0],
    );
    const accepted = JSON.parse(readFileSync(reservationPath, "utf8"));
    const winner = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: staticSource(cut).source,
      root: h.spool.paths.root,
      ownerInstanceId: "snapshot-owner-new",
      takeoverExistingOwner: true,
    });
    assert.deepEqual(readdirSync(winner.paths.reservations), []);
    const tombstone = JSON.parse(readFileSync(
      join(winner.paths.tombstones, `${accepted.snapshotId}.json`),
      "utf8",
    ));
    assert.equal(tombstone.snapshotId, accepted.snapshotId);
    assert.equal(tombstone.binding.snapshotRequestId, request.snapshotRequestId);
    await assert.rejects(winner.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
    releaseCapture();
    await assert.rejects(oldBuild, assertSpoolError("INTERNAL"));
    assert.deepEqual(readdirSync(winner.paths.cuts), []);
  } finally {
    releaseCapture();
    h.cleanup();
  }
});

test("a crashed BUILDING reservation restarts as the same logical expired fence", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-building-crash-"));
  const root = join(home, "spool");
  const marker = `${root}.metadata-critical`;
  const crashed = spawnSnapshotSpoolChild(root, {
    mode: "crash-building",
    owner: "building-crasher",
  });
  try {
    await crashed.message("opened");
    const accepted = await crashed.message("reservation-persisted");
    assert.deepEqual(await crashed.exit(), [85, null]);
    rmSync(marker, { force: true });
    const reservationFile = readdirSync(join(root, "reservations"))[0];
    const reservation = JSON.parse(readFileSync(
      join(root, "reservations", reservationFile),
      "utf8",
    ));
    assert.equal(reservation.snapshotId, accepted.snapshotId);

    const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: staticSource(staticCut()).source,
      root,
      ownerInstanceId: "building-successor",
    });
    assert.deepEqual(readdirSync(restarted.paths.reservations), []);
    const tombstone = JSON.parse(readFileSync(
      join(restarted.paths.tombstones, `${accepted.snapshotId}.json`),
      "utf8",
    ));
    assert.equal(tombstone.snapshotId, reservation.snapshotId);
    assert.equal(tombstone.binding.snapshotRequestId, "logical-building-crash");
    await assert.rejects(
      restarted.get(firstRequest("authority-epoch", "logical-building-crash")),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );
    assert.deepEqual(readdirSync(restarted.paths.cuts), []);
  } finally {
    if (crashed.child.exitCode === null) {
      crashed.send({ type: "exit" });
      await crashed.exit();
    }
    rmSync(marker, { force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a post-rename fsync failure rolls back final and permanently expires the accepted request", async () => {
  let failPublishFsync = true;
  const h = await fakeSpool({
    options: {
      testHooks: {
        beforeDirectoryFsync(point) {
          if (point === "publish_cuts" && failPublishFsync) {
            failPublishFsync = false;
            throw new Error("injected publish fsync failure");
          }
        },
      },
    },
  });
  try {
    const request = firstRequest("authority-epoch", "logical-fsync-rollback");
    await assert.rejects(h.spool.get(request), assertSpoolError("INTERNAL"));
    assert.deepEqual(readdirSync(h.spool.paths.cuts), []);
    assert.deepEqual(readdirSync(h.spool.paths.staging), []);
    assert.deepEqual(readdirSync(h.spool.paths.reservations), []);
    assert.equal(readdirSync(h.spool.paths.tombstones).length, 1);
    await assert.rejects(h.spool.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
    assert.deepEqual(readdirSync(h.spool.paths.cuts), []);
  } finally {
    h.cleanup();
  }
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
    const buildingRequest = firstRequest("authority-epoch", "logical-building-expiry");
    const pending = delayedSpool.get(buildingRequest);
    await started;
    const waitingRetry = delayedSpool.get(buildingRequest);
    now = 2_351;
    await delayedSpool.cleanupExpired();
    assert.deepEqual(readdirSync(delayedSpool.paths.reservations), []);
    assert.deepEqual(
      readdirSync(delayedSpool.paths.staging),
      [],
      "an expired BUILDING reservation must be rejected before staging starts",
    );
    await assert.rejects(pending, assertSpoolError("SNAPSHOT_EXPIRED"));
    await assert.rejects(waitingRetry, assertSpoolError("SNAPSHOT_EXPIRED"));
    await assert.rejects(
      delayedSpool.get(buildingRequest),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );
    assert.equal(readdirSync(delayedSpool.paths.tombstones).length, 1);
    releaseCapture();
    await new Promise((resolve) => setImmediate(resolve));
    await delayedSpool.cleanupExpired();
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

test("release durability preserves ACK-loss idempotence, headroom, and crash cleanup", async () => {
  const h = await fakeSpool();
  try {
    const request = firstRequest("authority-epoch", "r".repeat(128), {
      principalId: "p".repeat(128),
      clientInstanceId: "c".repeat(128),
    });
    const chunk = await h.spool.get(request);
    const cutDirectory = join(h.spool.paths.cuts, chunk.snapshotId);
    const manifest = JSON.parse(readFileSync(join(cutDirectory, "manifest-v1.json"), "utf8"));
    const baseMetadataBytes = ["manifest-v1.json", "binding-v1.json", "lease-v1.json"]
      .reduce((sum, name) => sum + statSync(join(cutDirectory, name)).size, 0);
    const backup = join(h.home, "released-cut-backup");
    cpSync(cutDirectory, backup, { recursive: true });

    const released = await h.spool.release(releaseRequest(chunk, {
      principalId: request.principalId,
      clientInstanceId: request.clientInstanceId,
      snapshotRequestId: request.snapshotRequestId,
    }));
    const tombstonePath = join(h.spool.paths.tombstones, `${chunk.snapshotId}.json`);
    assert.ok(
      manifest.metadataBytes >= baseMetadataBytes + statSync(tombstonePath).size,
      "active metadata must independently reserve the release tombstone headroom",
    );

    cpSync(backup, cutDirectory, { recursive: true });
    chmodSync(cutDirectory, 0o700);
    const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: h.fake.source,
      root: h.spool.paths.root,
      takeoverExistingOwner: true,
    });
    assert.deepEqual(readdirSync(restarted.paths.cuts), []);
    const replay = await restarted.release(releaseRequest(chunk, {
      principalId: request.principalId,
      clientInstanceId: request.clientInstanceId,
      snapshotRequestId: request.snapshotRequestId,
    }));
    assert.equal(replay.alreadyReleased, true);
    assert.equal(replay.released, false);
    assert.equal(replay.releasedAtMs, released.releasedAtMs);
    await assert.rejects(restarted.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
  } finally {
    h.cleanup();
  }

  let now = 50_000;
  const expired = await fakeSpool({
    now: () => now,
    limits: { idleLeaseMs: 100, absoluteLeaseMs: 500 },
  });
  try {
    const request = firstRequest("authority-epoch", "logical-expiry-restart");
    await expired.spool.get(request);
    now += 101;
    const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: expired.fake.source,
      root: expired.spool.paths.root,
      now: () => now,
      testLimits: { idleLeaseMs: 100, absoluteLeaseMs: 500 },
      takeoverExistingOwner: true,
    });
    assert.deepEqual(readdirSync(restarted.paths.cuts), []);
    await assert.rejects(restarted.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
  } finally {
    expired.cleanup();
  }
});

test("recovery preserves tombstones over quota and fails closed on corrupt or unsafe metadata", async (t) => {
  await t.test("metadata overage keeps the release fence", async () => {
    const h = await fakeSpool();
    try {
      const request = firstRequest("authority-epoch", "logical-metadata-overage");
      const chunk = await h.spool.get(request);
      await h.spool.release(releaseRequest(chunk));
      const tombstonePath = join(h.spool.paths.tombstones, `${chunk.snapshotId}.json`);
      const metadataLimit = statSync(h.spool.paths.owner).size + statSync(tombstonePath).size - 1;
      await assert.rejects(
        snapshotSpool.RelayV2StateSnapshotSpool.open({
          hostId: "mac-admin",
          cutSource: h.fake.source,
          root: h.spool.paths.root,
          testLimits: { maxMetadataBytes: metadataLimit },
          takeoverExistingOwner: true,
        }),
        assertSpoolError("INTERNAL"),
      );
      assert.equal(readdirSync(h.spool.paths.tombstones).length, 1);
    } finally {
      h.cleanup();
    }
  });

  await t.test("recovery charges padded metadata before parsing or reading later files", async () => {
    const h = await fakeSpool();
    try {
      const chunk = await h.spool.get(firstRequest(
        "authority-epoch",
        "logical-padded-recovery-metadata",
      ));
      const cutDirectory = join(h.spool.paths.cuts, chunk.snapshotId);
      const manifestPath = join(cutDirectory, "manifest-v1.json");
      const manifest = readFileSync(manifestPath);
      writeFileSync(manifestPath, Buffer.concat([manifest, Buffer.alloc(4_096, 0x20)]), {
        mode: 0o600,
      });
      const metadataLimit = statSync(h.spool.paths.owner).size
        + statSync(join(cutDirectory, "binding-v1.json")).size
        + statSync(manifestPath).size - 1;
      const deeplyRead = [];
      await assert.rejects(
        snapshotSpool.RelayV2StateSnapshotSpool.open({
          hostId: "mac-admin",
          cutSource: h.fake.source,
          root: h.spool.paths.root,
          testLimits: { maxMetadataBytes: metadataLimit },
          takeoverExistingOwner: true,
          testHooks: {
            beforeRecoveryMetadataRead: (kind) => deeplyRead.push(kind),
          },
        }),
        assertSpoolError("INTERNAL"),
      );
      assert.deepEqual(deeplyRead, ["binding"]);
      assert.equal(readFileSync(manifestPath).byteLength, manifest.byteLength + 4_096);
      const canonicalReads = [];
      const canonicalRestart = await snapshotSpool.RelayV2StateSnapshotSpool.open({
        hostId: "mac-admin",
        cutSource: h.fake.source,
        root: h.spool.paths.root,
        takeoverExistingOwner: true,
        testHooks: {
          beforeRecoveryMetadataRead: (kind) => canonicalReads.push(kind),
        },
      });
      assert.deepEqual(canonicalReads, ["binding", "manifest"]);
      assert.deepEqual(readdirSync(canonicalRestart.paths.cuts), []);
      await assert.rejects(
        canonicalRestart.get(firstRequest(
          "authority-epoch",
          "logical-padded-recovery-metadata",
        )),
        assertSpoolError("SNAPSHOT_EXPIRED"),
      );
    } finally {
      h.cleanup();
    }
  });

  await t.test("corrupt tombstone remains isolated", async () => {
    const h = await fakeSpool();
    try {
      const chunk = await h.spool.get(firstRequest("authority-epoch", "logical-corrupt-tomb"));
      await h.spool.release(releaseRequest(chunk));
      const tombstonePath = join(h.spool.paths.tombstones, `${chunk.snapshotId}.json`);
      writeFileSync(tombstonePath, "{}\n", { mode: 0o600 });
      await assert.rejects(
        snapshotSpool.RelayV2StateSnapshotSpool.open({
          hostId: "mac-admin",
          cutSource: h.fake.source,
          root: h.spool.paths.root,
          takeoverExistingOwner: true,
        }),
        assertSpoolError("INTERNAL"),
      );
      assert.equal(readFileSync(tombstonePath, "utf8"), "{}\n");
    } finally {
      h.cleanup();
    }
  });

  await t.test("recovery stops before reading chunks beyond cumulative totals", async () => {
    const records = [
      {
        recordType: "scope",
        item: { scopeId: "scope-a", displayName: "Local", kind: "local", reachability: "online" },
      },
      {
        recordType: "sessions_scope",
        scopeId: "scope-a",
        revision: "1",
        completeness: "complete",
      },
      {
        recordType: "session",
        scopeId: "scope-a",
        item: { scopeId: "scope-a", sessionId: "session-a" },
      },
    ];
    const h = await fakeSpool({ cut: staticCut(records), limits: { maxChunkRecords: 1 } });
    try {
      const request = firstRequest("authority-epoch", "logical-recovery-total-overrun");
      const chunk = await h.spool.get(request);
      const manifestPath = join(h.spool.paths.cuts, chunk.snapshotId, "manifest-v1.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.totalRecords = 1;
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      const reads = [];
      const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
        hostId: "mac-admin",
        cutSource: h.fake.source,
        root: h.spool.paths.root,
        testLimits: { maxChunkRecords: 1 },
        takeoverExistingOwner: true,
        testHooks: { beforeRecoveryChunkRead: (index) => reads.push(index) },
      });
      assert.deepEqual(reads, [0]);
      assert.deepEqual(readdirSync(restarted.paths.cuts), []);
      await assert.rejects(restarted.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
    } finally {
      h.cleanup();
    }
  });

  await t.test("unsafe file mode is rejected without repair or path disclosure", async () => {
    const h = await fakeSpool();
    try {
      const chunk = await h.spool.get(firstRequest("authority-epoch", "logical-unsafe-mode"));
      const manifestPath = join(h.spool.paths.cuts, chunk.snapshotId, "manifest-v1.json");
      chmodSync(manifestPath, 0o644);
      let failure;
      try {
        await snapshotSpool.RelayV2StateSnapshotSpool.open({
          hostId: "mac-admin",
          cutSource: h.fake.source,
          root: h.spool.paths.root,
          takeoverExistingOwner: true,
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(assertSpoolError("INTERNAL")(failure));
      assert.equal(statSync(manifestPath).mode & 0o777, 0o644);
      assert.equal(failure.message.includes(h.home), false);
    } finally {
      h.cleanup();
    }
  });

  await t.test("unsafe directory mode is rejected without repair", async () => {
    const h = await fakeSpool();
    try {
      chmodSync(h.spool.paths.root, 0o750);
      await assert.rejects(
        snapshotSpool.RelayV2StateSnapshotSpool.open({
          hostId: "mac-admin",
          cutSource: h.fake.source,
          root: h.spool.paths.root,
          takeoverExistingOwner: true,
        }),
        assertSpoolError("INTERNAL"),
      );
      assert.equal(statSync(h.spool.paths.root).mode & 0o777, 0o750);
    } finally {
      h.cleanup();
    }
  });

  await t.test("cut and staging symlinks never redirect recovery outside the spool", async () => {
    for (const location of ["cuts", "staging"]) {
      const h = await fakeSpool();
      const external = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-sentinel-"));
      const sentinel = join(external, "sentinel.txt");
      writeFileSync(sentinel, `outside-${location}`, { mode: 0o600 });
      try {
        const chunk = await h.spool.get(firstRequest(
          "authority-epoch",
          `logical-symlink-${location}`,
        ));
        const redirected = location === "cuts"
          ? join(h.spool.paths.cuts, chunk.snapshotId)
          : join(
              h.spool.paths.staging,
              `${chunk.snapshotId}.00000000-0000-4000-8000-000000000000.tmp`,
            );
        if (location === "cuts") rmSync(redirected, { recursive: true });
        symlinkSync(external, redirected, "dir");
        await assert.rejects(
          snapshotSpool.RelayV2StateSnapshotSpool.open({
            hostId: "mac-admin",
            cutSource: h.fake.source,
            root: h.spool.paths.root,
            takeoverExistingOwner: true,
          }),
          assertSpoolError("INTERNAL"),
        );
        assert.equal(readFileSync(sentinel, "utf8"), `outside-${location}`);
        assert.equal(statSync(sentinel).mode & 0o777, 0o600);
      } finally {
        h.cleanup();
        rmSync(external, { recursive: true, force: true });
      }
    }
  });

  await t.test("a custom-root symlink ancestor is fixed to one physical tree", async () => {
    const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-snapshot-root-alias-"));
    const original = join(home, "physical-original");
    const replacement = join(home, "physical-replacement");
    const alias = join(home, "alias");
    mkdirSync(original, { mode: 0o700 });
    mkdirSync(replacement, { mode: 0o700 });
    const originalSentinel = join(original, "sentinel.txt");
    const replacementSentinel = join(replacement, "sentinel.txt");
    writeFileSync(originalSentinel, "original", { mode: 0o600 });
    writeFileSync(replacementSentinel, "replacement", { mode: 0o600 });
    symlinkSync(original, alias, "dir");
    const fake = staticSource(staticCut());
    try {
      const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
        hostId: "mac-admin",
        cutSource: fake.source,
        root: join(alias, "nested", "spool"),
      });
      assert.equal(spool.paths.root, join(realpathSync(original), "nested", "spool"));
      rmSync(alias);
      symlinkSync(replacement, alias, "dir");
      await spool.get(firstRequest("authority-epoch", "logical-physical-root"));
      await spool.close();
      assert.equal(readFileSync(originalSentinel, "utf8"), "original");
      assert.equal(readFileSync(replacementSentinel, "utf8"), "replacement");
      assert.deepEqual(readdirSync(replacement).sort(), ["sentinel.txt"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("restart recovers valid same-epoch final cuts, cleans crash orphans, and enforces modes", async () => {
  const h = await realHarness({ sessions: [terminal("pane:a", "alpha")] });
  try {
    const epoch = h.seeded.snapshot.hostEpoch;
    const request = firstRequest(epoch, "logical-recovery");
    const first = await h.spool.get(request);
    const recoverableStaging = join(
      h.spool.paths.staging,
      `${first.snapshotId}.00000000-0000-4000-8000-000000000000.tmp`,
    );
    mkdirSync(recoverableStaging, { mode: 0o700 });
    writeFileSync(join(recoverableStaging, "partial"), "partial", {
      mode: 0o600,
    });

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
      takeoverExistingOwner: true,
    });
    assert.deepEqual(readdirSync(restarted.paths.staging), []);
    assert.deepEqual(readdirSync(restarted.paths.reservations), []);
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
      takeoverExistingOwner: true,
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
      takeoverExistingOwner: true,
    });
    assert.deepEqual(readdirSync(manifestRecovery.paths.cuts), []);
    await assert.rejects(
      manifestRecovery.get(firstRequest(epoch, "logical-corrupt-manifest")),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );

    const bindingVictim = await manifestRecovery.get(firstRequest(
      epoch,
      "logical-corrupt-binding",
    ));
    writeFileSync(
      join(manifestRecovery.paths.cuts, bindingVictim.snapshotId, "binding-v1.json"),
      "{}\n",
      { mode: 0o600 },
    );
    const bindingRecovery = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: restartedFoundation.snapshotCutSource,
      root: restarted.paths.root,
      takeoverExistingOwner: true,
    });
    assert.deepEqual(readdirSync(bindingRecovery.paths.cuts), []);
    await assert.rejects(
      bindingRecovery.get(firstRequest(epoch, "logical-corrupt-binding")),
      assertSpoolError("SNAPSHOT_EXPIRED"),
    );

    const replacement = await bindingRecovery.get(firstRequest(
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
      takeoverExistingOwner: true,
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

test("a real crash after recovery fence persistence cannot reopen the logical request", async () => {
  const h = await fakeSpool();
  const marker = `${h.spool.paths.root}.metadata-critical`;
  let crashed;
  try {
    const request = firstRequest("authority-epoch", "logical-recovery-fence-crash");
    const chunk = await h.spool.get(request);
    const cutDirectory = join(h.spool.paths.cuts, chunk.snapshotId);
    const chunkFile = readdirSync(cutDirectory).find((name) => name.startsWith("chunk-"));
    writeFileSync(join(cutDirectory, chunkFile), "[", { mode: 0o600 });

    crashed = spawnSnapshotSpoolChild(h.spool.paths.root, {
      mode: "crash-after-recovery-fence",
      owner: "recovery-fence-crasher",
      takeover: true,
    });
    const fenced = await crashed.message("recovery-fence");
    assert.equal(fenced.snapshotId, chunk.snapshotId);
    assert.deepEqual(await crashed.exit(), [84, null]);
    rmSync(marker, { force: true });
    assert.equal(readdirSync(h.spool.paths.cuts).includes(chunk.snapshotId), true);
    assert.equal(readdirSync(h.spool.paths.tombstones).includes(`${chunk.snapshotId}.json`), true);

    const restarted = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: "mac-admin",
      cutSource: h.fake.source,
      root: h.spool.paths.root,
      ownerInstanceId: "recovery-fence-successor",
    });
    assert.deepEqual(readdirSync(restarted.paths.cuts), []);
    await assert.rejects(restarted.get(request), assertSpoolError("SNAPSHOT_EXPIRED"));
    assert.deepEqual(readdirSync(restarted.paths.cuts), []);
  } finally {
    if (crashed?.child.exitCode === null) {
      crashed.send({ type: "exit" });
      await crashed.exit();
    }
    rmSync(marker, { force: true });
    h.cleanup();
  }
});

test("host epoch rotation is fenced in the publish-to-serve and release-to-ACK windows", async (t) => {
  const raceSource = (failAtFence) => {
    const cut = staticCut();
    let epoch = cut.hostEpoch;
    let fenceCalls = 0;
    const fake = staticSource(cut, {
      currentHostEpoch: () => epoch,
      async withHostEpochFence(expectedHostEpoch, operation) {
        fenceCalls += 1;
        if (fenceCalls === failAtFence) epoch = "authority-rotated";
        if (expectedHostEpoch !== epoch) {
          const error = new Error("host lineage changed at the final fence");
          error.code = "HOST_EPOCH_MISMATCH";
          throw error;
        }
        return operation();
      },
    });
    return fake;
  };

  await t.test("published cut is not served after rotation", async () => {
    const fake = raceSource(2);
    const h = await fakeSpool({ source: fake });
    try {
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-publish-serve-race")),
        assertSpoolError("HOST_EPOCH_MISMATCH"),
      );
      assert.equal(readdirSync(h.spool.paths.cuts).length, 1);
      assert.deepEqual(readdirSync(h.spool.paths.reservations), []);
    } finally {
      h.cleanup();
    }
  });

  await t.test("release does not delete or ACK after rotation", async () => {
    const fake = raceSource(3);
    const h = await fakeSpool({ source: fake });
    try {
      const chunk = await h.spool.get(firstRequest(
        "authority-epoch",
        "logical-release-ack-race",
      ));
      await assert.rejects(
        h.spool.release(releaseRequest(chunk)),
        assertSpoolError("HOST_EPOCH_MISMATCH"),
      );
      assert.equal(readdirSync(h.spool.paths.cuts).length, 1);
      assert.deepEqual(readdirSync(h.spool.paths.tombstones), []);
    } finally {
      h.cleanup();
    }
  });
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
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-read-failure")),
        assertSpoolError("SNAPSHOT_EXPIRED"),
      );
    } finally {
      h.cleanup();
    }
  });

  await t.test("source codes use fixed messages and closed details", async () => {
    const secret = "source-secret-do-not-forward";
    const leakedPath = "/private/relay/source-state.json";
    const sourceFailure = new Error(`${leakedPath}: ${secret}`);
    sourceFailure.code = "BUSY";
    sourceFailure.details = {
      readinessInternal: secret,
      path: leakedPath,
    };
    const fake = staticSource(staticCut(), {
      capture: async () => { throw sourceFailure; },
    });
    const h = await fakeSpool({ source: fake });
    try {
      let failure;
      try {
        await h.spool.get(firstRequest("authority-epoch", "logical-source-redaction"));
      } catch (error) {
        failure = error;
      }
      assert.ok(assertSpoolError("BUSY")(failure));
      assert.equal(failure.message, "materialized snapshot source is busy");
      assert.equal(failure.details, null);
      assert.equal(failure.message.includes(secret), false);
      assert.equal(failure.message.includes(leakedPath), false);
      await assert.rejects(
        h.spool.get(firstRequest("authority-epoch", "logical-source-redaction")),
        assertSpoolError("SNAPSHOT_EXPIRED"),
      );
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
    maxTombstones: 16_384,
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
