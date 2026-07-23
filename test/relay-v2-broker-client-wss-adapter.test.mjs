import assert from "node:assert/strict";
import test from "node:test";

const adapterModule = await import("../dist/relay/v2/brokerClientWssAdapter.js");

const NOW_MS = 1_783_700_000_000;

function authContext() {
  return Object.freeze({
    scheme: "twcap2",
    role: "client",
    hostId: "mac-admin",
    principalId: "client-principal",
    grantId: "client-grant",
    clientInstanceId: "android-install",
    jti: "client-jti",
    kid: "kid-current",
    expiresAtMs: NOW_MS + 60_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
  });
}

function producerTarget() {
  return Object.freeze({ transportId: "host-transport", generation: "7" });
}

class StrictFakeSocket {
  constructor() {
    this._readyState = 1;
    this._protocol = "tw-relay.v2";
    this._extensions = "";
    this._bufferedAmount = 0;
    this.listeners = new Map();
    this.sends = [];
    this.pauses = 0;
    this.resumes = 0;
    this.closes = [];
    this.terminates = 0;
    this.sendImpl = undefined;
    this.onImpl = undefined;
    this.closeImpl = undefined;
    this.terminateImpl = undefined;
  }

  get readyState() { return this._readyState; }
  get protocol() { return this._protocol; }
  get extensions() { return this._extensions; }
  get bufferedAmount() { return this._bufferedAmount; }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    if (this.onImpl) return this.onImpl({ event, listener });
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

  send(bytes, options, callback) {
    const call = { bytes, options, callback };
    this.sends.push(call);
    if (this.sendImpl) return this.sendImpl(call);
    return undefined;
  }

  pause() {
    this.pauses += 1;
  }

  resume() {
    this.resumes += 1;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
    if (this.closeImpl) return this.closeImpl({ code, reason });
  }

  terminate() {
    this.terminates += 1;
    if (this.terminateImpl) return this.terminateImpl();
  }
}

function createFakeTransport(overrides = {}) {
  const state = {
    inputs: [],
    received: [],
    closed: 0,
    errored: 0,
    writable: 0,
  };
  const openResult = Object.freeze({ accepted: true, routeId: "route-1" });
  const transport = {
    registerClientSocket(input) {
      state.inputs.push(input);
      overrides.onRegister?.(input);
      return Object.freeze({
        connectionId: overrides.connectionId ?? input.connectionId,
        connectionIncarnation: "client-incarnation-1",
        openResult,
        receive(bytes, metadata) {
          state.received.push({ bytes, metadata });
          return overrides.receive?.(input, bytes, metadata)
            ?? Object.freeze({ accepted: true, actions: [] });
        },
        writable() {
          state.writable += 1;
          return "applied";
        },
        closed() {
          state.closed += 1;
          return Object.freeze({ accepted: true, actions: [] });
        },
        errored() {
          state.errored += 1;
          return Object.freeze({ accepted: true, actions: [] });
        },
      });
    },
  };
  return { transport, state, openResult };
}

function createAdapter(socket, fakeTransport, overrides = {}) {
  const authorization = overrides.authContext ?? authContext();
  const target = overrides.hostProducerTarget ?? producerTarget();
  const capture = adapterModule.createRelayV2BrokerClientWssCaptureAuthority(
    StrictFakeSocket.prototype,
    (candidate) => candidate === socket,
  );
  const adapter = capture.create({
    connectionId: overrides.connectionId ?? "client-connection-1",
    authContext: authorization,
    hostProducerTarget: target,
    socket,
    transport: fakeTransport.transport,
  });
  return { adapter, authorization, target, port: fakeTransport.state.inputs[0].socket };
}

test("broker client WSS adapter translates text, write completion, flow control, and close", async () => {
  const socket = new StrictFakeSocket();
  const fakeTransport = createFakeTransport();
  const { adapter, authorization, target, port } = createAdapter(socket, fakeTransport);

  assert.notStrictEqual(fakeTransport.state.inputs[0].authContext, authorization);
  assert.notStrictEqual(fakeTransport.state.inputs[0].hostProducerTarget, target);
  assert.deepEqual(fakeTransport.state.inputs[0].authContext, authorization);
  assert.deepEqual(fakeTransport.state.inputs[0].hostProducerTarget, target);
  assert.equal(Object.isFrozen(fakeTransport.state.inputs[0].authContext), true);
  assert.equal(Object.isFrozen(fakeTransport.state.inputs[0].hostProducerTarget), true);
  assert.strictEqual(adapter.openResult, fakeTransport.openResult);
  assert.equal(adapter.connectionIncarnation, "client-incarnation-1");

  const incoming = Buffer.from("text-frame");
  socket.emit("message", incoming, false);
  incoming.fill(0);
  assert.deepEqual(
    [...fakeTransport.state.received[0].bytes],
    [...Buffer.from("text-frame")],
  );
  assert.deepEqual(fakeTransport.state.received[0].metadata, {
    opcode: "text",
    compressed: false,
  });

  assert.equal(port.pause(), "applied");
  assert.equal(port.resume(), "applied");
  assert.equal(socket.pauses, 1);
  assert.equal(socket.resumes, 1);

  const completions = [];
  const outbound = Uint8Array.from([123, 34, 120, 34, 58, 49, 125]);
  socket._bufferedAmount = 17;
  assert.equal(port.send(outbound, (receipt) => completions.push(receipt)), "applied");
  outbound.fill(0);
  assert.deepEqual([...socket.sends[0].bytes], [123, 34, 120, 34, 58, 49, 125]);
  assert.deepEqual(socket.sends[0].options, { binary: false, compress: false });
  assert.deepEqual(port.bufferedState(), { bytes: 17, frames: 1 });

  socket.sends[0].callback(null);
  socket.sends[0].callback(new Error("late"));
  assert.deepEqual(completions, []);
  await Promise.resolve();
  assert.deepEqual(completions, ["delivered"]);
  assert.deepEqual(port.bufferedState(), { bytes: 17, frames: 0 });

  assert.equal(port.close(1000, "normal"), "applied");
  assert.deepEqual(socket.closes, [{ code: 1000, reason: "normal" }]);
  socket.emit("close", 1000, Buffer.from("ignored"));
  assert.deepEqual(await adapter.terminal, { kind: "closed", code: 1000 });
  await adapter.drained;
  assert.equal(fakeTransport.state.closed, 1);
  assert.equal(fakeTransport.state.errored, 0);

  socket.emit("message", Buffer.from("late"), false);
  socket.emit("error", new Error("late"));
  assert.equal(fakeTransport.state.received.length, 1);
  assert.equal(fakeTransport.state.closed, 1);
  assert.equal(fakeTransport.state.errored, 0);
  assert.equal(port.send(Uint8Array.of(1), () => assert.fail("late completion")), "rejected");
});

test("broker client WSS adapter preserves binary metadata and rejects unsafe send completion paths", async () => {
  const binarySocket = new StrictFakeSocket();
  const binaryTransport = createFakeTransport({
    receive(input, _bytes, metadata) {
      if (metadata.opcode === "binary") {
        assert.equal(input.socket.close(4400, "invalid_client_frame"), "applied");
        return Object.freeze({ accepted: false, actions: [] });
      }
      return Object.freeze({ accepted: true, actions: [] });
    },
  });
  const { adapter: binaryAdapter } = createAdapter(binarySocket, binaryTransport);

  binarySocket.emit("message", Buffer.from("looks-like-text"), true);
  assert.deepEqual(binaryTransport.state.received[0].metadata, {
    opcode: "binary",
    compressed: false,
  });
  assert.deepEqual(binarySocket.closes, [{ code: 4400, reason: "invalid_client_frame" }]);
  binarySocket.emit("close", 4400, Buffer.alloc(0));
  await binaryAdapter.terminal;
  await binaryAdapter.drained;

  const socket = new StrictFakeSocket();
  const fakeTransport = createFakeTransport();
  const { adapter, port } = createAdapter(socket, fakeTransport);

  const completions = [];
  socket.sendImpl = ({ callback }) => {
    callback();
    assert.deepEqual(completions, []);
    return undefined;
  };
  assert.equal(port.send(Uint8Array.of(1), (receipt) => completions.push(receipt)), "applied");
  assert.deepEqual(completions, []);
  await Promise.resolve();
  assert.deepEqual(completions, ["delivered"]);

  socket.sendImpl = () => {
    throw new Error("sync send failure");
  };
  assert.equal(port.send(Uint8Array.of(2), (receipt) => completions.push(receipt)), "rejected");

  let syncThenThrow;
  socket.sendImpl = ({ callback }) => {
    syncThenThrow = callback;
    callback();
    throw new Error("throw after callback");
  };
  assert.equal(port.send(Uint8Array.of(3), (receipt) => completions.push(receipt)), "rejected");
  syncThenThrow(new Error("late callback"));

  socket.sendImpl = ({ callback }) => {
    callback();
    return socket;
  };
  assert.equal(port.send(Uint8Array.of(4), (receipt) => completions.push(receipt)), "rejected");
  await Promise.resolve();
  assert.deepEqual(completions, ["delivered"]);

  let asynchronousError;
  socket.sendImpl = ({ callback }) => {
    asynchronousError = callback;
    return undefined;
  };
  assert.equal(port.send(Uint8Array.of(5), (receipt) => completions.push(receipt)), "applied");
  asynchronousError(new Error("asynchronous write failure"));
  assert.deepEqual(completions, ["delivered"]);
  await Promise.resolve();
  assert.deepEqual(completions, ["delivered", "rejected"]);

  let lateSuccess;
  socket.sendImpl = ({ callback }) => {
    lateSuccess = callback;
    return undefined;
  };
  assert.equal(port.send(Uint8Array.of(6), (receipt) => completions.push(receipt)), "applied");
  assert.equal(port.forceDestroy(), "applied");
  assert.equal(socket.terminates, 1);
  socket.emit("error", new Error("terminal"));
  socket.emit("close", 1006, Buffer.alloc(0));
  lateSuccess();
  await Promise.resolve();

  assert.deepEqual(await adapter.terminal, { kind: "errored" });
  await adapter.drained;
  assert.equal(fakeTransport.state.errored, 1);
  assert.equal(fakeTransport.state.closed, 0);
  assert.deepEqual(completions, ["delivered", "rejected"]);

  const invalidSocket = new StrictFakeSocket();
  invalidSocket._protocol = "tw-relay.v1";
  assert.throws(
    () => createAdapter(invalidSocket, createFakeTransport()),
    adapterModule.RelayV2BrokerClientWssAdapterError,
  );
  assert.equal(invalidSocket.terminates, 1);

  const identityMismatch = new StrictFakeSocket();
  assert.throws(
    () => createAdapter(
      identityMismatch,
      createFakeTransport({ connectionId: "foreign-connection" }),
    ),
    adapterModule.RelayV2BrokerClientWssAdapterError,
  );
  assert.equal(identityMismatch.terminates, 1);

  assert.throws(
    () => adapterModule.createRelayV2BrokerClientWssCaptureAuthority(
      StrictFakeSocket.prototype,
      () => false,
    ).create(new Proxy({}, {})),
    adapterModule.RelayV2BrokerClientWssAdapterError,
  );
  assert.throws(
    () => adapterModule.createRelayV2BrokerClientWssCaptureAuthority(
      StrictFakeSocket.prototype,
      () => false,
    ).create(
      Object.defineProperty({}, "socket", {
        enumerable: true,
        get: () => new StrictFakeSocket(),
      }),
    ),
    adapterModule.RelayV2BrokerClientWssAdapterError,
  );
});

test("broker client WSS adapter rejects synchronous setup reentry before registration", async (t) => {
  const cases = [
    {
      name: "close",
      event: "close",
      args: [1001, Buffer.from("setup-close")],
    },
    {
      name: "error",
      event: "error",
      args: [new Error("setup-error")],
    },
    {
      name: "message",
      event: "message",
      args: [Buffer.from("setup-message"), false],
    },
    {
      name: "on throws after install",
      event: "close",
      throws: true,
    },
  ];

  for (const setupCase of cases) {
    await t.test(setupCase.name, () => {
      const socket = new StrictFakeSocket();
      const fakeTransport = createFakeTransport();
      socket.onImpl = ({ event, listener }) => {
        if (event !== setupCase.event) return socket;
        if (setupCase.throws) throw new Error("installed then threw");
        Reflect.apply(listener, socket, setupCase.args);
        return socket;
      };

      assert.throws(
        () => createAdapter(socket, fakeTransport),
        adapterModule.RelayV2BrokerClientWssAdapterError,
      );
      assert.equal(fakeTransport.state.inputs.length, 0);
      assert.equal(socket.terminates, 1);
      assert.equal(
        [...socket.listeners.values()].every((listeners) => listeners.length === 0),
        true,
      );
    });
  }

  await t.test("terminal reentry during registration uses the exact registration once", async () => {
    const socket = new StrictFakeSocket();
    const fakeTransport = createFakeTransport({
      onRegister() {
        socket.emit("close", 1001, Buffer.from("registered-close"));
      },
    });
    const { adapter } = createAdapter(socket, fakeTransport);

    assert.deepEqual(await adapter.terminal, { kind: "closed", code: 1001 });
    await adapter.drained;
    assert.equal(fakeTransport.state.closed, 1);
    assert.equal(fakeTransport.state.errored, 0);
    socket.emit("error", new Error("late"));
    assert.equal(fakeTransport.state.closed, 1);
    assert.equal(fakeTransport.state.errored, 0);
  });
});

test("broker client WSS adapter captures auth and producer target before socket reentry", async () => {
  const socket = new StrictFakeSocket();
  const authorization = { ...authContext() };
  const target = { ...producerTarget() };
  const originalAuthorization = { ...authorization };
  const originalTarget = { ...target };
  socket.onImpl = () => {
    authorization.hostId = "mutated-host";
    target.transportId = "mutated-transport";
    target.generation = "99";
    return socket;
  };
  const fakeTransport = createFakeTransport();
  const { adapter } = createAdapter(socket, fakeTransport, {
    authContext: authorization,
    hostProducerTarget: target,
  });

  assert.deepEqual(fakeTransport.state.inputs[0].authContext, originalAuthorization);
  assert.deepEqual(fakeTransport.state.inputs[0].hostProducerTarget, originalTarget);
  assert.equal(Object.isFrozen(fakeTransport.state.inputs[0].authContext), true);
  assert.equal(Object.isFrozen(fakeTransport.state.inputs[0].hostProducerTarget), true);

  socket.emit("close", 1000, Buffer.alloc(0));
  await adapter.terminal;
  await adapter.drained;
});

test("broker client WSS adapter commits sends only while OPEN and fences close or terminate intent", async (t) => {
  await t.test("send rechecks OPEN and a synchronous forceDestroy suppresses completion", async () => {
    const socket = new StrictFakeSocket();
    const fakeTransport = createFakeTransport();
    const { adapter, port } = createAdapter(socket, fakeTransport);
    const completions = [];

    socket.sendImpl = ({ callback }) => {
      callback();
      socket._readyState = 2;
      return undefined;
    };
    assert.equal(port.send(Uint8Array.of(1), (receipt) => completions.push(receipt)), "rejected");
    await Promise.resolve();
    assert.deepEqual(completions, []);

    socket._readyState = 1;
    socket.sendImpl = ({ callback }) => {
      callback();
      assert.equal(port.forceDestroy(), "applied");
      return undefined;
    };
    assert.equal(port.send(Uint8Array.of(2), (receipt) => completions.push(receipt)), "rejected");
    assert.equal(socket.terminates, 1);
    assert.equal(port.send(Uint8Array.of(3), () => assert.fail("fenced send")), "rejected");
    assert.equal(port.pause(), "rejected");
    assert.equal(port.resume(), "rejected");
    await Promise.resolve();
    assert.deepEqual(completions, []);

    socket.emit("error", new Error("terminated"));
    assert.deepEqual(await adapter.terminal, { kind: "errored" });
    await adapter.drained;
  });

  await t.test("successful close intent suppresses an outstanding native callback", async () => {
    const socket = new StrictFakeSocket();
    const fakeTransport = createFakeTransport();
    const { adapter, port } = createAdapter(socket, fakeTransport);
    const completions = [];
    let lateCallback;
    socket.sendImpl = ({ callback }) => {
      lateCallback = callback;
      return undefined;
    };

    assert.equal(port.send(Uint8Array.of(4), (receipt) => completions.push(receipt)), "applied");
    assert.equal(port.close(1000, "normal"), "applied");
    assert.equal(port.send(Uint8Array.of(5), () => assert.fail("fenced send")), "rejected");
    assert.equal(port.pause(), "rejected");
    assert.equal(port.resume(), "rejected");
    lateCallback();
    await Promise.resolve();
    assert.deepEqual(completions, []);

    socket.emit("close", 1000, Buffer.alloc(0));
    assert.deepEqual(await adapter.terminal, { kind: "closed", code: 1000 });
    await adapter.drained;
  });
});

test("broker client WSS adapter fences callback failures before exactly-once terminate", async (t) => {
  await t.test("receive throw fences later events and effects", async () => {
    const socket = new StrictFakeSocket();
    const fakeTransport = createFakeTransport({
      receive() {
        throw new Error("receive failed");
      },
    });
    const { adapter, port } = createAdapter(socket, fakeTransport);

    socket.emit("message", Buffer.from("first"), false);
    socket.emit("message", Buffer.from("second"), false);
    assert.equal(fakeTransport.state.received.length, 1);
    assert.equal(socket.terminates, 1);
    assert.equal(port.send(Uint8Array.of(1), () => assert.fail("fenced send")), "rejected");
    const drained = assert.rejects(
      adapter.drained,
      adapterModule.RelayV2BrokerClientWssAdapterError,
    );
    socket.emit("error", new Error("terminal"));
    assert.deepEqual(await adapter.terminal, { kind: "errored" });
    await drained;
    assert.equal(fakeTransport.state.errored, 1);
    assert.equal(socket.terminates, 1);
  });

  await t.test("completion throw fences later callbacks and effects", async () => {
    const socket = new StrictFakeSocket();
    const fakeTransport = createFakeTransport();
    const { adapter, port } = createAdapter(socket, fakeTransport);
    let nativeCallback;
    socket.sendImpl = ({ callback }) => {
      nativeCallback = callback;
      return undefined;
    };

    assert.equal(port.send(Uint8Array.of(2), () => {
      throw new Error("completion failed");
    }), "applied");
    nativeCallback();
    await Promise.resolve();
    assert.equal(socket.terminates, 1);
    nativeCallback(new Error("late"));
    assert.equal(port.send(Uint8Array.of(3), () => assert.fail("fenced send")), "rejected");
    const drained = assert.rejects(
      adapter.drained,
      adapterModule.RelayV2BrokerClientWssAdapterError,
    );
    socket.emit("close", 1006, Buffer.alloc(0));
    assert.deepEqual(await adapter.terminal, { kind: "closed", code: 1006 });
    await drained;
    assert.equal(fakeTransport.state.closed, 1);
    assert.equal(socket.terminates, 1);
  });
});
