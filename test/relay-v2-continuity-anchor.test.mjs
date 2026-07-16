import assert from "node:assert/strict";
import test from "node:test";

const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
const ANCHOR_ID = "relay-v2-credential-state";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

class MemoryMonotonicCasAuthority {
  constructor() {
    this.tokenSequence = 0;
    this.current = {
      protocolVersion: VERSION,
      status: "uninitialized",
      anchorId: ANCHOR_ID,
      casToken: "cas-0",
    };
    this.failNextCas = false;
    this.competingCheckpoint = null;
  }

  async read(request) {
    assert.deepEqual(request, { protocolVersion: VERSION, anchorId: ANCHOR_ID });
    return clone(this.current);
  }

  async compareAndSwap(request) {
    assert.equal(request.protocolVersion, VERSION);
    assert.equal(request.anchorId, ANCHOR_ID);

    if (this.failNextCas) {
      this.failNextCas = false;
      throw new Error("injected external authority outage");
    }
    if (this.competingCheckpoint !== null) {
      const competitor = this.competingCheckpoint;
      this.competingCheckpoint = null;
      this.commit(competitor);
    }
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

function anchor(authority) {
  return new continuity.RelayV2ContinuityAnchor({
    anchorId: ANCHOR_ID,
    authority,
  });
}

test("external anchor repairs the single state-before-anchor crash window", async () => {
  assert.throws(
    () => new continuity.RelayV2ContinuityAnchor({ anchorId: ANCHOR_ID }),
    /must be supplied by the caller/,
  );

  const authority = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-genesis", null, "a");
  const next = checkpoint(1, "commit-after-crash", genesis.commitId, "b");
  let localState = genesis;

  assert.equal((await anchor(authority).reconcile(genesis)).disposition, "initialized");
  authority.failNextCas = true;
  await assert.rejects(
    anchor(authority).advance({
      current: genesis,
      next,
      publishState: (published) => { localState = clone(published); },
    }),
    (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN",
  );
  assert.deepEqual(localState, next);
  assert.deepEqual(authority.current.checkpoint, genesis);

  const reopened = anchor(authority);
  const recovered = await reopened.reconcile(localState);
  assert.equal(recovered.disposition, "recovered_state_before_anchor");
  assert.deepEqual(recovered.anchor.checkpoint, next);
});

test("an identical CAS winner converges while a divergent winner fences local state", async () => {
  const convergentAuthority = new MemoryMonotonicCasAuthority();
  const convergentGenesis = checkpoint(0, "commit-convergent-genesis", null, "d");
  const sharedNext = checkpoint(1, "commit-shared", convergentGenesis.commitId, "e");
  await anchor(convergentAuthority).reconcile(convergentGenesis);
  convergentAuthority.competingCheckpoint = sharedNext;
  const converged = await anchor(convergentAuthority).advance({
    current: convergentGenesis,
    next: sharedNext,
    publishState: () => {},
  });
  assert.equal(converged.disposition, "converged_after_cas_conflict");
  assert.deepEqual(converged.anchor.checkpoint, sharedNext);

  const authority = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-genesis", null, "a");
  const ours = checkpoint(1, "commit-ours", genesis.commitId, "b");
  const competitor = checkpoint(1, "commit-competitor", genesis.commitId, "c");
  let localState = genesis;

  await anchor(authority).reconcile(genesis);
  authority.competingCheckpoint = competitor;
  await assert.rejects(
    anchor(authority).advance({
      current: genesis,
      next: ours,
      publishState: (published) => { localState = clone(published); },
    }),
    (error) => error.code === "CAS_CONFLICT",
  );
  assert.deepEqual(localState, ours);
  assert.deepEqual(authority.current.checkpoint, competitor);
  await assert.rejects(
    anchor(authority).reconcile(localState),
    (error) => error.code === "ROLLBACK_DETECTED",
  );
});

test("restoring a paired local state and witness cannot roll back the external anchor", async () => {
  const authority = new MemoryMonotonicCasAuthority();
  const genesis = checkpoint(0, "commit-genesis", null, "a");
  const committed = checkpoint(1, "commit-current", genesis.commitId, "b");
  const rolledBackPair = {
    state: clone(genesis),
    witness: clone(genesis),
  };
  let localState = genesis;

  const protocol = anchor(authority);
  await protocol.reconcile(genesis);
  assert.equal((await protocol.advance({
    current: genesis,
    next: committed,
    publishState: (published) => { localState = clone(published); },
  })).disposition, "committed");
  assert.deepEqual(localState, committed);

  localState = rolledBackPair.state;
  assert.deepEqual(rolledBackPair.witness, genesis);
  await assert.rejects(
    anchor(authority).reconcile(localState),
    (error) => error.code === "ROLLBACK_DETECTED",
  );
  assert.deepEqual(authority.current.checkpoint, committed);
});
