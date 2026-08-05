import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import test from "node:test";

const adapterModule = await import(
  "../dist/relay/v2/brokerHostWssNodeUpgradeRequestAdapter.js"
);

const TOKEN = "twcap2.node-upgrade-request-sensitive";
const HOST_PROTOCOL = "tw-relay.host.v2";
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

function requestFor(socket, {
  url = "/host",
  rawHeaders = [
    "Authorization", `Bearer ${TOKEN}`,
    "Sec-WebSocket-Protocol", HOST_PROTOCOL,
  ],
} = {}) {
  const request = new IncomingMessage(socket);
  request.url = url;
  request.rawHeaders = rawHeaders;
  return request;
}

function inputFor(socket, request = requestFor(socket), head = Buffer.alloc(0)) {
  return { request, socket, head };
}

function fakeComposition({ upgrade, close = () => Promise.resolve() }) {
  let hostUpgrade;
  let composition;
  hostUpgrade = Object.freeze(Object.assign(Object.create(null), {
    upgrade(input) {
      assert.strictEqual(this, hostUpgrade);
      return upgrade(input);
    },
  }));
  composition = Object.freeze(Object.assign(Object.create(null), {
    hostUpgrade,
    closeAndDrain() {
      assert.strictEqual(this, composition);
      return close();
    },
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

test("forwards raw Host Upgrade metadata and leaves an upgraded socket to the delegated owner", async () => {
  const delegatedInputs = [];
  let closeCalls = 0;
  const adapter = createAdapter(fakeComposition({
    async upgrade(input) {
      delegatedInputs.push(input);
      return Object.freeze({ outcome: "upgraded", connection: Object.freeze({}) });
    },
    close() {
      closeCalls += 1;
      return Promise.resolve();
    },
  }));

  const socket = new MemoryDuplex();
  const request = requestFor(socket, {
    url: "/host?credential=query-secret",
    rawHeaders: [
      "authorization", `Bearer ${TOKEN}-first`,
      "X-Ignored", "value",
      "AUTHORIZATION", `Bearer ${TOKEN}-second`,
      "Sec-WebSocket-Protocol", `\t${HOST_PROTOCOL} \t, tw-relay.v2\t`,
      "sec-websocket-protocol", "  tw-relay.extra\t",
    ],
  });
  const head = new Uint8Array(new ArrayBuffer(8), 2, 3);

  assert.equal(
    await adapter.handleUpgradeRequest(inputFor(socket, request, head)),
    "upgraded",
  );
  assert.equal(delegatedInputs.length, 1);
  assert.strictEqual(delegatedInputs[0].request, request);
  assert.strictEqual(delegatedInputs[0].socket, socket);
  assert.strictEqual(delegatedInputs[0].head, head);
  assert.deepEqual({ ...delegatedInputs[0].metadata }, {
    pathname: "/host",
    search: "?credential=query-secret",
    authorizationHeaders: [
      `Bearer ${TOKEN}-first`,
      `Bearer ${TOKEN}-second`,
    ],
    legacyQuerySecret: null,
    offeredProtocols: [HOST_PROTOCOL, "tw-relay.v2", "tw-relay.extra"],
  });
  assert.equal(socket.responseText(), "");
  assert.equal(socket.endCalls, 0);
  assert.equal(socket.destroyCalls, 0);

  await adapter.closeAndDrain();
  assert.equal(closeCalls, 1);
  socket.destroy();
});

test("writes fixed empty pre-101 rejects and rejects malformed requests before delegation", async () => {
  const statuses = [400, 401, 403, 404, 426, 503];
  let upgradeCalls = 0;
  const adapter = createAdapter(fakeComposition({
    async upgrade() {
      const status = statuses[upgradeCalls];
      upgradeCalls += 1;
      return Object.freeze({
        outcome: "reject",
        status,
        errorCode: `sensitive-${TOKEN}`,
        fallback: false,
      });
    },
  }));

  for (const status of statuses) {
    const socket = new MemoryDuplex();
    assert.equal(await adapter.handleUpgradeRequest(inputFor(socket)), "rejected");
    assert.equal(socket.responseText(), expectedResponse(status));
    assert.equal(socket.responseText().includes(TOKEN), false);
    assert.equal(socket.endCalls, 1);
  }

  const malformedSocket = new MemoryDuplex();
  const malformedRequest = requestFor(malformedSocket, {
    rawHeaders: ["Authorization"],
  });
  assert.equal(
    await adapter.handleUpgradeRequest(inputFor(malformedSocket, malformedRequest)),
    "rejected",
  );
  assert.equal(malformedSocket.responseText(), expectedResponse(400));
  assert.equal(upgradeCalls, statuses.length);

  await adapter.closeAndDrain();
});

test("close fences new requests and waits for the active handler and delegated drain", async () => {
  const upgradeDecision = deferred();
  const delegatedClose = deferred();
  let closeCalls = 0;
  const adapter = createAdapter(fakeComposition({
    upgrade() {
      return upgradeDecision.promise;
    },
    close() {
      closeCalls += 1;
      return delegatedClose.promise;
    },
  }));
  const socket = new MemoryDuplex();
  const handling = adapter.handleUpgradeRequest(inputFor(socket));
  const closing = adapter.closeAndDrain();
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });

  upgradeDecision.resolve(Object.freeze({ outcome: "reject", status: 503 }));
  assert.equal(await handling, "rejected");
  assert.equal(socket.responseText(), expectedResponse(503));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(closeCalls, 1);

  delegatedClose.resolve();
  await closing;
  assert.equal(closeSettled, true);

  const lateSocket = new MemoryDuplex();
  await assert.rejects(
    adapter.handleUpgradeRequest(inputFor(lateSocket)),
    /Relay v2 Broker Host Node Upgrade request adapter failed/,
  );
  assert.equal(lateSocket.responseText(), "");
});
