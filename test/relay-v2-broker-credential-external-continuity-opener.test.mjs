import assert from "node:assert/strict";
import test from "node:test";

const openerModule = await import(
  "../dist/relay/v2/brokerCredentialExternalContinuityOpener.js"
);
const broker = await import("../dist/relay/v2/brokerCore.js");
const credential = await import("../dist/relay/v2/brokerCredentialAuthority.js");
const issuer = await import("../dist/relay/v2/issuer.js");

const ENDPOINT = "https://continuity.example.test/external/continuity/v1";
const TRUSTED_HOME = "/test/account-home";
const BROKER_NAMESPACE = "broker-credential.v1";
const AGENT_NAMESPACE = "agent-transcript-lifecycle.v1";
const BROKER_ANCHOR = "broker-credential-anchor";
const AGENT_ANCHOR = "agent-transcript-anchor";
const CREDENTIAL_REFERENCE = "credential-reference-a";
const TRUST_REFERENCE = "trust-reference-a";
const AUTHORIZATION = "Bearer test-only-workload-token";
const TEST_SECRET = Buffer.alloc(32, 17).toString("base64url");

function copy(value) {
  return structuredClone(value);
}

class NarrowNativeStore {
  #bytes;
  #revision = 0;
  #revisionOwners = new WeakMap();

  constructor(initialBytes = null) {
    this.#bytes = initialBytes === null ? null : Uint8Array.from(initialBytes);
    this.closeCalls = 0;
    this.runExclusiveCalls = 0;
  }

  async runExclusive(operation) {
    this.runExclusiveCalls += 1;
    const transactionIdentity = Object.freeze({});
    const readCurrent = () => {
      const revision = Object.freeze({});
      this.#revisionOwners.set(revision, {
        transactionIdentity,
        revision: this.#revision,
      });
      return this.#bytes === null
        ? { outcome: "missing", revision }
        : { outcome: "present", revision, bytes: Uint8Array.from(this.#bytes) };
    };
    const transaction = Object.freeze({
      read: async () => readCurrent(),
      compareAndPublish: async (expected, next) => {
        const owner = this.#revisionOwners.get(expected);
        if (!owner || owner.transactionIdentity !== transactionIdentity) {
          throw new Error("foreign fake revision");
        }
        if (owner.revision !== this.#revision) {
          return { outcome: "conflict", current: readCurrent() };
        }
        this.#bytes = Uint8Array.from(next);
        this.#revision += 1;
        return { outcome: "swapped", current: readCurrent() };
      },
    });
    return operation(transaction);
  }

  async close() {
    this.closeCalls += 1;
  }
}

function validGenesis() {
  return {
    issuerKeyring: issuer.createRelayV2IssuerKeyring({
      issuerId: "external-opener-issuer",
      kid: "external-opener-kid",
      secretBase64url: TEST_SECRET,
      nowSeconds: Math.floor(Date.now() / 1_000),
    }),
    issuerUrl: "https://relay.example.test/",
    relayUrl: "wss://relay.example.test/client",
  };
}

function config(namespaceBindings = [
  { namespace: AGENT_NAMESPACE, ownerBinding: "agent-owner", anchorId: AGENT_ANCHOR },
  { namespace: BROKER_NAMESPACE, ownerBinding: "broker-owner", anchorId: BROKER_ANCHOR },
]) {
  return {
    configVersion: 1,
    endpoint: ENDPOINT,
    securityDomainId: "security-domain-a",
    authenticationMode: "workload_identity",
    credentialReference: CREDENTIAL_REFERENCE,
    tlsTrustReference: TRUST_REFERENCE,
    operationTimeoutMs: 250,
    maxPendingOperations: 2,
    namespaceBindings,
  };
}

function nativeLoader(resultFactory, events = []) {
  const state = { capabilityCalls: 0, openCalls: 0, trustedHomes: [] };
  const loader = Object.freeze({
    capability() {
      state.capabilityCalls += 1;
      throw new Error("the opener must not probe a second capability cut");
    },
    async open(trustedHome) {
      state.openCalls += 1;
      state.trustedHomes.push(trustedHome);
      events.push("native.open");
      return resultFactory();
    },
  });
  return { loader, state };
}

function responseEnvelope(wire, result) {
  const body = Buffer.from(JSON.stringify({
    contractVersion: 1,
    operationId: wire.operationId,
    ok: true,
    result,
    error: null,
  }), "utf8");
  return {
    statusCode: 200,
    headers: [
      ["Content-Type", "application/json"],
      ["Cache-Control", "no-store"],
      ["Content-Length", String(body.byteLength)],
    ],
    body: {
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    },
    destroy() {},
  };
}

function backend(mode = "success", events = []) {
  const state = {
    resolveCalls: 0,
    authCalls: 0,
    startCalls: 0,
    discardCalls: 0,
    resolutionRequests: [],
    wires: [],
    current: {
      protocolVersion: 1,
      status: "uninitialized",
      anchorId: BROKER_ANCHOR,
      casToken: "cas-0",
    },
  };
  let casGeneration = 0;
  const provider = Object.freeze({
    resolveAttempt(request) {
      state.resolveCalls += 1;
      state.resolutionRequests.push(copy(request));
      events.push("provider.resolve");
      const transport = Object.freeze({
        start(request) {
          state.startCalls += 1;
          const wire = JSON.parse(Buffer.from(request.body).toString("utf8"));
          state.wires.push(wire);
          events.push(`transport.start:${wire.namespace}:${wire.operation}`);
          if (mode === "start") throw new Error("injected start fault");
          if ((mode === "read" && wire.operation === "read")
            || (mode === "cas" && wire.operation === "compare_and_swap")) {
            return {
              response: Promise.reject(new Error("injected external fault")),
              abort() {},
            };
          }
          let result;
          if (wire.operation === "read") {
            result = copy(state.current);
          } else {
            casGeneration += 1;
            state.current = {
              protocolVersion: 1,
              status: "committed",
              anchorId: BROKER_ANCHOR,
              casToken: `cas-${casGeneration}`,
              checkpoint: copy(wire.payload.next),
            };
            result = {
              protocolVersion: 1,
              outcome: "swapped",
              current: copy(state.current),
            };
          }
          return {
            response: Promise.resolve(responseEnvelope(wire, result)),
            abort() {},
          };
        },
        discard() {
          state.discardCalls += 1;
        },
      });
      return Object.freeze({
        authenticationHeaders() {
          state.authCalls += 1;
          events.push("auth.resolve");
          if (mode === "auth") throw new Error("injected auth fault");
          return Object.freeze({ Authorization: AUTHORIZATION });
        },
        transport,
      });
    },
  });
  return { provider, state };
}

function createOpener({
  loader,
  provider,
  externalConfig = config(),
  genesis = validGenesis(),
}) {
  return openerModule.createRelayV2BrokerCredentialExternalContinuityOpener({
    trustedHome: TRUSTED_HOME,
    nativeLoader: loader,
    externalContinuityConfig: externalConfig,
    externalContinuityAttemptProvider: provider,
    genesis,
  });
}

function input(liveAuthorizationFence) {
  return Object.freeze({ liveAuthorizationFence });
}

function openerFailure(error) {
  return error instanceof Error
    && error.message === "Relay v2 broker credential external continuity activation failed";
}

function authorityFailure(code) {
  return (error) => credential.isRelayV2BrokerCredentialAuthorityError(error)
    && error.code === code;
}

test("happy activation stays inert until one exact open and transfers the Broker store once", async () => {
  const events = [];
  const store = new NarrowNativeStore();
  const opened = nativeLoader(
    () => Object.freeze({ status: "opened", selfCheck: "passed", store }),
    events,
  );
  const external = backend("success", events);
  const core = new broker.RelayV2BrokerCore();
  const exactFence = core.liveAuthorizationFencePort;
  const opener = createOpener({ loader: opened.loader, provider: external.provider });

  assert.deepEqual(events, [], "construction is inert");
  assert.equal(Object.isFrozen(opener), true);
  assert.equal(Object.hasOwn(opener, "ready"), false);
  assert.strictEqual(core.liveAuthorizationFencePort, exactFence);
  assert.equal(core.inspectLiveAuthCompositionLatch(), "open");
  assert.deepEqual(
    core.recheckConnectionAccessExpiry("client", "missing", "missing"),
    { outcome: "stale" },
  );

  const authority = await opener(input(exactFence));
  assert.equal(authority instanceof credential.RelayV2BrokerCredentialAuthority, true);
  assert.equal(authority.authorityContinuityReadiness.status, "ready");
  assert.deepEqual(opened.state.trustedHomes, [TRUSTED_HOME]);
  assert.equal(opened.state.capabilityCalls, 0);
  assert.ok(events.indexOf("native.open") < events.indexOf("provider.resolve"));
  assert.deepEqual(external.state.wires.map((wire) => wire.namespace), [
    BROKER_NAMESPACE,
    BROKER_NAMESPACE,
  ]);
  assert.deepEqual(external.state.wires.map((wire) => wire.anchorId), [
    BROKER_ANCHOR,
    BROKER_ANCHOR,
  ]);
  assert.deepEqual(external.state.resolutionRequests, [
    {
      endpoint: ENDPOINT,
      authenticationMode: "workload_identity",
      credentialReference: CREDENTIAL_REFERENCE,
      tlsTrustReference: TRUST_REFERENCE,
    },
    {
      endpoint: ENDPOINT,
      authenticationMode: "workload_identity",
      credentialReference: CREDENTIAL_REFERENCE,
      tlsTrustReference: TRUST_REFERENCE,
    },
  ]);
  assert.equal(external.state.wires.some((wire) => wire.namespace === AGENT_NAMESPACE), false);
  assert.equal(external.state.wires.some((wire) => Object.hasOwn(wire, "ownerBinding")), false);
  assert.equal(store.closeCalls, 0, "the opener no longer owns a successful store");
  assert.equal(core.inspectLiveAuthCompositionLatch(), "open");

  await authority.close();
  assert.equal(store.closeCalls, 1);
  assert.equal(core.inspectLiveAuthCompositionLatch(), "latched_fail_closed");
  assert.deepEqual(
    core.recheckConnectionAccessExpiry("client", "missing", "missing"),
    { outcome: "fail_closed" },
  );

  const foreignCore = new broker.RelayV2BrokerCore();
  await assert.rejects(opener(input(foreignCore.liveAuthorizationFencePort)), openerFailure);
  await assert.rejects(
    Reflect.apply(opener, Object.freeze({}), [input(foreignCore.liveAuthorizationFencePort)]),
    openerFailure,
  );
  assert.equal(foreignCore.inspectLiveAuthCompositionLatch(), "open");
  assert.deepEqual(
    foreignCore.recheckConnectionAccessExpiry("client", "missing", "missing"),
    { outcome: "stale" },
  );
  assert.equal(opened.state.openCalls, 1);
  assert.equal(external.state.resolveCalls, 2);
  assert.equal(store.closeCalls, 1);
});

test("pre-transfer invalid open and binding shapes close only acquired stores and never resolve a provider", async () => {
  const cases = [
    {
      name: "invalid native open result",
      make() {
        const store = new NarrowNativeStore();
        return {
          store,
          expectedCloseCalls: 1,
          externalConfig: config(),
          provider: backend().provider,
          openResult: Object.freeze({ status: "opened", selfCheck: "failed", store }),
        };
      },
    },
    {
      name: "missing Broker binding",
      make() {
        const store = new NarrowNativeStore();
        return {
          store,
          expectedCloseCalls: 1,
          externalConfig: config([
            { namespace: AGENT_NAMESPACE, ownerBinding: "agent-owner", anchorId: AGENT_ANCHOR },
          ]),
          provider: backend().provider,
          openResult: Object.freeze({ status: "opened", selfCheck: "passed", store }),
        };
      },
    },
    {
      name: "invalid binder provider shape",
      make() {
        const store = new NarrowNativeStore();
        return {
          store,
          expectedCloseCalls: 1,
          externalConfig: config(),
          provider: Object.freeze({ resolveAttempt: "not-callable" }),
          openResult: Object.freeze({ status: "opened", selfCheck: "passed", store }),
        };
      },
    },
  ];

  for (const selected of cases) {
    const item = selected.make();
    const events = [];
    const opened = nativeLoader(() => item.openResult, events);
    const providerStarts = { resolveCalls: 0, startCalls: 0 };
    const provider = typeof item.provider.resolveAttempt === "function"
      ? Object.freeze({
          resolveAttempt(request) {
            providerStarts.resolveCalls += 1;
            const resolved = item.provider.resolveAttempt(request);
            return Object.freeze({
              authenticationHeaders: resolved.authenticationHeaders,
              transport: Object.freeze({
                start(transportRequest) {
                  providerStarts.startCalls += 1;
                  return resolved.transport.start(transportRequest);
                },
                discard() { return resolved.transport.discard(); },
              }),
            });
          },
        })
      : item.provider;
    const opener = createOpener({
      loader: opened.loader,
      provider,
      externalConfig: item.externalConfig,
    });
    const core = new broker.RelayV2BrokerCore();
    const exactFence = core.liveAuthorizationFencePort;
    assert.strictEqual(core.liveAuthorizationFencePort, exactFence);
    await assert.rejects(opener(input(exactFence)), openerFailure, selected.name);
    assert.equal(providerStarts.resolveCalls, 0, `${selected.name}: provider remains inert`);
    assert.equal(providerStarts.startCalls, 0, `${selected.name}: transport remains inert`);
    assert.equal(item.store.closeCalls, item.expectedCloseCalls, selected.name);
    assert.equal(core.inspectLiveAuthCompositionLatch(), "open", selected.name);
    assert.deepEqual(
      core.recheckConnectionAccessExpiry("client", "missing", "missing"),
      { outcome: "stale" },
      selected.name,
    );
    const foreignCore = new broker.RelayV2BrokerCore();
    await assert.rejects(
      opener(input(foreignCore.liveAuthorizationFencePort)),
      openerFailure,
      selected.name,
    );
    assert.equal(foreignCore.inspectLiveAuthCompositionLatch(), "open", selected.name);
    assert.equal(opened.state.openCalls, 1, `${selected.name}: no retry or fallback`);
    assert.equal(item.store.closeCalls, item.expectedCloseCalls, selected.name);
  }
});

test("post-transfer authority faults retain owner mappings and close without opener retry or publication", async () => {
  const cases = [
    { name: "external read", mode: "read", expected: "EXTERNAL_CONTINUITY_UNAVAILABLE" },
    { name: "external CAS", mode: "cas", expected: "EXTERNAL_ANCHOR_UNCERTAIN" },
    { name: "authentication", mode: "auth", expected: "EXTERNAL_CONTINUITY_UNAVAILABLE" },
    { name: "transport start", mode: "start", expected: "EXTERNAL_CONTINUITY_UNAVAILABLE" },
    { name: "authority open rejection", mode: "success", expected: "STATE_INVALID" },
  ];

  for (const selected of cases) {
    const events = [];
    const store = new NarrowNativeStore(
      selected.name === "authority open rejection" ? Buffer.from("{") : null,
    );
    const opened = nativeLoader(
      () => Object.freeze({ status: "opened", selfCheck: "passed", store }),
      events,
    );
    const external = backend(selected.mode, events);
    const opener = createOpener({
      loader: opened.loader,
      provider: external.provider,
    });
    const core = new broker.RelayV2BrokerCore();
    const exactFence = core.liveAuthorizationFencePort;
    assert.strictEqual(core.liveAuthorizationFencePort, exactFence);
    assert.equal(core.inspectLiveAuthCompositionLatch(), "open", selected.name);
    let published;
    await assert.rejects(
      opener(input(exactFence)).then((authority) => { published = authority; }),
      authorityFailure(selected.expected),
      selected.name,
    );
    assert.equal(published, undefined, `${selected.name}: no authority handle is published`);
    assert.equal(Object.hasOwn(opener, "ready"), false);
    assert.equal(store.closeCalls, 1, `${selected.name}: authority owns the only close`);
    assert.equal(core.inspectLiveAuthCompositionLatch(), "latched_fail_closed", selected.name);
    assert.deepEqual(
      core.recheckConnectionAccessExpiry("client", "missing", "missing"),
      { outcome: "fail_closed" },
      selected.name,
    );
    const foreignCore = new broker.RelayV2BrokerCore();
    await assert.rejects(
      opener(input(foreignCore.liveAuthorizationFencePort)),
      openerFailure,
      selected.name,
    );
    assert.equal(foreignCore.inspectLiveAuthCompositionLatch(), "open", selected.name);
    assert.equal(opened.state.openCalls, 1, `${selected.name}: opener is terminal`);
    assert.equal(store.closeCalls, 1, `${selected.name}: opener never double-closes`);
  }
});
