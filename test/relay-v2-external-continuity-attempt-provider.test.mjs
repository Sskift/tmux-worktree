import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const providerModule = await import(
  "../dist/relay/v2/externalContinuityAuthorityNodeAttemptProvider.js"
);
const configModule = await import(
  "../dist/relay/v2/externalContinuityAuthorityConfig.js"
);
const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const ENDPOINT = "https://continuity.example.test/external/continuity/v1";
const SECURITY_DOMAIN = "domain-a";
const NAMESPACE = "broker-credential.v1";
const ANCHOR_ID = "anchor-broker-a";
const CREDENTIAL_REFERENCE = "credential-ref-a";
const TRUST_REFERENCE = "trust-ref-a";
const CA_ROOT_A = "test-only-root-ca-a";
const CA_ROOT_B = "test-only-root-ca-b";
const WORKLOAD_SECRET = "SENTINEL_SECRET_WORKLOAD_TOKEN";
const CLIENT_CERT = "SENTINEL_SECRET_CLIENT_CERT_PEM";
const CLIENT_KEY = "SENTINEL_SECRET_CLIENT_KEY_PEM";
const PROVIDER_FAILURE =
  "Relay v2 external continuity Node attempt provider resolution failed";
const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;

function makeNodeBackend(handler) {
  const state = { calls: [] };
  const httpsRequest = (url, options, callback) => {
    const client = new EventEmitter();
    client.sent = null;
    client.destroyCalls = 0;
    client.end = (body) => {
      client.sent = Buffer.from(body);
      handler({ url, options, callback, client });
    };
    client.destroy = () => { client.destroyCalls += 1; };
    const call = { url, options, callback, client };
    state.calls.push(call);
    return client;
  };
  return { state, httpsRequest };
}

function makeIncoming(bytes) {
  const state = { destroys: 0 };
  const message = {
    statusCode: 200,
    rawHeaders: [
      "Content-Type", "application/json",
      "Cache-Control", "no-store",
      "Content-Length", String(bytes.byteLength),
    ],
    async *[Symbol.asyncIterator]() { yield bytes; },
    destroy() { state.destroys += 1; },
  };
  return { state, message };
}

function makeResolver(overrides = {}) {
  const state = {
    trustCalls: [],
    credentialCalls: [],
    trustDisposes: 0,
    credentialDisposes: 0,
  };
  const resolver = Object.freeze({
    resolveTrust(reference) {
      state.trustCalls.push(reference);
      if (overrides.trustMaterial) return overrides.trustMaterial(state);
      return Object.freeze({
        certificateAuthorities: [CA_ROOT_A, CA_ROOT_B],
        dispose() { state.trustDisposes += 1; },
      });
    },
    resolveCredential(reference, mode) {
      state.credentialCalls.push([reference, mode]);
      if (overrides.credentialMaterial) return overrides.credentialMaterial(state, mode);
      if (mode === "workload_identity") {
        return Object.freeze({
          authenticationHeaders: Object.freeze({
            Authorization: `Bearer ${WORKLOAD_SECRET}`,
          }),
          dispose() { state.credentialDisposes += 1; },
        });
      }
      return Object.freeze({
        clientCertificate: CLIENT_CERT,
        clientKey: CLIENT_KEY,
        dispose() { state.credentialDisposes += 1; },
      });
    },
  });
  return { state, resolver };
}

function makeProvider(resolver, httpsRequest) {
  return providerModule.createRelayV2ExternalContinuityAuthorityNodeAttemptProvider(
    httpsRequest === undefined ? { resolver } : { resolver, httpsRequest },
  );
}

function resolutionRequest(authenticationMode = "mutual_tls") {
  return Object.freeze({
    endpoint: ENDPOINT,
    authenticationMode,
    credentialReference: CREDENTIAL_REFERENCE,
    tlsTrustReference: TRUST_REFERENCE,
  });
}

function attemptRequest(headers = Object.freeze({ "X-Test": "1" })) {
  return Object.freeze({
    endpoint: ENDPOINT,
    method: "POST",
    headers,
    body: Buffer.from("{}"),
  });
}

function uninitialized() {
  return {
    protocolVersion: VERSION,
    status: "uninitialized",
    anchorId: ANCHOR_ID,
    casToken: "cas-0",
  };
}

function checkpoint() {
  return {
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    sequence: "0",
    commitId: "commit-0",
    parentCommitId: null,
    stateDigest: "a".repeat(64),
  };
}

function committed(next) {
  return {
    protocolVersion: VERSION,
    status: "committed",
    anchorId: ANCHOR_ID,
    casToken: "cas-1",
    checkpoint: next,
  };
}

test("every attempt freshly resolves exact references and mutual_tls binds endpoint/trust/auth", async () => {
  const backend = makeNodeBackend(({ callback }) => {
    callback(makeIncoming(Buffer.from("{}")).message);
  });
  const materials = makeResolver();
  const provider = makeProvider(materials.resolver, backend.httpsRequest);

  const first = provider.resolveAttempt(resolutionRequest("mutual_tls"));
  const second = provider.resolveAttempt(resolutionRequest("mutual_tls"));
  assert.deepEqual(materials.state.trustCalls, [TRUST_REFERENCE, TRUST_REFERENCE]);
  assert.deepEqual(materials.state.credentialCalls, [
    [CREDENTIAL_REFERENCE, "mutual_tls"],
    [CREDENTIAL_REFERENCE, "mutual_tls"],
  ]);
  assert.notEqual(first, second);
  assert.notEqual(first.transport, second.transport);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.transport), true);

  // mutual_tls carries no workload authentication headers.
  const emptyHeaders = first.authenticationHeaders();
  assert.deepEqual({ ...emptyHeaders }, {});
  assert.equal(Object.isFrozen(emptyHeaders), true);

  const exchange = first.transport.start(attemptRequest());
  assert.equal(backend.state.calls.length, 1);
  const call = backend.state.calls[0];
  assert.equal(call.url.href, ENDPOINT);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.agent, false);
  assert.equal(call.options.rejectUnauthorized, true);
  assert.equal(typeof call.options.checkServerIdentity, "function");
  assert.deepEqual(call.options.ca, [CA_ROOT_A, CA_ROOT_B]);
  assert.equal(call.options.cert, CLIENT_CERT);
  assert.equal(call.options.key, CLIENT_KEY);
  assert.deepEqual(call.options.headers, { "X-Test": "1" });
  assert.deepEqual(call.client.sent, Buffer.from("{}"));

  const received = await exchange.response;
  assert.equal(received.statusCode, 200);
  assert.equal(materials.state.trustDisposes, 1);
  assert.equal(materials.state.credentialDisposes, 1);

  // The second attempt is independent: its material is still held.
  second.transport.discard();
  assert.equal(materials.state.trustDisposes, 2);
  assert.equal(materials.state.credentialDisposes, 2);
  assert.throws(() => second.transport.discard(), { message: PROVIDER_FAILURE });
  assert.throws(() => second.transport.start(attemptRequest()), {
    message: PROVIDER_FAILURE,
  });
  assert.equal(materials.state.trustDisposes, 2);
  assert.equal(materials.state.credentialDisposes, 2);
});

test("workload_identity binds trust roots and keeps the auth secret inside request headers", async () => {
  const backend = makeNodeBackend(({ callback }) => {
    callback(makeIncoming(Buffer.from("{}")).message);
  });
  const materials = makeResolver();
  const provider = makeProvider(materials.resolver, backend.httpsRequest);
  const attempt = provider.resolveAttempt(resolutionRequest("workload_identity"));
  assert.deepEqual(materials.state.trustCalls, [TRUST_REFERENCE]);
  assert.deepEqual(materials.state.credentialCalls, [
    [CREDENTIAL_REFERENCE, "workload_identity"],
  ]);

  const headers = attempt.authenticationHeaders();
  assert.equal(Object.isFrozen(headers), true);
  assert.equal(headers.Authorization, `Bearer ${WORKLOAD_SECRET}`);

  const exchange = attempt.transport.start(attemptRequest(headers));
  const call = backend.state.calls[0];
  assert.equal(call.url.href, ENDPOINT);
  assert.deepEqual(call.options.ca, [CA_ROOT_A, CA_ROOT_B]);
  assert.equal(Object.hasOwn(call.options, "cert"), false);
  assert.equal(Object.hasOwn(call.options, "key"), false);
  assert.equal(call.options.headers.Authorization, `Bearer ${WORKLOAD_SECRET}`);
  assert.doesNotMatch(call.url.href, /SENTINEL_SECRET/);
  assert.doesNotMatch(String(call.options.method), /SENTINEL_SECRET/);
  await exchange.response;
  assert.equal(materials.state.trustDisposes, 1);
  assert.equal(materials.state.credentialDisposes, 1);
});

test("material is disposed exactly once on discard, start failure, and endpoint mismatch", async () => {
  const backend = makeNodeBackend(({ callback }) => {
    callback(makeIncoming(Buffer.from("{}")).message);
  });

  // Discard before start releases once and poisons the attempt.
  {
    const materials = makeResolver();
    const provider = makeProvider(materials.resolver, backend.httpsRequest);
    const attempt = provider.resolveAttempt(resolutionRequest("mutual_tls"));
    attempt.transport.discard();
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
    assert.equal(backend.state.calls.length, 0);
    assert.throws(() => attempt.transport.start(attemptRequest()), {
      message: PROVIDER_FAILURE,
    });
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
  }

  // A synchronous dial failure rejects the exchange once and poisons the attempt.
  {
    const materials = makeResolver();
    const provider = makeProvider(materials.resolver, () => {
      throw new Error(`dial refused with ${WORKLOAD_SECRET}`);
    });
    const attempt = provider.resolveAttempt(resolutionRequest("mutual_tls"));
    const exchange = attempt.transport.start(attemptRequest());
    await assert.rejects(
      exchange.response,
      (error) => {
        assert.equal(error.message, PROVIDER_FAILURE);
        assert.doesNotMatch(error.message, /SENTINEL_SECRET/);
        return true;
      },
    );
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
    assert.throws(() => attempt.transport.discard(), { message: PROVIDER_FAILURE });
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
  }

  // Any other start endpoint fails closed before transport creation.
  {
    const materials = makeResolver();
    const provider = makeProvider(materials.resolver, backend.httpsRequest);
    const attempt = provider.resolveAttempt(resolutionRequest("workload_identity"));
    assert.throws(
      () => attempt.transport.start(Object.freeze({
        endpoint: "https://other.example.test/external/continuity/v1",
        method: "POST",
        headers: Object.freeze({}),
        body: Buffer.from("{}"),
      })),
      { message: PROVIDER_FAILURE },
    );
    assert.equal(backend.state.calls.length, 0);
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
  }
});

test("exchange failure and abort dispose material once without reflecting secrets", async () => {
  // A rejected response maps to the fixed redacted failure.
  {
    const materials = makeResolver();
    let captured;
    const backend = makeNodeBackend((call) => { captured = call; });
    const provider = makeProvider(materials.resolver, backend.httpsRequest);
    const attempt = provider.resolveAttempt(resolutionRequest("workload_identity"));
    const exchange = attempt.transport.start(
      attemptRequest(attempt.authenticationHeaders()),
    );
    captured.client.emit("error", new Error(`dial ${WORKLOAD_SECRET}`));
    await assert.rejects(
      exchange.response,
      (error) => {
        assert.equal(error.name, "TypeError");
        assert.equal(error.message, PROVIDER_FAILURE);
        assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /SENTINEL_SECRET/);
        return true;
      },
    );
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
    assert.doesNotMatch(captured.url.href, /SENTINEL_SECRET/);
    assert.equal(
      captured.options.headers.Authorization,
      `Bearer ${WORKLOAD_SECRET}`,
      "workload secret is confined to request headers",
    );
  }

  // Abort before settlement releases once; a second abort is inert.
  {
    const materials = makeResolver();
    const backend = makeNodeBackend(() => {});
    const provider = makeProvider(materials.resolver, backend.httpsRequest);
    const attempt = provider.resolveAttempt(resolutionRequest("mutual_tls"));
    const exchange = attempt.transport.start(attemptRequest());
    exchange.abort();
    await assert.rejects(exchange.response, { message: PROVIDER_FAILURE });
    exchange.abort();
    assert.equal(materials.state.trustDisposes, 1);
    assert.equal(materials.state.credentialDisposes, 1);
    assert.equal(backend.state.calls[0].client.destroyCalls, 1);
  }
});

test("resolver faults, hostile shapes, and foreign receivers fail closed without secrets", () => {
  const sentinelError = new Error(`vault says ${WORKLOAD_SECRET}`);

  // A resolver fault is redacted and resolves nothing.
  {
    const provider = makeProvider(Object.freeze({
      resolveTrust() { throw sentinelError; },
      resolveCredential() { throw sentinelError; },
    }));
    assert.throws(
      () => provider.resolveAttempt(resolutionRequest("mutual_tls")),
      (error) => {
        assert.equal(error.message, PROVIDER_FAILURE);
        assert.doesNotMatch(error.message, /SENTINEL_SECRET/);
        return true;
      },
    );
  }

  // Invalid trust material is still disposed once; credential was never handed out.
  {
    const state = { trustDisposes: 0, credentialDisposes: 0 };
    const provider = makeProvider(Object.freeze({
      resolveTrust() {
        return Object.freeze({
          certificateAuthorities: [],
          dispose() { state.trustDisposes += 1; },
        });
      },
      resolveCredential() {
        return Object.freeze({
          clientCertificate: CLIENT_CERT,
          clientKey: CLIENT_KEY,
          dispose() { state.credentialDisposes += 1; },
        });
      },
    }));
    assert.throws(() => provider.resolveAttempt(resolutionRequest("mutual_tls")), {
      message: PROVIDER_FAILURE,
    });
    assert.equal(state.trustDisposes, 1);
    assert.equal(state.credentialDisposes, 0);
  }

  // A proxy workload header record is rejected; both materials are released once.
  {
    const state = { trustDisposes: 0, credentialDisposes: 0 };
    const provider = makeProvider(Object.freeze({
      resolveTrust() {
        return Object.freeze({
          certificateAuthorities: [CA_ROOT_A],
          dispose() { state.trustDisposes += 1; },
        });
      },
      resolveCredential() {
        return Object.freeze({
          authenticationHeaders: new Proxy({ Authorization: "forged" }, {}),
          dispose() { state.credentialDisposes += 1; },
        });
      },
    }));
    assert.throws(() => provider.resolveAttempt(resolutionRequest("workload_identity")), {
      message: PROVIDER_FAILURE,
    });
    assert.equal(state.credentialDisposes, 1);
    assert.equal(state.trustDisposes, 1);
  }

  // A dispose that cannot be captured safely leaves nothing to release.
  {
    const state = { trustDisposes: 0 };
    const trust = { certificateAuthorities: [CA_ROOT_A] };
    Object.defineProperty(trust, "dispose", {
      enumerable: true,
      get() { throw sentinelError; },
    });
    const provider = makeProvider(Object.freeze({
      resolveTrust() { return trust; },
      resolveCredential() { throw new Error("must not resolve credential"); },
    }));
    assert.throws(() => provider.resolveAttempt(resolutionRequest("mutual_tls")), {
      message: PROVIDER_FAILURE,
    });
    assert.equal(state.trustDisposes, 0);
  }

  // Hostile resolution requests and foreign receivers resolve nothing.
  {
    const materials = makeResolver();
    const provider = makeProvider(materials.resolver);
    const extraKey = Object.freeze({
      ...resolutionRequest("mutual_tls"),
      future: true,
    });
    const unfrozen = {
      endpoint: ENDPOINT,
      authenticationMode: "mutual_tls",
      credentialReference: CREDENTIAL_REFERENCE,
      tlsTrustReference: TRUST_REFERENCE,
    };
    const proxied = new Proxy(resolutionRequest("mutual_tls"), {});
    for (const bad of [extraKey, unfrozen, proxied, null, ENDPOINT]) {
      assert.throws(() => provider.resolveAttempt(bad), { message: PROVIDER_FAILURE });
    }
    assert.throws(
      () => Reflect.apply(
        provider.resolveAttempt,
        Object.create(null),
        [resolutionRequest("mutual_tls")],
      ),
      { message: PROVIDER_FAILURE },
    );
    assert.throws(
      () => Reflect.apply(
        provider.resolveAttempt,
        provider,
        [resolutionRequest("mutual_tls"), Object.freeze({})],
      ),
      { message: PROVIDER_FAILURE },
    );
    assert.equal(materials.state.trustCalls.length, 0);
    assert.equal(materials.state.credentialCalls.length, 0);
  }

  // Proxy or unfrozen resolvers are rejected at construction.
  {
    const materials = makeResolver();
    assert.throws(() => makeProvider(new Proxy(materials.resolver, {})), {
      message: PROVIDER_FAILURE,
    });
    assert.throws(
      () => makeProvider({ resolveTrust() {}, resolveCredential() {} }),
      { message: PROVIDER_FAILURE },
    );
  }
});

test("captured TLS material is copied at resolve time and later mutation is inert", async () => {
  const caBytes = Buffer.from("ca-root-a", "utf8");
  const keyBytes = Buffer.from("client-key-a", "utf8");
  const materials = makeResolver({
    trustMaterial: (state) => Object.freeze({
      certificateAuthorities: [caBytes],
      dispose() { state.trustDisposes += 1; },
    }),
    credentialMaterial: (state) => Object.freeze({
      clientCertificate: "client-cert-a",
      clientKey: keyBytes,
      dispose() { state.credentialDisposes += 1; },
    }),
  });
  const backend = makeNodeBackend(({ callback }) => {
    callback(makeIncoming(Buffer.from("{}")).message);
  });
  const provider = makeProvider(materials.resolver, backend.httpsRequest);
  const attempt = provider.resolveAttempt(resolutionRequest("mutual_tls"));
  caBytes.fill(0x58);
  keyBytes.fill(0x59);
  const exchange = attempt.transport.start(attemptRequest());
  const call = backend.state.calls[0];
  assert.deepEqual(Buffer.from(call.options.ca[0]), Buffer.from("ca-root-a", "utf8"));
  assert.deepEqual(Buffer.from(call.options.key), Buffer.from("client-key-a", "utf8"));
  await exchange.response;
  assert.equal(materials.state.trustDisposes, 1);
  assert.equal(materials.state.credentialDisposes, 1);
});

test("bound authority performs read and CAS through the provider with fresh per-attempt resolution", async () => {
  const backend = makeNodeBackend(({ callback, client }) => {
    const wire = JSON.parse(client.sent.toString("utf8"));
    const result = wire.operation === "read"
      ? uninitialized()
      : { protocolVersion: 1, outcome: "swapped", current: committed(wire.payload.next) };
    const bytes = Buffer.from(JSON.stringify({
      contractVersion: 1,
      operationId: wire.operationId,
      ok: true,
      result,
      error: null,
    }), "utf8");
    callback(makeIncoming(bytes).message);
  });
  const materials = makeResolver();
  const provider = makeProvider(materials.resolver, backend.httpsRequest);
  const binding = configModule.bindRelayV2ExternalContinuityAuthorityConfig({
    configVersion: 1,
    endpoint: ENDPOINT,
    securityDomainId: SECURITY_DOMAIN,
    authenticationMode: "workload_identity",
    credentialReference: CREDENTIAL_REFERENCE,
    tlsTrustReference: TRUST_REFERENCE,
    operationTimeoutMs: 250,
    maxPendingOperations: 4,
    namespaceBindings: [
      { namespace: NAMESPACE, ownerBinding: "broker-owner-a", anchorId: ANCHOR_ID },
    ],
  }, provider);
  assert.equal(materials.state.trustCalls.length, 0, "binding stays inert");

  const authority = binding.namespaceBindings[0].continuityAnchorOptions.authority;
  const readResult = await authority.read({
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    signal: new AbortController().signal,
  });
  assert.equal(JSON.stringify(readResult), JSON.stringify(uninitialized()));

  const casResult = await authority.compareAndSwap({
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    expected: uninitialized(),
    next: checkpoint(),
    signal: new AbortController().signal,
  });
  assert.equal(
    JSON.stringify(casResult),
    JSON.stringify({
      protocolVersion: 1,
      outcome: "swapped",
      current: committed(checkpoint()),
    }),
  );

  assert.equal(materials.state.trustCalls.length, 2);
  assert.equal(materials.state.credentialCalls.length, 2);
  assert.equal(materials.state.trustDisposes, 2);
  assert.equal(materials.state.credentialDisposes, 2);
  assert.equal(backend.state.calls.length, 2);
  for (const call of backend.state.calls) {
    assert.equal(call.url.href, ENDPOINT);
    assert.equal(call.options.headers.Authorization, `Bearer ${WORKLOAD_SECRET}`);
    assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(typeof call.options.checkServerIdentity, "function");
  }
});

test("dispose is bound to the original material object and runs exactly once", async () => {
  const backend = makeNodeBackend(({ callback }) => {
    callback(makeIncoming(Buffer.from("{}")).message);
  });
  const disposeCalls = new Map();
  const track = (self) => disposeCalls.set(self, (disposeCalls.get(self) ?? 0) + 1);

  // Discard before start.
  {
    const originalTrust = {
      certificateAuthorities: [CA_ROOT_A],
      dispose() { track(this); },
    };
    const originalCredential = {
      clientCertificate: CLIENT_CERT,
      clientKey: CLIENT_KEY,
      dispose() { track(this); },
    };
    const materials = makeResolver({
      trustMaterial: () => originalTrust,
      credentialMaterial: () => originalCredential,
    });
    const provider = makeProvider(materials.resolver, backend.httpsRequest);
    const attempt = provider.resolveAttempt(resolutionRequest("mutual_tls"));
    attempt.transport.discard();
    assert.equal(disposeCalls.get(originalTrust), 1);
    assert.equal(disposeCalls.get(originalCredential), 1);
  }

  // Exchange settlement.
  {
    const originalTrust = {
      certificateAuthorities: [CA_ROOT_A],
      dispose() { track(this); },
    };
    const originalCredential = {
      authenticationHeaders: Object.freeze({ Authorization: `Bearer ${WORKLOAD_SECRET}` }),
      dispose() { track(this); },
    };
    const materials = makeResolver({
      trustMaterial: () => originalTrust,
      credentialMaterial: () => originalCredential,
    });
    const provider = makeProvider(materials.resolver, backend.httpsRequest);
    const attempt = provider.resolveAttempt(resolutionRequest("workload_identity"));
    const exchange = attempt.transport.start(
      attemptRequest(attempt.authenticationHeaders()),
    );
    await exchange.response;
    assert.equal(disposeCalls.get(originalTrust), 1);
    assert.equal(disposeCalls.get(originalCredential), 1);
  }
});

test("invalid-after-acquire material is released once on the original object", () => {
  const disposeCalls = new Map();
  const track = (self) => disposeCalls.set(self, (disposeCalls.get(self) ?? 0) + 1);
  const runCase = ({ trust, credential, mode, expectTrust, expectCredential }) => {
    const originalTrust = trust === undefined
      ? undefined
      : { ...trust, dispose() { track(this); } };
    const originalCredential = credential === undefined
      ? undefined
      : { ...credential, dispose() { track(this); } };
    const materials = makeResolver({
      trustMaterial: () => originalTrust,
      credentialMaterial: () => originalCredential,
    });
    const provider = makeProvider(materials.resolver);
    assert.throws(
      () => provider.resolveAttempt(resolutionRequest(mode)),
      { message: PROVIDER_FAILURE },
    );
    assert.equal(disposeCalls.get(originalTrust) ?? 0, expectTrust);
    assert.equal(disposeCalls.get(originalCredential) ?? 0, expectCredential);
  };

  // Invalid CA entry type: trust was acquired, credential is never resolved.
  runCase({
    trust: { certificateAuthorities: [123] },
    credential: { clientCertificate: CLIENT_CERT, clientKey: CLIENT_KEY },
    mode: "mutual_tls",
    expectTrust: 1,
    expectCredential: 0,
  });
  // Non-string workload header value: both acquired materials are released once.
  runCase({
    trust: { certificateAuthorities: [CA_ROOT_A] },
    credential: { authenticationHeaders: { Authorization: 42 } },
    mode: "workload_identity",
    expectTrust: 1,
    expectCredential: 1,
  });
  // Extra own key on the credential material: released once.
  runCase({
    trust: { certificateAuthorities: [CA_ROOT_A] },
    credential: {
      clientCertificate: CLIENT_CERT,
      clientKey: CLIENT_KEY,
      future: true,
    },
    mode: "mutual_tls",
    expectTrust: 1,
    expectCredential: 1,
  });

  // Accessor CA with a capturable dispose: still released once on the original.
  {
    const originalTrust = { dispose() { track(this); } };
    Object.defineProperty(originalTrust, "certificateAuthorities", {
      enumerable: true,
      get() { throw new Error(`accessor ${WORKLOAD_SECRET}`); },
    });
    const materials = makeResolver({
      trustMaterial: () => originalTrust,
      credentialMaterial: () => ({
        clientCertificate: CLIENT_CERT,
        clientKey: CLIENT_KEY,
        dispose() { track(this); },
      }),
    });
    const provider = makeProvider(materials.resolver);
    assert.throws(
      () => provider.resolveAttempt(resolutionRequest("mutual_tls")),
      (error) => {
        assert.equal(error.message, PROVIDER_FAILURE);
        assert.doesNotMatch(error.message, /SENTINEL_SECRET/);
        return true;
      },
    );
    assert.equal(disposeCalls.get(originalTrust), 1);
  }
});

test("over-limit resolver output fails redacted after exactly one release", () => {
  const cases = [
    {
      name: "ca entry count",
      mode: "mutual_tls",
      trust: { certificateAuthorities: Array.from({ length: 9 }, () => CA_ROOT_A) },
      credential: { clientCertificate: CLIENT_CERT, clientKey: CLIENT_KEY },
      trustReleased: 1,
      credentialReleased: 0,
    },
    {
      name: "ca entry bytes",
      mode: "mutual_tls",
      trust: { certificateAuthorities: ["A".repeat(16_385)] },
      credential: { clientCertificate: CLIENT_CERT, clientKey: CLIENT_KEY },
      trustReleased: 1,
      credentialReleased: 0,
    },
    {
      name: "ca total bytes",
      mode: "mutual_tls",
      trust: {
        certificateAuthorities: [
          "A".repeat(16_384),
          "B".repeat(16_384),
          "C".repeat(16_384),
        ],
      },
      credential: { clientCertificate: CLIENT_CERT, clientKey: CLIENT_KEY },
      trustReleased: 1,
      credentialReleased: 0,
    },
    {
      name: "header count",
      mode: "workload_identity",
      trust: { certificateAuthorities: [CA_ROOT_A] },
      credential: {
        authenticationHeaders: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`X-Header-${index}`, "v"]),
        ),
      },
      trustReleased: 1,
      credentialReleased: 1,
    },
    {
      name: "header name bytes",
      mode: "workload_identity",
      trust: { certificateAuthorities: [CA_ROOT_A] },
      credential: { authenticationHeaders: { ["X".repeat(129)]: "v" } },
      trustReleased: 1,
      credentialReleased: 1,
    },
    {
      name: "header value bytes",
      mode: "workload_identity",
      trust: { certificateAuthorities: [CA_ROOT_A] },
      credential: {
        authenticationHeaders: { Authorization: WORKLOAD_SECRET.repeat(300) },
      },
      trustReleased: 1,
      credentialReleased: 1,
    },
    {
      name: "client certificate bytes",
      mode: "mutual_tls",
      trust: { certificateAuthorities: [CA_ROOT_A] },
      credential: {
        clientCertificate: CLIENT_CERT.repeat(600),
        clientKey: CLIENT_KEY,
      },
      trustReleased: 1,
      credentialReleased: 1,
    },
    {
      name: "client key bytes",
      mode: "mutual_tls",
      trust: { certificateAuthorities: [CA_ROOT_A] },
      credential: {
        clientCertificate: CLIENT_CERT,
        clientKey: CLIENT_KEY.repeat(600),
      },
      trustReleased: 1,
      credentialReleased: 1,
    },
  ];
  for (const selected of cases) {
    const disposeCalls = new Map();
    const track = (self) => disposeCalls.set(self, (disposeCalls.get(self) ?? 0) + 1);
    const originalTrust = { ...selected.trust, dispose() { track(this); } };
    const originalCredential = { ...selected.credential, dispose() { track(this); } };
    const materials = makeResolver({
      trustMaterial: () => originalTrust,
      credentialMaterial: () => originalCredential,
    });
    const provider = makeProvider(materials.resolver);
    assert.throws(
      () => provider.resolveAttempt(resolutionRequest(selected.mode)),
      (error) => {
        assert.equal(error.message, PROVIDER_FAILURE);
        assert.doesNotMatch(error.message, /SENTINEL_SECRET/);
        return true;
      },
      selected.name,
    );
    assert.equal(
      disposeCalls.get(originalTrust) ?? 0,
      selected.trustReleased,
      selected.name,
    );
    assert.equal(
      disposeCalls.get(originalCredential) ?? 0,
      selected.credentialReleased,
      selected.name,
    );
  }
});
