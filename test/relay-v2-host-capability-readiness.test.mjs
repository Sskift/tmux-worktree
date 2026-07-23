import assert from "node:assert/strict";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const readinessModule = await import("../dist/relay/v2/hostCapabilityReadiness.js");
const runtimeModule = await import("../dist/relay/v2/hostRuntime.js");

const EXPECTED_SOURCES = Object.freeze([
  "codec",
  "carrier",
  "h0",
  "h1",
  "h2",
  "h3",
]);
const CAPABILITIES = broker.RELAY_V2_REQUIRED_CAPABILITIES;

function sourceSnapshot(source, generation, ready, extensions = {}) {
  return { source, generation, ready, ...extensions };
}

function assertExactIntersection(snapshot, ready) {
  assert.equal(typeof snapshot.generation, "string");
  assert.deepEqual(Object.keys(snapshot.capabilities), [...CAPABILITIES]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(snapshot.capabilities)),
    Object.fromEntries(CAPABILITIES.map((capability) => [capability, ready])),
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.capabilities), true);
}

function createOwner(options) {
  const owner = new readinessModule.RelayV2HostCapabilityReadiness(options);
  const sources = Object.fromEntries(
    EXPECTED_SOURCES.map((source) => [source, owner.source(source)]),
  );
  return { owner, sources };
}

function makeReady() {
  const harness = createOwner();
  for (const source of EXPECTED_SOURCES) {
    assert.equal(harness.sources[source].apply(sourceSnapshot(source, "1", true)), true);
  }
  assertExactIntersection(harness.owner.current(), true);
  return harness;
}

function makePreCarrierReady() {
  const harness = createOwner();
  for (const source of EXPECTED_SOURCES.filter((candidate) => candidate !== "carrier")) {
    assert.equal(harness.sources[source].apply(sourceSnapshot(source, "1", true)), true);
  }
  assertExactIntersection(harness.owner.current(), false);
  return harness;
}

function routeBinding(overrides = {}) {
  return Object.freeze({
    connectorGeneration: 1,
    connectorId: "readiness-connector",
    routeId: "readiness-route",
    routeFence: "readiness-fence",
    connectionId: "readiness-connection",
    clientDialect: "tw-relay.v2",
    maxFrameBytes: 1_048_576,
    authContext: Object.freeze({
      scheme: "twcap2",
      role: "client",
      hostId: "mac-admin",
      principalId: "readiness-principal",
      grantId: "readiness-grant",
      clientInstanceId: "readiness-client",
      jti: "readiness-jti",
      kid: "readiness-kid",
      expiresAtMs: 1_783_703_600_000,
      ...(overrides.authContext ?? {}),
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "authContext")),
  });
}

test("the readiness source contract is the exact stable six-source tuple", () => {
  assert.deepEqual(
    [...readinessModule.RELAY_V2_HOST_CAPABILITY_READINESS_SOURCES],
    [...EXPECTED_SOURCES],
  );
});

test("six typed sources default false and publish only the atomic frozen base set", () => {
  const { owner, sources } = createOwner();
  const observed = [];
  const subscription = owner.subscribe({
    apply(snapshot) {
      observed.push(snapshot);
      return true;
    },
    close() { assert.fail("a valid bounded subscriber must remain open"); },
  });

  assert.equal(owner.current().generation, "0");
  assertExactIntersection(owner.current(), false);
  assert.equal(observed.length, 1, "subscribe must synchronously publish current disabled state");

  for (const source of EXPECTED_SOURCES.slice(0, -1)) {
    assert.equal(sources[source].apply(sourceSnapshot(source, "1", true)), true);
    assertExactIntersection(owner.current(), false);
    assertExactIntersection(observed.at(-1), false);
  }
  const finalSource = EXPECTED_SOURCES.at(-1);
  assert.equal(sources[finalSource].apply(sourceSnapshot(finalSource, "1", true)), true);
  assertExactIntersection(owner.current(), true);
  assertExactIntersection(observed.at(-1), true);
  assert.equal(observed.length, EXPECTED_SOURCES.length + 1);

  const beforeDuplicate = observed.length;
  assert.equal(sources.codec.apply(sourceSnapshot("codec", "1", true)), true);
  assert.equal(observed.length, beforeDuplicate, "an exact source replay is idempotent");
  subscription.unsubscribe();
  assert.equal(sources.codec.apply(sourceSnapshot("codec", "2", true)), true);
  assert.equal(observed.length, beforeDuplicate, "unsubscribe must release the bounded slot");
});

test("pre-carrier offers are opaque one-shot exact bindings and stale cuts require a new offer", () => {
  const { owner, sources } = makePreCarrierReady();
  const bindings = [];
  const fenced = [];
  const fence = Object.freeze({
    bind(binding) {
      bindings.push(binding);
      return true;
    },
    fence(binding) {
      fenced.push(binding);
    },
  });
  const first = owner.issuePreCarrierOffer(Object.freeze({
    controllerGeneration: "7",
    carrierAttemptGeneration: "11",
    fence,
  }));
  assert.notEqual(first, null);
  assert.deepEqual(Reflect.ownKeys(first), []);
  assert.equal(bindings.length, 1);
  assert.equal(Object.isFrozen(bindings[0]), true);
  assert.equal(readinessModule.matchesRelayV2HostPreCarrierOfferClaim(first, {
    controllerGeneration: "7",
    carrierAttemptGeneration: "11",
  }), true);
  assert.equal(readinessModule.matchesRelayV2HostPreCarrierOfferClaim(first, {
    controllerGeneration: "7",
    carrierAttemptGeneration: "12",
  }), false);
  const advertised = readinessModule.consumeRelayV2HostPreCarrierOfferClaim(first);
  assert.deepEqual(advertised, [...CAPABILITIES]);
  assert.equal(Object.isFrozen(advertised), true);
  assert.equal(readinessModule.consumeRelayV2HostPreCarrierOfferClaim(first), null);

  const stale = owner.issuePreCarrierOffer(Object.freeze({
    controllerGeneration: "8",
    carrierAttemptGeneration: "12",
    fence,
  }));
  assert.notEqual(stale, null);
  const staleGeneration = BigInt(bindings.at(-1).offerGeneration);
  sources.h2.close();
  assert.deepEqual(fenced.at(-1), bindings.at(-1));
  assert.equal(readinessModule.consumeRelayV2HostPreCarrierOfferClaim(stale), null);
  assert.equal(sources.h2.apply(sourceSnapshot("h2", "1", true)), false);
  assert.equal(owner.issuePreCarrierOffer(Object.freeze({
    controllerGeneration: "9",
    carrierAttemptGeneration: "13",
    fence,
  })), null);
  assert.equal(sources.h2.apply(sourceSnapshot("h2", "2", true)), true);
  const recovered = owner.issuePreCarrierOffer(Object.freeze({
    controllerGeneration: "9",
    carrierAttemptGeneration: "13",
    fence,
  }));
  assert.notEqual(recovered, null);
  assert.ok(BigInt(bindings.at(-1).offerGeneration) > staleGeneration);
});

test("false, invalid, regressed, and closed sources withdraw before a newer generation recovers", async (t) => {
  for (const source of EXPECTED_SOURCES) {
    await t.test(source, () => {
      const { owner, sources } = makeReady();
      const observed = [];
      owner.subscribe({
        apply(snapshot) { observed.push(snapshot); return true; },
        close() { assert.fail("the source withdrawal is a recoverable empty intersection"); },
      });

      assert.equal(sources[source].apply(sourceSnapshot(source, "2", false)), true);
      assertExactIntersection(observed.at(-1), false);
      assertExactIntersection(owner.current(), false);
      assert.equal(sources[source].apply(sourceSnapshot(source, "2", true)), false);
      assertExactIntersection(owner.current(), false);
      assert.equal(sources[source].apply(sourceSnapshot(source, "1", true)), false);
      assertExactIntersection(owner.current(), false);
      assert.equal(sources[source].apply(sourceSnapshot(source, "3", true)), true);
      assertExactIntersection(owner.current(), true);

      sources[source].close();
      assertExactIntersection(observed.at(-1), false);
      assertExactIntersection(owner.current(), false);
      assert.equal(sources[source].apply(sourceSnapshot(source, "3", true)), false);
      assert.equal(sources[source].apply(sourceSnapshot(source, "4", true)), true);
      assertExactIntersection(owner.current(), true);

      assert.equal(sources[source].apply(sourceSnapshot(
        source,
        "5",
        true,
        { capabilities: ["agent.transcript-lifecycle.v1"] },
      )), false);
      assertExactIntersection(owner.current(), false);
      assert.equal(
        sources[source].apply(sourceSnapshot(source, "5", true)),
        false,
        "an invalid generation cannot be cleaned up and reused",
      );
      assert.equal(sources[source].apply(sourceSnapshot(source, "6", true)), true);
      assertExactIntersection(owner.current(), true);

      assert.equal(sources[source].apply(sourceSnapshot(source, "06", true)), false);
      assertExactIntersection(owner.current(), false);
      assert.equal(sources[source].apply(sourceSnapshot(source, "7", true)), true);
      assertExactIntersection(owner.current(), true);
    });
  }
});

test("fanout is synchronous, non-reentrant, thenable-free, and subscriber-bounded", () => {
  const limited = new readinessModule.RelayV2HostCapabilityReadiness({
    testLimits: { maxSubscribers: 2 },
  });
  let thenableClosed = 0;
  limited.subscribe({ apply: () => true, close() {} });
  limited.subscribe({
    apply: () => Promise.resolve(true),
    close() { thenableClosed += 1; },
  });
  assert.equal(thenableClosed, 1, "a thenable acknowledgement is not synchronous acceptance");
  limited.subscribe({ apply: () => true, close() {} });
  assert.throws(
    () => limited.subscribe({ apply: () => true, close() {} }),
    /subscriber capacity is exhausted/,
  );

  const { owner, sources } = createOwner();
  for (const source of EXPECTED_SOURCES.slice(0, -1)) {
    assert.equal(sources[source].apply(sourceSnapshot(source, "1", true)), true);
  }
  const observed = [];
  let reentrantResult = null;
  let reentrantAttempted = false;
  owner.subscribe({
    apply(snapshot) {
      observed.push(CAPABILITIES.every((capability) => snapshot.capabilities[capability] === true));
      if (!reentrantAttempted && observed.at(-1) === true) {
        reentrantAttempted = true;
        assert.throws(
          () => owner.subscribe({ apply: () => true, close() {} }),
          /reentrant .* subscription is forbidden/,
        );
        reentrantResult = sources.codec.apply(sourceSnapshot("codec", "2", true));
      }
      return true;
    },
    close() { assert.fail("the bounded subscriber accepts both full and empty snapshots"); },
  });

  assert.equal(sources.h3.apply(sourceSnapshot("h3", "1", true)), false);
  assert.equal(reentrantResult, false);
  assert.deepEqual(observed, [false, true, false]);
  assertExactIntersection(owner.current(), false);
  assert.equal(
    sources.codec.apply(sourceSnapshot("codec", "2", true)),
    true,
    "a rejected reentrant caller snapshot is not read or consumed",
  );
  assertExactIntersection(owner.current(), true);
});

test("source descriptor reentry withdraws current before the trap returns", () => {
  const { owner, sources } = makeReady();
  const observed = [];
  owner.subscribe({
    apply(snapshot) { observed.push(snapshot); return true; },
    close() { assert.fail("descriptor reentry withdraws readiness without closing subscribers"); },
  });
  observed.length = 0;

  let trapped = false;
  const callerOwnedSnapshot = new Proxy(sourceSnapshot("codec", "2", true), {
    getOwnPropertyDescriptor(target, property) {
      if (!trapped) {
        trapped = true;
        sources.codec.close();
        assertExactIntersection(owner.current(), false);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  assert.equal(sources.codec.apply(callerOwnedSnapshot), false);
  assert.equal(trapped, true);
  assertExactIntersection(owner.current(), false);
  assert.equal(observed.length, 1);
  assertExactIntersection(observed[0], false);
  assert.equal(
    sources.codec.apply(sourceSnapshot("codec", "2", true)),
    false,
    "the trapped generation cannot be reused after the decode fault",
  );
  assert.equal(sources.codec.apply(sourceSnapshot("codec", "3", true)), true);
  assertExactIntersection(owner.current(), true);
});

test("fanout reentry empties current and shields every remaining subscriber synchronously", () => {
  const { owner, sources } = makeReady();
  const first = [];
  const remaining = [];
  let withdrawOnReady = false;
  let currentInsideReentrantClose = null;

  owner.subscribe({
    apply(snapshot) {
      const ready = CAPABILITIES.every(
        (capability) => snapshot.capabilities[capability] === true,
      );
      first.push(ready);
      if (withdrawOnReady && ready) {
        withdrawOnReady = false;
        sources.codec.close();
        currentInsideReentrantClose = owner.current();
      }
      return true;
    },
    close() { assert.fail("the first subscriber accepts the synchronous withdrawal"); },
  });
  owner.subscribe({
    apply(snapshot) {
      remaining.push(CAPABILITIES.every(
        (capability) => snapshot.capabilities[capability] === true,
      ));
      return true;
    },
    close() { assert.fail("the remaining subscriber accepts the synchronous withdrawal"); },
  });
  first.length = 0;
  remaining.length = 0;
  withdrawOnReady = true;

  assert.equal(sources.h3.apply(sourceSnapshot("h3", "2", true)), false);
  assertExactIntersection(currentInsideReentrantClose, false);
  assertExactIntersection(owner.current(), false);
  assert.deepEqual(first, [true, false]);
  assert.deepEqual(
    remaining,
    [false, false],
    "a later subscriber must never receive the stale ready snapshot",
  );

  assert.equal(sources.codec.apply(sourceSnapshot("codec", "2", true)), true);
  assertExactIntersection(owner.current(), true);
});

test("subscriber getter reentry cannot over-admit and fails the reserved admission", () => {
  const owner = new readinessModule.RelayV2HostCapabilityReadiness({
    testLimits: { maxSubscribers: 2 },
  });
  const sources = Object.fromEntries(
    EXPECTED_SOURCES.map((source) => [source, owner.source(source)]),
  );
  for (const source of EXPECTED_SOURCES) {
    assert.equal(sources[source].apply(sourceSnapshot(source, "1", true)), true);
  }

  const existing = [];
  owner.subscribe({
    apply(snapshot) {
      existing.push(CAPABILITIES.every(
        (capability) => snapshot.capabilities[capability] === true,
      ));
      return true;
    },
    close() { assert.fail("getter reentry withdraws readiness without closing subscribers"); },
  });
  existing.length = 0;

  let nestedSubscribeError = null;
  let sourceApplyResult = null;
  let currentInsideGetter = null;
  const reentrantSink = new Proxy({
    apply() { return true; },
    close() {},
  }, {
    get(target, property, receiver) {
      if (property === "apply") {
        try {
          owner.subscribe({ apply: () => true, close() {} });
        } catch (error) {
          nestedSubscribeError = error;
        }
      }
      if (property === "close") {
        sourceApplyResult = sources.codec.apply(sourceSnapshot("codec", "2", true));
        currentInsideGetter = owner.current();
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(() => owner.subscribe(reentrantSink), /subscriber is invalid/);
  assert.match(nestedSubscribeError?.message ?? "", /reentrant .* subscription is forbidden/);
  assert.equal(sourceApplyResult, false);
  assertExactIntersection(currentInsideGetter, false);
  assert.deepEqual(existing, [false]);

  const admitted = [];
  owner.subscribe({
    apply(snapshot) { admitted.push(snapshot); return true; },
    close() { assert.fail("the released admission slot must remain usable"); },
  });
  assertExactIntersection(admitted[0], false);
  assert.throws(
    () => owner.subscribe({ apply: () => true, close() {} }),
    /subscriber capacity is exhausted/,
  );
  assert.equal(sources.codec.apply(sourceSnapshot("codec", "2", true)), true);
  assertExactIntersection(owner.current(), true);
});

test("recovery reaches only a fresh connector generation through the existing runtime fence", () => {
  const { owner, sources } = makeReady();
  const closes = [];
  const unsubscribed = [];
  const unbound = [];
  const runtime = new runtimeModule.RelayV2HostRuntime({
    hostId: "mac-admin",
    hostEpoch: "readiness-host-epoch",
    hostInstanceId: "readiness-host-instance",
    identity: {
      async current() {
        return {
          hostEpoch: "readiness-host-epoch",
          hostInstanceId: "readiness-host-instance",
        };
      },
    },
    capabilityIntersection: owner,
    commands: {
      async execute() { throw new Error("readiness test does not enter H1"); },
      async query() { throw new Error("readiness test does not enter H1"); },
      async issueDedupeWindow() { throw new Error("readiness test does not enter H1"); },
    },
    resources: {
      async linearizeWelcome() { throw new Error("readiness test does not enter H2"); },
      async scopesSnapshot() { throw new Error("readiness test does not enter H2"); },
      async sessionsSnapshot() { throw new Error("readiness test does not enter H2"); },
      unsubscribe(subscriberId) { unsubscribed.push(subscriberId); },
    },
    snapshots: {
      async get() { throw new Error("readiness test does not enter the spool"); },
      async release() { throw new Error("readiness test does not enter the spool"); },
    },
    terminals: {
      async open() { throw new Error("readiness test does not enter H3"); },
      async requestReplay() { throw new Error("readiness test does not enter H3"); },
      async acknowledgeOutput() { throw new Error("readiness test does not enter H3"); },
      async input() { throw new Error("readiness test does not enter H3"); },
      async resize() { throw new Error("readiness test does not enter H3"); },
      async close() { throw new Error("readiness test does not enter H3"); },
      async unbind(_auth, route) { unbound.push(route); },
    },
    welcome: { build() { throw new Error("readiness test does not build welcome"); } },
    outbound: {
      trySend() { throw new Error("readiness test sends no public frame"); },
      close(binding, close) { closes.push({ binding, close }); },
    },
  });

  const first = routeBinding();
  assert.equal(runtime.onRouteBound(first), undefined);
  assert.equal(sources.h2.apply(sourceSnapshot("h2", "2", false)), true);
  assert.deepEqual(closes.map(({ close }) => close), [{
    code: 4406,
    reason: "capability_withdrawn",
  }]);
  assert.deepEqual(unsubscribed, ["host-route-1"]);
  assert.equal(unbound.length, 1);

  assert.equal(sources.h2.apply(sourceSnapshot("h2", "2", true)), false);
  assertExactIntersection(owner.current(), false);
  assert.equal(sources.h2.apply(sourceSnapshot("h2", "3", true)), true);
  assertExactIntersection(owner.current(), true);

  const sameConnectorGeneration = routeBinding({
    routeId: "restored-same-route",
    routeFence: "restored-same-fence",
    connectionId: "restored-same-connection",
    authContext: { jti: "restored-same-jti" },
  });
  assert.equal(runtime.onRouteBound(sameConnectorGeneration).code, "CAPABILITY_UNAVAILABLE");

  const nextConnectorGeneration = routeBinding({
    connectorGeneration: 2,
    routeId: "restored-next-route",
    routeFence: "restored-next-fence",
    connectionId: "restored-next-connection",
    authContext: { jti: "restored-next-jti" },
  });
  assert.equal(runtime.onRouteBound(nextConnectorGeneration), undefined);
  runtime.dispose();
});
