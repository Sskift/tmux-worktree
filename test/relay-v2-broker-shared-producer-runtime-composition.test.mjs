import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const pumpModule = await import("../dist/relay/v2/carrierPump.js");

const HOST_ID = "shared-producer-host";
const NOW_MS = 1_783_700_000_000;

function authContext(role) {
  return {
    scheme: "twcap2",
    role,
    hostId: HOST_ID,
    principalId: `${role}-principal`,
    grantId: `${role}-grant`,
    clientInstanceId: role === "client" ? "android-install" : null,
    jti: `${role}-${randomUUID()}`,
    kid: "kid-current",
    expiresAtMs: NOW_MS + 3_600_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
  };
}

class ManualScheduler {
  tasks = [];

  schedule = (delayMs, callback) => {
    const task = { delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };

  runNext(delayMs) {
    const task = this.tasks.find((candidate) => (
      !candidate.cancelled && candidate.delayMs === delayMs
    ));
    if (!task) throw new Error(`no scheduled shared-producer task at ${delayMs}ms`);
    task.cancelled = true;
    task.callback();
  }

  async flushReady(limit = 200) {
    for (let turn = 0; turn < limit; turn += 1) {
      const task = this.tasks.find((candidate) => (
        !candidate.cancelled && candidate.delayMs === 0
      ));
      if (task) {
        task.cancelled = true;
        task.callback();
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.tasks.some((candidate) => (
        !candidate.cancelled && candidate.delayMs === 0
      ))) return;
    }
    throw new Error("shared-producer scheduler did not settle");
  }
}

class FakeHostCarrier {
  constructor() {
    this.frames = [];
    this.phase = "offline";
    this.generation = "1";
    this.transport = null;
    this.nextDeliveryToken = 0;
  }

  connect(transport) {
    this.transport = transport;
    this.phase = "connecting";
    const hello = codec.encodeRelayV2WebSocketFrame("carrier", {
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
    });
    assert.equal(transport.trySend(hello, "host-hello"), true);
    return Object.freeze({
      generation: this.generation,
      receive: (bytes) => {
        const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
        this.frames.push(frame);
        if (frame.type === "host.registered") this.phase = "registered";
        if (frame.type === "route.open") {
          const opened = codec.encodeRelayV2WebSocketFrame("carrier", {
            carrierVersion: 1,
            type: "route.opened",
            requestId: frame.requestId,
            connectorId: frame.connectorId,
            routeId: frame.routeId,
            routeFence: frame.routeFence,
            payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
          });
          this.nextDeliveryToken += 1;
          assert.equal(
            this.transport.trySend(opened, `host-route-${this.nextDeliveryToken}`),
            true,
          );
        }
      },
      writable: () => {},
      acknowledge: () => {},
      rejectUnaccepted: () => {},
      closed: () => { this.phase = "offline"; },
    });
  }

  status() {
    return Object.freeze({
      phase: this.phase,
      generation: this.generation,
      closeCode: null,
    });
  }
}

class FakeClientSocket {
  constructor() {
    this.readyState = 1;
    this.protocol = "tw-relay.v2";
    this.extensions = "";
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.closes = [];
    this.pauseCalls = 0;
    this.terminates = 0;
    this.onInstalled = undefined;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    this.onInstalled?.(event, listeners.length);
    return this;
  }

  removeListener(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    return this;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      Reflect.apply(listener, this, args);
    }
  }

  send(_bytes, _options, callback) { callback(); }
  pause() { this.pauseCalls += 1; }
  resume() {}
  close(code, reason) { this.closes.push({ code, reason }); }
  terminate() { this.terminates += 1; }
}

test("sealed shared admission rejects untouched inputs while existing Pump effects remain live", async () => {
  const scheduler = new ManualScheduler();
  let callerBrokerActionCalls = 0;
  let callerForceActionCalls = 0;
  const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: scheduler,
    authorizationExpiryScheduleAt: () => () => {},
  });
  const host = new FakeHostCarrier();
  const pump = pumpModule.createRelayV2BrokerSharedProducerHostCarrierPump(
    shared.hostPumpAuthority,
    {
      host,
      transportId: "shared-producer-transport",
      hostAuthContext: authContext("host"),
      credentialReference: "host-credential-reference",
      now: () => NOW_MS,
      schedule: scheduler.schedule,
      onBrokerAction: () => { callerBrokerActionCalls += 1; },
      onForceBrokerAction: () => {
        callerForceActionCalls += 1;
        return false;
      },
    },
  );
  pump.start();
  await scheduler.flushReady();
  assert.equal(host.phase, "registered");

  const prepared = shared.clientWssRuntime.prepareClientWss({
    connectionId: "shared-producer-client",
    trustedAuthContext: authContext("client"),
    hostProducerTarget: pump.producerComposition.target,
  });
  assert.equal(prepared.outcome, "accept");
  const socket = new FakeClientSocket();
  const client = shared.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: prepared.admissionReceipt,
    alreadyUpgradedSocket: socket,
  });
  assert.equal(client.openResult.accepted, true);
  await scheduler.flushReady();
  assert.equal(
    host.frames.filter((frame) => frame.type === "route.open").length,
    1,
  );
  assert.equal(callerBrokerActionCalls, 0);
  assert.equal(callerForceActionCalls, 0);
  const clientFrame = codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "request",
    type: "client.hello",
    requestId: randomUUID(),
    hostId: HOST_ID,
    payload: {
      clientInstanceId: "android-install",
      capabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      requiredCapabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      resume: null,
    },
  });
  assert.equal(socket.listeners.get("message")?.length, 1);
  socket.emit("message", clientFrame, false);
  await scheduler.flushReady();
  const routeData = host.frames.filter((frame) => frame.type === "route.data");
  assert.equal(
    routeData.length,
    1,
    `a distinct registry would reject the exact ready binding before send_host; frames=${host.frames.map((frame) => frame.type).join(",")}; closes=${JSON.stringify(socket.closes)}; snapshot=${JSON.stringify(pump.snapshot())}`,
  );
  assert.deepEqual(
    Buffer.from(routeData[0].payload.data, "base64"),
    Buffer.from(clientFrame),
  );
  assert.equal(callerBrokerActionCalls, 0);
  assert.equal(callerForceActionCalls, 0);

  const pending = shared.clientWssRuntime.prepareClientWss({
    connectionId: "shared-producer-pending-client",
    trustedAuthContext: authContext("client"),
    hostProducerTarget: pump.producerComposition.target,
  });
  assert.equal(pending.outcome, "accept");
  const sealClientAdmission = shared.clientWssRuntime.sealClientAdmission;
  assert.strictEqual(
    shared.clientWssRuntime.sealClientAdmission,
    sealClientAdmission,
  );
  assert.equal(sealClientAdmission(), undefined);
  assert.equal(sealClientAdmission(), undefined);

  let hostilePrepareReads = 0;
  const hostilePrepareInput = new Proxy({}, {
    ownKeys() {
      hostilePrepareReads += 1;
      throw new Error("sealed prepare input must stay untouched");
    },
    getOwnPropertyDescriptor() {
      hostilePrepareReads += 1;
      throw new Error("sealed prepare descriptors must stay untouched");
    },
    get() {
      hostilePrepareReads += 1;
      throw new Error("sealed prepare properties must stay untouched");
    },
  });
  const sealedPrepare = shared.clientWssRuntime.prepareClientWss(hostilePrepareInput);
  assert.equal(sealedPrepare.outcome, "reject");
  assert.equal(sealedPrepare.status, 503);
  assert.equal(sealedPrepare.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(hostilePrepareReads, 0);

  let hostileSocketReads = 0;
  const hostileSocket = new Proxy({}, {
    ownKeys() {
      hostileSocketReads += 1;
      throw new Error("sealed socket must stay untouched");
    },
    getOwnPropertyDescriptor() {
      hostileSocketReads += 1;
      throw new Error("sealed socket descriptors must stay untouched");
    },
    getPrototypeOf() {
      hostileSocketReads += 1;
      throw new Error("sealed socket prototype must stay untouched");
    },
    get() {
      hostileSocketReads += 1;
      throw new Error("sealed socket properties must stay untouched");
    },
  });
  assert.throws(() => shared.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: pending.admissionReceipt,
    alreadyUpgradedSocket: hostileSocket,
  }), /runtime is closing/);
  assert.equal(hostileSocketReads, 0);

  pump.acceptBrokerResult({
    accepted: true,
    actions: [{
      kind: "pause_client",
      connectionId: client.connectionId,
      connectionIncarnation: client.incarnation,
    }],
  });
  await scheduler.flushReady();
  assert.equal(socket.pauseCalls, 1);
  assert.equal(callerBrokerActionCalls, 0);
  assert.equal(callerForceActionCalls, 0);
  assert.equal(sealClientAdmission(), undefined);

  socket.emit("close", 1000);
  await client.drained;
  const pumpClosed = pump.shutdown();
  await scheduler.flushReady();
  await pumpClosed;
  await shared.clientWssRuntime.closeAndDrain();
});

test("opaque owner keeps forced cleanup and reentrant seal rolls back a partial attach", async () => {
  const scheduler = new ManualScheduler();
  const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: scheduler,
    authorizationExpiryScheduleAt: () => () => {},
  });
  assert.deepEqual(Reflect.ownKeys(shared), ["clientWssRuntime", "hostPumpAuthority"]);
  assert.deepEqual(Reflect.ownKeys(shared.clientWssRuntime), [
    "sealClientAdmission",
    "prepareClientWss",
    "attachPreparedClientWss",
    "applyBrokerAction",
    "closeAndDrain",
  ]);
  assert.deepEqual(Reflect.ownKeys(shared.hostPumpAuthority), []);
  for (const forbidden of [
    "broker",
    "brokerCore",
    "hostPumpBrokerAuthority",
    "producerRegistry",
    "resolveHostProducerBinding",
  ]) {
    assert.equal(Object.hasOwn(shared, forbidden), false);
    assert.equal(Object.hasOwn(shared.clientWssRuntime, forbidden), false);
    assert.equal(Object.hasOwn(shared.hostPumpAuthority, forbidden), false);
  }

  let optionReads = 0;
  const hostileOptions = new Proxy({}, {
    ownKeys() {
      optionReads += 1;
      throw new Error("Pump options must not be read");
    },
    getOwnPropertyDescriptor() {
      optionReads += 1;
      throw new Error("Pump options must not be inspected");
    },
  });
  const authorityCases = [
    ["copied", Object.assign(Object.create(null), shared.hostPumpAuthority)],
    ["inherited", Object.create(shared.hostPumpAuthority)],
    ["proxied", new Proxy(shared.hostPumpAuthority, {})],
  ];
  for (const [label, candidate] of authorityCases) {
    assert.throws(
      () => pumpModule.createRelayV2BrokerSharedProducerHostCarrierPump(
        candidate,
        hostileOptions,
      ),
      /invalid Relay v2 shared-producer Host Pump authority/,
      label,
    );
  }
  assert.equal(optionReads, 0);

  const host = new FakeHostCarrier();
  const actionDeadlineMs = 17;
  const pump = pumpModule.createRelayV2BrokerSharedProducerHostCarrierPump(
    shared.hostPumpAuthority,
    {
      host,
      transportId: "shared-producer-race-transport",
      hostAuthContext: authContext("host"),
      credentialReference: "host-credential-reference",
      deliveryTimeoutMs: actionDeadlineMs,
      now: () => NOW_MS,
      schedule: scheduler.schedule,
    },
  );
  pump.start();
  await scheduler.flushReady();
  assert.equal(host.phase, "registered");

  const prepared = shared.clientWssRuntime.prepareClientWss({
    connectionId: "shared-producer-race-client",
    trustedAuthContext: authContext("client"),
    hostProducerTarget: pump.producerComposition.target,
  });
  assert.equal(prepared.outcome, "accept");
  const socket = new FakeClientSocket();
  const client = shared.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: prepared.admissionReceipt,
    alreadyUpgradedSocket: socket,
  });
  assert.equal(client.openResult.accepted, true);
  await scheduler.flushReady();

  pump.acceptBrokerResult({
    accepted: true,
    actions: [{
      kind: "pause_client",
      connectionId: client.connectionId,
      connectionIncarnation: client.incarnation,
    }],
  });
  scheduler.runNext(0);
  scheduler.runNext(actionDeadlineMs);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.pauseCalls, 0);

  scheduler.runNext(actionDeadlineMs);
  const receipt = await pump.whenCloseSettled();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.closes, [{
    code: 1013,
    reason: "host_offline",
  }]);
  assert.equal(socket.terminates, 0);
  assert.equal(receipt.outcome, "closed");
  assert.equal(receipt.failedMandatoryActions, 0);
  assert.equal(pump.snapshot().closeActionFailures, 1);

  socket.emit("close", 1000);
  await client.drained;
  await shared.clientWssRuntime.closeAndDrain();

  const reentrantScheduler = new ManualScheduler();
  const reentrantShared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: reentrantScheduler,
    authorizationExpiryScheduleAt: () => () => {},
  });
  const reentrantHost = new FakeHostCarrier();
  const reentrantPump = pumpModule.createRelayV2BrokerSharedProducerHostCarrierPump(
    reentrantShared.hostPumpAuthority,
    {
      host: reentrantHost,
      transportId: "shared-producer-reentrant-seal-transport",
      hostAuthContext: authContext("host"),
      credentialReference: "host-credential-reference",
      now: () => NOW_MS,
      schedule: reentrantScheduler.schedule,
    },
  );
  reentrantPump.start();
  await reentrantScheduler.flushReady();
  assert.equal(reentrantHost.phase, "registered");

  const reentrantPrepared = reentrantShared.clientWssRuntime.prepareClientWss({
    connectionId: "shared-producer-reentrant-seal-client",
    trustedAuthContext: authContext("client"),
    hostProducerTarget: reentrantPump.producerComposition.target,
  });
  assert.equal(reentrantPrepared.outcome, "accept");
  const reentrantSocket = new FakeClientSocket();
  let reentrantSealCalls = 0;
  reentrantSocket.onInstalled = (event, count) => {
    if (event !== "error" || count !== 2 || reentrantSealCalls !== 0) return;
    reentrantSealCalls += 1;
    reentrantShared.clientWssRuntime.sealClientAdmission();
  };
  assert.throws(() => reentrantShared.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: reentrantPrepared.admissionReceipt,
    alreadyUpgradedSocket: reentrantSocket,
  }), /transport construction failed|runtime is closing/);
  assert.equal(reentrantSealCalls, 1);
  assert.equal(reentrantSocket.terminates, 1);
  assert.equal(reentrantShared.clientWssRuntime.sealClientAdmission(), undefined);

  const reentrantClose = reentrantShared.clientWssRuntime.closeAndDrain();
  assert.strictEqual(reentrantShared.clientWssRuntime.closeAndDrain(), reentrantClose);
  let reentrantCloseSettled = false;
  void reentrantClose.then(() => { reentrantCloseSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    reentrantCloseSettled,
    false,
    "partial force termination is not native terminal evidence",
  );
  reentrantSocket.emit("error", new Error("partial socket terminal"));
  await reentrantScheduler.flushReady();
  const reentrantPumpClosed = reentrantPump.shutdown();
  await reentrantScheduler.flushReady();
  await reentrantPumpClosed;
  await reentrantClose;
  assert.equal(reentrantCloseSettled, true);
  assert.equal(
    [...reentrantSocket.listeners.values()].every((listeners) => listeners.length === 0),
    true,
  );
  assert.equal(reentrantShared.clientWssRuntime.sealClientAdmission(), undefined);
});
