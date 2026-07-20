import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");
const terminalDurable = await import("../dist/relay/v2/terminalDurableLineage.js");
const terminal = await import("../dist/relay/v2/terminalManager.js");

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

async function createHarness({
  throwStatusObserver = false,
  reenterDisposeOnOffline = false,
  terminalManagerOverrides,
  h1ExecutorOverrides = {},
} = {}) {
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
  const spoolRoot = join(home, "snapshot-spool");
  const publisherSpool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  await publisherSpool.get({
    principalId: "carrier-runtime-readiness-principal",
    clientInstanceId: "composition-client",
    expectedHostEpoch: seeded.snapshot.hostEpoch,
    snapshotRequestId: "carrier-runtime-readiness",
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  await publisherSpool.close();
  const spool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  const h2RecoveryCandidate = await spool.issueRecoveredHostH2Candidate();
  assert.notEqual(h2RecoveryCandidate, null);

  const identity = {
    hostEpoch: seeded.snapshot.hostEpoch,
    hostInstanceId: store.hostInstanceId,
  };
  let expectedWelcome = null;
  let composition = null;
  let reentrantDispose = null;
  const lineage = new terminalDurable.RelayV2TerminalDurableLineageAuthority({ store });
  const terminalManager = new terminal.RelayV2TerminalManager({
    hostId: HOST_ID,
    hostEpoch: identity.hostEpoch,
    hostInstanceId: identity.hostInstanceId,
    resolver: { async resolve() { throw new Error("unexpected terminal resolve"); } },
    lineage,
    backend: { async open() { throw new Error("unexpected terminal backend open"); } },
    terminalControl: {},
    async send(route, frame, responseLineage) {
      await composition.routeSink.sendTerminalFrame(route, frame, responseLineage);
    },
  });
  Object.assign(terminalManager, terminalManagerOverrides);
  const h3RecoveryCandidate = await lineage.recoverForHostH3(terminalManager);
  const h1RecoveryCandidate = await commandPlane.RelayV2HostCommandPlane
    .openRecoveredAuthority({
      store,
      hostId: HOST_ID,
      now: () => 1_783_700_000_000,
      executor: {
        async resolve(request) {
          if (h1ExecutorOverrides.resolve) return h1ExecutorOverrides.resolve(request);
          throw new Error("unexpected carrier command resolution");
        },
        fenceResolution(transaction, request, fence) {
          return h1ExecutorOverrides.fenceResolution?.(transaction, request, fence);
        },
        async executeTwRpc(plan) {
          if (h1ExecutorOverrides.executeTwRpc) return h1ExecutorOverrides.executeTwRpc(plan);
          throw new Error("unexpected carrier TW RPC execution");
        },
        async executeTerminalControl(plan) {
          if (h1ExecutorOverrides.executeTerminalControl) {
            return h1ExecutorOverrides.executeTerminalControl(plan);
          }
          throw new Error("unexpected carrier terminal-control execution");
        },
      },
    });
  assert.notEqual(h1RecoveryCandidate, null);
  const statusObservations = [];
  const identityReads = { hostId: 0, hostEpoch: 0, hostInstanceId: 0 };
  composition = await compositionModule.openRelayV2HostCarrierRuntimeComposition({
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
        h0: store.h0ReadinessPort,
        h1RecoveryCandidate,
        h2RecoveryCandidate,
        h3RecoveryCandidate,
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
        if (reenterDisposeOnOffline && status.phase === "offline") {
          reentrantDispose = composition.dispose();
        }
        if (throwStatusObserver) throw new Error("status observer failure");
      },
    },
  });

  assert.equal(await composition.readiness.h0.activate(), true);
  assert.equal(Object.isFrozen(composition.readiness.codec), true);
  assert.deepEqual(Object.keys(composition.readiness.codec), ["close"]);
  assert.equal(composition.readiness.codec.apply, undefined);
  assert.equal(composition.readiness.codec.activate, undefined);
  assert.equal(composition.readiness.h1.apply, undefined);
  assert.equal(composition.readiness.h1.execute, undefined);
  assert.equal(composition.readiness.h1.query, undefined);
  assert.equal(composition.readiness.h1.issueDedupeWindow, undefined);
  assert.equal(composition.readiness.h3.apply, undefined);
  assert.equal(composition.readiness.h3.activate(), true);
  assert.deepEqual(Object.keys(composition.readiness.h2), ["close"]);

  return {
    home,
    spool,
    store,
    composition,
    identity,
    statusObservations,
    expectedWelcome: () => expectedWelcome,
    reentrantDispose: () => reentrantDispose,
    async cleanup() {
      await composition.dispose();
      store.close();
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
    assert.equal(h.composition.readiness.h0.apply, undefined);
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
    const queryResponse = codec.decodeRelayV2WebSocketFrame(
      "public",
      delivered[1].bytes,
    ).frame;
    assert.equal(queryResponse.type, "command.statuses");
    assert.equal(queryResponse.requestId, query.requestId);
    assert.equal(queryResponse.hostEpoch, h.identity.hostEpoch);

    route.connection.acknowledge(route.transport.confirmNext());
    await settle();
    const h1Close = h.composition.readiness.h1.close();
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
      closeCode: 4406,
      reason: "protocol_error",
      errorCode: "CAPABILITY_UNAVAILABLE",
      retryable: false,
    });
    assert.equal(h.composition.carrier.status().phase, "registered");
    await h1Close;
  } finally {
    await h.cleanup();
  }
});

test("combined dispose publishes one barrier and waits for H1 drain plus H3 shutdown", async () => {
  let releaseShutdown;
  let rejectH1;
  let signalH1Entered;
  const shutdownBarrier = new Promise((resolve) => { releaseShutdown = resolve; });
  const h1Entered = new Promise((resolve) => { signalH1Entered = resolve; });
  let shutdownCalls = 0;
  const h = await createHarness({
    reenterDisposeOnOffline: true,
    terminalManagerOverrides: {
      shutdown() {
        shutdownCalls += 1;
        return shutdownBarrier;
      },
    },
    h1ExecutorOverrides: {
      resolve() {
        return new Promise((_resolve, reject) => {
          rejectH1 = reject;
          signalH1Entered();
        });
      },
    },
  });
  try {
    const route = await openRoute(h);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.route.payload.authContext.clientInstanceId;
    sendClientFrame(route, hello);
    await settle();
    assert.equal(hostDataFrames(route.transport).length, 1);
    assert.equal(route.transport.pending.length, 1);
    route.connection.acknowledge(route.transport.confirmNext());
    const execute = fixture("command-execute-send-agent-message");
    execute.expectedHostEpoch = h.identity.hostEpoch;
    execute.payload.dedupeWindowId = h.expectedWelcome().payload.commandDedupeWindow.windowId;
    sendClientFrame(route, execute);
    await h1Entered;

    const observationsBeforeDispose = h.statusObservations.length;
    const firstDispose = h.composition.dispose();
    const secondDispose = h.composition.dispose();
    assert.equal(h.reentrantDispose(), firstDispose);
    assert.equal(firstDispose, secondDispose);
    assert.equal(h.statusObservations.length, observationsBeforeDispose + 1);
    assert.equal(h.statusObservations.at(-1).status.phase, "offline");
    assert.equal(readinessReady(h.statusObservations.at(-1).cut), false);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    const routeClose = route.transport.sent.map(decodeCarrier).findLast((frame) => (
      frame.type === "route.close"
    ));
    assert.equal(routeClose.payload.closeCode, 4406);
    assert.equal(routeClose.payload.error.code, "CAPABILITY_UNAVAILABLE");
    assert.deepEqual(route.transport.closes, [{ code: 1000, reason: "host_shutdown" }]);
    let disposed = false;
    void firstDispose.then(() => { disposed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
    assert.equal(disposed, false);
    releaseShutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false, "H1 admitted command must keep disposal pending");
    rejectH1(new TypeError("release admitted H1 command"));
    await firstDispose;
    assert.equal(disposed, true);
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
    releaseShutdown?.();
    rejectH1?.(new TypeError("cleanup admitted H1 command"));
    await h.cleanup();
  }
});

test("fatal H3 authority failure withdraws readiness and fences the route with 4406 first", async () => {
  const h = await createHarness();
  try {
    const route = await openRoute(h);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = route.route.payload.authContext.clientInstanceId;
    sendClientFrame(route, hello);
    await settle();
    route.connection.acknowledge(route.transport.confirmNext());

    const terminalOpen = fixture("terminal-open-new");
    terminalOpen.expectedHostEpoch = h.identity.hostEpoch;
    sendClientFrame(route, terminalOpen);
    await settle();

    const close = route.transport.sent.map(decodeCarrier).findLast((frame) => (
      frame.type === "route.close"
    ));
    assert.equal(close.payload.closeCode, 4406);
    assert.equal(close.payload.error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(readinessReady(h.composition.readiness.current()), false);
  } finally {
    await h.cleanup();
  }
});
