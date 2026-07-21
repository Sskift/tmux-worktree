import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import test from "node:test";

const adapterModule = await import(
  "../dist/relay/v2/brokerHostWssNodeUpgradeRequestAdapter.js"
);

const HOST_PROTOCOL = "tw-relay.host.v2";
const TOKEN = "twcap2.node-upgrade-request-sensitive";
const FAILURE = "Relay v2 Broker Host Node Upgrade request adapter failed";
const STATUS_LINES = Object.freeze({
  400: "HTTP/1.1 400 Bad Request",
  401: "HTTP/1.1 401 Unauthorized",
  403: "HTTP/1.1 403 Forbidden",
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

class FailingEndDuplex extends MemoryDuplex {
  end() {
    this.endCalls += 1;
    throw new Error(`end failed with ${TOKEN}`);
  }
}

class LateCallbackEndDuplex extends MemoryDuplex {
  end(chunk, callback) {
    this.endCalls += 1;
    this.writes.push(Buffer.from(chunk));
    this.lateEndCallback = callback;
    return this;
  }

  deliverLateEndCallback() {
    assert.equal(typeof this.lateEndCallback, "function");
    const callback = this.lateEndCallback;
    this.lateEndCallback = undefined;
    callback();
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

function requestFor(socket, {
  url = "/host",
  rawHeaders = [
    "Authorization", `Bearer ${TOKEN}`,
    "Sec-WebSocket-Protocol", HOST_PROTOCOL,
  ],
  normalizedHeaders,
} = {}) {
  const request = new IncomingMessage(socket);
  request.url = url;
  request.rawHeaders = rawHeaders;
  if (normalizedHeaders !== undefined) request.headers = normalizedHeaders;
  return request;
}

function inputFor(socket, request = requestFor(socket), head = Buffer.from([1, 2, 3])) {
  return { request, socket, head };
}

function fakeComposition({ upgrade, close = () => Promise.resolve() }) {
  let hostUpgrade;
  let composition;
  const upgradeMethod = function upgradeMethod(input) {
    if (this !== hostUpgrade) throw new Error("invalid fake Host Upgrade receiver");
    return upgrade(input);
  };
  const closeAndDrain = function closeAndDrain() {
    if (this !== composition) throw new Error("invalid fake composition receiver");
    return close();
  };
  hostUpgrade = Object.freeze(Object.assign(Object.create(null), {
    upgrade: upgradeMethod,
  }));
  composition = Object.freeze(Object.assign(Object.create(null), {
    hostUpgrade,
    closeAndDrain,
  }));
  return composition;
}

function createAdapter(composition) {
  return adapterModule.createRelayV2BrokerHostWssNodeUpgradeRequestAdapter(
    composition,
  );
}

function expectedResponse(status) {
  return `${STATUS_LINES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`;
}

function isGenericFailure(error) {
  assert.equal(error.message, FAILURE);
  assert.equal(error.cause, undefined);
  assert.equal(String(error).includes(TOKEN), false);
  return true;
}

test("captures exact raw IncomingMessage metadata and delegates the same request, socket, and head once", async () => {
  const delegatedInputs = [];
  let closeCalls = 0;
  const hiddenConnection = Object.freeze({ secret: TOKEN });
  const composition = fakeComposition({
    async upgrade(input) {
      delegatedInputs.push(input);
      return Object.freeze({ outcome: "upgraded", connection: hiddenConnection });
    },
    close() {
      closeCalls += 1;
      return Promise.resolve();
    },
  });
  const adapter = createAdapter(composition);

  assert.equal(Object.getPrototypeOf(adapter), null);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Reflect.ownKeys(adapter), [
    "handleUpgradeRequest",
    "closeAndDrain",
  ]);
  for (const hidden of [
    "composition",
    "hostUpgrade",
    "metadata",
    "reject",
    "connection",
  ]) assert.equal(adapter[hidden], undefined);

  const socket = new MemoryDuplex();
  const request = requestFor(socket, {
    url: "/host?credential=query-secret",
    rawHeaders: [
      "authorization", `Bearer ${TOKEN}-first`,
      "X-Ignored", "value",
      "AUTHORIZATION", `Bearer ${TOKEN}-second`,
      "Sec-WebSocket-Protocol", `\t${HOST_PROTOCOL} \t, tw-relay.v2\t`,
      "sec-websocket-protocol", "  tw-relay.extra\t",
      "Cookie", "credential=cookie-secret",
    ],
    normalizedHeaders: Object.freeze({
      authorization: "Bearer normalized-secret",
      "sec-websocket-protocol": "normalized-protocol",
    }),
  });
  const head = new Uint8Array(new ArrayBuffer(8), 2, 3);
  const result = await adapter.handleUpgradeRequest({ request, socket, head });

  assert.equal(result, "upgraded");
  assert.equal(delegatedInputs.length, 1);
  const delegated = delegatedInputs[0];
  assert.equal(Object.getPrototypeOf(delegated), null);
  assert.equal(Object.isFrozen(delegated), true);
  assert.deepEqual(Reflect.ownKeys(delegated), [
    "metadata",
    "request",
    "socket",
    "head",
  ]);
  assert.strictEqual(delegated.request, request);
  assert.strictEqual(delegated.socket, socket);
  assert.strictEqual(delegated.head, head);
  assert.equal(Object.getPrototypeOf(delegated.metadata), null);
  assert.equal(Object.isFrozen(delegated.metadata), true);
  assert.deepEqual({ ...delegated.metadata }, {
    pathname: "/host",
    search: "?credential=query-secret",
    authorizationHeaders: [
      `Bearer ${TOKEN}-first`,
      `Bearer ${TOKEN}-second`,
    ],
    legacyQuerySecret: null,
    offeredProtocols: [HOST_PROTOCOL, "tw-relay.v2", "tw-relay.extra"],
  });
  assert.equal(Object.isFrozen(delegated.metadata.authorizationHeaders), true);
  assert.equal(Object.isFrozen(delegated.metadata.offeredProtocols), true);
  assert.equal(socket.endCalls, 0);
  assert.equal(socket.destroyCalls, 0);
  assert.equal(socket.responseText(), "");

  await adapter.closeAndDrain();
  assert.equal(closeCalls, 1);
  socket.destroy();
});

test("writes fixed minimal pre-101 rejects and keeps malformed raw targets or headers out of B7j", async () => {
  const statuses = [400, 401, 403, 404, 426, 503];
  let upgradeCalls = 0;
  const composition = fakeComposition({
    async upgrade() {
      const status = statuses[upgradeCalls % statuses.length];
      upgradeCalls += 1;
      return Object.freeze({
        outcome: "reject",
        status,
        errorCode: `sensitive-${TOKEN}`,
        fallback: false,
      });
    },
  });
  const adapter = createAdapter(composition);

  for (const status of statuses) {
    const socket = new MemoryDuplex();
    const outcome = await adapter.handleUpgradeRequest(inputFor(socket));
    const response = socket.responseText();
    assert.equal(outcome, "rejected", String(status));
    assert.equal(response, expectedResponse(status), String(status));
    assert.equal(response.includes("101 Switching Protocols"), false, String(status));
    assert.equal(response.includes("errorCode"), false, String(status));
    assert.equal(response.includes(TOKEN), false, String(status));
    assert.equal(response.slice(response.indexOf("\r\n\r\n") + 4), "", String(status));
    assert.equal(socket.endCalls, 1, String(status));
    assert.equal(socket.destroyCalls, 0, String(status));
  }
  assert.equal(upgradeCalls, statuses.length);

  let rawHeaderProxyTouches = 0;
  const rawHeaderProxy = new Proxy([], {
    get() { rawHeaderProxyTouches += 1; throw new Error("rawHeaders getter"); },
    getOwnPropertyDescriptor() {
      rawHeaderProxyTouches += 1;
      throw new Error("rawHeaders descriptor");
    },
    ownKeys() { rawHeaderProxyTouches += 1; throw new Error("rawHeaders keys"); },
  });
  let rawHeadersAccessorTouches = 0;
  const accessorSocket = new MemoryDuplex();
  const accessorRequest = requestFor(accessorSocket);
  Object.defineProperty(accessorRequest, "rawHeaders", {
    configurable: true,
    enumerable: true,
    get() {
      rawHeadersAccessorTouches += 1;
      throw new Error("rawHeaders accessor must not run");
    },
  });
  let extraRawHeaderAccessorTouches = 0;
  const rawHeadersWithExtraAccessor = ["Authorization", `Bearer ${TOKEN}`];
  Object.defineProperty(rawHeadersWithExtraAccessor, "extra", {
    configurable: true,
    enumerable: true,
    get() {
      extraRawHeaderAccessorTouches += 1;
      throw new Error("extra rawHeaders accessor must not run");
    },
  });
  const malformed = [
    ["non-origin target", "host", ["Authorization", `Bearer ${TOKEN}`]],
    ["fragment target", "/host#fragment", ["Authorization", `Bearer ${TOKEN}`]],
    ["odd rawHeaders", "/host", ["Authorization"]],
    ["non-string rawHeaders", "/host", ["Authorization", 42]],
    ["Proxy rawHeaders", "/host", rawHeaderProxy],
    ["extra rawHeaders accessor", "/host", rawHeadersWithExtraAccessor],
  ];
  for (const [name, url, rawHeaders] of malformed) {
    const socket = new MemoryDuplex();
    const request = requestFor(socket, { url, rawHeaders });
    assert.equal(
      await adapter.handleUpgradeRequest(inputFor(socket, request)),
      "rejected",
      name,
    );
    assert.equal(socket.responseText(), expectedResponse(400), name);
    assert.equal(socket.endCalls, 1, name);
    assert.equal(socket.destroyCalls, 0, name);
  }
  assert.equal(
    await adapter.handleUpgradeRequest(inputFor(accessorSocket, accessorRequest)),
    "rejected",
  );
  assert.equal(accessorSocket.responseText(), expectedResponse(400));
  assert.equal(rawHeaderProxyTouches, 0);
  assert.equal(rawHeadersAccessorTouches, 0);
  assert.equal(extraRawHeaderAccessorTouches, 0);
  assert.equal(upgradeCalls, statuses.length);

  const requestSocket = new MemoryDuplex();
  const outerSocket = new MemoryDuplex();
  const mixedRequest = requestFor(requestSocket);
  assert.equal(
    await adapter.handleUpgradeRequest(inputFor(outerSocket, mixedRequest)),
    "rejected",
  );
  assert.equal(outerSocket.responseText(), expectedResponse(400));
  assert.equal(outerSocket.endCalls, 1);
  assert.equal(outerSocket.destroyCalls, 0);
  assert.equal(requestSocket.responseText(), "");
  assert.equal(requestSocket.endCalls, 0);
  assert.equal(requestSocket.destroyCalls, 0);
  assert.equal(upgradeCalls, statuses.length);
  requestSocket.destroy();

  const failingSocket = new FailingEndDuplex();
  await assert.rejects(
    adapter.handleUpgradeRequest(inputFor(failingSocket)),
    isGenericFailure,
  );
  assert.equal(upgradeCalls, statuses.length + 1);
  assert.equal(failingSocket.endCalls, 1);
  assert.equal(failingSocket.destroyCalls, 1);
  assert.equal(failingSocket.responseText(), "");

  await adapter.closeAndDrain();
});

test("upgraded sockets stay untouched while exact receivers and close races fence and drain both sides", async () => {
  let upgradedCloseCalls = 0;
  const upgradedComposition = fakeComposition({
    async upgrade() {
      return Object.freeze({ outcome: "upgraded", connection: Object.freeze({}) });
    },
    close() {
      upgradedCloseCalls += 1;
      return Promise.resolve();
    },
  });
  const upgradedAdapter = createAdapter(upgradedComposition);
  let wrongReceiverTouches = 0;
  const wrongReceiverInput = new Proxy({}, {
    get() { wrongReceiverTouches += 1; throw new Error("wrong receiver getter"); },
    ownKeys() { wrongReceiverTouches += 1; throw new Error("wrong receiver keys"); },
  });
  await assert.rejects(
    Reflect.apply(upgradedAdapter.handleUpgradeRequest, Object.create(null), [
      wrongReceiverInput,
    ]),
    isGenericFailure,
  );
  await assert.rejects(
    Reflect.apply(upgradedAdapter.closeAndDrain, Object.create(null), []),
    isGenericFailure,
  );
  assert.equal(wrongReceiverTouches, 0);
  assert.equal(upgradedCloseCalls, 0);

  const upgradedSocket = new MemoryDuplex();
  assert.equal(
    await upgradedAdapter.handleUpgradeRequest(inputFor(upgradedSocket)),
    "upgraded",
  );
  assert.equal(upgradedSocket.endCalls, 0);
  assert.equal(upgradedSocket.destroyCalls, 0);
  assert.equal(upgradedSocket.responseText(), "");
  await upgradedAdapter.closeAndDrain();
  assert.equal(upgradedCloseCalls, 1);
  upgradedSocket.destroy();

  let reentrantAdapter;
  let reentrantClose;
  let reentrantCloseCalls = 0;
  const reentrantComposition = fakeComposition({
    upgrade() {
      reentrantClose = reentrantAdapter.closeAndDrain();
      return Promise.resolve(Object.freeze({ outcome: "reject", status: 503 }));
    },
    close() {
      reentrantCloseCalls += 1;
      return Promise.resolve();
    },
  });
  reentrantAdapter = createAdapter(reentrantComposition);
  const reentrantSocket = new GatedEndDuplex();
  const reentrantHandler = reentrantAdapter.handleUpgradeRequest(
    inputFor(reentrantSocket),
  );
  assert.ok(reentrantClose);
  assert.equal(reentrantCloseCalls, 1);
  let reentrantCloseSettled = false;
  void reentrantClose.then(() => { reentrantCloseSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reentrantSocket.responseText(), expectedResponse(503));
  assert.equal(reentrantSocket.endCalls, 1);
  assert.equal(reentrantCloseSettled, false);
  reentrantSocket.flushEnd();
  assert.equal(await reentrantHandler, "rejected");
  await reentrantClose;
  assert.equal(reentrantCloseSettled, true);
  assert.equal(reentrantSocket.destroyCalls, 0);
  reentrantSocket.destroy();

  const upgradeDecision = deferred();
  const delegatedClose = deferred();
  let delegatedCloseCalls = 0;
  const racingComposition = fakeComposition({
    upgrade() { return upgradeDecision.promise; },
    close() {
      delegatedCloseCalls += 1;
      return delegatedClose.promise;
    },
  });
  const racingAdapter = createAdapter(racingComposition);
  const racingSocket = new MemoryDuplex();
  const pendingHandler = racingAdapter.handleUpgradeRequest(inputFor(racingSocket));
  const closing = racingAdapter.closeAndDrain();
  assert.strictEqual(racingAdapter.closeAndDrain(), closing);
  assert.equal(delegatedCloseCalls, 1);
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  upgradeDecision.resolve(Object.freeze({ outcome: "reject", status: 503 }));
  assert.equal(await pendingHandler, "rejected");
  assert.equal(racingSocket.responseText(), expectedResponse(503));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  delegatedClose.resolve();
  await closing;
  assert.equal(closeSettled, true);

  let postCloseTouches = 0;
  const postCloseInput = new Proxy({}, {
    get() { postCloseTouches += 1; throw new Error("post-close getter"); },
    ownKeys() { postCloseTouches += 1; throw new Error("post-close keys"); },
  });
  await assert.rejects(
    racingAdapter.handleUpgradeRequest(postCloseInput),
    isGenericFailure,
  );
  assert.equal(postCloseTouches, 0);
  assert.strictEqual(racingAdapter.closeAndDrain(), closing);

  const neverCloseUpgrade = deferred();
  const neverCloseDelegated = deferred();
  const neverCloseComposition = fakeComposition({
    upgrade() { return neverCloseUpgrade.promise; },
    close() { return neverCloseDelegated.promise; },
  });
  const neverCloseAdapter = createAdapter(neverCloseComposition);
  const neverCloseSocket = new LateCallbackEndDuplex();
  const neverCloseHandler = neverCloseAdapter.handleUpgradeRequest(
    inputFor(neverCloseSocket),
  );
  const neverCloseDrain = neverCloseAdapter.closeAndDrain();
  const handlerSettlements = [];
  void neverCloseHandler.then(
    (value) => { handlerSettlements.push(["fulfilled", value]); },
    (error) => { handlerSettlements.push(["rejected", error.message]); },
  );
  const neverCloseHandlerFailure = assert.rejects(
    neverCloseHandler,
    isGenericFailure,
  );
  const neverCloseDrainFailure = assert.rejects(
    neverCloseDrain,
    isGenericFailure,
  );
  let neverCloseSettled = false;
  void neverCloseDrain.then(
    () => { neverCloseSettled = true; },
    () => { neverCloseSettled = true; },
  );
  const deadlineStartedAt = Date.now();
  neverCloseUpgrade.resolve(Object.freeze({ outcome: "reject", status: 503 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(neverCloseSocket.responseText(), expectedResponse(503));
  assert.equal(neverCloseSocket.endCalls, 1);
  assert.equal(neverCloseSocket.destroyCalls, 0);
  neverCloseDelegated.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(neverCloseSettled, false);
  await neverCloseHandlerFailure;
  await neverCloseDrainFailure;
  const deadlineElapsedMs = Date.now() - deadlineStartedAt;
  assert.ok(deadlineElapsedMs >= 900, String(deadlineElapsedMs));
  assert.ok(deadlineElapsedMs < 5_000, String(deadlineElapsedMs));
  assert.equal(neverCloseSettled, true);
  assert.equal(neverCloseSocket.destroyCalls, 1);
  assert.deepEqual(handlerSettlements, [["rejected", FAILURE]]);
  neverCloseSocket.deliverLateEndCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handlerSettlements, [["rejected", FAILURE]]);
  assert.equal(neverCloseSocket.endCalls, 1);
  assert.equal(neverCloseSocket.destroyCalls, 1);

  const failedUpgrade = deferred();
  const failedClose = deferred();
  const failedComposition = fakeComposition({
    upgrade() { return failedUpgrade.promise; },
    close() { return failedClose.promise; },
  });
  const failedAdapter = createAdapter(failedComposition);
  const failedSocket = new MemoryDuplex();
  const failedHandler = failedAdapter.handleUpgradeRequest(inputFor(failedSocket));
  const failedDrain = failedAdapter.closeAndDrain();
  const handlerFailure = assert.rejects(failedHandler, isGenericFailure);
  let failedDrainSettled = false;
  void failedDrain.then(
    () => { failedDrainSettled = true; },
    () => { failedDrainSettled = true; },
  );
  failedUpgrade.reject(new Error(`B7j failed after possible 101 with ${TOKEN}`));
  await handlerFailure;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failedDrainSettled, false);
  assert.equal(failedSocket.endCalls, 0);
  assert.equal(failedSocket.destroyCalls, 0);
  assert.equal(failedSocket.responseText(), "");
  failedClose.resolve();
  await assert.rejects(failedDrain, isGenericFailure);
});
