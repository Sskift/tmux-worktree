import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  request as nodeHttpRequest,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const {
  startRelayBroker,
  startRelayV2BrokerPublicHttpsServer,
} = await import("../dist/relayServer.js");
const brokerCore = await import("../dist/relay/v2/brokerCore.js");
const relayV2Codec = await import("../dist/relay/v2/codec.js");
const agentCodec = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codec.js"
);
const relayV2Corpus = loadRelayV2FixtureCorpus();

const NOW_MS = 1_800_000_000_000;
const ACCESS_TOKEN = "twcap2.payload.mac";
const CLIENT_GRANT = Object.freeze({
  principalId: "client-principal",
  grantId: "client-grant",
  hostId: "host-one",
  relayUrl: "wss://relay.example.com/client",
  accessToken: ACCESS_TOKEN,
  accessExpiresAtMs: NOW_MS + 3_600_000,
  refreshToken: "twref2.next-client-refresh",
  refreshExpiresAtMs: NOW_MS + 86_400_000,
});
const HOST_GRANT = Object.freeze({
  principalId: "host-principal",
  grantId: "host-grant",
  hostId: "host-one",
  accessToken: ACCESS_TOKEN,
  accessExpiresAtMs: NOW_MS + 3_600_000,
  refreshToken: "twref2.next-host-refresh",
  refreshExpiresAtMs: NOW_MS + 86_400_000,
});
const CREDENTIAL_ROUTES = Object.freeze([
  Object.freeze({
    endpoint: "host_bootstrap",
    path: "/v2/hosts/bootstrap",
    body: Object.freeze({
      bootstrapAttemptId: "bootstrap-attempt",
      bootstrapToken: "twhostboot2.bootstrap-secret",
      hostId: "host-one",
      hostEpoch: "host-epoch",
      hostInstanceId: "host-instance",
    }),
  }),
  Object.freeze({
    endpoint: "enrollment_redeem",
    path: "/v2/enrollments/redeem",
    body: Object.freeze({
      exchangeAttemptId: "exchange-attempt",
      enrollmentId: "enrollment-one",
      enrollmentCode: "twenroll2.enrollment-code",
      clientInstanceId: "client-instance",
      deviceLabel: "Pixel",
    }),
  }),
  Object.freeze({
    endpoint: "client_refresh",
    path: "/v2/tokens/refresh",
    body: Object.freeze({
      refreshAttemptId: "client-refresh-attempt",
      grantId: "client-grant",
      clientInstanceId: "client-instance",
      refreshToken: "twref2.client-refresh",
    }),
  }),
  Object.freeze({
    endpoint: "host_refresh",
    path: "/v2/hosts/tokens/refresh",
    body: Object.freeze({
      refreshAttemptId: "host-refresh-attempt",
      grantId: "host-grant",
      hostInstanceId: "host-instance",
      refreshToken: "twref2.host-refresh",
    }),
  }),
  Object.freeze({
    endpoint: "self_revoke",
    path: "/v2/grants/self/revoke",
    body: Object.freeze({ reason: "user_revoked" }),
    authorization: `Bearer ${ACCESS_TOKEN}`,
  }),
]);

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function within(promise, label, timeoutMs = 2_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function assertPortClosed(port) {
  await within(new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(new Error(`listener still open on ${port}`)); });
    socket.once("error", () => { socket.destroy(); resolve(); });
  }), "listener close", 2_000);
}

class FakeReadyAuthority {
  constructor(fence, options = {}) {
    this.fence = fence;
    this.options = options;
    this.authorityContinuityReadiness = Object.freeze({ status: "ready" });
    this.receipts = new Map();
    this.calls = [];
    this.authorizeCalls = [];
    this.authControlEvents = [];
    this.activeHandlers = 0;
    this.activeAuthorizations = 0;
    this.activeAuthControls = 0;
    this.closed = false;
    this.blockedEndpoint = null;
    this.blockEntered = deferred();
    this.blockRelease = deferred();
    this.authorizeEntered = deferred();
    this.authorizeRelease = deferred();
    this.authControlEntered = deferred();
    this.authControlRelease = deferred();
  }

  async admitHttpSource(input) {
    const receipt = Object.freeze(() => undefined);
    this.receipts.set(receipt, { ...input });
    return receipt;
  }

  take(receipt, endpoint, sourceKey) {
    assert.deepEqual(this.receipts.get(receipt), { endpoint, sourceKey });
    this.receipts.delete(receipt);
  }

  releaseHttpSourceAdmission(receipt, endpoint, sourceKey) {
    this.take(receipt, endpoint, sourceKey);
  }

  authorization(token, role) {
    const suffix = token.slice("twcap2.".length).replaceAll(".", "-");
    return Object.freeze({
      scheme: "twcap2",
      role,
      hostId: "host-one",
      principalId: `${role}-principal`,
      grantId: suffix.includes("revoked") ? "grant-revoked" : `${role}-grant`,
      clientInstanceId: role === "client" ? "client-instance" : null,
      jti: suffix.includes("expired") ? "jti-expired" : `${role}-jti-${suffix}`,
      kid: "issuer-kid",
      expiresAtMs: Date.now() + 3_600_000,
      authorizationRevision: "1",
      authorizationFence: "authorization-fence-one",
    });
  }

  async authorizeAccessToken(token, role) {
    this.authorizeCalls.push({ token, role });
    this.activeAuthorizations += 1;
    try {
      if (this.options.blockAuthorization) {
        this.authorizeEntered.resolve();
        await this.authorizeRelease.promise;
      }
      return this.authorization(token, role);
    } finally {
      this.activeAuthorizations -= 1;
    }
  }

  async invoke(endpoint, receipt, sourceKey, body) {
    this.take(receipt, endpoint, sourceKey);
    this.activeHandlers += 1;
    this.calls.push({ endpoint, sourceKey, body: structuredClone(body) });
    try {
      if (this.blockedEndpoint === endpoint) {
        this.blockEntered.resolve();
        await this.blockRelease.promise;
      }
    } finally {
      this.activeHandlers -= 1;
    }
  }

  async bootstrapHost(receipt, sourceKey, input) {
    await this.invoke("host_bootstrap", receipt, sourceKey, input);
    return {
      endpoint: "host_bootstrap",
      replayed: false,
      body: {
        bootstrapAttemptId: input.bootstrapAttemptId,
        ...HOST_GRANT,
      },
    };
  }

  async redeemEnrollment(receipt, sourceKey, input) {
    await this.invoke("enrollment_redeem", receipt, sourceKey, input);
    return {
      endpoint: "enrollment_redeem",
      replayed: false,
      body: { exchangeAttemptId: input.exchangeAttemptId, ...CLIENT_GRANT },
    };
  }

  async refreshClientGrantFromHttp(receipt, sourceKey, input) {
    await this.invoke("client_refresh", receipt, sourceKey, input);
    return {
      endpoint: "client_refresh",
      replayed: false,
      body: { refreshAttemptId: input.refreshAttemptId, ...CLIENT_GRANT },
    };
  }

  async refreshHostGrantFromHttp(receipt, sourceKey, input) {
    await this.invoke("host_refresh", receipt, sourceKey, input);
    return {
      endpoint: "host_refresh",
      replayed: false,
      body: { refreshAttemptId: input.refreshAttemptId, ...HOST_GRANT },
    };
  }

  async selfRevokeGrantFromHttp(receipt, sourceKey, context, input) {
    await this.invoke("self_revoke", receipt, sourceKey, { context, input });
    return { grantId: context.grantId, revokedAtMs: NOW_MS, alreadyRevoked: false };
  }

  async handle(request) {
    const label = request.accessToken ?? request.type;
    this.activeAuthControls += 1;
    this.authControlEvents.push(`start:${label}`);
    try {
      if (this.options.blockFirstAuthControl && this.authControlEvents.length === 1) {
        this.authControlEntered.resolve();
        await this.authControlRelease.promise;
        if (this.options.rejectFirstAuthControl) throw new Error("isolated authority rejection");
      }
      this.authControlEvents.push(`finish:${label}`);
      return {
        outcome: "reject",
        error: {
          code: "AUTH_INVALID",
          message: "Rejected by isolated fake authority",
          retryable: false,
          retryAfterMs: null,
          commandDisposition: "not_applicable",
          details: null,
        },
      };
    } finally {
      this.activeAuthControls -= 1;
    }
  }

  async close() {
    assert.equal(this.activeHandlers, 0);
    assert.equal(this.activeAuthorizations, 0);
    assert.equal(this.activeAuthControls, 0);
    this.closed = true;
  }
}

function fakeComposition(options = {}) {
  const opened = deferred();
  const schedulerDelays = [];
  return {
    opened,
    schedulerDelays,
    composition: {
      async openCredentialAuthority({ liveAuthorizationFence }) {
        const authority = new FakeReadyAuthority(liveAuthorizationFence, options);
        opened.resolve(authority);
        return authority;
      },
      resolveHttpSourceKey(socket) {
        assert.equal(typeof socket.remoteAddress, "string");
        if (options.invalidSource) return "";
        return `trusted-listener:${socket.remoteAddress}`;
      },
      closeDeadlineScheduler: options.recordDeadlines ? {
        schedule(run, delayMs) {
          schedulerDelays.push(delayMs);
          const timer = setTimeout(run, delayMs);
          timer.unref();
          return timer;
        },
        cancel(timer) { clearTimeout(timer); },
      } : undefined,
      ...(options.agentReadiness
        ? {
            agentTranscriptLifecycleReadiness: options.agentReadiness.receipt,
          }
        : {}),
    },
  };
}

function fakeAgentReadiness({ synchronousLoss = false } = {}) {
  const subscribers = new Set();
  let cancelCalls = 0;
  let receipt;
  receipt = Object.freeze({
    status: "ready",
    subscribeLoss(onLoss) {
      assert.strictEqual(this, receipt);
      assert.equal(typeof onLoss, "function");
      subscribers.add(onLoss);
      let active = true;
      const cancel = () => {
        if (!active) return;
        active = false;
        cancelCalls += 1;
        subscribers.delete(onLoss);
      };
      if (synchronousLoss) onLoss();
      return cancel;
    },
  });
  return Object.freeze({
    receipt,
    lose() {
      for (const subscriber of [...subscribers]) subscriber();
    },
    subscriptionCount() { return subscribers.size; },
    cancelCalls() { return cancelCalls; },
  });
}

async function postJson(port, path, body, authorization) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
        Connection: "close",
        "X-Forwarded-For": "203.0.113.77",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(bytes);
  });
}

function openWebSocket(port, token, protocol = "tw-relay.host.v2") {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/host`, protocol, {
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function closeCode(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

function rejectedUpgradeStatus(port, token, protocol) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/client`, protocol, {
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.once("open", () => reject(new Error("unexpected WebSocket admission")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", () => undefined);
  });
}

function rejectedUpgradePathStatus(port, path, protocol) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocol);
    socket.once("open", () => reject(new Error("unexpected WebSocket admission")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", () => undefined);
  });
}

function upgradeAttempt(port, { role, token }) {
  const path = role === "host" ? "/host" : "/client";
  const protocol = role === "host" ? "tw-relay.host.v2" : "tw-relay.v2";
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocol, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const outcome = new Promise((resolve) => {
    socket.once("open", () => resolve({ outcome: "open" }));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ outcome: "reject", status: response.statusCode });
    });
    socket.once("error", () => undefined);
  });
  return { socket, outcome };
}

function connectV2(port, { role = "host", token = `twcap2.${role}` } = {}) {
  const path = role === "host" ? "/host" : "/client";
  const protocol = role === "host" ? "tw-relay.host.v2" : "tw-relay.v2";
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocol, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const messages = [];
  const waiters = [];
  socket.on("message", (data, isBinary) => {
    const item = { data: Buffer.from(data), isBinary };
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else messages.push(item);
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    opened,
    nextMessage() {
      const item = messages.shift();
      return item ? Promise.resolve(item) : new Promise((resolve) => waiters.push(resolve));
    },
    messageCount() { return messages.length; },
  };
}

function carrierFrame(frame) {
  return Buffer.from(
    relayV2Codec.encodeRelayV2WebSocketFrame("carrier", frame),
  ).toString("utf8");
}

function decodeFrame(channel, message) {
  assert.equal(message.isBinary, false);
  return relayV2Codec.decodeRelayV2WebSocketFrame(channel, message.data).frame;
}

function fakeHostHello(overrides = {}) {
  return {
    carrierVersion: 1,
    type: "host.hello",
    requestId: randomUUID(),
    payload: {
      hostId: "host-one",
      hostEpoch: randomUUID(),
      hostInstanceId: randomUUID(),
      clientDialects: ["tw-relay.v1", "tw-relay.v2"],
      capabilities: [...brokerCore.RELAY_V2_REQUIRED_CAPABILITIES],
      limits: {
        maxFrameBytes: 1_048_576,
        terminalMaxFrameBytes: 65_536,
      },
      ...overrides,
    },
  };
}

function relayV2Fixture(name) {
  return structuredClone(relayV2Corpus.goldenByName.get(name).frame);
}

function routeOpenedFrame(route) {
  return {
    carrierVersion: 1,
    type: "route.opened",
    requestId: route.requestId,
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
    payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
  };
}

function hostToClientFrame(route, seq, publicWire) {
  return {
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
  };
}

async function registerFakeHost(
  port,
  token = "twcap2.host-online",
  helloOverrides = {},
) {
  const connection = connectV2(port, { role: "host", token });
  await connection.opened;
  const hello = fakeHostHello(helloOverrides);
  connection.socket.send(carrierFrame(hello), { binary: false });
  const registered = decodeFrame(
    "carrier",
    await within(connection.nextMessage(), "host.registered"),
  );
  assert.equal(registered.type, "host.registered");
  await new Promise((resolve) => setImmediate(resolve));
  return { ...connection, hello, registered };
}

function reauthenticateFrame(connectorId, accessToken) {
  return {
    carrierVersion: 1,
    type: "host.reauthenticate",
    requestId: randomUUID(),
    connectorId,
    payload: { accessToken },
  };
}

test("relay server keeps detailed host state behind authentication", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0);

  const secret = "relay-health-test-secret";
  const child = spawn(process.execPath, [
    "dist/cli.cjs",
    "relay-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    env: { ...process.env, TW_RELAY_SECRET: secret },
    stdio: "ignore",
  });

  try {
    const deadline = Date.now() + 4000;
    let healthResponse;
    while (Date.now() < deadline) {
      try {
        healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
        if (healthResponse.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await healthResponse?.json(), { ok: true });

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/hosts`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`http://127.0.0.1:${port}/api/hosts`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { ok: true, hosts: [] });

    const disabledV2 = await fetch(
      `http://127.0.0.1:${port}/v2/enrollments/redeem`,
      { method: "POST", body: "{}" },
    );
    assert.equal(disabledV2.status, 404);
    assert.deepEqual(await disabledV2.json(), { ok: false, error: "not found" });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("public v2 HTTPS root claims one listener lifecycle and drains every terminal path", async () => {
  const countedComposition = (fake) => {
    let opens = 0;
    const open = fake.composition.openCredentialAuthority;
    return {
      composition: {
        ...fake.composition,
        async openCredentialAuthority(input) {
          opens += 1;
          return open.call(fake.composition, input);
        },
      },
      openCount: () => opens,
    };
  };

  const wrongProtocol = countedComposition(fakeComposition());
  await assert.rejects(
    startRelayV2BrokerPublicHttpsServer(
      createHttpServer(),
      { host: "127.0.0.1", port: 0 },
      wrongProtocol.composition,
    ),
    /node:https Server/,
  );
  assert.equal(wrongProtocol.openCount(), 0);

  const alreadyOwnedServer = createHttpsServer((_request, response) => response.end());
  const alreadyOwned = countedComposition(fakeComposition());
  await assert.rejects(
    startRelayV2BrokerPublicHttpsServer(
      alreadyOwnedServer,
      { host: "127.0.0.1", port: 0 },
      alreadyOwned.composition,
    ),
    /already has a listener owner/,
  );
  assert.equal(alreadyOwned.openCount(), 0);

  const explicitShutdownFake = fakeComposition();
  const explicitShutdown = countedComposition(explicitShutdownFake);
  const explicitShutdownServer = createHttpsServer();
  const explicitShutdownHandle = await startRelayV2BrokerPublicHttpsServer(
    explicitShutdownServer,
    { host: "127.0.0.1", port: 0 },
    explicitShutdown.composition,
  );
  const explicitShutdownAuthority = await explicitShutdownFake.opened.promise;
  assert.equal(explicitShutdown.openCount(), 1);
  assert.equal(explicitShutdownServer.listening, true);
  assert.equal(explicitShutdownServer.listenerCount("request"), 1);
  assert.equal(explicitShutdownServer.listenerCount("upgrade"), 1);
  await explicitShutdownHandle.shutdown();
  assert.equal(explicitShutdownAuthority.closed, true);
  assert.equal(explicitShutdownServer.listenerCount("request"), 0);
  assert.equal(explicitShutdownServer.listenerCount("upgrade"), 0);

  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const occupiedAddress = occupied.address();
  assert.ok(occupiedAddress !== null && typeof occupiedAddress === "object");
  const listenFailureFake = fakeComposition();
  const listenFailure = countedComposition(listenFailureFake);
  await assert.rejects(
    startRelayV2BrokerPublicHttpsServer(
      createHttpsServer(),
      { host: "127.0.0.1", port: occupiedAddress.port },
      listenFailure.composition,
    ),
    (error) => error?.code === "EADDRINUSE",
  );
  const listenFailureAuthority = await listenFailureFake.opened.promise;
  assert.equal(listenFailure.openCount(), 1);
  assert.equal(listenFailureAuthority.closed, true);
  await new Promise((resolve) => occupied.close(resolve));

  const externalCloseFake = fakeComposition();
  const externalClose = countedComposition(externalCloseFake);
  const externalCloseServer = createHttpsServer();
  const externalCloseHandle = await startRelayV2BrokerPublicHttpsServer(
    externalCloseServer,
    { host: "127.0.0.1", port: 0 },
    externalClose.composition,
  );
  const externalCloseAuthority = await externalCloseFake.opened.promise;
  await new Promise((resolve) => externalCloseServer.close(resolve));
  await externalCloseHandle.shutdown();
  assert.equal(externalClose.openCount(), 1);
  assert.equal(externalCloseAuthority.closed, true);
});

test("default relay listener keeps twcap2 credentials out of the v1 verifier", async () => {
  const token = "twcap2.same-as-configured-v1-secret";
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: token,
  });
  try {
    assert.equal(
      await rejectedUpgradeStatus(server.port, token, "tw-relay.v1"),
      401,
    );
  } finally {
    await server.shutdown();
  }

  const legacy = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "legacy-shared-secret",
  });
  try {
    for (const path of [
      "/client?secret=legacy-shared-secret&secret=twcap2.payload.mac",
      "/client?secret=legacy-shared-secret&se%63ret=%74wcap2%2Epayload%2Emac",
    ]) {
      assert.equal(
        await rejectedUpgradePathStatus(legacy.port, path, "tw-relay.v1"),
        401,
        path,
      );
    }
  } finally {
    await legacy.shutdown();
  }
});

test("opt-in v2 listener dispatches only five exact raw credential paths from a trusted socket source", async () => {
  const exposed = fakeComposition();
  await assert.rejects(
    startRelayBroker({
      host: "0.0.0.0",
      port: 0,
      secret: "must-not-listen",
    }, exposed.composition),
    /isolated random-port loopback listener/,
  );

  const fake = fakeComposition();
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, fake.composition);
  const authority = await fake.opened.promise;
  try {
    for (const route of CREDENTIAL_ROUTES) {
      const response = await postJson(
        server.port,
        route.path,
        route.body,
        route.authorization,
      );
      assert.equal(response.status, 200, `${route.endpoint}: ${response.body}`);
    }
    assert.deepEqual(
      authority.calls.map(({ endpoint }) => endpoint),
      CREDENTIAL_ROUTES.map(({ endpoint }) => endpoint),
    );
    assert.equal(authority.receipts.size, 0);
    for (const call of authority.calls) {
      assert.equal(call.sourceKey.startsWith("trusted-listener:127.0.0.1"), true);
      assert.equal(call.sourceKey.includes("203.0.113.77"), false);
    }

    const callCount = authority.calls.length;
    const variants = [
      "/v2/hosts/bootstrap?retry=1",
      "/v2/enrollments/redeem/",
      "/v2/tokens/%72efresh",
      "/v2/hosts/tokens/../tokens/refresh",
      "/v2/unknown",
    ];
    for (const path of variants) {
      const response = await postJson(server.port, path, {}, undefined);
      assert.equal(response.status, 404, `${path}: ${response.body}`);
    }
    assert.equal(authority.calls.length, callCount);
    assert.equal(authority.receipts.size, 0);
  } finally {
    await server.shutdown();
  }
  assert.equal(authority.closed, true);
});

test("v2 transport actor preserves host frame FIFO and rejects binary JSON before core mutation", async () => {
  const fake = fakeComposition({ blockFirstAuthControl: true });
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, fake.composition);
  const authority = await fake.opened.promise;
  try {
    const host = await registerFakeHost(server.port);
    const first = reauthenticateFrame(host.registered.connectorId, "twcap2.first-control.mac");
    const second = reauthenticateFrame(host.registered.connectorId, "twcap2.second-control.mac");
    host.socket.send(carrierFrame(first), { binary: false });
    const closeSignal = new Promise((resolve) => host.socket.once("close", (code, reason) => resolve({ kind: "close", code, reason: reason.toString() })));
    const errorSignal = new Promise((resolve) => host.socket.once("error", (error) => resolve({ kind: "error", message: error.message })));
    const outcome = await within(Promise.race([
      authority.authControlEntered.promise.then(() => ({ kind: "auth" })),
      closeSignal,
      errorSignal,
    ]), "first auth control admission");
    assert.equal(outcome.kind, "auth", `first host frame outcome: ${JSON.stringify(outcome)}`);
    host.socket.send(carrierFrame(second), { binary: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(authority.authControlEvents, ["start:twcap2.first-control.mac"]);

    authority.authControlRelease.resolve();
    const firstError = decodeFrame(
      "carrier",
      await within(host.nextMessage(), "first carrier.error"),
    );
    const secondError = decodeFrame(
      "carrier",
      await within(host.nextMessage(), "second carrier.error"),
    );
    assert.deepEqual(
      [firstError.requestId, secondError.requestId],
      [first.requestId, second.requestId],
    );
    assert.deepEqual(authority.authControlEvents, [
      "start:twcap2.first-control.mac",
      "finish:twcap2.first-control.mac",
      "start:twcap2.second-control.mac",
      "finish:twcap2.second-control.mac",
    ]);
    const hostClosed = closeCode(host.socket);
    host.socket.close();
    await hostClosed;

    const binary = await registerFakeHost(server.port, "twcap2.binary");
    const binaryCalls = authority.authControlEvents.length;
    const binaryClosed = closeCode(binary.socket);
    binary.socket.send(Buffer.from(carrierFrame(reauthenticateFrame(binary.registered.connectorId, "twcap2.binary-first.mac"))), { binary: true });
    try { binary.socket.send(carrierFrame(reauthenticateFrame(binary.registered.connectorId, "twcap2.binary-after.mac")), { binary: false }); } catch {}
    assert.equal(await within(binaryClosed, "binary close"), 4400);
    assert.equal(binary.messageCount(), 0);
    assert.equal(authority.authControlEvents.length, binaryCalls);
  } finally {
    await server.shutdown();
    await assertPortClosed(server.port);
  }
});

test("opt-in listener wires optional Agent readiness into the canonical v2 owner", async () => {
  const agentCapability = agentCodec.RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY;
  const baseCapabilities = [...brokerCore.RELAY_V2_REQUIRED_CAPABILITIES];
  const claimedCapabilities = [...baseCapabilities, agentCapability];
  const fake = fakeComposition();
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, fake.composition);
  const authority = await fake.opened.promise;
  try {
    const host = await registerFakeHost(server.port, undefined, {
      capabilities: claimedCapabilities,
    });
    const client = connectV2(server.port, { role: "client", token: "twcap2.client-route" });
    const route = decodeFrame(
      "carrier",
      await within(host.nextMessage(), "route.open"),
    );
    assert.equal(route.type, "route.open");
    host.socket.send(carrierFrame(routeOpenedFrame(route)), { binary: false });

    await client.opened;
    const welcome = decodeFrame(
      "public",
      await within(client.nextMessage(), "relay.welcome"),
    );
    assert.equal(welcome.type, "relay.welcome");
    assert.equal(welcome.payload.connectionId, route.payload.connectionId);
    assert.equal(welcome.payload.principalId, "client-principal");
    assert.deepEqual(
      welcome.payload.capabilities,
      baseCapabilities,
      "Host hello alone cannot enable the default-off Agent capability",
    );

    const hello = relayV2Fixture("client-hello-fresh");
    hello.requestId = randomUUID();
    hello.hostId = "host-one";
    hello.payload.clientInstanceId = "client-instance";
    hello.payload.capabilities = baseCapabilities;
    hello.payload.requiredCapabilities = baseCapabilities;
    client.socket.send(Buffer.from(
      relayV2Codec.encodeRelayV2WebSocketFrame("public", hello),
    ).toString("utf8"), { binary: false });

    const routedHello = decodeFrame(
      "carrier",
      await within(host.nextMessage(), "client.hello route.data"),
    );
    assert.equal(routedHello.type, "route.data");
    assert.equal(routedHello.direction, "client_to_host");
    const observedHello = relayV2Codec.decodeRelayV2WebSocketFrame(
      "public",
      Buffer.from(routedHello.payload.data, "base64"),
    ).frame;
    assert.equal(observedHello.type, "client.hello");
    assert.equal(observedHello.requestId, hello.requestId);

    const hostWelcome = relayV2Fixture("host-welcome-snapshot-required");
    hostWelcome.requestId = hello.requestId;
    hostWelcome.hostId = "host-one";
    hostWelcome.hostEpoch = host.hello.payload.hostEpoch;
    hostWelcome.hostInstanceId = host.hello.payload.hostInstanceId;
    hostWelcome.payload.capabilities = baseCapabilities;
    const hostWelcomeWire = relayV2Codec.encodeRelayV2WebSocketFrame(
      "public",
      hostWelcome,
    );
    host.socket.send(carrierFrame(hostToClientFrame(route, "1", hostWelcomeWire)), {
      binary: false,
    });
    const observedWelcome = decodeFrame(
      "public",
      await within(client.nextMessage(), "host.welcome"),
    );
    assert.equal(observedWelcome.type, "host.welcome");
    assert.equal(observedWelcome.requestId, hello.requestId);

    const hostClosed = closeCode(host.socket);
    const clientClosed = closeCode(client.socket);
    host.socket.close();
    client.socket.close();
    await Promise.all([hostClosed, clientClosed]);
  } finally {
    await server.shutdown();
  }
  assert.equal(authority.closed, true);

  const malformed = fakeComposition();
  let malformedGetterReads = 0;
  Object.defineProperty(
    malformed.composition,
    "agentTranscriptLifecycleReadiness",
    {
      enumerable: true,
      get() {
        malformedGetterReads += 1;
        return fakeAgentReadiness().receipt;
      },
    },
  );
  await assert.rejects(
    startRelayBroker({
      host: "127.0.0.1",
      port: 0,
      secret: "isolated-v1-secret",
    }, malformed.composition),
    /optional capability readiness is invalid/,
  );
  assert.equal(malformedGetterReads, 0);

  const synchronousReadiness = fakeAgentReadiness({ synchronousLoss: true });
  const synchronous = fakeComposition({ agentReadiness: synchronousReadiness });
  const synchronousServer = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, synchronous.composition);
  const synchronousAuthority = await synchronous.opened.promise;
  assert.equal(synchronousReadiness.subscriptionCount(), 0);
  assert.equal(synchronousReadiness.cancelCalls(), 1);
  assert.equal(synchronousAuthority.closed, false);
  await synchronousServer.shutdown();
  assert.equal(synchronousReadiness.cancelCalls(), 1);
  assert.equal(synchronousAuthority.closed, true);

  const readiness = fakeAgentReadiness();
  const enabled = fakeComposition({ agentReadiness: readiness });
  const enabledServer = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, enabled.composition);
  const enabledAuthority = await enabled.opened.promise;
  try {
    const host = await registerFakeHost(enabledServer.port, undefined, {
      capabilities: claimedCapabilities,
    });
    assert.equal(readiness.subscriptionCount(), 1);

    const client = connectV2(enabledServer.port, {
      role: "client",
      token: "twcap2.client-agent-route",
    });
    const route = decodeFrame(
      "carrier",
      await within(host.nextMessage(), "optional route.open"),
    );
    host.socket.send(carrierFrame(routeOpenedFrame(route)), { binary: false });

    await client.opened;
    const relayWelcome = decodeFrame(
      "public",
      await within(client.nextMessage(), "optional relay.welcome"),
    );
    assert.deepEqual(relayWelcome.payload.capabilities, claimedCapabilities);

    const hello = relayV2Fixture("client-hello-fresh");
    hello.requestId = randomUUID();
    hello.hostId = "host-one";
    hello.payload.clientInstanceId = "client-instance";
    hello.payload.capabilities = claimedCapabilities;
    hello.payload.requiredCapabilities = baseCapabilities;
    client.socket.send(Buffer.from(
      relayV2Codec.encodeRelayV2WebSocketFrame("public", hello),
    ).toString("utf8"), { binary: false });

    const routedHello = decodeFrame(
      "carrier",
      await within(host.nextMessage(), "optional client.hello route.data"),
    );
    const observedHello = relayV2Codec.decodeRelayV2WebSocketFrame(
      "public",
      Buffer.from(routedHello.payload.data, "base64"),
    ).frame;
    const hostWelcome = relayV2Fixture("host-welcome-snapshot-required");
    hostWelcome.requestId = observedHello.requestId;
    hostWelcome.hostId = "host-one";
    hostWelcome.hostEpoch = host.hello.payload.hostEpoch;
    hostWelcome.hostInstanceId = host.hello.payload.hostInstanceId;
    hostWelcome.payload.capabilities = claimedCapabilities;
    host.socket.send(carrierFrame(hostToClientFrame(
      route,
      "1",
      relayV2Codec.encodeRelayV2WebSocketFrame("public", hostWelcome),
    )), { binary: false });
    const observedWelcome = decodeFrame(
      "public",
      await within(client.nextMessage(), "optional host.welcome"),
    );
    assert.deepEqual(observedWelcome.payload.capabilities, claimedCapabilities);

    readiness.lose();
    assert.equal(enabledAuthority.closed, false);
    assert.equal(readiness.subscriptionCount(), 1);

    const agentRequest = {
      protocolVersion: 2,
      kind: "request",
      type: "agent.timeline.status.get",
      requestId: "agent-after-production-loss",
      hostId: "host-one",
      expectedHostEpoch: host.hello.payload.hostEpoch,
      scopeId: "scope-local",
      sessionId: "session-opaque",
      payload: {},
    };
    client.socket.send(Buffer.from(
      agentCodec.encodeRelayAgentTranscriptLifecycleFrame(agentRequest),
    ).toString("utf8"), { binary: false });
    const unavailable = agentCodec.decodeRelayAgentTranscriptLifecycleFrame(
      (await within(client.nextMessage(), "withdrawn Agent error")).data,
    ).frame;
    assert.equal(unavailable.requestId, agentRequest.requestId);
    assert.equal(unavailable.error.code, "AGENT_TIMELINE_UNAVAILABLE");
    assert.equal(unavailable.error.retryable, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.messageCount(), 0);

    const baseAfterLoss = relayV2Codec.encodeRelayV2WebSocketFrame("public", {
      protocolVersion: 2,
      kind: "event",
      type: "terminal.input_ack",
      streamId: "base-after-production-agent-loss",
      payload: { generation: "generation-1", ackedThroughInputSeq: "0" },
    });
    host.socket.send(carrierFrame(hostToClientFrame(route, "2", baseAfterLoss)), {
      binary: false,
    });
    const observedBaseAfterLoss = decodeFrame(
      "public",
      await within(client.nextMessage(), "base frame after Agent loss"),
    );
    assert.equal(observedBaseAfterLoss.type, "terminal.input_ack");
    assert.equal(observedBaseAfterLoss.streamId, "base-after-production-agent-loss");

    const hostClosed = closeCode(host.socket);
    const clientClosed = closeCode(client.socket);
    host.socket.close();
    client.socket.close();
    await Promise.all([hostClosed, clientClosed]);
  } finally {
    await enabledServer.shutdown();
  }
  assert.equal(enabledAuthority.closed, true);
  assert.equal(readiness.subscriptionCount(), 0);
  assert.equal(readiness.cancelCalls(), 1);
});

test("v2 authority withdrawal fences admission and closes exact live sockets with bounded policy", async () => {
  const fake = fakeComposition({ recordDeadlines: true });
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, fake.composition);
  const authority = await fake.opened.promise;
  try {
    const expired = await openWebSocket(server.port, "twcap2.expired");
    const expiredClosed = closeCode(expired);
    const expiry = authority.fence.begin({
      reason: "access_expired",
      role: "host",
      hostId: "host-one",
      jti: "jti-expired",
    });

    const late = upgradeAttempt(server.port, {
      role: "host",
      token: "twcap2.expired",
    });
    assert.deepEqual(await late.outcome, { outcome: "reject", status: 401 });
    expiry.committed({
      authorizationRevision: "2",
      authorizationFence: "authorization-fence-two",
    });
    assert.equal(await expiredClosed, 4401);

    const revoked = await openWebSocket(server.port, "twcap2.revoked");
    const revokedClosed = closeCode(revoked);
    const revocation = authority.fence.begin({
      reason: "grant_revoked",
      role: "host",
      hostId: "host-one",
      grantId: "grant-revoked",
    });
    revocation.committed({
      authorizationRevision: "3",
      authorizationFence: "authorization-fence-three",
    });
    assert.equal(await revokedClosed, 4403);

    const unavailable = await openWebSocket(server.port, "twcap2.authority-loss");
    const unavailableClosed = closeCode(unavailable);
    authority.fence.failClosed();
    assert.equal(await unavailableClosed, 1013);
    assert.deepEqual(fake.schedulerDelays, [5_000, 5_000, 5_000]);
  } finally {
    await server.shutdown();
  }
});

test("shutdown seals the Upgrade verifier barrier before closing authority", async () => {
  const fake = fakeComposition({ blockAuthorization: true });
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, fake.composition);
  const authority = await fake.opened.promise;
  const attempt = upgradeAttempt(server.port, {
    role: "host",
    token: "twcap2.delayed-verifier",
  });
  await authority.authorizeEntered.promise;

  let shutdownSettled = false;
  const shutdown = server.shutdown().then(() => { shutdownSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);
  assert.equal(authority.closed, false);
  assert.equal(authority.activeAuthorizations, 1);

  authority.authorizeRelease.resolve();
  assert.deepEqual(await attempt.outcome, { outcome: "reject", status: 503 });
  await shutdown;
  assert.equal(authority.activeAuthorizations, 0);
  assert.equal(authority.closed, true);
});

test("shutdown seals frame admission and drains invalid-source bodies without a late task", async () => {
  const framed = fakeComposition({ blockFirstAuthControl: true, rejectFirstAuthControl: true });
  const framedServer = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, framed.composition);
  const framedAuthority = await framed.opened.promise;
  const host = await registerFakeHost(framedServer.port, "twcap2.shutdown-frame");
  host.socket.send(carrierFrame(reauthenticateFrame(
    host.registered.connectorId,
    "twcap2.before-shutdown.mac",
  )), { binary: false });
  await framedAuthority.authControlEntered.promise;
  const closed = closeCode(host.socket);
  host.socket.close();
  await within(closed, "host close processing");
  const framedShutdown = framedServer.shutdown();
  try {
    host.socket.send(carrierFrame(reauthenticateFrame(
      host.registered.connectorId,
      "twcap2.after-shutdown.mac",
    )), { binary: false });
  } catch {}
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    framedAuthority.authControlEvents,
    ["start:twcap2.before-shutdown.mac"],
  );
  assert.equal(framedAuthority.closed, false);
  framedAuthority.authControlRelease.resolve();
  await framedShutdown;
  assert.equal(
    framedAuthority.authControlEvents.some((event) => event.includes("after-shutdown")),
    false,
  );
  assert.equal(framedAuthority.closed, true);

  const invalid = fakeComposition({ invalidSource: true });
  const invalidServer = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, invalid.composition);
  const invalidAuthority = await invalid.opened.promise;
  const responseSeen = deferred();
  const partial = nodeHttpRequest({
    host: "127.0.0.1",
    port: invalidServer.port,
    method: "POST",
    path: "/v2/tokens/refresh",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Length": "4096",
    },
  }, (response) => {
    response.resume();
    responseSeen.resolve(response.statusCode);
  });
  partial.once("error", () => undefined);
  partial.write("{");
  assert.equal(await responseSeen.promise, 503);
  await invalidServer.shutdown();
  assert.equal(invalidAuthority.calls.length, 0);
  assert.equal(invalidAuthority.closed, true);
});

test("shutdown waits for the active v2 request body, authority handler, and response barrier", async () => {
  const fake = fakeComposition();
  const server = await startRelayBroker({
    host: "127.0.0.1",
    port: 0,
    secret: "isolated-v1-secret",
  }, fake.composition);
  const authority = await fake.opened.promise;
  authority.blockedEndpoint = "client_refresh";
  const route = CREDENTIAL_ROUTES.find(({ endpoint }) => endpoint === "client_refresh");
  const response = postJson(server.port, route.path, route.body, undefined);
  await authority.blockEntered.promise;

  let shutdownSettled = false;
  const shutdown = server.shutdown().then(() => { shutdownSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);
  assert.equal(authority.closed, false);
  assert.equal(authority.activeHandlers, 1);

  authority.blockRelease.resolve();
  assert.equal((await response).status, 200);
  await shutdown;
  assert.equal(authority.activeHandlers, 0);
  assert.equal(authority.closed, true);
});
