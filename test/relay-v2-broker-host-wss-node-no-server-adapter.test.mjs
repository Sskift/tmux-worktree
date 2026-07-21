import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";

const adapterModule = await import(
  "../dist/relay/v2/brokerHostWssNodeNoServerAdapter.js"
);
const hostSocketModule = await import("../dist/relay/v2/brokerHostWssAdapter.js");

const HOST_PROTOCOL = "tw-relay.host.v2";
const FAILURE = "Relay v2 Broker Host noServer Upgrade failed";

class MemoryDuplex extends Duplex {
  constructor() {
    super();
    this.writes = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  responseText() {
    return Buffer.concat(this.writes).toString("latin1");
  }
}

function upgradeRequest(socket, protocols, { compression = false } = {}) {
  const headers = {
    upgrade: "websocket",
    "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
    "sec-websocket-version": "13",
  };
  if (protocols !== undefined) headers["sec-websocket-protocol"] = protocols;
  if (compression) {
    headers["sec-websocket-extensions"] =
      "permessage-deflate; client_max_window_bits";
  }
  return Object.freeze({
    method: "GET",
    url: "/host",
    headers: Object.freeze(headers),
    socket,
  });
}

function invokeUpgrade(adapter, request, socket, callback, head = Buffer.alloc(0)) {
  return Reflect.apply(adapter.nativeUpgrade.handleUpgrade, adapter.nativeUpgrade, [
    request,
    socket,
    head,
    callback,
  ]);
}

function isGenericFailure(error) {
  assert.equal(error.message, FAILURE);
  assert.equal(error.cause, undefined);
  return true;
}

function oversizedMaskedBinaryHeader(payloadBytes) {
  const frame = Buffer.alloc(14);
  frame[0] = 0x82;
  frame[1] = 0x80 | 127;
  frame.writeUInt32BE(0, 2);
  frame.writeUInt32BE(payloadBytes, 6);
  return frame;
}

test("real noServer ws handshake admits only the Host protocol without compression and rejects oversized frames", async () => {
  const adapter = adapterModule.createRelayV2BrokerHostWssNodeNoServerAdapter();

  for (const [name, protocols] of [
    ["missing", undefined],
    ["extra", `${HOST_PROTOCOL}, tw-relay.v2`],
    ["other", "tw-relay.v2"],
  ]) {
    const socket = new MemoryDuplex();
    const request = upgradeRequest(socket, protocols);
    let callbackCalled = false;
    assert.throws(
      () => invokeUpgrade(adapter, request, socket, () => { callbackCalled = true; }),
      isGenericFailure,
      name,
    );
    assert.equal(callbackCalled, false, name);
    assert.equal(socket.responseText().includes("101 Switching Protocols"), false, name);
    socket.destroy();
  }

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket, HOST_PROTOCOL, { compression: true });
  let accepted;
  assert.equal(invokeUpgrade(adapter, request, socket, (webSocket) => {
    accepted = webSocket;
  }), undefined);
  assert.ok(accepted);
  assert.equal(accepted.protocol, HOST_PROTOCOL);
  assert.equal(accepted.extensions, "");
  const response = socket.responseText();
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(response, /\r\nSec-WebSocket-Protocol: tw-relay\.host\.v2\r\n/);
  assert.doesNotMatch(response, /\r\nSec-WebSocket-Extensions:/i);

  const frameError = new Promise((resolve) => accepted.once("error", resolve));
  socket.push(oversizedMaskedBinaryHeader(
    hostSocketModule.RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES + 1,
  ));
  const error = await frameError;
  assert.equal(error.code, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  socket.destroy();
  await adapter.closeAndDrain();
});

test("adapter surface, receivers, callback identity, and close fence remain exact", async () => {
  const adapter = adapterModule.createRelayV2BrokerHostWssNodeNoServerAdapter();
  assert.equal(Object.getPrototypeOf(adapter), null);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Reflect.ownKeys(adapter), [
    "trustedSocketPrototype",
    "nativeUpgrade",
    "closeAndDrain",
  ]);
  assert.equal(Object.getPrototypeOf(adapter.nativeUpgrade), null);
  assert.equal(Object.isFrozen(adapter.nativeUpgrade), true);
  assert.deepEqual(Reflect.ownKeys(adapter.nativeUpgrade), ["handleUpgrade"]);

  const foreignSocket = new MemoryDuplex();
  const foreignRequest = upgradeRequest(foreignSocket, HOST_PROTOCOL);
  let foreignCallbackCalled = false;
  assert.throws(
    () => Reflect.apply(adapter.nativeUpgrade.handleUpgrade, Object.create(null), [
      foreignRequest,
      foreignSocket,
      Buffer.alloc(0),
      () => { foreignCallbackCalled = true; },
    ]),
    isGenericFailure,
  );
  assert.equal(foreignCallbackCalled, false);
  assert.equal(foreignSocket.responseText(), "");
  foreignSocket.destroy();
  await assert.rejects(
    Reflect.apply(adapter.closeAndDrain, Object.create(null), []),
    isGenericFailure,
  );

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket, HOST_PROTOCOL);
  const nonBufferHead = new Uint8Array(new ArrayBuffer(8), 3, 0);
  let accepted;
  let callbackRequest;
  let callbackReceiver = null;
  let closing;
  let closingAgain;
  const result = invokeUpgrade(adapter, request, socket, function callback(
    webSocket,
    upgradedRequest,
  ) {
    callbackReceiver = this;
    accepted = webSocket;
    callbackRequest = upgradedRequest;
    closing = adapter.closeAndDrain();
    closingAgain = adapter.closeAndDrain();
  }, nonBufferHead);
  assert.equal(result, undefined);
  assert.equal(callbackReceiver, undefined);
  assert.strictEqual(callbackRequest, request);
  assert.strictEqual(Object.getPrototypeOf(accepted), adapter.trustedSocketPrototype);
  assert.strictEqual(closingAgain, closing);

  const fencedSocket = new MemoryDuplex();
  const fencedRequest = upgradeRequest(fencedSocket, HOST_PROTOCOL);
  assert.throws(
    () => invokeUpgrade(adapter, fencedRequest, fencedSocket, () => {}),
    isGenericFailure,
  );
  assert.equal(fencedSocket.responseText(), "");
  fencedSocket.destroy();

  await closing;
  assert.strictEqual(adapter.closeAndDrain(), closing);
  assert.equal(accepted.readyState, 1);
  accepted.terminate();
});
