import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const adapterModule = await import(
  "../dist/relay/v2/externalContinuityAuthorityHttpsAdapter.js"
);
const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const ENDPOINT = "https://continuity.example.test/external/continuity/v1";
const SECURITY_DOMAIN = "domain-a";
const NAMESPACE = "broker-credential.v1";
const ANCHOR_ID = "anchor-broker-a";
const SECRET = "Bearer workload-secret-never-reflect";
const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;

function forgedPublicAdapterError(code = "ANCHOR_COMMIT_UNCERTAIN") {
  const error = new adapterModule.RelayV2ExternalContinuityHttpsAdapterError(code);
  error.message = `forged public adapter error ${SECRET}`;
  error.dynamic = SECRET;
  return error;
}

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

function checkpoint(sequence = "0", commitId = "commit-0", parentCommitId = null) {
  return {
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    sequence,
    commitId,
    parentCommitId,
    stateDigest: "a".repeat(64),
  };
}

function uninitialized(casToken = "cas-0") {
  return {
    protocolVersion: VERSION,
    status: "uninitialized",
    anchorId: ANCHOR_ID,
    casToken,
  };
}

function response(options = {}) {
  const bytes = options.bytes ?? Buffer.from(options.body ?? "", "utf8");
  const state = options.state ?? { bodyReads: 0, chunksRead: 0, destroys: 0 };
  const chunks = options.chunks ?? [bytes];
  const headers = options.headers ?? [
    ["Content-Type", "application/json"],
    ["Cache-Control", "no-store"],
    ["Content-Length", String(bytes.byteLength)],
  ];
  return {
    state,
    value: {
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
    },
  };
}

function jsonEnvelope(requestBody, options) {
  return JSON.stringify({
    contractVersion: 1,
    operationId: requestBody.operationId,
    ok: options.ok,
    result: options.ok ? options.result : null,
    error: options.ok ? null : options.error,
  });
}

function immediateExchange(value, state = { aborts: 0 }) {
  return {
    state,
    exchange: {
      response: Promise.resolve(value),
      abort() { state.aborts += 1; },
    },
  };
}

class HandlerTransport {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  start(request) {
    this.calls.push(request);
    return this.handler(request, this.calls.length - 1);
  }
}

function makeAdapter(transport, options = {}) {
  return new adapterModule.RelayV2ExternalContinuityAuthorityHttpsAdapter({
    endpoint: options.endpoint ?? ENDPOINT,
    securityDomainId: SECURITY_DOMAIN,
    namespace: options.namespace ?? NAMESPACE,
    anchorId: ANCHOR_ID,
    authenticationHeaders: () => ({ Authorization: SECRET }),
    transport,
  });
}

function readRequest(signal = new AbortController().signal) {
  return { protocolVersion: VERSION, anchorId: ANCHOR_ID, signal };
}

function casRequest(signal = new AbortController().signal) {
  return {
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    expected: uninitialized(),
    next: checkpoint(),
    signal,
  };
}

function successTransport(resultForRequest) {
  return new HandlerTransport((request) => {
    const body = JSON.parse(Buffer.from(request.body).toString("utf8"));
    const encoded = jsonEnvelope(body, { ok: true, result: resultForRequest(body) });
    const received = response({ body: encoded });
    return immediateExchange(received.value).exchange;
  });
}

test("encodes exact read/CAS POST requests and passes success results through as unknown", async () => {
  const transport = successTransport((body) => ({
    opaque: body.operation,
    malformedInnerField: true,
  }));
  const adapter = makeAdapter(transport);

  const readResult = await adapter.read(readRequest());
  const casResult = await adapter.compareAndSwap(casRequest());
  assert.equal(JSON.stringify(readResult), JSON.stringify({
    opaque: "read",
    malformedInnerField: true,
  }));
  assert.equal(JSON.stringify(casResult), JSON.stringify({
    opaque: "compare_and_swap",
    malformedInnerField: true,
  }));
  assert.equal(transport.calls.length, 2);

  const readWire = JSON.parse(Buffer.from(transport.calls[0].body).toString("utf8"));
  const casWire = JSON.parse(Buffer.from(transport.calls[1].body).toString("utf8"));
  assert.deepEqual(readWire, {
    contractVersion: 1,
    operationId: readWire.operationId,
    securityDomainId: SECURITY_DOMAIN,
    namespace: NAMESPACE,
    anchorId: ANCHOR_ID,
    operation: "read",
    payload: {},
  });
  assert.deepEqual(casWire, {
    contractVersion: 1,
    operationId: casWire.operationId,
    securityDomainId: SECURITY_DOMAIN,
    namespace: NAMESPACE,
    anchorId: ANCHOR_ID,
    operation: "compare_and_swap",
    payload: { expected: uninitialized(), next: checkpoint() },
  });
  assert.match(readWire.operationId, /^twca1\.[A-Za-z0-9_-]{43}$/);
  assert.match(casWire.operationId, /^twca1\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(readWire.operationId, casWire.operationId);

  for (const call of transport.calls) {
    assert.equal(call.endpoint, ENDPOINT);
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Accept, "application/json");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.equal(call.headers["Cache-Control"], "no-store");
    assert.equal(call.headers["Accept-Encoding"], "identity");
    assert.equal(call.headers.Authorization, SECRET);
    assert.equal(call.headers["Content-Length"], String(call.body.byteLength));
  }
});

test("rejects non-exact HTTPS endpoints before resolving auth or starting transport", () => {
  let authCalls = 0;
  let transportCalls = 0;
  const transport = { start() { transportCalls += 1; throw new Error("must not start"); } };
  for (const endpoint of [
    "http://continuity.example.test/external/continuity/v1",
    "https://user:password@continuity.example.test/external/continuity/v1",
    "https://continuity.example.test/external/continuity/v1?redirect=1",
    "https://continuity.example.test/external/continuity/v1#fragment",
    `https://continuity.example.test/${"x".repeat(2_100)}`,
  ]) {
    assert.throws(
      () => new adapterModule.RelayV2ExternalContinuityAuthorityHttpsAdapter({
        endpoint,
        securityDomainId: SECURITY_DOMAIN,
        namespace: NAMESPACE,
        anchorId: ANCHOR_ID,
        authenticationHeaders: () => { authCalls += 1; return { Authorization: SECRET }; },
        transport,
      }),
      /HTTPS endpoint is invalid/,
    );
  }
  assert.equal(authCalls, 0);
  assert.equal(transportCalls, 0);
});

test("default Node transport pins system TLS verification and does not add proxy/redirect behavior", async () => {
  const client = new EventEmitter();
  client.end = (body) => { client.body = Buffer.from(body); };
  client.destroy = () => { client.destroyed = true; };
  let captured;
  const transport = adapterModule.createRelayV2ExternalContinuityNodeHttpsTransport(
    (url, options, callback) => {
      captured = { url, options, callback };
      return client;
    },
  );
  const exchange = transport.start({
    endpoint: ENDPOINT,
    method: "POST",
    headers: { Authorization: SECRET },
    body: Buffer.from("{}"),
  });
  assert.equal(captured.url.href, ENDPOINT);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.rejectUnauthorized, true);
  assert.equal(typeof captured.options.checkServerIdentity, "function");
  assert.equal(captured.options.agent, false);
  assert.equal(Object.hasOwn(captured.options, "proxy"), false);
  assert.equal(Object.hasOwn(captured.options, "maxRedirects"), false);
  assert.deepEqual(client.body, Buffer.from("{}"));
  exchange.abort();
  await assert.rejects(
    exchange.response,
    (error) => error.name === "Error"
      && error.message === "Relay v2 external continuity HTTPS transport failed",
  );
  assert.equal(client.destroyed, true);
});

test("redirects and response-header mismatches are destroyed before any body read", async () => {
  const cases = [
    { statusCode: 307, headers: [["Location", "https://attacker.example/steal"]] },
    { statusCode: 200, headers: [["Content-Type", "application/json; charset=utf-8"], ["Cache-Control", "no-store"]] },
    { statusCode: 200, headers: [["Content-Type", "application/json"], ["Cache-Control", "private"]] },
    { statusCode: 200, headers: [["Content-Type", "application/json"], ["Cache-Control", "no-store"], ["Content-Encoding", "gzip"]] },
    { statusCode: 200, headers: [["Content-Type", "application/json"], ["Cache-Control", "no-store"], ["Content-Length", "16385"]] },
  ];
  for (const selected of cases) {
    const bodyState = { bodyReads: 0, chunksRead: 0, destroys: 0 };
    const received = response({ ...selected, body: `proxy body ${SECRET}`, state: bodyState });
    const exchangeState = { aborts: 0 };
    const transport = new HandlerTransport(() => immediateExchange(
      received.value,
      exchangeState,
    ).exchange);
    await assert.rejects(
      makeAdapter(transport).read(readRequest()),
      (error) => {
        assert.equal(error.code, "ANCHOR_UNAVAILABLE");
        assert.doesNotMatch(error.message, /proxy body|workload-secret/);
        return true;
      },
    );
    assert.equal(transport.calls.length, 1, "redirects are never followed");
    assert.equal(transport.calls[0].endpoint, ENDPOINT);
    assert.equal(transport.calls[0].headers.Authorization, SECRET);
    assert.equal(bodyState.bodyReads, 0, "rejected headers never enter the body iterator");
    assert.equal(bodyState.destroys, 1);
    assert.equal(exchangeState.aborts, 0, "received response is destroyed without a second abort side effect");
  }
});

test("counting reader aborts on byte 16385 without reading or allocating a larger body", async () => {
  const state = { bodyReads: 0, chunksRead: 0, destroys: 0 };
  const received = response({
    headers: [["Content-Type", "application/json"], ["Cache-Control", "no-store"]],
    chunks: [Buffer.alloc(16_384, 0x20), Buffer.from("x"), Buffer.from("not-read")],
    state,
  });
  const exchangeState = { aborts: 0 };
  const transport = new HandlerTransport(() => immediateExchange(received.value, exchangeState).exchange);
  await assert.rejects(
    makeAdapter(transport).read(readRequest()),
    (error) => error.code === "ANCHOR_UNAVAILABLE",
  );
  assert.equal(state.bodyReads, 1);
  assert.equal(state.chunksRead, 2, "reader stops at the first over-limit byte");
  assert.equal(state.destroys, 1);
  assert.equal(exchangeState.aborts, 0, "over-limit response uses the same one-shot destroy path");
});

test("throwing response/header access and late rejection all enter the one-shot closed path", async () => {
  {
    const state = { aborts: 0 };
    const transport = new HandlerTransport(() => ({
      get response() { throw forgedPublicAdapterError(); },
      abort() { state.aborts += 1; },
    }));
    await assert.rejects(
      makeAdapter(transport).read(readRequest()),
      (error) => {
        assert.equal(error.code, "ANCHOR_UNAVAILABLE");
        assert.doesNotMatch(error.message, /workload-secret|response getter/);
        return true;
      },
    );
    assert.equal(state.aborts, 1);
  }

  for (const throwingHeaders of [
    { get value() { throw forgedPublicAdapterError(); } },
    {
      value: {
        [Symbol.iterator]() { throw forgedPublicAdapterError(); },
      },
    },
  ]) {
    const state = { destroys: 0, aborts: 0 };
    const received = {
      statusCode: 200,
      get headers() { return throwingHeaders.value; },
      get body() { throw new Error("pre-body gate must not touch body"); },
      destroy() { state.destroys += 1; },
    };
    const transport = new HandlerTransport(() => ({
      response: Promise.resolve(received),
      abort() { state.aborts += 1; },
    }));
    await assert.rejects(
      makeAdapter(transport).read(readRequest()),
      (error) => {
        assert.equal(error.code, "ANCHOR_UNAVAILABLE");
        assert.doesNotMatch(error.message, /workload-secret|header/);
        return true;
      },
    );
    assert.equal(state.destroys, 1);
    assert.equal(state.aborts, 0);
  }

  {
    const state = { destroys: 0, aborts: 0 };
    const received = {
      statusCode: 200,
      headers: [
        ["Content-Type", "application/json"],
        ["Cache-Control", "no-store"],
      ],
      body: {
        async *[Symbol.asyncIterator]() { throw forgedPublicAdapterError(); },
      },
      destroy() { state.destroys += 1; },
    };
    const transport = new HandlerTransport(() => ({
      response: Promise.resolve(received),
      abort() { state.aborts += 1; },
    }));
    await assert.rejects(
      makeAdapter(transport).read(readRequest()),
      (error) => {
        assert.equal(error.code, "ANCHOR_UNAVAILABLE");
        assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /workload-secret/);
        return true;
      },
    );
    assert.equal(state.destroys, 1);
    assert.equal(state.aborts, 0);
  }

  {
    const pending = deferred();
    const state = { aborts: 0 };
    const controller = new AbortController();
    const transport = new HandlerTransport(() => ({
      response: pending.promise,
      abort() { state.aborts += 1; },
    }));
    const operation = makeAdapter(transport).read(readRequest(controller.signal));
    controller.abort();
    await assert.rejects(operation, (error) => error.code === "ANCHOR_UNAVAILABLE");
    pending.reject(new Error(`late rejection ${SECRET}`));
    await nextTurn();
    assert.equal(state.aborts, 1, "late rejection cannot trigger a second cancellation");
  }
});

test("strict UTF-8/JSON and the closed outer envelope reject each independent boundary", async () => {
  const validBase = {
    contractVersion: 1,
    operationId: "replaced-per-request",
    ok: true,
    result: { value: true },
    error: null,
  };
  const bodies = [
    () => Buffer.from([0xc3, 0x28]),
    (id) => Buffer.from(`{"contractVersion":1,"operationId":"${id}","ok":true,"ok":true,"result":{},"error":null}`),
    (id) => Buffer.from(`${JSON.stringify({ ...validBase, operationId: id })}{}`),
    (id) => {
      let nested = null;
      for (let index = 0; index < 8; index += 1) nested = [nested];
      return Buffer.from(JSON.stringify({ ...validBase, operationId: id, result: nested }));
    },
    (id) => Buffer.from(JSON.stringify({
      ...validBase,
      operationId: id,
      result: Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`k${index}`, index])),
    })),
    (id) => Buffer.from(JSON.stringify({ ...validBase, operationId: id, future: true })),
    (id) => Buffer.from(JSON.stringify({
      contractVersion: 1,
      operationId: id,
      ok: false,
      result: null,
      error: {
        code: "FUTURE_ERROR",
        message: null,
        retryable: false,
        retryAfterMs: null,
        commitDisposition: "not_applicable",
      },
    })),
  ];

  for (const makeBody of bodies) {
    const transport = new HandlerTransport((request) => {
      const wire = JSON.parse(Buffer.from(request.body).toString("utf8"));
      const bytes = makeBody(wire.operationId);
      return immediateExchange(response({ bytes }).value).exchange;
    });
    await assert.rejects(
      makeAdapter(transport).read(readRequest()),
      (error) => error.code === "ANCHOR_UNAVAILABLE",
    );
  }
});

test("read errors map unavailable while every CAS outer/error result remains commit-uncertain", async () => {
  const externalError = (operation) => operation === "read"
    ? {
        code: "STALE_READ", message: null, retryable: false,
        retryAfterMs: null, commitDisposition: "not_applicable",
      }
    : {
        code: "CAPACITY_EXHAUSTED", message: null, retryable: true,
        retryAfterMs: 250, commitDisposition: "proven_no_commit",
      };
  const transport = new HandlerTransport((request) => {
    const wire = JSON.parse(Buffer.from(request.body).toString("utf8"));
    const body = jsonEnvelope(wire, { ok: false, error: externalError(wire.operation) });
    return immediateExchange(response({ body }).value).exchange;
  });
  const adapter = makeAdapter(transport);
  await assert.rejects(
    adapter.read(readRequest()),
    (error) => error.code === "ANCHOR_UNAVAILABLE",
  );
  await assert.rejects(
    adapter.compareAndSwap(casRequest()),
    (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN",
  );
  assert.equal(transport.calls.length, 2, "definite capacity rejection does not trigger adapter retry");

  const malformedCasTransport = new HandlerTransport((request) => {
    const wire = JSON.parse(Buffer.from(request.body).toString("utf8"));
    const body = JSON.stringify({
      contractVersion: 1,
      operationId: wire.operationId,
      ok: true,
      result: {},
      error: null,
      future: true,
    });
    return immediateExchange(response({ body }).value).exchange;
  });
  await assert.rejects(
    makeAdapter(malformedCasTransport).compareAndSwap(casRequest()),
    (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN",
  );
});

test("existing continuity owner alone distinguishes malformed read inner from uncertain CAS inner", async () => {
  const malformedRead = successTransport(() => ({
    protocolVersion: 1,
    status: "uninitialized",
    anchorId: ANCHOR_ID,
    casToken: "cas-0",
    adapterMustNotStripThis: true,
  }));
  const readAnchor = new continuity.RelayV2ContinuityAnchor({
    anchorId: ANCHOR_ID,
    authority: makeAdapter(malformedRead),
    operationTimeoutMs: 250,
  });
  await assert.rejects(
    readAnchor.reconcile(checkpoint()),
    (error) => error.code === "INVALID_AUTHORITY_RESPONSE",
  );

  const casTransport = new HandlerTransport((request) => {
    const wire = JSON.parse(Buffer.from(request.body).toString("utf8"));
    const result = wire.operation === "read"
      ? uninitialized()
      : { protocolVersion: 1, outcome: "swapped", current: { malformed: true } };
    const body = jsonEnvelope(wire, { ok: true, result });
    return immediateExchange(response({ body }).value).exchange;
  });
  const casAnchor = new continuity.RelayV2ContinuityAnchor({
    anchorId: ANCHOR_ID,
    authority: makeAdapter(casTransport),
    operationTimeoutMs: 250,
  });
  await assert.rejects(
    casAnchor.reconcile(checkpoint()),
    (error) => error.code === "ANCHOR_COMMIT_UNCERTAIN",
  );
});

test("anchor-owned abort destroys HTTPS I/O once and late response cannot resettle", async () => {
  const pending = deferred();
  const exchangeState = { aborts: 0 };
  const transport = new HandlerTransport(() => ({
    response: pending.promise,
    abort() { exchangeState.aborts += 1; },
  }));
  const adapter = makeAdapter(transport);
  const anchor = new continuity.RelayV2ContinuityAnchor({
    anchorId: ANCHOR_ID,
    authority: adapter,
    operationTimeoutMs: 20,
  });

  await assert.rejects(
    anchor.reconcile(checkpoint()),
    (error) => error.code === "ANCHOR_UNAVAILABLE",
  );
  assert.equal(exchangeState.aborts, 1);

  const requestWire = JSON.parse(Buffer.from(transport.calls[0].body).toString("utf8"));
  const late = response({
    body: jsonEnvelope(requestWire, { ok: true, result: uninitialized() }),
  });
  pending.resolve(late.value);
  await nextTurn();
  assert.equal(late.state.bodyReads, 0, "late response is ignored before body decode");
  assert.equal(late.state.destroys, 1, "late response is destroyed exactly once");
  assert.equal(exchangeState.aborts, 1, "late callback cannot abort or settle twice");
});

test("an own getter cannot mask pre-start abort or resolve auth and HTTPS", async () => {
  const controller = new AbortController();
  controller.abort();
  let ownAbortedGetterReads = 0;
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true,
    get() {
      ownAbortedGetterReads += 1;
      throw forgedPublicAdapterError();
    },
  });

  let authCalls = 0;
  let starts = 0;
  const adapter = new adapterModule.RelayV2ExternalContinuityAuthorityHttpsAdapter({
    endpoint: ENDPOINT,
    securityDomainId: SECURITY_DOMAIN,
    namespace: NAMESPACE,
    anchorId: ANCHOR_ID,
    authenticationHeaders: () => { authCalls += 1; return { Authorization: SECRET }; },
    transport: { start() { starts += 1; throw new Error("must not start"); } },
  });
  await assert.rejects(
    adapter.read(readRequest(controller.signal)),
    (error) => {
      assert.equal(error.code, "ANCHOR_UNAVAILABLE");
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /workload-secret/);
      return true;
    },
  );
  assert.equal(authCalls, 0);
  assert.equal(starts, 0);
  assert.equal(ownAbortedGetterReads, 0);
});
