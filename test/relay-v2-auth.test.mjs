import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

const auth = await import("../dist/relay/v2/auth.js");
const issuer = await import("../dist/relay/v2/issuer.js");

const NOW = 1_783_700_000;
const ISSUER_ID = "relay-issuer-test";
const HOST_ID = "mac-admin";
const CLIENT_PRINCIPAL = "principal-client";
const CLIENT_GRANT = "grant-client";
const CLIENT_INSTANCE = "android-install";

function keyring(kid = "key-old") {
  return issuer.createRelayV2IssuerKeyring({
    issuerId: ISSUER_ID,
    kid,
    secretBase64url: randomBytes(32).toString("base64url"),
    nowSeconds: NOW,
  });
}

function clientGrant(overrides = {}) {
  return {
    role: "client",
    hostId: HOST_ID,
    principalId: CLIENT_PRINCIPAL,
    grantId: CLIENT_GRANT,
    clientInstanceId: CLIENT_INSTANCE,
    revokedAtSeconds: null,
    expiresAtSeconds: NOW + 86_400,
    ...overrides,
  };
}

function clientIssue(overrides = {}) {
  return {
    role: "client",
    hostId: HOST_ID,
    principalId: CLIENT_PRINCIPAL,
    grantId: CLIENT_GRANT,
    clientInstanceId: CLIENT_INSTANCE,
    nowSeconds: NOW,
    ttlSeconds: 600,
    jti: "jti-client",
    ...overrides,
  };
}

function verifyClient(token, currentKeyring, overrides = {}) {
  return auth.verifyRelayV2AccessAuthorization(token, {
    keyring: currentKeyring,
    grant: clientGrant(),
    nowSeconds: NOW,
    expectedRole: "client",
    expectedHostId: HOST_ID,
    ...overrides,
  });
}

function signPayloadSegment(payloadSegment, currentKeyring) {
  const secret = Buffer.from(currentKeyring.activeKey.secretBase64url, "base64url");
  const mac = createHmac("sha256", secret)
    .update(`twcap2.${payloadSegment}`, "ascii")
    .digest("base64url");
  return `twcap2.${payloadSegment}.${mac}`;
}

function mutatePayload(token, transform, currentKeyring, resign = true) {
  const [, payloadSegment, mac] = token.split(".");
  const payload = Buffer.from(payloadSegment, "base64url").toString("utf8");
  const changedSegment = Buffer.from(transform(payload), "utf8").toString("base64url");
  return resign
    ? signPayloadSegment(changedSegment, currentKeyring)
    : `twcap2.${changedSegment}.${mac}`;
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("twcap2 prepares and verifies closed client and host identities", () => {
  let current = keyring();
  const client = issuer.prepareRelayV2AccessTokenIssuance(current, clientIssue());
  current = client.nextKeyring;
  const clientContext = verifyClient(client.token, current);

  assert.deepEqual(clientContext, {
    scheme: "twcap2",
    role: "client",
    hostId: HOST_ID,
    principalId: CLIENT_PRINCIPAL,
    grantId: CLIENT_GRANT,
    clientInstanceId: CLIENT_INSTANCE,
    jti: "jti-client",
    kid: "key-old",
    expiresAtMs: (NOW + 600) * 1_000,
  });
  for (const segment of client.token.split(".").slice(1)) {
    assert.match(segment, /^[A-Za-z0-9_-]+$/);
    assert.equal(segment.includes("="), false);
  }

  const host = issuer.prepareRelayV2AccessTokenIssuance(current, {
    role: "host",
    hostId: HOST_ID,
    principalId: "principal-host",
    grantId: "grant-host",
    nowSeconds: NOW,
    ttlSeconds: 600,
    jti: "jti-host",
  });
  const hostContext = auth.verifyRelayV2AccessAuthorization(host.token, {
    keyring: host.nextKeyring,
    grant: {
      role: "host",
      hostId: HOST_ID,
      principalId: "principal-host",
      grantId: "grant-host",
      clientInstanceId: null,
      revokedAtSeconds: null,
      expiresAtSeconds: NOW + 86_400,
    },
    nowSeconds: NOW,
    expectedRole: "host",
    expectedHostId: HOST_ID,
  });
  assert.equal(hostContext.role, "host");
  assert.equal(hostContext.clientInstanceId, null);
});

test("twcap2 rejects tamper, noncanonical data, closed-claim violations, and invalid time", () => {
  const initial = keyring();
  const issued = issuer.prepareRelayV2AccessTokenIssuance(initial, clientIssue());
  const current = issued.nextKeyring;
  const [, canonicalPayload, canonicalMac] = issued.token.split(".");
  const paddedPayload = `${canonicalPayload}=`;
  const notYetValid = issuer.prepareRelayV2AccessTokenIssuance(current, clientIssue({
    notBeforeSeconds: NOW + 120,
    jti: "jti-future",
  }));
  const shortLived = issuer.prepareRelayV2AccessTokenIssuance(notYetValid.nextKeyring, clientIssue({
    ttlSeconds: 120,
    jti: "jti-short",
  }));

  const invalidCases = [
    {
      name: "payload tamper",
      token: mutatePayload(issued.token, (payload) => payload.replace(HOST_ID, "mac-evil"), current, false),
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "MAC tamper",
      token: `twcap2.${canonicalPayload}.${canonicalMac.slice(0, -1)}${canonicalMac.endsWith("A") ? "B" : "A"}`,
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "unknown claim",
      token: mutatePayload(issued.token, (payload) => payload.replace(/}$/, ',"extra":true}'), current),
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "duplicate claim",
      token: mutatePayload(issued.token, (payload) => payload.replace('"v":2', '"v":2,"v":2'), current),
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "unknown kid",
      token: mutatePayload(issued.token, (payload) => payload.replace('"kid":"key-old"', '"kid":"key-missing"'), current),
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "noncanonical padded payload",
      token: signPayloadSegment(paddedPayload, current),
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "noncanonical padded MAC",
      token: `${issued.token}=`,
      keyring: current,
      nowSeconds: NOW,
    },
    {
      name: "expired at skew boundary",
      token: shortLived.token,
      keyring: shortLived.nextKeyring,
      nowSeconds: shortLived.claims.exp + 60,
    },
    {
      name: "not yet valid outside skew",
      token: notYetValid.token,
      keyring: notYetValid.nextKeyring,
      nowSeconds: NOW + 59,
    },
    {
      name: "legacy credential is never a fallback",
      token: "legacy-shared-secret",
      keyring: current,
      nowSeconds: NOW,
    },
  ];

  for (const fixture of invalidCases) {
    assert.throws(
      () => verifyClient(fixture.token, fixture.keyring, { nowSeconds: fixture.nowSeconds }),
      (error) => {
        assert.equal(error.code, "AUTH_INVALID", fixture.name);
        assert.equal(error.message.includes(fixture.token), false, fixture.name);
        assert.equal(error.message.includes(current.activeKey.secretBase64url), false, fixture.name);
        return true;
      },
      fixture.name,
    );
  }

  assert.equal(
    verifyClient(shortLived.token, shortLived.nextKeyring, {
      nowSeconds: shortLived.claims.exp + 59,
    }).jti,
    "jti-short",
  );
  assert.equal(
    verifyClient(notYetValid.token, notYetValid.nextKeyring, { nowSeconds: NOW + 60 }).jti,
    "jti-future",
  );
  assert.throws(
    () => issuer.prepareRelayV2AccessTokenIssuance(current, clientIssue({ ttlSeconds: 3_601 })),
    (error) => error.code === "AUTH_STATE_INVALID",
  );
});

test("role, host, principal, grant, client instance, revocation, and grant expiry are bound", () => {
  const initial = keyring();
  const issued = issuer.prepareRelayV2AccessTokenIssuance(initial, clientIssue());
  const base = {
    keyring: issued.nextKeyring,
    grant: clientGrant(),
    nowSeconds: NOW,
    expectedRole: "client",
    expectedHostId: HOST_ID,
  };
  const cases = [
    { name: "expected role", patch: { expectedRole: "host" }, code: "ROLE_MISMATCH" },
    { name: "expected host", patch: { expectedHostId: "another-host" }, code: "PERMISSION_DENIED" },
    { name: "grant role", patch: { grant: clientGrant({ role: "host", clientInstanceId: null }) }, code: "ROLE_MISMATCH" },
    { name: "grant host", patch: { grant: clientGrant({ hostId: "another-host" }) }, code: "PERMISSION_DENIED" },
    { name: "grant principal", patch: { grant: clientGrant({ principalId: "another-principal" }) }, code: "PERMISSION_DENIED" },
    { name: "grant id", patch: { grant: clientGrant({ grantId: "another-grant" }) }, code: "PERMISSION_DENIED" },
    { name: "client instance", patch: { grant: clientGrant({ clientInstanceId: "another-install" }) }, code: "PERMISSION_DENIED" },
    { name: "revoked", patch: { grant: clientGrant({ revokedAtSeconds: NOW - 1 }) }, code: "PERMISSION_DENIED" },
    { name: "grant expired", patch: { grant: clientGrant({ expiresAtSeconds: NOW }) }, code: "PERMISSION_DENIED" },
    { name: "grant missing", patch: { grant: undefined }, code: "GRANT_NOT_FOUND" },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => auth.verifyRelayV2AccessAuthorization(issued.token, { ...base, ...fixture.patch }),
      (error) => error.code === fixture.code,
      fixture.name,
    );
  }
});

test("key rotation retains verify-only keys, forbids kid reuse, and supports deliberate removal", () => {
  const first = issuer.prepareRelayV2AccessTokenIssuance(keyring(), clientIssue({
    ttlSeconds: 3_600,
    jti: "jti-old-key",
  }));
  const rotated = issuer.rotateRelayV2IssuerKeyring(first.nextKeyring, {
    kid: "key-new",
    secretBase64url: randomBytes(32).toString("base64url"),
    nowSeconds: NOW + 10,
  });
  assert.equal(rotated.activeKey.kid, "key-new");
  assert.equal(rotated.verifyOnlyKeys[0].kid, "key-old");
  assert.equal(rotated.verifyOnlyKeys[0].verifyUntilSeconds, first.claims.exp + 60);
  assert.equal(verifyClient(first.token, rotated, { nowSeconds: NOW + 20 }).kid, "key-old");

  const second = issuer.prepareRelayV2AccessTokenIssuance(rotated, clientIssue({
    nowSeconds: NOW + 20,
    jti: "jti-new-key",
  }));
  assert.equal(second.claims.kid, "key-new");
  assert.equal(verifyClient(second.token, second.nextKeyring, { nowSeconds: NOW + 20 }).kid, "key-new");
  assert.throws(
    () => issuer.removeRelayV2VerifyOnlyKey(rotated, "key-old", {
      nowSeconds: first.claims.exp + 59,
    }),
    /still required/,
  );
  assert.throws(
    () => issuer.rotateRelayV2IssuerKeyring(rotated, {
      kid: "key-old",
      secretBase64url: randomBytes(32).toString("base64url"),
      nowSeconds: NOW + 30,
    }),
    /cannot be reused/,
  );

  const emergencyRemoval = issuer.removeRelayV2VerifyOnlyKey(second.nextKeyring, "key-old", {
    nowSeconds: NOW + 30,
    emergency: true,
  });
  assert.equal(emergencyRemoval.retiredKids.includes("key-old"), true);
  assert.throws(
    () => verifyClient(first.token, emergencyRemoval, { nowSeconds: NOW + 30 }),
    (error) => error.code === "AUTH_INVALID",
  );
  assert.equal(verifyClient(second.token, emergencyRemoval, { nowSeconds: NOW + 30 }).kid, "key-new");

  const scheduledRemoval = issuer.removeRelayV2VerifyOnlyKey(rotated, "key-old", {
    nowSeconds: first.claims.exp + 60,
  });
  assert.equal(scheduledRemoval.verifyOnlyKeys.length, 0);
  assert.equal(scheduledRemoval.retiredKids[0], "key-old");
});

test("issuer keyring storage is strict, atomic, owner-private, and mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-v2-auth-"));
  const path = join(root, "private", "issuer-keyring.json");
  try {
    const initial = keyring();
    issuer.saveRelayV2IssuerKeyring(initial, path);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(issuer.loadRelayV2IssuerKeyring(path).activeKey.kid, "key-old");

    const rotated = issuer.rotateRelayV2IssuerKeyring(initial, {
      kid: "key-persisted",
      secretBase64url: randomBytes(32).toString("base64url"),
      nowSeconds: NOW + 1,
    });
    issuer.saveRelayV2IssuerKeyring(rotated, path);
    const loaded = issuer.loadRelayV2IssuerKeyring(path);
    assert.equal(loaded.activeKey.kid, "key-persisted");
    assert.deepEqual(readdirSync(dirname(path)), [basename(path)]);

    const beforeRejectedWrite = fileHash(path);
    assert.throws(
      () => issuer.saveRelayV2IssuerKeyring({ ...rotated, unknown: true }, path),
      (error) => error.code === "AUTH_STATE_INVALID",
    );
    assert.equal(fileHash(path), beforeRejectedWrite);

    chmodSync(path, 0o644);
    assert.throws(
      () => issuer.loadRelayV2IssuerKeyring(path),
      (error) => error.code === "AUTH_STATE_INVALID",
    );
    chmodSync(path, 0o600);

    const duplicate = readFileSync(path, "utf8")
      .replace('"version": 1', '"version": 1, "version": 1');
    writeFileSync(path, duplicate, { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(
      () => issuer.loadRelayV2IssuerKeyring(path),
      (error) => error.code === "AUTH_STATE_INVALID" && !error.message.includes(initial.activeKey.secretBase64url),
    );
    assert.throws(
      () => issuer.saveRelayV2IssuerKeyring(rotated, path),
      (error) => error.code === "AUTH_STATE_INVALID",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
