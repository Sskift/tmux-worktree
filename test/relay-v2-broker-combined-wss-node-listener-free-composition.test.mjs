import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const broker = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const compositionModule = await import("../dist/relay/v2/brokerHostWssListenerFreeComposition.js");
const corpus = loadRelayV2FixtureCorpus();

const NOW_MS = 1_783_700_000_000;
const HOST_ID = "combined-listener-free-host";
const HOST_PROTOCOL = "tw-relay.host.v2";
const CLIENT_PROTOCOL = "tw-relay.v2";
const HOST_TOKEN = "twcap2.combined-host-sensitive";
const CLIENT_TOKEN = "twcap2.combined-client-sensitive";
const FAILURE = "Relay v2 Broker combined WSS Node listener-free composition failed";

function auth(role) {
  return Object.freeze({ scheme: "twcap2", role, hostId: HOST_ID,
    principalId: `${role}-principal`, grantId: `${role}-grant`,
    clientInstanceId: role === "client" ? "combined-client-install" : null,
    jti: `${role}-jti`, kid: "kid-current", expiresAtMs: NOW_MS + 3600000,
    authorizationRevision: "11", authorizationFence: "authorization-fence-11" });
}

function sharedRuntimeOptions() {
  return { brokerOptions: { now: () => NOW_MS, baseCapabilityReadiness: [...broker.RELAY_V2_REQUIRED_CAPABILITIES] }, authorizationExpiryScheduleAt: () => () => {} };
}

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function hostHello(identity) {
  return codec.encodeRelayV2WebSocketFrame("carrier", { carrierVersion: 1, type: "host.hello", requestId: randomUUID(), payload: {
    hostId: HOST_ID, hostEpoch: identity.hostEpoch, hostInstanceId: identity.hostInstanceId, clientDialects: [CLIENT_PROTOCOL],
    capabilities: [...broker.RELAY_V2_REQUIRED_CAPABILITIES], limits: { maxFrameBytes: 1048576, terminalMaxFrameBytes: 65536 },
  }});
}

function clientHello() {
  const frame = fixture("client-hello-fresh");
  frame.requestId = randomUUID();
  frame.hostId = HOST_ID;
  frame.payload.clientInstanceId = "combined-client-install";
  frame.payload.capabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  frame.payload.requiredCapabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  return frame;
}

function hostWelcome(hello, identity) {
  const frame = fixture("host-welcome-snapshot-required");
  frame.requestId = hello.requestId;
  frame.hostId = HOST_ID;
  frame.hostEpoch = identity.hostEpoch;
  frame.hostInstanceId = identity.hostInstanceId;
  frame.payload.capabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  return frame;
}

function decode(data) { return codec.decodeRelayV2WebSocketFrame("carrier", Buffer.from(data)).frame; }

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for combined listener-free evidence");
}

function rejectedUpgradeStatus(url, protocol, token) {
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const socket = new WebSocket(url, protocol, {
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.once("unexpected-response", (_request, response) => {
      responseReceived = true;
      const { statusCode } = response;
      response.resume();
      resolve(statusCode);
    });
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("role-mismatched WebSocket unexpectedly opened"));
    });
    socket.once("error", (error) => {
      if (!responseReceived) reject(error);
    });
  });
}

function hostToClientData(route, seq, publicWire) {
  return codec.encodeRelayV2WebSocketFrame("carrier", {
    carrierVersion: 1,
    type: "route.data",
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
    direction: "host_to_client",
    seq,
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(publicWire).toString("base64"),
    },
  });
}

function routeOpened(route) {
  return codec.encodeRelayV2WebSocketFrame("carrier", {
    carrierVersion: 1,
    type: "route.opened",
    requestId: route.requestId,
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
    payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1048576 },
  });
}

function sendText(socket, bytes) {
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(bytes).toString("utf8"), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function exerciseRealHostToClientLoopback(t, composition, roleSplit = false) {
  let host;
  let client;
  const server = createServer();
  t.after(async () => {
    host?.terminate();
    client?.terminate();
    await composition.closeAndDrain().catch(() => {});
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  server.on("upgrade", (request, socket, head) => {
    const input = { request, socket, head };
    const pending = request.url === "/host"
      ? composition.handleHostUpgradeRequest(input)
      : composition.handleClientUpgradeRequest(input);
    pending.catch(() => socket.destroy());
  });

  if (roleSplit) {
    assert.equal(await rejectedUpgradeStatus(
      `ws://127.0.0.1:${port}/host`,
      HOST_PROTOCOL,
      CLIENT_TOKEN,
    ), 403);
  }

  const hostFrames = [];
  const hostErrors = [];
  const hostIdentity = {
    hostEpoch: randomUUID(),
    hostInstanceId: randomUUID(),
  };
  host = new WebSocket(`ws://127.0.0.1:${port}/host`, HOST_PROTOCOL, {
    headers: { Authorization: `Bearer ${HOST_TOKEN}` },
  });
  host.on("error", (error) => hostErrors.push(error));
  host.on("message", (data) => hostFrames.push(decode(data)));
  await once(host, "open");
  await sendText(host, hostHello(hostIdentity));
  await waitFor(() => hostFrames.find((frame) => frame.type === "host.registered"));

  if (roleSplit) {
    assert.equal(await rejectedUpgradeStatus(
      `ws://127.0.0.1:${port}/client`,
      CLIENT_PROTOCOL,
      HOST_TOKEN,
    ), 403);
  }

  const clientMessages = [];
  const clientFrames = [];
  const clientErrors = [];
  client = new WebSocket(`ws://127.0.0.1:${port}/client`, CLIENT_PROTOCOL, {
    headers: { Authorization: `Bearer ${CLIENT_TOKEN}` },
  });
  client.on("error", (error) => clientErrors.push(error));
  client.on("message", (data) => {
    const bytes = Buffer.from(data);
    clientMessages.push(bytes.toString("utf8"));
    clientFrames.push(codec.decodeRelayV2WebSocketFrame("public", bytes).frame);
  });
  const clientOpen = once(client, "open");
  const route = await waitFor(() => hostFrames.find((frame) => frame.type === "route.open"));

  // A WebSocket `open` event precedes Core processing of route.opened. The
  // callback proves the carrier write completed; the following turn lets the
  // route_opened adapter action open the Client drain gate for Core's queued
  // public welcome.
  await sendText(host, routeOpened(route));
  await new Promise((resolve) => setImmediate(resolve));
  await clientOpen;
  await waitFor(() => (
    clientFrames.find((frame) => frame.type === "relay.welcome")
  ));
  assert.deepEqual(JSON.parse(clientMessages[0]), {
    protocolVersion: 2,
    kind: "event",
    type: "relay.welcome",
    payload: {
      selectedVersion: 2,
      connectionId: route.payload.connectionId,
      brokerEpoch: hostFrames.find((frame) => frame.type === "host.registered")
        .payload.brokerEpoch,
      principalId: "client-principal",
      capabilities: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      limits: {
        maxFrameBytes: broker.RELAY_V2_BROKER_LIMITS.maxFrameBytes,
        maxCarrierFrameBytes: broker.RELAY_V2_BROKER_LIMITS.maxCarrierFrameBytes,
        brokerRouteBufferedBytesPerDirection:
          broker.RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection,
        brokerRouteLowWaterBytesPerDirection:
          broker.RELAY_V2_BROKER_LIMITS.routeLowWaterBytesPerDirection,
        brokerCarrierBufferedBytes: broker.RELAY_V2_BROKER_LIMITS.carrierBufferedBytes,
        brokerCarrierLowWaterBytes: broker.RELAY_V2_BROKER_LIMITS.carrierLowWaterBytes,
        maxQueuedRouteFrames: broker.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames,
        maxInFlightRequestsPerRoute:
          broker.RELAY_V2_BROKER_LIMITS.maxInFlightRequestsPerRoute,
      },
    },
  });

  const hello = clientHello();
  await sendText(client, codec.encodeRelayV2WebSocketFrame("public", hello));
  await new Promise((resolve) => setImmediate(resolve));
  const clientRouteData = await waitFor(() => hostFrames.find((frame) => (
    frame.type === "route.data" && frame.direction === "client_to_host"
  )));
  const observedHello = codec.decodeRelayV2WebSocketFrame(
    "public",
    Buffer.from(clientRouteData.payload.data, "base64"),
  ).frame;
  assert.equal(observedHello.type, "client.hello");
  assert.equal(observedHello.requestId, hello.requestId);
  assert.deepEqual(clientFrames.map((frame) => frame.type), ["relay.welcome"]);

  const welcome = hostWelcome(observedHello, hostIdentity);
  const welcomeWire = codec.encodeRelayV2WebSocketFrame("public", welcome);
  const expectedWelcome = Buffer.from(welcomeWire).toString("utf8");
  await sendText(host, hostToClientData(route, "1", welcomeWire));
  await new Promise((resolve) => setImmediate(resolve));
  await waitFor(() => clientMessages.includes(expectedWelcome) ? true : undefined);
  assert.deepEqual(
    clientFrames.slice(0, 2).map((frame) => frame.type),
    ["relay.welcome", "host.welcome"],
  );

  const loopback = codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId: "combined-loopback-stream",
    payload: { generation: "combined-loopback-generation", ackedThroughInputSeq: "7" },
  });
  const expectedLoopback = Buffer.from(loopback).toString("utf8");
  await sendText(host, hostToClientData(route, "2", loopback));
  await new Promise((resolve) => setImmediate(resolve));
  await waitFor(() => clientMessages.includes(expectedLoopback) ? true : undefined);
  assert.equal(clientMessages.includes(expectedLoopback), true);
  assert.equal(hostErrors.length, 0);
  assert.equal(clientErrors.length, 0);

  const hostClosed = once(host, "close");
  const clientClosed = once(client, "close");
  const close = composition.closeAndDrain();
  assert.strictEqual(composition.closeAndDrain(), close);
  await close;
  assert.strictEqual(composition.closeAndDrain(), close);
  host.close();
  client.close();
  await Promise.all([hostClosed, clientClosed]);
}

test("raw combined owner loops real Host data to Client and closes once", async (t) => {
  const roles = [];
  const composition = await compositionModule.createRelayV2BrokerCombinedWssNodeListenerFreeComposition({
    verifyV2AccessToken(token, role) {
      roles.push(role);
      assert.equal(token, role === "host" ? HOST_TOKEN : CLIENT_TOKEN);
      return auth(role);
    }, sharedRuntimeOptions: sharedRuntimeOptions(),
  });
  await exerciseRealHostToClientLoopback(t, composition);
  assert.deepEqual(roles, ["host", "client"]);
});

test("combined strict outer input rejects extras without invoking verifier", async () => {
  let calls = 0;
  await assert.rejects(compositionModule.createRelayV2BrokerCombinedWssNodeListenerFreeComposition({ verifyV2AccessToken() { calls += 1; }, sharedRuntimeOptions: sharedRuntimeOptions(), extra: true }), (error) => error?.message === FAILURE);
  assert.equal(calls, 0);
});

test("credential-activated combined owner splits roles, loops Host data to Client, and closes once", async (t) => {
  let exactAuthority;
  let authorityCloseCalls = 0;
  let openerInput;
  const authorizerCalls = [];

  class ExactCredentialAuthority {
    authorityContinuityReadiness = Object.freeze({ status: "ready" });

    async handle() {
      throw new Error("auth-control is not used by this combined ingress case");
    }

    authorizeAccessToken(token, expectedRole) {
      assert.strictEqual(this, exactAuthority);
      authorizerCalls.push([token, expectedRole]);
      const expectedToken = expectedRole === "host" ? HOST_TOKEN : CLIENT_TOKEN;
      if (token !== expectedToken) {
        throw Object.assign(new Error("credential role mismatch"), {
          code: "ROLE_MISMATCH",
        });
      }
      return auth(expectedRole);
    }

    async close() {
      assert.strictEqual(this, exactAuthority);
      authorityCloseCalls += 1;
    }
  }
  exactAuthority = new ExactCredentialAuthority();

  const composition = await compositionModule
    .activateRelayV2BrokerCombinedWssNodeListenerFreeComposition({
      async openCredentialAuthority(input) {
        assert.equal(this, undefined);
        assert.equal(Object.isFrozen(input), true);
        assert.deepEqual(Reflect.ownKeys(input), ["liveAuthorizationFence"]);
        openerInput = input;
        return exactAuthority;
      },
      sharedRuntimeOptions: sharedRuntimeOptions(),
    });
  assert.equal(typeof openerInput.liveAuthorizationFence.begin, "function");
  assert.equal(Object.getPrototypeOf(composition), null);
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Reflect.ownKeys(composition), [
    "handleHostUpgradeRequest",
    "handleClientUpgradeRequest",
    "closeAndDrain",
  ]);
  for (const forbidden of [
    "credentialAuthority",
    "authorizeAccessToken",
    "runtime",
    "core",
    "producerRegistry",
  ]) assert.equal(composition[forbidden], undefined);

  await exerciseRealHostToClientLoopback(t, composition, true);

  assert.deepEqual(authorizerCalls, [
    [CLIENT_TOKEN, "host"],
    [HOST_TOKEN, "host"],
    [HOST_TOKEN, "client"],
    [CLIENT_TOKEN, "client"],
  ]);
  assert.equal(authorityCloseCalls, 1);
});

test("credential-activated combined construction rolls back an unpublished authorizer", async () => {
  let liveAuthorizationFence;
  let authorityCloseCalls = 0;
  const authority = {
    authorityContinuityReadiness: Object.freeze({ status: "ready" }),
    async handle() {
      throw new Error("unpublished authority must not handle auth-control");
    },
    async close() {
      assert.strictEqual(this, authority);
      authorityCloseCalls += 1;
    },
  };

  await assert.rejects(
    compositionModule.activateRelayV2BrokerCombinedWssNodeListenerFreeComposition({
      async openCredentialAuthority(input) {
        liveAuthorizationFence = input.liveAuthorizationFence;
        return authority;
      },
      sharedRuntimeOptions: sharedRuntimeOptions(),
    }),
    (error) => error?.message === FAILURE,
  );
  assert.equal(authorityCloseCalls, 1);
  assert.throws(() => liveAuthorizationFence.begin({
    reason: "kid_removed",
    kid: "combined-rollback-kid",
  }), /live-authorization close signal is unavailable/);
});
