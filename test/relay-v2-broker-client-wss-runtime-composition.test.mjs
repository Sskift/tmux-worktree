import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const compositionModule = await import(
  "../dist/relay/v2/brokerClientWssRuntimeComposition.js"
);
const nodeIngressModule = await import(
  "../dist/relay/v2/brokerClientWssNodeListenerFreeIngress.js"
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

function hostTerminalInputAck(streamId = "warning-stream") {
  return {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId,
    payload: { generation: "generation-1", ackedThroughInputSeq: "0" },
  };
}

function hostRouteData(identity, seq, publicFrame) {
  return {
    carrierVersion: 1,
    type: "route.data",
    connectorId: identity.connectorId,
    routeId: identity.routeId,
    routeFence: identity.routeFence,
    direction: "host_to_client",
    seq,
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(
        codec.encodeRelayV2WebSocketFrame("public", publicFrame),
      ).toString("base64"),
    },
  };
}

function hostHello(overrides = {}) {
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
      ...overrides,
    },
  };
}

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

class StrictFakeSocket {
  constructor(log = []) {
    this._readyState = 1;
    this._protocol = "tw-relay.v2";
    this._extensions = "";
    this._bufferedAmount = 0;
    this.listeners = new Map();
    this.closes = [];
    this.terminates = 0;
    this.sends = [];
    this.sendBlocked = false;
    this.blockedSendCallbacks = [];
    this.log = log;
    this.onInstalled = undefined;
    this.removeListenerImpl = undefined;
  }

  get readyState() { return this._readyState; }
  get protocol() { return this._protocol; }
  get extensions() { return this._extensions; }
  get bufferedAmount() { return this._bufferedAmount; }

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

  send(bytes, _options, callback) {
    this.sends.push(bytes.slice());
    if (this.sendBlocked) {
      this.blockedSendCallbacks.push(callback);
      return;
    }
    callback();
  }

  releaseBlockedSends() {
    this.sendBlocked = false;
    const pending = this.blockedSendCallbacks.splice(0);
    for (const callback of pending) callback();
  }

  sentFrames() {
    return this.sends.map((bytes) => (
      codec.decodeRelayV2WebSocketFrame("public", bytes).frame
    ));
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

class MemoryDuplex extends Duplex {
  constructor() {
    super();
    this.writes = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  _destroy(error, callback) {
    callback(error);
  }

  responseText() {
    return Buffer.concat(this.writes).toString("latin1");
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
  let clientWssRuntime;
  const composition = compositionModule.createRelayV2BrokerClientWssRuntimeComposition({
    brokerOptions: {
      now: () => now.value,
      baseCapabilityReadiness: options.baseCapabilityReadiness
        ?? [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    producerRegistry: registry,
    resolveHostProducerBinding: () => binding,
    clientSocketScheduler: createClientScheduler(),
    deliveryTimeoutMs: 5_000,
    closeTimeoutMs: 5_000,
    authorizationExpiryScheduleAt: (expiresAtMs, callback) => (
      absolute.scheduleAt(expiresAtMs, callback)
    ),
    transportCloseDeadlineScheduler: closeDeadlines,
  }, (runtime) => {
    clientWssRuntime = runtime;
  });
  assert.ok(clientWssRuntime);
  const trustedClientSockets = new WeakSet();
  if (options.installClientIngress !== false) {
    clientWssRuntime.installTrustedSocketCapture(
      StrictFakeSocket.prototype,
      (socket) => trustedClientSockets.has(socket),
    );
  }
  const hostBroker = composition.hostPumpBrokerAuthority;
  hostBroker.attachHostCarrier(
    transportId,
    authContext("host", { jti: `${transportId}-jti`, expiresAtMs: NOW_MS + 3_600_000 }),
    hostIncarnation,
  );
  const registered = await hostBroker.receiveHostFrame(
    transportId,
    carrierBytes(hostHello(options.hostHelloOverrides)),
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
    clientWssRuntime,
    hostBroker,
    producer,
    transportId,
    now,
    log,
    absolute,
    closeDeadlines,
    admitClientSocket(socket) {
      trustedClientSockets.add(socket);
    },
    releaseClientSocket(socket) {
      trustedClientSockets.delete(socket);
    },
  };
}

function prepareClient(harness, options = {}) {
  const connectionId = options.connectionId ?? `client-${randomUUID()}`;
  const prepared = harness.clientWssRuntime.prepareClientWssForCurrentHost({
    connectionId,
    trustedAuthContext: authContext("client", {
      grantId: options.grantId ?? `${connectionId}-grant`,
      jti: `${connectionId}-jti`,
      kid: options.kid ?? "kid-current",
      expiresAtMs: options.expiresAtMs ?? NOW_MS + 60_000,
    }),
  });
  assert.equal(prepared.outcome, "accept");
  return { connectionId, admissionReceipt: prepared.admissionReceipt };
}

async function attachOpenedClient(harness, options = {}) {
  const prepared = prepareClient(harness, options);
  const connectionId = prepared.connectionId;
  const socket = options.socket ?? new StrictFakeSocket(harness.log);
  harness.admitClientSocket(socket);
  let handle;
  try {
    handle = harness.clientWssRuntime.attachPreparedClientWss({
      admissionReceipt: prepared.admissionReceipt,
      alreadyUpgradedSocket: socket,
    });
  } finally {
    harness.releaseClientSocket(socket);
  }
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
  return {
    connectionId,
    admissionReceipt: prepared.admissionReceipt,
    socket,
    handle,
    routeOpen,
  };
}

async function completeRouteUnbind(harness, capturedDelivery, lastHostToClientSeq = "0") {
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
        lastHostToClientSeq,
      },
    }),
  );
  assert.equal(result.accepted, true);
}

test("listener-free Node ingress composes the canonical client runtime without a server owner", async () => {
  const harness = await createHarness({ installClientIngress: false });
  let verifierCalls = 0;
  const ingress = nodeIngressModule.createRelayV2BrokerClientWssNodeListenerFreeIngress({
    verifyV2AccessToken(token, expectedRole) {
      verifierCalls += 1;
      assert.equal(token, "twcap2.node-runtime-integration");
      assert.equal(expectedRole, "client");
      return authContext("client");
    },
    runtime: harness.clientWssRuntime,
  });
  const socket = new MemoryDuplex();
  const key = Buffer.alloc(16, 12).toString("base64");
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = "/client";
  request.rawHeaders = [
    "Host", "relay.example.com",
    "Connection", "Upgrade",
    "Upgrade", "websocket",
    "Authorization", "Bearer twcap2.node-runtime-integration",
    "Sec-WebSocket-Key", key,
    "Sec-WebSocket-Version", "13",
    "Sec-WebSocket-Protocol", "tw-relay.v2",
    "Sec-WebSocket-Extensions", "permessage-deflate; client_max_window_bits",
  ];
  request.headers = {
    host: "relay.example.com",
    connection: "Upgrade",
    upgrade: "websocket",
    authorization: "Bearer twcap2.node-runtime-integration",
    "sec-websocket-key": key,
    "sec-websocket-version": "13",
    "sec-websocket-protocol": "tw-relay.v2",
    "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
  };

  const ingressResult = await ingress.handleUpgradeRequest({
    request,
    socket,
    head: Buffer.alloc(0),
  });
  assert.equal(ingressResult, "upgraded", socket.responseText());
  assert.equal(verifierCalls, 1);
  assert.match(socket.responseText(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.doesNotMatch(socket.responseText(), /\r\nSec-WebSocket-Extensions:/i);
  assert.equal(
    harness.hostBroker.drainHostCarrier(harness.transportId)
      .some((delivery) => delivery.frame.type === "route.open"),
    true,
  );

  socket.destroy();
  await ingress.closeAndDrain();
});

test("client WSS runtime keeps one incarnation through Core and drains only after native close", async () => {
  const harness = await createHarness();
  assert.equal(
    harness.hostBroker.sweepBackpressure(harness.transportId).accepted,
    true,
  );
  const client = await attachOpenedClient(harness);
  assert.equal(harness.absolute.tasks.length, 2);

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

test("pre-101 admission rejection returns the Core HTTP result without socket or close-lease effects", async () => {
  const harness = await createHarness({
    hostHelloOverrides: { capabilities: ["error.structured.v1"] },
  });
  const prepared = harness.composition.prepareClientWss({
    connectionId: "client-preflight-rejected",
    trustedAuthContext: authContext("client", {
      grantId: "client-preflight-rejected-grant",
      jti: "client-preflight-rejected-jti",
    }),
    hostProducerTarget: harness.producer.target,
  });

  assert.equal(prepared.outcome, "reject");
  assert.equal(prepared.status, 426);
  assert.equal(prepared.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(Object.hasOwn(prepared, "admissionReceipt"), false);
  assert.equal(harness.hostBroker.drainHostCarrier(harness.transportId).length, 0);
  assert.equal(harness.absolute.tasks.length, 0);
  assert.equal(harness.closeDeadlines.tasks.length, 0);
  await harness.composition.closeAndDrain();
});

test("prepared admission is one-shot and a composition close invalidates unconsumed receipts", async () => {
  const harness = await createHarness();
  const client = await attachOpenedClient(harness, { connectionId: "client-one-shot" });
  const untouchedSocket = new Proxy({}, {});

  assert.throws(() => harness.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: client.admissionReceipt,
    alreadyUpgradedSocket: untouchedSocket,
  }), /admission receipt/);
  const pending = prepareClient(harness, { connectionId: "client-close-invalidated" });
  const closeDrain = harness.composition.closeAndDrain();
  assert.throws(() => harness.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: pending.admissionReceipt,
    alreadyUpgradedSocket: untouchedSocket,
  }), /closing/);

  client.socket.emit("close", 1000);
  await closeDrain;
});

test("client ingress claim rejects missing brand and a branded structural socket", async () => {
  const harness = await createHarness();
  const missingBrand = prepareClient(harness, { connectionId: "client-missing-brand" });
  const samePrototypeSocket = new StrictFakeSocket();
  assert.throws(() => harness.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: missingBrand.admissionReceipt,
    alreadyUpgradedSocket: samePrototypeSocket,
  }), /adapter|construction failed/i);
  harness.admitClientSocket(samePrototypeSocket);
  try {
    assert.throws(() => harness.clientWssRuntime.attachPreparedClientWss({
      admissionReceipt: missingBrand.admissionReceipt,
      alreadyUpgradedSocket: samePrototypeSocket,
    }), /admission receipt/);
  } finally {
    harness.releaseClientSocket(samePrototypeSocket);
  }

  class StructuralSocket extends StrictFakeSocket {}
  const foreignPrototype = prepareClient(harness, {
    connectionId: "client-foreign-prototype",
  });
  const structuralSocket = new StructuralSocket();
  harness.admitClientSocket(structuralSocket);
  try {
    assert.throws(() => harness.clientWssRuntime.attachPreparedClientWss({
      admissionReceipt: foreignPrototype.admissionReceipt,
      alreadyUpgradedSocket: structuralSocket,
    }), /adapter|construction failed/i);
  } finally {
    harness.releaseClientSocket(structuralSocket);
  }
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

test("client auth-expiring warning reaches the socket once per credential before the exact 4401 fence", async () => {
  const harness = await createHarness();
  const expiresAtMs = NOW_MS + 60_000;
  const client = await attachOpenedClient(harness, {
    connectionId: "client-warning-e2e",
    expiresAtMs,
  });
  assert.equal(harness.absolute.tasks.length, 2);
  const [exactExpiry, warning] = harness.absolute.tasks;
  assert.equal(exactExpiry.expiresAtMs, expiresAtMs);
  assert.equal(warning.expiresAtMs, expiresAtMs - 60_000);

  harness.absolute.fire(warning);
  await settle();
  assert.deepEqual(
    client.socket.sentFrames().map((frame) => frame.type),
    ["relay.welcome", "auth.expiring"],
    "the warning follows the reserved welcome on the client socket",
  );
  assert.deepEqual(JSON.parse(Buffer.from(client.socket.sends[1]).toString("utf8")), {
    protocolVersion: 2,
    kind: "event",
    type: "auth.expiring",
    payload: {
      grantId: "client-warning-e2e-grant",
      expiresAtMs,
      refreshRecommendedAtMs: expiresAtMs - 300_000,
    },
  });

  harness.absolute.fire(warning, { includeCancelled: true });
  await settle();
  assert.equal(client.socket.sends.length, 2, "the once latch never re-emits");

  const firstHostData = await harness.hostBroker.receiveHostFrame(
    harness.transportId,
    carrierBytes(hostRouteData(client.routeOpen.frame, "1", hostTerminalInputAck())),
  );
  assert.equal(
    firstHostData.accepted,
    true,
    "the broker-owned warning consumes no host sequence: the initial host_to_client seq is still expected after auth.expiring",
  );
  await settle();
  assert.deepEqual(
    client.socket.sentFrames().map((frame) => frame.type),
    ["relay.welcome", "auth.expiring", "terminal.input_ack"],
    "the first host route.data frame follows the broker control event intact",
  );
  assert.deepEqual(JSON.parse(Buffer.from(client.socket.sends[2]).toString("utf8")), {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId: "warning-stream",
    payload: { generation: "generation-1", ackedThroughInputSeq: "0" },
  });

  harness.now.value = expiresAtMs;
  harness.absolute.fire(exactExpiry);
  await settle();
  assert.deepEqual(client.socket.closes, [{ code: 4401, reason: "access_expired" }]);
  const closeDeadline = harness.closeDeadlines.tasks[0];
  assert.equal(closeDeadline.delayMs, 5_000);
  harness.closeDeadlines.fire(closeDeadline);
  assert.equal(client.socket.terminates, 1);
  client.socket.emit("close", 1006);
  await client.handle.drained;
  const unbind = harness.hostBroker.drainHostCarrier(harness.transportId)
    .find((delivery) => delivery.frame.type === "route.unbind");
  assert.ok(unbind);
  await completeRouteUnbind(harness, unbind, "1");
  await harness.composition.closeAndDrain();
});

test("a client warning queue overflow closes only this client and never seals the composition", async () => {
  const harness = await createHarness();
  const socket = new StrictFakeSocket(harness.log);
  socket.sendBlocked = true;
  const client = await attachOpenedClient(harness, {
    connectionId: "client-warning-overflow",
    expiresAtMs: NOW_MS + 60_000,
    socket,
  });
  const [, warning] = harness.absolute.tasks;

  // The blocked send keeps every delivery billed: the reserved welcome plus
  // 127 contiguous host route.data frames charge the route to exactly the
  // 128-frame budget (127+1 is still admitted), so the warning's +1 is the
  // precise 129th frame that overflows the enqueue.
  for (let index = 0; index < brokerModule.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames - 1; index += 1) {
    const accepted = await harness.hostBroker.receiveHostFrame(
      harness.transportId,
      carrierBytes(hostRouteData(
        client.routeOpen.frame,
        `${index + 1}`,
        hostTerminalInputAck(),
      )),
    );
    assert.equal(accepted.accepted, true, `route.data ${index + 1} still fits the route budget`);
  }

  harness.absolute.fire(warning);
  await settle();
  assert.deepEqual(
    socket.closes,
    [{ code: 1013, reason: "slow_consumer" }],
    "queue rejection closes only this client as a slow consumer",
  );
  assert.deepEqual(
    socket.sentFrames().map((frame) => frame.type),
    ["relay.welcome"],
    "the overflowed warning is never queued behind the reserved welcome",
  );
  const [unbind] = harness.hostBroker.drainHostCarrier(harness.transportId, { maxFrames: 1 });
  assert.equal(unbind.frame.type, "route.unbind");
  assert.equal(unbind.frame.payload.reason, "slow_consumer");
  await completeRouteUnbind(harness, unbind, "127");

  const reopened = await attachOpenedClient(harness, {
    connectionId: "client-after-warning-overflow",
  });
  assert.deepEqual(
    reopened.socket.sentFrames().map((frame) => frame.type),
    ["relay.welcome"],
    "a fresh client still completes the handshake: the queue rejection never seals the composition",
  );

  socket.releaseBlockedSends();
  socket.emit("close", 1006);
  await client.handle.drained;
  reopened.socket.emit("close", 1000);
  await reopened.handle.drained;
  await harness.composition.closeAndDrain();
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
  const partial = prepareClient(harness, { connectionId: "partial-client" });
  harness.admitClientSocket(socket);
  try {
    assert.throws(() => harness.clientWssRuntime.attachPreparedClientWss({
      admissionReceipt: partial.admissionReceipt,
      alreadyUpgradedSocket: socket,
    }), /closing|construction failed/);
  } finally {
    harness.releaseClientSocket(socket);
  }
  assert.ok(closeFromAttach);
  assert.strictEqual(harness.composition.closeAndDrain(), closeFromAttach);
  const late = harness.composition.prepareClientWss({
    connectionId: "late-client",
    trustedAuthContext: authContext("client", { jti: "late-client-jti" }),
    hostProducerTarget: harness.producer.target,
  });
  assert.equal(late.outcome, "reject");
  assert.equal(late.status, 503);
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

test("private client socket capture and Host WSS runtime hold independent one-shot claims", async () => {
  const harness = await createHarness();
  const hostRuntime = compositionModule.installRelayV2BrokerHostWssRuntime(
    harness.composition,
    StrictFakeSocket.prototype,
    () => false,
  );
  assert.equal(typeof hostRuntime.prepareHostWss, "function");
  assert.throws(() => harness.clientWssRuntime.installTrustedSocketCapture(
    StrictFakeSocket.prototype,
    () => false,
  ), /already installed/);
  assert.throws(() => compositionModule.installRelayV2BrokerHostWssRuntime(
    harness.composition,
    StrictFakeSocket.prototype,
    () => false,
  ), /already installed/);
  await harness.composition.closeAndDrain();
});
