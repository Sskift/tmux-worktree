import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import test from "node:test";
import { WebSocket } from "ws";

const hostAdapterModule = await import(
  "../dist/relay/v2/brokerHostWssNodeNoServerAdapter.js"
);
const hostWssModule = await import("../dist/relay/v2/hostWssTransportLifecycle.js");
const credentialModule = await import("../dist/relay/v2/hostCredentialAuthority.js");
const issuer = await import("../dist/relay/v2/issuer.js");
const carrierModule = await import("../dist/relay/v2/hostCarrier.js");

const HOST_PROTOCOL = "tw-relay.host.v2";
const HOST_ID = "mac-admin";
const HOST_EPOCH = "host-epoch-one";
const HOST_INSTANCE_ID = "host-instance-one";
const REFERENCE = "relay-v2-host-credential-ref:primary";
const HEARTBEAT_INTERVAL_MS = 50;
const HEARTBEAT_MISSED_PONG_LIMIT = 2;

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

function upgradeRequest(socket, protocols) {
  const headers = {
    upgrade: "websocket",
    "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
    "sec-websocket-version": "13",
  };
  if (protocols !== undefined) headers["sec-websocket-protocol"] = protocols;
  return Object.freeze({
    method: "GET",
    url: "/host",
    headers: Object.freeze(headers),
    socket,
  });
}

function invokeHostUpgrade(adapter, request, socket, callback, head = Buffer.alloc(0)) {
  return Reflect.apply(adapter.nativeUpgrade.handleUpgrade, adapter.nativeUpgrade, [
    request,
    socket,
    head,
    callback,
  ]);
}

// Build a masked pong frame echoing the ping payload (which may be empty).
function pongFrameForPing(pingBytes) {
  // pingBytes[0] is 0x89, pingBytes[1] is length+mask bit.
  const second = pingBytes[1];
  const masked = (second & 0x80) !== 0;
  let payloadLen = second & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = pingBytes.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(pingBytes.readBigUInt64BE(2));
    offset = 10;
  }
  let payload = pingBytes.subarray(offset, offset + payloadLen);
  if (masked) {
    const mask = pingBytes.subarray(offset, offset + 4);
    offset += 4;
    payload = pingBytes.subarray(offset, offset + payloadLen);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }
  // Client-to-server pong must be masked.
  const maskKey = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const maskedPayload = Buffer.from(payload);
  for (let i = 0; i < maskedPayload.length; i += 1) {
    maskedPayload[i] ^= maskKey[i % 4];
  }
  let header;
  if (payloadLen < 126) {
    header = Buffer.from([0x8a, 0x80 | payloadLen]);
  } else if (payloadLen < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x8a;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLen, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x8a;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLen), 2);
  }
  return Buffer.concat([header, maskKey, maskedPayload]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class InMemoryCredentialStorage {
  slots = new Map();
  exclusiveDepth = 0;

  runExclusive(reference, operation) {
    if (this.exclusiveDepth !== 0) {
      throw new Error("injected non-reentrant credential storage");
    }
    const slot = this.slot(reference);
    this.exclusiveDepth += 1;
    try {
      return operation({
        read: () => ({
          state: slot.state === null ? null : structuredClone(slot.state),
          revision: Object.freeze({ revision: slot.revision }),
        }),
        compareAndSwap(_expected, replacement) {
          slot.state = replacement === null ? null : structuredClone(replacement);
          slot.revision += 1;
          return { status: "swapped" };
        },
      });
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
}

function tokenIssuer() {
  let keyring = issuer.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "host-heartbeat-test-key",
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
  authority.applyBootstrapResponse(prepared.fence, {
    bootstrapAttemptId: "bootstrap-attempt-one",
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: "twref2.refresh-one",
    refreshExpiresAtMs: access.expiresAtMs + 86_400_000,
  });
  return { storage, authority };
}

test("broker host WSS adapter: pong-responding peer stays connected", async () => {
  const adapter = hostAdapterModule.createRelayV2BrokerHostWssNodeNoServerAdapter({
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatMissedPongLimit: HEARTBEAT_MISSED_PONG_LIMIT,
  });

  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    invokeHostUpgrade(adapter, request, socket, (webSocket) => {
      webSocket;
    }, head);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const client = new WebSocket(`ws://localhost:${port}`, HOST_PROTOCOL);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });

  // Wait well past 2x interval; the ws client auto-pongs so the socket must stay open.
  await sleep(HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MISSED_PONG_LIMIT + 3));
  assert.equal(client.readyState, WebSocket.OPEN, "client should remain open");

  client.close();
  await new Promise((resolve) => server.close(resolve));
  await adapter.closeAndDrain();
});

test("broker host WSS adapter: non-ponging peer is terminated within 2x interval", async () => {
  const adapter = hostAdapterModule.createRelayV2BrokerHostWssNodeNoServerAdapter({
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatMissedPongLimit: HEARTBEAT_MISSED_PONG_LIMIT,
  });

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket, HOST_PROTOCOL);
  let accepted;
  invokeHostUpgrade(adapter, request, socket, (webSocket) => {
    accepted = webSocket;
  });
  assert.ok(accepted);

  const closed = new Promise((resolve) => accepted.once("close", resolve));
  // Do not push any pong frames; the heartbeat should terminate the socket.
  await closed;
  assert.equal(accepted.readyState, WebSocket.CLOSED);

  socket.destroy();
  await adapter.closeAndDrain();
});

test("broker host WSS adapter: manual pong responses keep the socket alive", async () => {
  const adapter = hostAdapterModule.createRelayV2BrokerHostWssNodeNoServerAdapter({
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatMissedPongLimit: HEARTBEAT_MISSED_PONG_LIMIT,
  });

  const socket = new MemoryDuplex();
  const request = upgradeRequest(socket, HOST_PROTOCOL);
  let accepted;
  invokeHostUpgrade(adapter, request, socket, (webSocket) => {
    accepted = webSocket;
  });
  assert.ok(accepted);

  // Echo every ping frame back as a masked pong.
  let written = 0;
  const interval = setInterval(() => {
    while (written < socket.writes.length) {
      const chunk = socket.writes[written];
      written += 1;
      if (chunk[0] === 0x89) {
        socket.push(pongFrameForPing(chunk));
      }
    }
  }, 5);

  await sleep(HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MISSED_PONG_LIMIT + 3));
  assert.equal(accepted.readyState, WebSocket.OPEN, "socket should stay open with pongs");

  clearInterval(interval);
  accepted.terminate();
  socket.destroy();
  await adapter.closeAndDrain();
});

// --- Host WSS transport lifecycle heartbeat ---

test("host WSS lifecycle: pong responses keep the transport open", async () => {
  const { authority } = credentialHarness();

  const sockets = [];
  class FakeWebSocket {
    constructor(address, protocols, options) {
      this.address = address;
      this.protocols = protocols;
      this.options = options;
      this.readyState = 0;
      this.protocol = "";
      this.extensions = "";
      this.listeners = new Map();
      this.pingCalls = 0;
      this.terminateCalls = 0;
      sockets.push(this);
      options.finishRequest({
        setHeader() {},
        end() {},
        destroy() {},
      }, this);
    }
    on(event, listener) {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    removeListener(event, listener) {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(event, list.filter((l) => l !== listener));
      return this;
    }
    send(_bytes, _options, callback) {
      if (callback) queueMicrotask(callback);
    }
    close() {
      this.readyState = 3;
      for (const l of this.listeners.get("close") ?? []) l(1000);
    }
    terminate() {
      this.terminateCalls += 1;
      this.readyState = 3;
      for (const l of this.listeners.get("close") ?? []) l(1006);
    }
    ping() {
      this.pingCalls += 1;
      // Auto-respond with pong (mimics real ws client behavior).
      setImmediate(() => this.emit("pong"));
    }
    emit(event, ...args) {
      for (const l of this.listeners.get(event) ?? []) l(...args);
    }
  }

  const factory = new hostWssModule.RelayV2HostWssTransportLifecycleFactory({
    relayUrl: "wss://relay.example.test/",
    credentialAuthority: authority,
    webSocketConstructor: FakeWebSocket,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatMissedPongLimit: HEARTBEAT_MISSED_PONG_LIMIT,
  });

  const signal = new AbortController().signal;
  const input = Object.freeze({
    requestId: "heartbeat-request",
    controllerGeneration: "1",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReference: REFERENCE,
    signal,
  });
  const admission = hostWssModule.prepareRelayV2HostWssTransportLifecycleAttempt(
    factory,
    Object.freeze({ ...input, credentialReferences: authority }),
  );
  const lifecycle = factory.createTransportLifecycle(input);

  const carrier = new carrierModule.RelayV2HostCarrierActor({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReferences: authority,
    credentialConnectionAdmission: admission,
    routeSink: { onRouteBound() {}, onClientFrame() {}, onRouteUnbound() {} },
    advertisedCapabilities: [],
    clientDialects: ["tw-relay.v2"],
    idFactory: () => "host-hello-one",
    onStatus() {},
  });
  const connection = carrier.connect(lifecycle.transport, REFERENCE);
  lifecycle.bindConnection(connection);

  const socket = sockets[0];
  assert.ok(socket);
  socket.readyState = 1;
  socket.protocol = hostWssModule.RELAY_V2_HOST_WSS_SUBPROTOCOL;
  socket.extensions = "";
  socket.emit("open");

  await sleep(HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MISSED_PONG_LIMIT + 3));
  assert.equal(socket.terminateCalls, 0, "socket should not be terminated when ponging");
  assert.ok(socket.pingCalls >= HEARTBEAT_MISSED_PONG_LIMIT, "heartbeat pings were sent");

  socket.terminate();
});

test("host WSS lifecycle: missing pongs terminate the transport within 2x interval", async () => {
  const { authority } = credentialHarness();

  const sockets = [];
  class FakeWebSocket {
    constructor(address, protocols, options) {
      this.address = address;
      this.protocols = protocols;
      this.options = options;
      this.readyState = 0;
      this.protocol = "";
      this.extensions = "";
      this.listeners = new Map();
      this.pingCalls = 0;
      this.terminateCalls = 0;
      sockets.push(this);
      options.finishRequest({
        setHeader() {},
        end() {},
        destroy() {},
      }, this);
    }
    on(event, listener) {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    removeListener(event, listener) {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(event, list.filter((l) => l !== listener));
      return this;
    }
    send(_bytes, _options, callback) {
      if (callback) queueMicrotask(callback);
    }
    close() {
      this.readyState = 3;
      for (const l of this.listeners.get("close") ?? []) l(1000);
    }
    terminate() {
      this.terminateCalls += 1;
      this.readyState = 3;
      for (const l of this.listeners.get("close") ?? []) l(1006);
    }
    ping() {
      this.pingCalls += 1;
    }
    emit(event, ...args) {
      for (const l of this.listeners.get(event) ?? []) l(...args);
    }
  }

  const factory = new hostWssModule.RelayV2HostWssTransportLifecycleFactory({
    relayUrl: "wss://relay.example.test/",
    credentialAuthority: authority,
    webSocketConstructor: FakeWebSocket,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatMissedPongLimit: HEARTBEAT_MISSED_PONG_LIMIT,
  });

  const signal = new AbortController().signal;
  const input = Object.freeze({
    requestId: "heartbeat-request-2",
    controllerGeneration: "2",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReference: REFERENCE,
    signal,
  });
  const admission = hostWssModule.prepareRelayV2HostWssTransportLifecycleAttempt(
    factory,
    Object.freeze({ ...input, credentialReferences: authority }),
  );
  const lifecycle = factory.createTransportLifecycle(input);

  const carrier = new carrierModule.RelayV2HostCarrierActor({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReferences: authority,
    credentialConnectionAdmission: admission,
    routeSink: { onRouteBound() {}, onClientFrame() {}, onRouteUnbound() {} },
    advertisedCapabilities: [],
    clientDialects: ["tw-relay.v2"],
    idFactory: () => "host-hello-two",
    onStatus() {},
  });
  const connection = carrier.connect(lifecycle.transport, REFERENCE);
  lifecycle.bindConnection(connection);

  const socket = sockets[0];
  assert.ok(socket);
  socket.readyState = 1;
  socket.protocol = hostWssModule.RELAY_V2_HOST_WSS_SUBPROTOCOL;
  socket.extensions = "";
  socket.emit("open");

  // Never emit pong. The heartbeat should terminate the socket.
  const start = Date.now();
  while (socket.terminateCalls === 0 && Date.now() - start < HEARTBEAT_INTERVAL_MS * 10) {
    await sleep(5);
  }
  assert.ok(socket.terminateCalls >= 1, "socket should be terminated after missed pongs");
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed <= HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MISSED_PONG_LIMIT + 2),
    `terminated within 2x interval (elapsed=${elapsed}ms)`,
  );
});
