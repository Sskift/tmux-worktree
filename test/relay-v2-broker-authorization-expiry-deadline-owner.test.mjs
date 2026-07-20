import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const deadlineOwner = await import(
  "../dist/relay/v2/brokerAuthorizationExpiryDeadlineOwner.js"
);
const closeOwner = await import("../dist/relay/v2/brokerTransportCloseCoordinator.js");
const codec = await import("../dist/relay/v2/codec.js");

const NOW_MS = 1_783_700_000_000;
const HOST_ID = "mac-admin";

class AbsoluteScheduler {
  now = NOW_MS;
  nextHandle = 1;
  scheduled = new Map();

  scheduleAt = (atMs, callback) => {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { atMs, callback });
    return () => { this.scheduled.delete(handle); };
  };

  fireDue() {
    const due = [...this.scheduled.entries()]
      .filter(([, item]) => item.atMs <= this.now)
      .sort((left, right) => left[1].atMs - right[1].atMs);
    for (const [handle, item] of due) {
      if (!this.scheduled.delete(handle)) continue;
      item.callback();
    }
  }
}

class RelativeScheduler {
  nextHandle = 1;
  scheduled = new Map();

  schedule(callback, delayMs) {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { callback, delayMs });
    return handle;
  }

  cancel(handle) {
    this.scheduled.delete(handle);
  }

  fireAll() {
    const pending = [...this.scheduled.values()];
    this.scheduled.clear();
    for (const item of pending) item.callback();
  }
}

function authContext(role, overrides = {}) {
  return {
    scheme: "twcap2",
    role,
    hostId: HOST_ID,
    principalId: role === "host" ? "host-principal" : "client-principal",
    grantId: role === "host" ? "host-grant" : "client-grant",
    clientInstanceId: role === "host" ? null : "android-install",
    jti: role === "host" ? "host-jti" : "client-jti",
    kid: "key-2026-07",
    expiresAtMs: NOW_MS + 3_600_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
    ...overrides,
  };
}

function carrierBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function publicBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
}

async function registerHost(core, transportId) {
  core.attachHostCarrier(transportId, authContext("host", {
    jti: `${transportId}-jti`,
  }));
  const hello = {
    carrierVersion: 1,
    type: "host.hello",
    requestId: randomUUID(),
    payload: {
      hostId: HOST_ID,
      hostEpoch: randomUUID(),
      hostInstanceId: randomUUID(),
      clientDialects: ["tw-relay.v2"],
      capabilities: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      limits: { maxFrameBytes: 1_048_576, terminalMaxFrameBytes: 65_536 },
    },
  };
  const result = await core.receiveHostFrame(transportId, carrierBytes(hello));
  const registration = result.actions.find((action) => action.deliveryId);
  assert.ok(registration);
  assert.equal(
    core.acknowledgeHostControlDelivery(transportId, registration.deliveryId).accepted,
    true,
  );
}

async function openClient(core, transportId, connectionId, connectionIncarnation, expiresAtMs) {
  assert.equal(core.openClientRoute(
    connectionId,
    authContext("client", { jti: `${connectionId}-jti`, expiresAtMs }),
    connectionIncarnation,
  ).accepted, true);
  const [delivery] = core.drainHostCarrier(transportId, { maxFrames: 1 });
  assert.equal(delivery.frame.type, "route.open");
  assert.equal(core.acknowledgeHostDelivery(transportId, delivery.deliveryId).accepted, true);
  const opened = await core.receiveHostFrame(transportId, carrierBytes({
    carrierVersion: 1,
    type: "route.opened",
    requestId: delivery.frame.requestId,
    connectorId: delivery.frame.connectorId,
    routeId: delivery.frame.routeId,
    routeFence: delivery.frame.routeFence,
    payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
  }));
  assert.equal(opened.accepted, true);
}

function terminalAck() {
  return publicBytes({
    protocolVersion: 2,
    kind: "event",
    type: "terminal.output_ack",
    streamId: "expiry-stream",
    payload: { generation: "generation-1", nextOffset: "0" },
  });
}

async function flushTurns() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

test("Relay v2 broker authorization-expiry deadline owner foundation", async (t) => {
  await t.test("a due Core cut fences before 4401 and the existing force-destroy deadline", async () => {
    const absolute = new AbsoluteScheduler();
    const relative = new RelativeScheduler();
    const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: relative,
    });
    const socketEvents = [];
    const connectionId = "client-owned-expiry";
    const socketRegistration = coordinator.registerSocket({
      connectionKind: "client",
      connectionId,
      close(code, reason) {
        socketEvents.push(["close", code, reason]);
        return new Promise(() => {});
      },
      forceDestroy() {
        socketEvents.push(["force_destroy"]);
      },
    });
    let core;
    const cuts = [];
    core = new broker.RelayV2BrokerCore({
      now: () => absolute.now,
      onLiveAuthorizationClose(signal) {
        cuts.push(["close_signal", signal.reason]);
        coordinator.handleLiveAuthorizationClose(signal);
      },
    });
    await registerHost(core, "host-owned-expiry");
    const expiresAtMs = NOW_MS + 100;
    await openClient(
      core,
      "host-owned-expiry",
      connectionId,
      socketRegistration.connectionIncarnation,
      expiresAtMs,
    );
    const owner = new deadlineOwner.RelayV2BrokerAuthorizationExpiryDeadlineOwner({
      serializedCutPort: {
        recheckConnectionAccessExpiry(kind, id, incarnation) {
          cuts.push(["cut", kind, id, incarnation]);
          return core.recheckConnectionAccessExpiry(kind, id, incarnation);
        },
        failClosed() {
          core.liveAuthorizationFencePort.failClosed();
        },
      },
      scheduleAt: absolute.scheduleAt,
    });
    const deadlineRegistration = owner.register(
      "client",
      connectionId,
      socketRegistration.connectionIncarnation,
    );
    await flushTurns();
    assert.deepEqual(
      [...absolute.scheduled.values()].map((item) => item.atMs),
      [expiresAtMs],
      "only the Core-owned absolute expiry is armed",
    );

    absolute.now = expiresAtMs;
    absolute.fireDue();
    assert.equal(
      core.forwardClientFrame(connectionId, terminalAck()).accepted,
      false,
      "the serialized due cut fences data synchronously",
    );
    assert.deepEqual(socketEvents, [], "transport close remains outside the Core cut");
    assert.deepEqual(cuts.at(-1), ["close_signal", "access_expired"]);
    assert.deepEqual(
      [...relative.scheduled.values()].map((item) => item.delayMs),
      [5_000],
    );

    await flushTurns();
    assert.deepEqual(socketEvents, [["close", 4401, "access_expired"]]);
    relative.fireAll();
    assert.deepEqual(socketEvents, [
      ["close", 4401, "access_expired"],
      ["force_destroy"],
    ]);
    assert.equal(absolute.scheduled.size, 0);

    await deadlineRegistration.unregister();
    await owner.close();
    socketRegistration.unregister();
  });

  await t.test("replacement, unregister, and close drain exact admitted cuts", async () => {
    const absolute = new AbsoluteScheduler();
    const pending = [];
    const cutPort = {
      recheckConnectionAccessExpiry(kind, id, incarnation) {
        return new Promise((resolve, reject) => {
          pending.push({ kind, id, incarnation, resolve, reject });
        });
      },
      failClosed() {
        failClosedCalls += 1;
      },
    };
    let failClosedCalls = 0;
    const owner = new deadlineOwner.RelayV2BrokerAuthorizationExpiryDeadlineOwner({
      serializedCutPort: cutPort,
      scheduleAt: absolute.scheduleAt,
    });

    const old = owner.register("client", "reused-id", "old-incarnation");
    const oldDrain = old.unregister();
    let oldDrained = false;
    void oldDrain.then(() => { oldDrained = true; });
    const winner = owner.register("client", "reused-id", "winner-incarnation");
    assert.equal(pending.length, 2);
    pending[0].resolve({ outcome: "active", expiresAtMs: NOW_MS + 10 });
    await oldDrain;
    assert.equal(oldDrained, true);
    assert.equal(absolute.scheduled.size, 0, "retired cut cannot arm a deadline");
    pending[1].resolve({ outcome: "active", expiresAtMs: NOW_MS + 20 });
    await flushTurns();
    assert.deepEqual(
      [...absolute.scheduled.values()].map((item) => item.atMs),
      [NOW_MS + 20],
    );

    absolute.now = NOW_MS + 20;
    absolute.fireDue();
    assert.equal(pending.length, 3);
    const replacement = owner.register("client", "reused-id", "replacement-incarnation");
    assert.equal(pending.length, 4);
    pending[2].resolve({ outcome: "expired" });
    pending[3].resolve({ outcome: "active", expiresAtMs: NOW_MS + 40 });
    await flushTurns();
    assert.deepEqual(
      [...absolute.scheduled.values()].map((item) => item.atMs),
      [NOW_MS + 40],
      "late loser completion cannot retire or rearm the replacement",
    );

    const closeDrain = owner.close();
    await closeDrain;
    assert.equal(absolute.scheduled.size, 0);
    await owner.close();
    await winner.unregister();
    await replacement.unregister();
    assert.equal(failClosedCalls, 0);
  });

  await t.test("repeated synchronous early fire is bounded and failure drain is serialized", async () => {
    let cutDepth = 0;
    let maximumCutDepth = 0;
    let cutCalls = 0;
    let scheduleCalls = 0;
    let failClosedCalls = 0;
    let resolveFailClosed;
    const owner = new deadlineOwner.RelayV2BrokerAuthorizationExpiryDeadlineOwner({
      serializedCutPort: {
        recheckConnectionAccessExpiry() {
          cutDepth += 1;
          maximumCutDepth = Math.max(maximumCutDepth, cutDepth);
          cutCalls += 1;
          cutDepth -= 1;
          return { outcome: "active", expiresAtMs: NOW_MS + cutCalls };
        },
        failClosed() {
          failClosedCalls += 1;
          return new Promise((resolve) => { resolveFailClosed = resolve; });
        },
      },
      scheduleAt(_atMs, callback) {
        scheduleCalls += 1;
        callback();
        return () => {};
      },
    });
    const registration = owner.register(
      "host",
      "sync-early-host",
      "sync-early-incarnation",
    );
    await flushTurns();
    assert.equal(cutCalls, 3, "repeated early fire reaches the fixed safety bound");
    assert.equal(maximumCutDepth, 1);
    assert.equal(scheduleCalls, 2);
    assert.equal(failClosedCalls, 1);
    let drained = false;
    const unregisterDrain = registration.unregister().then(() => { drained = true; });
    await flushTurns();
    assert.equal(drained, false, "unregister drains the serialized fail-closed operation");
    resolveFailClosed();
    await unregisterDrain;
    await owner.close();
    await owner.close();
    assert.equal(failClosedCalls, 1, "the sealed owner never retries failClosed");
    assert.throws(() => owner.register("host", "sealed-host", "sealed-incarnation"));

    let proxyTrapCalls = 0;
    let proxyFailClosedCalls = 0;
    const proxyResult = new Proxy({ outcome: "active", expiresAtMs: NOW_MS + 1 }, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("result descriptor trap must not run");
      },
    });
    const proxyOwner = new deadlineOwner.RelayV2BrokerAuthorizationExpiryDeadlineOwner({
      serializedCutPort: {
        recheckConnectionAccessExpiry() { return proxyResult; },
        failClosed() { proxyFailClosedCalls += 1; },
      },
      scheduleAt: () => assert.fail("invalid result cannot arm a deadline"),
    });
    const proxyRegistration = proxyOwner.register(
      "client",
      "proxy-result-client",
      "proxy-result-incarnation",
    );
    await flushTurns();
    assert.equal(proxyFailClosedCalls, 1);
    await proxyRegistration.unregister();
    await proxyOwner.close();
    assert.equal(proxyTrapCalls, 0);
  });
});
