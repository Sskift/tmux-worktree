import assert from "node:assert/strict";
import test from "node:test";

const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
const ANCHOR_ID = "relay-v2-shared-continuity";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkpoint(sequence, commitId, parentCommitId, digestCharacter) {
  return {
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    sequence: String(sequence),
    commitId,
    parentCommitId,
    stateDigest: digestCharacter.repeat(64),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

class MemoryMonotonicCasAuthority {
  constructor() {
    this.tokenSequence = 0;
    this.current = {
      protocolVersion: VERSION,
      status: "uninitialized",
      anchorId: ANCHOR_ID,
      casToken: "cas-0",
    };
    this.readCalls = [];
    this.casCalls = [];
    this.activeCalls = 0;
    this.maxActiveCalls = 0;
    this.onRead = null;
    this.onCas = null;
  }

  async read(request) {
    assert.equal(request.protocolVersion, VERSION);
    assert.equal(request.anchorId, ANCHOR_ID);
    assert.equal(request.signal instanceof AbortSignal, true);
    this.readCalls.push(request);
    return this.track(async () => (
      this.onRead
        ? this.onRead(request, () => clone(this.current))
        : clone(this.current)
    ));
  }

  async compareAndSwap(request) {
    assert.equal(request.protocolVersion, VERSION);
    assert.equal(request.anchorId, ANCHOR_ID);
    assert.equal(request.signal instanceof AbortSignal, true);
    this.casCalls.push({ next: clone(request.next), signal: request.signal });
    return this.track(async () => (
      this.onCas
        ? this.onCas(request, () => this.defaultCas(request))
        : this.defaultCas(request)
    ));
  }

  async track(operation) {
    this.activeCalls += 1;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    try {
      return await operation();
    } finally {
      this.activeCalls -= 1;
    }
  }

  defaultCas(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: VERSION,
        outcome: "conflict",
        current: clone(this.current),
      };
    }
    if (this.current.status === "uninitialized") {
      assert.equal(request.next.sequence, "0");
      assert.equal(request.next.parentCommitId, null);
    } else {
      assert.equal(BigInt(request.next.sequence), BigInt(this.current.checkpoint.sequence) + 1n);
      assert.equal(request.next.parentCommitId, this.current.checkpoint.commitId);
    }
    this.commit(request.next);
    return {
      protocolVersion: VERSION,
      outcome: "swapped",
      current: clone(this.current),
    };
  }

  commit(next) {
    this.tokenSequence += 1;
    this.current = {
      protocolVersion: VERSION,
      status: "committed",
      anchorId: ANCHOR_ID,
      casToken: `cas-${this.tokenSequence}`,
      checkpoint: clone(next),
    };
  }
}

class MemoryLocalCasStore {
  constructor(initial) {
    this.current = clone(initial);
    this.calls = [];
    this.onCas = null;
  }

  async publish(expected, next, signal) {
    assert.equal(signal instanceof AbortSignal, true);
    this.calls.push({ expected: clone(expected), next: clone(next), signal });
    if (this.onCas) return this.onCas(expected, next, signal);
    if (same(this.current, expected)) {
      this.current = clone(next);
      return { outcome: "swapped", current: clone(this.current) };
    }
    if (same(this.current, next)) {
      return { outcome: "already_same", current: clone(this.current) };
    }
    return { outcome: "conflict", current: clone(this.current) };
  }
}

function anchor(authority, options = {}) {
  return new continuity.RelayV2ContinuityAnchor({
    anchorId: ANCHOR_ID,
    authority,
    operationTimeoutMs: options.operationTimeoutMs ?? 250,
    maxPendingOperations: options.maxPendingOperations ?? 16,
  });
}

function advance(protocol, store, current, next) {
  return protocol.advance({
    current,
    next,
    publishState: (expected, successor, signal) => store.publish(expected, successor, signal),
  });
}

test("state-before-anchor uncertainty recovers, while paired rollback remains fenced", async () => {
  const external = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-genesis", null, "a");
  const afterCrash = checkpoint(1, "commit-after-crash", genesis.commitId, "b");
  const later = checkpoint(2, "commit-later", afterCrash.commitId, "c");
  const local = new MemoryLocalCasStore(genesis);
  const protocol = anchor(external);

  assert.equal((await protocol.reconcile(genesis)).disposition, "initialized");
  external.onCas = async () => {
    external.onCas = null;
    throw new Error("injected external CAS outage");
  };
  await assert.rejects(
    advance(protocol, local, genesis, afterCrash),
    (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN",
  );
  assert.deepEqual(local.current, afterCrash, "local CAS is the state commit point");
  assert.deepEqual(external.current.checkpoint, genesis);

  const localCallsBeforeBlockedRetry = local.calls.length;
  await assert.rejects(
    advance(protocol, local, afterCrash, later),
    (error) => error.code === "RECONCILIATION_REQUIRED",
  );
  assert.equal(local.calls.length, localCallsBeforeBlockedRetry, "uncertain advance is not retried blindly");

  const reopened = anchor(external);
  const recovered = await reopened.reconcile(local.current);
  assert.equal(recovered.disposition, "recovered_state_before_anchor");
  assert.deepEqual(recovered.anchor.checkpoint, afterCrash);

  const rolledBackPair = { state: clone(genesis), witness: clone(genesis) };
  local.current = rolledBackPair.state;
  assert.deepEqual(rolledBackPair.witness, genesis);
  await assert.rejects(
    anchor(external).reconcile(local.current),
    (error) => error.code === "ROLLBACK_DETECTED",
  );
  assert.deepEqual(external.current.checkpoint, afterCrash);
});

test("two instances racing different successors let only the local CAS winner advance the anchor", async () => {
  const external = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-race-genesis", null, "d");
  const leftNext = checkpoint(1, "commit-left", genesis.commitId, "e");
  const rightNext = checkpoint(1, "commit-right", genesis.commitId, "f");
  const local = new MemoryLocalCasStore(genesis);
  await anchor(external).reconcile(genesis);
  const casCallsBeforeRace = external.casCalls.length;

  const bothReads = deferred();
  let competingReads = 0;
  external.onRead = async (_request, snapshot) => {
    const captured = snapshot();
    competingReads += 1;
    if (competingReads === 2) bothReads.resolve();
    await bothReads.promise;
    return captured;
  };

  const results = await Promise.allSettled([
    advance(anchor(external), local, genesis, leftNext),
    advance(anchor(external), local, genesis, rightNext),
  ]);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "LOCAL_STATE_CONFLICT");
  assert.deepEqual(winners[0].value.anchor.checkpoint, local.current);
  assert.deepEqual(external.current.checkpoint, local.current);
  assert.equal(
    external.casCalls.length,
    casCallsBeforeRace + 1,
    "divergent local loser never attempts external CAS",
  );
});

test("pending reads time out, same-instance work serializes, and admission stays bounded", async () => {
  const external = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-pending-read", null, "1");
  let reads = 0;
  external.onRead = async (_request, snapshot) => {
    reads += 1;
    if (reads === 1) return await new Promise(() => {});
    return snapshot();
  };
  const protocol = anchor(external, { operationTimeoutMs: 100, maxPendingOperations: 2 });

  const first = protocol.reconcile(genesis);
  await nextTurn();
  const second = protocol.reconcile(genesis);
  const overflow = protocol.reconcile(genesis);
  await assert.rejects(overflow, (error) => error.code === "BUSY");
  assert.equal(external.readCalls.length, 1, "queued operation does not overlap the running serializer turn");
  await assert.rejects(first, (error) => error.code === "ANCHOR_UNAVAILABLE");
  assert.equal(external.readCalls[0].signal.aborted, true);
  assert.equal((await second).disposition, "initialized");
  assert.equal(external.maxActiveCalls, 2, "the timed-out adapter call remains bounded while late");
});

test("a timed-out external CAS is uncertain, ignores its late result, and requires reconcile", async () => {
  const external = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-late-genesis", null, "2");
  const next = checkpoint(1, "commit-late-next", genesis.commitId, "3");
  const after = checkpoint(2, "commit-after-reconcile", next.commitId, "4");
  const local = new MemoryLocalCasStore(genesis);
  const protocol = anchor(external, { operationTimeoutMs: 20 });
  await protocol.reconcile(genesis);

  const releaseLateCas = deferred();
  let lateSignal;
  external.onCas = async (request, commit) => {
    external.onCas = null;
    lateSignal = request.signal;
    await releaseLateCas.promise;
    return commit();
  };
  const timedOut = advance(protocol, local, genesis, next);
  await assert.rejects(timedOut, (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN");
  assert.equal(lateSignal.aborted, true);
  assert.deepEqual(local.current, next);
  assert.deepEqual(external.current.checkpoint, genesis);

  const localCallsBeforeBlockedRetry = local.calls.length;
  await assert.rejects(
    advance(protocol, local, next, after),
    (error) => error.code === "RECONCILIATION_REQUIRED",
  );
  assert.equal(local.calls.length, localCallsBeforeBlockedRetry);

  releaseLateCas.resolve();
  await nextTurn();
  assert.deepEqual(external.current.checkpoint, next, "late adapter completion may commit but cannot fulfill old call");
  assert.equal((await protocol.reconcile(local.current)).disposition, "matched");
  assert.equal((await advance(protocol, local, next, after)).disposition, "committed");
});

test("closed validation and uncertain seams fail closed without external progress", async () => {
  assert.throws(
    () => new continuity.RelayV2ContinuityAnchor({ anchorId: ANCHOR_ID }),
    /must be supplied by the caller/,
  );
  assert.throws(
    () => new continuity.RelayV2ContinuityAnchor({
      anchorId: "x".repeat(129),
      authority: new MemoryMonotonicCasAuthority(),
    }),
    /anchorId is invalid/,
  );

  const genesis = checkpoint(0, "commit-validation", null, "5");
  for (const invalid of [
    { ...genesis, extra: true },
    { ...genesis, sequence: "18446744073709551616" },
  ]) {
    await assert.rejects(
      anchor(new MemoryMonotonicCasAuthority()).reconcile(invalid),
      (error) => error.code === "INVALID_CHECKPOINT",
    );
  }

  for (const invalidSnapshot of [
    (current) => ({ ...current, extra: true }),
    (current) => ({ ...current, casToken: "t".repeat(513) }),
  ]) {
    const external = new MemoryMonotonicCasAuthority();
    external.onRead = async (_request, snapshot) => invalidSnapshot(snapshot());
    await assert.rejects(
      anchor(external).reconcile(genesis),
      (error) => error.code === "INVALID_AUTHORITY_RESPONSE",
    );
  }

  const failedRead = new MemoryMonotonicCasAuthority();
  failedRead.onRead = async () => { throw new Error("injected read failure"); };
  await assert.rejects(
    anchor(failedRead).reconcile(genesis),
    (error) => error.code === "ANCHOR_UNAVAILABLE",
  );

  for (const invalidCas of [
    (request) => ({
      protocolVersion: VERSION,
      outcome: "swapped",
      current: {
        protocolVersion: VERSION,
        status: "committed",
        anchorId: ANCHOR_ID,
        casToken: request.expected.casToken,
        checkpoint: clone(request.next),
      },
    }),
    (request) => ({
      protocolVersion: VERSION,
      outcome: "swapped",
      current: { ...clone(request.expected), extra: true },
    }),
  ]) {
    const external = new MemoryMonotonicCasAuthority();
    external.onCas = async (request) => invalidCas(request);
    await assert.rejects(
      anchor(external).reconcile(genesis),
      (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN",
    );
  }

  const external = new MemoryMonotonicCasAuthority();
  await anchor(external).reconcile(genesis);
  const next = checkpoint(1, "commit-local-uncertain", genesis.commitId, "6");
  const casCallsBeforeLocalUncertain = external.casCalls.length;
  await assert.rejects(
    anchor(external).advance({
      current: genesis,
      next,
      publishState: () => ({ outcome: "uncertain" }),
    }),
    (error) => error.code === "STATE_COMMIT_UNCERTAIN",
  );
  assert.equal(external.casCalls.length, casCallsBeforeLocalUncertain);
});
