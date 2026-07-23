import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const clientRuntime = await import("../dist/relay/v2/brokerClientWssRuntimeComposition.js");
const codec = await import("../dist/relay/v2/codec.js");
const pump = await import("../dist/relay/v2/carrierPump.js");
const producerRegistryModule = await import("../dist/relay/v2/brokerProducerRegistry.js");

const NOW_MS = 1_783_700_000_000;

function authContext(hostId = "native-host") {
  return {
    scheme: "twcap2",
    role: "host",
    hostId,
    principalId: `${hostId}-principal`,
    grantId: `${hostId}-grant`,
    clientInstanceId: null,
    jti: `${hostId}-${randomUUID()}`,
    kid: "kid-current",
    expiresAtMs: NOW_MS + 3_600_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
  };
}

function clientAuth(hostId = "native-host") {
  return {
    ...authContext(hostId),
    role: "client",
    principalId: `${hostId}-client-principal`,
    grantId: `${hostId}-client-grant`,
    clientInstanceId: `${hostId}-android`,
    jti: `${hostId}-client-${randomUUID()}`,
  };
}

function carrierFrame(frame) {
  return Buffer.from(codec.encodeRelayV2WebSocketFrame("carrier", frame)).toString("utf8");
}

function hostHello(hostId = "native-host") {
  return {
    carrierVersion: 1,
    type: "host.hello",
    requestId: randomUUID(),
    payload: {
      hostId,
      hostEpoch: randomUUID(),
      hostInstanceId: randomUUID(),
      clientDialects: ["tw-relay.v2"],
      capabilities: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      limits: { maxFrameBytes: 1_048_576, terminalMaxFrameBytes: 65_536 },
    },
  };
}

async function settle(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

const TRUSTED_UPGRADED_SOCKETS = new WeakSet();
const trustedUpgradedSocketBrand = (socket) => TRUSTED_UPGRADED_SOCKETS.has(socket);

class FakeUpgradedSocket {
  constructor({ protocol = "tw-relay.host.v2", synchronousSend = false } = {}) {
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
    this.synchronousSend = synchronousSend;
    this.listeners = new Map();
    this.sends = [];
    this.closes = [];
    this.terminates = 0;
    this.pauses = 0;
    this.resumes = 0;
    this.factHook = null;
    this.onHook = null;
    this.removeListenerReceipt = this;
    this.removeListenerHook = null;
    this.terminateHook = null;
  }

  get readyState() { this.factHook?.("readyState"); return this._readyState; }
  get protocol() { this.factHook?.("protocol"); return this._protocol; }
  get extensions() { this.factHook?.("extensions"); return this._extensions; }
  get bufferedAmount() { this.factHook?.("bufferedAmount"); return this._bufferedAmount; }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    const hooked = this.onHook?.(event, listener);
    if (hooked !== undefined) return hooked;
    return this;
  }

  removeListener(event, listener) {
    const hooked = this.removeListenerHook?.(event, listener);
    if (hooked !== undefined) return hooked;
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    return this.removeListenerReceipt;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      Reflect.apply(listener, this, args);
    }
  }

  send(text, options, callback) {
    const entry = { text, options, callback };
    this.sends.push(entry);
    if (this.synchronousSend) callback();
  }

  pause() { this.pauses += 1; }
  resume() { this.resumes += 1; }
  close(code, reason) { this.closes.push({ code, reason }); }
  terminate() {
    this.terminates += 1;
    const hooked = this.terminateHook?.(this.terminates);
    if (hooked !== undefined) return hooked;
  }

  frame(index) {
    return codec.decodeRelayV2WebSocketFrame(
      "carrier",
      Buffer.from(this.sends[index].text, "utf8"),
    ).frame;
  }
}

function createShared(extraBrokerOptions = {}) {
  return pump.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeUpgradedSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      ...extraBrokerOptions,
    },
    authorizationExpiryScheduleAt: () => () => {},
  });
}

async function openClientRoute(shared, hostSocket, hostHandle, hostId, index, synchronousClient) {
  const prepared = shared.clientWssRuntime.prepareClientWss({
    connectionId: `backpressure-client-${index}-${randomUUID()}`,
    trustedAuthContext: clientAuth(hostId),
    hostProducerTarget: {
      transportId: hostHandle.transportId,
      generation: hostHandle.producerGeneration,
    },
  });
  assert.equal(prepared.outcome, "accept");
  const socket = new FakeUpgradedSocket({
    protocol: "tw-relay.v2",
    synchronousSend: synchronousClient,
  });
  const connection = shared.clientWssRuntime.attachPreparedClientWss({
    admissionReceipt: prepared.admissionReceipt,
    alreadyUpgradedSocket: socket,
  });
  await settle();
  const routeOpen = hostSocket.frame(hostSocket.sends.length - 1);
  assert.equal(routeOpen.type, "route.open");
  hostSocket.emit("message", carrierFrame({
    carrierVersion: 1,
    type: "route.opened",
    requestId: routeOpen.requestId,
    connectorId: routeOpen.connectorId,
    routeId: routeOpen.routeId,
    routeFence: routeOpen.routeFence,
    payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
  }), false);
  await settle();
  return {
    socket,
    connection,
    identity: {
      connectorId: routeOpen.connectorId,
      routeId: routeOpen.routeId,
      routeFence: routeOpen.routeFence,
    },
    nextSeq: 0,
  };
}

function routeData(route, index) {
  route.nextSeq += 1;
  const publicFrame = codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId: `stream-${index}`,
    payload: {
      generation: "generation-1",
      ackedThroughInputSeq: String(index),
    },
  });
  return carrierFrame({
    carrierVersion: 1,
    type: "route.data",
    ...route.identity,
    direction: "host_to_client",
    seq: String(route.nextSeq),
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(publicFrame).toString("base64"),
    },
  });
}

function prepareAndAttach(shared, socket, hostId = "native-host") {
  const prepared = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext(hostId),
  });
  assert.equal(prepared.outcome, "accept");
  const handle = shared.hostWssRuntime.attachPreparedHostWss({
    receipt: prepared.receipt,
    alreadyUpgradedSocket: socket,
  });
  return { prepared, handle };
}

test("Host WSS receipt is owner-bound/one-shot and registration commits only after native send ACK", async () => {
  const first = createShared();
  const second = createShared();
  assert.deepEqual(Reflect.ownKeys(first.hostWssRuntime), [
    "prepareHostWss",
    "claimPreparedHostWss",
    "attachPreparedHostWss",
    "closeAndDrain",
  ]);
  const pending = first.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext(),
  });
  assert.equal(pending.outcome, "accept");
  assert.deepEqual(Reflect.ownKeys(pending.receipt), []);
  for (const key of ["core", "producerRegistry", "closeCoordinator", "ownerPort", "createSession"]) {
    assert.equal(first.hostWssRuntime[key], undefined);
    assert.equal(pending.receipt[key], undefined);
  }

  let foreignSocketReads = 0;
  const foreignSocket = new Proxy({}, {
    get() { foreignSocketReads += 1; throw new Error("foreign receipt touched socket"); },
    getOwnPropertyDescriptor() { foreignSocketReads += 1; throw new Error("foreign receipt touched socket"); },
    getPrototypeOf() { foreignSocketReads += 1; throw new Error("foreign receipt touched socket"); },
  });
  assert.throws(() => second.hostWssRuntime.claimPreparedHostWss({
    receipt: pending.receipt,
  }), /admission receipt/);
  assert.equal(foreignSocketReads, 0);

  const claim = first.hostWssRuntime.claimPreparedHostWss({
    receipt: pending.receipt,
  });
  assert.deepEqual(Reflect.ownKeys(claim), ["attach"]);
  assert.throws(() => Reflect.apply(claim.attach, {}, [{
    alreadyUpgradedSocket: foreignSocket,
  }]), /admission claim/);
  assert.throws(() => first.hostWssRuntime.attachPreparedHostWss({
    receipt: pending.receipt,
    alreadyUpgradedSocket: foreignSocket,
  }), /admission receipt/);
  assert.equal(foreignSocketReads, 0);

  const socket = new FakeUpgradedSocket();
  const handle = claim.attach({
    alreadyUpgradedSocket: socket,
  });
  assert.match(handle.transportId, /^[0-9a-f-]{36}$/);
  assert.match(handle.connectionIncarnation, /^[0-9a-f-]{36}$/);
  assert.match(handle.producerGeneration, /^[1-9][0-9]*$/);
  assert.notEqual(handle.transportId, handle.connectionIncarnation);
  assert.deepEqual(Reflect.ownKeys(handle), [
    "transportId",
    "connectionIncarnation",
    "producerGeneration",
    "terminal",
    "drained",
  ]);
  assert.equal(handle.socket, undefined);
  assert.equal(handle.binding, undefined);
  assert.equal(handle.closeLease, undefined);
  assert.equal(handle.core, undefined);
  assert.equal(handle.producerRegistry, undefined);
  assert.throws(() => claim.attach({
    alreadyUpgradedSocket: foreignSocket,
  }), /admission claim/);
  assert.equal(foreignSocketReads, 0);

  socket.emit("message", carrierFrame(hostHello()), false);
  await settle();
  assert.equal(socket.sends.length, 1);
  assert.equal(socket.frame(0).type, "host.registered");
  assert.deepEqual(socket.sends[0].options, { binary: false, compress: false });
  const beforeAck = first.clientWssRuntime.prepareClientWss({
    connectionId: "client-before-registration-ack",
    trustedAuthContext: clientAuth(),
    hostProducerTarget: {
      transportId: handle.transportId,
      generation: handle.producerGeneration,
    },
  });
  assert.equal(beforeAck.outcome, "reject");
  assert.equal(beforeAck.status, 503);

  socket.sends[0].callback();
  await settle();
  const afterAck = first.clientWssRuntime.prepareClientWss({
    connectionId: "client-after-registration-ack",
    trustedAuthContext: clientAuth(),
    hostProducerTarget: {
      transportId: handle.transportId,
      generation: handle.producerGeneration,
    },
  });
  assert.equal(afterAck.outcome, "accept");

  socket.emit("close", 1000);
  await handle.drained;
  const hostClose = first.hostWssRuntime.closeAndDrain();
  assert.strictEqual(first.hostWssRuntime.closeAndDrain(), hostClose);
  await Promise.all([hostClose, first.closeAndDrain(), second.closeAndDrain()]);
  assert.equal(first.hostWssRuntime.prepareHostWss(new Proxy({}, {
    get() { throw new Error("closed prepare reflected input"); },
  })).status, 503);
});

test("native framing, one-callback FIFO, and transport backpressure fail closed", async (t) => {
  await t.test("untrusted sockets, partial installs, and oversized frames roll back without residue", async () => {
    let rawDataProxyReads = 0;
    const sparse = new Array(1_500_001);
    sparse[0] = Buffer.alloc(0);
    for (const [makeData, isBinary] of [
      [() => Buffer.from(carrierFrame(hostHello())), true],
      [() => Buffer.alloc(1_500_001, 0x61), false],
      [() => "a".repeat(1_500_001), false],
      [() => [Buffer.alloc(750_001), Buffer.alloc(750_001)], false],
      [() => sparse, false],
      [() => new Proxy({}, {
        get() { rawDataProxyReads += 1; throw new Error("proxied frame getter"); },
        getPrototypeOf() { rawDataProxyReads += 1; throw new Error("proxied frame prototype"); },
      }), false],
    ]) {
      const shared = createShared();
      const socket = new FakeUpgradedSocket();
      const { handle } = prepareAndAttach(shared, socket);
      socket.emit("message", makeData(), isBinary);
      assert.equal(socket.sends.length, 0);
      assert.equal(socket.closes[0]?.code, 4400);
      socket.emit("close", 4400);
      await handle.drained;
      await shared.closeAndDrain();
    }
    assert.equal(rawDataProxyReads, 0);

    const proxyShared = createShared();
    const proxyPrepared = proxyShared.hostWssRuntime.prepareHostWss({
      trustedAuthContext: authContext("proxy-host"),
    });
    let proxySocketReads = 0;
    const proxySocket = new Proxy(new FakeUpgradedSocket(), {
      get() { proxySocketReads += 1; throw new Error("socket getter trap"); },
      getPrototypeOf() { proxySocketReads += 1; throw new Error("socket prototype trap"); },
    });
    assert.throws(() => proxyShared.hostWssRuntime.attachPreparedHostWss({
      receipt: proxyPrepared.receipt,
      alreadyUpgradedSocket: proxySocket,
    }), /Host WSS/);
    assert.equal(proxySocketReads, 0);
    await proxyShared.closeAndDrain();

    const forgedShared = createShared();
    const forgedPrepared = forgedShared.hostWssRuntime.prepareHostWss({
      trustedAuthContext: authContext("forged-host"),
    });
    const forgedSocket = Object.create(FakeUpgradedSocket.prototype);
    Object.defineProperty(forgedSocket, "constructor", {
      value: FakeUpgradedSocket,
      enumerable: true,
    });
    assert.throws(() => forgedShared.hostWssRuntime.attachPreparedHostWss({
      receipt: forgedPrepared.receipt,
      alreadyUpgradedSocket: forgedSocket,
    }), /Relay v2 Broker Host WSS closed/);
    await forgedShared.closeAndDrain();

    for (const [name, configure, stickyCleanupFailure = false] of [
      ["capture getter throw", (socket) => {
        socket.factHook = () => { throw new Error("trusted getter rejected"); };
      }],
      ["install getter throw", (socket) => {
        let reads = 0;
        socket.factHook = () => {
          reads += 1;
          if (reads > 4) throw new Error("post-install getter rejected");
        };
      }],
      ["on throws after install", (socket) => {
        socket.onHook = (event) => {
          if (event === "error") throw new Error("listener install rejected");
        };
      }],
      ["raw cleanup and terminate failures stay generic and sticky", (socket) => {
        socket.onHook = (event) => {
          if (event === "error") throw new Error("SENTINEL_ON_FAILURE");
        };
        let removeAttempts = 0;
        socket.removeListenerHook = () => {
          removeAttempts += 1;
          if (removeAttempts === 1) throw new Error("SENTINEL_REMOVE_FAILURE");
        };
        socket.terminateHook = (attempt) => {
          if (attempt === 1) return Object.freeze({ sentinel: "SENTINEL_FOREIGN_RECEIPT" });
          if (attempt === 2) throw new Error("SENTINEL_TERMINATE_FAILURE");
        };
      }, true],
      ["on returns foreign", (socket) => {
        socket.onHook = (event) => event === "close" ? Object.freeze({}) : undefined;
      }],
      ["on reenters listener", (socket) => {
        let reentered = false;
        socket.onHook = (_event, listener) => {
          if (!reentered) {
            reentered = true;
            Reflect.apply(listener, socket, [1006]);
          }
        };
      }],
    ]) {
      const shared = createShared();
      const prepared = shared.hostWssRuntime.prepareHostWss({
        trustedAuthContext: authContext(`rollback-${name}`),
      });
      const socket = new FakeUpgradedSocket();
      configure(socket);
      assert.throws(() => shared.hostWssRuntime.attachPreparedHostWss({
        receipt: prepared.receipt,
        alreadyUpgradedSocket: socket,
      }), (error) => {
        assert.equal(error.message, "Relay v2 Broker Host WSS closed", name);
        assert.equal(error.cause, undefined, name);
        assert.equal(error instanceof AggregateError, false, name);
        assert.equal(/SENTINEL/.test(String(error)), false, name);
        return true;
      });
      assert.equal(socket.terminates, 1, name);
      assert.equal(
        [...socket.listeners.values()].every((listeners) => listeners.length === 0),
        true,
        name,
      );
      if (stickyCleanupFailure) {
        await settle();
        assert.equal(socket.terminates, 2);
        const hostClose = shared.hostWssRuntime.closeAndDrain();
        assert.strictEqual(shared.hostWssRuntime.closeAndDrain(), hostClose);
        let stickyError;
        await assert.rejects(hostClose, (error) => {
          stickyError = error;
          assert.equal(error.message, "Relay v2 Broker Host WSS closed");
          assert.equal(error.cause, undefined);
          assert.equal(error instanceof AggregateError, false);
          assert.equal(/SENTINEL/.test(String(error)), false);
          return true;
        });
        await assert.rejects(shared.hostWssRuntime.closeAndDrain(), (error) => (
          error === stickyError
        ));
        assert.equal(socket.terminates, 3, "close performs one final bounded force attempt");
        assert.equal(
          [...socket.listeners.values()].every((listeners) => listeners.length === 0),
          true,
        );
        socket.emit("message", carrierFrame(hostHello()), false);
        assert.equal(socket.sends.length, 0, "failed construction cannot retain callbacks");
        assert.equal(socket.closes.length, 0, "failed construction is not tracked as a connection");
        await assert.rejects(shared.closeAndDrain(), (error) => {
          assert.equal(error.message, "Relay v2 Broker Host WSS closed");
          assert.equal(/SENTINEL/.test(String(error)), false);
          return true;
        });
      } else {
        await shared.closeAndDrain();
      }
    }

    const reentrantShared = createShared();
    const reentrantPrepared = reentrantShared.hostWssRuntime.prepareHostWss({
      trustedAuthContext: authContext("capture-close-host"),
    });
    const reentrantSocket = new FakeUpgradedSocket();
    let reentrantClose;
    reentrantSocket.factHook = () => {
      reentrantClose ??= reentrantShared.closeAndDrain();
    };
    assert.throws(() => reentrantShared.hostWssRuntime.attachPreparedHostWss({
      receipt: reentrantPrepared.receipt,
      alreadyUpgradedSocket: reentrantSocket,
    }), /Relay v2 Broker Host WSS closed/);
    assert.ok(reentrantClose);
    assert.strictEqual(reentrantShared.closeAndDrain(), reentrantClose);
    assert.equal(reentrantSocket.terminates, 1);
    await reentrantClose;

    const registry = new producerRegistryModule.RelayV2BrokerProducerRegistry();
    const ordinaryRegister = registry.registerHostProducer.bind(registry);
    let failedTarget;
    registry.registerHostProducer = (...args) => {
      const registration = ordinaryRegister(...args);
      failedTarget = registration.target;
      return Object.freeze({
        ...registration,
        bindConnectionIncarnation() {
          throw new Error("owner open binding rejected");
        },
      });
    };
    const lowLevel = clientRuntime.createRelayV2BrokerClientWssRuntimeComposition({
      brokerOptions: {
        now: () => NOW_MS,
        baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      },
      producerRegistry: registry,
      resolveHostProducerBinding: () => undefined,
      authorizationExpiryScheduleAt: () => () => {},
    });
    const safeHost = clientRuntime.installRelayV2BrokerHostWssRuntime(
      lowLevel,
      FakeUpgradedSocket.prototype,
      trustedUpgradedSocketBrand,
    );
    assert.throws(() => clientRuntime.installRelayV2BrokerHostWssRuntime(
      lowLevel,
      FakeUpgradedSocket.prototype,
      trustedUpgradedSocketBrand,
    ), /already installed/);
    const failedPrepared = safeHost.prepareHostWss({
      trustedAuthContext: authContext("owner-open-failure"),
    });
    const failedSocket = new FakeUpgradedSocket();
    assert.throws(() => safeHost.attachPreparedHostWss({
      receipt: failedPrepared.receipt,
      alreadyUpgradedSocket: failedSocket,
    }), /Relay v2 Broker Host WSS closed/);
    assert.equal(failedSocket.terminates, 1);
    await settle();
    assert.equal(
      registry.inspectHostProducerOwner(failedTarget.transportId, "rolled-back").status,
      "stale",
    );
    registry.registerHostProducer = ordinaryRegister;
    const recoveredPrepared = safeHost.prepareHostWss({
      trustedAuthContext: authContext("owner-open-recovered"),
    });
    const recoveredSocket = new FakeUpgradedSocket();
    const recovered = safeHost.attachPreparedHostWss({
      receipt: recoveredPrepared.receipt,
      alreadyUpgradedSocket: recoveredSocket,
    });
    const clientClose = lowLevel.closeAndDrain();
    assert.deepEqual(recoveredSocket.closes, [{ code: 1013, reason: "broker_shutdown" }]);
    const safeClose = safeHost.closeAndDrain();
    assert.strictEqual(safeHost.closeAndDrain(), safeClose);
    recoveredSocket.emit("close", 1000);
    await Promise.all([safeClose, clientClose, recovered.drained]);
  });

  await t.test("synchronous callback settles after send returns; callback error rejects and closes 1013", async () => {
    const successful = createShared();
    const syncSocket = new FakeUpgradedSocket({ synchronousSend: true });
    const { handle: syncHandle } = prepareAndAttach(successful, syncSocket);
    syncSocket.emit("message", carrierFrame(hostHello()), false);
    await settle();
    const accepted = successful.clientWssRuntime.prepareClientWss({
      connectionId: "sync-callback-client",
      trustedAuthContext: clientAuth(),
      hostProducerTarget: {
        transportId: syncHandle.transportId,
        generation: syncHandle.producerGeneration,
      },
    });
    assert.equal(accepted.outcome, "accept");
    syncSocket.emit("close", 1000);
    await syncHandle.drained;
    await successful.closeAndDrain();

    const failing = createShared();
    const errorSocket = new FakeUpgradedSocket();
    const { handle: errorHandle } = prepareAndAttach(failing, errorSocket);
    errorSocket.emit("message", carrierFrame(hostHello()), false);
    await settle();
    errorSocket.sends[0].callback(new Error("native write failed"));
    await settle();
    assert.deepEqual(errorSocket.closes.at(-1), {
      code: 1013,
      reason: "carrier_write_failed",
    });
    errorSocket.emit("error", new Error("native terminal"));
    await errorHandle.drained;
    await failing.closeAndDrain();

    const pendingWrite = createShared();
    const pendingSocket = new FakeUpgradedSocket();
    const { handle: pendingHandle } = prepareAndAttach(pendingWrite, pendingSocket);
    pendingSocket.emit("message", carrierFrame(hostHello()), false);
    await settle();
    pendingSocket.emit("close", 1000);
    let pendingDrained = false;
    void pendingHandle.drained.then(() => { pendingDrained = true; });
    await settle();
    assert.equal(pendingDrained, true, "native terminal fences an untrusted pending callback");
    const lateCallback = pendingSocket.sends[0].callback;
    lateCallback();
    lateCallback(new Error("duplicate late callback"));
    await settle();
    const lateAdmission = pendingWrite.clientWssRuntime.prepareClientWss({
      connectionId: "late-terminal-callback-client",
      trustedAuthContext: clientAuth(),
      hostProducerTarget: {
        transportId: pendingHandle.transportId,
        generation: pendingHandle.producerGeneration,
      },
    });
    assert.equal(lateAdmission.outcome, "reject", "late callback cannot ACK registration");
    await pendingWrite.closeAndDrain();
  });

  await t.test("route pause stays route-scoped while aggregate watermarks pause/resume the socket", async () => {
    let releaseAuth;
    const blockedAuth = new Promise((_, reject) => { releaseAuth = reject; });
    const aggregate = createShared({
      authControlAuthority: {
        handle() { return blockedAuth; },
      },
    });
    const aggregateSocket = new FakeUpgradedSocket({ synchronousSend: true });
    const { handle: aggregateHandle } = prepareAndAttach(
      aggregate,
      aggregateSocket,
      "aggregate-host",
    );
    aggregateSocket.emit("message", carrierFrame(hostHello("aggregate-host")), false);
    await settle();
    const registered = aggregateSocket.frame(0);
    const routes = [];
    for (let index = 0; index < 5; index += 1) {
      routes.push(await openClientRoute(
        aggregate,
        aggregateSocket,
        aggregateHandle,
        "aggregate-host",
        index,
        true,
      ));
    }
    aggregateSocket.emit("message", carrierFrame({
      carrierVersion: 1,
      type: "host.reauthenticate",
      requestId: randomUUID(),
      connectorId: registered.connectorId,
      payload: { accessToken: "twcap2.blocked.signature" },
    }), false);
    await settle();
    for (let index = 0; index < 512; index += 1) {
      const route = routes[index % routes.length];
      aggregateSocket.emit("message", routeData(route, index + 1), false);
    }
    assert.equal(aggregateSocket.pauses, 1);
    assert.equal(aggregateSocket.resumes, 0);
    releaseAuth(new Error("release aggregate ingress"));
    await settle(24);
    assert.equal(aggregateSocket.resumes, 1);
    assert.equal(aggregateSocket.closes.length, 0);

    for (const route of routes) route.socket.emit("close", 1000);
    aggregateSocket.emit("close", 1000);
    await Promise.all([
      aggregateHandle.drained,
      ...routes.map((route) => route.connection.drained),
    ]);
    await aggregate.closeAndDrain();

    const scoped = createShared();
    const scopedSocket = new FakeUpgradedSocket({ synchronousSend: true });
    const { handle: scopedHandle } = prepareAndAttach(scoped, scopedSocket, "scoped-host");
    scopedSocket.emit("message", carrierFrame(hostHello("scoped-host")), false);
    await settle();
    const scopedRoute = await openClientRoute(
      scoped,
      scopedSocket,
      scopedHandle,
      "scoped-host",
      99,
      false,
    );
    for (let index = 0; index < 128; index += 1) {
      scopedSocket.emit("message", routeData(scopedRoute, index + 1), false);
      await settle(2);
    }
    await settle();
    assert.equal(scopedSocket.pauses, 0, "route pause must not pause the multiplexed socket");
    for (let index = 0; index < 129; index += 1) {
      scopedSocket.emit("message", routeData(scopedRoute, index + 129), false);
    }
    assert.equal(scopedSocket.pauses, 0);
    assert.deepEqual(scopedSocket.closes.at(-1), {
      code: 1013,
      reason: "host_ingress_saturated",
    });
    scopedRoute.socket.emit("close", 1000);
    scopedSocket.emit("close", 1013);
    await Promise.all([scopedHandle.drained, scopedRoute.connection.drained]);
    await scoped.closeAndDrain();
  });
});

test("replacement actions keep exact producer identity and total drain waits for real native terminal", async () => {
  const shared = createShared();
  const oldSocket = new FakeUpgradedSocket();
  const { handle: oldHandle } = prepareAndAttach(shared, oldSocket, "replacement-host");
  oldSocket.emit("message", carrierFrame(hostHello("replacement-host")), false);
  await settle();
  oldSocket.sends[0].callback();
  await settle();

  const winnerSocket = new FakeUpgradedSocket();
  const { handle: winnerHandle } = prepareAndAttach(shared, winnerSocket, "replacement-host");
  winnerSocket.emit("message", carrierFrame(hostHello("replacement-host")), false);
  await settle();
  assert.equal(winnerSocket.frame(0).type, "host.registered");
  winnerSocket.sends[0].callback();
  await settle();
  assert.equal(oldSocket.frame(1).type, "host.superseded");
  assert.equal(winnerSocket.sends.length, 1, "old producer action cannot fall forward");
  assert.equal(oldSocket.closes.length, 0, "terminal control owns FIFO before close");
  oldSocket.sends[1].callback();
  await settle();
  assert.equal(oldSocket.closes.at(-1)?.code, 4409);

  oldSocket.emit("close", 4409);
  await oldHandle.drained;
  const closing = shared.closeAndDrain();
  assert.deepEqual(winnerSocket.closes.at(-1), { code: 1013, reason: "broker_shutdown" });
  let settled = false;
  void closing.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false);
  assert.equal(winnerSocket.terminates, 0, "forceDestroy is not terminal evidence");
  winnerSocket.emit("close", 1000);
  await closing;
  await winnerHandle.drained;
  assert.equal(settled, true);
  assert.equal(
    [...winnerSocket.listeners.values()].every((listeners) => listeners.length === 0),
    true,
  );
});

test("host.hello handshake deadline: 4408 on timeout, only accepted host.hello cancels", async (t) => {
  const hostWss = await import("../dist/relay/v2/brokerHostWssRuntimeComposition.js");

  const fakeOwnerBinding = () => {
    const captured = [];
    return {
      captured,
      credentialAdmissionOpen: () => true,
      inspectHostAdmission: () => Object.freeze({ outcome: "accept" }),
      createSession: (input) => {
        captured.push(input);
        return {
          transportId: randomUUID(),
          connectionIncarnation: randomUUID(),
          producerGeneration: "1",
          attach() {},
          registerExpiry() {},
          receiveHostFrame: async () => "applied",
          drainHostCarrier: () => [],
          acknowledgeHostControlDelivery: () => "applied",
          rejectHostControlDelivery: () => "applied",
          acknowledgeHostDelivery: () => "applied",
          disconnectHost: () => "applied",
          beginProducerClose() {},
          terminalAndUnregister: async () => {},
          rollbackConstruction: async () => {},
        };
      },
    };
  };

  const fakeScheduler = () => {
    const scheduled = [];
    return {
      scheduled,
      schedule(delayMs, callback) {
        const entry = { delayMs, callback, cancelled: false };
        scheduled.push(entry);
        return () => { entry.cancelled = true; };
      },
    };
  };

  const attachWithScheduler = (scheduler) => {
    const binding = fakeOwnerBinding();
    const facade = hostWss.bindRelayV2BrokerHostWssRuntimeFacade(
      binding,
      FakeUpgradedSocket.prototype,
      trustedUpgradedSocketBrand,
      { handshakeScheduler: scheduler },
    );
    const prepared = facade.prepareHostWss({ trustedAuthContext: authContext() });
    assert.equal(prepared.outcome, "accept");
    const socket = new FakeUpgradedSocket();
    const handle = facade.attachPreparedHostWss({
      receipt: prepared.receipt,
      alreadyUpgradedSocket: socket,
    });
    return { facade, socket, handle, binding };
  };

  const hostRegisteredFrame = {
    carrierVersion: 1,
    type: "host.registered",
    requestId: randomUUID(),
    connectorId: randomUUID(),
    payload: {
      brokerEpoch: randomUUID(),
      hostsRevision: "1",
      disposition: "connected",
      supersededHostInstanceId: null,
      limits: {
        maxCarrierFrameBytes: 1_048_576,
        brokerCarrierBufferedBytes: 8_388_608,
        brokerCarrierLowWaterBytes: 1_048_576,
      },
    },
  };

  await t.test("bind rejects proxied, getter-based, or malformed handshake schedulers", () => {
    for (const options of [
      { handshakeScheduler: new Proxy({}, {}) },
      { handshakeScheduler: { schedule: 42 } },
      { handshakeScheduler: Object.create(null) },
      Object.defineProperty({}, "handshakeScheduler", {
        enumerable: true,
        get() { throw new Error("options getter trap"); },
      }),
      new Proxy({}, {}),
    ]) {
      assert.throws(() => hostWss.bindRelayV2BrokerHostWssRuntimeFacade(
        fakeOwnerBinding(),
        FakeUpgradedSocket.prototype,
        trustedUpgradedSocketBrand,
        options,
      ), /Relay v2 Broker Host WSS/);
    }
  });

  const cases = [
    {
      name: "no host.hello within the frozen 5s closes 4408 handshake_timeout",
      run: async (scheduler, { socket, handle }) => {
        scheduler.scheduled[0].callback();
        scheduler.scheduled[0].callback();
        assert.deepEqual(socket.closes, [{ code: 4408, reason: "handshake_timeout" }]);
        socket.emit("close", 4408);
        await handle.drained;
      },
    },
    {
      name: "Core host.registered enqueue cancels the deadline and a late fire is a no-op",
      run: async (scheduler, { socket, handle, binding }) => {
        socket.emit("message", carrierFrame(hostHello()), false);
        await settle();
        assert.equal(scheduler.scheduled[0].cancelled, false);
        const receipt = binding.captured[0].producerPort.apply(
          [{ kind: "send_host", transportId: handle.transportId, frame: hostRegisteredFrame }],
          {
            mayApply: () => true,
            target: {
              transportId: handle.transportId,
              generation: handle.producerGeneration,
            },
          },
        );
        assert.equal(receipt, "applied");
        assert.equal(scheduler.scheduled[0].cancelled, true);
        scheduler.scheduled[0].callback();
        assert.deepEqual(socket.closes, []);
        socket.emit("close", 1000);
        await handle.drained;
      },
    },
    {
      name: "close before the deadline releases the timer and a late fire cannot close",
      run: async (scheduler, { socket, handle }) => {
        socket.emit("close", 1000);
        assert.equal(scheduler.scheduled[0].cancelled, true);
        scheduler.scheduled[0].callback();
        assert.deepEqual(socket.closes, []);
        await handle.drained;
      },
    },
  ];

  for (const { name, run } of cases) {
    await t.test(name, async () => {
      const scheduler = fakeScheduler();
      const attached = attachWithScheduler(scheduler);
      assert.equal(scheduler.scheduled.length, 1);
      assert.equal(scheduler.scheduled[0].delayMs, 5_000);
      await run(scheduler, attached);
      await attached.facade.closeAndDrain();
    });
  }
});

test("host auth-expiring warning reaches the socket once per credential and reauth re-arms", async () => {
  const now = { value: NOW_MS };
  const scheduled = [];
  const initialAuth = authContext();
  const nextAuth = {
    ...initialAuth,
    jti: "reauth-shorter-jti",
    expiresAtMs: NOW_MS + 3_570_000,
  };
  const shared = pump.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeUpgradedSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: {
      now: () => now.value,
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      authControlAuthority: {
        handle(request) {
          assert.equal(request.type, "host.reauthenticate");
          return {
            outcome: "success",
            replayed: false,
            nextAuthContext: nextAuth,
            response: {
              carrierVersion: 1,
              type: "host.reauthenticated",
              requestId: request.requestId,
              connectorId: request.connectorId,
              payload: {
                grantId: nextAuth.grantId,
                jti: nextAuth.jti,
                expiresAtMs: nextAuth.expiresAtMs,
                deduplicated: false,
              },
            },
          };
        },
      },
    },
    authorizationExpiryScheduleAt: (atMs, callback) => {
      const task = { atMs, callback, cancelled: false };
      scheduled.push(task);
      return () => { task.cancelled = true; };
    },
  });
  const socket = new FakeUpgradedSocket({ synchronousSend: true });
  const prepared = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: initialAuth,
  });
  assert.equal(prepared.outcome, "accept");
  shared.hostWssRuntime.attachPreparedHostWss({
    receipt: prepared.receipt,
    alreadyUpgradedSocket: socket,
  });
  socket.emit("message", carrierFrame(hostHello()), false);
  await settle();
  assert.equal(socket.frame(0).type, "host.registered");
  const connectorId = socket.frame(0).connectorId;

  const firstWarningAt = initialAuth.expiresAtMs - 60_000;
  const firstWarning = scheduled.find(
    (task) => task.atMs === firstWarningAt && !task.cancelled,
  );
  assert.ok(firstWarning, "warning is armed at exp-60s from the closed cut");
  now.value = firstWarningAt;
  firstWarning.callback();
  await settle();
  const warningIndex = socket.sends.findIndex(
    (_, index) => socket.frame(index).type === "host.auth_expiring",
  );
  assert.ok(warningIndex > 0, "the warning frame is written to the host socket");
  assert.equal(socket.frame(warningIndex).payload.grantId, initialAuth.grantId);
  assert.equal(socket.frame(warningIndex).payload.expiresAtMs, initialAuth.expiresAtMs);
  assert.equal(
    socket.frame(warningIndex).payload.refreshRecommendedAtMs,
    initialAuth.expiresAtMs - 300_000,
  );

  socket.emit("message", carrierFrame({
    carrierVersion: 1,
    type: "host.reauthenticate",
    requestId: randomUUID(),
    connectorId,
    payload: { accessToken: "twcap2.replacement" },
  }), false);
  await settle();
  const live = scheduled.filter((task) => !task.cancelled).map((task) => task.atMs);
  assert.deepEqual(
    [...live].sort((a, b) => a - b),
    [nextAuth.expiresAtMs - 60_000, nextAuth.expiresAtMs],
    "a shorter-exp reauth re-arms warning and exact expiry in the same turn",
  );

  const sendsBeforeOldFire = socket.sends.length;
  firstWarning.callback();
  await settle();
  assert.equal(
    socket.sends.length,
    sendsBeforeOldFire,
    "the replaced old-identity warning is a no-op",
  );

  const replacementWarning = scheduled.find(
    (task) => !task.cancelled && task.atMs === nextAuth.expiresAtMs - 60_000,
  );
  now.value = nextAuth.expiresAtMs - 60_000;
  replacementWarning.callback();
  await settle();
  const replacementIndex = socket.sends.findIndex(
    (_, index) => index > warningIndex && socket.frame(index).type === "host.auth_expiring",
  );
  assert.ok(replacementIndex > warningIndex, "the replacement credential warns again");
  assert.equal(socket.frame(replacementIndex).payload.grantId, nextAuth.grantId);
  assert.equal(socket.frame(replacementIndex).payload.expiresAtMs, nextAuth.expiresAtMs);
  assert.equal(
    socket.frame(replacementIndex).payload.refreshRecommendedAtMs,
    nextAuth.expiresAtMs - 300_000,
  );

  socket.emit("close", 1000);
  await shared.hostWssRuntime.closeAndDrain();
});

test("a warning due inside the beginClose/disconnect window maps closed and never seals", async () => {
  const now = { value: NOW_MS };
  const scheduled = [];
  const shared = pump.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeUpgradedSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: {
      now: () => now.value,
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    authorizationExpiryScheduleAt: (atMs, callback) => {
      const task = { atMs, callback, cancelled: false };
      scheduled.push(task);
      return () => { task.cancelled = true; };
    },
  });
  const firstSocket = new FakeUpgradedSocket();
  const prepared = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext(),
  });
  assert.equal(prepared.outcome, "accept");
  shared.hostWssRuntime.attachPreparedHostWss({
    receipt: prepared.receipt,
    alreadyUpgradedSocket: firstSocket,
  });
  firstSocket.emit("message", carrierFrame(hostHello()), false);
  await settle();
  assert.equal(firstSocket.frame(0).type, "host.registered");
  firstSocket.sends[0].callback();
  await settle();
  const warningAt = NOW_MS + 3_600_000 - 60_000;
  const warning = scheduled.find((task) => task.atMs === warningAt && !task.cancelled);
  assert.ok(warning);

  // Supersede runs beginClose+disconnect on the first connection but its
  // native terminal evidence (the socket "close" event) is the drain gate
  // and is never delivered, so terminalAndUnregister stays pending.
  const secondSocket = new FakeUpgradedSocket({ synchronousSend: true });
  const second = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext(),
  });
  assert.equal(second.outcome, "accept");
  shared.hostWssRuntime.attachPreparedHostWss({
    receipt: second.receipt,
    alreadyUpgradedSocket: secondSocket,
  });
  secondSocket.emit("message", carrierFrame(hostHello()), false);
  await settle();
  assert.equal(secondSocket.frame(0).type, "host.registered");
  assert.equal(firstSocket.frame(1).type, "host.superseded");
  firstSocket.sends[1].callback();
  await settle();
  assert.ok(firstSocket.closes.length > 0, "the superseded connection entered beginClose");
  assert.equal(
    warning.cancelled,
    false,
    "the held terminal gate keeps the registration armed, so the fire really enters the lifecycle-rejected path",
  );

  now.value = warningAt;
  warning.callback();
  await settle();
  assert.equal(
    firstSocket.sends.filter((_, index) => (
      firstSocket.frame(index).type === "host.auth_expiring"
    )).length,
    0,
    "the close-window warning maps to closed before any enqueue",
  );

  const thirdSocket = new FakeUpgradedSocket({ synchronousSend: true });
  const third = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext("other-host"),
  });
  assert.equal(third.outcome, "accept", "composition admits a new host after the close-window warning");
  shared.hostWssRuntime.attachPreparedHostWss({
    receipt: third.receipt,
    alreadyUpgradedSocket: thirdSocket,
  });
  thirdSocket.emit("message", carrierFrame(hostHello("other-host")), false);
  await settle();
  assert.equal(thirdSocket.frame(0).type, "host.registered");
  firstSocket.emit("close", 1000);
  secondSocket.emit("close", 1000);
  thirdSocket.emit("close", 1000);
  await shared.hostWssRuntime.closeAndDrain();
});

test("an open/current warning emit failure seals the composition", async () => {
  const now = { value: NOW_MS };
  const scheduled = [];
  let failClock = false;
  let clockCalls = 0;
  const shared = pump.createRelayV2BrokerSharedProducerRuntimeComposition({
    hostWssTrustedSocketPrototype: FakeUpgradedSocket.prototype,
    hostWssTrustedSocketBrand: trustedUpgradedSocketBrand,
    brokerOptions: {
      now: () => {
        if (failClock) {
          clockCalls += 1;
          // The in-try expiry read stays numeric; the next trusted-clock
          // read outside the try throws inside the Core cut.
          if (clockCalls > 1) throw new Error("trusted clock failure");
        }
        return now.value;
      },
      baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    authorizationExpiryScheduleAt: (atMs, callback) => {
      const task = { atMs, callback, cancelled: false };
      scheduled.push(task);
      return () => { task.cancelled = true; };
    },
  });
  const socket = new FakeUpgradedSocket({ synchronousSend: true });
  const prepared = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext(),
  });
  assert.equal(prepared.outcome, "accept");
  shared.hostWssRuntime.attachPreparedHostWss({
    receipt: prepared.receipt,
    alreadyUpgradedSocket: socket,
  });
  socket.emit("message", carrierFrame(hostHello()), false);
  await settle();
  assert.equal(socket.frame(0).type, "host.registered");
  const warningAt = NOW_MS + 3_600_000 - 60_000;
  const warning = scheduled.find((task) => task.atMs === warningAt && !task.cancelled);
  assert.ok(warning);

  now.value = warningAt;
  failClock = true;
  clockCalls = 0;
  warning.callback();
  await settle();

  const late = shared.hostWssRuntime.prepareHostWss({
    trustedAuthContext: authContext("other-host"),
  });
  assert.equal(late.outcome, "reject", "an open/current emit failure seals the composition");
  socket.emit("close", 1000);
  await shared.hostWssRuntime.closeAndDrain().catch(() => {});
});
