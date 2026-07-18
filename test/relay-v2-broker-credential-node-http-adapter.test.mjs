import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  Agent as HttpAgent,
  createServer,
  request as nodeHttpRequest,
} from "node:http";
import test from "node:test";

const adapter = await import("../dist/relay/v2/brokerCredentialNodeHttpAdapter.js");
const bootstrapIngress = await import("../dist/relay/v2/brokerHostBootstrapHttpIngress.js");
const credentialIngress = await import("../dist/relay/v2/brokerCredentialHttpIngress.js");

const NOW_MS = 1_800_000_000_000;
const ACCESS_TOKEN = "twcap2.payload.mac";
const REFRESH_TOKEN = "twref2.original-refresh";
const CLIENT_CONTEXT = Object.freeze({
  scheme: "twcap2",
  role: "client",
  hostId: "host-one",
  principalId: "client-principal",
  grantId: "client-grant",
  clientInstanceId: "client-instance",
  jti: "client-jti",
  kid: "issuer-kid",
  expiresAtMs: NOW_MS + 3_600_000,
  authorizationRevision: "1",
  authorizationFence: "authorization-fence",
});

const CLIENT_GRANT_BODY = Object.freeze({
  principalId: "client-principal",
  grantId: "client-grant",
  hostId: "host-one",
  relayUrl: "wss://relay.example.com/client",
  accessToken: ACCESS_TOKEN,
  accessExpiresAtMs: NOW_MS + 3_600_000,
  refreshToken: "twref2.next-refresh",
  refreshExpiresAtMs: NOW_MS + 86_400_000,
});
const HOST_GRANT_BODY = Object.freeze({
  principalId: "host-principal",
  grantId: "host-grant",
  hostId: "host-one",
  accessToken: ACCESS_TOKEN,
  accessExpiresAtMs: NOW_MS + 3_600_000,
  refreshToken: "twref2.next-host-refresh",
  refreshExpiresAtMs: NOW_MS + 86_400_000,
});

const ROUTES = Object.freeze({
  host_bootstrap: Object.freeze({
    path: bootstrapIngress.RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH,
    body: Object.freeze({
      bootstrapAttemptId: "bootstrap-attempt",
      bootstrapToken: "twhostboot2.bootstrap-secret",
      hostId: "host-one",
      hostEpoch: "host-epoch",
      hostInstanceId: "host-instance",
    }),
    response: Object.freeze({
      bootstrapAttemptId: "bootstrap-attempt",
      principalId: "host-principal",
      grantId: "host-grant",
      hostId: "host-one",
      accessToken: ACCESS_TOKEN,
      accessExpiresAtMs: NOW_MS + 3_600_000,
      refreshToken: "twref2.host-refresh",
      refreshExpiresAtMs: NOW_MS + 86_400_000,
    }),
  }),
  enrollment_redeem: Object.freeze({
    path: credentialIngress.RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH,
    body: Object.freeze({
      exchangeAttemptId: "exchange-attempt",
      enrollmentId: "enrollment-one",
      enrollmentCode: "twenroll2.enrollment-code",
      clientInstanceId: "client-instance",
      deviceLabel: "Pixel",
    }),
    response: Object.freeze({ exchangeAttemptId: "exchange-attempt", ...CLIENT_GRANT_BODY }),
  }),
  client_refresh: Object.freeze({
    path: credentialIngress.RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
    body: Object.freeze({
      refreshAttemptId: "client-refresh-attempt",
      grantId: "client-grant",
      clientInstanceId: "client-instance",
      refreshToken: REFRESH_TOKEN,
    }),
    response: Object.freeze({ refreshAttemptId: "client-refresh-attempt", ...CLIENT_GRANT_BODY }),
  }),
  host_refresh: Object.freeze({
    path: credentialIngress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
    body: Object.freeze({
      refreshAttemptId: "host-refresh-attempt",
      grantId: "host-grant",
      hostInstanceId: "host-instance",
      refreshToken: REFRESH_TOKEN,
    }),
    response: Object.freeze({ refreshAttemptId: "host-refresh-attempt", ...HOST_GRANT_BODY }),
  }),
  self_revoke: Object.freeze({
    path: credentialIngress.RELAY_V2_BROKER_SELF_REVOKE_PATH,
    body: Object.freeze({ reason: "user_revoked" }),
    response: Object.freeze({
      grantId: "client-grant",
      revokedAtMs: NOW_MS,
      alreadyRevoked: false,
    }),
  }),
});

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function rawHeadersFor(bytes, options = {}) {
  const headers = [
    "Content-Type", "application/json",
    "Cache-Control", "no-store",
  ];
  if (options.contentLength !== null) {
    headers.push("Content-Length", options.contentLength ?? String(bytes.byteLength));
  }
  if (options.authorization !== null && options.authorization !== undefined) {
    headers.push("Authorization", options.authorization);
  }
  if (options.extraHeaders) headers.push(...options.extraHeaders);
  return headers;
}

class SyntheticRequest extends EventEmitter {
  constructor(options) {
    super();
    this.method = options.method ?? "POST";
    this.url = options.url;
    this.rawHeaders = options.rawHeaders;
    this.headers = options.headers ?? {};
    this.chunks = options.chunks ?? [];
    this.errorAt = options.errorAt ?? null;
    this.abortAt = options.abortAt ?? null;
    this.completeOnDone = options.completeOnDone ?? true;
    this.abortedOnDone = options.abortedOnDone ?? false;
    this.resumeSettleEvent = options.resumeSettleEvent ?? null;
    this.iteratorCalls = 0;
    this.nextCalls = 0;
    this.returnCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.destroyCalls = 0;
    this.destroyed = false;
    this.aborted = false;
    this.readableEnded = false;
    this.complete = false;
    this.socketReads = 0;
    this.operations = options.operations ?? [];
    Object.defineProperty(this, "socket", {
      configurable: true,
      get: () => {
        this.socketReads += 1;
        throw new Error("socket source must not be inspected");
      },
    });
  }

  [Symbol.asyncIterator]() {
    this.iteratorCalls += 1;
    let index = 0;
    return {
      next: async () => {
        this.nextCalls += 1;
        if (this.abortAt === this.nextCalls) {
          this.aborted = true;
          throw new Error(`aborted with ${ACCESS_TOKEN}`);
        }
        if (this.errorAt === this.nextCalls) {
          throw new Error(`read failed with ${REFRESH_TOKEN}`);
        }
        if (index >= this.chunks.length) {
          this.readableEnded = true;
          this.complete = this.completeOnDone;
          this.aborted = this.abortedOnDone;
          return { done: true, value: undefined };
        }
        return { done: false, value: this.chunks[index++] };
      },
      return: async () => {
        this.returnCalls += 1;
        return { done: true, value: undefined };
      },
    };
  }

  resume() {
    this.resumeCalls += 1;
    this.operations.push("request:resume");
    if (this.resumeSettleEvent === "end") {
      this.readableEnded = true;
      this.complete = true;
      this.emit("end");
    } else if (this.resumeSettleEvent === "close") {
      this.destroyed = true;
      this.emit("close");
    } else if (this.resumeSettleEvent === "error") {
      this.emit("error", new Error(`drain failed with ${REFRESH_TOKEN}`));
    }
    return this;
  }

  pause() {
    this.pauseCalls += 1;
    this.operations.push("request:pause");
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.operations.push("request:destroy");
    this.destroyed = true;
    return this;
  }
}

class SyntheticResponse extends EventEmitter {
  constructor(failure = null, operations = []) {
    super();
    this.failure = failure;
    this.operations = operations;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.writeHeadCalls = [];
    this.endCalls = [];
  }

  writeHead(status, headers) {
    this.operations.push("response:writeHead");
    this.writeHeadCalls.push({ status, headers: { ...headers } });
    if (this.failure === "writeHead") {
      throw new Error(`writeHead failed with ${ACCESS_TOKEN}`);
    }
    this.headersSent = true;
    if (this.failure === "writeHeadEvent") {
      this.emit("error", new Error(`writeHead event with ${REFRESH_TOKEN}`));
    }
    return this;
  }

  end(body) {
    this.operations.push("response:end");
    this.endCalls.push(Buffer.from(body));
    if (this.failure === "end") throw new Error(`end failed with ${REFRESH_TOKEN}`);
    if (this.failure === "close") {
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
      return this;
    }
    if (this.failure === "error") {
      queueMicrotask(() => this.emit("error", new Error(`write failed with ${ACCESS_TOKEN}`)));
      return this;
    }
    this.writableEnded = true;
    queueMicrotask(() => this.emit("finish"));
    return this;
  }
}

class RecordingAuthority {
  constructor() {
    this.events = [];
    this.receipts = new Map();
    this.inputs = [];
  }

  async admitHttpSource(input) {
    this.events.push(`admit:${input.endpoint}`);
    const receipt = Object.freeze(() => undefined);
    this.receipts.set(receipt, { ...input });
    return receipt;
  }

  take(receipt, endpoint, sourceKey) {
    const value = this.receipts.get(receipt);
    assert.deepEqual(value, { endpoint, sourceKey });
    this.receipts.delete(receipt);
  }

  releaseHttpSourceAdmission(receipt, endpoint, sourceKey) {
    this.events.push(`release:${endpoint}`);
    this.take(receipt, endpoint, sourceKey);
  }

  async authorizeAccessToken(token, role) {
    this.events.push("authorize");
    assert.equal(token, ACCESS_TOKEN);
    assert.equal(role, "client");
    return CLIENT_CONTEXT;
  }

  async bootstrapHost(receipt, sourceKey, input) {
    this.events.push("invoke:host_bootstrap");
    this.take(receipt, "host_bootstrap", sourceKey);
    this.inputs.push({ endpoint: "host_bootstrap", sourceKey, input: structuredClone(input) });
    return { endpoint: "host_bootstrap", body: ROUTES.host_bootstrap.response, replayed: false };
  }

  async redeemEnrollment(receipt, sourceKey, input) {
    this.events.push("invoke:enrollment_redeem");
    this.take(receipt, "enrollment_redeem", sourceKey);
    this.inputs.push({ endpoint: "enrollment_redeem", sourceKey, input: structuredClone(input) });
    return { endpoint: "enrollment_redeem", body: ROUTES.enrollment_redeem.response, replayed: false };
  }

  async refreshClientGrantFromHttp(receipt, sourceKey, input) {
    this.events.push("invoke:client_refresh");
    this.take(receipt, "client_refresh", sourceKey);
    this.inputs.push({ endpoint: "client_refresh", sourceKey, input: structuredClone(input) });
    return { endpoint: "client_refresh", body: ROUTES.client_refresh.response, replayed: false };
  }

  async refreshHostGrantFromHttp(receipt, sourceKey, input) {
    this.events.push("invoke:host_refresh");
    this.take(receipt, "host_refresh", sourceKey);
    this.inputs.push({ endpoint: "host_refresh", sourceKey, input: structuredClone(input) });
    return { endpoint: "host_refresh", body: ROUTES.host_refresh.response, replayed: false };
  }

  async selfRevokeGrantFromHttp(receipt, sourceKey, context, input) {
    this.events.push("invoke:self_revoke");
    this.take(receipt, "self_revoke", sourceKey);
    this.inputs.push({
      endpoint: "self_revoke",
      sourceKey,
      context: structuredClone(context),
      input: structuredClone(input),
    });
    return ROUTES.self_revoke.response;
  }
}

function requestFor(route, options = {}) {
  const bytes = options.bytes ?? jsonBytes(route.body);
  return new SyntheticRequest({
    method: options.method,
    url: options.url ?? route.path,
    rawHeaders: options.rawHeaders ?? rawHeadersFor(bytes, {
      contentLength: options.contentLength,
      authorization: options.authorization ?? (
        route === ROUTES.self_revoke ? `Bearer ${ACCESS_TOKEN}` : null
      ),
      extraHeaders: options.extraHeaders,
    }),
    headers: options.headers,
    chunks: options.chunks ?? [bytes],
    errorAt: options.errorAt,
    abortAt: options.abortAt,
    completeOnDone: options.completeOnDone,
    abortedOnDone: options.abortedOnDone,
    resumeSettleEvent: options.resumeSettleEvent,
    operations: options.operations,
  });
}

async function handle(authority, sourceKey, request, response = new SyntheticResponse()) {
  await adapter.handleRelayV2BrokerCredentialNodeHttpRequest(
    authority,
    sourceKey,
    request,
    response,
  );
  return response;
}

function assertExactWrite(response, status, body) {
  assert.equal(response.writeHeadCalls.length, 1);
  assert.deepEqual(response.writeHeadCalls[0], {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
  assert.equal(response.endCalls.length, 1);
  assert.deepEqual(response.endCalls[0], jsonBytes(body));
}

test("the raw request-target dispatches each frozen endpoint exactly once", async (t) => {
  for (const [endpoint, route] of Object.entries(ROUTES)) {
    await t.test(endpoint, async () => {
      const bytes = jsonBytes(route.body);
      const first = Math.max(1, Math.floor(bytes.byteLength / 3));
      const second = Math.max(first + 1, Math.floor(bytes.byteLength * 2 / 3));
      const request = requestFor(route, {
        chunks: [bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)],
      });
      const authority = new RecordingAuthority();
      const response = await handle(authority, `trusted-${endpoint}`, request);

      assertExactWrite(response, 200, route.response);
      assert.equal(authority.inputs.length, 1);
      assert.equal(authority.inputs[0].endpoint, endpoint);
      assert.equal(authority.inputs[0].sourceKey, `trusted-${endpoint}`);
      assert.deepEqual(authority.inputs[0].input, route.body);
      assert.equal(authority.receipts.size, 0);
      assert.equal(request.iteratorCalls, 1);
      assert.equal(request.nextCalls, 4);
      assert.equal(request.resumeCalls, 0);
      assert.equal(request.destroyCalls, 0);
    });
  }
});

test("unknown, query, slash, and encoded raw targets never normalize into a route", async (t) => {
  const targets = [
    ...Object.values(ROUTES).map((route) => `${route.path}?source=spoofed`),
    `${ROUTES.client_refresh.path}/`,
    "/v2/%65nrollments/redeem",
    "/v2/enrollments/../enrollments/redeem",
    "/v2/unknown",
  ];
  for (const rawTarget of targets) {
    await t.test(rawTarget, async () => {
      const authority = new RecordingAuthority();
      const request = requestFor(ROUTES.client_refresh, { url: rawTarget });
      const response = await handle(authority, "trusted-source", request);
      assert.equal(response.writeHeadCalls[0].status, 404);
      assert.equal(JSON.parse(response.endCalls[0]).error.code, "INVALID_ENVELOPE");
      assert.equal(response.writeHeadCalls.length, 1);
      assert.equal(response.endCalls.length, 1);
      assert.deepEqual(authority.events, []);
      assert.equal(request.iteratorCalls, 0);
      assert.equal(request.resumeCalls, 1);
      assert.equal(request.destroyCalls, 0);
    });
  }
});

test("rawHeaders preserve duplicate fields instead of trusting normalized headers", async (t) => {
  await t.test("duplicate Authorization", async () => {
    const route = ROUTES.self_revoke;
    const bytes = jsonBytes(route.body);
    const request = requestFor(route, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      rawHeaders: [
        "Content-Type", "application/json",
        "Authorization", `Bearer ${ACCESS_TOKEN}`,
        "Cache-Control", "no-store",
        "authorization", `Bearer ${ACCESS_TOKEN}`,
        "Content-Length", String(bytes.byteLength),
      ],
    });
    const authority = new RecordingAuthority();
    const response = await handle(authority, "trusted-source", request);
    assert.equal(response.writeHeadCalls[0].status, 401);
    assert.equal(JSON.parse(response.endCalls[0]).error.code, "AUTH_INVALID");
    assert.deepEqual(authority.events, ["admit:self_revoke", "release:self_revoke"]);
    assert.equal(request.iteratorCalls, 0);
    assert.equal(request.resumeCalls, 1);
  });

  await t.test("ordered duplicate Content-Length", async () => {
    const route = ROUTES.client_refresh;
    const bytes = jsonBytes(route.body);
    const request = requestFor(route, {
      headers: { "content-length": String(bytes.byteLength) },
      rawHeaders: [
        "Content-Length", String(bytes.byteLength),
        "Forwarded", "for=spoofed",
        "content-length", String(bytes.byteLength),
        "Content-Type", "application/json",
        "Cache-Control", "no-store",
      ],
    });
    const authority = new RecordingAuthority();
    const response = await handle(authority, "trusted-source", request);
    assert.equal(response.writeHeadCalls[0].status, 400);
    assert.deepEqual(authority.events, []);
    assert.equal(request.iteratorCalls, 0);
  });
});

test("sourceKey comes only from the trusted call argument", async () => {
  const route = ROUTES.self_revoke;
  const request = requestFor(route, {
    headers: {
      forwarded: "for=normalized-spoof",
      "x-forwarded-for": "normalized-xff-spoof",
    },
    extraHeaders: [
      "Forwarded", "for=raw-spoof",
      "X-Forwarded-For", "raw-xff-spoof",
    ],
  });
  const authority = new RecordingAuthority();
  const response = await handle(authority, "trusted-composition-source", request);
  assert.equal(response.writeHeadCalls[0].status, 200);
  assert.equal(authority.inputs[0].sourceKey, "trusted-composition-source");
  assert.equal(request.socketReads, 0);
});

test("the streaming body enforces length, abort, error, and the 16 KiB hard limit", async (t) => {
  await t.test("declared oversize rejects before body iteration", async () => {
    for (const settleEvent of ["end", "close", "error"]) {
      const operations = [];
      const request = requestFor(ROUTES.client_refresh, {
        contentLength: "16385",
        operations,
        resumeSettleEvent: settleEvent,
      });
      const authority = new RecordingAuthority();
      const response = new SyntheticResponse(null, operations);
      await handle(authority, "trusted-source", request, response);
      assert.equal(response.writeHeadCalls[0].status, 413, settleEvent);
      assert.equal(response.writeHeadCalls[0].headers.Connection, "close", settleEvent);
      assert.deepEqual(authority.events, [], settleEvent);
      assert.equal(request.iteratorCalls, 0, settleEvent);
      assert.equal(request.nextCalls, 0, settleEvent);
      assert.equal(request.pauseCalls, 1, settleEvent);
      assert.equal(request.resumeCalls, 1, settleEvent);
      assert.equal(request.destroyCalls, 0, settleEvent);
      assert.equal(request.listenerCount("end"), 0, settleEvent);
      assert.equal(request.listenerCount("close"), 0, settleEvent);
      assert.equal(request.listenerCount("error"), 0, settleEvent);
      assert.deepEqual(operations, [
        "request:pause",
        "response:writeHead",
        "response:end",
        "request:resume",
      ], settleEvent);
    }
  });

  await t.test("exactly 16384 bytes is admitted to strict decode", async () => {
    const bytes = new Uint8Array(16_384);
    const request = requestFor(ROUTES.client_refresh, {
      bytes,
      chunks: [bytes],
      contentLength: "16384",
    });
    const authority = new RecordingAuthority();
    const response = await handle(authority, "trusted-source", request);
    assert.equal(response.writeHeadCalls[0].status, 400);
    assert.deepEqual(authority.events, ["admit:client_refresh", "release:client_refresh"]);
    assert.equal(request.nextCalls, 2);
    assert.equal(request.destroyCalls, 0);
  });

  const validBytes = jsonBytes(ROUTES.client_refresh.body);
  for (const item of [
    {
      name: "declared length mismatch",
      options: {
        contentLength: String(validBytes.byteLength - 1),
        chunks: [validBytes],
        resumeSettleEvent: "end",
      },
      expectedPauseCalls: 1,
      expectedResumeCalls: 1,
    },
    {
      name: "read error after a complete-looking partial body",
      options: {
        contentLength: null,
        chunks: [validBytes],
        errorAt: 2,
        resumeSettleEvent: "end",
      },
      expectedPauseCalls: 1,
      expectedResumeCalls: 1,
    },
    {
      name: "client abort after a complete-looking partial body",
      options: { contentLength: null, chunks: [validBytes], abortAt: 2 },
      expectedPauseCalls: 1,
      expectedResumeCalls: 0,
    },
    {
      name: "premature close after complete-looking JSON bytes",
      options: {
        contentLength: String(validBytes.byteLength),
        chunks: [validBytes],
        completeOnDone: false,
        abortedOnDone: true,
      },
      expectedPauseCalls: 0,
      expectedResumeCalls: 0,
    },
  ]) {
    await t.test(item.name, async () => {
      const request = requestFor(ROUTES.client_refresh, item.options);
      const authority = new RecordingAuthority();
      const response = await handle(authority, "trusted-source", request);
      assert.equal(response.writeHeadCalls[0].status, 400);
      assert.deepEqual(authority.events, ["admit:client_refresh", "release:client_refresh"]);
      assert.equal(authority.inputs.length, 0);
      assert.equal(authority.events.some((event) => event.startsWith("invoke:")), false);
      assert.equal(request.destroyCalls, 0);
      assert.equal(request.pauseCalls, item.expectedPauseCalls);
      assert.equal(request.resumeCalls, item.expectedResumeCalls);
      assert.equal(request.listenerCount("end"), 0);
      assert.equal(request.listenerCount("close"), 0);
      assert.equal(request.listenerCount("error"), 0);
      assert.equal(response.writeHeadCalls[0].headers.Connection, "close");
      assert.equal(response.endCalls[0].includes(Buffer.from(ACCESS_TOKEN)), false);
      assert.equal(response.endCalls[0].includes(Buffer.from(REFRESH_TOKEN)), false);
    });
  }
});

test("real node:http delivers a complete chunked oversize 413 before closing the connection", async () => {
  const authority = new RecordingAuthority();
  const handlerErrors = [];
  const handlerPromises = [];
  const serverSockets = new Set();
  const server = createServer((request, response) => {
    const handled = adapter.handleRelayV2BrokerCredentialNodeHttpRequest(
      authority,
      "trusted-loopback-source",
      request,
      response,
    ).catch((error) => {
      handlerErrors.push(error);
      if (!response.destroyed) response.destroy();
    });
    handlerPromises.push(handled);
  });
  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
  });
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");

    let clientSocket;
    let clientSocketClosed;
    const received = await new Promise((resolve, reject) => {
      const request = nodeHttpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: ROUTES.client_refresh.path,
        agent,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
          complete: response.complete,
        }));
      });
      request.once("socket", (socket) => {
        clientSocket = socket;
        clientSocketClosed = new Promise((resolveClose) => socket.once("close", resolveClose));
      });
      request.once("error", reject);
      request.write(Buffer.alloc(16_384, 0x20));
      request.end(Buffer.from("x", "utf8"));
    });

    await Promise.all(handlerPromises);
    if (clientSocketClosed) await clientSocketClosed;
    assert.equal(received.status, 413);
    assert.equal(received.headers["content-type"], "application/json");
    assert.equal(received.headers["cache-control"], "no-store");
    assert.equal(received.headers.connection, "close");
    assert.equal(received.complete, true);
    assert.equal(JSON.parse(received.body).error.code, "INVALID_ENVELOPE");
    assert.deepEqual(handlerErrors, []);
    assert.deepEqual(authority.events, ["admit:client_refresh", "release:client_refresh"]);
    assert.equal(authority.inputs.length, 0);
    assert.equal(clientSocket?.destroyed, true);
    assert.equal(Object.keys(agent.freeSockets).length, 0);
  } finally {
    agent.destroy();
    const closed = server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    for (const socket of serverSockets) socket.destroy();
    await closed;
  }
});

test("response failures never retry a handler or expose the write error", async (t) => {
  for (const failure of ["writeHead", "writeHeadEvent", "end", "close", "error"]) {
    await t.test(failure, async () => {
      const authority = new RecordingAuthority();
      const request = requestFor(ROUTES.client_refresh);
      const response = new SyntheticResponse(failure);
      await assert.rejects(
        handle(authority, "trusted-source", request, response),
        (error) => error instanceof Error
          && error.message === "Relay v2 credential HTTP response write failed"
          && !error.message.includes(ACCESS_TOKEN)
          && !error.message.includes(REFRESH_TOKEN),
      );
      assert.equal(
        authority.events.filter((event) => event === "invoke:client_refresh").length,
        1,
      );
      assert.equal(response.writeHeadCalls.length, 1);
      assert.equal(
        response.endCalls.length,
        failure === "writeHead" || failure === "writeHeadEvent" ? 0 : 1,
      );
    });
  }
});
