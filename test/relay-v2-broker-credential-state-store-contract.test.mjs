import assert from "node:assert/strict";
import test from "node:test";
import { registerRelayV2BrokerCredentialStateStoreConformance } from "./support/relayV2BrokerCredentialStateStoreConformance.mjs";
import {
  captureContractFailure,
  loadRelayV2BrokerCredentialStateStoreCorpus,
  materializeRelayV2BrokerCredentialCorruptCases,
  parseRelayV2BrokerCredentialBinaryContainer,
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

function rawFailure(code) {
  return Object.freeze({ code });
}

class RawMemoryBacking {
  bytes = null;
  generation = 0;
  publicationAttempts = 0;
}

class RawMemoryStore {
  #backing;
  #tail = Promise.resolve();
  #closing = false;
  #closePromise = null;
  #transactionSequence = 0;
  #revisions = new WeakMap();
  #uncertainMode = null;
  #publishCaptureBarrier = null;
  nativeClosed = false;

  constructor(backing) {
    this.#backing = backing;
    this.handle = Object.freeze({
      runExclusive: this.runExclusive.bind(this),
      close: this.close.bind(this),
    });
  }

  armUncertain(mode) {
    this.#uncertainMode = mode;
  }

  armPublishCapture(barrier) {
    this.#publishCaptureBarrier = barrier;
  }

  runExclusive(callback) {
    if (this.#closing) return Promise.reject(rawFailure("STORE_CLOSED"));
    const transactionId = ++this.#transactionSequence;
    const run = this.#tail.then(async () => {
      let active = true;
      const issueRevision = () => {
        const revision = Object.freeze(Object.create(null));
        this.#revisions.set(revision, {
          transactionId,
          generation: this.#backing.generation,
        });
        return revision;
      };
      const current = () => this.#backing.bytes === null
        ? { outcome: "missing", revision: issueRevision() }
        : {
            outcome: "present",
            revision: issueRevision(),
            bytes: this.#backing.bytes,
          };
      const transaction = Object.freeze({
        read: async () => {
          if (!active) throw rawFailure("INVALID_REVISION");
          return current();
        },
        compareAndPublish: async (expected, next) => {
          if (!active) throw rawFailure("INVALID_REVISION");
          const expectedRevision = this.#revisions.get(expected);
          if (!expectedRevision || expectedRevision.transactionId !== transactionId) {
            throw rawFailure("INVALID_REVISION");
          }
          const captureBarrier = this.#publishCaptureBarrier;
          this.#publishCaptureBarrier = null;
          if (captureBarrier) await captureBarrier();
          const copied = Buffer.from(next);
          if (this.#backing.bytes !== null && this.#backing.bytes.equals(copied)) {
            return { outcome: "already_same", current: current() };
          }
          if (expectedRevision.generation !== this.#backing.generation) {
            return { outcome: "conflict", current: current() };
          }
          this.#backing.publicationAttempts += 1;
          const uncertainMode = this.#uncertainMode;
          this.#uncertainMode = null;
          if (uncertainMode === "before") return { outcome: "uncertain" };
          this.#backing.bytes = copied;
          this.#backing.generation += 1;
          if (uncertainMode === "after") return { outcome: "uncertain" };
          return { outcome: "swapped", current: current() };
        },
      });
      try {
        await callback(transaction);
        return "native-does-not-echo-operation-result";
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

class MemoryAdapterContext {
  #backing = new RawMemoryBacking();
  #activeRawStore = null;

  constructor() {
    this.binding = Object.freeze({
      relayV2BrokerCredentialStateCapability: () => corpus.manifest.capability.supported,
      openRelayV2BrokerCredentialStateStore: (options) => {
        assert.deepEqual(options, {
          trustedHome: "/Users/fixture-owner",
          maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
        });
        assert.equal(Object.isFrozen(options), true);
        this.#activeRawStore = new RawMemoryStore(this.#backing);
        return {
          status: "opened",
          selfCheck: "passed",
          store: this.#activeRawStore.handle,
        };
      },
    });
  }

  deferred() {
    return deferred();
  }

  open() {
    return stateStore.openRelayV2BrokerCredentialStateStoreNativeBinding(
      this.binding,
      {
        trustedHome: "/Users/fixture-owner",
        maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
      },
    );
  }

  armUncertain(mode) {
    this.#activeRawStore.armUncertain(mode);
  }

  armPublishCapture(barrier) {
    this.#activeRawStore.armPublishCapture(barrier);
  }

  publicationAttempts() {
    return this.#backing.publicationAttempts;
  }

  nativeClosed() {
    return this.#activeRawStore.nativeClosed;
  }

}

test("manifest and fixtures freeze one deep descriptor-backed seam without production readiness", () => {
  const { manifest } = corpus;
  assert.equal(manifest.contract, "tmux-worktree-relay-v2-broker-credential-state-store");
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.fixtureFormatVersion, corpus.goldenFixtureFormatVersion);
  assert.equal(manifest.fixtureFormatVersion, corpus.corruptFile.fixtureFormatVersion);
  assert.equal(manifest.fixtureFormatVersion, corpus.nativeInterface.fixtureFormatVersion);
  assert.equal(corpus.goldenEncoding, "zero-filled-exact-file-with-absolute-segments");
  assert.equal(manifest.status, "frozen");
  assert.equal(manifest.scope, "native-storage-seam-only");
  assert.equal(manifest.productionCapabilityEffect, "none");
  assert.equal(manifest.businessOwner, "RelayV2BrokerCredentialAuthority");
  assert.equal(manifest.capability.supportedMeansReady, false);
  assert.equal(
    manifest.capability.supported.maxStateBytes,
    stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
  );
  assert.equal(
    manifest.capability.supported.durability,
    stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY,
  );
  assert.deepEqual(
    manifest.capability.supported.features,
    [...stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES],
  );
  assert.equal(manifest.nativeInterface.openArguments[0].exactKeys.join(","),
    "trustedHome,maxStateBytes");
  assert.equal(manifest.nativeInterface.openArguments[0].trustedHome.accountHomeRootOnly, true);
  assert.equal(manifest.nativeInterface.openArguments[0].trustedHome.descendantPathAllowed, false);
  assert.equal(manifest.nativeInterface.openArguments[0].maxStateBytes.mustEqualFrozenValue, true);
  assert.equal(manifest.nativeInterface.openArguments[0].maxStateBytes.callerConfigurable, false);
  assert.equal(manifest.openUnion.pathConfigurationAllowed, false);
  assert.equal(manifest.openUnion.implicitHomeLookupAllowed, false);
  assert.deepEqual(manifest.nativeInterface.storeMethods, ["runExclusive", "close"]);
  assert.deepEqual(manifest.nativeInterface.transactionMethods, ["read", "compareAndPublish"]);
  assert.deepEqual(manifest.port.runExclusive.compareAndPublishOutcomes.uncertain, ["outcome"]);
  assert.equal(manifest.port.close.admittedTransactionsRemainUsableDuringOrdinaryClose, true);
  assert.equal(manifest.binaryStorage.container.fileLengthBytes, 134217984);
  assert.equal(manifest.binaryStorage.container.layoutAlignmentBytes, 128);
  assert.deepEqual(
    manifest.binaryStorage.container.regions.map(({ name, offset, capacity }) => ({ name, offset, capacity })),
    [
      { name: "header0", offset: 0, capacity: 128 },
      { name: "header1", offset: 128, capacity: 128 },
      { name: "payload0", offset: 256, capacity: 67108864 },
      { name: "payload1", offset: 67109120, capacity: 67108864 },
    ],
  );
  const checksum = manifest.binaryStorage.headerLayout.find(({ name }) => name === "headerChecksum");
  assert.deepEqual(checksum.covers, { offset: 0, length: 96 });
  assert.deepEqual(manifest.binaryStorage.container.positionalIoOnly, ["pwrite", "write_at"]);
  assert.equal(manifest.binaryStorage.container.sharedCursorOrWriteAllowed, false);
  assert.equal(manifest.binaryStorage.container.namedReplaceAllowed, false);
  assert.equal(manifest.binaryStorage.container.renameAllowed, false);
  assert.equal(
    manifest.binaryStorage.container.missingInitialization.initialPayloads,
    "both-67108864-byte-regions-logically-all-zero",
  );
  assert.deepEqual(
    manifest.port.runExclusive.postPublishFailure.provenNoCommitCodes,
    ["INVALID_ARGUMENT", "INVALID_REVISION", "STATE_TOO_LARGE", "GENERATION_EXHAUSTED"],
  );
  assert.equal(
    manifest.binaryStorage.container.locking.primitive,
    "process-wide-exclusive-kernel-lock-on-the-same-container-descriptor",
  );
  assert.equal(manifest.binaryStorage.container.locking.contention, "STORE_BUSY");
  assert.equal(manifest.binaryStorage.container.locking.perTransactionReleaseAllowed, false);
  assert.equal(manifest.binaryStorage.container.locking.lockFileAllowed, false);
  assert.equal(manifest.binaryStorage.legacyPrototypeArtifacts,
    "never-read-imported-migrated-renamed-unlinked-or-cleaned");
});

test("binary v1 exact-container golden fixtures select committed state", () => {
  for (const fixture of corpus.golden) {
    const parsed = parseRelayV2BrokerCredentialBinaryContainer(fixture.container);
    assert.equal(parsed.outcome, fixture.expected.outcome, fixture.name);
    if (parsed.outcome === "present") {
      assert.equal(parsed.generation, fixture.expected.generation, fixture.name);
      assert.equal(parsed.payload.toString("base64"), fixture.expected.payloadBase64, fixture.name);
      assert.equal(parsed.payloadSha256, fixture.expected.payloadSha256, fixture.name);
    }
  }
});

test("binary v1 corrupt, unknown, and crash-selection fixtures are closed", () => {
  for (const vector of materializeRelayV2BrokerCredentialCorruptCases(corpus)) {
    const captured = captureContractFailure(() => (
      parseRelayV2BrokerCredentialBinaryContainer(vector.container, vector.mutations)
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

test("native options, capability, open, and errors decode as closed copied values", async () => {
  for (const fixture of corpus.nativeInterface.openOptionsCases) {
    assert.equal(
      stateStore.isRelayV2BrokerCredentialStateStoreOpenOptions(fixture.input),
      fixture.expected === "valid",
      fixture.name,
    );
  }
  for (const fixture of corpus.nativeInterface.capabilityCases) {
    const parsed = stateStore.parseRelayV2BrokerCredentialStateStoreCapability(fixture.input);
    assert.equal(parsed.status, fixture.expected.status, fixture.name);
    if (parsed.status === "unsupported") assert.equal(parsed.reason, fixture.expected.reason, fixture.name);
    if (parsed.status === "invalid") assert.equal(parsed.error.code, fixture.expected.errorCode, fixture.name);
  }

  const marker = new RawMemoryStore(new RawMemoryBacking());
  for (const fixture of corpus.nativeInterface.openCases) {
    const input = structuredClone(fixture.input);
    if (input.store === "materialize-test-store") input.store = marker.handle;
    const parsed = stateStore.parseRelayV2BrokerCredentialStateStoreOpenResult(input);
    assert.equal(parsed.status, fixture.expected.status, fixture.name);
    if (parsed.status === "unsupported") assert.equal(parsed.reason, fixture.expected.reason, fixture.name);
    if (parsed.status === "invalid") assert.equal(parsed.error.code, fixture.expected.errorCode, fixture.name);
    if (parsed.status === "opened") await parsed.store.close();
  }

  for (const fixture of corpus.nativeInterface.errorCases) {
    const parsed = stateStore.parseRelayV2BrokerCredentialStateStoreFailure(fixture.input);
    assert.equal(parsed.code, fixture.expectedCode, fixture.name);
  }
});

test("runtime boundary rejects accessors, raw throws, and malformed raw store values", async () => {
  let accessorReads = 0;
  const accessorOptions = { maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES };
  Object.defineProperty(accessorOptions, "trustedHome", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "/Users/fixture-owner";
    },
  });
  const neverCalledBinding = Object.freeze({
    relayV2BrokerCredentialStateCapability: () => corpus.manifest.capability.supported,
    openRelayV2BrokerCredentialStateStore: () => { throw new Error("must not run"); },
  });
  const accessorResult = await stateStore.openRelayV2BrokerCredentialStateStoreNativeBinding(
    neverCalledBinding,
    accessorOptions,
  );
  assert.equal(accessorResult.status, "invalid");
  assert.equal(accessorResult.error.code, "INVALID_ARGUMENT");
  assert.equal(accessorReads, 0, "accessor options are rejected without invoking the getter");

  let descriptorReads = 0;
  let receivedOptions;
  const descriptorSnapshot = new Proxy({}, {
    ownKeys: () => ["trustedHome", "maxStateBytes"],
    getOwnPropertyDescriptor: (_target, property) => {
      descriptorReads += 1;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: property === "trustedHome"
          ? "/Users/fixture-owner"
          : stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
      };
    },
  });
  const raw = new RawMemoryStore(new RawMemoryBacking());
  const snapshotBinding = Object.freeze({
    relayV2BrokerCredentialStateCapability: () => corpus.manifest.capability.supported,
    openRelayV2BrokerCredentialStateStore: (options) => {
      receivedOptions = options;
      return { status: "opened", selfCheck: "passed", store: raw.handle };
    },
  });
  const snapshotResult = await stateStore.openRelayV2BrokerCredentialStateStoreNativeBinding(
    snapshotBinding,
    descriptorSnapshot,
  );
  assert.equal(snapshotResult.status, "opened");
  assert.equal(descriptorReads, 2, "each own data descriptor is captured once");
  assert.deepEqual(receivedOptions, {
    trustedHome: "/Users/fixture-owner",
    maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
  });
  await snapshotResult.store.close();

  const capabilityGetter = {};
  Object.defineProperty(capabilityGetter, "status", { get() { throw new Error("getter"); } });
  assert.equal(
    stateStore.parseRelayV2BrokerCredentialStateStoreCapability(capabilityGetter).error.code,
    "NATIVE_INTERFACE_INVALID",
  );
  let changingReasonReads = 0;
  const changingUnsupported = { status: "unsupported" };
  Object.defineProperty(changingUnsupported, "reason", {
    enumerable: true,
    get() {
      changingReasonReads += 1;
      return changingReasonReads === 1 ? "native_artifact_missing" : "evil";
    },
  });
  const changingUnsupportedResult =
    stateStore.parseRelayV2BrokerCredentialStateStoreCapability(changingUnsupported);
  assert.equal(changingUnsupportedResult.status, "invalid");
  assert.equal(changingUnsupportedResult.error.code, "NATIVE_INTERFACE_INVALID");
  assert.equal(changingReasonReads, 0, "changing union accessors are never evaluated");
  const throwingBinding = Object.freeze({
    relayV2BrokerCredentialStateCapability: () => { throw new Error("raw"); },
    openRelayV2BrokerCredentialStateStore: () => { throw new Error("raw"); },
  });
  assert.equal(
    stateStore.readRelayV2BrokerCredentialStateStoreNativeCapability(throwingBinding).error.code,
    "NATIVE_INTERFACE_INVALID",
  );
  const rawOpenThrow = await stateStore.openRelayV2BrokerCredentialStateStoreNativeBinding(
    throwingBinding,
    { trustedHome: "/Users/fixture-owner", maxStateBytes: 67108864 },
  );
  assert.equal(rawOpenThrow.error.code, "NATIVE_INTERFACE_INVALID");

  const hostileStore = {};
  Object.defineProperties(hostileStore, {
    runExclusive: { enumerable: true, get() { throw new Error("getter"); } },
    close: { enumerable: true, value: () => undefined },
  });
  const hostileOpen = stateStore.parseRelayV2BrokerCredentialStateStoreOpenResult({
    status: "opened",
    selfCheck: "passed",
    store: hostileStore,
  });
  assert.equal(hostileOpen.status, "invalid");
  assert.equal(hostileOpen.error.code, "NATIVE_INTERFACE_INVALID");
});

test("runtime store wrapper closes raw operation shapes and legal error codes", async () => {
  const rawTransaction = (read) => Object.freeze({
    read,
    compareAndPublish: async () => ({ outcome: "uncertain" }),
  });
  const openRaw = (transaction) => stateStore.parseRelayV2BrokerCredentialStateStoreOpenResult({
    status: "opened",
    selfCheck: "passed",
    store: Object.freeze({
      runExclusive: async (callback) => { await callback(transaction); },
      close: async () => undefined,
    }),
  });

  const legal = openRaw(rawTransaction(async () => { throw rawFailure("STORE_BUSY"); }));
  await assert.rejects(
    legal.store.runExclusive((transaction) => transaction.read()),
    (error) => error.code === "STORE_BUSY" && error.retryable === true,
  );
  await legal.store.close();

  const rawError = openRaw(rawTransaction(async () => { throw new Error("raw"); }));
  await assert.rejects(
    rawError.store.runExclusive((transaction) => transaction.read()),
    (error) => error.code === "NATIVE_INTERFACE_INVALID",
  );
  await rawError.store.close();

  let forgedCodeReads = 0;
  const forgedLocalError = Object.create(
    stateStore.RelayV2BrokerCredentialStateStoreError.prototype,
  );
  Object.defineProperty(forgedLocalError, "code", {
    enumerable: true,
    get() {
      forgedCodeReads += 1;
      return "STORE_BUSY";
    },
  });
  const forged = openRaw(rawTransaction(async () => { throw forgedLocalError; }));
  await assert.rejects(
    forged.store.runExclusive((transaction) => transaction.read()),
    (error) => error.code === "NATIVE_INTERFACE_INVALID",
  );
  assert.equal(forgedCodeReads, 0, "forged local error code accessor is never evaluated");
  await forged.store.close();

  const getterValue = {};
  Object.defineProperty(getterValue, "outcome", { get() { throw new Error("getter"); } });
  const getter = openRaw(rawTransaction(async () => getterValue));
  await assert.rejects(
    getter.store.runExclusive((transaction) => transaction.read()),
    (error) => error.code === "NATIVE_INTERFACE_INVALID",
  );
  await getter.store.close();

  let changingBytesReads = 0;
  const changingBytesValue = {
    outcome: "present",
    revision: Object.freeze({}),
  };
  Object.defineProperty(changingBytesValue, "bytes", {
    enumerable: true,
    get() {
      changingBytesReads += 1;
      return changingBytesReads === 1 ? new Uint8Array([1]) : new Uint8Array(67108865);
    },
  });
  const changingBytes = openRaw(rawTransaction(async () => changingBytesValue));
  await assert.rejects(
    changingBytes.store.runExclusive((transaction) => transaction.read()),
    (error) => error.code === "NATIVE_INTERFACE_INVALID",
  );
  assert.equal(changingBytesReads, 0, "changing bytes accessor cannot bypass size decode");
  await changingBytes.store.close();
});

test("post-publish malformed results and unstructured failures terminal-close the store", async () => {
  const openRaw = (rawPublish) => {
    const rawRevision = Object.freeze({});
    let publicationAttempts = 0;
    const transaction = Object.freeze({
      read: async () => ({ outcome: "missing", revision: rawRevision }),
      compareAndPublish: async (...args) => {
        publicationAttempts += 1;
        return rawPublish(...args);
      },
    });
    const opened = stateStore.parseRelayV2BrokerCredentialStateStoreOpenResult({
      status: "opened",
      selfCheck: "passed",
      store: Object.freeze({
        runExclusive: async (callback) => { await callback(transaction); },
        close: async () => undefined,
      }),
    });
    return { store: opened.store, publicationAttempts: () => publicationAttempts };
  };

  const cases = [
    ["malformed closed-union result", async () => ({ outcome: "swapped" }), "NATIVE_INTERFACE_INVALID"],
    ["unstructured raw failure", async () => { throw new Error("raw post-publish failure"); }, "NATIVE_INTERFACE_INVALID"],
    ["exact error without no-commit proof", async () => { throw rawFailure("STORE_IO"); }, "STORE_IO"],
  ];
  for (const [name, rawPublish, expectedCode] of cases) {
    const context = openRaw(rawPublish);
    await context.store.runExclusive(async (transaction) => {
      const current = await transaction.read();
      await assert.rejects(
        transaction.compareAndPublish(current.revision, new Uint8Array([1])),
        (error) => error.code === expectedCode,
        name,
      );
      await assert.rejects(
        transaction.read(),
        (error) => error.code === "STORE_CLOSED",
        `${name} fences the active transaction`,
      );
    });
    assert.equal(context.publicationAttempts(), 1, `${name} crossed the raw publish boundary`);
    await assert.rejects(
      context.store.runExclusive(() => undefined),
      (error) => error.code === "STORE_CLOSED",
      `${name} fences new admission`,
    );
    assert.equal(context.publicationAttempts(), 1, `${name} is never resent`);
    await context.store.close();
  }

  const provenNoCommit = openRaw(async () => { throw rawFailure("GENERATION_EXHAUSTED"); });
  await provenNoCommit.store.runExclusive(async (transaction) => {
    const current = await transaction.read();
    await assert.rejects(
      transaction.compareAndPublish(current.revision, new Uint8Array([1])),
      (error) => error.code === "GENERATION_EXHAUSTED",
    );
    assert.equal((await transaction.read()).outcome, "missing");
  });
  await provenNoCommit.store.runExclusive(async (transaction) => {
    assert.equal((await transaction.read()).outcome, "missing");
  });
  await provenNoCommit.store.close();
});

test("runtime runExclusive requires exactly one settled callback without identity echo", async () => {
  const openRaw = (runExclusive) => stateStore.parseRelayV2BrokerCredentialStateStoreOpenResult({
    status: "opened",
    selfCheck: "passed",
    store: Object.freeze({ runExclusive, close: async () => undefined }),
  }).store;

  const inertTransaction = Object.freeze({
    read: async () => ({ outcome: "missing", revision: Object.freeze({}) }),
    compareAndPublish: async () => ({ outcome: "uncertain" }),
  });

  const noEcho = openRaw(async (callback) => {
    await callback(inertTransaction);
    return "unrelated-native-result";
  });
  assert.equal(await noEcho.runExclusive(() => "wrapper-result"), "wrapper-result");
  await noEcho.close();

  const duplicate = openRaw(async (callback) => {
    await callback(inertTransaction);
    try { await callback(inertTransaction); } catch {}
  });
  await assert.rejects(
    duplicate.runExclusive(() => undefined),
    (error) => error.code === "NATIVE_INTERFACE_INVALID",
  );
  await assert.rejects(
    duplicate.runExclusive(() => undefined),
    (error) => error.code === "STORE_CLOSED",
  );
  await duplicate.close();

  for (const settlement of ["resolve", "reject", "throw"]) {
    const release = deferred();
    const entered = deferred();
    const callbackDone = deferred();
    const rawRevision = Object.freeze({});
    const rawBacking = { publicationAttempts: 0 };
    const transaction = Object.freeze({
      read: async () => ({ outcome: "missing", revision: rawRevision }),
      compareAndPublish: async () => {
        rawBacking.publicationAttempts += 1;
        return { outcome: "uncertain" };
      },
    });
    const early = openRaw((callback) => {
      const pendingCallback = callback(transaction);
      void pendingCallback.then(callbackDone.resolve, callbackDone.resolve);
      if (settlement === "resolve") return undefined;
      if (settlement === "reject") return Promise.reject(rawFailure("STORE_BUSY"));
      throw rawFailure("STORE_BUSY");
    });
    const running = early.runExclusive(async (wrappedTransaction) => {
      entered.resolve();
      let expectedRevision;
      let initialReadError;
      try {
        const initial = await wrappedTransaction.read();
        expectedRevision = initial.revision;
      } catch (error) {
        initialReadError = error;
      }
      if (settlement === "throw") {
        assert.equal(initialReadError?.code, "STORE_CLOSED");
        assert.equal(expectedRevision, undefined);
      } else {
        assert.equal(initialReadError, undefined);
        assert.notEqual(expectedRevision, undefined);
      }
      await release.promise;
      await assert.rejects(
        wrappedTransaction.read(),
        (error) => error.code === "STORE_CLOSED",
      );
      await assert.rejects(
        wrappedTransaction.compareAndPublish(
          expectedRevision ?? Object.freeze({}),
          new Uint8Array([1]),
        ),
        (error) => error.code === "STORE_CLOSED",
      );
    });
    const rejected = assert.rejects(
      running,
      (error) => error.code === "NATIVE_INTERFACE_INVALID",
      `raw early ${settlement} is closed`,
    );
    await entered.promise;
    await rejected;
    await assert.rejects(
      early.runExclusive(() => undefined),
      (error) => error.code === "STORE_CLOSED",
      `raw early ${settlement} fences new admission`,
    );
    release.resolve();
    await callbackDone.promise;
    assert.equal(
      rawBacking.publicationAttempts,
      0,
      `raw early ${settlement} cannot publish from its background callback`,
    );
    await early.close();
  }
});

registerRelayV2BrokerCredentialStateStoreConformance({
  test,
  assert,
  stateStore,
  label: "in-memory raw-adapter model (not native evidence)",
  createContext: () => new MemoryAdapterContext(),
});
