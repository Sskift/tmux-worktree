import assert from "node:assert/strict";
import test from "node:test";

const upgradeModule = await import(
  "../dist/relay/v2/brokerHostUpgradeDispatch.js"
);

const HOST_ID = "mac-admin";
const TOKEN = "twcap2.sensitive-host-token";

function metadata(overrides = {}) {
  return {
    pathname: "/host",
    search: "",
    authorizationHeaders: [`Bearer ${TOKEN}`],
    legacyQuerySecret: null,
    offeredProtocols: ["tw-relay.host.v2"],
    ...overrides,
  };
}

function trustedHostAuthorization() {
  return {
    scheme: "twcap2",
    role: "host",
    hostId: HOST_ID,
    principalId: "host-principal",
    grantId: "host-grant",
    clientInstanceId: null,
    jti: "host-jti",
    kid: "kid-current",
    expiresAtMs: 1_783_700_060_000,
    authorizationRevision: "7",
    authorizationFence: "authorization-fence-7",
  };
}

test("Host Upgrade accept passes only closed auth through preflight before exposing its receipt", async () => {
  const trustedAuth = trustedHostAuthorization();
  const preflightReject = Object.freeze({ outcome: "reject", status: 503 });
  const admissionReceipt = Object.freeze(Object.create(null));
  const verifierInputs = [];
  const preflightInputs = [];
  let preflightResult = preflightReject;
  let resolveFirstVerifier;
  const owner = new upgradeModule.RelayV2BrokerHostUpgradeDispatchOwner({
    verifyV2AccessToken(token, expectedRole) {
      verifierInputs.push({ token, expectedRole });
      if (verifierInputs.length === 1) {
        return new Promise((resolve) => { resolveFirstVerifier = resolve; });
      }
      return trustedAuth;
    },
    prepareHostWss(input) {
      preflightInputs.push(input);
      return preflightResult;
    },
  });

  const mutableMetadata = metadata();
  const pendingRejected = owner.dispatch(mutableMetadata);
  assert.equal(typeof resolveFirstVerifier, "function");
  mutableMetadata.pathname = "/client";
  mutableMetadata.authorizationHeaders[0] = "Bearer twcap2.changed";
  mutableMetadata.offeredProtocols[0] = "tw-relay.v2";
  resolveFirstVerifier(trustedAuth);

  const rejected = await pendingRejected;
  assert.strictEqual(rejected, preflightReject);
  assert.deepEqual(verifierInputs[0], { token: TOKEN, expectedRole: "host" });
  assert.deepEqual(Reflect.ownKeys(preflightInputs[0]), ["trustedAuthContext"]);
  assert.deepEqual(preflightInputs[0].trustedAuthContext, trustedAuth);
  assert.equal(Object.isFrozen(preflightInputs[0].trustedAuthContext), true);
  assert.deepEqual(Reflect.ownKeys(preflightInputs[0].trustedAuthContext).sort(), [
    "authorizationFence",
    "authorizationRevision",
    "clientInstanceId",
    "expiresAtMs",
    "grantId",
    "hostId",
    "jti",
    "kid",
    "principalId",
    "role",
    "scheme",
  ]);
  assert.equal(JSON.stringify(preflightInputs[0]).includes(TOKEN), false);

  preflightResult = Object.freeze({ outcome: "accept", receipt: admissionReceipt });
  const accepted = await owner.dispatch(metadata());
  assert.deepEqual(verifierInputs, [
    { token: TOKEN, expectedRole: "host" },
    { token: TOKEN, expectedRole: "host" },
  ]);
  assert.deepEqual(Reflect.ownKeys(accepted).sort(), [
    "admissionReceipt",
    "outcome",
    "selectedProtocol",
  ]);
  assert.equal(accepted.outcome, "accept");
  assert.equal(accepted.selectedProtocol, "tw-relay.host.v2");
  assert.strictEqual(accepted.admissionReceipt, admissionReceipt);
  assert.equal(JSON.stringify(accepted).includes(TOKEN), false);
  for (const forbidden of [
    "authContext",
    "trustedAuthContext",
    "token",
    "broker",
    "core",
    "socket",
  ]) assert.equal(Object.hasOwn(accepted, forbidden), false);
});

test("Host Upgrade rejects role, endpoint, protocol, and auth without verifier fallback or preflight", async () => {
  let v2VerifierCalls = 0;
  let legacyVerifierCalls = 0;
  let prepareCalls = 0;
  const owner = new upgradeModule.RelayV2BrokerHostUpgradeDispatchOwner({
    verifyV2AccessToken(token, expectedRole) {
      v2VerifierCalls += 1;
      assert.equal(token, TOKEN);
      assert.equal(expectedRole, "host");
      throw Object.assign(new Error(`redacted ${TOKEN}`), { code: "PERMISSION_DENIED" });
    },
    verifyLegacySecret() {
      legacyVerifierCalls += 1;
      return true;
    },
    prepareHostWss() {
      prepareCalls += 1;
      throw new Error("preflight must not run");
    },
  });

  let metadataProxyTrapCalls = 0;
  const metadataProxy = new Proxy(metadata(), {
    get() {
      metadataProxyTrapCalls += 1;
      throw new Error("metadata Proxy getter must not run");
    },
    getOwnPropertyDescriptor() {
      metadataProxyTrapCalls += 1;
      throw new Error("metadata Proxy descriptor trap must not run");
    },
    ownKeys() {
      metadataProxyTrapCalls += 1;
      throw new Error("metadata Proxy ownKeys trap must not run");
    },
  });
  let pathnameGetterCalls = 0;
  const accessorMetadata = metadata();
  Object.defineProperty(accessorMetadata, "pathname", {
    configurable: true,
    enumerable: true,
    get() {
      pathnameGetterCalls += 1;
      throw new Error("pathname getter must not run");
    },
  });
  let authorizationHeadersProxyTrapCalls = 0;
  const authorizationHeadersProxy = new Proxy([`Bearer ${TOKEN}`], {
    get() {
      authorizationHeadersProxyTrapCalls += 1;
      throw new Error("Authorization Proxy getter must not run");
    },
    getOwnPropertyDescriptor() {
      authorizationHeadersProxyTrapCalls += 1;
      throw new Error("Authorization Proxy descriptor trap must not run");
    },
    ownKeys() {
      authorizationHeadersProxyTrapCalls += 1;
      throw new Error("Authorization Proxy ownKeys trap must not run");
    },
  });
  const cases = [
    {
      name: "metadata Proxy",
      input: metadataProxy,
      expectedError: /invalid Relay v2 Broker host Upgrade metadata/,
    },
    {
      name: "pathname own accessor",
      input: accessorMetadata,
      expectedError: /invalid Relay v2 Broker host Upgrade metadata/,
    },
    {
      name: "Authorization headers Proxy",
      input: metadata({ authorizationHeaders: authorizationHeadersProxy }),
      expectedError: /invalid Relay v2 Broker host Upgrade metadata/,
    },
    {
      name: "client role",
      input: metadata({ pathname: "/client", offeredProtocols: ["tw-relay.v2"] }),
      expected: { outcome: "reject", status: 403, errorCode: "ROLE_MISMATCH", fallback: false },
    },
    {
      name: "non-exact Host path",
      input: metadata({ pathname: "/host/" }),
      expected: {
        outcome: "reject",
        status: 404,
        errorCode: "PROTOCOL_UNSUPPORTED",
        fallback: false,
      },
    },
    {
      name: "Host query",
      input: metadata({ search: "?hostId=mac-admin" }),
      expected: {
        outcome: "reject",
        status: 400,
        errorCode: "PROTOCOL_UNSUPPORTED",
        fallback: false,
      },
    },
    {
      name: "multiple Authorization",
      input: metadata({ authorizationHeaders: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }),
      expected: { outcome: "reject", status: 401, errorCode: "AUTH_INVALID", fallback: false },
    },
    {
      name: "wrong Host protocol",
      input: metadata({ offeredProtocols: ["tw-relay.v1"] }),
      expected: {
        outcome: "reject",
        status: 426,
        errorCode: "PROTOCOL_UNSUPPORTED",
        fallback: false,
      },
    },
    {
      name: "v1 credential",
      input: metadata({
        authorizationHeaders: ["Bearer legacy-secret"],
        offeredProtocols: ["tw-relay.v1"],
      }),
      expected: { outcome: "reject", status: 401, errorCode: "AUTH_INVALID", fallback: false },
    },
    {
      name: "Host verifier rejection",
      input: metadata(),
      expected: {
        outcome: "reject",
        status: 403,
        errorCode: "PERMISSION_DENIED",
        fallback: false,
      },
    },
  ];

  for (const entry of cases) {
    if (entry.expectedError) {
      await assert.rejects(owner.dispatch(entry.input), entry.expectedError, entry.name);
      continue;
    }
    const result = await owner.dispatch(entry.input);
    assert.deepEqual(result, entry.expected, entry.name);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, entry.name);
  }
  assert.equal(metadataProxyTrapCalls, 0);
  assert.equal(pathnameGetterCalls, 0);
  assert.equal(authorizationHeadersProxyTrapCalls, 0);
  assert.equal(v2VerifierCalls, 1);
  assert.equal(legacyVerifierCalls, 0);
  assert.equal(prepareCalls, 0);
});
