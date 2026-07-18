import assert from "node:assert/strict";
import test from "node:test";

const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");

const HOST_ID = "mac-admin";
const HOST_EPOCH = "composition-host-epoch";
const HOST_INSTANCE_ID = "composition-host-instance";

function binding(overrides = {}) {
  return Object.freeze({
    connectorGeneration: 1,
    connectorId: "composition-connector",
    routeId: "composition-route",
    routeFence: "composition-fence",
    connectionId: "composition-connection",
    clientDialect: "tw-relay.v2",
    maxFrameBytes: 1_048_576,
    authContext: Object.freeze({
      scheme: "twcap2",
      role: "client",
      hostId: HOST_ID,
      principalId: "composition-principal",
      grantId: "composition-grant",
      clientInstanceId: "composition-client",
      jti: "composition-jti",
      kid: "composition-kid",
      expiresAtMs: 1_783_703_600_000,
      ...(overrides.authContext ?? {}),
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "authContext")),
  });
}

test("default-off host composition cannot advertise without an owner-issued H2 source", () => {
  const calls = {
    h0: 0,
    h1: 0,
    h2: 0,
    spool: 0,
    h3: 0,
    welcome: 0,
  };
  const composition = compositionModule.createRelayV2HostRuntimeComposition({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    authorities: {
      h0: {
        async read() {
          calls.h0 += 1;
          return { hostEpoch: HOST_EPOCH, hostInstanceId: HOST_INSTANCE_ID };
        },
      },
      h1: {
        async execute() { calls.h1 += 1; throw new Error("unexpected H1 execute"); },
        async query() { calls.h1 += 1; throw new Error("unexpected H1 query"); },
        async issueDedupeWindow() {
          calls.h1 += 1;
          throw new Error("unexpected H1 window");
        },
      },
      h2: {
        async linearizeWelcome() { calls.h2 += 1; throw new Error("unexpected H2 welcome"); },
        async scopesSnapshot() { calls.h2 += 1; throw new Error("unexpected H2 scopes"); },
        async sessionsSnapshot() { calls.h2 += 1; throw new Error("unexpected H2 sessions"); },
        unsubscribe() {
          calls.h2 += 1;
        },
      },
      snapshotSpool: {
        async get() { calls.spool += 1; throw new Error("unexpected spool get"); },
        async release() { calls.spool += 1; throw new Error("unexpected spool release"); },
      },
      h3: {
        async open() { calls.h3 += 1; throw new Error("unexpected H3 open"); },
        async requestReplay() { calls.h3 += 1; throw new Error("unexpected H3 replay"); },
        async acknowledgeOutput() { calls.h3 += 1; throw new Error("unexpected H3 ack"); },
        async input() { calls.h3 += 1; throw new Error("unexpected H3 input"); },
        async resize() { calls.h3 += 1; throw new Error("unexpected H3 resize"); },
        async close() { calls.h3 += 1; throw new Error("unexpected H3 close"); },
        async unbind() {
          calls.h3 += 1;
        },
      },
      nextDedupeWindowBounds() {
        calls.h1 += 1;
        throw new Error("unexpected dedupe policy");
      },
    },
    welcome: {
      build() {
        calls.welcome += 1;
        throw new Error("unexpected welcome build");
      },
    },
    outbound: {
      trySend() { throw new Error("unexpected outbound frame"); },
      close() { throw new Error("unexpected route close"); },
    },
  });

  assert.deepEqual(composition.readiness.advertisedCapabilities(), []);

  for (const source of ["codec", "carrier", "h0", "h1", "h3"]) {
    assert.equal(composition.readiness[source].apply({
      source,
      generation: "1",
      ready: true,
    }), true);
  }
  assert.deepEqual(composition.readiness.advertisedCapabilities(), []);

  const rejectedWithFiveReadySources = binding({
    connectorGeneration: 2,
    routeId: "composition-five-ready-route",
    routeFence: "composition-five-ready-fence",
    connectionId: "composition-five-ready-connection",
    authContext: { jti: "composition-five-ready-jti" },
  });
  assert.equal(
    composition.routeSink.onRouteBound(rejectedWithFiveReadySources).code,
    "CAPABILITY_UNAVAILABLE",
  );

  composition.dispose();
  assert.equal(composition.readiness.codec.apply({
    source: "codec",
    generation: "2",
    ready: true,
  }), false);
  composition.dispose();
  assert.equal(composition.readiness.carrier.apply({
    source: "carrier",
    generation: "2",
    ready: true,
  }), false);
  assert.deepEqual(calls, { h0: 0, h1: 0, h2: 0, spool: 0, h3: 0, welcome: 0 });
});
