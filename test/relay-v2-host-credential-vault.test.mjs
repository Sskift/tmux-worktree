import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const credentialAuthority = await import("../dist/relay/v2/hostCredentialAuthority.js");
const credentialVault = await import("../dist/relay/v2/hostCredentialVault.js");
const issuer = await import("../dist/relay/v2/issuer.js");

const NOW_SECONDS = 1_783_700_000;
const HOST_ID = "mac-admin";
const CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:primary";
const FOREIGN_CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:foreign";
const BOOTSTRAP_SECRET_REFERENCE = "bootstrap-secret-slot-primary";
const REFRESH_SECRET_REFERENCE = "refresh-secret-slot-primary";
const BOOTSTRAP_SECRET = "twhostboot2.bootstrap-secret-material";
const REFRESH_SECRET_1 = "twref2.host-refresh-token-1";
const REFRESH_SECRET_2 = "twref2.host-refresh-token-2";
const ENVELOPE_MAGIC_BYTES = 8;
const ENVELOPE_HEADER_BYTES = 44;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function optionalDigest(value) {
  return value === null ? null : digest(value);
}

class FakeAtomicByteCell {
  bytes = null;
  generation = 0;
  revisions = new WeakMap();
  operations = 0;
  compares = 0;
  throwOnNextCompare = false;
  uncertainNext = null;
  beforeOperation = null;

  constructor(bytes = null) {
    this.bytes = bytes === null ? null : Uint8Array.from(bytes);
  }

  runExclusive(operation) {
    this.operations += 1;
    const before = this.beforeOperation;
    this.beforeOperation = null;
    before?.();
    return operation({
      read: () => this.readCut(),
      compareAndSwap: (expected, replacement) => {
        this.compares += 1;
        const identity = this.revisions.get(expected);
        if (identity === undefined || identity !== this.generation) {
          return { status: "conflict", current: this.readCut() };
        }
        if (this.throwOnNextCompare) {
          this.throwOnNextCompare = false;
          throw new Error(`backend exposed ${REFRESH_SECRET_1}`);
        }
        const uncertainty = this.uncertainNext;
        this.uncertainNext = null;
        if (uncertainty === "before") return { status: "uncertain" };
        this.bytes = Uint8Array.from(replacement);
        this.generation += 1;
        if (uncertainty === "after") return { status: "uncertain" };
        return { status: "swapped" };
      },
    });
  }

  readCut() {
    const revision = Object.freeze(Object.create(null));
    this.revisions.set(revision, this.generation);
    return {
      bytes: this.bytes === null ? null : Uint8Array.from(this.bytes),
      revision,
    };
  }

  snapshotBytes() {
    return this.bytes === null ? null : Uint8Array.from(this.bytes);
  }
}

class FakeReadOnceBootstrapHandoff {
  candidates = new WeakMap();
  attempts = 0;
  consumes = 0;

  issue(secret) {
    const candidate = Object.freeze(Object.create(null));
    this.candidates.set(candidate, { secret, consumed: false, inFlight: false });
    return candidate;
  }

  runWithCandidate(candidate, operation) {
    const record = this.candidates.get(candidate);
    if (!record || record.consumed || record.inFlight) throw new Error("handoff unavailable");
    this.attempts += 1;
    record.inFlight = true;
    try {
      const result = operation(record.secret);
      record.consumed = true;
      this.consumes += 1;
      return result;
    } finally {
      record.inFlight = false;
    }
  }
}

function openVault(cell, handoff = new FakeReadOnceBootstrapHandoff()) {
  return {
    cell,
    handoff,
    vault: new credentialVault.RelayV2HostCredentialVault({
      hostId: HOST_ID,
      credentialReference: CREDENTIAL_REFERENCE,
      bootstrapSecretReference: BOOTSTRAP_SECRET_REFERENCE,
      refreshSecretReference: REFRESH_SECRET_REFERENCE,
      cell,
      bootstrapSecretHandoff: handoff,
    }),
  };
}

function openAuthority(vault) {
  return new credentialAuthority.RelayV2HostCredentialAuthority({
    storage: vault,
    secretResolver: vault,
  });
}

function tokenIssuer() {
  let keyring = issuer.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "host-vault-test-key",
    secretBase64url: Buffer.alloc(32, 0x72).toString("base64url"),
    nowSeconds: NOW_SECONDS,
  });
  let issued = 0;
  return () => {
    issued += 1;
    const prepared = issuer.prepareRelayV2AccessTokenIssuance(keyring, {
      role: "host",
      hostId: HOST_ID,
      principalId: "host-principal-uuid",
      grantId: "host-grant-uuid",
      nowSeconds: NOW_SECONDS + issued,
      jti: `host-access-jti-${issued}`,
    });
    keyring = prepared.nextKeyring;
    return {
      token: prepared.token,
      jti: prepared.claims.jti,
      expiresAtMs: prepared.claims.exp * 1_000,
    };
  };
}

function bootstrapPreparation(overrides = {}) {
  return {
    credentialReference: CREDENTIAL_REFERENCE,
    hostId: HOST_ID,
    attemptId: "host-bootstrap-attempt-1",
    oldSecretReference: BOOTSTRAP_SECRET_REFERENCE,
    ...overrides,
  };
}

function bootstrapResponse(access) {
  return {
    bootstrapAttemptId: "host-bootstrap-attempt-1",
    principalId: "host-principal-uuid",
    grantId: "host-grant-uuid",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: REFRESH_SECRET_1,
    refreshExpiresAtMs: 1_786_292_000_000,
  };
}

function refreshPreparation(attemptId) {
  return {
    credentialReference: CREDENTIAL_REFERENCE,
    attemptId,
    oldSecretReference: REFRESH_SECRET_REFERENCE,
  };
}

function refreshResponse(attemptId, access, refreshToken) {
  return {
    refreshAttemptId: attemptId,
    principalId: "host-principal-uuid",
    grantId: "host-grant-uuid",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken,
    refreshExpiresAtMs: 1_786_292_000_001,
  };
}

function assertVaultError(code) {
  return (error) => error?.code === code
    && !error.message.includes("twcap2.")
    && !error.message.includes("twref2.")
    && !error.message.includes("twhostboot2.");
}

function assertAuthorityError(code) {
  return (error) => error?.code === code
    && !error.message.includes("twcap2.")
    && !error.message.includes("twref2.")
    && !error.message.includes("twhostboot2.");
}

function rewriteEnvelope(bytes, mutate) {
  const source = Buffer.from(bytes);
  const payload = JSON.parse(source.subarray(ENVELOPE_HEADER_BYTES).toString("utf8"));
  mutate(payload);
  const replacementPayload = Buffer.from(JSON.stringify(payload), "utf8");
  const replacement = Buffer.alloc(ENVELOPE_HEADER_BYTES + replacementPayload.byteLength);
  source.subarray(0, ENVELOPE_MAGIC_BYTES).copy(replacement, 0);
  replacement.writeUInt32BE(replacementPayload.byteLength, ENVELOPE_MAGIC_BYTES);
  createHash("sha256").update(replacementPayload).digest().copy(
    replacement,
    ENVELOPE_MAGIC_BYTES + 4,
  );
  replacementPayload.copy(replacement, ENVELOPE_HEADER_BYTES);
  return Uint8Array.from(replacement);
}

test("provision, pending response-loss retry, bootstrap commit, and refresh rotation reopen from one atomic envelope", () => {
  const cell = new FakeAtomicByteCell();
  const handoff = new FakeReadOnceBootstrapHandoff();
  const opened = openVault(cell, handoff);
  assert.equal(cell.operations, 0, "construction is inert against the byte cell");
  assert.equal(handoff.consumes, 0, "construction does not consume a handoff");
  assert.deepEqual(Object.keys(opened.vault), []);

  const candidate = handoff.issue(BOOTSTRAP_SECRET);
  assert.deepEqual(Object.keys(candidate), []);
  opened.vault.provisionBootstrap(candidate);
  const authority = openAuthority(opened.vault);
  const prepared = authority.prepareBootstrap(bootstrapPreparation());
  assert.equal(prepared.fence.oldCredentialVersion, "0");
  assert.equal(digest(prepared.credential.bootstrapToken), digest(BOOTSTRAP_SECRET));

  const reopenedVault = openVault(cell, handoff).vault;
  const reopenedAuthority = openAuthority(reopenedVault);
  const responseLossRetry = reopenedAuthority.prepareBootstrap(bootstrapPreparation({
    attemptId: "must-reuse-durable-bootstrap-attempt",
  }));
  assert.equal(responseLossRetry.fence.attemptId, prepared.fence.attemptId);
  assert.equal(
    digest(responseLossRetry.credential.bootstrapToken),
    digest(prepared.credential.bootstrapToken),
  );

  const issueToken = tokenIssuer();
  const access1 = issueToken();
  const comparesBeforeBootstrapCommit = cell.compares;
  assert.deepEqual(reopenedAuthority.applyBootstrapResponse(
    responseLossRetry.fence,
    bootstrapResponse(access1),
  ), { status: "applied", credentialVersion: "1" });
  assert.equal(cell.compares - comparesBeforeBootstrapCommit, 1);
  assert.throws(
    () => reopenedVault.resolve(BOOTSTRAP_SECRET_REFERENCE),
    assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_SECRET_UNAVAILABLE"),
  );
  assert.equal(
    digest(reopenedVault.resolve(REFRESH_SECRET_REFERENCE)),
    digest(REFRESH_SECRET_1),
  );

  const afterBootstrapReopen = openVault(cell, handoff).vault;
  const afterBootstrapAuthority = openAuthority(afterBootstrapReopen);
  const carrier = afterBootstrapAuthority.read(CREDENTIAL_REFERENCE);
  assert.equal(carrier.version, "1");
  assert.equal(carrier.accessJti, access1.jti);
  assert.equal(JSON.stringify(carrier).includes("twcap2."), false);
  assert.equal(JSON.stringify(afterBootstrapReopen).includes("twref2."), false);

  const refresh = afterBootstrapAuthority.prepareRefresh(
    refreshPreparation("host-refresh-attempt-2"),
  );
  assert.equal(digest(refresh.credential.refreshToken), digest(REFRESH_SECRET_1));
  const access2 = issueToken();
  const comparesBeforeRefreshCommit = cell.compares;
  assert.deepEqual(afterBootstrapAuthority.applyRefreshResponse(
    refresh.fence,
    refreshResponse("host-refresh-attempt-2", access2, REFRESH_SECRET_2),
  ), { status: "applied", credentialVersion: "2" });
  assert.equal(cell.compares - comparesBeforeRefreshCommit, 1);

  const rotatedVault = openVault(cell, handoff).vault;
  const rotatedAuthority = openAuthority(rotatedVault);
  assert.equal(rotatedAuthority.read(CREDENTIAL_REFERENCE).version, "2");
  assert.equal(
    digest(rotatedVault.resolve(REFRESH_SECRET_REFERENCE)),
    digest(REFRESH_SECRET_2),
  );
  const nextRefresh = rotatedAuthority.prepareRefresh(
    refreshPreparation("host-refresh-attempt-3"),
  );
  assert.equal(nextRefresh.fence.oldCredentialVersion, "2");
  assert.equal(nextRefresh.fence.oldSecretReference, REFRESH_SECRET_REFERENCE);
  assert.equal(digest(nextRefresh.credential.refreshToken), digest(REFRESH_SECRET_2));
});

test("foreign, replayed, invalid, uncertain, and closed inputs fail closed without byte or secret disclosure", async (t) => {
  await t.test("foreign references are rejected before backend or secret access", () => {
    const cell = new FakeAtomicByteCell();
    const { vault } = openVault(cell);
    const operations = cell.operations;
    assert.throws(
      () => vault.runExclusive(FOREIGN_CREDENTIAL_REFERENCE, () => undefined),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_FOREIGN_REFERENCE"),
    );
    assert.throws(
      () => vault.resolve("foreign-secret-slot"),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_FOREIGN_REFERENCE"),
    );
    assert.equal(cell.operations, operations);
    assert.equal(cell.snapshotBytes(), null);
  });

  await t.test("bootstrap failures preserve candidates until an exact CAS commits", () => {
    const sourceCell = new FakeAtomicByteCell();
    const sourceHandoff = new FakeReadOnceBootstrapHandoff();
    openVault(sourceCell, sourceHandoff).vault.provisionBootstrap(
      sourceHandoff.issue(BOOTSTRAP_SECRET),
    );
    const occupiedBytes = sourceCell.snapshotBytes();
    const corruptBytes = Uint8Array.from(occupiedBytes);
    corruptBytes[0] ^= 0xff;
    const cases = [
      {
        label: "occupied",
        cell: new FakeAtomicByteCell(occupiedBytes),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED",
      },
      {
        label: "corrupt",
        cell: new FakeAtomicByteCell(corruptBytes),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID",
      },
      {
        label: "backend-read-failure",
        cell: new FakeAtomicByteCell(occupiedBytes),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE",
        configure: (cell) => {
          cell.readCut = () => {
            throw new Error(`backend exposed ${REFRESH_SECRET_1}`);
          };
        },
      },
      {
        label: "cas-throw",
        cell: new FakeAtomicByteCell(),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE",
        expectedAttempts: 1,
        expectedCompares: 1,
        configure: (cell) => {
          cell.throwOnNextCompare = true;
        },
      },
      {
        label: "uncertain-before",
        cell: new FakeAtomicByteCell(),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN",
        expectedAttempts: 1,
        expectedCompares: 1,
        configure: (cell) => {
          cell.uncertainNext = "before";
        },
      },
    ];
    let replay;
    for (const entry of cases) {
      const handoff = new FakeReadOnceBootstrapHandoff();
      const candidate = handoff.issue(BOOTSTRAP_SECRET);
      const before = entry.cell.snapshotBytes();
      entry.configure?.(entry.cell);
      assert.throws(
        () => openVault(entry.cell, handoff).vault.provisionBootstrap(candidate),
        assertVaultError(entry.errorCode),
        entry.label,
      );
      assert.equal(handoff.consumes, 0, entry.label);
      assert.equal(handoff.attempts, entry.expectedAttempts ?? 0, entry.label);
      assert.equal(entry.cell.compares, entry.expectedCompares ?? 0, entry.label);
      assert.equal(
        optionalDigest(entry.cell.snapshotBytes()),
        optionalDigest(before),
        entry.label,
      );

      const acceptingCell = new FakeAtomicByteCell();
      openVault(acceptingCell, handoff).vault.provisionBootstrap(candidate);
      assert.equal(handoff.consumes, 1, entry.label);
      assert.notEqual(acceptingCell.snapshotBytes(), null, entry.label);
      replay ??= { handoff, candidate };
    }

    const uncertainAfterCell = new FakeAtomicByteCell();
    const uncertainAfterHandoff = new FakeReadOnceBootstrapHandoff();
    const uncertainAfterCandidate = uncertainAfterHandoff.issue(BOOTSTRAP_SECRET);
    const uncertainAfterVault = openVault(
      uncertainAfterCell,
      uncertainAfterHandoff,
    ).vault;
    uncertainAfterCell.uncertainNext = "after";
    assert.throws(
      () => uncertainAfterVault.provisionBootstrap(uncertainAfterCandidate),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN"),
    );
    assert.equal(uncertainAfterHandoff.attempts, 1);
    assert.equal(uncertainAfterHandoff.consumes, 0);
    const uncertainAfterBytes = uncertainAfterCell.snapshotBytes();
    assert.notEqual(uncertainAfterBytes, null);
    assert.throws(
      () => uncertainAfterVault.provisionBootstrap(uncertainAfterCandidate),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED"),
    );
    assert.equal(uncertainAfterHandoff.attempts, 1);
    assert.equal(
      optionalDigest(uncertainAfterCell.snapshotBytes()),
      optionalDigest(uncertainAfterBytes),
    );

    const replayCell = new FakeAtomicByteCell();
    assert.throws(
      () => openVault(replayCell, replay.handoff).vault.provisionBootstrap(replay.candidate),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_HANDOFF_INVALID"),
    );
    assert.equal(replayCell.compares, 0);
    assert.equal(replayCell.snapshotBytes(), null);
  });

  await t.test("structurally and semantically invalid envelopes preserve original bytes", () => {
    const sourceCell = new FakeAtomicByteCell();
    const sourceHandoff = new FakeReadOnceBootstrapHandoff();
    const sourceVault = openVault(sourceCell, sourceHandoff).vault;
    sourceVault.provisionBootstrap(
      sourceHandoff.issue(BOOTSTRAP_SECRET),
    );
    openAuthority(sourceVault).prepareBootstrap(bootstrapPreparation());
    const valid = sourceCell.snapshotBytes();
    const cases = [
      ["corrupt", () => {
        const bytes = Uint8Array.from(valid);
        bytes[0] ^= 0xff;
        return bytes;
      }],
      ["unknown-version", () => rewriteEnvelope(valid, (payload) => {
        payload.schemaVersion = 2;
      })],
      ["foreign-binding", () => rewriteEnvelope(valid, (payload) => {
        payload.binding.hostId = "mac-other";
      })],
      ["invalid-pending-state", () => rewriteEnvelope(valid, (payload) => {
        payload.credentialState.pendingCredentialAttempt.oldCredentialVersion = "1";
      })],
    ];
    for (const [label, bytes] of cases) {
      const cell = new FakeAtomicByteCell(bytes());
      const { vault } = openVault(cell);
      const before = cell.snapshotBytes();
      assert.throws(
        () => vault.runExclusive(CREDENTIAL_REFERENCE, (transaction) => transaction.read()),
        assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID"),
        label,
      );
      assert.throws(
        () => vault.resolve(BOOTSTRAP_SECRET_REFERENCE),
        assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID"),
        `${label}-resolve`,
      );
      assert.equal(cell.compares, 0, label);
      assert.equal(digest(cell.snapshotBytes()), digest(before), label);
    }
  });

  await t.test("uncertain CAS is never reported as success and reopens from the committed cut", () => {
    const cell = new FakeAtomicByteCell();
    const handoff = new FakeReadOnceBootstrapHandoff();
    const { vault } = openVault(cell, handoff);
    vault.provisionBootstrap(handoff.issue(BOOTSTRAP_SECRET));
    const authority = openAuthority(vault);
    cell.uncertainNext = "after";
    assert.throws(
      () => authority.prepareBootstrap(bootstrapPreparation()),
      assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
    );
    const committedBytes = cell.snapshotBytes();
    const reopened = openAuthority(openVault(cell, handoff).vault);
    const recovered = reopened.prepareBootstrap(bootstrapPreparation({
      attemptId: "must-not-replace-uncertain-winner",
    }));
    assert.equal(recovered.fence.attemptId, "host-bootstrap-attempt-1");
    assert.equal(digest(recovered.credential.bootstrapToken), digest(BOOTSTRAP_SECRET));
    assert.equal(digest(cell.snapshotBytes()), digest(committedBytes));
  });

  await t.test("close fences new work and drains the already admitted transaction", async () => {
    const cell = new FakeAtomicByteCell();
    const handoff = new FakeReadOnceBootstrapHandoff();
    const { vault } = openVault(cell, handoff);
    vault.provisionBootstrap(handoff.issue(BOOTSTRAP_SECRET));
    const before = cell.snapshotBytes();
    let closePromise;
    let closeSettled = false;
    cell.beforeOperation = () => {
      closePromise = vault.closeAndDrain();
      void closePromise.then(() => {
        closeSettled = true;
      });
    };
    vault.runExclusive(CREDENTIAL_REFERENCE, (transaction) => {
      assert.equal(closeSettled, false);
      return transaction.read();
    });
    assert.ok(closePromise);
    await closePromise;
    assert.equal(closeSettled, true);
    const operations = cell.operations;
    assert.throws(
      () => vault.runExclusive(CREDENTIAL_REFERENCE, () => undefined),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_CLOSED"),
    );
    assert.throws(
      () => vault.resolve(BOOTSTRAP_SECRET_REFERENCE),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_CLOSED"),
    );
    assert.equal(cell.operations, operations);
    assert.equal(digest(cell.snapshotBytes()), digest(before));
  });
});
