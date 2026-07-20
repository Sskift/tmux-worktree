import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const pumpModule = await import("../dist/relay/v2/carrierPump.js");

const NOW_MS = 1_783_700_000_000;

function deferredValue() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

const TRUSTED_UPGRADED_SOCKETS = new WeakSet();
const trustedUpgradedSocketBrand = (socket) => TRUSTED_UPGRADED_SOCKETS.has(socket);

class FakeClientSocket {
  constructor(protocol = "tw-relay.v2") {
    TRUSTED_UPGRADED_SOCKETS.add(this);
    this._readyState = 1;
    this._protocol = protocol;
    this._extensions = "";
    this._bufferedAmount = 0;
    Object.defineProperties(this, {
      readyState: { value: 1, writable: true, configurable: true, enumerable: true },
      protocol: { value: protocol, writable: true, configurable: true, enumerable: true },
      extensions: { value: "", writable: true, configurable: true, enumerable: true },
      bufferedAmount: { value: 0, writable: true, configurable: true, enumerable: true },
    });
    this.listeners = new Map();
    this.closes = [];
    this.terminates = 0;
    this.removeListenerReceipt = this;
  }

  get readyState() { return this._readyState; }
  get protocol() { return this._protocol; }
  get extensions() { return this._extensions; }
  get bufferedAmount() { return this._bufferedAmount; }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    return this.removeListenerReceipt;
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

test("one Core activates one credential authority before publishing the shared runtime", async () => {
  const scheduler = new ManualScheduler();
  const opened = deferredValue();
  const authorityEntered = deferredValue();
  const authorityDecision = deferredValue();
  const authorityRequests = [];
  const authorityLifecycle = [];
  let authorityCloseCalls = 0;
  const authority = {
    authorityContinuityReadiness: Object.freeze({ status: "ready" }),
    async handle(request) {
      authorityRequests.push(request);
      authorityLifecycle.push("handle:started");
      authorityEntered.resolve();
      assert.equal(request.type, "host.reauthenticate");
      await authorityDecision.promise;
      authorityLifecycle.push("handle:completed");
      const nextAuthContext = Object.freeze({
        ...request.currentAuthContext,
        jti: "host-reauthenticated-jti",
        expiresAtMs: NOW_MS + 7_200_000,
        authorizationRevision: "2",
        authorizationFence: "authorization-fence-2",
      });
      return {
        outcome: "success",
        response: {
          carrierVersion: 1,
          type: "host.reauthenticated",
          requestId: request.requestId,
          connectorId: request.connectorId,
          payload: {
            grantId: nextAuthContext.grantId,
            jti: nextAuthContext.jti,
            expiresAtMs: nextAuthContext.expiresAtMs,
            deduplicated: false,
          },
        },
        replayed: false,
        nextAuthContext,
      };
    },
    async close() {
      authorityCloseCalls += 1;
      authorityLifecycle.push("authority:closed");
    },
  };
  let openerCalls = 0;
  let capturedFence;
  const activationPromise = pumpModule.activateRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeClientSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: scheduler,
    authorizationExpiryScheduleAt: () => () => {},
    async openCredentialAuthority(input) {
      assert.equal(this, undefined);
      assert.throws(() => Reflect.get(this, "producerRegistry"), TypeError);
      openerCalls += 1;
      assert.equal(Object.isFrozen(input), true);
      assert.deepEqual(Reflect.ownKeys(input), ["liveAuthorizationFence"]);
      capturedFence = input.liveAuthorizationFence;
      return await opened.promise;
    },
  });

  let activationSettled = false;
  void activationPromise.then(
    () => { activationSettled = true; },
    () => { activationSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openerCalls, 1);
  assert.equal(activationSettled, false);
  assert.equal(typeof capturedFence.begin, "function");
  assert.equal(typeof capturedFence.failClosed, "function");

  opened.resolve(authority);
  const activation = await activationPromise;
  assert.equal(Object.isFrozen(activation), true);
  assert.deepEqual(Reflect.ownKeys(activation), ["sharedRuntime"]);
  assert.equal(Object.isFrozen(activation.sharedRuntime), true);
  assert.equal(activation.credentialAuthority, undefined);
  assert.equal(activation.authority, undefined);
  assert.equal(activation.sharedRuntime.hostPumpBrokerAuthority, undefined);
  assert.equal(activation.sharedRuntime.producerRegistry, undefined);
  assert.equal(activation.sharedRuntime.runtime, undefined);

  const shared = activation.sharedRuntime;
  const entry = createPump(
    shared,
    scheduler,
    "activated-shared-producer-host",
    "activated-shared-producer-transport",
  );
  await startPumps(scheduler, entry);

  const defaultClient = shared.clientWssRuntime.prepareClientWss({
    connectionId: "activated-default-client",
    trustedAuthContext: authContext("client", entry.host.hostId),
    hostProducerTarget: entry.pump.producerComposition.target,
  });
  assert.equal(defaultClient.outcome, "reject");
  assert.equal(defaultClient.status, 426);

  const registered = entry.host.frames.find((frame) => frame.type === "host.registered");
  assert.ok(registered);
  const reauthenticate = codec.encodeRelayV2WebSocketFrame("carrier", {
    carrierVersion: 1,
    type: "host.reauthenticate",
    requestId: "activated-host-reauthentication",
    connectorId: registered.connectorId,
    payload: { accessToken: "twcap2.replacement.signature" },
  });
  assert.equal(entry.pump.trySend(reauthenticate, "activated-host-reauthentication"), true);
  await scheduler.flushReady();
  await authorityEntered.promise;
  assert.equal(authorityRequests.length, 1);

  const close = shared.closeAndDrain();
  assert.strictEqual(shared.closeAndDrain(), close);
  await scheduler.flushReady();
  let closeSettled = false;
  void close.then(
    () => { closeSettled = true; },
    () => { closeSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(authorityCloseCalls, 0);
  authorityDecision.resolve();
  await close;
  assert.equal(authorityCloseCalls, 1);
  assert.deepEqual(authorityLifecycle, [
    "handle:started",
    "handle:completed",
    "authority:closed",
  ]);

  let failClosedAuthorityCloseCalls = 0;
  let failClosedFence;
  const failClosedActivation = pumpModule.activateRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeClientSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: new ManualScheduler(),
    authorizationExpiryScheduleAt: () => () => {},
    async openCredentialAuthority({ liveAuthorizationFence }) {
      failClosedFence = liveAuthorizationFence;
      liveAuthorizationFence.failClosed();
      return {
        authorityContinuityReadiness: Object.freeze({ status: "ready" }),
        async handle() {
          throw new Error("fail-closed authority must remain unreachable");
        },
        async close() {
          failClosedAuthorityCloseCalls += 1;
        },
      };
    },
  });
  await assert.rejects(failClosedActivation, /credential authority is not ready/);
  assert.equal(failClosedAuthorityCloseCalls, 1);
  assert.throws(() => failClosedFence.begin({
    reason: "kid_removed",
    kid: "fail-closed-opener-kid",
  }), /live-authorization close signal is unavailable/);

  let rejectedFence;
  let rejectedOpenerCalls = 0;
  const rejectedActivation = pumpModule.activateRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeClientSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: { now: () => NOW_MS },
    clientSocketScheduler: new ManualScheduler(),
    authorizationExpiryScheduleAt: () => () => {},
    async openCredentialAuthority({ liveAuthorizationFence }) {
      rejectedOpenerCalls += 1;
      rejectedFence = liveAuthorizationFence;
      throw new Error("deferred credential opener rejected");
    },
  });
  await assert.rejects(rejectedActivation, /deferred credential opener rejected/);
  assert.equal(rejectedOpenerCalls, 1);
  assert.throws(() => rejectedFence.begin({
    reason: "kid_removed",
    kid: "rejected-opener-kid",
  }), /live-authorization close signal is unavailable/);
});

test("total close seals all admissions, starts tracked Pump/WSS siblings, then drains the live client", async (t) => {
  await t.test("mixed Pump/WSS/client close waits for every native owner", async () => {
  const scheduler = new ManualScheduler();
  const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeClientSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    },
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
  const preparedHostWss = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext("host", "shared-native-wss-host"),
  });
  assert.equal(preparedHostWss.outcome, "accept");
  const hostWssSocket = new FakeClientSocket("tw-relay.host.v2");
  const hostWss = shared.hostWssRuntime.attachPreparedHostWss({
    receipt: preparedHostWss.receipt,
    alreadyUpgradedSocket: hostWssSocket,
  });
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
  assert.deepEqual(hostWssSocket.closes, [{ code: 1013, reason: "broker_shutdown" }]);

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

  let hostileHostPrepareReads = 0;
  const rejectedHostPrepare = shared.hostWssRuntime.prepareHostWss(new Proxy({}, {
    ownKeys() {
      hostileHostPrepareReads += 1;
      throw new Error("sealed Host WSS prepare must stay untouched");
    },
    get() {
      hostileHostPrepareReads += 1;
      throw new Error("sealed Host WSS prepare must stay untouched");
    },
  }));
  assert.equal(rejectedHostPrepare.outcome, "reject");
  assert.equal(rejectedHostPrepare.status, 503);
  assert.equal(hostileHostPrepareReads, 0);

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
  assert.equal(closeSettled, false, "Host WSS native terminal remains outstanding");
  hostWssSocket.emit("close", 1000);
  await close;
  await client.drained;
  await hostWss.drained;
  assert.equal(closeSettled, true);
  assert.equal(first.host.phase, "offline");
  assert.equal(second.host.phase, "offline");
  assert.equal(
    [...socket.listeners.values()].every((listeners) => listeners.length === 0),
    true,
  );
  });

  await t.test("construction reservations and rejected siblings cannot skip later drains", async () => {
  {
    const scheduler = new ManualScheduler();
    const shared = pumpModule.createRelayV2BrokerSharedProducerRuntimeComposition({
      hostWssTrustedSocketPrototype: FakeClientSocket.prototype,
      hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
      brokerOptions: {
        now: () => NOW_MS,
        baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      },
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
      hostWssTrustedSocketPrototype: FakeClientSocket.prototype,
      hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
      brokerOptions: {
        now: () => NOW_MS,
        baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      },
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
    const preparedHostWss = shared.hostWssRuntime.prepareHostWss({
      trustedAuthContext: authContext("host", "shared-rejecting-host-wss"),
    });
    assert.equal(preparedHostWss.outcome, "accept");
    const rejectingHostSocket = new FakeClientSocket("tw-relay.host.v2");
    const rejectingHost = shared.hostWssRuntime.attachPreparedHostWss({
      receipt: preparedHostWss.receipt,
      alreadyUpgradedSocket: rejectingHostSocket,
    });
    rejectingHostSocket.removeListenerReceipt = Object.freeze({});
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
    assert.deepEqual(rejectingHostSocket.closes, [{
      code: 1013,
      reason: "broker_shutdown",
    }]);

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

    rejectingHostSocket.emit("close", 1000);
    await assert.rejects(rejectingHost.drained, /Relay v2 Broker Host WSS closed/);
    assert.equal(closeRejected, false, "one rejected sibling cannot skip the live client");
    socket.emit("close", 1000);
    await scheduler.flushReady();
    await assert.rejects(
      close,
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        const messages = error.errors.map((entry) => String(entry?.message ?? entry));
        assert.equal(messages.some((message) => (
          /Relay v2 Broker Host WSS closed/.test(message)
        )), true);
        assert.equal(messages.some((message) => (
          /tracked Host Pump terminal failure \(1\): mandatory_force_rejected/.test(message)
        )), true);
        return true;
      },
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
});
