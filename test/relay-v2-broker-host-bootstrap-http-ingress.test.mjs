import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRelayV2BrokerCredentialStateStore } from "./support/inMemoryRelayV2BrokerCredentialStateStore.mjs";

const credential = await import("../dist/relay/v2/brokerCredentialAuthority.js");
const ingress = await import("../dist/relay/v2/brokerHostBootstrapHttpIngress.js");
const issuer = await import("../dist/relay/v2/issuer.js");
const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const NOW_MS = 1_800_000_000_000;
const ANCHOR_ID = "host-bootstrap-http-test";
const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
const BOOTSTRAP_TOKEN = "twhostboot2.bootstrap-selector.bootstrap-secret";
const VALID_INPUT = Object.freeze({
  bootstrapAttemptId: "host-bootstrap-attempt",
  bootstrapToken: BOOTSTRAP_TOKEN,
  hostId: "host-one",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
});
const VALID_RESULT = Object.freeze({
  endpoint: "host_bootstrap",
  body: Object.freeze({
    bootstrapAttemptId: VALID_INPUT.bootstrapAttemptId,
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: VALID_INPUT.hostId,
    accessToken: "twcap2.payload.mac",
    accessExpiresAtMs: NOW_MS + 3_600_000,
    refreshToken: "twref2.refresh-token",
    refreshExpiresAtMs: NOW_MS + 86_400_000,
  }),
  replayed: false,
});

function jsonBytes(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function responseJson(response) {
  return JSON.parse(Buffer.from(response.body).toString("utf8"));
}

function assertClosedHeaders(response) {
  assert.deepEqual(response.headers, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
}

function headersFor(bytes, options = {}) {
  const headers = [
    { name: "Content-Type", value: "application/json" },
    { name: "Cache-Control", value: "no-store" },
  ];
  if (options.contentEncoding !== null) {
    headers.push({ name: "Content-Encoding", value: options.contentEncoding ?? "identity" });
  }
  if (options.contentLength !== null) {
    headers.push({
      name: "Content-Length",
      value: options.contentLength ?? String(bytes.byteLength),
    });
  }
  if (options.extraHeaders) headers.push(...options.extraHeaders);
  return headers;
}

function controlledBody(chunks, options = {}) {
  const state = {
    iteratorCalls: 0,
    nextCalls: 0,
    returnCalls: 0,
    cancelCalls: 0,
  };
  const body = {
    [Symbol.asyncIterator]() {
      state.iteratorCalls += 1;
      let index = 0;
      return {
        async next() {
          state.nextCalls += 1;
          if (options.throwOnNext === state.nextCalls) {
            throw new Error("injected body read failure");
          }
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
        return: options.iteratorReturn ?? (() => {
          state.returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined });
        }),
      };
    },
    cancel: options.cancel ?? (() => {
      state.cancelCalls += 1;
      return Promise.resolve();
    }),
  };
  return { body, state };
}

function requestFor(bytes, body, options = {}) {
  return {
    method: options.method ?? "POST",
    path: options.path ?? ingress.RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH,
    headers: options.headers ?? headersFor(bytes, options),
    body,
  };
}

class RecordingAuthority {
  constructor() {
    this.events = [];
    this.admitError = null;
    this.bootstrapError = null;
    this.receipts = new Map();
    this.bootstrapInputs = [];
    this.releaseInputs = [];
  }

  async admitHttpSource(input) {
    this.events.push("admit");
    if (this.admitError) throw this.admitError;
    const receipt = Object.freeze(() => undefined);
    this.receipts.set(receipt, { ...input });
    return receipt;
  }

  releaseHttpSourceAdmission(receipt, endpoint, sourceKey) {
    this.events.push("release");
    const record = this.receipts.get(receipt);
    if (!record || record.endpoint !== endpoint || record.sourceKey !== sourceKey) {
      throw new credential.RelayV2BrokerCredentialAuthorityError("INVALID_ARGUMENT");
    }
    this.receipts.delete(receipt);
    this.releaseInputs.push({ endpoint, sourceKey });
  }

  async bootstrapHost(receipt, sourceKey, input) {
    this.events.push("bootstrap");
    const record = this.receipts.get(receipt);
    if (!record || record.endpoint !== "host_bootstrap" || record.sourceKey !== sourceKey) {
      throw new credential.RelayV2BrokerCredentialAuthorityError("INVALID_ARGUMENT");
    }
    this.receipts.delete(receipt);
    this.bootstrapInputs.push({ sourceKey, input: structuredClone(input) });
    if (this.bootstrapError) throw this.bootstrapError;
    return VALID_RESULT;
  }
}

async function handleWithFake(bytes, options = {}) {
  const authority = options.authority ?? new RecordingAuthority();
  const stream = options.stream ?? controlledBody([bytes]);
  const request = requestFor(bytes, stream.body, options.request ?? {});
  const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
    authority,
    options.sourceKey ?? "trusted-server-source",
    request,
  );
  return { authority, stream, response };
}

test("exact route and frozen request headers reject pre-body and abort without next()", async (t) => {
  const bytes = jsonBytes(VALID_INPUT);
  const cases = [
    {
      name: "method",
      request: { method: "GET" },
      status: 404,
      code: "INVALID_ENVELOPE",
    },
    {
      name: "path and query",
      request: { path: "/v2/hosts/bootstrap?source=spoofed" },
      status: 404,
      code: "INVALID_ENVELOPE",
    },
    {
      name: "compressed body",
      request: { contentEncoding: "gzip" },
      status: 415,
      code: "PROTOCOL_UNSUPPORTED",
    },
    {
      name: "content type parameter",
      request: {
        headers: headersFor(bytes).map((header) => header.name === "Content-Type"
          ? { ...header, value: "application/json; charset=utf-8" }
          : header),
      },
      status: 415,
      code: "PROTOCOL_UNSUPPORTED",
    },
    {
      name: "cache control",
      request: {
        headers: headersFor(bytes).filter((header) => header.name !== "Cache-Control"),
      },
      status: 400,
      code: "INVALID_ENVELOPE",
    },
    {
      name: "malformed content length",
      request: { contentLength: "01" },
      status: 400,
      code: "INVALID_ENVELOPE",
    },
    {
      name: "declared oversize",
      request: { contentLength: "16385" },
      status: 413,
      code: "INVALID_ENVELOPE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const authority = new RecordingAuthority();
      const stream = controlledBody([bytes]);
      const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
        authority,
        "trusted-server-source",
        requestFor(bytes, stream.body, item.request),
      );
      assert.equal(response.status, item.status);
      assert.equal(responseJson(response).error.code, item.code);
      assertClosedHeaders(response);
      assert.equal(stream.state.iteratorCalls, 0);
      assert.equal(stream.state.nextCalls, 0);
      assert.equal(stream.state.cancelCalls, 1);
      assert.deepEqual(authority.events, []);
    });
  }
});

test("pre-body and limit abort is one-shot, non-blocking, and absorbs throwing or rejecting seams", async (t) => {
  const bytes = jsonBytes(VALID_INPUT);

  await t.test("hanging cancel and return cannot hold a 16385 response", async () => {
    const never = new Promise(() => {});
    const state = { cancelCalls: 0, returnCalls: 0, nextCalls: 0 };
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            state.nextCalls += 1;
            return Promise.resolve({ done: false, value: new Uint8Array(16_385) });
          },
          return() {
            state.returnCalls += 1;
            return never;
          },
        };
      },
      cancel() {
        state.cancelCalls += 1;
        return never;
      },
    };
    const authority = new RecordingAuthority();
    const response = await Promise.race([
      ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
        authority,
        "trusted-server-source",
        requestFor(bytes, body, { contentLength: null }),
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error("abort blocked response")), 100)),
    ]);
    assert.equal(response.status, 413);
    assert.equal(state.nextCalls, 1);
    assert.equal(state.cancelCalls, 1);
    assert.equal(state.returnCalls, 1);
    assert.deepEqual(authority.events, ["admit", "release"]);
  });

  await t.test("throwing getters and rejecting promises stay closed", async () => {
    const state = { nextCalls: 0, returnGetterCalls: 0, cancelGetterCalls: 0 };
    const iterator = {
      async next() {
        state.nextCalls += 1;
        return { done: false, value: new Uint8Array(16_385) };
      },
      get return() {
        state.returnGetterCalls += 1;
        throw new Error(`iterator getter ${BOOTSTRAP_TOKEN}`);
      },
    };
    const body = {
      [Symbol.asyncIterator]() { return iterator; },
      get cancel() {
        state.cancelGetterCalls += 1;
        return () => Promise.reject(new Error(`cancel rejection ${BOOTSTRAP_TOKEN}`));
      },
    };
    const authority = new RecordingAuthority();
    const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
      authority,
      "trusted-server-source",
      requestFor(bytes, body, { contentLength: null }),
    );
    assert.equal(response.status, 413);
    assert.equal(state.nextCalls, 1);
    assert.equal(state.cancelGetterCalls, 1);
    assert.equal(state.returnGetterCalls, 1);
    assert.equal(Buffer.from(response.body).includes(Buffer.from(BOOTSTRAP_TOKEN)), false);
  });

  await t.test("throwing thenables and rejected iterator returns stay closed", async () => {
    const state = { cancelCalls: 0, returnCalls: 0 };
    const body = {
      [Symbol.asyncIterator]() {
        return {
          async next() { return { done: false, value: new Uint8Array(16_385) }; },
          return() {
            state.returnCalls += 1;
            return Promise.reject(new Error(`return rejection ${BOOTSTRAP_TOKEN}`));
          },
        };
      },
      cancel() {
        state.cancelCalls += 1;
        return {
          get then() { throw new Error(`throwing thenable ${BOOTSTRAP_TOKEN}`); },
        };
      },
    };
    const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
      new RecordingAuthority(),
      "trusted-server-source",
      requestFor(bytes, body, { contentLength: null }),
    );
    assert.equal(response.status, 413);
    assert.equal(state.cancelCalls, 1);
    assert.equal(state.returnCalls, 1);
    assert.equal(Buffer.from(response.body).includes(Buffer.from(BOOTSTRAP_TOKEN)), false);
  });

  await t.test("pre-read reject never constructs the iterator even when cancel hangs", async () => {
    const state = { iteratorCalls: 0, cancelCalls: 0 };
    const body = {
      [Symbol.asyncIterator]() {
        state.iteratorCalls += 1;
        throw new Error("iterator must not be constructed");
      },
      cancel() {
        state.cancelCalls += 1;
        return new Promise(() => {});
      },
    };
    const response = await Promise.race([
      ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
        new RecordingAuthority(),
        "trusted-server-source",
        requestFor(bytes, body, { contentLength: "16385" }),
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pre-read abort blocked")), 100)),
    ]);
    assert.equal(response.status, 413);
    assert.equal(state.iteratorCalls, 0);
    assert.equal(state.cancelCalls, 1);
  });
});

test("unknown-length counting stops at byte 16385 and read failures release admission", async (t) => {
  const full = new Uint8Array(16_384);
  const cases = [
    { name: "single chunk", chunks: [new Uint8Array(16_385)], nextCalls: 1 },
    { name: "boundary chunk", chunks: [full, Uint8Array.of(1), Uint8Array.of(2)], nextCalls: 2 },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const authority = new RecordingAuthority();
      const stream = controlledBody(item.chunks);
      const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
        authority,
        "trusted-server-source",
        requestFor(full, stream.body, { contentLength: null }),
      );
      assert.equal(response.status, 413);
      assert.equal(stream.state.nextCalls, item.nextCalls);
      assert.equal(stream.state.cancelCalls, 1);
      assert.equal(stream.state.returnCalls, 1);
      assert.deepEqual(authority.events, ["admit", "release"]);
    });
  }

  await t.test("reader error", async () => {
    const authority = new RecordingAuthority();
    const stream = controlledBody([jsonBytes("{}")], { throwOnNext: 1 });
    const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
      authority,
      "trusted-server-source",
      requestFor(jsonBytes("{}"), stream.body, { contentLength: null }),
    );
    assert.equal(response.status, 400);
    assert.equal(stream.state.cancelCalls, 1);
    assert.equal(stream.state.returnCalls, 1);
    assert.deepEqual(authority.events, ["admit", "release"]);
    assert.deepEqual(authority.releaseInputs, [{
      endpoint: "host_bootstrap",
      sourceKey: "trusted-server-source",
    }]);
  });
});

test("declared Content-Length is checked against the exact actual body length", async (t) => {
  const bytes = jsonBytes(VALID_INPUT);
  const cases = [
    { name: "truncated", declared: String(bytes.byteLength + 1), chunks: [bytes] },
    { name: "extra", declared: String(bytes.byteLength - 1), chunks: [bytes] },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const authority = new RecordingAuthority();
      const stream = controlledBody(item.chunks);
      const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
        authority,
        "trusted-server-source",
        requestFor(bytes, stream.body, { contentLength: item.declared }),
      );
      assert.equal(response.status, 400);
      assert.equal(responseJson(response).error.code, "INVALID_ENVELOPE");
      assert.equal(stream.state.cancelCalls, 1);
      assert.equal(stream.state.returnCalls, 1);
      assert.deepEqual(authority.events, ["admit", "release"]);
    });
  }
});

test("durable source admission precedes reading and strict JSON/schema failures release it", async (t) => {
  const rateLimited = new RecordingAuthority();
  rateLimited.admitError = new credential.RelayV2BrokerCredentialAuthorityError("RATE_LIMITED");
  const unread = controlledBody([jsonBytes("not-json")]);
  const limited = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
    rateLimited,
    "rate-limited-source",
    requestFor(jsonBytes("not-json"), unread.body),
  );
  assert.equal(limited.status, 429);
  assert.equal(unread.state.nextCalls, 0);
  assert.equal(unread.state.cancelCalls, 1);
  assert.deepEqual(rateLimited.events, ["admit"]);

  const duplicate = JSON.stringify(VALID_INPUT).replace(
    `"bootstrapToken":"${BOOTSTRAP_TOKEN}"`,
    `"bootstrapToken":"${BOOTSTRAP_TOKEN}","bootstrapToken":"${BOOTSTRAP_TOKEN}"`,
  );
  const nested = `${"[".repeat(8)}0${"]".repeat(8)}`;
  const tooManyKeys = Object.fromEntries(Array.from({ length: 33 }, (_, index) => (
    [`key${index}`, index]
  )));
  const cases = [
    { name: "malformed", bytes: jsonBytes("{") },
    { name: "invalid utf8", bytes: Uint8Array.of(0xff) },
    { name: "duplicate", bytes: jsonBytes(duplicate) },
    { name: "trailing", bytes: jsonBytes(`${JSON.stringify(VALID_INPUT)}{}`) },
    {
      name: "depth",
      bytes: jsonBytes(`{"bootstrapAttemptId":"attempt","bootstrapToken":"${BOOTSTRAP_TOKEN}","hostId":"host","hostEpoch":${nested},"hostInstanceId":"instance"}`),
    },
    { name: "keys", bytes: jsonBytes(tooManyKeys) },
    { name: "unknown field", bytes: jsonBytes({ ...VALID_INPUT, sourceKey: "body-spoof" }) },
    { name: "null", bytes: jsonBytes({ ...VALID_INPUT, hostEpoch: null }) },
    { name: "coercion", bytes: jsonBytes({ ...VALID_INPUT, hostEpoch: 42 }) },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { authority, response } = await handleWithFake(item.bytes);
      assert.equal(response.status, 400);
      assert.equal(responseJson(response).error.code, "INVALID_ENVELOPE");
      assert.equal(Buffer.from(response.body).includes(Buffer.from(BOOTSTRAP_TOKEN)), false);
      assert.deepEqual(authority.events, ["admit", "release"]);
      assert.equal(authority.receipts.size, 0);
    });
  }
});

test("trusted sourceKey stays out of URL, body, and forwarding headers", async () => {
  const bytes = jsonBytes(VALID_INPUT);
  const authority = new RecordingAuthority();
  const stream = controlledBody([bytes]);
  const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
    authority,
    "trusted-server-source",
    requestFor(bytes, stream.body, {
      contentEncoding: null,
      extraHeaders: [
        { name: "Forwarded", value: "for=forwarded-spoof" },
        { name: "X-Forwarded-For", value: "xff-spoof" },
      ],
    }),
  );
  assert.equal(response.status, 200);
  assertClosedHeaders(response);
  assert.deepEqual(authority.bootstrapInputs, [{
    sourceKey: "trusted-server-source",
    input: VALID_INPUT,
  }]);
});

test("authority success and ACK-loss replay return the exact frozen credential body", async () => {
  const external = new MemoryContinuityAuthority();
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, external),
  );
  try {
    const created = await authority.adminCreateHostBootstrap();
    const input = { ...VALID_INPUT, bootstrapToken: created.bootstrapToken };
    const bytes = jsonBytes(input);
    const first = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
      authority,
      "trusted-real-source",
      requestFor(bytes, controlledBody([bytes]).body),
    );
    const replay = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
      authority,
      "trusted-real-source",
      requestFor(bytes, controlledBody([bytes]).body),
    );
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assertClosedHeaders(first);
    assert.deepEqual(responseJson(replay), responseJson(first));
    assert.deepEqual(Buffer.from(replay.body), Buffer.from(first.body));
    assert.equal(responseJson(first).bootstrapAttemptId, input.bootstrapAttemptId);
    assert.equal(responseJson(first).hostId, input.hostId);
  } finally {
    await authority.close();
  }
});

test("authority taxonomy maps closed without reflecting secrets or collapsing fatal errors to auth", async (t) => {
  const bytes = jsonBytes(VALID_INPUT);
  const cases = [
    ["INVALID_ARGUMENT", 400, "INVALID_ENVELOPE", false, null],
    ["AUTH_INVALID", 401, "AUTH_INVALID", false, null],
    ["ROLE_MISMATCH", 403, "ROLE_MISMATCH", false, null],
    ["PERMISSION_DENIED", 403, "PERMISSION_DENIED", false, null],
    ["GRANT_NOT_FOUND", 404, "GRANT_NOT_FOUND", false, null],
    ["IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT", false, null],
    ["RATE_LIMITED", 429, "RATE_LIMITED", true, 1_000],
    ["BUSY", 503, "BUSY", true, 1_000],
    ["STATE_CAPACITY_EXHAUSTED", 503, "BUSY", true, 1_000],
    ["STATE_INVALID", 500, "INTERNAL", false, null],
    ["STATE_CONFLICT", 500, "INTERNAL", false, null],
    ["AUTHORITY_NOT_READY", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["AUTHORITY_CLOSED", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["STORE_PUBLICATION_UNCERTAIN", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["EXTERNAL_ANCHOR_UNCERTAIN", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["EXTERNAL_ANCHOR_CONFLICT", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["EXTERNAL_CONTINUITY_UNAVAILABLE", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["EXTERNAL_CONTINUITY_INVALID", 503, "CAPABILITY_UNAVAILABLE", false, null],
    ["CLOSE_BARRIER_FAILED", 503, "CAPABILITY_UNAVAILABLE", false, null],
  ];
  for (const [authorityCode, status, responseCode, retryable, retryAfterMs] of cases) {
    await t.test(authorityCode, async () => {
      const authority = new RecordingAuthority();
      authority.bootstrapError = new credential.RelayV2BrokerCredentialAuthorityError(
        authorityCode,
      );
      const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
        authority,
        "trusted-server-source",
        requestFor(bytes, controlledBody([bytes]).body),
      );
      const error = responseJson(response).error;
      assert.equal(response.status, status);
      assert.equal(error.code, responseCode);
      assert.equal(error.retryable, retryable);
      assert.equal(error.retryAfterMs, retryAfterMs);
      assert.equal(error.commandDisposition, "not_applicable");
      assert.equal(error.details, null);
      assert.equal(Buffer.from(response.body).includes(Buffer.from(BOOTSTRAP_TOKEN)), false);
      assertClosedHeaders(response);
    });
  }

  const unknown = new RecordingAuthority();
  unknown.bootstrapError = new Error(`unknown failure ${BOOTSTRAP_TOKEN}`);
  const response = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
    unknown,
    "trusted-server-source",
    requestFor(bytes, controlledBody([bytes]).body),
  );
  assert.equal(response.status, 500);
  assert.equal(responseJson(response).error.code, "INTERNAL");
  assert.equal(Buffer.from(response.body).includes(Buffer.from(BOOTSTRAP_TOKEN)), false);

  const lookalike = new RecordingAuthority();
  lookalike.bootstrapError = Object.assign(
    new Error(`lookalike ${BOOTSTRAP_TOKEN}`),
    { name: "RelayV2BrokerCredentialAuthorityError", code: "AUTH_INVALID" },
  );
  const lookalikeResponse = await ingress.handleRelayV2BrokerHostBootstrapHttpIngress(
    lookalike,
    "trusted-server-source",
    requestFor(bytes, controlledBody([bytes]).body),
  );
  assert.equal(lookalikeResponse.status, 500);
  assert.equal(responseJson(lookalikeResponse).error.code, "INTERNAL");
  assert.equal(
    Buffer.from(lookalikeResponse.body).includes(Buffer.from(BOOTSTRAP_TOKEN)),
    false,
  );
});

class MemoryContinuityAuthority {
  constructor() {
    this.token = 0;
    this.current = {
      protocolVersion: VERSION,
      status: "uninitialized",
      anchorId: ANCHOR_ID,
      casToken: "cas-0",
    };
  }

  async read() {
    return structuredClone(this.current);
  }

  async compareAndSwap(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: VERSION,
        outcome: "conflict",
        current: structuredClone(this.current),
      };
    }
    this.token += 1;
    this.current = {
      protocolVersion: VERSION,
      status: "committed",
      anchorId: ANCHOR_ID,
      casToken: `cas-${this.token}`,
      checkpoint: structuredClone(request.next),
    };
    return {
      protocolVersion: VERSION,
      outcome: "swapped",
      current: structuredClone(this.current),
    };
  }
}

function authorityOptions(store, external) {
  let id = 0;
  let byte = 0;
  return {
    store,
    continuityAnchor: {
      anchorId: ANCHOR_ID,
      authority: external,
      operationTimeoutMs: 100,
    },
    genesis: {
      issuerKeyring: issuer.createRelayV2IssuerKeyring({
        issuerId: "host-bootstrap-http-issuer",
        kid: "host-bootstrap-http-kid",
        secretBase64url: Buffer.alloc(32, 7).toString("base64url"),
        nowSeconds: Math.floor(NOW_MS / 1_000),
      }),
      issuerUrl: "https://relay.example.com/",
      relayUrl: "wss://relay.example.com/client",
    },
    now: () => NOW_MS,
    randomId: () => `host-bootstrap-http-id-${++id}`,
    randomBytes: (length) => {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        output[index] = (byte + index + 1) % 256;
      }
      byte = (byte + length) % 256;
      return output;
    },
  };
}
