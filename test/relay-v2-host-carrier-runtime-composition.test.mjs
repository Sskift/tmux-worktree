import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");

const HOST_ID = "mac-admin";
const corpus = loadRelayV2FixtureCorpus();

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function carrierWire(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function publicWire(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
}

function decodeCarrier(bytes) {
  return codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
}

function settle(turns = 8) {
  return Array.from({ length: turns }).reduce(
    (tail) => tail.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );
}

function readinessReady(snapshot) {
  return Object.values(snapshot.capabilities).every((ready) => ready === true);
}

class QueueDiscovery {
  scans = [];

  async scan() {
    const scan = this.scans.shift();
    if (!scan) throw new Error("unexpected composition discovery");
    return structuredClone(scan);
  }
}

class FakeTransport {
  bufferedBytes = 0;
  pending = [];
  sent = [];
  closes = [];

  trySend(bytes, deliveryToken) {
    const copy = Uint8Array.from(bytes);
    this.sent.push(copy);
    this.bufferedBytes += copy.byteLength;
    this.pending.push({ deliveryToken, byteLength: copy.byteLength });
    return true;
  }

  bufferedAmount() {
    return this.bufferedBytes;
  }

  confirmNext() {
    const delivery = this.pending.shift();
    assert.ok(delivery, "missing composition delivery");
    this.bufferedBytes -= delivery.byteLength;
    return delivery.deliveryToken;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

function completeScope() {
  return {
    backendIdentity: "local",
    displayName: "Local",
    kind: "local",
    reachability: "online",
    sessionsCompleteness: "complete",
    sessions: [],
    error: null,
  };
}

async function createHarness({ throwStatusObserver = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-carrier-runtime-"));
  const store = await hostState.RelayV2HostStateStore.open({
    paths: hostState.relayV2HostStatePaths(home),
  });
  const discovery = new QueueDiscovery();
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: HOST_ID,
    discovery,
    store,
    readinessSink: { apply: () => true },
  });
  discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
  const seeded = await foundation.reconcile();
  const spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
    hostId: HOST_ID,
    materializedStateAuthority: foundation.snapshotAuthorityBundle,
    root: join(home, "snapshot-spool"),
    ownerInstanceId: store.hostInstanceId,
  });
  assert.notEqual(spool.hostH2Authority, null);

  const identity = {
    hostEpoch: seeded.snapshot.hostEpoch,
    hostInstanceId: store.hostInstanceId,
  };
  let expectedWelcome = null;
  let expectedQuery = null;
  let composition = null;
  const statusObservations = [];
  const identityReads = { hostId: 0, hostEpoch: 0, hostInstanceId: 0 };
  composition = compositionModule.createRelayV2HostCarrierRuntimeComposition({
    runtime: {
      get hostId() {
        if (++identityReads.hostId > 1) throw new Error("hostId was captured twice");
        return HOST_ID;
      },
      get hostEpoch() {
        if (++identityReads.hostEpoch > 1) throw new Error("hostEpoch was captured twice");
        return identity.hostEpoch;
      },
      get hostInstanceId() {
        if (++identityReads.hostInstanceId > 1) {
          throw new Error("hostInstanceId was captured twice");
        }
        return identity.hostInstanceId;
      },
      authorities: {
        h0: {
          async read() { return structuredClone(identity); },
        },
        h1: {
          async execute() { throw new Error("unexpected command execute"); },
          async query(_auth, request) {
            const response = fixture("command-statuses-all-states");
            response.requestId = request.requestId;
            response.hostId = HOST_ID;
            response.hostEpoch = identity.hostEpoch;
            expectedQuery = structuredClone(response);
            return response;
          },
          async issueDedupeWindow(bounds) {
            return {
              windowId: "carrier-runtime-window",
              windowSeq: "1",
              acceptUntilMs: bounds.acceptUntilMs,
              queryUntilMs: bounds.queryUntilMs,
            };
          },
        },
        h2SnapshotAuthority: spool.hostH2Authority,
        h3: {
          async open() { throw new Error("unexpected terminal open"); },
          async requestReplay() { throw new Error("unexpected terminal replay"); },
          async acknowledgeOutput() { throw new Error("unexpected terminal ACK"); },
          async input() { throw new Error("unexpected terminal input"); },
          async resize() { throw new Error("unexpected terminal resize"); },
          async close() { throw new Error("unexpected terminal close"); },
          async unbind() {},
        },
        nextDedupeWindowBounds() {
          return {
            acceptUntilMs: 1_783_786_400_000,
            queryUntilMs: 1_784_391_200_000,
          };
        },
      },
      welcome: {
        build(input) {
          const welcome = fixture("host-welcome-snapshot-required");
          welcome.requestId = input.hello.requestId;
          welcome.hostId = HOST_ID;
          welcome.hostEpoch = input.cut.hostEpoch;
          welcome.hostInstanceId = input.cut.hostInstanceId;
          welcome.payload.eventSeq = input.cut.eventSeq;
          welcome.payload.capabilities = [...input.capabilities];
          welcome.payload.commandDedupeWindow = structuredClone(input.commandDedupeWindow);
          expectedWelcome = structuredClone(welcome);
          return welcome;
        },
      },
    },
    carrier: {
      credentialReferences: {
        read(reference) {
          return {
            reference,
            version: "1",
            grantId: "host-grant",
            accessJti: "host-access-jti",
            accessToken: "twcap2.host.payload.mac",
          };
        },
        prepareReauthentication() { throw new Error("unexpected reauthentication"); },
        acknowledgeReauthentication() { return false; },
      },
      clientDialects: ["tw-relay.v1"],
      dialectAdapters: {
        "tw-relay.v1": { validate() {} },
      },
      idFactory: () => "carrier-runtime-host-hello",
      clock: () => 1_783_700_100_000,
      onStatus(status) {
        if (composition === null) throw new Error("carrier status preceded composition");
        statusObservations.push({
          status: structuredClone(status),
          cut: composition.readiness.current(),
        });
        if (throwStatusObserver) throw new Error("status observer failure");
      },
    },
  });

  for (const source of ["codec", "h0", "h1", "h3"]) {
    assert.equal(composition.readiness[source].apply({
      source,
      generation: "1",
      ready: true,
    }), true);
  }
  const principalId = "carrier-runtime-readiness-principal";
  const chunk = await spool.get({
    principalId,
    clientInstanceId: "composition-client",
    expectedHostEpoch: identity.hostEpoch,
    snapshotRequestId: "carrier-runtime-readiness",
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  const issue = await spool.issueReadinessReceipt(chunk.snapshotId);
  assert.equal(await composition.readiness.h2.activate(issue), true);

  return {
    home,
    spool,
    composition,
    identity,
    statusObservations,
    expectedWelcome: () => expectedWelcome,
    expectedQuery: () => expectedQuery,
    async cleanup() {
      composition.dispose();
      await spool.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function acknowledgeAll(connection, transport) {
  while (transport.pending.length > 0) {
    connection.acknowledge(transport.confirmNext());
  }
}

function connectCarrier(harness) {
  const transport = new FakeTransport();
  const connection = harness.composition.carrier.connect(transport, "host-credential");
  const hello = decodeCarrier(transport.sent.at(-1));
  assert.deepEqual(hello.payload.capabilities, []);
  assert.deepEqual(hello.payload.clientDialects, ["tw-relay.v2"]);
  return { transport, connection, hello };
}

function registerCarrier(active, connectorId, disposition = "connected") {
  const { transport, connection, hello } = active;
  connection.acknowledge(transport.confirmNext());

  const registered = fixture("host-registered");
  registered.requestId = hello.requestId;
  registered.connectorId = connectorId;
  registered.payload.disposition = disposition;
  registered.payload.supersededHostInstanceId = disposition === "replaced"
    ? "previous-carrier-runtime-instance"
    : null;
  connection.receive(carrierWire(registered));
  return registered;
}

async function openRoute(harness) {
  const active = connectCarrier(harness);
  const { transport, connection } = active;
  const registered = registerCarrier(active, "carrier-runtime-connector");

  const route = fixture("route-open");
  route.connectorId = registered.connectorId;
  route.routeId = "carrier-runtime-route";
  route.routeFence = "carrier-runtime-fence";
  route.payload.connectionId = "carrier-runtime-connection";
  route.payload.authContext.hostId = HOST_ID;
  route.payload.authContext.principalId = "carrier-runtime-principal";
  route.payload.authContext.clientInstanceId = "composition-client";
  connection.receive(carrierWire(route));
  assert.equal(decodeCarrier(transport.sent.at(-1)).type, "route.opened");
  acknowledgeAll(connection, transport);
  return { transport, connection, route, nextClientSequence: 0 };
}

function sendClientFrame(route, frame) {
  route.nextClientSequence += 1;
  route.connection.receive(carrierWire({
    carrierVersion: 1,
    type: "route.data",
    connectorId: route.route.connectorId,
    routeId: route.route.routeId,
    routeFence: route.route.routeFence,
    direction: "client_to_host",
    seq: String(route.nextClientSequence),
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(publicWire(frame)).toString("base64"),
    },
  }));
}

test("combined composition owns carrier readiness transitions before status observation", async () => {
  const h = await createHarness({ throwStatusObserver: true });
  try {
    assert.equal(h.composition.readiness.carrier, undefined);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    let previousCutGeneration = BigInt(h.composition.readiness.current().generation);
    let observationCount = 0;

    const expectStatus = (phase, ready) => {
      observationCount += 1;
      assert.equal(h.statusObservations.length, observationCount);
      const observation = h.statusObservations[observationCount - 1];
      assert.equal(observation.status.phase, phase);
      assert.equal(readinessReady(observation.cut), ready);
      assert.equal(readinessReady(h.composition.readiness.current()), ready);
      const cutGeneration = BigInt(observation.cut.generation);
      assert.ok(cutGeneration > previousCutGeneration);
      previousCutGeneration = cutGeneration;
    };

    const first = connectCarrier(h);
    expectStatus("connecting", false);
    registerCarrier(first, "carrier-readiness-first");
    expectStatus("registered", true);
    assert.equal(h.composition.carrier.status().phase, "registered");

    first.connection.closed(1006);
    expectStatus("offline", false);

    const second = connectCarrier(h);
    expectStatus("connecting", false);
    registerCarrier(second, "carrier-readiness-second");
    expectStatus("registered", true);

    const replacement = connectCarrier(h);
    expectStatus("connecting", false);
    assert.deepEqual(second.transport.closes, [{ code: 1000, reason: "connector_replaced" }]);
    const replacementRegistration = registerCarrier(
      replacement,
      "carrier-readiness-replacement",
      "replaced",
    );
    expectStatus("registered", true);

    const superseded = fixture("host-superseded");
    superseded.connectorId = replacementRegistration.connectorId;
    superseded.payload.hostId = HOST_ID;
    superseded.payload.losingConnectorId = replacementRegistration.connectorId;
    superseded.payload.losingHostInstanceId = h.identity.hostInstanceId;
    superseded.payload.winningConnectorId = "carrier-readiness-winner";
    superseded.payload.winningHostInstanceId = "carrier-readiness-winning-instance";
    replacement.connection.receive(carrierWire(superseded));
    expectStatus("superseded", false);
    assert.equal(h.composition.carrier.status().phase, "superseded");
  } finally {
    await h.cleanup();
  }
});

function hostDataFrames(transport) {
  return transport.sent
    .map(decodeCarrier)
    .filter((frame) => frame.type === "route.data")
    .map((frame) => ({
      carrier: frame,
      bytes: Uint8Array.from(Buffer.from(frame.payload.data, "base64")),
    }));
}

test("combined carrier/runtime bridges copied bindings, exact bytes, FIFO, and route-only close", async () => {
  const h = await createHarness();
  try {
    assert.equal(Object.isFrozen(h.composition), true);
    assert.equal(Object.isFrozen(h.composition.carrier), true);
    assert.equal(h.composition.routeSink, undefined);
    assert.equal(h.composition.carrier.sendPublic, undefined);
    assert.equal(h.composition.carrier.closeRoute, undefined);
    assert.equal(h.composition.carrier.dispose, undefined);

    const route = await openRoute(h);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.route.payload.authContext.clientInstanceId;
    sendClientFrame(route, hello);
    await settle();
    assert.equal(hostDataFrames(route.transport).length, 1);

    const query = fixture("command-query");
    query.expectedHostEpoch = h.identity.hostEpoch;
    sendClientFrame(route, query);
    await settle();
    assert.equal(
      hostDataFrames(route.transport).length,
      1,
      "the second runtime frame remains behind the first carrier receipt",
    );

    route.connection.acknowledge(route.transport.confirmNext());
    await settle();
    const delivered = hostDataFrames(route.transport);
    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered.map(({ carrier }) => carrier.seq), ["1", "2"]);
    assert.deepEqual(delivered[0].bytes, publicWire(h.expectedWelcome()));
    assert.deepEqual(delivered[1].bytes, publicWire(h.expectedQuery()));

    route.connection.acknowledge(route.transport.confirmNext());
    await settle();
    h.identity.hostInstanceId = "replacement-host-instance";
    const stale = fixture("command-query");
    stale.requestId = "carrier-runtime-stale-process";
    stale.expectedHostEpoch = h.identity.hostEpoch;
    sendClientFrame(route, stale);
    await settle();
    const close = route.transport.sent.map(decodeCarrier).findLast((frame) => (
      frame.type === "route.close"
    ));
    assert.deepEqual({
      closeCode: close.payload.closeCode,
      reason: close.payload.reason,
      errorCode: close.payload.error.code,
      retryable: close.payload.error.retryable,
    }, {
      closeCode: 4409,
      reason: "host_shutdown",
      errorCode: "HOST_SUPERSEDED",
      retryable: false,
    });
    assert.equal(h.composition.carrier.status().phase, "registered");
  } finally {
    await h.cleanup();
  }
});

test("combined dispose keeps the bridge alive through receipt cleanup and then closes once", async () => {
  const h = await createHarness();
  try {
    const route = await openRoute(h);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.route.payload.authContext.clientInstanceId;
    sendClientFrame(route, hello);
    await settle();
    assert.equal(hostDataFrames(route.transport).length, 1);
    assert.equal(route.transport.pending.length, 1);

    const observationsBeforeDispose = h.statusObservations.length;
    h.composition.dispose();
    h.composition.dispose();
    assert.equal(h.statusObservations.length, observationsBeforeDispose + 1);
    assert.equal(h.statusObservations.at(-1).status.phase, "offline");
    assert.equal(readinessReady(h.statusObservations.at(-1).cut), false);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assert.deepEqual(route.transport.closes, [{ code: 1000, reason: "host_shutdown" }]);
    assert.throws(
      () => h.composition.carrier.connect(new FakeTransport(), "host-credential"),
      /disposed and cannot reconnect/,
    );

    const observationsAfterDispose = h.statusObservations.length;
    route.connection.closed(1006);
    assert.equal(h.statusObservations.length, observationsAfterDispose);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    const late = route.transport.confirmNext();
    assert.doesNotThrow(() => route.connection.acknowledge(late));
    assert.deepEqual(route.transport.closes, [{ code: 1000, reason: "host_shutdown" }]);
  } finally {
    await h.cleanup();
  }
});
