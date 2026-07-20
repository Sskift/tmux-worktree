import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nativeCell = await import(
  "../dist/relay/v2/hostCredentialAtomicFileCellNative.js"
);
const contractRoot = new URL(
  "../contracts/relay/v2/host-credential-atomic-file-cell-v1/",
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", contractRoot), "utf8"));
const fixture = JSON.parse(
  readFileSync(new URL("native-interface-cases.json", contractRoot), "utf8"),
);
const platformFixture = JSON.parse(
  readFileSync(new URL("platform-resource-cases.json", contractRoot), "utf8"),
);
const claimJournalFixture = JSON.parse(
  readFileSync(new URL("claim-journal-v1.json", contractRoot), "utf8"),
);

const ABI_VERSION = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION;
const OPEN_METHOD = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_OPEN_METHOD;

function errorCode(code) {
  return (error) => error?.code === code;
}

function exactClosed(operations, operation, outcome, fields = {}) {
  return { abiVersion: ABI_VERSION, operation, outcome, ...fields };
}

function materialize(value, context) {
  if (Array.isArray(value)) return value.map((item) => materialize(item, context));
  if (value === null || typeof value !== "object") {
    if (value === "materialize-handle") return context.handle;
    if (value === "materialize-native-revision") return context.revision;
    return value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "bytesBase64") result.bytes = Uint8Array.from(Buffer.from(item, "base64"));
    else result[key] = materialize(item, context);
  }
  return result;
}

function rawHarness({ readResult, compareResult, closeResult } = {}) {
  const state = {
    openRequests: [],
    readRequests: [],
    compareRequests: [],
    closeRequests: [],
  };
  const revision = Object.freeze(Object.create(null));
  const handle = Object.freeze({
    read(request) {
      state.readRequests.push(request);
      return materialize(readResult ?? exactClosed([], "read", "ok", {
        current: { state: "empty", revision: "materialize-native-revision" },
      }), { handle, revision });
    },
    compareAndSwap(request) {
      state.compareRequests.push(request);
      return materialize(compareResult ?? exactClosed([], "compare_and_swap", "swapped"), {
        handle,
        revision,
      });
    },
    close(request) {
      state.closeRequests.push(request);
      return materialize(closeResult ?? exactClosed([], "close", "closed"), {
        handle,
        revision,
      });
    },
  });
  return { state, revision, handle };
}

function moduleFor(rawOpen, harness) {
  return Object.freeze({
    [OPEN_METHOD](request) {
      harness.state.openRequests.push(request);
      return materialize(rawOpen, harness);
    },
  });
}

function openWith(rawOpen, harness) {
  return nativeCell.openRelayV2HostCredentialAtomicFileCellNative({
    nativeModule: moduleFor(rawOpen, harness),
  });
}

function assertRequest(request, operation, keys) {
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.getPrototypeOf(request), null);
  assert.deepEqual(Object.keys(request).sort(), [...keys].sort());
  assert.equal(request.abiVersion, ABI_VERSION);
  assert.equal(request.operation, operation);
}

function assertSameMembers(actual, expected) {
  assert.equal(actual.every((value) => expected.includes(value)), true);
  assert.equal(expected.every((value) => actual.includes(value)), true);
}

test("Host credential native ABI manifest and every machine case stay closed", async () => {
  assert.equal(manifest.contract, "tmux-worktree-relay-v2-host-credential-atomic-file-cell");
  assert.equal(manifest.contractVersion, 2);
  assert.equal(
    manifest.scope,
    "host-credential-native-abi-and-isolated-platform-admission-contract-foundation",
  );
  assert.equal(manifest.productionWired, false);
  assert.equal(manifest.fixtureFormatVersion, fixture.fixtureFormatVersion);
  assert.deepEqual(manifest.files, [
    { role: "specification", path: "README.md" },
    { role: "native-interface", path: "native-interface-cases.json" },
    { role: "platform-resource-cases", path: "platform-resource-cases.json" },
    { role: "claim-journal-golden", path: "claim-journal-v1.json" },
  ]);
  assert.equal(manifest.nativeInterface.abiVersion, ABI_VERSION);
  assert.deepEqual(manifest.nativeInterface.moduleMethods, [OPEN_METHOD]);
  assert.deepEqual(manifest.nativeInterface.handleMethods, ["read", "compareAndSwap", "close"]);
  assert.equal(manifest.productionCapabilityEffect, "none");
  assert.equal(manifest.businessOwner, "RelayV2HostCredentialVault");
  assert.deepEqual(manifest.nativeModuleAuthority, {
    source: "future-production-composition-single-trusted-factory",
    binding: "pre-bound-exact-host-credential-cell-directory-descriptor-capability",
    futureNativeHolder: "4b2a-host-platform-common-admission-owner",
    wrapperOpenConsumesBoundCapabilityOnly: true,
    pathOrDescriptorArgumentInAbi: false,
    homePathEnvironmentOrGlobalLookupAllowed: false,
    factoryLoaderOrPathImplementedIn4b1: false,
    platformAdmissionImplementedIn4b2a: true,
    platformAdmissionProductionWired: false,
  });
  assert.equal(manifest.bytes.maximumBytes, 65_536);
  assert.deepEqual(manifest.revision.publicFields, []);
  assert.deepEqual(manifest.revision.rejectedBeforeRawMutation,
    ["foreign", "copy", "replay", "stale", "forged"]);
  assert.equal(manifest.lifecycle.closeAndDrain.rawCloseCount, "exactly-once");
  assert.equal(manifest.lifecycle.fallbackAllowed, false);
  assert.equal(manifest.ownershipIsolation.forbiddenReuse.some((entry) => (
    entry.includes("BrokerCredentialStateStoreV1")
  )), true);
  assert.equal(JSON.stringify(fixture).includes("twref2."), false);
  assert.equal(JSON.stringify(fixture).includes("twhostboot2."), false);

  assert.equal(manifest.platformResources.contractVersion, 1);
  assert.equal(
    manifest.platformResources.implementation,
    "native/relay-v2-host-credential-atomic-file-cell-platform-common",
  );
  assert.equal(
    manifest.platformResources.fileOperations,
    "injected-descriptor-relative-trait-only",
  );
  assert.equal(manifest.platformResources.realDarwinOrLinuxSyscallsImplemented, false);
  assert.equal(platformFixture.fixtureFormatVersion, 1);
  assert.equal(
    platformFixture.platformResourceContractVersion,
    manifest.platformResources.contractVersion,
  );
  assert.deepEqual(manifest.platformResources.durabilityQualification.qualifiedRecords, []);
  assert.equal(
    manifest.platformResources.durabilityQualification.productionProofConstructible,
    false,
  );
  assert.equal(
    manifest.platformResources.durabilityQualification.productionFailure,
    "CELL_DURABILITY_UNSUPPORTED",
  );
  assert.deepEqual(platformFixture.resourceNames, {
    credential: manifest.platformResources.relativeNames.credential,
    lock: manifest.platformResources.relativeNames.lock,
    claim: manifest.platformResources.relativeNames.claim,
  });
  for (const component of Object.values(platformFixture.resourceNames)) {
    assert.equal(component.includes("/"), false);
    assert.equal(component.toLowerCase().includes("broker"), false);
  }
  assert.deepEqual(
    manifest.platformResources.processRegistry.key,
    [
      "verified-directory-device",
      "verified-directory-inode",
      "RelayV2HostCredentialAtomicFileCellAdmissionV1",
    ],
  );
  assert.equal(manifest.platformResources.processRegistry.sharedWithBrokerRegistry, false);
  assert.equal(manifest.platformResources.processRegistry.childCleanupAllowed, false);
  assert.equal(manifest.platformResources.lock.primitive, "traditional-process-owned-F_SETLK");
  assert.equal(manifest.platformResources.lock.nonblocking, true);
  assert.equal(manifest.platformResources.lock.explicitUnlockAllowed, false);
  assert.deepEqual(manifest.platformResources.lock.busyErrnos, ["EACCES", "EAGAIN"]);
  assert.equal(manifest.platformResources.claim.existingOpenAllowed, false);
  assert.deepEqual(
    manifest.platformResources.claim.createOpen,
    ["O_RDWR", "O_CREAT", "O_EXCL", "O_NOFOLLOW", "O_CLOEXEC"],
  );
  assert.equal(
    manifest.platformResources.claim.requiredPostOpenDescriptorFlag,
    "FD_CLOEXEC",
  );
  assert.deepEqual(manifest.platformResources.claim.forbiddenOpenFlags, ["O_TRUNC"]);
  assert.equal(manifest.platformResources.claimJournal.formatVersion, 1);
  assert.equal(
    manifest.platformResources.claimJournal.byteLength,
    claimJournalFixture.byteLength,
  );
  assert.equal(
    manifest.platformResources.claimJournal.magicAscii,
    claimJournalFixture.fields[0].valueAscii,
  );
  assert.equal(claimJournalFixture.fixtureFormatVersion, 1);
  assert.equal(
    claimJournalFixture.journalFormatVersion,
    manifest.platformResources.claimJournal.formatVersion,
  );
  assert.equal(
    claimJournalFixture.golden.bytesHex.length,
    claimJournalFixture.byteLength * 2,
  );
  assert.equal(claimJournalFixture.golden.claimIdHex.length, 64);
  assert.equal(claimJournalFixture.golden.integrityDigestHex.length, 64);
  for (const entry of platformFixture.errorMapping) {
    assert.equal(manifest.rawErrorUnion.codes.includes(entry.code), true, entry.condition);
  }
  assert.equal(platformFixture.preservation.existingClaim, true);
  assert.equal(platformFixture.preservation.foreignClaim, true);
  assert.equal(platformFixture.preservation.corruptClaim, true);
  assert.equal(platformFixture.preservation.failureAfterClaimDurableCut, true);
  assert.equal(platformFixture.forbidden.includes("H4a-or-Relay-v1-fallback"), true);
  assert.equal(
    JSON.stringify(manifest.platformResources).includes("TWV2BCS1"),
    false,
  );
  assert.equal(
    JSON.stringify(manifest.platformResources).includes("RelayV2BrokerCredentialStateStoreV1"),
    false,
  );

  assert.deepEqual(manifest.requests.variants, {
    open: ["abiVersion", "operation"],
    read: ["abiVersion", "operation"],
    compare_and_swap: ["abiVersion", "operation", "revision", "bytes"],
    close: ["abiVersion", "operation"],
  });
  assert.deepEqual(manifest.results.current, {
    empty: ["state", "revision"],
    present: ["state", "revision", "bytes"],
  });
  assertSameMembers(
    fixture.errorCases.slice(0, -2).map((entry) => entry.expectedCode),
    manifest.rawErrorUnion.codes,
  );
  assert.equal(manifest.rawErrorUnion.rawThrow,
    "always-NATIVE_INTERFACE_INVALID-without-inspection-or-reflection");
  assertSameMembers(
    manifest.nodeWrapperErrorUnion.codes,
    [
      ...manifest.rawErrorUnion.codes,
      "REENTRANT",
      "ASYNC_OPERATION_UNSUPPORTED",
      "UNCERTAIN_FENCED",
    ],
  );
  assert.equal(manifest.nodeWrapperErrorUnion.rawThrowCodeReflectionAllowed, false);

  const names = [];
  for (const entry of fixture.openCases) {
    names.push(entry.name);
    const harness = rawHarness();
    if (entry.expected.outcome === "opened") {
      const cell = openWith(entry.rawResult, harness);
      assert.equal(Object.isFrozen(cell), true, entry.name);
      await cell.closeAndDrain();
    } else {
      assert.throws(
        () => openWith(entry.rawResult, harness),
        errorCode(entry.expected.errorCode),
        entry.name,
      );
    }
    assert.equal(harness.state.openRequests.length, 1, entry.name);
    assertRequest(harness.state.openRequests[0], "open", ["abiVersion", "operation"]);
    if (entry.expected.rawCloseCount !== undefined) {
      assert.equal(harness.state.closeRequests.length, entry.expected.rawCloseCount, entry.name);
    }
  }

  for (const entry of fixture.readCases) {
    names.push(entry.name);
    const harness = rawHarness({ readResult: entry.rawResult });
    const cell = openWith(fixture.openCases[0].rawResult, harness);
    if (entry.expected.errorCode !== undefined) {
      assert.throws(
        () => cell.runExclusive((transaction) => transaction.read()),
        errorCode(entry.expected.errorCode),
        entry.name,
      );
    } else {
      const read = cell.runExclusive((transaction) => transaction.read());
      assert.equal(read.bytes === null ? "empty" : "present", entry.expected.state, entry.name);
      if (entry.expected.bytesBase64 !== undefined) {
        assert.equal(Buffer.from(read.bytes).toString("base64"), entry.expected.bytesBase64, entry.name);
      }
    }
    assert.equal(harness.state.readRequests.length, 1, entry.name);
    assertRequest(harness.state.readRequests[0], "read", ["abiVersion", "operation"]);
    if (entry.expected.fenced) {
      assert.throws(
        () => cell.runExclusive((transaction) => transaction.read()),
        errorCode("UNCERTAIN_FENCED"),
        entry.name,
      );
    }
    await cell.closeAndDrain();
  }

  for (const entry of fixture.compareAndSwapCases) {
    names.push(entry.name);
    const harness = rawHarness({ compareResult: entry.rawResult });
    const cell = openWith(fixture.openCases[0].rawResult, harness);
    const read = cell.runExclusive((transaction) => transaction.read());
    const replacement = Uint8Array.from(Buffer.from(
      fixture.canonicalRequests.compareAndSwap.bytesBase64,
      "base64",
    ));
    if (entry.expected.errorCode !== undefined) {
      assert.throws(
        () => cell.runExclusive((transaction) => transaction.compareAndSwap(
          read.revision,
          replacement,
        )),
        errorCode(entry.expected.errorCode),
        entry.name,
      );
    } else {
      const result = cell.runExclusive((transaction) => transaction.compareAndSwap(
        read.revision,
        replacement,
      ));
      assert.equal(result.status, entry.expected.status, entry.name);
      if (result.status === "conflict") {
        assert.equal(result.current.bytes === null ? "empty" : "present", entry.expected.state);
        if (entry.expected.bytesBase64 !== undefined) {
          assert.equal(
            Buffer.from(result.current.bytes).toString("base64"),
            entry.expected.bytesBase64,
          );
        }
      }
    }
    assert.equal(harness.state.compareRequests.length, 1, entry.name);
    const request = harness.state.compareRequests[0];
    assertRequest(request, "compare_and_swap", ["abiVersion", "operation", "revision", "bytes"]);
    assert.equal(request.revision, harness.revision, entry.name);
    assert.deepEqual([...request.bytes], [...replacement], entry.name);
    assert.notEqual(request.bytes, replacement, entry.name);
    if (entry.expected.fenced) {
      assert.throws(
        () => cell.runExclusive((transaction) => transaction.read()),
        errorCode("UNCERTAIN_FENCED"),
        entry.name,
      );
    }
    await cell.closeAndDrain();
  }

  for (const entry of fixture.closeCases) {
    names.push(entry.name);
    const harness = rawHarness({ closeResult: entry.rawResult });
    const cell = openWith(fixture.openCases[0].rawResult, harness);
    const close = cell.closeAndDrain();
    assert.equal(cell.closeAndDrain(), close, entry.name);
    if (entry.expected.errorCode === undefined) await close;
    else await assert.rejects(close, errorCode(entry.expected.errorCode), entry.name);
    assert.equal(harness.state.closeRequests.length, 1, entry.name);
    assertRequest(harness.state.closeRequests[0], "close", ["abiVersion", "operation"]);
  }

  for (const entry of fixture.errorCases) {
    names.push(entry.name);
    const rawResult = exactClosed([], "read", "error", { error: entry.input });
    const harness = rawHarness({ readResult: rawResult });
    const cell = openWith(fixture.openCases[0].rawResult, harness);
    assert.throws(
      () => cell.runExclusive((transaction) => transaction.read()),
      errorCode(entry.expectedCode),
      entry.name,
    );
    if (entry.fenced) {
      assert.throws(
        () => cell.runExclusive((transaction) => transaction.read()),
        errorCode("UNCERTAIN_FENCED"),
        entry.name,
      );
    }
    await cell.closeAndDrain();
  }

  assert.equal(new Set(names).size, names.length, "every fixture case has a unique execution name");
  assert.equal(
    names.length,
    fixture.openCases.length
      + fixture.readCases.length
      + fixture.compareAndSwapCases.length
      + fixture.closeCases.length
      + fixture.errorCases.length,
  );
});
