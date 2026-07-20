import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const credentialAuthority = await import("../dist/relay/v2/hostCredentialAuthority.js");
const credentialVault = await import("../dist/relay/v2/hostCredentialVault.js");
const bootstrapHandoff = await import("../dist/relay/v2/hostBootstrapSecretHandoff.js");
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

function createBootstrapHandoff() {
  return bootstrapHandoff.createRelayV2HostBootstrapSecretHandoffAuthority();
}

function openVault(cell, handoffAuthority = createBootstrapHandoff()) {
  return {
    cell,
    handoffAuthority,
    vault: new credentialVault.RelayV2HostCredentialVault({
      hostId: HOST_ID,
      credentialReference: CREDENTIAL_REFERENCE,
      bootstrapSecretReference: BOOTSTRAP_SECRET_REFERENCE,
      refreshSecretReference: REFRESH_SECRET_REFERENCE,
      cell,
      bootstrapSecretHandoff: handoffAuthority.handoff,
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

function assertHandoffError(code) {
  return (error) => error?.code === code
    && doesNotExposeBootstrapSecret(error)
    && doesNotExposeBootstrapSecret(error.message)
    && doesNotExposeBootstrapSecret(error.cause);
}

function doesNotExposeBootstrapSecret(value) {
  try {
    return !String(value).includes(BOOTSTRAP_SECRET);
  } catch (error) {
    return error === value || (
      doesNotExposeBootstrapSecret(error?.message)
      && doesNotExposeBootstrapSecret(error?.cause)
    );
  }
}

function assertStringDoesNotExposeBootstrapSecret(value) {
  let rendered;
  try {
    rendered = String(value);
  } catch (error) {
    assert.equal(doesNotExposeBootstrapSecret(error), true);
    assert.equal(doesNotExposeBootstrapSecret(error?.message), true);
    assert.equal(doesNotExposeBootstrapSecret(error?.cause), true);
    return;
  }
  assert.equal(rendered.includes(BOOTSTRAP_SECRET), false);
}

function assertInspectableSurfaceDoesNotExposeBootstrapSecret(value) {
  for (const inspect of [
    () => Object.keys(value),
    () => Reflect.ownKeys(value).map((key) => String(key)),
    () => JSON.stringify(value),
  ]) {
    let observed;
    try {
      observed = inspect();
    } catch (error) {
      assert.equal(doesNotExposeBootstrapSecret(error), true);
      assert.equal(doesNotExposeBootstrapSecret(error?.message), true);
      assert.equal(doesNotExposeBootstrapSecret(error?.cause), true);
      continue;
    }
    assert.equal(doesNotExposeBootstrapSecret(observed), true);
  }
  assertStringDoesNotExposeBootstrapSecret(value);
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

test("provision, pending response-loss retry, bootstrap commit, and refresh rotation reopen from one atomic envelope", async () => {
  const cell = new FakeAtomicByteCell();
  const handoffAuthority = createBootstrapHandoff();
  const opened = openVault(cell, handoffAuthority);
  assert.equal(cell.operations, 0, "construction is inert against the byte cell");
  assertInspectableSurfaceDoesNotExposeBootstrapSecret(opened.vault);
  assertInspectableSurfaceDoesNotExposeBootstrapSecret(handoffAuthority);

  const candidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
  assertInspectableSurfaceDoesNotExposeBootstrapSecret(candidate);
  assert.equal(cell.operations, 0, "privileged intake is inert against the byte cell");
  opened.vault.provisionBootstrap(candidate);
  const authority = openAuthority(opened.vault);
  const prepared = authority.prepareBootstrap(bootstrapPreparation());
  assert.equal(prepared.fence.oldCredentialVersion, "0");
  assert.equal(digest(prepared.credential.bootstrapToken), digest(BOOTSTRAP_SECRET));

  const reopenedVault = openVault(cell, handoffAuthority).vault;
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

  const afterBootstrapReopen = openVault(cell, handoffAuthority).vault;
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

  const rotatedVault = openVault(cell, handoffAuthority).vault;
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
  await handoffAuthority.closeAndDrain();
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

  await t.test("opaque candidates are exact, synchronous, read-once, and retryable only after callback throw", async () => {
    const handoffAuthority = createBootstrapHandoff();
    for (const handle of [
      handoffAuthority,
      handoffAuthority.privilegedIntake,
      handoffAuthority.handoff,
    ]) {
      assertInspectableSurfaceDoesNotExposeBootstrapSecret(handle);
    }
    const bootstrapSecretPrefix = "twhostboot2.";
    const maxBootstrapSecret = `${bootstrapSecretPrefix}${"x".repeat(
      8_192 - Buffer.byteLength(bootstrapSecretPrefix, "utf8"),
    )}`;
    assert.equal(Buffer.byteLength(maxBootstrapSecret, "utf8"), 8_192);
    const maxCandidate = handoffAuthority.privilegedIntake.accept(maxBootstrapSecret);
    for (const value of [
      "twref2.not-a-bootstrap-secret",
      "twhostboot2.with whitespace",
      "twhostboot2.non-ascii-é",
      "twhostboot2.control-\n",
      `${maxBootstrapSecret}x`,
    ]) {
      assert.throws(
        () => handoffAuthority.privilegedIntake.accept(value),
        assertHandoffError("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_INTAKE_INVALID"),
      );
    }

    const candidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
    assertInspectableSurfaceDoesNotExposeBootstrapSecret(candidate);

    const copy = Object.freeze({ ...candidate });
    const proxy = new Proxy(candidate, {});
    for (const foreign of [Object.freeze(Object.create(null)), copy, proxy]) {
      let callbackCalled = false;
      assert.throws(
        () => handoffAuthority.handoff.runWithCandidate(foreign, () => {
          callbackCalled = true;
        }),
        assertHandoffError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE",
        ),
      );
      assert.equal(callbackCalled, false);
    }

    let callbackCalls = 0;
    let nestedCallbackCalled = false;
    const resultIdentity = Object.freeze(Object.create(null));
    assert.equal(handoffAuthority.handoff.runWithCandidate(candidate, (secret) => {
      callbackCalls += 1;
      assert.equal(digest(secret), digest(BOOTSTRAP_SECRET));
      assert.throws(
        () => handoffAuthority.handoff.runWithCandidate(candidate, () => {
          nestedCallbackCalled = true;
        }),
        assertHandoffError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE",
        ),
      );
      return resultIdentity;
    }), resultIdentity);
    assert.equal(callbackCalls, 1);
    assert.equal(nestedCallbackCalled, false);
    let replayCallbackCalled = false;
    assert.throws(
      () => handoffAuthority.handoff.runWithCandidate(candidate, () => {
        replayCallbackCalled = true;
      }),
      assertHandoffError("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE"),
    );
    assert.equal(replayCallbackCalled, false);

    const retryCandidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
    const originalCallbackError = new Error("vault callback sentinel");
    assert.throws(
      () => handoffAuthority.handoff.runWithCandidate(retryCandidate, () => {
        throw originalCallbackError;
      }),
      (error) => error === originalCallbackError,
    );
    assert.equal(handoffAuthority.handoff.runWithCandidate(
      retryCandidate,
      (secret) => digest(secret),
    ), digest(BOOTSTRAP_SECRET));
    assertInspectableSurfaceDoesNotExposeBootstrapSecret(maxCandidate);
    await handoffAuthority.closeAndDrain();
  });

  await t.test("Promise and hostile thenable callback results fail closed without assimilation", async () => {
    const handoffAuthority = createBootstrapHandoff();
    const promiseCandidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
    const secretBearingRejection = Promise.reject(new Error(
      `native Promise rejection exposed ${BOOTSTRAP_SECRET}`,
      { cause: BOOTSTRAP_SECRET },
    ));
    assert.throws(
      () => handoffAuthority.handoff.runWithCandidate(
        promiseCandidate,
        () => secretBearingRejection,
      ),
      assertHandoffError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED",
      ),
    );
    const acceptingCell = new FakeAtomicByteCell();
    openVault(acceptingCell, handoffAuthority).vault.provisionBootstrap(promiseCandidate);
    assert.notEqual(acceptingCell.snapshotBytes(), null);

    const brandedCandidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
    const promiseWithNonCallableOwnThen = Promise.resolve("native-promise");
    Object.defineProperty(promiseWithNonCallableOwnThen, "then", {
      value: null,
    });
    assert.throws(
      () => handoffAuthority.handoff.runWithCandidate(
        brandedCandidate,
        () => promiseWithNonCallableOwnThen,
      ),
      assertHandoffError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED",
      ),
    );
    assert.equal(handoffAuthority.handoff.runWithCandidate(
      brandedCandidate,
      (secret) => digest(secret),
    ), digest(BOOTSTRAP_SECRET));

    const thenableCandidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
    let thenGetterReads = 0;
    let thenCalls = 0;
    const hostileThenable = Object.create(null);
    Object.defineProperty(hostileThenable, "then", {
      get() {
        thenGetterReads += 1;
        return () => {
          thenCalls += 1;
        };
      },
    });
    assert.throws(
      () => handoffAuthority.handoff.runWithCandidate(
        thenableCandidate,
        () => hostileThenable,
      ),
      assertHandoffError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED",
      ),
    );
    assert.equal(thenGetterReads, 1);
    assert.equal(thenCalls, 0);
    assert.equal(handoffAuthority.handoff.runWithCandidate(
      thenableCandidate,
      (secret) => digest(secret),
    ), digest(BOOTSTRAP_SECRET));

    const throwingGetterCandidate = handoffAuthority.privilegedIntake.accept(
      BOOTSTRAP_SECRET,
    );
    let throwingGetterReads = 0;
    const throwingThenable = Object.create(null);
    Object.defineProperty(throwingThenable, "then", {
      get() {
        throwingGetterReads += 1;
        throw new Error(`hostile then getter exposed ${BOOTSTRAP_SECRET}`, {
          cause: BOOTSTRAP_SECRET,
        });
      },
    });
    assert.throws(
      () => handoffAuthority.handoff.runWithCandidate(
        throwingGetterCandidate,
        () => throwingThenable,
      ),
      assertHandoffError(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED",
      ),
    );
    assert.equal(throwingGetterReads, 1);
    assert.equal(handoffAuthority.handoff.runWithCandidate(
      throwingGetterCandidate,
      (secret) => digest(secret),
    ), digest(BOOTSTRAP_SECRET));
    await handoffAuthority.closeAndDrain();
  });

  await t.test("handoff close synchronously fences intake and consume, drains its callback, and cannot revive", async () => {
    const handoffAuthority = createBootstrapHandoff();
    const abandonedCandidate = handoffAuthority.privilegedIntake.accept(
      `${BOOTSTRAP_SECRET}-abandoned`,
    );
    const admittedCandidate = handoffAuthority.privilegedIntake.accept(
      `${BOOTSTRAP_SECRET}-admitted`,
    );
    let closePromise;
    let callbackReturned = false;
    let closeObservedAfterReturn = false;
    let fencedCallbackCalled = false;
    const result = handoffAuthority.handoff.runWithCandidate(
      admittedCandidate,
      (secret) => {
        assert.equal(digest(secret), digest(`${BOOTSTRAP_SECRET}-admitted`));
        closePromise = handoffAuthority.closeAndDrain();
        assert.equal(handoffAuthority.closeAndDrain(), closePromise);
        void closePromise.then(() => {
          closeObservedAfterReturn = callbackReturned;
        });
        assert.throws(
          () => handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET),
          assertHandoffError("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED"),
        );
        for (const fencedCandidate of [abandonedCandidate, admittedCandidate]) {
          assert.throws(
            () => handoffAuthority.handoff.runWithCandidate(fencedCandidate, () => {
              fencedCallbackCalled = true;
            }),
            assertHandoffError("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED"),
          );
        }
        return "admitted-result";
      },
    );
    callbackReturned = true;
    assert.equal(result, "admitted-result");
    assert.equal(fencedCallbackCalled, false);
    assert.ok(closePromise);
    await closePromise;
    assert.equal(closeObservedAfterReturn, true);
    assert.equal(handoffAuthority.closeAndDrain(), closePromise);

    await Promise.resolve();
    for (const staleCandidate of [abandonedCandidate, admittedCandidate]) {
      assert.throws(
        () => handoffAuthority.handoff.runWithCandidate(staleCandidate, () => {
          fencedCallbackCalled = true;
        }),
        assertHandoffError("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED"),
      );
    }
    assert.equal(fencedCallbackCalled, false);

    const throwingHandoffAuthority = createBootstrapHandoff();
    const throwingCandidate = throwingHandoffAuthority.privilegedIntake.accept(
      BOOTSTRAP_SECRET,
    );
    const originalCallbackError = new Error("reentrant close callback sentinel");
    let throwingClosePromise;
    let callbackThrowEscaped = false;
    let closeObservedAfterFinally = false;
    assert.throws(
      () => throwingHandoffAuthority.handoff.runWithCandidate(
        throwingCandidate,
        () => {
          throwingClosePromise = throwingHandoffAuthority.closeAndDrain();
          assert.equal(
            throwingHandoffAuthority.closeAndDrain(),
            throwingClosePromise,
          );
          void throwingClosePromise.then(() => {
            closeObservedAfterFinally = callbackThrowEscaped;
          });
          throw originalCallbackError;
        },
      ),
      (error) => error === originalCallbackError
        && doesNotExposeBootstrapSecret(error)
        && doesNotExposeBootstrapSecret(error.message)
        && doesNotExposeBootstrapSecret(error.cause),
    );
    callbackThrowEscaped = true;
    assert.ok(throwingClosePromise);
    await throwingClosePromise;
    assert.equal(closeObservedAfterFinally, true);
    assert.equal(
      throwingHandoffAuthority.closeAndDrain(),
      throwingClosePromise,
    );
    let throwingReplayCalled = false;
    assert.throws(
      () => throwingHandoffAuthority.handoff.runWithCandidate(
        throwingCandidate,
        () => {
          throwingReplayCalled = true;
        },
      ),
      assertHandoffError("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED"),
    );
    assert.equal(throwingReplayCalled, false);
  });

  await t.test("bootstrap failures preserve candidates until an exact CAS commits", async () => {
    const sourceCell = new FakeAtomicByteCell();
    const sourceHandoff = createBootstrapHandoff();
    openVault(sourceCell, sourceHandoff).vault.provisionBootstrap(
      sourceHandoff.privilegedIntake.accept(BOOTSTRAP_SECRET),
    );
    const occupiedBytes = sourceCell.snapshotBytes();
    const corruptBytes = Uint8Array.from(occupiedBytes);
    corruptBytes[0] ^= 0xff;
    const cases = [
      {
        label: "occupied",
        cell: new FakeAtomicByteCell(occupiedBytes),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED",
        preflight: true,
      },
      {
        label: "corrupt",
        cell: new FakeAtomicByteCell(corruptBytes),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_STATE_INVALID",
        preflight: true,
      },
      {
        label: "backend-read-failure",
        cell: new FakeAtomicByteCell(occupiedBytes),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_BACKEND_UNAVAILABLE",
        preflight: true,
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
        expectedCompares: 1,
        configure: (cell) => {
          cell.throwOnNextCompare = true;
        },
      },
      {
        label: "uncertain-before",
        cell: new FakeAtomicByteCell(),
        errorCode: "RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN",
        expectedCompares: 1,
        configure: (cell) => {
          cell.uncertainNext = "before";
        },
      },
    ];
    let replay;
    for (const entry of cases) {
      const handoffAuthority = createBootstrapHandoff();
      const candidate = handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET);
      const candidateForFailure = entry.preflight
        ? Object.freeze(Object.create(null))
        : candidate;
      const before = entry.cell.snapshotBytes();
      entry.configure?.(entry.cell);
      assert.throws(
        () => openVault(entry.cell, handoffAuthority).vault.provisionBootstrap(
          candidateForFailure,
        ),
        assertVaultError(entry.errorCode),
        entry.label,
      );
      assert.equal(entry.cell.compares, entry.expectedCompares ?? 0, entry.label);
      assert.equal(
        optionalDigest(entry.cell.snapshotBytes()),
        optionalDigest(before),
        entry.label,
      );

      const acceptingCell = new FakeAtomicByteCell();
      openVault(acceptingCell, handoffAuthority).vault.provisionBootstrap(candidate);
      assert.notEqual(acceptingCell.snapshotBytes(), null, entry.label);
      if (replay === undefined) replay = { handoffAuthority, candidate };
      else await handoffAuthority.closeAndDrain();
    }
    await sourceHandoff.closeAndDrain();

    const uncertainAfterCell = new FakeAtomicByteCell();
    const uncertainAfterHandoff = createBootstrapHandoff();
    const uncertainAfterCandidate = uncertainAfterHandoff.privilegedIntake.accept(
      BOOTSTRAP_SECRET,
    );
    const uncertainAfterVault = openVault(
      uncertainAfterCell,
      uncertainAfterHandoff,
    ).vault;
    uncertainAfterCell.uncertainNext = "after";
    assert.throws(
      () => uncertainAfterVault.provisionBootstrap(uncertainAfterCandidate),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_COMMIT_UNCERTAIN"),
    );
    const uncertainAfterBytes = uncertainAfterCell.snapshotBytes();
    assert.notEqual(uncertainAfterBytes, null);
    assert.throws(
      () => uncertainAfterVault.provisionBootstrap(uncertainAfterCandidate),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_ALREADY_PROVISIONED"),
    );
    assert.equal(
      optionalDigest(uncertainAfterCell.snapshotBytes()),
      optionalDigest(uncertainAfterBytes),
    );

    const replayCell = new FakeAtomicByteCell();
    assert.throws(
      () => openVault(replayCell, replay.handoffAuthority).vault.provisionBootstrap(
        replay.candidate,
      ),
      assertVaultError("RELAY_V2_HOST_CREDENTIAL_VAULT_BOOTSTRAP_HANDOFF_INVALID"),
    );
    assert.equal(replayCell.compares, 0);
    assert.equal(replayCell.snapshotBytes(), null);
    await replay.handoffAuthority.closeAndDrain();
    await uncertainAfterHandoff.closeAndDrain();
  });

  await t.test("structurally and semantically invalid envelopes preserve original bytes", async () => {
    const sourceCell = new FakeAtomicByteCell();
    const sourceHandoff = createBootstrapHandoff();
    const sourceVault = openVault(sourceCell, sourceHandoff).vault;
    sourceVault.provisionBootstrap(
      sourceHandoff.privilegedIntake.accept(BOOTSTRAP_SECRET),
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
    await sourceHandoff.closeAndDrain();
  });

  await t.test("uncertain CAS is never reported as success and reopens from the committed cut", async () => {
    const cell = new FakeAtomicByteCell();
    const handoffAuthority = createBootstrapHandoff();
    const { vault } = openVault(cell, handoffAuthority);
    vault.provisionBootstrap(
      handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET),
    );
    const authority = openAuthority(vault);
    cell.uncertainNext = "after";
    assert.throws(
      () => authority.prepareBootstrap(bootstrapPreparation()),
      assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
    );
    const committedBytes = cell.snapshotBytes();
    const reopened = openAuthority(openVault(cell, handoffAuthority).vault);
    const recovered = reopened.prepareBootstrap(bootstrapPreparation({
      attemptId: "must-not-replace-uncertain-winner",
    }));
    assert.equal(recovered.fence.attemptId, "host-bootstrap-attempt-1");
    assert.equal(digest(recovered.credential.bootstrapToken), digest(BOOTSTRAP_SECRET));
    assert.equal(digest(cell.snapshotBytes()), digest(committedBytes));
    await handoffAuthority.closeAndDrain();
  });

  await t.test("close fences new work and drains the already admitted transaction", async () => {
    const cell = new FakeAtomicByteCell();
    const handoffAuthority = createBootstrapHandoff();
    const { vault } = openVault(cell, handoffAuthority);
    vault.provisionBootstrap(
      handoffAuthority.privilegedIntake.accept(BOOTSTRAP_SECRET),
    );
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
    await handoffAuthority.closeAndDrain();
  });
});
