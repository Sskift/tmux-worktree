import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [new URL("../src/relay/v2/hostCredentialAuthority.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const compiledSource = compiled.outputFiles[0].text;
const credential = await import(
  `data:text/javascript;base64,${Buffer.from(compiledSource).toString("base64")}`
);
const issuer = await import("../dist/relay/v2/issuer.js");

const NOW_SECONDS = 1_783_700_000;
const REFERENCE = "relay-v2-host-credential-ref:primary";
const SECOND_REFERENCE = "relay-v2-host-credential-ref:secondary";
const HOST_ID = "mac-admin";
const BOOTSTRAP_SECRET_REFERENCE = "bootstrap-secret-generation-1";
const BOOTSTRAP_TOKEN = "twhostboot2.bootstrap-secret-material";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class InMemoryDurableCredentialStorage {
  slots = new Map();
  revisions = new WeakMap();
  compareAttempts = 0;
  conflictsRemaining = 0;
  uncertainNext = null;

  runExclusive(reference, operation) {
    const transaction = {
      read: () => this.readCut(reference),
      compareAndSwap: (expected, replacement) => {
        this.compareAttempts += 1;
        const identity = this.revisions.get(expected);
        const slot = this.slot(reference);
        if (!identity || identity.reference !== reference || identity.revision !== slot.revision) {
          return { status: "conflict", current: this.readCut(reference) };
        }
        if (this.conflictsRemaining > 0) {
          this.conflictsRemaining -= 1;
          slot.revision += 1;
          return { status: "conflict", current: this.readCut(reference) };
        }
        const uncertainty = this.uncertainNext;
        this.uncertainNext = null;
        if (uncertainty === "before") return { status: "uncertain" };
        if (uncertainty === "after") {
          slot.state = structuredClone(replacement);
          slot.revision += 1;
          return { status: "uncertain" };
        }
        slot.state = structuredClone(replacement);
        slot.revision += 1;
        return { status: "swapped" };
      },
    };
    return operation(transaction);
  }

  snapshot(reference) {
    const state = this.slot(reference).state;
    return state === null ? null : structuredClone(state);
  }

  replace(reference, state) {
    const slot = this.slot(reference);
    slot.state = structuredClone(state);
    slot.revision += 1;
  }

  slot(reference) {
    let slot = this.slots.get(reference);
    if (!slot) {
      slot = { state: null, revision: 0 };
      this.slots.set(reference, slot);
    }
    return slot;
  }

  readCut(reference) {
    const slot = this.slot(reference);
    const revision = Object.freeze({ opaque: true });
    this.revisions.set(revision, { reference, revision: slot.revision });
    return {
      state: slot.state === null ? null : deepFreeze(structuredClone(slot.state)),
      revision,
    };
  }
}

class RecordingSecretResolver {
  values = new Map([
    [BOOTSTRAP_SECRET_REFERENCE, BOOTSTRAP_TOKEN],
    ["refresh-secret-generation-1", "twref2.host-refresh-token-1"],
    ["refresh-secret-generation-2", "twref2.host-refresh-token-2"],
    ["refresh-secret-generation-3", "twref2.host-refresh-token-3"],
  ]);
  resolutions = [];
  beforeResolve = undefined;

  resolve(reference) {
    this.beforeResolve?.(reference);
    this.resolutions.push(reference);
    const value = this.values.get(reference);
    if (!value) throw new Error("secret source unavailable");
    return value;
  }
}

function authority(storage = new InMemoryDurableCredentialStorage(), secrets = new RecordingSecretResolver()) {
  return {
    storage,
    secrets,
    authority: new credential.RelayV2HostCredentialAuthority({
      storage,
      secretResolver: secrets,
    }),
  };
}

function tokenIssuer() {
  let keyring = issuer.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "host-credential-test-key",
    secretBase64url: Buffer.alloc(32, 0x71).toString("base64url"),
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
    credentialReference: REFERENCE,
    hostId: HOST_ID,
    attemptId: "host-bootstrap-attempt-1",
    oldSecretReference: BOOTSTRAP_SECRET_REFERENCE,
    ...overrides,
  };
}

function bootstrapResponse(access, overrides = {}) {
  return {
    bootstrapAttemptId: "host-bootstrap-attempt-1",
    principalId: "host-principal-uuid",
    grantId: "host-grant-uuid",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: "twref2.host-refresh-token-1",
    refreshExpiresAtMs: 1_786_292_000_000,
    ...overrides,
  };
}

function refreshPreparation(version, overrides = {}) {
  return {
    credentialReference: REFERENCE,
    attemptId: `host-refresh-attempt-${version}`,
    oldSecretReference: `refresh-secret-generation-${version - 1}`,
    ...overrides,
  };
}

function refreshResponse(version, access, overrides = {}) {
  return {
    refreshAttemptId: `host-refresh-attempt-${version}`,
    principalId: "host-principal-uuid",
    grantId: "host-grant-uuid",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: `twref2.host-refresh-token-${version}`,
    refreshExpiresAtMs: 1_786_292_000_000 + version,
    ...overrides,
  };
}

function installBootstrap(harness, issueToken) {
  const prepared = harness.authority.prepareBootstrap(bootstrapPreparation());
  const access = issueToken();
  const committed = harness.authority.applyBootstrapResponse(
    prepared.fence,
    bootstrapResponse(access),
  );
  assert.equal(committed.status, "applied");
  assert.equal(committed.credentialVersion, "1");
  return { prepared, access };
}

function assertAuthorityError(code) {
  return (error) => error?.code === code
    && !error.message.includes("twcap2.")
    && !error.message.includes("twref2.")
    && !error.message.includes("twhostboot2.");
}

test("bootstrap and refresh persist exact attempts before secret/network use and survive reopen", () => {
  const h = authority();
  const issueToken = tokenIssuer();
  h.secrets.beforeResolve = (reference) => {
    const persisted = h.storage.snapshot(REFERENCE);
    assert.equal(persisted.pendingCredentialAttempt.oldSecretReference, reference);
    if (reference === BOOTSTRAP_SECRET_REFERENCE) {
      assert.equal(persisted.pendingCredentialAttempt.kind, "bootstrap");
      assert.equal(persisted.pendingCredentialAttempt.attemptId, "host-bootstrap-attempt-1");
    } else {
      assert.equal(persisted.pendingCredentialAttempt.kind, "refresh");
    }
  };

  const preparedBootstrap = h.authority.prepareBootstrap(bootstrapPreparation());
  assert.equal(preparedBootstrap.fence.oldCredentialVersion, "0");
  assert.equal(digest(preparedBootstrap.credential.bootstrapToken), digest(BOOTSTRAP_TOKEN));
  assert.equal(h.secrets.resolutions.length, 1);

  const reopened = authority(h.storage, h.secrets).authority;
  const retriedBootstrap = reopened.prepareBootstrap(bootstrapPreparation({
    attemptId: "must-not-replace-persisted-bootstrap-attempt",
  }));
  assert.equal(retriedBootstrap.fence.attemptId, "host-bootstrap-attempt-1");
  assert.equal(
    digest(retriedBootstrap.credential.bootstrapToken),
    digest(preparedBootstrap.credential.bootstrapToken),
  );

  const access1 = issueToken();
  const beforeStale = h.storage.snapshot(REFERENCE);
  const wrongFence = {
    ...preparedBootstrap.fence,
    oldSecretReference: "different-bootstrap-secret-reference",
  };
  assert.deepEqual(reopened.applyBootstrapResponse(
    wrongFence,
    bootstrapResponse(access1),
  ), { status: "stale", credentialVersion: "0" });
  assert.equal(h.storage.snapshot(REFERENCE).credentialVersion, beforeStale.credentialVersion);
  assert.equal(
    h.storage.snapshot(REFERENCE).pendingCredentialAttempt.attemptId,
    beforeStale.pendingCredentialAttempt.attemptId,
  );

  assert.deepEqual(reopened.applyBootstrapResponse(
    preparedBootstrap.fence,
    bootstrapResponse(access1),
  ), { status: "applied", credentialVersion: "1" });
  const carrierRecord = reopened.read(REFERENCE);
  assert.equal(carrierRecord.version, "1");
  assert.equal(carrierRecord.accessJti, access1.jti);
  assert.equal(digest(carrierRecord.accessToken), digest(access1.token));
  assert.equal(JSON.stringify(carrierRecord).includes("accessToken"), false);
  assert.equal(JSON.stringify(carrierRecord).includes("twcap2."), false);

  h.storage.conflictsRemaining = 1;
  const compareAttemptsBefore = h.storage.compareAttempts;
  const preparedRefresh = reopened.prepareRefresh(refreshPreparation(2));
  assert.equal(preparedRefresh.fence.attemptId, "host-refresh-attempt-2");
  assert.equal(preparedRefresh.fence.oldCredentialVersion, "1");
  assert.equal(h.secrets.resolutions.at(-1), preparedRefresh.fence.oldSecretReference);
  assert.equal(preparedRefresh.credential.refreshToken, "twref2.host-refresh-token-1");
  assert.equal(h.storage.compareAttempts - compareAttemptsBefore, 2);

  const reopenedDuringRefresh = authority(h.storage, h.secrets).authority;
  const retriedRefresh = reopenedDuringRefresh.prepareRefresh(refreshPreparation(2, {
    attemptId: "must-not-replace-persisted-refresh-attempt",
  }));
  assert.equal(retriedRefresh.fence.attemptId, "host-refresh-attempt-2");
  assert.equal(h.secrets.resolutions.at(-1), retriedRefresh.fence.oldSecretReference);
  assert.equal(
    digest(retriedRefresh.credential.refreshToken),
    digest(preparedRefresh.credential.refreshToken),
  );

  const access2 = issueToken();
  const response2 = refreshResponse(2, access2);
  assert.deepEqual(reopenedDuringRefresh.applyRefreshResponse(
    preparedRefresh.fence,
    response2,
  ), { status: "applied", credentialVersion: "2" });
  const afterRefresh = h.storage.snapshot(REFERENCE);
  assert.equal(afterRefresh.credentialVersion, "2");
  assert.equal(afterRefresh.accessJti, access2.jti);
  assert.equal(afterRefresh.pendingCredentialAttempt, null);

  assert.deepEqual(reopenedDuringRefresh.applyRefreshResponse(
    preparedRefresh.fence,
    response2,
  ), { status: "stale", credentialVersion: "2" });
  assert.equal(h.storage.snapshot(REFERENCE).credentialVersion, "2");

  const preparedRefresh3 = reopenedDuringRefresh.prepareRefresh(refreshPreparation(3));
  const access3 = issueToken();
  assert.deepEqual(reopenedDuringRefresh.applyRefreshResponse(
    preparedRefresh3.fence,
    refreshResponse(3, access3),
  ), { status: "applied", credentialVersion: "3" });
  reopenedDuringRefresh.prepareRefresh(refreshPreparation(4));
  const beforeLateV2 = h.storage.snapshot(REFERENCE);
  const lateAccess2 = issueToken();
  assert.deepEqual(reopenedDuringRefresh.applyRefreshResponse(
    preparedRefresh.fence,
    refreshResponse(2, lateAccess2, {
      accessExpiresAtMs: lateAccess2.expiresAtMs + 1_000,
      refreshToken: "twref2.late-refresh-token-must-not-win",
      refreshExpiresAtMs: 1_799_999_999_999,
    }),
  ), { status: "stale", credentialVersion: "3" });
  assert.deepEqual(h.storage.snapshot(REFERENCE), beforeLateV2);
});

test("reauthentication retries reuse requestId/token/jti and five-field ACK fences newer credentials", () => {
  const h = authority();
  const issueToken = tokenIssuer();
  installBootstrap(h, issueToken);

  const refresh2 = h.authority.prepareRefresh(refreshPreparation(2));
  const access2 = issueToken();
  h.authority.applyRefreshResponse(refresh2.fence, refreshResponse(2, access2));
  const reauth2 = h.authority.prepareReauthentication({
    credentialReference: REFERENCE,
    requestId: "host-reauth-request-2",
  });
  const retried2 = h.authority.prepareReauthentication({
    credentialReference: REFERENCE,
    requestId: "must-not-replace-persisted-reauth-request",
  });
  assert.equal(retried2.fence.requestId, reauth2.fence.requestId);
  assert.equal(retried2.fence.accessJti, reauth2.fence.accessJti);
  assert.equal(digest(retried2.accessToken), digest(reauth2.accessToken));

  const refresh3 = h.authority.prepareRefresh(refreshPreparation(3));
  const access3 = issueToken();
  h.authority.applyRefreshResponse(refresh3.fence, refreshResponse(3, access3));
  const beforeReusedOldRequestId = h.storage.snapshot(REFERENCE);
  assert.throws(
    () => h.authority.prepareReauthentication({
      credentialReference: REFERENCE,
      requestId: "host-reauth-request-2",
    }),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT"),
  );
  assert.deepEqual(h.storage.snapshot(REFERENCE), beforeReusedOldRequestId);
  const reauth3 = h.authority.prepareReauthentication({
    credentialReference: REFERENCE,
    requestId: "host-reauth-request-3",
  });
  assert.equal(reauth3.fence.version, "3");
  assert.equal(reauth3.fence.accessJti, access3.jti);

  assert.equal(h.authority.acknowledgeReauthentication(reauth2.fence), false);
  assert.equal(h.authority.inspect(REFERENCE).pendingReauthentication.requestId,
    "host-reauth-request-3");
  for (const staleFence of [
    { ...reauth3.fence, reference: SECOND_REFERENCE },
    { ...reauth3.fence, version: "2" },
    { ...reauth3.fence, requestId: "wrong-request" },
    { ...reauth3.fence, grantId: "wrong-grant" },
    { ...reauth3.fence, accessJti: "wrong-jti" },
  ]) {
    assert.equal(h.authority.acknowledgeReauthentication(staleFence), false);
    assert.equal(h.authority.inspect(REFERENCE).pendingReauthentication.requestId,
      "host-reauth-request-3");
  }
  assert.equal(h.authority.acknowledgeReauthentication(reauth3.fence), true);
  assert.equal(h.authority.inspect(REFERENCE).pendingReauthentication, null);
  assert.equal(h.authority.acknowledgeReauthentication(reauth3.fence), false);
});

test("uncertain CAS fails closed before or after linearization and bounded conflicts never guess", () => {
  const h = authority();
  const issueToken = tokenIssuer();

  h.storage.uncertainNext = "before";
  assert.throws(
    () => h.authority.prepareBootstrap(bootstrapPreparation()),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
  );
  assert.equal(h.storage.snapshot(REFERENCE), null);
  assert.equal(h.secrets.resolutions.length, 0);

  h.storage.uncertainNext = "after";
  assert.throws(
    () => h.authority.prepareBootstrap(bootstrapPreparation()),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
  );
  assert.equal(h.storage.snapshot(REFERENCE).pendingCredentialAttempt.attemptId,
    "host-bootstrap-attempt-1");
  assert.equal(h.secrets.resolutions.length, 0);

  const reopened = authority(h.storage, h.secrets).authority;
  const recovered = reopened.prepareBootstrap(bootstrapPreparation({
    attemptId: "new-id-must-not-replace-uncertain-winner",
  }));
  assert.equal(recovered.fence.attemptId, "host-bootstrap-attempt-1");
  const access1 = issueToken();

  h.storage.uncertainNext = "after";
  assert.throws(
    () => reopened.applyBootstrapResponse(recovered.fence, bootstrapResponse(access1)),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
  );
  assert.equal(h.storage.snapshot(REFERENCE).credentialVersion, "1");
  assert.deepEqual(reopened.applyBootstrapResponse(
    recovered.fence,
    bootstrapResponse(access1),
  ), { status: "stale", credentialVersion: "1" });

  const resolutionsBeforeRefresh = h.secrets.resolutions.length;
  h.storage.uncertainNext = "before";
  assert.throws(
    () => reopened.prepareRefresh(refreshPreparation(2)),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
  );
  assert.equal(h.storage.snapshot(REFERENCE).pendingCredentialAttempt, null);
  assert.equal(h.secrets.resolutions.length, resolutionsBeforeRefresh);

  h.storage.uncertainNext = "after";
  assert.throws(
    () => reopened.prepareRefresh(refreshPreparation(2)),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"),
  );
  const uncertainRefreshWinner = h.storage.snapshot(REFERENCE).pendingCredentialAttempt;
  assert.equal(uncertainRefreshWinner.oldSecretReference, "refresh-secret-generation-1");
  assert.equal(h.secrets.resolutions.length, resolutionsBeforeRefresh);
  const reopenedRefresh = authority(h.storage, h.secrets).authority.prepareRefresh(
    refreshPreparation(2, { attemptId: "must-reuse-uncertain-refresh-winner" }),
  );
  assert.equal(reopenedRefresh.fence.attemptId, uncertainRefreshWinner.attemptId);
  assert.equal(h.secrets.resolutions.at(-1), uncertainRefreshWinner.oldSecretReference);

  const conflicting = authority();
  installBootstrap(conflicting, tokenIssuer());
  const resolutionsBeforeConflicts = conflicting.secrets.resolutions.length;
  conflicting.storage.conflictsRemaining = 10;
  assert.throws(
    () => conflicting.authority.prepareRefresh(refreshPreparation(2)),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT"),
  );
  assert.equal(conflicting.storage.snapshot(REFERENCE).pendingCredentialAttempt, null);
  assert.equal(conflicting.secrets.resolutions.length, resolutionsBeforeConflicts);
});

test("defensive state validation and public inspection never expose token material", () => {
  const h = authority();
  const issueToken = tokenIssuer();
  installBootstrap(h, issueToken);

  const inspection = h.authority.inspect(REFERENCE);
  const ordinarySnapshot = JSON.stringify(inspection);
  assert.equal(ordinarySnapshot.includes("accessToken"), false);
  assert.equal(ordinarySnapshot.includes("refreshToken"), false);
  assert.equal(ordinarySnapshot.includes("twcap2."), false);
  assert.equal(ordinarySnapshot.includes("twref2."), false);
  const beforeInspectionMutation = h.storage.snapshot(REFERENCE);
  inspection.credentialVersion = "999";
  assert.deepEqual(h.storage.snapshot(REFERENCE), beforeInspectionMutation);

  const prepared = h.authority.prepareRefresh(refreshPreparation(2));
  const originalFence = structuredClone(prepared.fence);
  const beforeReturnedObjectMutation = h.storage.snapshot(REFERENCE);
  const pendingInspection = h.authority.inspect(REFERENCE);
  pendingInspection.pendingCredentialAttempt.attemptId = "mutated-inspection-attempt";
  prepared.fence.attemptId = "mutated-returned-fence";
  prepared.credential.refreshToken = "twref2.mutated-returned-credential";
  assert.deepEqual(h.storage.snapshot(REFERENCE), beforeReturnedObjectMutation);
  const tokenMarker = "twcap2.must-never-appear-in-an-error";
  assert.throws(
    () => h.authority.applyRefreshResponse(originalFence, refreshResponse(2, {
      token: tokenMarker,
      expiresAtMs: 1_783_703_602_000,
    })),
    (error) => assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID")(error)
      && !error.message.includes(tokenMarker),
  );
  assert.equal(h.storage.snapshot(REFERENCE).credentialVersion, "1");
  assert.equal(h.storage.snapshot(REFERENCE).pendingCredentialAttempt.attemptId,
    "host-refresh-attempt-2");

  const corrupt = h.storage.snapshot(REFERENCE);
  corrupt.connectorId = "forbidden-connector-state";
  h.storage.replace(REFERENCE, corrupt);
  assert.throws(
    () => h.authority.inspect(REFERENCE),
    assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID"),
  );
  assert.equal(h.storage.snapshot(REFERENCE).connectorId, "forbidden-connector-state");

  const throwingStorage = {
    runExclusive() {
      throw new Error(`storage leaked ${tokenMarker}`);
    },
  };
  const closed = authority(throwingStorage, h.secrets).authority;
  assert.throws(
    () => closed.inspect(REFERENCE),
    (error) => assertAuthorityError("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE")(error)
      && !error.message.includes(tokenMarker),
  );
});
