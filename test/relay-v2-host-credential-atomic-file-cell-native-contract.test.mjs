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
const credentialMutationFixture = JSON.parse(
  readFileSync(new URL("credential-mutation-cases-v1.json", contractRoot), "utf8"),
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

function assertExactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

function assertCaseTable(entries, fields, expected, label) {
  for (const entry of entries) {
    assertExactKeys(entry, fields, `${label} ${entry.name}`);
  }
  assert.deepEqual(
    entries.map((entry) => fields.map((field) => entry[field])),
    expected,
    label,
  );
}

test("Host credential native ABI manifest and every machine case stay closed", async () => {
  assert.equal(manifest.contract, "tmux-worktree-relay-v2-host-credential-atomic-file-cell");
  assert.equal(manifest.contractVersion, 4);
  assert.equal(
    manifest.scope,
    "host-credential-native-abi-platform-admission-and-credential-mutation-contract-foundation",
  );
  assert.equal(manifest.productionWired, false);
  assert.equal(manifest.fixtureFormatVersion, fixture.fixtureFormatVersion);
  assert.deepEqual(manifest.files, [
    { role: "specification", path: "README.md" },
    { role: "native-interface", path: "native-interface-cases.json" },
    { role: "platform-resource-cases", path: "platform-resource-cases.json" },
    { role: "claim-journal-golden", path: "claim-journal-v1.json" },
    { role: "credential-mutation-contract", path: "credential-mutation-cases-v1.json" },
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
  assert.equal(
    Object.hasOwn(manifest.platformResources, "realDarwinOrLinuxSyscallsImplemented"),
    false,
  );
  assert.deepEqual(manifest.platformResources.targetFacts, {
    darwin: {
      implementationPath:
        "native/relay-v2-host-credential-atomic-file-cell-platform-darwin",
      traitImplemented: true,
      validatedTargets: ["aarch64-apple-darwin"],
      realEvidence: [
        "descriptor-relative-filesystem",
        "subprocess-F_SETLK-busy-and-close-release",
        "exec-FD_CLOEXEC",
      ],
      fullAdmissionValidated: false,
      durabilityQualified: false,
      productionWired: false,
    },
    linux: {
      implementationPath:
        "native/relay-v2-host-credential-atomic-file-cell-platform-linux",
      traitImplemented: true,
      validatedTargets: ["x86_64-unknown-linux-gnu"],
      realEvidence: [
        "descriptor-relative-filesystem",
        "subprocess-F_SETLK-busy-and-close-release",
        "exec-FD_CLOEXEC",
      ],
      fullAdmissionValidated: false,
      durabilityQualified: false,
      productionWired: false,
    },
  });
  assert.deepEqual(manifest.notImplemented, [
    "trusted-production-factory",
    "darwin-x86_64-validation-evidence",
    "credential-cell-read-cas-temp-or-rename",
    "orphan-cleanup-or-recovery",
    "production-durability-qualification",
    "continuity",
    "napi-binding",
    "loader-or-packaging",
    "vault-injection",
    "relay-host-production-composition",
    "capability-advertisement",
  ]);

  const mutation = manifest.credentialMutation;
  assertExactKeys(mutation, [
    "contractVersion",
    "fixtureFormatVersion",
    "fixture",
    "status",
    "implementation",
    "owner",
    "platformResourceContractVersion",
    "claimJournalFormatVersion",
    "claimJournalRole",
    "maximumCredentialBytes",
    "operationGate",
    "credentialRead",
    "revision",
    "compareAndSwap",
    "temporary",
    "publication",
    "preCommitCleanup",
    "uncertainty",
    "recovery",
    "implementedInPlatformCommon",
    "implementedInDarwinAdapter",
    "implementedInLinuxAdapter",
    "fullAdmissionValidated",
    "durabilityQualified",
    "productionWired",
    "productionCapabilityEffect",
  ], "credential mutation manifest fields");
  assert.deepEqual({
    contractVersion: mutation.contractVersion,
    fixtureFormatVersion: mutation.fixtureFormatVersion,
    fixture: mutation.fixture,
    status: mutation.status,
    implementation: mutation.implementation,
    owner: mutation.owner,
    platformResourceContractVersion: mutation.platformResourceContractVersion,
    claimJournalFormatVersion: mutation.claimJournalFormatVersion,
    claimJournalRole: mutation.claimJournalRole,
    maximumCredentialBytes: mutation.maximumCredentialBytes,
  }, {
    contractVersion: 1,
    fixtureFormatVersion: 1,
    fixture: "credential-mutation-cases-v1.json",
    status: "platform-common-only",
    implementation: "platform-common-only",
    owner: "exact-live-AdmissionOwner",
    platformResourceContractVersion: 1,
    claimJournalFormatVersion: 1,
    claimJournalRole: "admission-proof-only-not-mutation-journal",
    maximumCredentialBytes: 65_536,
  });
  assertExactKeys(mutation.operationGate, [
    "requiredAtEveryPhase",
    "phases",
    "failure",
    "forkChildCleanupAllowed",
  ], "credential mutation operation gate fields");
  assert.deepEqual(mutation.operationGate.requiredAtEveryPhase, [
    "exact-live-AdmissionOwner",
    "parent-pid",
    "exact-process-registry-entry-and-fence",
    "directory-descriptor-and-identity-safety",
    "lock-descriptor-path-identity-lock-and-safety",
    "claim-descriptor-path-journal-claimId-and-safety",
  ]);
  assert.deepEqual(mutation.operationGate.phases, [
    "read-before-credential-observation",
    "read-after-open-before-A-proof",
    "read-after-bytes-before-B-proof",
    "read-before-C-proof",
    "read-before-close-and-revision-issue",
    "cas-before-revision-consumption",
    "cas-before-first-current-check",
    "cas-before-temp-create",
    "cas-before-temp-write",
    "cas-before-temp-fsync",
    "cas-before-temp-proof",
    "cas-before-second-current-check",
    "cas-before-renameat",
    "cas-after-rename-before-published-proof",
    "cas-before-directory-fsync",
    "cas-before-final-descriptor-close",
    "precommit-cleanup",
  ]);
  assert.equal(mutation.operationGate.failure, "closed-before-next-phase");
  assert.equal(mutation.operationGate.forkChildCleanupAllowed, false);

  assertExactKeys(mutation.credentialRead, [
    "order",
    "absentOnlyWhen",
    "postPresentEnoent",
    "presentProof",
    "readBytes",
    "repairAllowed",
  ], "credential read fields");
  assert.deepEqual(mutation.credentialRead.order, [
    "fstatat-credential-AT_SYMLINK_NOFOLLOW",
    "openat-credential-O_RDONLY-O_NOFOLLOW-O_CLOEXEC",
    "A=fstat(credential-descriptor)",
    "read-exact-observed-size",
    "B=fstatat(directory,credential,AT_SYMLINK_NOFOLLOW)",
    "C=fstat(credential-descriptor)",
    "raw-close-credential-descriptor-once",
  ]);
  assert.equal(mutation.credentialRead.absentOnlyWhen, "initial-fstatat-returns-ENOENT");
  assert.equal(mutation.credentialRead.postPresentEnoent, "CELL_IDENTITY_UNCERTAIN");
  assert.deepEqual(mutation.credentialRead.presentProof, {
    type: "regular",
    owner: "current-effective-uid-and-effective-gid",
    modeOctal: "0600",
    nlink: 1,
    minimumSizeBytes: 0,
    maximumSizeBytes: 65_536,
    descriptorFlag: "FD_CLOEXEC",
    stableFields: ["device", "inode", "type", "uid", "gid", "mode", "nlink", "size"],
  });
  assert.equal(mutation.credentialRead.readBytes, "exact-size-no-short-read-or-trailing-byte");
  assert.equal(mutation.credentialRead.repairAllowed, false);

  assertExactKeys(mutation.revision, [
    "opaque",
    "oneShot",
    "source",
    "boundTo",
    "consume",
    "invalid",
    "staleComparison",
  ], "credential revision fields");
  assert.equal(mutation.revision.opaque, true);
  assert.equal(mutation.revision.oneShot, true);
  assert.deepEqual(mutation.revision.boundTo, [
    "exact-AdmissionOwner",
    "exact-owner-fence",
    "absent-or-present-state-tag",
    "SHA-256-of-exact-present-bytes-or-empty-bytes-when-absent",
    "present-device-and-inode-or-null-when-absent",
  ]);
  assert.equal(
    mutation.revision.consume,
    "before-first-current-check-and-before-temp-or-rename-mutation",
  );
  assert.equal(
    mutation.revision.invalid,
    "INVALID_REVISION-before-current-check-or-filesystem-mutation",
  );
  assertExactKeys(mutation.compareAndSwap, [
    "replacementMaximumBytes",
    "currentChecks",
    "firstMismatch",
    "secondMismatch",
    "sameBytesOptimizationAllowed",
  ], "credential compare-and-swap fields");
  assert.equal(mutation.compareAndSwap.replacementMaximumBytes, 65_536);
  assert.deepEqual(mutation.compareAndSwap.currentChecks, [
    "first-after-exact-revision-consumption-before-temp-create",
    "second-after-temp-fsync-proof-and-full-owner-revalidation-immediately-before-renameat",
  ]);

  assertExactKeys(mutation.temporary, [
    "directory",
    "name",
    "create",
    "trackedIdentity",
    "requiredProof",
    "prepareOrder",
    "cleanup",
    "foreignCollisionOrReplacementCleanupAllowed",
  ], "credential temporary fields");
  assert.deepEqual(mutation.temporary.name, {
    prefix: ".relay-v2-host-credential.cell.tmp-",
    entropyBytes: 32,
    suffixEncoding: "lowercase-hex",
    suffixCharacters: 64,
    freshCSPRNGPerAttempt: true,
  });
  assert.deepEqual(mutation.temporary.create, {
    flags: ["O_RDWR", "O_CREAT", "O_EXCL", "O_NOFOLLOW", "O_CLOEXEC"],
    modeOctal: "0600",
    collisionErrno: "EEXIST",
    maximumAttempts: 8,
    collisionExhaustion: "CELL_IO",
    otherFailure: "closed-without-alternate-name-source",
  });
  assert.deepEqual(mutation.temporary.trackedIdentity, ["device", "inode"]);
  assert.deepEqual(mutation.temporary.requiredProof, {
    type: "regular",
    owner: "current-effective-uid-and-effective-gid",
    modeOctal: "0600",
    nlink: 1,
    size: "exact-replacement-byte-length",
    descriptorFlag: "FD_CLOEXEC",
    bytes: "exact-replacement-bytes-and-SHA-256",
    stableSequence: [
      "A=fstat(temp-descriptor)",
      "B=fstatat(directory,temp-name,AT_SYMLINK_NOFOLLOW)",
      "C=fstat(temp-descriptor)",
    ],
  });
  assert.deepEqual(mutation.temporary.prepareOrder, [
    "exclusive-create",
    "prove-empty-owned-temp",
    "write-exact-replacement-from-offset-zero",
    "fsync-temp",
    "prove-stable-temp-identity-metadata-and-bytes",
  ]);
  assert.equal(
    mutation.temporary.cleanup,
    "unlinkat-only-after-exact-tracked-device-and-inode-proof",
  );
  assert.equal(mutation.temporary.foreignCollisionOrReplacementCleanupAllowed, false);

  assertExactKeys(mutation.publication, [
    "preCommitOrder",
    "commitPoint",
    "postCommitOrder",
    "publishedStableSequence",
    "success",
    "renameErrorDefiniteNoCommit",
    "renameErrorWithoutDefiniteNoCommit",
  ], "credential publication fields");
  assert.equal(
    mutation.publication.commitPoint,
    "same-directory-renameat-temp-to-credential",
  );
  assert.equal(
    mutation.publication.success,
    "swapped-only-after-all-post-commit-proof-fsync-and-close",
  );
  assert.deepEqual(mutation.publication.postCommitOrder, [
    "prove-temp-name-absent",
    "prove-published-name-A-B-C-equals-tracked-temp-device-and-inode",
    "prove-published-bytes-equal-exact-replacement-and-digest",
    "fsync-directory",
    "raw-close-published-descriptor-once",
  ]);
  assert.equal(
    mutation.publication.renameErrorWithoutDefiniteNoCommit,
    "uncertain-and-permanent-fence",
  );
  assert.deepEqual(mutation.preCommitCleanup.order, [
    "revalidate-full-owner-gate",
    "prove-temp-name-equals-tracked-device-and-inode",
    "unlinkat-exact-owned-temp",
    "prove-temp-name-ENOENT",
    "fsync-directory",
    "raw-close-temp-descriptor-once",
  ]);
  assert.equal(
    mutation.preCommitCleanup.identityUncertain,
    "CELL_IDENTITY_UNCERTAIN-and-permanent-fence-without-unlink",
  );
  assert.equal(
    mutation.preCommitCleanup.cleanupOrDurabilityUncertain,
    "CELL_RECOVERY_REQUIRED-and-permanent-fence",
  );
  assert.deepEqual(mutation.uncertainty, {
    renameSucceededThenProofFsyncOrCloseFailure: "uncertain-and-permanent-fence",
    renameErroredAndOldValueCannotBeProvedUnchanged: "uncertain-and-permanent-fence",
    currentOrRevisionReturned: false,
    automaticReadRetryOrFallbackAllowed: false,
  });
  assert.deepEqual(mutation.recovery, {
    crashRecoveryImplemented: false,
    enumerationCleanupAllowed: false,
    existingClaim: "CELL_RECOVERY_REQUIRED-and-preserve",
    knownLeftoverTemp: "CELL_RECOVERY_REQUIRED-and-preserve",
    claimJournalMutationStateAllowed: false,
    claimJournalTempNameOrRevisionAllowed: false,
  });
  assert.deepEqual({
    implementedInPlatformCommon: mutation.implementedInPlatformCommon,
    implementedInDarwinAdapter: mutation.implementedInDarwinAdapter,
    implementedInLinuxAdapter: mutation.implementedInLinuxAdapter,
    fullAdmissionValidated: mutation.fullAdmissionValidated,
    durabilityQualified: mutation.durabilityQualified,
    productionWired: mutation.productionWired,
    productionCapabilityEffect: mutation.productionCapabilityEffect,
  }, {
    implementedInPlatformCommon: true,
    implementedInDarwinAdapter: false,
    implementedInLinuxAdapter: false,
    fullAdmissionValidated: false,
    durabilityQualified: false,
    productionWired: false,
    productionCapabilityEffect: "none",
  });

  assertExactKeys(credentialMutationFixture, [
    "fixtureFormatVersion",
    "credentialMutationContractVersion",
    "platformResourceContractVersion",
    "claimJournalFormatVersion",
    "implementationStatus",
    "constants",
    "phaseRevalidation",
    "readContract",
    "temporaryContract",
    "publicationContract",
    "readCases",
    "compareAndSwapCases",
    "recoveryCases",
    "qualification",
  ], "credential mutation fixture fields");
  assert.deepEqual({
    fixtureFormatVersion: credentialMutationFixture.fixtureFormatVersion,
    credentialMutationContractVersion:
      credentialMutationFixture.credentialMutationContractVersion,
    platformResourceContractVersion:
      credentialMutationFixture.platformResourceContractVersion,
    claimJournalFormatVersion: credentialMutationFixture.claimJournalFormatVersion,
    implementationStatus: credentialMutationFixture.implementationStatus,
  }, {
    fixtureFormatVersion: 1,
    credentialMutationContractVersion: 1,
    platformResourceContractVersion: 1,
    claimJournalFormatVersion: 1,
    implementationStatus: "platform-common-only",
  });
  assert.deepEqual(credentialMutationFixture.constants, {
    credentialMaximumBytes: 65_536,
    temporaryPrefix: ".relay-v2-host-credential.cell.tmp-",
    temporaryEntropyBytes: 32,
    temporarySuffixEncoding: "lowercase-hex",
    temporarySuffixCharacters: 64,
    temporaryCreateAttempts: 8,
    currentChecksPerCompareAndSwap: 2,
    commitPoint: "same-directory-renameat-temp-to-credential",
  });
  assertExactKeys(credentialMutationFixture.phaseRevalidation, [
    "owner",
    "requiredAtEveryPhase",
    "phases",
    "forkChildCleanupAllowed",
  ], "credential mutation phase revalidation fields");
  assert.deepEqual(
    credentialMutationFixture.phaseRevalidation.requiredAtEveryPhase,
    mutation.operationGate.requiredAtEveryPhase.slice(1),
  );
  assert.equal(credentialMutationFixture.phaseRevalidation.owner, mutation.owner);
  assert.deepEqual(
    credentialMutationFixture.phaseRevalidation.phases,
    mutation.operationGate.phases,
  );
  assert.equal(credentialMutationFixture.phaseRevalidation.forkChildCleanupAllowed, false);
  assertExactKeys(credentialMutationFixture.readContract, [
    "order",
    "absentOnlyWhen",
    "presentRequired",
    "revisionBinding",
  ], "credential mutation read contract fields");
  assert.deepEqual(credentialMutationFixture.readContract.order, mutation.credentialRead.order);
  assert.equal(
    credentialMutationFixture.readContract.absentOnlyWhen,
    mutation.credentialRead.absentOnlyWhen,
  );
  assert.deepEqual(
    credentialMutationFixture.readContract.presentRequired,
    mutation.credentialRead.presentProof,
  );
  assert.deepEqual(
    credentialMutationFixture.readContract.revisionBinding,
    mutation.revision.boundTo,
  );
  assertExactKeys(credentialMutationFixture.temporaryContract, [
    "createFlags",
    "createModeOctal",
    "retryOnly",
    "collisionExhaustion",
    "trackedIdentity",
    "prepareOrder",
    "cleanupOrder",
    "foreignOrUntrackedUnlinkAllowed",
  ], "credential mutation temporary contract fields");
  assert.deepEqual(
    credentialMutationFixture.temporaryContract.createFlags,
    mutation.temporary.create.flags,
  );
  assert.equal(
    credentialMutationFixture.temporaryContract.createModeOctal,
    mutation.temporary.create.modeOctal,
  );
  assert.deepEqual(
    credentialMutationFixture.temporaryContract.trackedIdentity,
    mutation.temporary.trackedIdentity,
  );
  assert.equal(
    credentialMutationFixture.temporaryContract.retryOnly,
    "EEXIST-with-fresh-32-byte-CSPRNG",
  );
  assert.equal(
    credentialMutationFixture.temporaryContract.collisionExhaustion,
    "CELL_IO",
  );
  assert.deepEqual(credentialMutationFixture.temporaryContract.prepareOrder, [
    "exclusive-create",
    "prove-empty-owned-temp",
    "write-exact-replacement-from-offset-zero",
    "fsync-temp",
    "A=fstat(temp-descriptor)",
    "B=fstatat(directory,temp-name,AT_SYMLINK_NOFOLLOW)",
    "C=fstat(temp-descriptor)",
    "prove-exact-replacement-size-bytes-and-SHA-256",
  ]);
  assert.equal(
    credentialMutationFixture.temporaryContract.foreignOrUntrackedUnlinkAllowed,
    false,
  );
  assert.deepEqual(
    credentialMutationFixture.temporaryContract.cleanupOrder,
    mutation.preCommitCleanup.order,
  );
  assertExactKeys(credentialMutationFixture.publicationContract, [
    "revisionConsumeOrder",
    "currentChecks",
    "preCommitOrder",
    "commitPoint",
    "postCommitOrder",
    "success",
    "postCommitFailure",
    "renameErrorDefiniteNoCommit",
    "renameErrorWithoutDefiniteNoCommit",
  ], "credential mutation publication contract fields");
  assert.equal(
    credentialMutationFixture.publicationContract.revisionConsumeOrder,
    mutation.revision.consume,
  );
  assert.deepEqual(
    credentialMutationFixture.publicationContract.currentChecks,
    mutation.compareAndSwap.currentChecks,
  );
  assert.deepEqual(
    credentialMutationFixture.publicationContract.preCommitOrder,
    mutation.publication.preCommitOrder,
  );
  assert.equal(
    credentialMutationFixture.publicationContract.commitPoint,
    mutation.publication.commitPoint,
  );
  assert.equal(
    credentialMutationFixture.publicationContract.postCommitFailure,
    "uncertain-and-permanent-fence",
  );
  assert.deepEqual(credentialMutationFixture.publicationContract.postCommitOrder, [
    "prove-temp-name-absent",
    "A=fstat(published-temp-descriptor)",
    "B=fstatat(directory,credential,AT_SYMLINK_NOFOLLOW)",
    "C=fstat(published-temp-descriptor)",
    "prove-published-device-and-inode-equal-tracked-temp",
    "prove-published-bytes-equal-exact-replacement-and-SHA-256",
    "fsync-directory",
    "raw-close-published-descriptor-once",
  ]);
  assert.equal(
    credentialMutationFixture.publicationContract.success,
    mutation.publication.success,
  );
  assert.equal(
    credentialMutationFixture.publicationContract.renameErrorDefiniteNoCommit,
    mutation.publication.renameErrorDefiniteNoCommit,
  );
  assert.equal(
    credentialMutationFixture.publicationContract.renameErrorWithoutDefiniteNoCommit,
    "uncertain-and-permanent-fence",
  );

  assertCaseTable(
    credentialMutationFixture.readCases,
    ["name", "observation", "expectedState", "errorCode", "revisionIssued", "fenced"],
    [
      ["initial-enoent-is-absent", "initial-fstatat-ENOENT", "absent", null, true, false],
      ["safe-present-is-read-and-bound", "safe-present-A-B-C-and-exact-bytes", "present", null, true, false],
      ["non-enoent-lookup-error-is-not-absent", "initial-fstatat-non-ENOENT", null, "CELL_IO", false, false],
      ["post-present-enoent-is-an-identity-race", "open-or-B-after-present-returns-ENOENT", null, "CELL_IDENTITY_UNCERTAIN", false, true],
      ["present-type-link-or-stable-identity-failure-fences", "nonregular-nlink-not-one-or-A-B-C-identity-mismatch", null, "CELL_IDENTITY_UNCERTAIN", false, true],
      ["present-owner-or-mode-invalid-fences", "uid-gid-not-current-or-mode-not-exact-0600", null, "CELL_PERMISSION_INVALID", false, true],
      ["present-size-over-limit-fences", "observed-size-greater-than-65536", null, "CELL_CORRUPT", false, true],
      ["read-descriptor-close-failure-does-not-issue-revision", "raw-close-credential-descriptor-fails", null, "CELL_IO", false, true],
    ],
    "credential mutation read cases",
  );
  assertCaseTable(
    credentialMutationFixture.compareAndSwapCases,
    [
      "name",
      "cut",
      "expectedOutcome",
      "errorCode",
      "fenced",
      "freshRevisionIssued",
      "tempDisposition",
      "credentialDisposition",
    ],
    [
      ["invalid-revision-stops-before-current-check", "revision-consumption", "error", "INVALID_REVISION", false, false, "not-created", "unchanged"],
      ["first-current-mismatch-conflicts-before-temp", "first-current-check", "conflict", null, false, true, "not-created", "current-observed"],
      ["eight-temp-name-collisions-exhaust", "temp-create-attempt-8-EEXIST", "error", "CELL_IO", false, false, "foreign-collisions-preserved", "unchanged"],
      ["second-current-mismatch-cleans-owned-temp-then-conflicts", "second-current-check", "conflict", null, false, true, "exact-owned-temp-removed-and-directory-fsynced", "current-observed"],
      ["precommit-cleanup-identity-mismatch-fences", "owned-temp-cleanup-identity-proof", "error", "CELL_IDENTITY_UNCERTAIN", true, false, "preserved-no-unlink", "unchanged"],
      ["precommit-cleanup-durability-uncertain-fences", "owned-temp-unlink-directory-fsync-or-close", "error", "CELL_RECOVERY_REQUIRED", true, false, "cleanup-or-durability-uncertain", "unchanged"],
      ["rename-error-with-old-and-temp-proof-is-definite", "renameat-error-definite-no-commit-proof", "error", "CELL_IO", false, false, "exact-owned-temp-removed-and-directory-fsynced", "old-value-proved-unchanged"],
      ["rename-error-without-old-value-proof-is-uncertain", "renameat-error-no-definite-no-commit-proof", "uncertain", null, true, false, "preserve-unknown-namespace", "unknown"],
      ["post-rename-published-proof-failure-is-uncertain", "published-identity-or-bytes-proof", "uncertain", null, true, false, "renamed-to-credential", "commit-uncertain"],
      ["post-rename-directory-fsync-failure-is-uncertain", "directory-fsync-after-rename", "uncertain", null, true, false, "renamed-to-credential", "commit-uncertain"],
      ["post-rename-close-failure-is-uncertain", "published-descriptor-close-after-directory-fsync", "uncertain", null, true, false, "renamed-to-credential", "commit-uncertain"],
      ["complete-publication-swaps", "after-published-proof-directory-fsync-and-close", "swapped", null, false, false, "renamed-to-credential", "new-value-proved-and-durable"],
    ],
    "credential mutation compare-and-swap cases",
  );
  assertCaseTable(
    credentialMutationFixture.recoveryCases,
    ["name", "observation", "expectedErrorCode", "preserveClaim", "preserveTemps", "enumerateOrCleanup"],
    [
      ["existing-admission-claim-remains-recovery-required", "existing-claim-with-or-without-leftover-temp", "CELL_RECOVERY_REQUIRED", true, true, false],
      ["known-leftover-temp-remains-recovery-required", "tracked-temp-cannot-be-proved-cleaned-before-close", "CELL_RECOVERY_REQUIRED", true, true, false],
    ],
    "credential mutation recovery cases",
  );
  assert.deepEqual(credentialMutationFixture.qualification, {
    qualifiedRecords: [],
    productionProofConstructible: false,
    fullAdmissionValidated: false,
    durabilityQualified: false,
    productionWired: false,
    productionCapabilityEffect: "none",
  });
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
