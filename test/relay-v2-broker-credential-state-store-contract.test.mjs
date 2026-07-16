import assert from "node:assert/strict";
import test from "node:test";
import {
  captureContractFailure,
  loadRelayV2BrokerCredentialStateStoreCorpus,
  materializeRelayV2BrokerCredentialCorruptCases,
  parseRelayV2BrokerCredentialBinaryObjects,
} from "./support/relayV2BrokerCredentialStateStoreFixtures.mjs";

const stateStore = await import("../dist/relay/v2/brokerCredentialStateStore.js");
const corpus = loadRelayV2BrokerCredentialStateStoreCorpus();

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function bytes(value) {
  return Buffer.from(value, "utf8");
}

function storeError(code) {
  return new stateStore.RelayV2BrokerCredentialStateStoreError(code);
}

class MemoryConformanceStore {
  #bytes = null;
  #generation = 0;
  #tail = Promise.resolve();
  #closing = false;
  #closePromise = null;
  #transactionSequence = 0;
  #revisions = new WeakMap();
  #uncertainMode = null;
  #publishCaptureBarrier = null;
  nativeClosed = false;

  setUncertainMode(mode) {
    this.#uncertainMode = mode;
  }

  setPublishCaptureBarrier(barrier) {
    this.#publishCaptureBarrier = barrier;
  }

  runExclusive(operation) {
    if (this.#closing) return Promise.reject(storeError("STORE_CLOSED"));
    const transactionId = ++this.#transactionSequence;
    const run = this.#tail.then(async () => {
      let active = true;
      const issueRevision = () => {
        const revision = Object.create(null);
        Object.defineProperty(revision, "toJSON", {
          value() {
            throw storeError("INVALID_REVISION");
          },
        });
        Object.freeze(revision);
        this.#revisions.set(revision, { transactionId, generation: this.#generation });
        return revision;
      };
      const assertActive = () => {
        if (!active) throw storeError("INVALID_REVISION");
      };
      const transaction = {
        read: async () => {
          assertActive();
          const revision = issueRevision();
          return this.#bytes === null
            ? { outcome: "missing", revision }
            : { outcome: "present", revision, bytes: Buffer.from(this.#bytes) };
        },
        compareAndPublish: async (expected, nextValue) => {
          assertActive();
          const expectedRevision = this.#revisions.get(expected);
          if (!expectedRevision || expectedRevision.transactionId !== transactionId) {
            throw storeError("INVALID_REVISION");
          }
          if (!(nextValue instanceof Uint8Array) || nextValue.byteLength === 0) {
            throw storeError("INVALID_ARGUMENT");
          }
          if (nextValue.byteLength > stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES) {
            throw storeError("STATE_TOO_LARGE");
          }
          const next = Buffer.from(nextValue);
          const captureBarrier = this.#publishCaptureBarrier;
          this.#publishCaptureBarrier = null;
          if (captureBarrier) await captureBarrier();
          if (this.#bytes !== null && this.#bytes.equals(next)) {
            return { outcome: "already_same", revision: issueRevision() };
          }
          if (expectedRevision.generation !== this.#generation) {
            return { outcome: "conflict", revision: issueRevision() };
          }
          const uncertainMode = this.#uncertainMode;
          this.#uncertainMode = null;
          if (uncertainMode === "before") return { outcome: "uncertain" };
          this.#bytes = next;
          this.#generation += 1;
          if (uncertainMode === "after") return { outcome: "uncertain" };
          return { outcome: "swapped", revision: issueRevision() };
        },
      };
      try {
        return await operation(transaction);
      } finally {
        active = false;
      }
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  close() {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#tail.then(() => {
      this.nativeClosed = true;
    });
    return this.#closePromise;
  }
}

test("N0 manifest freezes one deep native seam without paths or production capability", () => {
  const { manifest } = corpus;
  assert.equal(manifest.contract, "tmux-worktree-relay-v2-broker-credential-state-store");
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.status, "frozen");
  assert.equal(manifest.scope, "native-storage-seam-only");
  assert.equal(manifest.productionCapabilityEffect, "none");
  assert.equal(manifest.businessOwner, "RelayV2BrokerCredentialAuthority");
  assert.deepEqual(manifest.nativeInterface.openArguments, []);
  assert.deepEqual(manifest.nativeInterface.storeMethods, ["runExclusive", "close"]);
  assert.deepEqual(manifest.nativeInterface.transactionMethods, ["read", "compareAndPublish"]);
  assert.equal(manifest.openUnion.pathConfigurationAllowed, false);
  assert.equal(manifest.port.runExclusive.revisionScope, "issuing-transaction-only");
  assert.equal(manifest.port.runExclusive.revisionSerializable, false);
  assert.deepEqual(manifest.port.runExclusive.compareAndPublishOutcomes.uncertain, ["outcome"]);
  assert.equal(manifest.binaryStorage.legacyPrototypeArtifacts,
    "never-read-imported-migrated-renamed-unlinked-or-cleaned");
});

test("binary v1 golden objects select one exact generation and payload", () => {
  for (const fixture of corpus.golden) {
    const parsed = parseRelayV2BrokerCredentialBinaryObjects(fixture.objects);
    assert.equal(parsed.outcome, fixture.expected.outcome, fixture.name);
    if (parsed.outcome === "present") {
      assert.equal(parsed.generation, fixture.expected.generation, fixture.name);
      assert.equal(parsed.payload.toString("base64"), fixture.expected.payloadBase64, fixture.name);
      assert.equal(parsed.payloadSha256, fixture.expected.payloadSha256, fixture.name);
    }
  }
});

test("binary v1 corruption, unknown formats, and inert partial slots are closed", () => {
  for (const vector of materializeRelayV2BrokerCredentialCorruptCases(corpus)) {
    const captured = captureContractFailure(() => (
      parseRelayV2BrokerCredentialBinaryObjects(vector.objects)
    ));
    assert.equal(captured.outcome, vector.expected.outcome === "reject" ? "reject" : "success", vector.name);
    if (vector.expected.outcome === "reject") {
      assert.equal(captured.errorCode, vector.expected.errorCode, vector.name);
    } else {
      assert.equal(captured.value.outcome, "present", vector.name);
      assert.equal(captured.value.generation, vector.expected.generation, vector.name);
      assert.equal(captured.value.payloadSha256, vector.expected.payloadSha256, vector.name);
    }
  }
});

test("native capability, open, and error fixtures normalize to closed unions", () => {
  for (const fixture of corpus.nativeInterface.capabilityCases) {
    const parsed = stateStore.parseRelayV2BrokerCredentialStateStoreCapability(fixture.input);
    assert.equal(parsed.status, fixture.expected.status, fixture.name);
    if (parsed.status === "unsupported") assert.equal(parsed.reason, fixture.expected.reason, fixture.name);
    if (parsed.status === "invalid") assert.equal(parsed.error.code, fixture.expected.errorCode, fixture.name);
  }

  const markerStore = new MemoryConformanceStore();
  for (const fixture of corpus.nativeInterface.openCases) {
    const input = structuredClone(fixture.input);
    if (input.store === "materialize-test-store") input.store = markerStore;
    const parsed = stateStore.parseRelayV2BrokerCredentialStateStoreOpenResult(input);
    assert.equal(parsed.status, fixture.expected.status, fixture.name);
    if (parsed.status === "unsupported") assert.equal(parsed.reason, fixture.expected.reason, fixture.name);
    if (parsed.status === "invalid") assert.equal(parsed.error.code, fixture.expected.errorCode, fixture.name);
  }

  for (const fixture of corpus.nativeInterface.errorCases) {
    const parsed = stateStore.parseRelayV2BrokerCredentialStateStoreFailure(fixture.input);
    assert.equal(parsed.code, fixture.expectedCode, fixture.name);
  }
});

test("in-memory port conformance keeps revisions transaction-scoped and compare outcomes exact", async () => {
  const store = new MemoryConformanceStore();
  let escapedRevision;
  await store.runExclusive(async (transaction) => {
    const missing = await transaction.read();
    assert.equal(missing.outcome, "missing");
    assert.deepEqual(Object.keys(missing.revision), []);
    assert.throws(() => JSON.stringify(missing.revision), (error) => error.code === "INVALID_REVISION");
    escapedRevision = missing.revision;

    const swapped = await transaction.compareAndPublish(missing.revision, bytes("alpha"));
    assert.equal(swapped.outcome, "swapped");
    const sameFromStaleRevision = await transaction.compareAndPublish(missing.revision, bytes("alpha"));
    assert.equal(sameFromStaleRevision.outcome, "already_same");
    const conflict = await transaction.compareAndPublish(missing.revision, bytes("beta"));
    assert.equal(conflict.outcome, "conflict");
  });

  await assert.rejects(
    store.runExclusive((transaction) => transaction.compareAndPublish(escapedRevision, bytes("alpha"))),
    (error) => error.code === "INVALID_REVISION",
  );

  await store.runExclusive(async (transaction) => {
    const present = await transaction.read();
    assert.equal(present.outcome, "present");
    present.bytes[0] ^= 1;
  });
  await store.runExclusive(async (transaction) => {
    const present = await transaction.read();
    assert.equal(present.bytes.toString("utf8"), "alpha", "read bytes do not alias store state");
  });

  const captured = deferred();
  const release = deferred();
  store.setPublishCaptureBarrier(async () => {
    captured.resolve();
    await release.promise;
  });
  const callerBytes = bytes("captured");
  const publishing = store.runExclusive(async (transaction) => {
    const present = await transaction.read();
    return transaction.compareAndPublish(present.revision, callerBytes);
  });
  await captured.promise;
  callerBytes.fill(0);
  release.resolve();
  assert.equal((await publishing).outcome, "swapped");
  await store.runExclusive(async (transaction) => {
    const present = await transaction.read();
    assert.equal(present.bytes.toString("utf8"), "captured", "publish captures its own byte copy");
  });
});

test("uncertain publication exposes no revision and only a later transaction reconciles", async () => {
  const store = new MemoryConformanceStore();
  store.setUncertainMode("after");
  const uncertain = await store.runExclusive(async (transaction) => {
    const missing = await transaction.read();
    return transaction.compareAndPublish(missing.revision, bytes("possibly-committed"));
  });
  assert.deepEqual(uncertain, { outcome: "uncertain" });

  await store.runExclusive(async (transaction) => {
    const observed = await transaction.read();
    assert.equal(observed.outcome, "present");
    assert.equal(observed.bytes.toString("utf8"), "possibly-committed");
  });
});

test("close is an idempotent barrier over already-admitted transactions", async () => {
  const store = new MemoryConformanceStore();
  const entered = deferred();
  const release = deferred();
  const active = store.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  const close = store.close();
  assert.strictEqual(store.close(), close);
  let closed = false;
  close.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(store.runExclusive(() => undefined), (error) => error.code === "STORE_CLOSED");

  release.resolve();
  await active;
  await close;
  assert.equal(store.nativeClosed, true);
});
