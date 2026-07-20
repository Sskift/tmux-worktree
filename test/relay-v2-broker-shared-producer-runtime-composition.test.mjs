import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const pumpModule = await import("../dist/relay/v2/carrierPump.js");

const NOW_MS = 1_783_700_000_000;

function authContext(role, hostId) {
  return {
    scheme: "twcap2",
    role,
    hostId,
    principalId: `${role}-${hostId}-principal`,
    grantId: `${role}-${hostId}-grant`,
    clientInstanceId: role === "client" ? `android-${hostId}` : null,
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
  constructor(hostId) {
    this.hostId = hostId;
    this.frames = [];
    this.phase = "offline";
    this.generation = "1";
    this.transport = null;
    this.nextDeliveryToken = 0;
    this.connectCalls = 0;
  }

  connect(transport) {
    this.connectCalls += 1;
    this.transport = transport;
    this.phase = "connecting";
    const hello = codec.encodeRelayV2WebSocketFrame("carrier", {
      carrierVersion: 1,
      type: "host.hello",
      requestId: randomUUID(),
      payload: {
        hostId: this.hostId,
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
    this.terminates = 0;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
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
  pause() {}
  resume() {}
  close(code, reason) { this.closes.push({ code, reason }); }
  terminate() { this.terminates += 1; }
}

function createPump(shared, scheduler, hostId, transportId, extra = {}) {
  const host = new FakeHostCarrier(hostId);
  const pump = shared.createHostCarrierPump({
    host,
    transportId,
    hostAuthContext: authContext("host", hostId),
    credentialReference: `${hostId}-credential-reference`,
    now: () => NOW_MS,
    schedule: scheduler.schedule,
    ...extra,
  });
  return { host, pump };
}

async function startPumps(scheduler, ...entries) {
  for (const { pump } of entries) pump.start();
  await scheduler.flushReady();
  for (const { host } of entries) assert.equal(host.phase, "registered");
}

function prepareLiveClient(shared, pump, hostId, connectionId) {
  const prepared = shared.clientWssRuntime.prepareClientWss({
    connectionId,
    trustedAuthContext: authContext("client", hostId),
    hostProducerTarget: pump.producerComposition.target,
  });
  assert.equal(prepared.outcome, "accept");
  const socket = new FakeClientSocket();
  const client = shared.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: prepared.admissionReceipt,
    alreadyUpgradedSocket: socket,
  });
  assert.equal(client.openResult.accepted, true);
  return { client, socket };
}

test("total close seals both admissions, starts every tracked Pump, then drains the live client", async () => {
  const scheduler = new ManualScheduler();
  const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: scheduler,
    authorizationExpiryScheduleAt: () => () => {},
  });
  const first = createPump(
    shared,
    scheduler,
    "shared-producer-host-a",
    "shared-producer-transport-a",
  );
  const second = createPump(
    shared,
    scheduler,
    "shared-producer-host-b",
    "shared-producer-transport-b",
  );
  await startPumps(scheduler, first, second);
  assert.equal(Object.isFrozen(first.pump), true);
  assert.equal(first.pump.shutdown, undefined);
  assert.equal(first.pump.options, undefined);
  assert.equal(first.pump.producerRegistration, undefined);
  assert.equal(Object.isFrozen(first.host.transport), true);
  assert.equal(first.host.transport.options, undefined);

  const { client, socket } = prepareLiveClient(
    shared,
    first.pump,
    first.host.hostId,
    "shared-producer-client",
  );
  const pending = shared.clientWssRuntime.prepareClientWss({
    connectionId: "shared-producer-pending-client",
    trustedAuthContext: authContext("client", first.host.hostId),
    hostProducerTarget: first.pump.producerComposition.target,
  });
  assert.equal(pending.outcome, "accept");
  await scheduler.flushReady();
  assert.equal(
    first.host.frames.filter((frame) => frame.type === "route.open").length,
    1,
  );

  const close = shared.closeAndDrain();
  assert.strictEqual(shared.closeAndDrain(), close);
  assert.equal(first.pump.snapshot().phase, "closing");
  assert.equal(second.pump.snapshot().phase, "closing");

  let hostilePumpReads = 0;
  const hostilePumpOptions = new Proxy({}, {
    ownKeys() {
      hostilePumpReads += 1;
      throw new Error("closed Pump options must stay untouched");
    },
    getOwnPropertyDescriptor() {
      hostilePumpReads += 1;
      throw new Error("closed Pump descriptors must stay untouched");
    },
    get() {
      hostilePumpReads += 1;
      throw new Error("closed Pump properties must stay untouched");
    },
  });
  assert.throws(
    () => shared.createHostCarrierPump(hostilePumpOptions),
    /Host Pump admission is closed/,
  );
  assert.equal(hostilePumpReads, 0);

  let hostilePrepareReads = 0;
  const hostilePrepareInput = new Proxy({}, {
    ownKeys() {
      hostilePrepareReads += 1;
      throw new Error("sealed client input must stay untouched");
    },
    getOwnPropertyDescriptor() {
      hostilePrepareReads += 1;
      throw new Error("sealed client descriptors must stay untouched");
    },
    get() {
      hostilePrepareReads += 1;
      throw new Error("sealed client properties must stay untouched");
    },
  });
  const rejectedPrepare = shared.clientWssRuntime.prepareClientWss(hostilePrepareInput);
  assert.equal(rejectedPrepare.outcome, "reject");
  assert.equal(rejectedPrepare.status, 503);
  assert.equal(hostilePrepareReads, 0);

  let hostileAttachReads = 0;
  const hostileAttachInput = new Proxy({}, {
    ownKeys() {
      hostileAttachReads += 1;
      throw new Error("sealed attach input must stay untouched");
    },
    getOwnPropertyDescriptor() {
      hostileAttachReads += 1;
      throw new Error("sealed attach descriptors must stay untouched");
    },
    get() {
      hostileAttachReads += 1;
      throw new Error("sealed attach properties must stay untouched");
    },
  });
  assert.throws(
    () => shared.clientWssRuntime.attachPreparedClientWss(hostileAttachInput),
    /runtime is closing/,
  );
  assert.equal(hostileAttachReads, 0);

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

  let closeSettled = false;
  void close.then(() => { closeSettled = true; });
  await scheduler.flushReady();
  const receipts = await Promise.all([
    first.pump.whenCloseSettled(),
    second.pump.whenCloseSettled(),
  ]);
  assert.deepEqual(receipts.map((receipt) => receipt.outcome), ["closed", "closed"]);
  assert.deepEqual(socket.closes, [{ code: 1013, reason: "host_offline" }]);
  assert.equal(
    closeSettled,
    false,
    "Pump cleanup may close the client, but native terminal evidence still owns drain",
  );

  socket.emit("error", new Error("live client terminal evidence"));
  await scheduler.flushReady();
  await close;
  await client.drained;
  assert.equal(closeSettled, true);
  assert.equal(first.host.phase, "offline");
  assert.equal(second.host.phase, "offline");
  assert.equal(
    [...socket.listeners.values()].every((listeners) => listeners.length === 0),
    true,
  );
});

test("construction reservations survive reentrant close and terminal Pump failure cannot skip sibling or client drain", async () => {
  {
    const scheduler = new ManualScheduler();
    const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
      brokerOptions: { now: () => NOW_MS },
      clientSocketScheduler: scheduler,
      authorizationExpiryScheduleAt: () => () => {},
    });
    const host = new FakeHostCarrier("shared-producer-construction-host");
    let reentrantClose;
    const options = {
      get host() {
        reentrantClose ??= shared.closeAndDrain();
        return host;
      },
      transportId: "shared-producer-construction-transport",
      hostAuthContext: authContext("host", host.hostId),
      credentialReference: "construction-credential-reference",
      now: () => NOW_MS,
      schedule: scheduler.schedule,
    };
    assert.throws(
      () => shared.createHostCarrierPump(options),
      /Host Pump construction crossed close/,
    );
    assert.ok(reentrantClose);
    assert.strictEqual(shared.closeAndDrain(), reentrantClose);
    assert.equal(host.connectCalls, 0);

    let closeSettled = false;
    void reentrantClose.then(() => { closeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      closeSettled,
      false,
      "the construction reservation remains until the unreturned Pump receipt settles",
    );
    await scheduler.flushReady();
    await reentrantClose;
    assert.equal(closeSettled, true);

    let postCloseReads = 0;
    const hostileOptions = new Proxy({}, {
      ownKeys() {
        postCloseReads += 1;
        throw new Error("closed construction options must stay untouched");
      },
      getOwnPropertyDescriptor() {
        postCloseReads += 1;
        throw new Error("closed construction descriptors must stay untouched");
      },
    });
    assert.throws(
      () => shared.createHostCarrierPump(hostileOptions),
      /Host Pump admission is closed/,
    );
    assert.equal(postCloseReads, 0);
  }

  {
    const scheduler = new ManualScheduler();
    const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
      brokerOptions: { now: () => NOW_MS },
      clientSocketScheduler: scheduler,
      authorizationExpiryScheduleAt: () => () => {},
    });
    const failing = createPump(
      shared,
      scheduler,
      "shared-producer-failing-host",
      "shared-producer-failing-transport",
    );
    const healthy = createPump(
      shared,
      scheduler,
      "shared-producer-healthy-host",
      "shared-producer-healthy-transport",
    );
    await startPumps(scheduler, failing, healthy);
    const { client, socket } = prepareLiveClient(
      shared,
      healthy.pump,
      healthy.host.hostId,
      "shared-producer-healthy-client",
    );
    await scheduler.flushReady();

    failing.pump.acceptBrokerResult({
      accepted: true,
      actions: [{
        kind: "close_client",
        connectionId: "missing-mandatory-client",
        connectionIncarnation: randomUUID(),
        closeCode: 1013,
        reason: "mandatory_cleanup_test",
      }],
    });
    failing.pump.close(1000, "historical_terminal_test");
    await scheduler.flushReady();
    const failedReceipt = await failing.pump.whenCloseSettled();
    assert.equal(failedReceipt.outcome, "terminal_failure");
    assert.equal(failedReceipt.reason, "mandatory_force_rejected");
    assert.equal(failing.host.phase, "offline");

    const close = shared.closeAndDrain();
    assert.equal(failing.pump.snapshot().phase, "terminal_failure");
    assert.equal(healthy.pump.snapshot().phase, "closing");

    let closeRejected = false;
    void close.then(
      () => {},
      () => { closeRejected = true; },
    );
    await scheduler.flushReady();
    const healthyReceipt = await healthy.pump.whenCloseSettled();
    assert.equal(healthyReceipt.outcome, "closed");
    assert.deepEqual(socket.closes, [{ code: 1013, reason: "host_offline" }]);
    assert.equal(
      closeRejected,
      false,
      "terminal Pump failure is retained while the healthy client still awaits evidence",
    );

    socket.emit("close", 1000);
    await scheduler.flushReady();
    await assert.rejects(
      close,
      /tracked Host Pump terminal failure \(1\): mandatory_force_rejected/,
    );
    await client.drained;
    assert.equal(closeRejected, true);
    assert.equal(failing.host.phase, "offline");
    assert.equal(healthy.host.phase, "offline");
    assert.equal(
      [...socket.listeners.values()].every((listeners) => listeners.length === 0),
      true,
    );
  }
});
