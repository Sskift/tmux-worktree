import assert from "node:assert/strict";
import test from "node:test";

const upgradeModule = await import(
  "../dist/relay/v2/brokerClientUpgradeDispatch.js"
);

const HOST_ID = "mac-admin";
const TOKEN = "twcap2.sensitive-client-token";

function metadata(overrides = {}) {
  return {
    pathname: "/client",
    search: "",
    authorizationHeaders: [`Bearer ${TOKEN}`],
    legacyQuerySecret: null,
    offeredProtocols: ["tw-relay.v2"],
    ...overrides,
  };
}

function trustedClientAuthorization() {
  return {
    scheme: "twcap2",
    role: "client",
    hostId: HOST_ID,
    principalId: "client-principal",
    grantId: "client-grant",
    clientInstanceId: "android-install",
    jti: "client-jti",
    kid: "kid-current",
    expiresAtMs: 1_783_700_060_000,
    authorizationRevision: "7",
    authorizationFence: "authorization-fence-7",
  };
}

const producerTarget = Object.freeze({
  transportId: "host-producer",
  generation: "1",
});

test("client Upgrade dispatch keeps malformed, host, v1, and verifier failures in canonical dispatch", async () => {
  let v2VerifierCalls = 0;
  let legacyVerifierCalls = 0;
  let prepareCalls = 0;
  const owner = new upgradeModule.RelayV2BrokerClientUpgradeDispatchOwner({
    verifyV2AccessToken(token, expectedRole) {
      v2VerifierCalls += 1;
      assert.equal(token, TOKEN);
      assert.equal(expectedRole, "client");
      throw Object.assign(new Error("redacted"), { code: "AUTH_INVALID" });
    },
    verifyLegacySecret() {
      legacyVerifierCalls += 1;
      return true;
    },
    prepareClientWss() {
      prepareCalls += 1;
      throw new Error("preflight must not run");
    },
  });
  const validPorts = {
    verifyV2AccessToken() { return trustedClientAuthorization(); },
    prepareClientWss() { throw new Error("unused"); },
  };
  assert.throws(() => new upgradeModule.RelayV2BrokerClientUpgradeDispatchOwner(
    new Proxy(validPorts, {}),
  ), /dispatch ports/);
  let accessorCalls = 0;
  const accessorPorts = {};
  Object.defineProperties(accessorPorts, {
    verifyV2AccessToken: {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return validPorts.verifyV2AccessToken;
      },
    },
    prepareClientWss: { enumerable: true, value: validPorts.prepareClientWss },
  });
  assert.throws(() => new upgradeModule.RelayV2BrokerClientUpgradeDispatchOwner(
    accessorPorts,
  ), /dispatch ports/);
  assert.equal(accessorCalls, 0);

  await assert.rejects(owner.dispatch(metadata(), {
    transportId: "host-producer",
    generation: "0",
  }), /Host producer target/);
  await assert.rejects(owner.dispatch(metadata(), new Proxy(producerTarget, {})),
    /Host producer target/);
  assert.equal(v2VerifierCalls, 0);
  assert.equal(legacyVerifierCalls, 0);
  assert.equal(prepareCalls, 0);

  const cases = [
    {
      name: "multiple Authorization",
      input: metadata({
        authorizationHeaders: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`],
      }),
      expected: { outcome: "reject", status: 401, errorCode: "AUTH_INVALID", fallback: false },
    },
    {
      name: "query token",
      input: metadata({
        search: `?secret=${TOKEN}`,
        authorizationHeaders: [],
        legacyQuerySecret: TOKEN,
      }),
      expected: { outcome: "reject", status: 401, errorCode: "AUTH_INVALID", fallback: false },
    },
    {
      name: "query on v2 path",
      input: metadata({ search: "?hostId=mac-admin" }),
      expected: {
        outcome: "reject",
        status: 400,
        errorCode: "PROTOCOL_UNSUPPORTED",
        fallback: false,
      },
    },
    {
      name: "wrong path",
      input: metadata({ pathname: "/client/" }),
      expected: {
        outcome: "reject",
        status: 404,
        errorCode: "PROTOCOL_UNSUPPORTED",
        fallback: false,
      },
    },
    {
      name: "wrong protocol",
      input: metadata({ offeredProtocols: ["tw-relay.v1", "tw-relay.v2"] }),
      expected: {
        outcome: "reject",
        status: 426,
        errorCode: "PROTOCOL_UNSUPPORTED",
        fallback: false,
      },
    },
    {
      name: "host credential",
      input: metadata({ pathname: "/host", offeredProtocols: ["tw-relay.host.v2"] }),
      expected: { outcome: "reject", status: 403, errorCode: "ROLE_MISMATCH", fallback: false },
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
      name: "v2 verifier failure",
      input: metadata(),
      expected: { outcome: "reject", status: 401, errorCode: "AUTH_INVALID", fallback: false },
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(await owner.dispatch(entry.input, producerTarget), entry.expected, entry.name);
  }
  assert.equal(v2VerifierCalls, 1);
  assert.equal(legacyVerifierCalls, 0);
  assert.equal(prepareCalls, 0);
});

test("accepted client auth enters preflight exactly while reject and opaque success stay closed", async () => {
  const trustedAuth = trustedClientAuthorization();
  const coreReject = Object.freeze({
    outcome: "reject",
    status: 503,
    error: Object.freeze({
      code: "HOST_OFFLINE",
      message: "Host is not connected",
      retryable: true,
      retryAfterMs: 1_000,
      commandDisposition: "not_accepted",
      details: null,
    }),
  });
  const receipt = Object.freeze(Object.create(null));
  const verifierInputs = [];
  const preflightInputs = [];
  let preflightResult = coreReject;
  let resolveFirstVerifier;
  const owner = new upgradeModule.RelayV2BrokerClientUpgradeDispatchOwner({
    verifyV2AccessToken(token, expectedRole) {
      verifierInputs.push({ token, expectedRole });
      if (verifierInputs.length === 1) {
        return new Promise((resolve) => { resolveFirstVerifier = resolve; });
      }
      return trustedAuth;
    },
    prepareClientWss(input) {
      preflightInputs.push(input);
      return preflightResult;
    },
  });

  const mutableTarget = {
    transportId: "host-producer-before-await",
    generation: "7",
  };
  const pendingRejected = owner.dispatch(metadata(), mutableTarget);
  assert.equal(typeof resolveFirstVerifier, "function");
  mutableTarget.transportId = "host-producer-after-await";
  mutableTarget.generation = "8";
  resolveFirstVerifier(trustedAuth);
  const rejected = await pendingRejected;
  assert.strictEqual(rejected, coreReject);
  assert.deepEqual(Reflect.ownKeys(preflightInputs[0]).sort(), [
    "connectionId",
    "hostProducerTarget",
    "trustedAuthContext",
  ]);
  assert.match(preflightInputs[0].connectionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(preflightInputs[0].hostProducerTarget, {
    transportId: "host-producer-before-await",
    generation: "7",
  });
  assert.equal(Object.isFrozen(preflightInputs[0].hostProducerTarget), true);
  assert.deepEqual(preflightInputs[0].trustedAuthContext, trustedAuth);
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

  preflightResult = Object.freeze({ outcome: "accept", admissionReceipt: receipt });
  const accepted = await owner.dispatch(metadata(), producerTarget);
  assert.deepEqual(verifierInputs, [
    { token: TOKEN, expectedRole: "client" },
    { token: TOKEN, expectedRole: "client" },
  ]);
  assert.notEqual(preflightInputs[1].connectionId, preflightInputs[0].connectionId);
  assert.deepEqual(preflightInputs[1].hostProducerTarget, producerTarget);
  assert.equal(Object.isFrozen(preflightInputs[1].hostProducerTarget), true);
  assert.deepEqual(Reflect.ownKeys(accepted).sort(), [
    "admissionReceipt",
    "outcome",
    "selectedProtocol",
  ]);
  assert.equal(accepted.outcome, "accept");
  assert.equal(accepted.selectedProtocol, "tw-relay.v2");
  assert.strictEqual(accepted.admissionReceipt, receipt);
  assert.equal(JSON.stringify(accepted).includes(TOKEN), false);
  for (const forbidden of [
    "authContext",
    "trustedAuthContext",
    "hostProducerTarget",
    "connectionId",
    "token",
    "broker",
    "core",
  ]) assert.equal(Object.hasOwn(accepted, forbidden), false);
});
