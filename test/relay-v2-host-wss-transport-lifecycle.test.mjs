import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const carrierModule = await import("../dist/relay/v2/hostCarrier.js");
const codec = await import("../dist/relay/v2/codec.js");
const attemptAdapterModule = await import(
  "../dist/relay/v2/hostConnectorCarrierAttemptAdapter.js"
);
const credentialModule = await import("../dist/relay/v2/hostCredentialAuthority.js");
const issuer = await import("../dist/relay/v2/issuer.js");
const wss = await import("../dist/relay/v2/hostWssTransportLifecycle.js");

const HOST_ID = "mac-admin";
const HOST_EPOCH = "host-epoch-one";
const HOST_INSTANCE_ID = "host-instance-one";
const REFERENCE = "relay-v2-host-credential-ref:primary";
const corpus = loadRelayV2FixtureCorpus();

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function carrierWire(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function decodeCarrier(bytes) {
  return codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
}

function authorizationDigest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class InMemoryCredentialStorage {
  slots = new Map();
  exclusiveDepth = 0;
  operationErrors = [];

  runExclusive(reference, operation) {
    if (this.exclusiveDepth !== 0) {
      throw new Error("injected non-reentrant credential storage");
    }
    const slot = this.slot(reference);
    this.exclusiveDepth += 1;
    try {
      return operation({
        read: () => ({
          state: slot.state === null ? null : deepFreeze(structuredClone(slot.state)),
          revision: Object.freeze({ revision: slot.revision }),
        }),
        compareAndSwap: (_expected, replacement) => {
          slot.state = replacement === null ? null : structuredClone(replacement);
          slot.revision += 1;
          return { status: "swapped" };
        },
      });
    } catch (error) {
      this.operationErrors.push(error);
      throw error;
    } finally {
      this.exclusiveDepth -= 1;
    }
  }

  slot(reference) {
    let slot = this.slots.get(reference);
    if (!slot) {
      slot = { state: null, revision: 0 };
      this.slots.set(reference, slot);
    }
    return slot;
  }

  snapshot(reference) {
    const state = this.slot(reference).state;
    return state === null ? null : structuredClone(state);
  }

  replace(reference, state) {
    const slot = this.slot(reference);
    slot.state = state === null ? null : structuredClone(state);
    slot.revision += 1;
  }
}

function tokenIssuer() {
  let keyring = issuer.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "host-wss-test-key",
    secretBase64url: Buffer.alloc(32, 0x61).toString("base64url"),
    nowSeconds: 1_783_700_000,
  });
  let sequence = 0;
  return () => {
    sequence += 1;
    const prepared = issuer.prepareRelayV2AccessTokenIssuance(keyring, {
      role: "host",
      hostId: HOST_ID,
      principalId: "host-principal-one",
      grantId: "host-grant-one",
      nowSeconds: 1_783_700_000 + sequence,
      jti: `host-access-${sequence}`,
    });
    keyring = prepared.nextKeyring;
    return {
      token: prepared.token,
      jti: prepared.claims.jti,
      expiresAtMs: prepared.claims.exp * 1_000,
    };
  };
}

function credentialHarness() {
  const storage = new InMemoryCredentialStorage();
  const issue = tokenIssuer();
  const authority = new credentialModule.RelayV2HostCredentialAuthority({
    storage,
    secretResolver: {
      resolve(reference) {
        if (reference === "bootstrap-secret-one") return "twhostboot2.bootstrap-one";
        if (reference === "refresh-secret-one") return "twref2.refresh-one";
        throw new Error("unexpected secret reference");
      },
    },
  });
  const prepared = authority.prepareBootstrap({
    credentialReference: REFERENCE,
    hostId: HOST_ID,
    attemptId: "bootstrap-attempt-one",
    oldSecretReference: "bootstrap-secret-one",
  });
  const access = issue();
  assert.deepEqual(authority.applyBootstrapResponse(prepared.fence, {
    bootstrapAttemptId: "bootstrap-attempt-one",
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: "twref2.refresh-one",
    refreshExpiresAtMs: access.expiresAtMs + 86_400_000,
  }), { status: "applied", credentialVersion: "1" });
  return {
    storage,
    authority,
    access,
    expectedAuthorizationDigest: authorizationDigest(`Bearer ${access.token}`),
    issue,
  };
}

function replaceCredential(harness) {
  const state = harness.storage.snapshot(REFERENCE);
  const access = harness.issue();
  state.credentialVersion = (BigInt(state.credentialVersion) + 1n).toString(10);
  state.accessToken = access.token;
  state.accessJti = access.jti;
  state.accessExpiresAtMs = access.expiresAtMs;
  harness.storage.replace(REFERENCE, state);
}

function refreshCredential(harness) {
  const access = harness.issue();
  const prepared = harness.authority.prepareRefresh({
    credentialReference: REFERENCE,
    attemptId: "refresh-at-request-finalization",
    oldSecretReference: "refresh-secret-one",
  });
  return harness.authority.applyRefreshResponse(prepared.fence, {
    refreshAttemptId: prepared.fence.attemptId,
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: "twref2.refresh-two",
    refreshExpiresAtMs: access.expiresAtMs + 86_400_000,
  });
}

function revokeCredential(storage) {
  return storage.runExclusive(REFERENCE, (transaction) => {
    const read = transaction.read();
    return transaction.compareAndSwap(read.revision, null);
  });
}

function attempt(sequence = 1, signal = new AbortController().signal) {
  return Object.freeze({
    requestId: `wss-attempt-${sequence}`,
    controllerGeneration: String(sequence),
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReference: REFERENCE,
    signal,
  });
}

function fakeWebSockets(expectedAuthorizationDigest, behavior = {}) {
  const sockets = [];
  class FakeHandshakeRequest {
    setHeaderCalls = 0;
    endCalls = 0;
    destroyCalls = 0;
    authorizationIsExact = false;
    authorizationHeaderNameIsExact = false;

    setHeader(name, value) {
      this.setHeaderCalls += 1;
      this.authorizationHeaderNameIsExact = name === "Authorization";
      this.authorizationIsExact = typeof value === "string"
        && authorizationDigest(value) === expectedAuthorizationDigest;
      behavior.onSetHeader?.(this);
    }

    end() {
      this.endCalls += 1;
      behavior.onEnd?.(this);
    }

    destroy() {
      this.destroyCalls += 1;
    }
  }

  class FakeWebSocket {
    _readyState = 0;
    _protocol = "";
    _extensions = "";
    bufferedAmount = 99_999_999;
    listeners = new Map();
    writes = [];
    closeCalls = [];
    terminateCalls = 0;

    constructor(address, protocols, options) {
      this.request = behavior.requestFactory?.() ?? new FakeHandshakeRequest();
      this.extraRequests = [];
      this.finishRequest = options.finishRequest;
      this.construction = Object.freeze({
        address,
        protocols: [...protocols],
        optionKeys: Reflect.ownKeys(options),
        hasHeadersOption: Object.hasOwn(options, "headers"),
        finishRequestIsFunction: typeof options.finishRequest === "function",
        perMessageDeflate: options.perMessageDeflate,
        maxPayload: options.maxPayload,
      });
      sockets.push(this);
      behavior.onConstructor?.(this);
      if (!behavior.skipFinishRequest) {
        const invoke = (request, webSocket) => {
          try {
            options.finishRequest(request, webSocket);
          } catch (error) {
            if (!behavior.swallowFinishRequestError) throw error;
          }
        };
        invoke(this.request, behavior.requestWebSocket ?? this);
        for (const request of behavior.additionalRequests ?? []) {
          this.extraRequests.push(request);
          invoke(request, this);
        }
      }
    }

    get readyState() {
      behavior.onReadyState?.(this);
      return this._readyState;
    }

    set readyState(value) {
      this._readyState = value;
    }

    get protocol() {
      behavior.onProtocol?.(this);
      return this._protocol;
    }

    set protocol(value) {
      this._protocol = value;
    }

    get extensions() {
      behavior.onExtensions?.(this);
      return this._extensions;
    }

    set extensions(value) {
      this._extensions = value;
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      behavior.onListener?.(event, this);
      return this;
    }

    removeListener(event, listener) {
      if (behavior.removeListenerThrows) throw new Error("injected remove listener failure");
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
      return this;
    }

    emit(event, ...args) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    emitOpen(protocol = wss.RELAY_V2_HOST_WSS_SUBPROTOCOL, extensions = "") {
      this.readyState = 1;
      this.protocol = protocol;
      this.extensions = extensions;
      this.emit("open");
    }

    emitMessage(data, isBinary) {
      this.emit("message", data, isBinary);
    }

    emitClose(code = 1000) {
      this.readyState = 3;
      this.emit("close", code, Buffer.alloc(0));
    }

    send(bytes, options, callback) {
      this.writes.push({
        bytes: typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Uint8Array.from(bytes),
        options,
        callback,
      });
      if (behavior.syncSendCallbackError) {
        callback(new Error("injected non-sensitive synchronous write failure"));
      } else if (behavior.syncSendCallback) {
        callback();
      }
      if (behavior.sendThrowAfterCallback) {
        throw new Error("injected non-sensitive send failure");
      }
      return behavior.sendReturn;
    }

    close(code, reason) {
      this.closeCalls.push({ code, reason });
      this.readyState = 2;
    }

    terminate() {
      this.terminateCalls += 1;
      this.readyState = 3;
    }
  }
  return { sockets, FakeWebSocket };
}

function deadlineScheduler(behavior = {}) {
  const deadlines = [];
  return {
    deadlines,
    schedule(delayMs, callback) {
      const deadline = { delayMs, callback, cancelled: false };
      deadlines.push(deadline);
      return () => {
        deadline.cancelled = true;
        if (behavior.cancelThrows) {
          throw new Error("injected non-sensitive deadline cancellation failure");
        }
      };
    },
  };
}

function createFactory(harness, sockets, scheduler, overrides = {}) {
  return new wss.RelayV2HostWssTransportLifecycleFactory({
    relayUrl: "wss://relay.example.test/",
    credentialAuthority: harness.authority,
    webSocketConstructor: sockets.FakeWebSocket,
    scheduleCloseDrain: scheduler.schedule,
    ...overrides,
  });
}

function prepare(factory, authority, input) {
  const admission = wss.prepareRelayV2HostWssTransportLifecycleAttempt(
    factory,
    Object.freeze({ ...input, credentialReferences: authority }),
  );
  assert.notEqual(admission, null);
  return admission;
}

function actor(authority, admission, statuses = []) {
  return new carrierModule.RelayV2HostCarrierActor({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReferences: authority,
    credentialConnectionAdmission: admission,
    routeSink: {
      onRouteBound() {},
      onClientFrame() {},
      onRouteUnbound() {},
    },
    advertisedCapabilities: [],
    clientDialects: ["tw-relay.v2"],
    dialectAdapters: Object.freeze({}),
    idFactory: () => "host-hello-one",
    onStatus: (status) => statuses.push(structuredClone(status)),
  });
}

function observedConnection(connection, observations) {
  return Object.freeze({
    generation: connection.generation,
    receive(bytes) {
      observations.receives += 1;
      if (observations.suppressForwarding) return;
      return connection.receive(bytes);
    },
    acknowledge(deliveryToken) {
      observations.acks.push({
        deliveryToken,
        bufferedAmount: observations.bufferedAmount(),
      });
      if (observations.suppressForwarding) return;
      return connection.acknowledge(deliveryToken);
    },
    rejectUnaccepted(deliveryToken) {
      if (observations.suppressForwarding) return;
      return connection.rejectUnaccepted(deliveryToken);
    },
    writable() {
      observations.writables.push({
        acknowledgementCount: observations.acks.length,
        bufferedAmount: observations.bufferedAmount(),
      });
      if (observations.suppressForwarding) return;
      return connection.writable();
    },
    closed(code) {
      observations.closes.push(code);
      if (observations.closeThrows) {
        throw new Error("injected non-sensitive close observation failure");
      }
      if (observations.suppressForwarding) return;
      return connection.closed(code);
    },
  });
}

function registeredFrame(hello) {
  const registered = fixture("host-registered");
  registered.requestId = hello.requestId;
  registered.connectorId = "wss-connector-one";
  return carrierWire(registered);
}

function routeOpenFrame() {
  const route = fixture("route-open");
  route.connectorId = "wss-connector-one";
  route.routeId = "wss-route-one";
  route.routeFence = "wss-fence-one";
  route.payload.connectionId = "wss-connection-one";
  route.payload.authContext.hostId = HOST_ID;
  return carrierWire(route);
}

async function closeLifecycle(lifecycle, socket = null) {
  lifecycle.transport.close(1000, "host_shutdown");
  const proof = Object.freeze(Object.create(null));
  const drained = lifecycle.awaitDrained(proof);
  socket?.emitClose(1000);
  assert.equal(await drained, proof);
}

test("credential-exact lifecycle opens one exact WSS and preserves FIFO ACK ownership", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
  const scheduler = deadlineScheduler();
  const factory = createFactory(h, sockets, scheduler);
  const input = attempt();
  const admission = prepare(factory, h.authority, input);
  assert.equal(Object.isFrozen(admission), true);
  assert.equal(Object.getPrototypeOf(admission), null);
  assert.deepEqual(Reflect.ownKeys(admission), []);
  const lifecycle = factory.createTransportLifecycle(input);
  assert.equal(sockets.sockets.length, 0);

  h.authority.read = () => { throw new Error("independent credential read forbidden"); };
  const statuses = [];
  const carrier = actor(h.authority, admission, statuses);
  const connection = carrier.connect(lifecycle.transport, REFERENCE);
  const helloBuffered = lifecycle.transport.bufferedAmount();
  assert.ok(helloBuffered > 0);
  assert.equal(sockets.sockets.length, 0, "host.hello ownership does not open the socket");

  const observations = {
    acks: [],
    closes: [],
    receives: 0,
    writables: [],
    bufferedAmount: () => lifecycle.transport.bufferedAmount(),
  };
  lifecycle.bindConnection(observedConnection(connection, observations));
  assert.throws(() => lifecycle.bindConnection(connection));
  assert.equal(sockets.sockets.length, 1);
  const socket = sockets.sockets[0];
  assert.deepEqual(socket.construction, {
    address: "wss://relay.example.test/host",
    protocols: ["tw-relay.host.v2"],
    optionKeys: ["perMessageDeflate", "maxPayload", "finishRequest"],
    hasHeadersOption: false,
    finishRequestIsFunction: true,
    perMessageDeflate: false,
    maxPayload: codec.RELAY_V2_CARRIER_FRAME_BYTES,
  });
  assert.equal(socket.request.authorizationHeaderNameIsExact, true);
  assert.equal(socket.request.authorizationIsExact, true);
  assert.equal(socket.request.setHeaderCalls, 1);
  assert.equal(socket.request.endCalls, 1);
  assert.equal(socket.request.destroyCalls, 0);
  assert.equal(socket.construction.address.includes("?"), false);
  assert.equal(socket.construction.address.includes("#"), false);
  assert.equal(socket.construction.protocols.includes("tw-relay.host.v1"), false);

  socket.emitOpen();
  assert.equal(socket.writes.length, 1);
  assert.deepEqual(socket.writes[0].options, { binary: false, compress: false });
  const hello = decodeCarrier(socket.writes[0].bytes);
  assert.equal(hello.type, "host.hello");
  assert.equal(lifecycle.transport.bufferedAmount(), helloBuffered);
  assert.notEqual(lifecycle.transport.bufferedAmount(), socket.bufferedAmount);

  socket.emitMessage(Buffer.from(registeredFrame(hello)), false);
  socket.emitMessage(Buffer.from(routeOpenFrame()), false);
  assert.equal(statuses.at(-1).phase, "registered");
  assert.equal(socket.writes.length, 1, "one lifecycle write is in flight at a time");
  assert.ok(lifecycle.transport.bufferedAmount() > helloBuffered);

  socket.writes[0].callback();
  await Promise.resolve();
  assert.equal(socket.writes.length, 2);
  assert.equal(decodeCarrier(socket.writes[1].bytes).type, "route.opened");
  assert.deepEqual(observations.acks[0], {
    deliveryToken: "1:1",
    bufferedAmount: socket.writes[1].bytes.byteLength,
  });
  socket.writes[1].callback();
  await Promise.resolve();
  assert.deepEqual(observations.acks.map((entry) => entry.deliveryToken), ["1:1", "1:2"]);
  assert.deepEqual(observations.writables, [
    { acknowledgementCount: 1, bufferedAmount: socket.writes[1].bytes.byteLength },
    { acknowledgementCount: 2, bufferedAmount: 0 },
  ]);
  assert.equal(observations.acks[1].bufferedAmount, 0);
  assert.equal(lifecycle.transport.bufferedAmount(), 0);
  assert.equal(observations.receives, 2);

  await closeLifecycle(lifecycle, socket);
});

test("pre-OPEN FIFO is byte-bounded and refuses overflow without a ws queue", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
  const scheduler = deadlineScheduler();
  const factory = createFactory(h, sockets, scheduler, { maxBufferedBytes: 1_024 });
  const input = attempt();
  const admission = prepare(factory, h.authority, input);
  const lifecycle = factory.createTransportLifecycle(input);
  const carrier = actor(h.authority, admission);
  carrier.connect(lifecycle.transport, REFERENCE);
  const helloBytes = lifecycle.transport.bufferedAmount();
  assert.ok(helloBytes > 0 && helloBytes < 1_024);
  assert.equal(
    lifecycle.transport.trySend(new Uint8Array(1_024 - helloBytes), "bounded-fill"),
    true,
  );
  assert.equal(lifecycle.transport.bufferedAmount(), 1_024);
  assert.equal(lifecycle.transport.trySend(new Uint8Array(1), "bounded-overflow"), false);
  assert.equal(lifecycle.transport.bufferedAmount(), 1_024);
  assert.equal(sockets.sockets.length, 0);
  carrier.dispose();
  await closeLifecycle(lifecycle);
});

test("a pre-request constructor failure releases authorization and drains without headers", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest, { skipFinishRequest: true });
  const scheduler = deadlineScheduler();
  const factory = createFactory(h, sockets, scheduler);
  const input = attempt();
  const admission = prepare(factory, h.authority, input);
  const lifecycle = factory.createTransportLifecycle(input);
  const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
  assert.throws(
    () => lifecycle.bindConnection(connection),
    (error) => error?.name === "RelayV2HostWssTransportLifecycleError",
  );
  assert.equal(sockets.sockets.length, 1);
  const socket = sockets.sockets[0];
  assert.equal(socket.construction.hasHeadersOption, false);
  assert.equal(socket.request.setHeaderCalls, 0);
  assert.equal(socket.request.endCalls, 0);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(lifecycle.transport.bufferedAmount(), 0);
  const proof = Object.freeze(Object.create(null));
  assert.equal(await lifecycle.awaitDrained(proof), proof);
});

test("request capture destroys every actionable handshake request before generic failure", async (t) => {
  function requestProbe(shape) {
    const probe = {
      destroyCalls: 0,
      setHeaderCalls: 0,
      endCalls: 0,
      accessorCalls: 0,
    };
    const request = {
      destroy() { probe.destroyCalls += 1; },
    };
    if (shape !== "missing-set-header") {
      if (shape === "hostile-set-header") {
        Object.defineProperty(request, "setHeader", {
          get() {
            probe.accessorCalls += 1;
            throw new Error("injected non-sensitive request accessor failure");
          },
        });
      } else {
        request.setHeader = () => { probe.setHeaderCalls += 1; };
      }
    }
    if (shape !== "missing-end") request.end = () => { probe.endCalls += 1; };
    return { request, probe };
  }

  for (const shape of ["missing-set-header", "missing-end", "hostile-set-header"]) {
    await t.test(shape, async () => {
      const h = credentialHarness();
      const captured = requestProbe(shape);
      const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
        requestFactory: () => captured.request,
        swallowFinishRequestError: true,
      });
      const scheduler = deadlineScheduler();
      const factory = createFactory(h, sockets, scheduler);
      const input = attempt();
      const admission = prepare(factory, h.authority, input);
      const lifecycle = factory.createTransportLifecycle(input);
      const connection = actor(h.authority, admission).connect(
        lifecycle.transport,
        REFERENCE,
      );
      assert.throws(
        () => lifecycle.bindConnection(connection),
        (error) => error?.name === "RelayV2HostWssTransportLifecycleError",
      );
      assert.equal(captured.probe.destroyCalls, 1);
      assert.equal(captured.probe.setHeaderCalls, 0);
      assert.equal(captured.probe.endCalls, 0);
      assert.equal(captured.probe.accessorCalls, 0);
      assert.equal(sockets.sockets[0].terminateCalls, 1);
      const proof = Object.freeze(Object.create(null));
      assert.equal(await lifecycle.awaitDrained(proof), proof);
    });
  }

  await t.test("duplicate callback destroys the current and first request", async () => {
    const h = credentialHarness();
    const duplicate = requestProbe("missing-set-header");
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      additionalRequests: [duplicate.request],
      swallowFinishRequestError: true,
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    const socket = sockets.sockets[0];
    assert.equal(socket.request.destroyCalls, 1);
    assert.equal(duplicate.probe.destroyCalls, 1);
    assert.equal(socket.request.setHeaderCalls, 0);
    assert.equal(socket.request.endCalls, 0);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });

  await t.test("decoy socket identity never receives Authorization", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      requestWebSocket: Object.freeze({}),
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    const socket = sockets.sockets[0];
    assert.equal(socket.request.setHeaderCalls, 0);
    assert.equal(socket.request.endCalls, 0);
    assert.equal(socket.request.destroyCalls, 1);
    assert.equal(socket.terminateCalls, 1);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });

  await t.test("late callback destroys its request after the lifecycle fence", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, { skipFinishRequest: true });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    const socket = sockets.sockets[0];
    assert.throws(() => socket.finishRequest(socket.request, socket));
    assert.equal(socket.request.destroyCalls, 1);
    assert.equal(socket.request.setHeaderCalls, 0);
    assert.equal(socket.request.endCalls, 0);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });
});

test("synchronous constructor, request, listener, and getter reentry stays terminal", async (t) => {
  await t.test("constructor refresh invalidates the captured cut before request write", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onConstructor: () => replaceCredential(h),
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    const socket = sockets.sockets[0];
    assert.equal(socket.request.setHeaderCalls, 0);
    assert.equal(socket.request.endCalls, 0);
    assert.equal(socket.request.destroyCalls, 1);
    assert.equal(socket.terminateCalls, 1);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });

  await t.test("constructor close", async () => {
    const h = credentialHarness();
    let lifecycle = null;
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onConstructor: () => lifecycle.transport.close(1000, "host_shutdown"),
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    assert.equal(sockets.sockets[0].request.setHeaderCalls, 0);
    assert.equal(sockets.sockets[0].request.destroyCalls, 1);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });

  await t.test("request write awaits drain", async () => {
    const h = credentialHarness();
    let lifecycle = null;
    const proof = Object.freeze(Object.create(null));
    let drain = null;
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onSetHeader: () => { drain = lifecycle.awaitDrained(proof); },
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    assert.notEqual(drain, null);
    assert.equal(await drain, proof);
    const socket = sockets.sockets[0];
    assert.equal(socket.request.setHeaderCalls, 1);
    assert.equal(socket.request.endCalls, 0);
    assert.ok(socket.request.destroyCalls >= 1);
    assert.equal(socket.listeners.size, 0);
  });

  await t.test("request end close cannot continue into socket setup", async () => {
    const h = credentialHarness();
    let lifecycle = null;
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onEnd: () => lifecycle.transport.close(1000, "host_shutdown"),
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    const socket = sockets.sockets[0];
    assert.equal(socket.request.setHeaderCalls, 1);
    assert.equal(socket.request.endCalls, 1);
    assert.ok(socket.request.destroyCalls >= 1);
    assert.equal(socket.listeners.size, 0);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });

  await t.test("listener close installs no later listener", async () => {
    const h = credentialHarness();
    let lifecycle = null;
    let reentered = false;
    let abortListenerAdds = 0;
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "addEventListener", {
      configurable: true,
      value() { abortListenerAdds += 1; },
    });
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onListener: () => {
        if (reentered) return;
        reentered = true;
        lifecycle.transport.close(1000, "host_shutdown");
      },
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt(1, signal);
    const admission = prepare(factory, h.authority, input);
    lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => lifecycle.bindConnection(connection));
    const socket = sockets.sockets[0];
    assert.equal(socket.request.authorizationIsExact, true);
    assert.equal(socket.request.endCalls, 1);
    assert.equal([...socket.listeners.values()].flat().length, 0);
    assert.equal(abortListenerAdds, 0);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });

  await t.test("OPEN getter close cannot publish open or flush", async () => {
    const h = credentialHarness();
    let lifecycle = null;
    let reentered = false;
    const behavior = {
      onProtocol: () => {
        if (reentered) return;
        reentered = true;
        lifecycle.transport.close(1000, "host_shutdown");
      },
    };
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, behavior);
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    lifecycle.bindConnection(connection);
    const socket = sockets.sockets[0];
    socket.emitOpen();
    assert.equal(socket.writes.length, 0);
    assert.deepEqual(socket.closeCalls, [{ code: 1000, reason: "host_shutdown" }]);
    const proof = Object.freeze(Object.create(null));
    const drain = lifecycle.awaitDrained(proof);
    socket.emitClose(1000);
    assert.equal(await drain, proof);
  });
});

test("request finalization runs after the credential cut linearization point", async (t) => {
  await t.test("synchronous refresh linearizes after the admitted connection", async () => {
    const h = credentialHarness();
    let exclusiveDepthAtWrite = -1;
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onSetHeader: () => {
        exclusiveDepthAtWrite = h.storage.exclusiveDepth;
        assert.deepEqual(refreshCredential(h), {
          status: "applied",
          credentialVersion: "2",
        });
      },
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    lifecycle.bindConnection(connection);
    const socket = sockets.sockets[0];
    assert.equal(exclusiveDepthAtWrite, 0);
    assert.equal(h.storage.snapshot(REFERENCE).credentialVersion, "2");
    assert.equal(socket.request.authorizationIsExact, true);
    assert.equal(socket.request.endCalls, 1);
    assert.deepEqual(h.storage.operationErrors, []);
    await closeLifecycle(lifecycle, socket);
  });

  await t.test("synchronous revoke linearizes after the admitted connection", async () => {
    const h = credentialHarness();
    let exclusiveDepthAtEnd = -1;
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onEnd: () => {
        exclusiveDepthAtEnd = h.storage.exclusiveDepth;
        assert.deepEqual(revokeCredential(h.storage), { status: "swapped" });
      },
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    lifecycle.bindConnection(connection);
    const socket = sockets.sockets[0];
    assert.equal(exclusiveDepthAtEnd, 0);
    assert.equal(h.storage.snapshot(REFERENCE), null);
    assert.equal(socket.request.authorizationIsExact, true);
    assert.equal(socket.request.endCalls, 1);
    assert.deepEqual(h.storage.operationErrors, []);
    await closeLifecycle(lifecycle, socket);
  });

  await t.test("request failure remains a transport failure outside storage", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
      onSetHeader: () => {
        assert.equal(h.storage.exclusiveDepth, 0);
        throw new Error("injected non-sensitive request finalization failure");
      },
    });
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    const storageErrorsBefore = h.storage.operationErrors.length;
    assert.throws(
      () => lifecycle.bindConnection(connection),
      (error) => error instanceof wss.RelayV2HostWssTransportLifecycleError
        && !(error instanceof credentialModule.RelayV2HostCredentialAuthorityError),
    );
    assert.equal(h.storage.operationErrors.length, storageErrorsBefore);
    const socket = sockets.sockets[0];
    assert.equal(socket.request.setHeaderCalls, 1);
    assert.equal(socket.request.endCalls, 0);
    assert.equal(socket.request.destroyCalls, 1);
    assert.equal(socket.terminateCalls, 1);
    const proof = Object.freeze(Object.create(null));
    assert.equal(await lifecycle.awaitDrained(proof), proof);
  });
});

test("stale, revoked, replayed, copied, and foreign admissions fail before WSS open", async (t) => {
  await t.test("refresh before carrier consumption", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    replaceCredential(h);
    assert.throws(() => actor(h.authority, admission).connect(lifecycle.transport, REFERENCE));
    assert.equal(lifecycle.transport.bufferedAmount(), 0);
    assert.equal(sockets.sockets.length, 0);
    await closeLifecycle(lifecycle);
  });

  await t.test("revocation before carrier consumption", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    h.storage.replace(REFERENCE, null);
    assert.throws(() => actor(h.authority, admission).connect(lifecycle.transport, REFERENCE));
    assert.equal(sockets.sockets.length, 0);
    await closeLifecycle(lifecycle);
  });

  await t.test("refresh after host.hello ownership but before binding", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.ok(lifecycle.transport.bufferedAmount() > 0);
    replaceCredential(h);
    assert.throws(() => lifecycle.bindConnection(connection));
    assert.equal(sockets.sockets.length, 0);
    await closeLifecycle(lifecycle);
  });

  await t.test("one cut cannot be replayed or structurally copied", async () => {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
    const scheduler = deadlineScheduler();
    const factory = createFactory(h, sockets, scheduler);
    const input = attempt();
    const admission = prepare(factory, h.authority, input);
    const lifecycle = factory.createTransportLifecycle(input);
    actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
    assert.throws(() => actor(h.authority, admission).connect(lifecycle.transport, REFERENCE));
    assert.throws(() => actor(h.authority, Object.freeze({ ...admission }))
      .connect(lifecycle.transport, REFERENCE));
    assert.equal(sockets.sockets.length, 0);
    await closeLifecycle(lifecycle);
  });

  await t.test("factory and carrier credential authority must be identical", () => {
    const first = credentialHarness();
    const second = credentialHarness();
    const sockets = fakeWebSockets(first.expectedAuthorizationDigest);
    const scheduler = deadlineScheduler();
    const factory = createFactory(first, sockets, scheduler);
    assert.throws(() => prepare(factory, second.authority, attempt()));
    assert.equal(sockets.sockets.length, 0);
  });
});

test("text carrier, subprotocol, extension, and frame limits fail closed without fallback", async (t) => {
  for (const scenario of [
    { name: "selected subprotocol", protocol: "tw-relay.host.v1", extensions: "" },
    { name: "negotiated extension", protocol: "tw-relay.host.v2", extensions: "permessage-deflate" },
  ]) {
    await t.test(scenario.name, async () => {
      const h = credentialHarness();
      const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
      const scheduler = deadlineScheduler();
      const factory = createFactory(h, sockets, scheduler);
      const input = attempt();
      const admission = prepare(factory, h.authority, input);
      const lifecycle = factory.createTransportLifecycle(input);
      const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
      lifecycle.bindConnection(connection);
      const socket = sockets.sockets[0];
      socket.emitOpen(scenario.protocol, scenario.extensions);
      assert.equal(socket.writes.length, 0);
      assert.deepEqual(socket.closeCalls, [{ code: 4406, reason: "protocol_error" }]);
      assert.equal(sockets.sockets.length, 1);
      const proof = Object.freeze(Object.create(null));
      const drained = lifecycle.awaitDrained(proof);
      socket.emitClose(4406);
      assert.equal(await drained, proof);
    });
  }

  for (const scenario of [
    { name: "binary frame", data: Buffer.from("{}"), isBinary: true },
    {
      name: "oversized text frame",
      data: Buffer.alloc(codec.RELAY_V2_CARRIER_FRAME_BYTES + 1),
      isBinary: false,
    },
    { name: "malformed text event", data: [Buffer.from("{}")], isBinary: false },
  ]) {
    await t.test(scenario.name, async () => {
      const h = credentialHarness();
      const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
      const scheduler = deadlineScheduler();
      const factory = createFactory(h, sockets, scheduler);
      const input = attempt();
      const admission = prepare(factory, h.authority, input);
      const lifecycle = factory.createTransportLifecycle(input);
      const statuses = [];
      const connection = actor(h.authority, admission, statuses)
        .connect(lifecycle.transport, REFERENCE);
      lifecycle.bindConnection(connection);
      const socket = sockets.sockets[0];
      socket.emitOpen();
      socket.emitMessage(scenario.data, scenario.isBinary);
      assert.deepEqual(socket.closeCalls, [{ code: 4406, reason: "protocol_error" }]);
      assert.equal(statuses.some((status) => status.phase === "registered"), false);
      assert.equal(sockets.sockets.length, 1);
      const proof = Object.freeze(Object.create(null));
      const drained = lifecycle.awaitDrained(proof);
      socket.emitClose(4406);
      assert.equal(await drained, proof);
    });
  }

  for (const relayUrl of [
    "ws://relay.example.test/",
    "wss://relay.example.test/not-root",
    "wss://relay.example.test/?query=1",
    "wss://user@relay.example.test/",
  ]) {
    const h = credentialHarness();
    const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
    const scheduler = deadlineScheduler();
    assert.throws(() => createFactory(h, sockets, scheduler, { relayUrl }));
    assert.equal(sockets.sockets.length, 0);
  }
});

test("a synchronous successful write callback settles only after send returns", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest, { syncSendCallback: true });
  const scheduler = deadlineScheduler();
  const factory = createFactory(h, sockets, scheduler);
  const input = attempt();
  const admission = prepare(factory, h.authority, input);
  const lifecycle = factory.createTransportLifecycle(input);
  const observations = {
    acks: [],
    closes: [],
    receives: 0,
    writables: [],
    bufferedAmount: () => lifecycle.transport.bufferedAmount(),
  };
  const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
  lifecycle.bindConnection(observedConnection(connection, observations));
  const socket = sockets.sockets[0];
  const beforeOpenBytes = lifecycle.transport.bufferedAmount();
  socket.emitOpen();
  assert.deepEqual(observations.acks, []);
  assert.equal(lifecycle.transport.bufferedAmount(), beforeOpenBytes);
  await Promise.resolve();
  assert.equal(observations.acks.length, 1);
  assert.equal(observations.acks[0].bufferedAmount, 0);
  assert.deepEqual(observations.writables, [{ acknowledgementCount: 1, bufferedAmount: 0 }]);
  await closeLifecycle(lifecycle, socket);
});

test("write failures and invalid UTF-8 settle without ACK of the failed delivery", async (t) => {
  for (const scenario of [
    {
      name: "refusal-after-callback",
      behavior: { syncSendCallback: true, sendReturn: false },
      reason: "write_refused",
    },
    {
      name: "throw-after-callback",
      behavior: { syncSendCallback: true, sendThrowAfterCallback: true },
      reason: "write_failed",
    },
    { name: "callback-error", behavior: {}, reason: "write_failed" },
    {
      name: "invalid-utf8",
      behavior: {},
      reason: "write_failed",
      invalidFrame: Uint8Array.of(0xc3, 0x28),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const h = credentialHarness();
      const sockets = fakeWebSockets(
        h.expectedAuthorizationDigest,
        scenario.behavior,
      );
      const scheduler = deadlineScheduler();
      const factory = createFactory(h, sockets, scheduler);
      const input = attempt();
      const admission = prepare(factory, h.authority, input);
      const lifecycle = factory.createTransportLifecycle(input);
      const observations = {
        acks: [],
        closes: [],
        receives: 0,
        writables: [],
        suppressForwarding: scenario.invalidFrame !== undefined,
        bufferedAmount: () => lifecycle.transport.bufferedAmount(),
      };
      const connection = actor(h.authority, admission)
        .connect(lifecycle.transport, REFERENCE);
      lifecycle.bindConnection(observedConnection(connection, observations));
      const socket = sockets.sockets[0];
      if (scenario.invalidFrame) {
        assert.equal(
          lifecycle.transport.trySend(scenario.invalidFrame, "invalid-utf8-delivery"),
          true,
        );
      }
      socket.emitOpen();
      assert.equal(socket.writes.length, 1);
      if (scenario.invalidFrame) {
        socket.writes[0].callback();
        await Promise.resolve();
        assert.equal(socket.writes.length, 1, "invalid UTF-8 never reaches socket.send");
      } else if (scenario.name === "callback-error") {
        socket.writes[0].callback(new Error("injected non-sensitive write failure"));
        await Promise.resolve();
      }
      assert.deepEqual(socket.closeCalls, [{ code: 1011, reason: scenario.reason }]);
      assert.equal(
        observations.acks.some((entry) => entry.deliveryToken === "invalid-utf8-delivery"),
        false,
      );
      assert.equal(observations.acks.length, scenario.invalidFrame ? 1 : 0);
      assert.equal(lifecycle.transport.bufferedAmount(), 0);
      assert.equal(sockets.sockets.length, 1);
      const proof = Object.freeze(Object.create(null));
      const drained = lifecycle.awaitDrained(proof);
      socket.emitClose(1011);
      assert.equal(await drained, proof);
      socket.writes[0].callback();
      await Promise.resolve();
      assert.equal(observations.acks.length, scenario.invalidFrame ? 1 : 0);
      assert.equal(
        observations.acks.some((entry) => entry.deliveryToken === "invalid-utf8-delivery"),
        false,
      );
    });
  }
});

test("an actor.connect failure explicitly drains the exact unbound lifecycle", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
  const scheduler = deadlineScheduler();
  const transportFactory = createFactory(h, sockets, scheduler);
  let lifecycle = null;
  let drained = false;
  const adapter = new attemptAdapterModule.RelayV2HostConnectorCarrierAttemptAdapter({
    factory: {
      createAttempt(input) {
        const lifecycleInput = attempt(
          Number(input.controllerGeneration),
          input.signal,
        );
        const admission = prepare(transportFactory, h.authority, lifecycleInput);
        lifecycle = transportFactory.createTransportLifecycle(lifecycleInput);
        const carrier = new carrierModule.RelayV2HostCarrierActor({
          hostId: HOST_ID,
          hostEpoch: HOST_EPOCH,
          hostInstanceId: HOST_INSTANCE_ID,
          credentialReferences: h.authority,
          credentialConnectionAdmission: admission,
          routeSink: {
            onRouteBound() {},
            onClientFrame() {},
            onRouteUnbound() {},
          },
          advertisedCapabilities: [],
          clientDialects: ["tw-relay.v2"],
          dialectAdapters: Object.freeze({}),
          idFactory() {
            throw new Error("injected non-sensitive host.hello id failure");
          },
          onStatus: input.onCarrierStatus,
        });
        const drainHandle = new attemptAdapterModule
          .RelayV2HostConnectorCarrierAttemptDrainHandle({
            transport: lifecycle.transport,
            bindConnection: (connection) => lifecycle.bindConnection(connection),
            awaitDrained: (proof) => lifecycle.awaitDrained(proof).then((returned) => {
              drained = true;
              return returned;
            }),
          });
        return Object.freeze({
          actor: carrier,
          transport: lifecycle.transport,
          drainHandle,
        });
      },
    },
  });
  const input = attempt();
  await assert.rejects(adapter.startAttempt(Object.freeze({
    ...input,
    onCarrierStatus() {},
    onCarrierAttemptPrepared() {},
    onCarrierAttemptFenced() {},
  })));
  assert.equal(drained, true);
  assert.notEqual(lifecycle, null);
  assert.equal(lifecycle.transport.bufferedAmount(), 0);
  assert.equal(lifecycle.transport.trySend(Uint8Array.of(1), "after-drain"), false);
  assert.equal(sockets.sockets.length, 0);
});

test("close cleanup failures cannot skip exact drain settlement", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest, {
    removeListenerThrows: true,
  });
  const scheduler = deadlineScheduler({ cancelThrows: true });
  const signal = new AbortController().signal;
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value() {
      throw new Error("injected non-sensitive abort listener cleanup failure");
    },
  });
  const factory = createFactory(h, sockets, scheduler, { closeDrainDeadlineMs: 321 });
  const input = attempt(1, signal);
  const admission = prepare(factory, h.authority, input);
  const lifecycle = factory.createTransportLifecycle(input);
  const observations = {
    acks: [],
    closes: [],
    receives: 0,
    writables: [],
    closeThrows: true,
    bufferedAmount: () => lifecycle.transport.bufferedAmount(),
  };
  const connection = actor(h.authority, admission).connect(lifecycle.transport, REFERENCE);
  lifecycle.bindConnection(observedConnection(connection, observations));
  const socket = sockets.sockets[0];
  socket.emitOpen();
  lifecycle.transport.close(1000, "host_shutdown");
  const proof = Object.freeze(Object.create(null));
  const drain = lifecycle.awaitDrained(proof);
  scheduler.deadlines[0].callback();
  assert.equal(await drain, proof);
  assert.equal(scheduler.deadlines[0].cancelled, true);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(observations.closes.length, 1);
});

test("close is idempotent and drain fences callbacks through forced termination", async () => {
  const h = credentialHarness();
  const sockets = fakeWebSockets(h.expectedAuthorizationDigest);
  const scheduler = deadlineScheduler();
  const factory = createFactory(h, sockets, scheduler, { closeDrainDeadlineMs: 321 });
  const input = attempt();
  const admission = prepare(factory, h.authority, input);
  const lifecycle = factory.createTransportLifecycle(input);
  const statuses = [];
  const carrier = actor(h.authority, admission, statuses);
  const connection = carrier.connect(lifecycle.transport, REFERENCE);
  const observations = {
    acks: [],
    closes: [],
    receives: 0,
    writables: [],
    bufferedAmount: () => lifecycle.transport.bufferedAmount(),
  };
  lifecycle.bindConnection(observedConnection(connection, observations));
  const socket = sockets.sockets[0];
  socket.emitOpen();
  assert.equal(socket.writes.length, 1);

  lifecycle.transport.close(1000, "host_shutdown");
  lifecycle.transport.close(1000, "host_shutdown");
  assert.deepEqual(socket.closeCalls, [{ code: 1000, reason: "host_shutdown" }]);
  assert.equal(lifecycle.transport.bufferedAmount(), 0);
  assert.equal(observations.closes.length, 1);
  assert.deepEqual(scheduler.deadlines.map((deadline) => deadline.delayMs), [321]);

  const proof = Object.freeze(Object.create(null));
  let drained = false;
  const drain = lifecycle.awaitDrained(proof).then((value) => {
    drained = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  scheduler.deadlines[0].callback();
  assert.equal(await drain, proof);
  assert.equal(socket.terminateCalls, 1);

  socket.emitMessage(Buffer.from("{}"), false);
  socket.emitOpen();
  socket.emitClose(1000);
  socket.writes[0].callback();
  await Promise.resolve();
  assert.equal(observations.receives, 0);
  assert.deepEqual(observations.acks, []);
  assert.equal(observations.closes.length, 1);
});
