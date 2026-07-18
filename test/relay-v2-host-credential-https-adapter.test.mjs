import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import {
  createServer as createHttpsServer,
  request as nodeHttpsRequest,
} from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const BUILD_DIRECTORY = await mkdtemp(join(tmpdir(), "tw-host-credential-https-build-"));
const TLS_DIRECTORY = await mkdtemp(join(tmpdir(), "tw-host-credential-https-tls-"));
const PRIVATE_KEY_PATH = join(TLS_DIRECTORY, "localhost-key.pem");
const CERTIFICATE_PATH = join(TLS_DIRECTORY, "localhost-cert.pem");

execFileSync(
  join(REPOSITORY, "node_modules", ".bin", "tsup"),
  [
    "src/relay/v2/hostCredentialHttpsAdapter.ts",
    "src/relay/v2/singleExchangeHttpsTransport.ts",
    "--format", "esm",
    "--target", "node20",
    "--platform", "node",
    "--out-dir", BUILD_DIRECTORY,
    "--clean",
    "--splitting", "false",
  ],
  { cwd: REPOSITORY, stdio: "pipe" },
);
execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost",
    "-days", "1",
    "-keyout", PRIVATE_KEY_PATH,
    "-out", CERTIFICATE_PATH,
  ],
  { stdio: "pipe" },
);

const adapterModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "hostCredentialHttpsAdapter.js"),
).href);
const transportModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "singleExchangeHttpsTransport.js"),
).href);
const PRIVATE_KEY = await readFile(PRIVATE_KEY_PATH);
const CERTIFICATE = await readFile(CERTIFICATE_PATH);

test.after(async () => {
  await Promise.all([
    rm(BUILD_DIRECTORY, { recursive: true, force: true }),
    rm(TLS_DIRECTORY, { recursive: true, force: true }),
  ]);
});

const BOOTSTRAP_SECRET = "twhostboot2.bootstrap-secret-never-reflect";
const REFRESH_SECRET = "twref2.refresh-secret-never-reflect";
const ACCESS_SECRET = "twcap2.access-secret-never-reflect";
const NEXT_REFRESH_SECRET = "twref2.next-secret-never-reflect";
const ALL_SECRETS = [
  BOOTSTRAP_SECRET,
  REFRESH_SECRET,
  ACCESS_SECRET,
  NEXT_REFRESH_SECRET,
];

const BOOTSTRAP_REQUEST = Object.freeze({
  bootstrapAttemptId: "bootstrap-attempt-one",
  bootstrapToken: BOOTSTRAP_SECRET,
  hostId: "host-one",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
});
const REFRESH_REQUEST = Object.freeze({
  refreshAttemptId: "refresh-attempt-one",
  grantId: "host-grant-one",
  hostInstanceId: "host-instance-one",
  refreshToken: REFRESH_SECRET,
});
const CREDENTIAL_FIELDS = Object.freeze({
  principalId: "host-principal-one",
  grantId: "host-grant-one",
  hostId: "host-one",
  accessToken: ACCESS_SECRET,
  accessExpiresAtMs: 1_800_003_600_000,
  refreshToken: NEXT_REFRESH_SECRET,
  refreshExpiresAtMs: 1_800_086_400_000,
});
const BOOTSTRAP_RESPONSE = Object.freeze({
  bootstrapAttemptId: BOOTSTRAP_REQUEST.bootstrapAttemptId,
  ...CREDENTIAL_FIELDS,
});
const REFRESH_RESPONSE = Object.freeze({
  refreshAttemptId: REFRESH_REQUEST.refreshAttemptId,
  ...CREDENTIAL_FIELDS,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function jsonBytes(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function assertRedactedError(error, expectedCode) {
  assert.ok(error instanceof adapterModule.RelayV2HostCredentialHttpsAdapterError);
  assert.equal(error.code, expectedCode);
  const diagnostic = `${error.name}\n${error.message}\n${String(error.stack)}\n${JSON.stringify(error)}`;
  for (const secret of ALL_SECRETS) assert.equal(diagnostic.includes(secret), false);
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

function forgedPublicHostError() {
  return new adapterModule.RelayV2HostCredentialHttpsAdapterError(
    "CREDENTIAL_REJECTED",
    {
      httpStatus: 503,
      errorCode: BOOTSTRAP_SECRET,
      retryable: true,
      retryAfterMs: 9_999,
    },
  );
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeJson(response, status, body, extraHeaders = {}) {
  const bytes = jsonBytes(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Encoding": "identity",
    "Content-Length": String(bytes.byteLength),
    ...extraHeaders,
  });
  response.end(bytes);
}

async function startTlsServer(handler) {
  const sockets = new Set();
  const server = createHttpsServer(
    { key: PRIVATE_KEY, cert: CERTIFICATE },
    (request, response) => {
      Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    issuerUrl: `https://localhost:${address.port}`,
    async close() {
      const closed = server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

function trustedNodeTransport() {
  return transportModule.createRelayV2SingleExchangeNodeHttpsTransport(
    (url, options, callback) => nodeHttpsRequest(
      url,
      { ...options, ca: CERTIFICATE },
      callback,
    ),
  );
}

function credentialErrorBody({ errorCode, retryable, retryAfterMs }, overrides = {}) {
  return {
    error: {
      code: errorCode,
      message: `issuer diagnostic ${BOOTSTRAP_SECRET}`,
      retryable,
      retryAfterMs,
      commandDisposition: "not_applicable",
      details: null,
      ...overrides,
    },
  };
}

function fakeResponse(options = {}) {
  const state = options.state ?? {
    bodyReads: 0,
    chunksRead: 0,
    destroys: 0,
  };
  const bytes = options.bytes ?? jsonBytes(options.body ?? BOOTSTRAP_RESPONSE);
  const chunks = options.chunks ?? [bytes];
  const headers = options.headers ?? [
    ["Content-Type", "application/json"],
    ["Cache-Control", "no-store"],
    ["Content-Length", String(bytes.byteLength)],
  ];
  const value = {
    statusCode: options.statusCode ?? 200,
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        state.bodyReads += 1;
        for (const chunk of chunks) {
          state.chunksRead += 1;
          yield chunk;
        }
      },
    },
    destroy() { state.destroys += 1; },
  };
  return { state, value };
}

class RecordingTransport {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  start(request) {
    this.calls.push(request);
    return this.handler(request, this.calls.length - 1);
  }
}

function immediateExchange(response, state = { aborts: 0 }) {
  return {
    state,
    exchange: {
      response: Promise.resolve(response),
      abort() { state.aborts += 1; },
    },
  };
}

function fakeAdapter(transport) {
  return new adapterModule.RelayV2HostCredentialHttpsAdapter({
    issuerUrl: "https://relay.example.test",
    transport,
  });
}

test("local TLS exchanges use the two exact POST paths and keep credentials only in JSON bodies", async () => {
  const requests = [];
  let ownAbortedGetterReads = 0;
  const activeSignal = () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get() {
        ownAbortedGetterReads += 1;
        throw forgedPublicHostError();
      },
    });
    return controller.signal;
  };
  const server = await startTlsServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body,
    });
    if (request.url === adapterModule.RELAY_V2_HOST_BOOTSTRAP_HTTPS_PATH) {
      writeJson(response, 200, BOOTSTRAP_RESPONSE);
    } else if (request.url === adapterModule.RELAY_V2_HOST_TOKEN_REFRESH_HTTPS_PATH) {
      writeJson(response, 200, REFRESH_RESPONSE);
    } else {
      writeJson(response, 404, { error: "unexpected" });
    }
  });
  try {
    const adapter = new adapterModule.RelayV2HostCredentialHttpsAdapter({
      issuerUrl: server.issuerUrl,
      transport: trustedNodeTransport(),
    });
    const bootstrap = await adapter.bootstrap(
      BOOTSTRAP_REQUEST,
      activeSignal(),
    );
    const refresh = await adapter.refresh(
      REFRESH_REQUEST,
      activeSignal(),
    );

    assert.deepEqual(bootstrap, BOOTSTRAP_RESPONSE);
    assert.deepEqual(refresh, REFRESH_RESPONSE);
    assert.equal(Object.isFrozen(bootstrap), true);
    assert.equal(Object.isFrozen(refresh), true);
    assert.equal(ownAbortedGetterReads, 0);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map(({ method, url }) => ({ method, url })),
      [
        { method: "POST", url: "/v2/hosts/bootstrap" },
        { method: "POST", url: "/v2/hosts/tokens/refresh" },
      ],
    );
    assert.deepEqual(JSON.parse(requests[0].body), BOOTSTRAP_REQUEST);
    assert.deepEqual(JSON.parse(requests[1].body), REFRESH_REQUEST);
    for (const request of requests) {
      assert.equal(request.headers.accept, "application/json");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers["cache-control"], "no-store");
      assert.equal(request.headers["accept-encoding"], "identity");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      const metadata = JSON.stringify({ url: request.url, headers: request.headers });
      for (const secret of ALL_SECRETS) assert.equal(metadata.includes(secret), false);
    }
  } finally {
    await server.close();
  }
});

test("system TLS rejects an untrusted issuer and the adapter performs no fallback", async () => {
  let applicationRequests = 0;
  const server = await startTlsServer((_request, response) => {
    applicationRequests += 1;
    writeJson(response, 200, BOOTSTRAP_RESPONSE);
  });
  try {
    const adapter = new adapterModule.RelayV2HostCredentialHttpsAdapter({
      issuerUrl: server.issuerUrl,
    });
    await assert.rejects(
      adapter.bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
      (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
    );
    assert.equal(applicationRequests, 0);
  } finally {
    await server.close();
  }
});

test("a real HTTPS redirect is rejected once and never forwards the bootstrap secret", async () => {
  const requests = [];
  let server;
  server = await startTlsServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestBody(request) });
    if (request.url === adapterModule.RELAY_V2_HOST_BOOTSTRAP_HTTPS_PATH) {
      response.writeHead(302, {
        Location: `${server.issuerUrl}/redirect-target`,
        "Content-Type": "text/plain",
        "Content-Length": String(BOOTSTRAP_SECRET.length),
      });
      response.end(BOOTSTRAP_SECRET);
      return;
    }
    writeJson(response, 200, BOOTSTRAP_RESPONSE);
  });
  try {
    const adapter = new adapterModule.RelayV2HostCredentialHttpsAdapter({
      issuerUrl: server.issuerUrl,
      transport: trustedNodeTransport(),
    });
    await assert.rejects(
      adapter.bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
      (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v2/hosts/bootstrap");
    assert.deepEqual(JSON.parse(requests[0].body), BOOTSTRAP_REQUEST);
  } finally {
    await server.close();
  }
});

test("issuer configuration cannot smuggle credentials into URL, userinfo, path, query, or fragment", () => {
  let starts = 0;
  const transport = { start() { starts += 1; throw new Error("must not start"); } };
  for (const issuerUrl of [
    "http://relay.example.test",
    `https://${BOOTSTRAP_SECRET}@relay.example.test`,
    "https://relay.example.test/base",
    "https://relay.example.test/.",
    "https://relay.example.test/%2e",
    `https://relay.example.test?token=${BOOTSTRAP_SECRET}`,
    "https://relay.example.test?",
    `https://relay.example.test#${BOOTSTRAP_SECRET}`,
    "https://relay.example.test#",
    "https://relay.example.test:0",
  ]) {
    assert.throws(
      () => new adapterModule.RelayV2HostCredentialHttpsAdapter({ issuerUrl, transport }),
      (error) => assertRedactedError(error, "CONFIGURATION_INVALID"),
    );
  }
  assert.equal(starts, 0);
});

test("status and response headers fail closed before any body read", async (t) => {
  const cases = [
    { name: "redirect", statusCode: 302, headers: [["Location", "https://attacker.test"]] },
    { name: "content type parameter", headers: [["Content-Type", "application/json; charset=utf-8"], ["Cache-Control", "no-store"]] },
    { name: "cacheable", headers: [["Content-Type", "application/json"], ["Cache-Control", "private"]] },
    { name: "compressed", headers: [["Content-Type", "application/json"], ["Cache-Control", "no-store"], ["Content-Encoding", "gzip"]] },
    { name: "duplicate content type", headers: [["Content-Type", "application/json"], ["content-type", "application/json"], ["Cache-Control", "no-store"]] },
    { name: "declared oversize", headers: [["Content-Type", "application/json"], ["Cache-Control", "no-store"], ["Content-Length", "16385"]] },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const state = { bodyReads: 0, chunksRead: 0, destroys: 0 };
      const received = fakeResponse({
        statusCode: item.statusCode,
        headers: item.headers,
        body: `proxy body ${BOOTSTRAP_SECRET}`,
        state,
      });
      const exchangeState = { aborts: 0 };
      const transport = new RecordingTransport(() => immediateExchange(
        received.value,
        exchangeState,
      ).exchange);
      await assert.rejects(
        fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
        (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
      );
      assert.equal(transport.calls.length, 1);
      assert.equal(state.bodyReads, 0);
      assert.equal(state.destroys, 1);
      assert.equal(exchangeState.aborts, 0);
    });
  }
});

test("the counting reader stops on byte 16385 and enforces declared length", async (t) => {
  await t.test("byte limit", async () => {
    const state = { bodyReads: 0, chunksRead: 0, destroys: 0 };
    const received = fakeResponse({
      headers: [["Content-Type", "application/json"], ["Cache-Control", "no-store"]],
      chunks: [Buffer.alloc(16_384, 0x20), Buffer.from("x"), Buffer.from("not-read")],
      state,
    });
    const transport = new RecordingTransport(() => immediateExchange(received.value).exchange);
    await assert.rejects(
      fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
      (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
    );
    assert.equal(state.bodyReads, 1);
    assert.equal(state.chunksRead, 2);
    assert.equal(state.destroys, 1);
    assert.equal(transport.calls.length, 1);
  });

  for (const [name, declaredLength] of [
    ["truncated", jsonBytes(BOOTSTRAP_RESPONSE).byteLength + 1],
    ["extra", jsonBytes(BOOTSTRAP_RESPONSE).byteLength - 1],
  ]) {
    await t.test(`declared length ${name}`, async () => {
      const bytes = jsonBytes(BOOTSTRAP_RESPONSE);
      const received = fakeResponse({
        bytes,
        headers: [
          ["Content-Type", "application/json"],
          ["Cache-Control", "no-store"],
          ["Content-Length", String(declaredLength)],
        ],
      });
      const transport = new RecordingTransport(() => immediateExchange(received.value).exchange);
      await assert.rejects(
        fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
        (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
      );
      assert.equal(received.state.destroys, 1);
    });
  }
});

test("strict response codec and operation correlations fail closed", async (t) => {
  const cases = [
    {
      name: "closed codec rejects an unknown field",
      method: "bootstrap",
      request: BOOTSTRAP_REQUEST,
      body: { ...BOOTSTRAP_RESPONSE, future: true },
    },
    {
      name: "bootstrap attempt correlation",
      method: "bootstrap",
      request: BOOTSTRAP_REQUEST,
      body: { ...BOOTSTRAP_RESPONSE, bootstrapAttemptId: "other-attempt" },
    },
    {
      name: "bootstrap host correlation",
      method: "bootstrap",
      request: BOOTSTRAP_REQUEST,
      body: { ...BOOTSTRAP_RESPONSE, hostId: "other-host" },
    },
    {
      name: "refresh attempt correlation",
      method: "refresh",
      request: REFRESH_REQUEST,
      body: { ...REFRESH_RESPONSE, refreshAttemptId: "other-attempt" },
    },
    {
      name: "refresh grant correlation",
      method: "refresh",
      request: REFRESH_REQUEST,
      body: { ...REFRESH_RESPONSE, grantId: "other-grant" },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const received = fakeResponse({ body: item.body });
      const transport = new RecordingTransport(() => immediateExchange(received.value).exchange);
      await assert.rejects(
        fakeAdapter(transport)[item.method](item.request, new AbortController().signal),
        (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
      );
      assert.equal(received.state.bodyReads, 1);
      assert.equal(received.state.destroys, 1);
      assert.equal(transport.calls.length, 1);
    });
  }
});

test("request codec failures never start transport and request metadata never carries a secret", async () => {
  let starts = 0;
  const transport = { start() { starts += 1; throw new Error("must not start"); } };
  const adapter = fakeAdapter(transport);
  await assert.rejects(
    adapter.bootstrap(
      { ...BOOTSTRAP_REQUEST, hostEpoch: null },
      new AbortController().signal,
    ),
    (error) => assertRedactedError(error, "REQUEST_INVALID"),
  );
  assert.equal(starts, 0);

  const received = fakeResponse({ body: BOOTSTRAP_RESPONSE });
  const recording = new RecordingTransport(() => immediateExchange(received.value).exchange);
  await fakeAdapter(recording).bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal);
  assert.equal(recording.calls.length, 1);
  const call = recording.calls[0];
  assert.equal(call.endpoint, "https://relay.example.test/v2/hosts/bootstrap");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Accept-Encoding": "identity",
    "Content-Length": String(call.body.byteLength),
  });
  const metadata = JSON.stringify({ endpoint: call.endpoint, headers: call.headers });
  for (const secret of ALL_SECRETS) assert.equal(metadata.includes(secret), false);
  assert.deepEqual(JSON.parse(Buffer.from(call.body)), BOOTSTRAP_REQUEST);
});

test("credential errors require the frozen HTTP semantics and never trigger adapter retry", async (t) => {
  const cases = [
    {
      name: "401 AUTH_INVALID",
      statusCode: 401,
      method: "bootstrap",
      request: BOOTSTRAP_REQUEST,
      errorCode: "AUTH_INVALID",
      retryable: false,
      retryAfterMs: null,
    },
    {
      name: "503 BUSY",
      statusCode: 503,
      method: "refresh",
      request: REFRESH_REQUEST,
      errorCode: "BUSY",
      retryable: true,
      retryAfterMs: 1_000,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const received = fakeResponse({
        statusCode: item.statusCode,
        body: credentialErrorBody(item),
      });
      const exchangeState = { aborts: 0 };
      const transport = new RecordingTransport(() => immediateExchange(
        received.value,
        exchangeState,
      ).exchange);

      await assert.rejects(
        fakeAdapter(transport)[item.method](item.request, new AbortController().signal),
        (error) => {
          assertRedactedError(error, "CREDENTIAL_REJECTED");
          assert.equal(error.httpStatus, item.statusCode);
          assert.equal(error.errorCode, item.errorCode);
          assert.equal(error.retryable, item.retryable);
          assert.equal(error.retryAfterMs, item.retryAfterMs);
          return true;
        },
      );
      assert.equal(transport.calls.length, 1);
      assert.equal(received.state.bodyReads, 1);
      assert.equal(received.state.destroys, 1);
      assert.equal(exchangeState.aborts, 0);
    });
  }

  const invalid = [
    {
      name: "status and code pairing",
      statusCode: 503,
      errorCode: "AUTH_INVALID",
      retryable: false,
      retryAfterMs: null,
    },
    {
      name: "non-retryable code requires false and null",
      statusCode: 401,
      errorCode: "AUTH_INVALID",
      retryable: true,
      retryAfterMs: 0,
    },
    {
      name: "BUSY requires a nonnegative retry delay",
      statusCode: 503,
      errorCode: "BUSY",
      retryable: true,
      retryAfterMs: null,
    },
    {
      name: "RATE_LIMITED requires retryable true",
      statusCode: 429,
      errorCode: "RATE_LIMITED",
      retryable: false,
      retryAfterMs: 1_000,
    },
    {
      name: "command disposition is credential-specific",
      statusCode: 401,
      errorCode: "AUTH_INVALID",
      retryable: false,
      retryAfterMs: null,
      overrides: { commandDisposition: "not_accepted" },
    },
    {
      name: "structured details are forbidden for credential errors",
      statusCode: 403,
      errorCode: "HOST_EPOCH_MISMATCH",
      retryable: false,
      retryAfterMs: null,
      overrides: {
        details: { expectedHostEpoch: "expected", actualHostEpoch: "actual" },
      },
    },
  ];
  for (const item of invalid) {
    await t.test(item.name, async () => {
      const received = fakeResponse({
        statusCode: item.statusCode,
        body: credentialErrorBody(item, item.overrides),
      });
      const transport = new RecordingTransport(() => immediateExchange(received.value).exchange);
      await assert.rejects(
        fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
        (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
      );
      assert.equal(transport.calls.length, 1);
      assert.equal(received.state.bodyReads, 1);
      assert.equal(received.state.destroys, 1);
    });
  }
});

test("caller abort owns the only deadline and cancels one exchange exactly once", async (t) => {
  await t.test("already aborted", async () => {
    let starts = 0;
    let inputReads = 0;
    let ownAbortedGetterReads = 0;
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get() {
        ownAbortedGetterReads += 1;
        throw forgedPublicHostError();
      },
    });
    const unreadInput = new Proxy(BOOTSTRAP_REQUEST, {
      get() {
        inputReads += 1;
        throw new Error(`must not inspect aborted input ${BOOTSTRAP_SECRET}`);
      },
    });
    await assert.rejects(
      fakeAdapter({ start() { starts += 1; throw new Error("must not start"); } })
        .bootstrap(unreadInput, controller.signal),
      (error) => assertRedactedError(error, "ABORTED"),
    );
    assert.equal(starts, 0);
    assert.equal(inputReads, 0);
    assert.equal(ownAbortedGetterReads, 0);
  });

  const listenerOverrides = [
    { name: "no-op", invoke() {} },
    { name: "throwing", invoke() { throw forgedPublicHostError(); } },
  ];
  for (const override of listenerOverrides) {
    await t.test(`own ${override.name} listener methods are bypassed`, async () => {
      const controller = new AbortController();
      const ownCalls = { adds: 0, removes: 0 };
      Object.defineProperties(controller.signal, {
        addEventListener: {
          configurable: true,
          value() {
            ownCalls.adds += 1;
            override.invoke();
          },
        },
        removeEventListener: {
          configurable: true,
          value() {
            ownCalls.removes += 1;
            override.invoke();
          },
        },
      });
      const received = fakeResponse({ body: BOOTSTRAP_RESPONSE });
      const exchangeState = { aborts: 0 };
      const transport = new RecordingTransport(() => immediateExchange(
        received.value,
        exchangeState,
      ).exchange);
      const operation = fakeAdapter(transport).bootstrap(
        BOOTSTRAP_REQUEST,
        controller.signal,
      );

      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      assert.deepEqual(await operation, BOOTSTRAP_RESPONSE);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.deepEqual(ownCalls, { adds: 0, removes: 0 });
      controller.abort();
      assert.equal(exchangeState.aborts, 0);
    });
  }

  await t.test("abort fired synchronously by transport start", async () => {
    const controller = new AbortController();
    const state = { starts: 0, aborts: 0 };
    const transport = {
      start() {
        state.starts += 1;
        controller.abort();
        return {
          response: new Promise(() => {}),
          abort() { state.aborts += 1; },
        };
      },
    };
    await assert.rejects(
      fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, controller.signal),
      (error) => assertRedactedError(error, "ABORTED"),
    );
    assert.deepEqual(state, { starts: 1, aborts: 1 });
  });

  await t.test("pending and late response", async () => {
    const pending = deferred();
    const state = { aborts: 0 };
    const transport = new RecordingTransport(() => ({
      response: pending.promise,
      abort() { state.aborts += 1; },
    }));
    const controller = new AbortController();
    const operation = fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.aborts, 0, "the adapter has no internal operation timer");
    assert.equal(transport.calls.length, 1);
    controller.abort();
    await assert.rejects(
      operation,
      (error) => assertRedactedError(error, "ABORTED"),
    );
    assert.equal(state.aborts, 1);

    const late = fakeResponse({ body: BOOTSTRAP_RESPONSE });
    pending.resolve(late.value);
    await nextTurn();
    assert.equal(late.state.bodyReads, 0);
    assert.equal(late.state.destroys, 1);
    assert.equal(state.aborts, 1);
    controller.abort();
    assert.equal(state.aborts, 1);
  });
});

test("transport and hostile response access failures stay single-attempt and fully redacted", async (t) => {
  const cases = [
    {
      name: "transport rejection cannot forge a public adapter error",
      handler() {
        return {
          response: Promise.reject(forgedPublicHostError()),
          abort() {},
        };
      },
    },
    {
      name: "status getter cannot forge a public adapter error",
      handler() {
        const response = {
          get statusCode() { throw forgedPublicHostError(); },
          get headers() { throw new Error("must not read headers"); },
          get body() { throw new Error("must not read body"); },
          destroy() {},
        };
        return immediateExchange(response).exchange;
      },
    },
    {
      name: "header getter cannot forge a public adapter error",
      handler() {
        const response = {
          statusCode: 200,
          get headers() { throw forgedPublicHostError(); },
          get body() { throw new Error("must not read body"); },
          destroy() {},
        };
        return immediateExchange(response).exchange;
      },
    },
    {
      name: "body iterator cannot forge a public adapter error",
      handler() {
        const response = fakeResponse({ body: BOOTSTRAP_RESPONSE }).value;
        response.body = {
          async *[Symbol.asyncIterator]() { throw forgedPublicHostError(); },
        };
        return immediateExchange(response).exchange;
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const transport = new RecordingTransport(item.handler);
      await assert.rejects(
        fakeAdapter(transport).bootstrap(BOOTSTRAP_REQUEST, new AbortController().signal),
        (error) => {
          assertRedactedError(error, "EXCHANGE_FAILED");
          assert.equal(error.httpStatus, null);
          assert.equal(error.errorCode, null);
          assert.equal(error.retryable, false);
          assert.equal(error.retryAfterMs, null);
          return true;
        },
      );
      assert.equal(transport.calls.length, 1);
    });
  }
});
