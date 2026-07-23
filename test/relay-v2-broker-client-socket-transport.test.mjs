import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const adapterModule = await import("../dist/relay/v2/brokerClientSocketTransport.js");
const producerModule = await import("../dist/relay/v2/brokerProducerRegistry.js");
const closeOwner = await import("../dist/relay/v2/brokerTransportCloseCoordinator.js");
const codec = await import("../dist/relay/v2/codec.js");

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

function publicBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
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

function clientHello(requestId = randomUUID()) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "client.hello",
    requestId,
    hostId: HOST_ID,
    payload: {
      clientInstanceId: "android-install",
      capabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      requiredCapabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      resume: null,
    },
  };
}

function hostWelcome(requestId, hostEpoch, hostInstanceId) {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "host.welcome",
    requestId,
    hostId: HOST_ID,
    hostEpoch,
    hostInstanceId,
    payload: {
      selectedVersion: 2,
      capabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      eventSeq: "0",
      resumeDisposition: "snapshot_required",
      resumeReason: "fresh",
      commandDedupeWindow: {
        windowId: randomUUID(),
        windowSeq: "1",
        acceptUntilMs: NOW_MS + 60_000,
        queryUntilMs: NOW_MS + 600_000,
      },
      limits: {
        commandResultRetentionMs: 86_400_000,
        commandDedupeRetentionMs: 604_800_000,
        maxCommandQueryIds: 32,
        stateSnapshotChunkBytes: 524_288,
        stateSnapshotChunkRecords: 256,
        stateSnapshotMaxBytes: 268_435_456,
        stateSnapshotMaxRecords: 100_000,
        stateSnapshotIdleLeaseMs: 300_000,
        stateSnapshotMaxLifetimeMs: 3_600_000,
        stateSnapshotMaxPinnedPerPrincipal: 2,
        stateSnapshotMaxPinnedPerHost: 16,
        stateSnapshotPinnedBytesPerHost: 536_870_912,
        stateSnapshotPinnedMetadataBytesPerHost: 16_777_216,
        stateSnapshotChunkMaxJsonKeys: 8_192,
        stateSnapshotChunkMaxJsonNodes: 16_384,
        terminalReplayBytesPerStream: 4_194_304,
        terminalReplayBytesPerHost: 67_108_864,
        terminalDetachedLeaseMs: 120_000,
        terminalControlDedupeRetentionMs: 600_000,
        terminalMaxUnackedBytes: 524_288,
        terminalMaxFrameBytes: 65_536,
        terminalInputDedupeEntriesPerStream: 512,
        terminalResizeDedupeEntriesPerStream: 256,
        terminalMaxStreamsPerHost: 256,
        terminalControlRecordsPerHost: 4_096,
        brokerRouteBufferedBytesPerDirection: 1_048_576,
        brokerRouteLowWaterBytesPerDirection: 524_288,
      },
    },
  };
}

function clientTerminalAck(streamId = randomUUID()) {
  return {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.output_ack",
    streamId,
    payload: { generation: "generation-1", nextOffset: "0" },
  };
}

function hostTerminalAck(streamId = randomUUID()) {
  return {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId,
    payload: { generation: "generation-1", ackedThroughInputSeq: "0" },
  };
}

async function settleReadyTurns(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function createScheduler({ synchronous = false } = {}) {
  const tasks = [];
  return {
    tasks,
    schedule(delayMs, callback) {
      if (synchronous) {
        callback();
        return () => {};
      }
      const task = { delayMs, callback, cancelled: false };
      tasks.push(task);
      return () => { task.cancelled = true; };
    },
    runNext(delayMs) {
      const index = tasks.findIndex((task) => !task.cancelled && task.delayMs === delayMs);
      if (index < 0) return false;
      const [task] = tasks.splice(index, 1);
      if (!task.cancelled) task.callback();
      return true;
    },
    runAll(delayMs, limit = 1_000) {
      let count = 0;
      while (this.runNext(delayMs)) {
        count += 1;
        if (count > limit) throw new Error("scheduler did not quiesce");
      }
      return count;
    },
  };
}

function createSocket(overrides = {}) {
  const state = {
    buffer: { bytes: 0, frames: 0 },
    sends: [],
    pauses: 0,
    resumes: 0,
    closes: [],
    destroys: 0,
    sendReceipt: "applied",
    pauseReceipt: "applied",
    resumeReceipt: "applied",
    closeReceipt: "applied",
    destroyReceipt: "applied",
    sendThrows: false,
    synchronousCompletions: [],
    onPause: null,
    onResume: null,
    ...overrides,
  };
  const port = Object.create(null);
  Object.defineProperties(port, {
    bufferedState: {
      value() { return { bytes: state.buffer.bytes, frames: state.buffer.frames }; },
    },
    send: {
      value(bytes, complete) {
        if (state.sendThrows) throw new Error("socket send failed");
        state.sends.push({ bytes, complete });
        for (const receipt of state.synchronousCompletions) complete(receipt);
        return state.sendReceipt;
      },
    },
    pause: {
      value() {
        state.pauses += 1;
        return state.onPause ? state.onPause() : state.pauseReceipt;
      },
    },
    resume: {
      value() {
        state.resumes += 1;
        return state.onResume ? state.onResume() : state.resumeReceipt;
      },
    },
    close: {
      value(code, reason) {
        state.closes.push({ code, reason });
        return state.closeReceipt;
      },
    },
    forceDestroy: {
      value() {
        state.destroys += 1;
        return state.destroyReceipt;
      },
    },
  });
  return { port, state };
}

function createProducerRegistry(transportId = "host-pump", overrides = {}) {
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  const calls = { apply: [], forceTerminal: [] };
  const port = Object.create(null);
  Object.defineProperties(port, {
    apply: {
      value(actions, fence) {
        calls.apply.push({ actions, fence });
        return overrides.apply
          ? overrides.apply(actions, fence)
          : fence.mayApply() ? "applied" : "rejected";
      },
    },
    forceTerminal: {
      value(failure, fence) {
        calls.forceTerminal.push({ failure, fence });
        return overrides.forceTerminal
          ? overrides.forceTerminal(failure, fence)
          : fence.mayApply() ? "applied" : "rejected";
      },
    },
  });
  const registration = registry.registerHostProducer(transportId, port);
  return { registry, registration, calls };
}

async function registerCoreHost(core, transportId, connectionIncarnation) {
  const hello = hostHello();
  core.attachHostCarrier(
    transportId,
    authContext("host", { jti: `${transportId}-jti` }),
    connectionIncarnation,
  );
  const result = await core.receiveHostFrame(transportId, carrierBytes(hello));
  const registration = result.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.registered"
  ));
  assert.ok(registration);
  assert.equal(
    core.acknowledgeHostControlDelivery(transportId, registration.deliveryId).accepted,
    true,
  );
  return { hello, connectorId: registration.frame.connectorId };
}

async function createBaseComposition(options = {}) {
  const transportId = options.transportId ?? "host-pump";
  const hostIncarnation = options.hostIncarnation ?? `${transportId}-incarnation`;
  const scheduler = options.scheduler ?? createScheduler();
  const producer = createProducerRegistry(transportId, options.producerOverrides);
  const binding = options.bindHost === false
    ? undefined
    : producer.registration.bindConnectionIncarnation(hostIncarnation);
  const composition = adapterModule.createRelayV2BrokerClientSocketTransportComposition({
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    producerRegistry: producer.registry,
    resolveHostProducerBinding: (fence) => (
      options.resolveHostProducerBinding
        ? options.resolveHostProducerBinding(fence, binding)
        : binding
    ),
    scheduler,
    deliveryTimeoutMs: 5_000,
    closeTimeoutMs: 5_000,
  });
  const host = await registerCoreHost(
    composition.broker,
    transportId,
    hostIncarnation,
  );
  await settleReadyTurns();
  producer.calls.apply.length = 0;
  producer.calls.forceTerminal.length = 0;
  return {
    ...composition,
    transport: composition.clientSocketTransport,
    scheduler,
    producer,
    binding,
    transportId,
    hostIncarnation,
    host,
  };
}

async function createClientHarness(options = {}) {
  const base = await createBaseComposition(options);
  const connectionId = options.connectionId ?? `client-${randomUUID()}`;
  const socket = options.socket ?? createSocket(options.socketOptions);
  const registration = base.transport.registerClientSocket({
    connectionId,
    authContext: authContext("client", { jti: `${connectionId}-jti` }),
    hostProducerTarget: base.producer.registration.target,
    socket: socket.port,
  });
  assert.equal(registration.openResult.accepted, true);
  const [delivery] = base.broker.drainHostCarrier(base.transportId, { maxFrames: 1 });
  assert.equal(delivery.frame.type, "route.open");
  assert.equal(base.broker.acknowledgeHostDelivery(
    base.transportId,
    delivery.deliveryId,
  ).accepted, true);
  const opened = await base.broker.receiveHostFrame(base.transportId, carrierBytes({
    carrierVersion: 1,
    type: "route.opened",
    requestId: delivery.frame.requestId,
    connectorId: delivery.frame.connectorId,
    routeId: delivery.frame.routeId,
    routeFence: delivery.frame.routeFence,
    payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
  }));
  assert.equal(opened.accepted, true);
  assert.equal(socket.state.sends.length, 0, "Core output stays closed before route_opened action");
  for (const action of opened.actions) {
    assert.equal(base.transport.applyBrokerAction(action), "applied");
  }
  await settleReadyTurns();
  assert.equal(socket.state.sends.length, socket.state.destroys === 0 ? 1 : 0);
  if (socket.state.sends.length === 1) {
    codec.decodeRelayV2WebSocketFrame(
      "public",
      socket.state.sends[0].bytes,
      { opcode: "text", compressed: false },
    );
    assert.deepEqual(JSON.parse(Buffer.from(socket.state.sends[0].bytes).toString("utf8")), {
      protocolVersion: 2,
      kind: "event",
      type: "relay.welcome",
      payload: {
        selectedVersion: 2,
        connectionId,
        brokerEpoch: base.broker.brokerEpoch,
        principalId: "client-principal",
        capabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
        limits: {
          maxFrameBytes: brokerModule.RELAY_V2_BROKER_LIMITS.maxFrameBytes,
          maxCarrierFrameBytes: brokerModule.RELAY_V2_BROKER_LIMITS.maxCarrierFrameBytes,
          brokerRouteBufferedBytesPerDirection:
            brokerModule.RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection,
          brokerRouteLowWaterBytesPerDirection:
            brokerModule.RELAY_V2_BROKER_LIMITS.routeLowWaterBytesPerDirection,
          brokerCarrierBufferedBytes: brokerModule.RELAY_V2_BROKER_LIMITS.carrierBufferedBytes,
          brokerCarrierLowWaterBytes: brokerModule.RELAY_V2_BROKER_LIMITS.carrierLowWaterBytes,
          maxQueuedRouteFrames: brokerModule.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames,
          maxInFlightRequestsPerRoute:
            brokerModule.RELAY_V2_BROKER_LIMITS.maxInFlightRequestsPerRoute,
        },
      },
    });
    socket.state.sends[0].complete("delivered");
    await settleReadyTurns();
    socket.state.sends.length = 0;
  }
  base.producer.calls.apply.length = 0;
  base.producer.calls.forceTerminal.length = 0;
  return {
    ...base,
    connectionId,
    socket,
    registration,
    route: {
      connectorId: delivery.frame.connectorId,
      routeId: delivery.frame.routeId,
      routeFence: delivery.frame.routeFence,
    },
    hostSeq: 0,
  };
}

function enqueueHostData(harness, frame = hostTerminalAck()) {
  harness.hostSeq += 1;
  const wire = publicBytes(frame);
  const result = harness.broker.receiveHostFrame(harness.transportId, carrierBytes({
    carrierVersion: 1,
    type: "route.data",
    ...harness.route,
    direction: "host_to_client",
    seq: String(harness.hostSeq),
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(wire).toString("base64"),
    },
  }));
  return { wire, result };
}

function observeCoreMethod(core, name) {
  const original = core[name].bind(core);
  const calls = [];
  Object.defineProperty(core, name, {
    configurable: true,
    value(...args) {
      calls.push(args);
      return original(...args);
    },
  });
  return calls;
}

async function completeRouteUnbind(harness) {
  const [delivery] = harness.broker.drainHostCarrier(
    harness.transportId,
    { maxFrames: 1 },
  );
  assert.equal(delivery.frame.type, "route.unbind");
  assert.equal(harness.broker.acknowledgeHostDelivery(
    harness.transportId,
    delivery.deliveryId,
  ).accepted, true);
  const result = await harness.broker.receiveHostFrame(harness.transportId, carrierBytes({
    carrierVersion: 1,
    type: "route.unbound",
    connectorId: delivery.frame.connectorId,
    routeId: delivery.frame.routeId,
    routeFence: delivery.frame.routeFence,
    payload: {
      reason: delivery.frame.payload.reason,
      lastClientToHostSeq: delivery.frame.payload.lastClientToHostSeq,
      lastHostToClientSeq: String(harness.hostSeq),
    },
  }));
  assert.equal(result.accepted, true);
}

test("Broker ready fences are exact; client ACK does not manufacture a ready turn", async () => {
  const ready = [];
  const core = new brokerModule.RelayV2BrokerCore({
    now: () => NOW_MS,
    baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    outputReadyPort: { ready(fence) { ready.push(fence); } },
  });
  const host = await registerCoreHost(core, "host-ready", "host-ready-incarnation");
  const connectionId = "client-ready";
  const connectionIncarnation = "client-ready-incarnation";
  assert.equal(core.openClientRoute(
    connectionId,
    authContext("client"),
    connectionIncarnation,
  ).accepted, true);
  const hostFence = ready.at(-1);
  assert.deepEqual(
    [hostFence.kind, hostFence.transportId, hostFence.connectionIncarnation],
    ["host", "host-ready", "host-ready-incarnation"],
  );
  assert.equal(brokerModule.relayV2BrokerOutputReadyMayDrain(hostFence), true);
  const [openDelivery] = core.drainHostCarrier("host-ready", { maxFrames: 1 });
  assert.equal(brokerModule.relayV2BrokerOutputReadyMayDrain(hostFence), false);
  core.acknowledgeHostDelivery("host-ready", openDelivery.deliveryId);
  const opened = await core.receiveHostFrame("host-ready", carrierBytes({
    carrierVersion: 1,
    type: "route.opened",
    requestId: openDelivery.frame.requestId,
    connectorId: host.connectorId,
    routeId: openDelivery.frame.routeId,
    routeFence: openDelivery.frame.routeFence,
    payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
  }));
  assert.equal(opened.actions[0].connectionIncarnation, connectionIncarnation);

  const identity = {
    connectorId: host.connectorId,
    routeId: openDelivery.frame.routeId,
    routeFence: openDelivery.frame.routeFence,
  };
  for (const seq of ["1"]) {
    await core.receiveHostFrame("host-ready", carrierBytes({
      carrierVersion: 1,
      type: "route.data",
      ...identity,
      direction: "host_to_client",
      seq,
      payload: {
        opcode: "text",
        encoding: "base64",
        data: Buffer.from(publicBytes(hostTerminalAck(`host-${seq}`))).toString("base64"),
      },
    }));
  }
  const clientFence = ready.at(-1);
  assert.equal(clientFence.kind, "client");
  const readyCount = ready.length;
  const [first] = core.drainClient(connectionId, { maxFrames: 1 });
  assert.equal(brokerModule.relayV2BrokerOutputReadyMayDrain(clientFence), true);
  assert.equal(core.acknowledgeClientDelivery(connectionId, first.deliveryId).accepted, true);
  assert.equal(ready.length, readyCount, "ACK does not create a zero-delay ready chain");
  assert.equal(core.drainClient(connectionId, { maxFrames: 1 }).length, 1);
  assert.equal(brokerModule.relayV2BrokerOutputReadyMayDrain(clientFence), false);
  assert.equal(brokerModule.relayV2BrokerOutputReadyMayDrain({ ...clientFence }), false);

  const fatalCore = new brokerModule.RelayV2BrokerCore({
    now: () => NOW_MS,
    baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    outputReadyPort: { ready() { throw new Error("sink failed"); } },
  });
  await registerCoreHost(fatalCore, "host-fatal-ready", "host-fatal-incarnation");
  assert.doesNotThrow(() => fatalCore.openClientRoute(
    "client-fatal-ready",
    authContext("client"),
  ));
  assert.equal(fatalCore.outputReadyCompositionState, "latched_fail_closed");
  assert.equal(fatalCore.inspectClientAdmission(authContext("client")).outcome, "reject");
});

test("factory closes the pre-bind gap and Host ready crosses only the opaque B7a binding", async () => {
  const producer = createProducerRegistry("host-factory");
  const hostIncarnation = "host-factory-incarnation";
  const binding = producer.registration.bindConnectionIncarnation(hostIncarnation);
  let insideCoreCall = false;
  let resolverCalls = 0;
  const composition = adapterModule.createRelayV2BrokerClientSocketTransportComposition({
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    producerRegistry: producer.registry,
    resolveHostProducerBinding(fence) {
      resolverCalls += 1;
      assert.equal(insideCoreCall, false, "resolver is deferred outside the Core mutation");
      assert.equal(fence.connectionIncarnation, hostIncarnation);
      return binding;
    },
    scheduler: createScheduler(),
  });
  await registerCoreHost(composition.broker, "host-factory", hostIncarnation);
  const socket = createSocket();
  insideCoreCall = true;
  const registration = composition.clientSocketTransport.registerClientSocket({
    connectionId: "client-factory",
    authContext: authContext("client"),
    hostProducerTarget: producer.registration.target,
    socket: socket.port,
  });
  insideCoreCall = false;
  assert.equal(registration.openResult.accepted, true);
  assert.equal(resolverCalls, 0);
  assert.equal(producer.calls.apply.length, 0);
  await settleReadyTurns();
  assert.equal(resolverCalls, 1);
  assert.equal(producer.calls.apply.length, 1);
  assert.deepEqual(
    producer.calls.apply[0].actions.map((action) => action.kind),
    ["host_output_ready"],
  );
  assert.equal(socket.state.sends.length, 0, "route.open cannot emit welcome before route.opened");
});

test("route_opened opens one Core-owned relay.welcome drain before Host application data", async () => {
  const h = await createClientHarness({ connectionId: "client-core-welcome-order" });
  assert.equal(h.socket.state.sends.length, 0, "the helper consumed exactly the initial welcome");
  const hostData = enqueueHostData(h, hostTerminalAck("after-welcome"));
  await hostData.result;
  await settleReadyTurns();
  assert.equal(h.socket.state.sends.length, 1);
  assert.deepEqual(
    [...h.socket.state.sends[0].bytes],
    [...hostData.wire],
  );
});

test("one Host wake is coalesced until delivery, then a real ACK reissues the same epoch", async () => {
  const h = await createClientHarness({ connectionId: "client-host-ready-recovery" });
  assert.equal(h.registration.receive(
    publicBytes(clientTerminalAck("client-a")),
    { opcode: "text", compressed: false },
  ).accepted, true);
  assert.equal(h.registration.receive(
    publicBytes(clientTerminalAck("client-b")),
    { opcode: "text", compressed: false },
  ).accepted, true);
  await settleReadyTurns();
  const wakes = () => h.producer.calls.apply.flatMap((call) => call.actions)
    .filter((action) => action.kind === "host_output_ready");
  assert.equal(wakes().length, 1);
  const [first] = h.broker.drainHostCarrier(h.transportId, { maxFrames: 1 });
  assert.equal(first.frame.type, "route.data");
  assert.equal(h.broker.acknowledgeHostDelivery(h.transportId, first.deliveryId).accepted, true);
  await settleReadyTurns();
  assert.equal(wakes().length, 2);
  assert.equal(wakes()[1].readyEpoch, wakes()[0].readyEpoch);
});

test("opaque producer binding is canonical and stale replacement fences cannot wake or kill new owners", async () => {
  const producer = createProducerRegistry("host-binding");
  const first = producer.registration.bindConnectionIncarnation("incarnation-first");
  assert.equal(
    producer.registration.bindConnectionIncarnation("incarnation-first"),
    first,
  );
  assert.throws(
    () => producer.registration.bindConnectionIncarnation("incarnation-other"),
    /already bound/,
  );
  assert.equal(
    producer.registry.resolveHostProducerBinding(
      first,
      "host-binding",
      "incarnation-first",
    ),
    producer.registration.target,
  );
  assert.throws(() => producer.registration.beginClose({}), /native Promise/);
  assert.equal(
    producer.registry.resolveHostProducerBinding(
      first,
      "host-binding",
      "incarnation-first",
    ),
    undefined,
  );
  const replacementCalls = { apply: [], forceTerminal: [] };
  const replacementAdapter = Object.create(null);
  Object.defineProperties(replacementAdapter, {
    apply: { value(actions, fence) {
      replacementCalls.apply.push(actions);
      return fence.mayApply() ? "applied" : "rejected";
    } },
    forceTerminal: { value(failure, fence) {
      replacementCalls.forceTerminal.push(failure);
      return fence.mayApply() ? "applied" : "rejected";
    } },
  });
  const replacement = producer.registry.registerHostProducer("host-binding", replacementAdapter);
  replacement.bindConnectionIncarnation("incarnation-replacement");
  assert.equal(
    producer.registry.inspectHostProducerOwner("host-binding", "incarnation-first").status,
    "stale",
  );
  assert.equal(replacementCalls.apply.length, 0);

  const live = await createBaseComposition({ transportId: "host-binding-race" });
  const socket = createSocket();
  live.transport.registerClientSocket({
    connectionId: "client-binding-race",
    authContext: authContext("client"),
    hostProducerTarget: live.producer.registration.target,
    socket: socket.port,
  });
  assert.throws(() => live.producer.registration.beginClose({}), /native Promise/);
  const nextCalls = { apply: 0, forceTerminal: 0 };
  const nextProducerPort = Object.create(null);
  Object.defineProperties(nextProducerPort, {
    apply: { value(_actions, fence) {
      nextCalls.apply += 1;
      return fence.mayApply() ? "applied" : "rejected";
    } },
    forceTerminal: { value(_failure, fence) {
      nextCalls.forceTerminal += 1;
      return fence.mayApply() ? "applied" : "rejected";
    } },
  });
  const next = live.producer.registry.registerHostProducer(
    "host-binding-race",
    nextProducerPort,
  );
  next.bindConnectionIncarnation("replacement-incarnation");
  await settleReadyTurns();
  assert.deepEqual(nextCalls, { apply: 0, forceTerminal: 0 });
});

test("a missing or throwing resolver fail-closes the exact current producer", async () => {
  for (const mode of ["missing", "throwing"]) {
    const base = await createBaseComposition({
      transportId: `host-resolver-${mode}`,
      resolveHostProducerBinding(_fence, binding) {
        if (mode === "throwing") throw new Error("resolver failed");
        assert.ok(binding);
        return undefined;
      },
    });
    base.transport.registerClientSocket({
      connectionId: `client-resolver-${mode}`,
      authContext: authContext("client", { jti: `client-resolver-${mode}-jti` }),
      hostProducerTarget: base.producer.registration.target,
      socket: createSocket().port,
    });
    await settleReadyTurns();
    assert.equal(base.producer.calls.forceTerminal.length, 1, mode);
    assert.deepEqual(
      base.producer.calls.forceTerminal[0].failure.target,
      base.producer.registration.target,
    );
  }
});

test("async completions advance one frame each; sync completions stop until writable", async () => {
  const asyncHarness = await createClientHarness({ connectionId: "client-async-complete" });
  const asyncAcks = observeCoreMethod(asyncHarness.broker, "acknowledgeClientDelivery");
  const asyncFirst = enqueueHostData(asyncHarness, hostTerminalAck("async-1"));
  const asyncSecond = enqueueHostData(asyncHarness, hostTerminalAck("async-2"));
  await Promise.all([asyncFirst.result, asyncSecond.result]);
  await settleReadyTurns();
  assert.equal(asyncHarness.socket.state.sends.length, 1);
  asyncHarness.socket.state.sends[0].complete("delivered");
  assert.equal(asyncHarness.socket.state.sends.length, 2, "one real completion advances one frame");
  asyncHarness.socket.state.sends[1].complete("delivered");
  assert.equal(asyncAcks.length, 2);

  const syncSocket = createSocket({ synchronousCompletions: ["delivered"] });
  const syncHarness = await createClientHarness({
    connectionId: "client-sync-complete",
    socket: syncSocket,
  });
  const syncAcks = observeCoreMethod(syncHarness.broker, "acknowledgeClientDelivery");
  const syncFirst = enqueueHostData(syncHarness, hostTerminalAck("sync-1"));
  const syncSecond = enqueueHostData(syncHarness, hostTerminalAck("sync-2"));
  await Promise.all([syncFirst.result, syncSecond.result]);
  await settleReadyTurns(20);
  assert.equal(syncSocket.state.sends.length, 1, "same epoch never self-pumps in microtasks");
  assert.equal(syncAcks.length, 1);
  assert.equal(syncHarness.registration.writable(), "applied");
  assert.equal(syncSocket.state.sends.length, 2);
  assert.equal(syncAcks.length, 2);
});

test("only the first literal completion ACKs; synchronous deadlines cannot leave immortal sends", async () => {
  const firstReceiptSocket = createSocket();
  const firstReceipt = await createClientHarness({
    connectionId: "client-first-receipt",
    socket: firstReceiptSocket,
  });
  firstReceiptSocket.state.synchronousCompletions = ["rejected", "delivered"];
  const firstReceiptAcks = observeCoreMethod(firstReceipt.broker, "acknowledgeClientDelivery");
  await enqueueHostData(firstReceipt).result;
  await settleReadyTurns();
  assert.equal(firstReceiptSocket.state.sends.length, 1);
  assert.equal(firstReceiptAcks.length, 0, "rejected then delivered never ACKs");
  assert.equal(firstReceiptSocket.state.closes.length, 1);

  const synchronousScheduler = createScheduler({ synchronous: true });
  const timeout = await createClientHarness({
    connectionId: "client-sync-deadline",
    scheduler: synchronousScheduler,
  });
  const timeoutAcks = observeCoreMethod(timeout.broker, "acknowledgeClientDelivery");
  await enqueueHostData(timeout).result;
  await settleReadyTurns();
  assert.equal(timeout.socket.state.sends.length, 0, "early-fired deadline prevents send");
  assert.equal(timeoutAcks.length, 0);
  assert.equal(timeout.socket.state.destroys, 1, "early-fired close deadline also terminates");
});

test("socket buffer accounting bounds one writable drain and delivery bytes are copied", async () => {
  const h = await createClientHarness({ connectionId: "client-buffer-accounting" });
  h.socket.state.buffer.bytes = brokerModule.RELAY_V2_BROKER_LIMITS
    .routeBufferedBytesPerDirection - 1;
  h.socket.state.buffer.frames = 7;
  const queued = enqueueHostData(h, hostTerminalAck("buffered"));
  const original = queued.wire.slice();
  queued.wire[0] ^= 0xff;
  assert.equal(h.registration.writable(), "applied");
  assert.equal(h.socket.state.sends.length, 0);
  h.socket.state.buffer = { bytes: 0, frames: 0 };
  assert.equal(h.registration.writable(), "applied");
  assert.equal(h.socket.state.sends.length, 1);
  assert.deepEqual([...h.socket.state.sends[0].bytes], [...original]);
  await queued.result;
  await settleReadyTurns(20);
  assert.equal(h.socket.state.sends.length, 1, "ready turn does not busy-spin around in-flight data");
  assert.equal(h.scheduler.runAll(0), 0);
});

test("pause/resume is exact-once under synchronous reentry and stale incarnations are inert", async () => {
  let harness;
  let reentrantReceipt;
  const socket = createSocket({
    onPause() {
      reentrantReceipt = harness.transport.applyBrokerAction({
        kind: "pause_client",
        connectionId: harness.connectionId,
        connectionIncarnation: harness.registration.connectionIncarnation,
      });
      return "applied";
    },
  });
  harness = await createClientHarness({ connectionId: "client-pause", socket });
  const pause = {
    kind: "pause_client",
    connectionId: harness.connectionId,
    connectionIncarnation: harness.registration.connectionIncarnation,
  };
  assert.equal(harness.transport.applyBrokerAction(pause), "applied");
  assert.equal(reentrantReceipt, "applied");
  assert.equal(socket.state.pauses, 1, "same desired reentry never repeats native pause");
  assert.equal(harness.transport.applyBrokerAction(pause), "applied");
  assert.equal(socket.state.pauses, 1);
  assert.equal(harness.transport.applyBrokerAction({
    ...pause,
    connectionIncarnation: randomUUID(),
  }), "rejected");
  assert.equal(socket.state.pauses, 1);
  assert.equal(harness.transport.applyBrokerAction({ ...pause, kind: "resume_client" }), "applied");
  assert.equal(socket.state.resumes, 1);

  let conflict;
  const conflictSocket = createSocket({
    onPause() {
      conflict = conflictHarness.transport.applyBrokerAction({
        kind: "resume_client",
        connectionId: conflictHarness.connectionId,
        connectionIncarnation: conflictHarness.registration.connectionIncarnation,
      });
      return "applied";
    },
  });
  let conflictHarness = await createClientHarness({
    connectionId: "client-pause-conflict",
    socket: conflictSocket,
  });
  assert.equal(conflictHarness.transport.applyBrokerAction({
    kind: "pause_client",
    connectionId: conflictHarness.connectionId,
    connectionIncarnation: conflictHarness.registration.connectionIncarnation,
  }), "rejected");
  assert.equal(conflict, "rejected");
  assert.equal(conflictSocket.state.closes.length, 1);
});

test("offline route sends only relay.unavailable and bounded close forces destruction", async () => {
  const producer = createProducerRegistry("host-offline-target");
  const scheduler = createScheduler();
  const composition = adapterModule.createRelayV2BrokerClientSocketTransportComposition({
    brokerOptions: { now: () => NOW_MS },
    producerRegistry: producer.registry,
    resolveHostProducerBinding: () => undefined,
    scheduler,
  });
  const socket = createSocket();
  const registration = composition.clientSocketTransport.registerClientSocket({
    connectionId: "client-offline",
    authContext: authContext("client"),
    hostProducerTarget: producer.registration.target,
    socket: socket.port,
  });
  assert.equal(registration.openResult.accepted, false);
  assert.equal(socket.state.sends.length, 1);
  const unavailable = codec.decodeRelayV2WebSocketFrame(
    "public",
    socket.state.sends[0].bytes,
    { opcode: "text", compressed: false },
  ).frame;
  assert.equal(unavailable.type, "relay.unavailable");
  assert.equal(Object.hasOwn(unavailable.payload, "capabilities"), false);
  socket.state.sends[0].complete("delivered");
  assert.deepEqual(socket.state.closes, [{ code: 1013, reason: "route_unavailable" }]);
  assert.equal(scheduler.runNext(5_000), true);
  assert.equal(socket.state.destroys, 1);
});

test("late delivery callbacks cannot ACK or mutate a replacement; close/error unbind once", async () => {
  const h = await createClientHarness({ connectionId: "client-replacement" });
  const acks = observeCoreMethod(h.broker, "acknowledgeClientDelivery");
  const unbinds = observeCoreMethod(h.broker, "unbindClient");
  await enqueueHostData(h, hostTerminalAck("old-delivery")).result;
  await settleReadyTurns();
  const lateComplete = h.socket.state.sends[0].complete;
  const closed = h.registration.closed();
  const errored = h.registration.errored();
  assert.deepEqual(errored, closed);
  assert.equal(unbinds.length, 1);
  await completeRouteUnbind(h);

  const replacementSocket = createSocket();
  const replacement = h.transport.registerClientSocket({
    connectionId: h.connectionId,
    authContext: authContext("client", { jti: "replacement-client-jti" }),
    hostProducerTarget: h.producer.registration.target,
    socket: replacementSocket.port,
  });
  assert.equal(replacement.openResult.accepted, true);
  assert.notEqual(replacement.connectionIncarnation, h.registration.connectionIncarnation);
  lateComplete("delivered");
  assert.equal(acks.length, 0);
  assert.equal(replacementSocket.state.closes.length, 0);
});

test("only current uncompressed text reaches Broker; invalid and stale input fail closed", async () => {
  const current = await createClientHarness({ connectionId: "client-input-current" });
  const forwarded = observeCoreMethod(current.broker, "forwardClientFrame");
  const input = publicBytes(clientTerminalAck("input-current"));
  const expected = input.slice();
  assert.equal(current.registration.receive(
    input,
    { opcode: "text", compressed: false },
  ).accepted, true);
  input[0] ^= 0xff;
  assert.deepEqual(forwarded[0][1], expected);

  for (const candidate of [
    { id: "binary", bytes: Uint8Array.of(1), metadata: { opcode: "binary", compressed: false } },
    { id: "compressed", bytes: Uint8Array.of(1), metadata: { opcode: "text", compressed: true } },
    {
      id: "oversize",
      bytes: new Uint8Array(brokerModule.RELAY_V2_BROKER_LIMITS.maxFrameBytes + 1),
      metadata: { opcode: "text", compressed: false },
    },
  ]) {
    const h = await createClientHarness({ connectionId: `client-input-${candidate.id}` });
    const calls = observeCoreMethod(h.broker, "forwardClientFrame");
    h.registration.receive(candidate.bytes, candidate.metadata);
    assert.equal(calls.length, 0, candidate.id);
    assert.equal(h.socket.state.closes[0].code, 4400, candidate.id);
  }
  current.registration.closed();
  assert.equal(current.registration.receive(
    publicBytes(clientTerminalAck("stale")),
    { opcode: "text", compressed: false },
  ).accepted, false);
  assert.equal(forwarded.length, 1);
});

test("handshake deadlines arm on welcome, switch on accepted hello, cancel on host.welcome", async () => {
  const scenarios = [
    { id: "hello-timeout", hello: false, welcome: false, firesAtMs: 5_000 },
    { id: "welcome-timeout", hello: true, welcome: false, firesAtMs: 10_000 },
    { id: "completed", hello: true, welcome: true, firesAtMs: null },
  ];
  for (const scenario of scenarios) {
    const h = await createClientHarness({ connectionId: `client-handshake-${scenario.id}` });
    let helloRequestId = null;
    if (scenario.hello) {
      helloRequestId = randomUUID();
      assert.equal(h.registration.receive(
        publicBytes(clientHello(helloRequestId)),
        { opcode: "text", compressed: false },
      ).accepted, true, scenario.id);
      assert.equal(
        h.scheduler.runNext(5_000),
        false,
        `${scenario.id}: accepted client.hello cancels the 5s deadline`,
      );
    }
    if (scenario.welcome) {
      const welcome = enqueueHostData(h, hostWelcome(
        helloRequestId,
        h.host.hello.payload.hostEpoch,
        h.host.hello.payload.hostInstanceId,
      ));
      await welcome.result;
      await settleReadyTurns();
      assert.equal(h.socket.state.sends.length, 1, scenario.id);
      h.socket.state.sends[0].complete("delivered");
      await settleReadyTurns();
      assert.equal(h.scheduler.runNext(5_000), false, scenario.id);
      assert.equal(h.scheduler.runNext(10_000), false, scenario.id);
      assert.equal(h.socket.state.closes.length, 0, scenario.id);
      assert.equal(h.registration.receive(
        publicBytes(clientHello()),
        { opcode: "text", compressed: false },
      ).accepted, true, scenario.id);
      assert.equal(
        h.scheduler.runNext(10_000),
        false,
        `${scenario.id}: a late accepted client.hello never restarts the deadline`,
      );
      assert.equal(h.socket.state.closes.length, 0, scenario.id);
      continue;
    }
    assert.equal(h.scheduler.runNext(scenario.firesAtMs), true, scenario.id);
    assert.deepEqual(h.socket.state.closes, [
      { code: 4408, reason: "handshake_timeout" },
    ], scenario.id);
  }
});

test("managed client transport consumes the coordinator incarnation lease exactly once", async () => {
  const base = await createBaseComposition();
  const coordinator = new closeOwner.RelayV2BrokerTransportCloseCoordinator();
  const socket = createSocket();
  const closeRegistration = coordinator.registerManagedClientSocket({
    connectionKind: "client",
    connectionId: "managed-client-transport",
    close: socket.port.close,
    forceDestroy: socket.port.forceDestroy,
  });
  const registration = base.transport.registerManagedClientSocket(
    closeRegistration.lease,
    {
      connectionId: "managed-client-transport",
      authContext: authContext("client", { jti: "managed-client-transport-jti" }),
      hostProducerTarget: base.producer.registration.target,
      socket: socket.port,
    },
  );
  assert.equal(
    registration.connectionIncarnation,
    closeRegistration.connectionIncarnation,
  );
  assert.throws(() => base.transport.registerManagedClientSocket(
    closeRegistration.lease,
    {
      connectionId: "managed-client-transport-replay",
      authContext: authContext("client", { jti: "managed-client-transport-replay-jti" }),
      hostProducerTarget: base.producer.registration.target,
      socket: createSocket().port,
    },
  ));
  registration.closed();
  assert.equal(
    coordinator.terminalAndUnregisterManagedSocket(closeRegistration.lease),
    true,
  );
});
