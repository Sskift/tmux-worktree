import { rmSync, writeFileSync } from "node:fs";

const snapshotSpool = await import("../../dist/relay/v2/stateSnapshotSpool.js");

const root = process.env.SNAPSHOT_SPOOL_ROOT;
const mode = process.env.SNAPSHOT_SPOOL_CHILD_MODE ?? "worker";
const ownerInstanceId = process.env.SNAPSHOT_SPOOL_OWNER ?? `child-${process.pid}`;
const criticalMarker = `${root}.metadata-critical`;

if (!root || typeof process.send !== "function") {
  throw new Error("snapshot spool child requires an IPC channel and isolated root");
}

let acquireCount = 0;
let releaseAcquire;
let releaseStale;
const acquireGate = new Promise((resolve) => { releaseAcquire = resolve; });
const staleGate = new Promise((resolve) => { releaseStale = resolve; });

process.on("message", async (message) => {
  if (message?.type === "release-acquire") releaseAcquire();
  if (message?.type === "release-stale") releaseStale();
});

const cut = {
  hostEpoch: "authority-epoch",
  throughEventSeq: "0",
  scopesRevision: "0",
  records: [],
};
const source = {
  async currentHostEpoch() {
    return cut.hostEpoch;
  },
  async withHostEpochFence(expectedHostEpoch, operation) {
    if (expectedHostEpoch !== cut.hostEpoch) {
      const error = new Error("child source lineage mismatch");
      error.code = "HOST_EPOCH_MISMATCH";
      throw error;
    }
    return operation();
  },
  async admissionEstimate() {
    return { hostEpoch: cut.hostEpoch, totalRecords: 0, totalCanonicalBytes: 2 };
  },
  async capture() {
    return structuredClone(cut);
  },
};

const hooks = {
  async afterMetadataLockAcquired(token) {
    acquireCount += 1;
    try {
      writeFileSync(criticalMarker, `${process.pid}:${token}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      process.send({ type: "overlap", pid: process.pid });
      throw new Error("metadata critical section overlapped another process");
    }
    process.send({ type: "lock-enter", pid: process.pid, acquireCount });
    if (mode === "crash-lock") process.exit(83);
    if (process.env.SNAPSHOT_SPOOL_HOLD_FIRST === "1" && acquireCount === 1) {
      await acquireGate;
    }
  },
  async beforeStaleLockQuarantine(identity) {
    process.send({ type: "stale-observed", pid: process.pid, identity });
    if (process.env.SNAPSHOT_SPOOL_HOLD_STALE === "1") await staleGate;
  },
  afterStaleLockQuarantinePersisted(identity) {
    process.send({ type: "quarantine-persisted", pid: process.pid, identity });
    if (mode === "crash-after-quarantine") process.exit(86);
  },
  beforeMetadataLockRelease() {
    rmSync(criticalMarker, { force: true });
    process.send({ type: "lock-exit", pid: process.pid, acquireCount });
  },
  afterRecoveryExpiredFencePersisted(snapshotId) {
    process.send({ type: "recovery-fence", pid: process.pid, snapshotId });
    if (mode === "crash-after-recovery-fence") process.exit(84);
  },
  afterReservationPersisted(snapshotId) {
    process.send({ type: "reservation-persisted", pid: process.pid, snapshotId });
    if (mode === "crash-building") process.exit(85);
  },
};

let spool;
try {
  spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
    hostId: "mac-admin",
    cutSource: source,
    root,
    ownerInstanceId,
    takeoverExistingOwner: process.env.SNAPSHOT_SPOOL_TAKEOVER === "1",
    testHooks: hooks,
  });
} catch (error) {
  process.send({
    type: "open-error",
    pid: process.pid,
    code: error?.code ?? null,
    message: error?.message ?? "unknown",
  });
  process.exitCode = 1;
}

process.on("message", async (message) => {
  if (message?.type === "exit") process.exit(0);
  if (!spool) return;
  if (message?.type === "cleanup") {
    try {
      await spool.cleanupExpired();
      process.send({ type: "cleanup-result", ok: true });
    } catch (error) {
      process.send({ type: "cleanup-result", ok: false, code: error?.code ?? null });
    }
  }
  if (message?.type === "close") {
    try {
      await spool.close();
      process.send({ type: "close-result", ok: true });
    } catch (error) {
      process.send({ type: "close-result", ok: false, code: error?.code ?? null });
    }
  }
});

if (spool) {
  process.send({ type: "opened", pid: process.pid });
  if (mode === "open-close-exit") {
    await spool.close();
    process.send({ type: "auto-closed", pid: process.pid });
    process.exit(0);
  }
  if (mode === "crash-building") {
    void spool.get({
      principalId: "principal-one",
      clientInstanceId: "client-one",
      expectedHostEpoch: "authority-epoch",
      snapshotRequestId: "logical-building-crash",
      snapshotId: null,
      cursor: null,
      nextChunkIndex: 0,
    });
  }
}
