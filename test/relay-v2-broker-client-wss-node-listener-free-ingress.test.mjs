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
const ingressModule = await import(
  "../dist/relay/v2/brokerClientWssNodeListenerFreeIngress.js"
);
const producerModule = await import("../dist/relay/v2/brokerProducerRegistry.js");

const NOW_MS = 1_783_700_000_000;
const HOST_ID = "mac-admin";
const CLIENT_PROTOCOL = "tw-relay.v2";
const TOKEN = "twcap2.node-client-sensitive";
const FAILURE = "Relay v2 Broker client WSS Node listener-free ingress failed";
const STATUS_LINES = Object.freeze({
  400: "HTTP/1.1 400 Bad Request",
  401: "HTTP/1.1 401 Unauthorized",
  404: "HTTP/1.1 404 Not Found",
  426: "HTTP/1.1 426 Upgrade Required",
  503: "HTTP/1.1 503 Service Unavailable",
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

class MemoryDuplex extends Duplex {
  constructor() {
    super();
    this.writes = [];
    this.endCalls = 0;
    this.destroyCalls = 0;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  _destroy(error, callback) {
    callback(error);
  }

  end(...args) {
    this.endCalls += 1;
    return super.end(...args);
  }

  destroy(error) {
    this.destroyCalls += 1;
    return super.destroy(error);
  }

  responseText() {
    return Buffer.concat(this.writes).toString("latin1");
  }
}

class GatedEndDuplex extends MemoryDuplex {
  end(chunk, callback) {
    this.endCalls += 1;
    this.writes.push(Buffer.from(chunk));
    this.pendingEndCallback = callback;
    return this;
  }

  flushEnd() {
    assert.equal(typeof this.pendingEndCallback, "function");
    const callback = this.pendingEndCallback;
    this.pendingEndCallback = undefined;
    callback();
  }
}

class ThrowingEndDuplex extends MemoryDuplex {
  end() {
    this.endCalls += 1;
    throw new Error(`end leaked ${TOKEN}`);
  }
}

function authorization(role, overrides = {}) {
  return Object.freeze({
    scheme: "twcap2",
    role,
    hostId: HOST_ID,
    principalId: role === "host" ? "host-principal" : "client-principal",
    grantId: role === "host" ? "host-grant" : "client-grant",
    clientInstanceId: role === "host" ? null : "android-install",
    jti: `${role}-jti`,
    kid: "kid-current",
    expiresAtMs: NOW_MS + 60_000,
    authorizationRevision: "7",
    authorizationFence: "authorization-fence-7",
    ...overrides,
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
      clientDialects: [CLIENT_PROTOCOL],
      capabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
      limits: { maxFrameBytes: 1_048_576, terminalMaxFrameBytes: 65_536 },
    },
  };
}

function carrierBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function clientScheduler() {
  return {
    schedule() {
      return () => {};
    },
  };
}

async function createRuntimeHarness() {
  const transportId = `listener-free-host-${randomUUID()}`;
  const hostIncarnation = `${transportId}-incarnation`;
  const registry = new producerModule.RelayV2BrokerProducerRegistry();
  let applyHook = null;
  const producerPort = Object.freeze(Object.assign(Object.create(null), {
    apply(actions, fence) {
      applyHook?.(actions);
      return fence.mayApply() ? "applied" : "rejected";
    },
    forceTerminal(_failure, fence) {
      return fence.mayApply() ? "applied" : "rejected";
    },
  }));
  const producer = registry.registerHostProducer(transportId, producerPort);
  const binding = producer.bindConnectionIncarnation(hostIncarnation);
  let ingressRuntime;
  const composition = compositionModule.createRelayV2BrokerClientWssRuntimeComposition({
    brokerOptions: {
      now: () => NOW_MS,
      baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    },
    producerRegistry: registry,
    resolveHostProducerBinding: () => binding,
    clientSocketScheduler: clientScheduler(),
    authorizationExpiryScheduleAt: () => () => {},
  }, (runtime) => {
    ingressRuntime = runtime;
  });
  assert.ok(ingressRuntime);
  assert.deepEqual(Reflect.ownKeys(ingressRuntime), [
    "installTrustedSocketCapture",
    "prepareClientWssForCurrentHost",
    "attachPreparedClientWss",
  ]);
  const hostBroker = composition.hostPumpBrokerAuthority;
  hostBroker.attachHostCarrier(
    transportId,
    authorization("host", { expiresAtMs: NOW_MS + 3_600_000 }),
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
    ingressRuntime,
    hostBroker,
    producerTarget: producer.target,
    transportId,
    setApplyHook(hook) {
      applyHook = hook;
    },
  };
}

function requestFor(socket, {
  url = "/client",
  authorizationHeader = `Bearer ${TOKEN}`,
  protocols = CLIENT_PROTOCOL,
  compression = true,
} = {}) {
  const key = Buffer.alloc(16, 11).toString("base64");
  const rawHeaders = [
    "Host", "relay.example.com",
    "Connection", "Upgrade",
    "Upgrade", "websocket",
    "Authorization", authorizationHeader,
    "Sec-WebSocket-Key", key,
    "Sec-WebSocket-Version", "13",
    "Sec-WebSocket-Protocol", protocols,
  ];
  const headers = {
    host: "relay.example.com",
    connection: "Upgrade",
    upgrade: "websocket",
    authorization: authorizationHeader,
    "sec-websocket-key": key,
    "sec-websocket-version": "13",
    "sec-websocket-protocol": protocols,
  };
  if (compression) {
    rawHeaders.push(
      "Sec-WebSocket-Extensions",
      "permessage-deflate; client_max_window_bits",
    );
    headers["sec-websocket-extensions"] =
      "permessage-deflate; client_max_window_bits";
  }
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = url;
  request.rawHeaders = rawHeaders;
  request.headers = headers;
  return request;
}

function inputFor(_harness, socket, request = requestFor(socket), overrides = {}) {
  return {
    request,
    socket,
    head: Buffer.alloc(0),
    ...overrides,
  };
}

function createIngress(harness, verify = () => authorization("client")) {
  let child;
  const ingress = ingressModule.createRelayV2BrokerClientWssNodeListenerFreeIngress({
    verifyV2AccessToken: verify,
    runtime: harness.ingressRuntime,
  }, (installed) => {
    child = installed;
  });
  assert.ok(child);
  assert.equal(Object.getPrototypeOf(child), null);
  assert.equal(Object.isFrozen(child), true);
  assert.deepEqual(Reflect.ownKeys(child), ["closeAndDrain"]);
  harness.clientIngressChild = child;
  return ingress;
}

async function closeHarness(harness, ingress) {
  const childClose = harness.clientIngressChild.closeAndDrain();
  assert.strictEqual(ingress.closeAndDrain(), childClose);
  await childClose;
  await harness.composition.closeAndDrain();
}

function expectedResponse(status) {
  return `${STATUS_LINES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`;
}

function isGenericFailure(error) {
  assert.equal(error.message, FAILURE);
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes(TOKEN), false);
  return true;
}

function assertPre101SocketClosed(socket, status) {
  assert.equal(socket.responseText(), expectedResponse(status));
  assert.equal(socket.endCalls, 1);
  assert.equal(socket.writableEnded, true);
}

test("listener-free client ingress hands one strict no-compression Upgrade to the canonical runtime", async () => {
  const harness = await createRuntimeHarness();
  let verifierCalls = 0;
  const ingress = createIngress(harness, (token, role) => {
    verifierCalls += 1;
    assert.equal(token, TOKEN);
    assert.equal(role, "client");
    return authorization("client");
  });
  const socket = new MemoryDuplex();

  assert.equal(await ingress.handleUpgradeRequest(inputFor(harness, socket)), "upgraded");
  assert.equal(verifierCalls, 1);
  assert.match(socket.responseText(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(
    socket.responseText(),
    /\r\nSec-WebSocket-Protocol: tw-relay\.v2\r\n/,
  );
  assert.doesNotMatch(socket.responseText(), /\r\nSec-WebSocket-Extensions:/i);
  assert.equal(
    harness.hostBroker.drainHostCarrier(harness.transportId)
      .some((delivery) => delivery.frame.type === "route.open"),
    true,
  );

  socket.destroy();
  await closeHarness(harness, ingress);
});

test("listener-free client ingress rejects path, query, credential, and protocol before HTTP 101", async () => {
  const harness = await createRuntimeHarness();
  let verifierCalls = 0;
  const ingress = createIngress(harness, (token) => {
    verifierCalls += 1;
    if (token !== TOKEN) {
      throw Object.assign(new Error(`invalid ${token}`), { code: "AUTH_INVALID" });
    }
    return authorization("client");
  });
  const cases = [
    ["wrong path", 404, { url: "/client/" }],
    ["query", 400, { url: "/client?hostId=mac-admin" }],
    ["bad credential", 401, { authorizationHeader: "Bearer twcap2.invalid" }],
    ["extra protocol", 426, { protocols: `${CLIENT_PROTOCOL}, tw-relay.v1` }],
  ];

  for (const [name, status, requestOptions] of cases) {
    const socket = new MemoryDuplex();
    const result = await ingress.handleUpgradeRequest(inputFor(
      harness,
      socket,
      requestFor(socket, requestOptions),
    ));
    assert.equal(result, "rejected", name);
    assert.equal(socket.responseText(), expectedResponse(status), name);
    assert.equal(socket.responseText().includes("101 Switching Protocols"), false, name);
  }
  assert.equal(verifierCalls, 1);
  assert.equal(harness.hostBroker.drainHostCarrier(harness.transportId).length, 0);
  await closeHarness(harness, ingress);
});

test("caller target and every other extra handoff field fail before dispatch", async () => {
  const harness = await createRuntimeHarness();
  let verifierCalls = 0;
  const ingress = createIngress(harness, () => {
    verifierCalls += 1;
    throw new Error(`must not expose ${TOKEN}`);
  });
  const socket = new MemoryDuplex();

  await assert.rejects(ingress.handleUpgradeRequest(inputFor(
    harness,
    socket,
    requestFor(socket),
    { hostProducerTarget: Object.freeze({ transportId: "invalid", generation: "1" }) },
  )), isGenericFailure);
  assert.equal(verifierCalls, 0);
  assert.equal(socket.responseText(), "");
  assert.equal(socket.destroyCalls, 0);
  await closeHarness(harness, ingress);
});

test("closing and closed handoffs own and close the delivered raw socket without rerunning Phase A", async () => {
  const harness = await createRuntimeHarness();
  const verification = deferred();
  let verifierCalls = 0;
  const ingress = createIngress(harness, () => {
    verifierCalls += 1;
    return verification.promise;
  });
  const admittedSocket = new MemoryDuplex();
  const admitted = ingress.handleUpgradeRequest(inputFor(harness, admittedSocket));
  const close = ingress.closeAndDrain();

  const closingSocket = new MemoryDuplex();
  assert.equal(
    await ingress.handleUpgradeRequest(inputFor(harness, closingSocket)),
    "rejected",
  );
  assertPre101SocketClosed(closingSocket, 503);
  assert.equal(verifierCalls, 1);

  verification.resolve(authorization("client"));
  assert.equal(await admitted, "rejected");
  await close;

  const closedSocket = new MemoryDuplex();
  assert.equal(
    await ingress.handleUpgradeRequest(inputFor(harness, closedSocket)),
    "rejected",
  );
  assertPre101SocketClosed(closedSocket, 503);
  assert.equal(verifierCalls, 1, "closing/closed handoff must not rerun Phase A");
  await harness.composition.closeAndDrain();
});

test("invalid head closes the captured raw socket without touching hostile accessors or Phase A", async () => {
  const harness = await createRuntimeHarness();
  let verifierCalls = 0;
  const ingress = createIngress(harness, () => {
    verifierCalls += 1;
    return authorization("client");
  });
  let hostileReads = 0;
  const invalidHead = new Proxy({}, {
    get() { hostileReads += 1; throw new Error(`head getter leaked ${TOKEN}`); },
    getPrototypeOf() { hostileReads += 1; throw new Error(`head prototype leaked ${TOKEN}`); },
  });
  const socket = new MemoryDuplex();

  assert.equal(await ingress.handleUpgradeRequest(inputFor(
    harness,
    socket,
    requestFor(socket),
    { head: invalidHead },
  )), "rejected");
  assertPre101SocketClosed(socket, 400);
  assert.equal(hostileReads, 0);
  assert.equal(verifierCalls, 0);

  const failedEndSocket = new ThrowingEndDuplex();
  await assert.rejects(ingress.handleUpgradeRequest(inputFor(
    harness,
    failedEndSocket,
    requestFor(failedEndSocket),
    { head: invalidHead },
  )), isGenericFailure);
  assert.equal(failedEndSocket.endCalls, 1);
  assert.equal(failedEndSocket.destroyCalls, 1);
  assert.equal(failedEndSocket.destroyed, true);
  assert.equal(hostileReads, 0);
  assert.equal(verifierCalls, 0);
  await closeHarness(harness, ingress);
});

test("post-101 lifecycle loss consumes Phase A once and waits for canonical cleanup", async () => {
  const harness = await createRuntimeHarness();
  let verifierCalls = 0;
  const ingress = createIngress(harness, () => {
    verifierCalls += 1;
    return authorization("client");
  });
  let closeFromAttach;
  harness.setApplyHook(() => {
    harness.setApplyHook(null);
    closeFromAttach = ingress.closeAndDrain();
  });
  const socket = new MemoryDuplex();

  await assert.rejects(
    ingress.handleUpgradeRequest(inputFor(harness, socket)),
    isGenericFailure,
  );
  assert.match(socket.responseText(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.equal(verifierCalls, 1, "Phase A credential admission must not rerun");
  assert.ok(closeFromAttach);
  assert.strictEqual(ingress.closeAndDrain(), closeFromAttach);
  await assert.rejects(closeFromAttach, isGenericFailure);
  assert.ok(socket.destroyCalls >= 1);
  await harness.composition.closeAndDrain();
});

test("close fences an admitted async dispatch and drains its bodyless 503 rejection", async () => {
  const harness = await createRuntimeHarness();
  const verification = deferred();
  const ingress = createIngress(harness, () => verification.promise);
  const socket = new GatedEndDuplex();
  const handled = ingress.handleUpgradeRequest(inputFor(harness, socket));
  const closed = ingress.closeAndDrain();
  assert.strictEqual(ingress.closeAndDrain(), closed);

  verification.resolve(authorization("client"));
  await settle();
  assert.equal(socket.responseText(), expectedResponse(503));
  let closeSettled = false;
  void closed.then(() => { closeSettled = true; });
  await settle();
  assert.equal(closeSettled, false, "close must include the admitted response flush");

  socket.flushEnd();
  assert.equal(await handled, "rejected");
  await closed;
  await harness.composition.closeAndDrain();
});
