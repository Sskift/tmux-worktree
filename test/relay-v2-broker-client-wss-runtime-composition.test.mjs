import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const compositionModule = await import(
  "../dist/relay/v2/brokerClientWssRuntimeComposition.js"
);
const producerModule = await import("../dist/relay/v2/brokerProducerRegistry.js");

const HOST_ID = "mac-admin";
const NOW_MS = 1_783_700_000_000;

function authContext(role, overrides = {}) {
  return {
    scheme: "twcap2",
    role,
    hostId: HOST_ID,
    principalId: `${role}-principal`,
    grantId: `${role}-grant`,
    clientInstanceId: role === "client" ? "android-install" : null,
    jti: `${role}-jti`,
    kid: "kid-current",
    expiresAtMs: NOW_MS + 60_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
    ...overrides,
  };
}

function carrierBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function publicBytes(streamId = randomUUID()) {
  return codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.output_ack",
    streamId,
    payload: { generation: "generation-1", nextOffset: "0" },
  });
}

function hostHello() {
  return {
    carrierVersion: 1,
    type: "host.hello",
    requestId: randomUUID(),
    payload: {
      hostId: HOST_ID,
      hostEpoch: randomUUID(),
      hostInstanceId: randomUUID(),
      clientDialects: ["tw-relay.v2"],
      capabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      limits: { maxFrameBytes: 1_048_576, terminalMaxFrameBytes: 65_536 },
    },
  };
}

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

class StrictFakeSocket {
  constructor(log = []) {
    this.readyState = 1;
    this.protocol = "tw-relay.v2";
    this.extensions = "";
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.closes = [];
    this.terminates = 0;
    this.log = log;
    this.onInstalled = undefined;
    this.removeListenerImpl = undefined;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    this.onInstalled?.(event, listeners.length);
    return this;
  }

  removeListener(event, listener) {
    if (this.removeListenerImpl) return this.removeListenerImpl(event, listener);
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    this.log.push(`listener-removed:${event}`);
    return this;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      Reflect.apply(listener, this, args);
    }
  }

  send(_bytes, _options, callback) {
    callback();
  }

  pause() {}
  resume() {}

  close(code, reason) {
    this.closes.push({ code, reason });
  }

  terminate() {
    this.terminates += 1;
  }
}

class ManualAbsoluteScheduler {
  constructor(log = []) {
    this.tasks = [];
    this.log = log;
  }

  scheduleAt(expiresAtMs, callback) {
    const task = { expiresAtMs, callback, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
      this.log.push("expiry-cancelled");
    };
  }

  fire(task, { includeCancelled = false } = {}) {
    if (!task.cancelled || includeCancelled) task.callback();
  }
}

class ManualCloseScheduler {
  constructor() {
    this.tasks = [];
  }

  schedule(callback, delayMs) {
    const task = { callback, delayMs, cancelled: false };
    this.tasks.push(task);
    return task;
  }

  cancel(task) {
    task.cancelled = true;
  }

  fire(task, { includeCancelled = false } = {}) {
    if (!task.cancelled || includeCancelled) task.callback();
  }
}

function createClientScheduler() {
  return {
    tasks: [],
    schedule(delayMs, callback) {
      const task = { delayMs, callback, cancelled: false };
      this.tasks.push(task);
      return () => { task.cancelled = true; };
    },
  };
}

async function createHarness(options = {}) {
  const now = options.now ?? { value: NOW_MS };
  const log = options.log ?? [];
  const absolute = options.absolute ?? new ManualAbsoluteScheduler(log);
  const closeDeadlines = options.closeDeadlines ?? new ManualCloseScheduler();
  const transportId = options.transportId ?? `host-${randomUUID()}`;
  const hostIncarnation = `${transportId}-incarnation`;
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const producerPort = Object.create(null);
  Object.defineProperties(producerPort, {
    apply: {
      value(_actions, fence) {
        return fence.mayApply() ? "applied" : "rejected";
      },
    },
    forceTerminal: {
      value(_failure, fence) {
        return fence.mayApply() ? "applied" : "rejected";
      },
    },
  });
  const producer = registry.registerHostProducer(transportId, producerPort);
  const binding = producer.bindConnectionIncarnation(hostIncarnation);
  const composition = compositionModule.createRelayV2BrokerClientWssRuntimeComposition({
    brokerOptions: { now: () => now.value },
    producerRegistry: registry,
    resolveHostProducerBinding: () => binding,
    clientSocketScheduler: createClientScheduler(),
    deliveryTimeoutMs: 5_000,
    closeTimeoutMs: 5_000,
    authorizationExpiryScheduleAt: (expiresAtMs, callback) => (
      absolute.scheduleAt(expiresAtMs, callback)
    ),
    transportCloseDeadlineScheduler: closeDeadlines,
  });
  const hostBroker = composition.hostPumpBrokerAuthority;
  hostBroker.attachHostCarrier(
    transportId,
    authContext("host", { jti: `${transportId}-jti`, expiresAtMs: NOW_MS + 3_600_000 }),
    hostIncarnation,
  );
  const registered = await hostBroker.receiveHostFrame(
    transportId,
    carrierBytes(hostHello()),
  );
  const registration = registered.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.registered"
  ));
  assert.ok(registration);
  assert.equal(
    hostBroker.acknowledgeHostControlDelivery(
      transportId,
      registration.deliveryId,
    ).accepted,
    true,
  );
  return {
    composition,
    hostBroker,
    producer,
    transportId,
    now,
    log,
    absolute,
    closeDeadlines,
  };
}

async function attachOpenedClient(harness, options = {}) {
  const connectionId = options.connectionId ?? `client-${randomUUID()}`;
  const socket = options.socket ?? new StrictFakeSocket(harness.log);
  const handle = harness.composition.attachClientWss({
    connectionId,
    authContext: authContext("client", {
      grantId: options.grantId ?? `${connectionId}-grant`,
      jti: `${connectionId}-jti`,
      kid: options.kid ?? "kid-current",
      expiresAtMs: options.expiresAtMs ?? NOW_MS + 60_000,
    }),
    hostProducerTarget: harness.producer.target,
    alreadyUpgradedSocket: socket,
  });
  assert.equal(handle.openResult.accepted, true);
  const deliveries = harness.hostBroker.drainHostCarrier(harness.transportId);
  const routeOpen = deliveries.find((delivery) => delivery.frame.type === "route.open");
  assert.ok(routeOpen);
  assert.equal(
    harness.hostBroker.acknowledgeHostDelivery(
      harness.transportId,
      routeOpen.deliveryId,
    ).accepted,
    true,
  );
  const opened = await harness.hostBroker.receiveHostFrame(
    harness.transportId,
    carrierBytes({
      carrierVersion: 1,
      type: "route.opened",
      requestId: routeOpen.frame.requestId,
      connectorId: routeOpen.frame.connectorId,
      routeId: routeOpen.frame.routeId,
      routeFence: routeOpen.frame.routeFence,
      payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
    }),
  );
  assert.equal(
    opened.actions.find((action) => action.kind === "route_opened")?.connectionIncarnation,
    handle.incarnation,
  );
  for (const action of opened.actions) harness.composition.applyBrokerAction(action);
  await settle();
  return { connectionId, socket, handle, routeOpen };
}

async function completeRouteUnbind(harness, capturedDelivery) {
  const delivery = capturedDelivery ?? harness.hostBroker.drainHostCarrier(
    harness.transportId,
    { maxFrames: 1 },
  )[0];
  assert.equal(delivery.frame.type, "route.unbind");
  assert.equal(
    harness.hostBroker.acknowledgeHostDelivery(
      harness.transportId,
      delivery.deliveryId,
    ).accepted,
    true,
  );
  const result = await harness.hostBroker.receiveHostFrame(
    harness.transportId,
    carrierBytes({
      carrierVersion: 1,
      type: "route.unbound",
      connectorId: delivery.frame.connectorId,
      routeId: delivery.frame.routeId,
      routeFence: delivery.frame.routeFence,
      payload: {
        reason: delivery.frame.payload.reason,
        lastClientToHostSeq: delivery.frame.payload.lastClientToHostSeq,
        lastHostToClientSeq: "0",
      },
    }),
  );
  assert.equal(result.accepted, true);
}

test("client WSS runtime keeps one incarnation through Core and drains only after native close", async () => {
  const harness = await createHarness();
  assert.equal(
    harness.hostBroker.sweepBackpressure(harness.transportId).accepted,
    true,
  );
  const client = await attachOpenedClient(harness);
  assert.equal(harness.absolute.tasks.length, 1);

  client.socket.emit("close", 1000);
  const [unbind] = harness.hostBroker.drainHostCarrier(
    harness.transportId,
    { maxFrames: 1 },
  );
  assert.equal(unbind.frame.type, "route.unbind");
  assert.equal(harness.log.includes("expiry-cancelled"), false);
  assert.deepEqual(await client.handle.terminal, { kind: "closed", code: 1000 });
  await client.handle.drained;
  client.socket.emit("message", publicBytes(), false);
  assert.equal(harness.hostBroker.drainHostCarrier(harness.transportId).length, 0);
  const expiryIndex = harness.log.indexOf("expiry-cancelled");
  const lastListenerIndex = harness.log.lastIndexOf("listener-removed:error");
  assert.ok(expiryIndex < lastListenerIndex, "composition terminal guard drains last");
  assert.equal(harness.closeDeadlines.tasks.length, 0);
  await harness.composition.closeAndDrain();
});

test("absolute expiry fences frames before 4401, forces at 5s, and stale callbacks miss replacement", async () => {
  const harness = await createHarness();
  const old = await attachOpenedClient(harness, {
    connectionId: "client-expiry",
    expiresAtMs: NOW_MS + 1_000,
  });
  const oldExpiry = harness.absolute.tasks[0];
  harness.now.value = NOW_MS + 1_000;
  harness.absolute.fire(oldExpiry);
  old.socket.emit("message", publicBytes(), false);
  const fencedDeliveries = harness.hostBroker.drainHostCarrier(harness.transportId);
  assert.equal(fencedDeliveries.some((delivery) => delivery.frame.type === "route.data"), false);
  assert.deepEqual(old.socket.closes, [], "native close is deferred after the Core fence");
  await settle();
  assert.deepEqual(old.socket.closes, [{ code: 4401, reason: "access_expired" }]);
  const oldCloseDeadline = harness.closeDeadlines.tasks[0];
  assert.equal(oldCloseDeadline.delayMs, 5_000);
  harness.closeDeadlines.fire(oldCloseDeadline);
  assert.equal(old.socket.terminates, 1);

  let drained = false;
  void old.handle.drained.then(() => { drained = true; });
  await settle();
  assert.equal(drained, false, "forceDestroy is not native terminal evidence");
  old.socket.emit("close", 1006);
  await old.handle.drained;
  const oldUnbind = harness.hostBroker.drainHostCarrier(harness.transportId)
    .find((delivery) => delivery.frame.type === "route.unbind");
  assert.ok(oldUnbind);
  await completeRouteUnbind(harness, oldUnbind);

  const winner = await attachOpenedClient(harness, {
    connectionId: old.connectionId,
    expiresAtMs: NOW_MS + 120_000,
  });
  harness.absolute.fire(oldExpiry, { includeCancelled: true });
  harness.closeDeadlines.fire(oldCloseDeadline, { includeCancelled: true });
  old.socket.emit("error", new Error("late old socket error"));
  await settle();
  assert.deepEqual(winner.socket.closes, []);
  assert.equal(winner.socket.terminates, 0);
  winner.socket.emit("close", 1000);
  await winner.handle.drained;
  await harness.composition.closeAndDrain();

  const authorityLoss = await createHarness();
  const authorityClient = await attachOpenedClient(authorityLoss);
  const authorityDrain = authorityLoss.composition.closeAndDrain();
  await settle();
  assert.deepEqual(authorityClient.socket.closes, [{
    code: 1013,
    reason: "credential_authority_unavailable",
  }]);
  authorityClient.socket.emit("close", 1000);
  await authorityDrain;
});

test("partial attach and concurrent close share a real-terminal drain barrier", async () => {
  const harness = await createHarness();
  const socket = new StrictFakeSocket(harness.log);
  let closeFromAttach;
  socket.onInstalled = (event, count) => {
    if (event === "error" && count === 2 && !closeFromAttach) {
      closeFromAttach = harness.composition.closeAndDrain();
    }
  };
  assert.throws(() => harness.composition.attachClientWss({
    connectionId: "partial-client",
    authContext: authContext("client"),
    hostProducerTarget: harness.producer.target,
    alreadyUpgradedSocket: socket,
  }), /closing|construction failed/);
  assert.ok(closeFromAttach);
  assert.strictEqual(harness.composition.closeAndDrain(), closeFromAttach);
  assert.throws(() => harness.composition.attachClientWss({
    connectionId: "late-client",
    authContext: authContext("client", { jti: "late-client-jti" }),
    hostProducerTarget: harness.producer.target,
    alreadyUpgradedSocket: new StrictFakeSocket(),
  }), /closing/);
  let closed = false;
  void closeFromAttach.then(() => { closed = true; });
  await settle();
  assert.equal(socket.terminates, 1);
  assert.equal(closed, false, "forceDestroy cannot settle the composition drain");
  socket.emit("error", new Error("native terminal"));
  await closeFromAttach;
  assert.equal(closed, true);
  assert.equal(harness.absolute.tasks.every((task) => task.cancelled), true);
  assert.equal(harness.closeDeadlines.tasks.every((task) => task.cancelled), true);

  const cleanupFault = await createHarness();
  const first = await attachOpenedClient(cleanupFault, { connectionId: "cleanup-fault" });
  const second = await attachOpenedClient(cleanupFault, { connectionId: "terminal-wait" });
  first.socket.removeListenerImpl = () => {
    throw new Error("injected listener cleanup failure");
  };
  const allDrained = cleanupFault.composition.closeAndDrain();
  let allSettled = false;
  void allDrained.then(
    () => { allSettled = true; },
    () => { allSettled = true; },
  );
  await settle();
  first.socket.emit("close", 1000);
  await settle();
  assert.equal(allSettled, false, "one cleanup fault cannot skip another native terminal");
  second.socket.emit("close", 1000);
  await assert.rejects(allDrained, /WebSocket adapter rejected|cleanup/);
  assert.equal(allSettled, true);
});
