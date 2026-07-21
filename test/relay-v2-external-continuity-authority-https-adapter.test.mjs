import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const adapterModule = await import(
  "../dist/relay/v2/externalContinuityAuthorityHttpsAdapter.js"
);
const configModule = await import(
  "../dist/relay/v2/externalContinuityAuthorityConfig.js"
);
const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const ENDPOINT = "https://continuity.example.test/external/continuity/v1";
const SECURITY_DOMAIN = "domain-a";
const NAMESPACE = "broker-credential.v1";
const ANCHOR_ID = "anchor-broker-a";
const SECRET = "Bearer workload-secret-never-reflect";
const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
const E0_BASE_CONFIG = {
  configVersion: 1,
  endpoint: ENDPOINT,
  securityDomainId: SECURITY_DOMAIN,
  authenticationMode: "mutual_tls",
  credentialReference: "mtls-credential-a",
  tlsTrustReference: "private-trust-a",
  operationTimeoutMs: 250,
  maxPendingOperations: 4,
  namespaceBindings: [{
    namespace: NAMESPACE, ownerBinding: "broker-owner-a", anchorId: ANCHOR_ID,
  }],
};

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

test("closed E0 config rejects hostile shape, invalid references, duplicate bindings, and limits before resolution", () => {
  let resolverCalls = 0;
  let transportCalls = 0;
  const resolved = Object.freeze({
    authenticationHeaders: () => ({ Authorization: SECRET }),
    transport: Object.freeze({
      start() { transportCalls += 1; throw new Error("must not start"); },
      discard() { transportCalls += 1; },
    }),
  });
  const provider = Object.freeze({
    resolveAttempt() { resolverCalls += 1; return resolved; },
  });
  const base = E0_BASE_CONFIG;
  const accessor = { ...base };
  Object.defineProperty(accessor, "credentialReference", {
    enumerable: true,
    get() { throw new Error(`accessor ${SECRET}`); },
  });
  const symbolKey = { ...base };
  symbolKey[Symbol("future")] = true;
  const invalid = [
    { ...base, future: true },
    accessor,
    symbolKey,
    new Proxy(base, {}),
    { ...base, credentialReference: "../credential" },
    { ...base, operationTimeoutMs: 0 },
    { ...base, maxPendingOperations: 1_025 },
    { ...base,
      namespaceBindings: [base.namespaceBindings[0], {
        namespace: NAMESPACE, ownerBinding: "other-owner", anchorId: "other-anchor",
      }],
    },
    { ...base,
      namespaceBindings: [base.namespaceBindings[0], {
        namespace: "agent-transcript-lifecycle.v1",
        ownerBinding: "host-a:epoch-a", anchorId: ANCHOR_ID,
      }],
    },
  ];

  for (const config of invalid) {
    assert.throws(() => configModule.bindRelayV2ExternalContinuityAuthorityConfig(
      config, provider,
    ), { name: "TypeError" });
  }
  assert.equal(resolverCalls, 0);
  assert.equal(transportCalls, 0);
});

test("valid E0 bindings are immutable Anchor options and preserve exact local and wire identity", async () => {
  const resolverRequests = [];
  const transportRequests = [];
  let discards = 0;
  let provider;
  provider = Object.freeze({
    resolveAttempt(request) {
      assert.equal(this, provider);
      assert.equal(Object.getPrototypeOf(request), null);
      assert.equal(Object.isFrozen(request), true);
      resolverRequests.push(request);
      let resolved;
      let transport;
      transport = Object.freeze({
        start(transportRequest) {
          assert.equal(this, transport);
          transportRequests.push(transportRequest);
          const wire = JSON.parse(Buffer.from(transportRequest.body).toString("utf8"));
          return immediateExchange(response({ body: jsonEnvelope(wire, {
            ok: true, result: { admitted: wire.anchorId },
          }) }).value).exchange;
        },
        discard() { assert.equal(this, transport); discards += 1; },
      });
      resolved = Object.freeze({
        authenticationHeaders() { assert.equal(this, resolved); return { Authorization: SECRET }; },
        transport,
      });
      return resolved;
    },
  });
  const config = {
    ...E0_BASE_CONFIG,
    authenticationMode: "workload_identity",
    credentialReference: "credential-ref-a",
    tlsTrustReference: "trust-ref-a",
    maxPendingOperations: 2,
    namespaceBindings: [
      { namespace: NAMESPACE, ownerBinding: "broker-owner-a", anchorId: ANCHOR_ID },
      { namespace: "agent-transcript-lifecycle.v1", ownerBinding: "host-a:epoch-a",
        anchorId: "anchor-agent-a" },
    ],
  };
  const binding = configModule.bindRelayV2ExternalContinuityAuthorityConfig(config, provider);
  assert.equal(resolverRequests.length, 0, "binding is inert");
  assert.equal(transportRequests.length, 0, "binding creates no HTTPS attempt");
  assert.equal(Object.getPrototypeOf(binding), null);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.namespaceBindings), true);
  assert.deepEqual(Reflect.ownKeys(binding), ["namespaceBindings"]);

  for (const [index, item] of binding.namespaceBindings.entries()) {
    const options = item.continuityAnchorOptions;
    const authority = options.authority;
    assert.deepEqual([item.namespace, item.ownerBinding, item.anchorId], [
      config.namespaceBindings[index].namespace,
      config.namespaceBindings[index].ownerBinding,
      config.namespaceBindings[index].anchorId,
    ]);
    for (const [value, keys] of [
      [item, ["namespace", "ownerBinding", "anchorId", "continuityAnchorOptions"]],
      [options, ["anchorId", "authority", "operationTimeoutMs", "maxPendingOperations"]],
      [authority, ["read", "compareAndSwap"]],
    ]) {
      assert.equal(Object.getPrototypeOf(value), null);
      assert.equal(Object.isFrozen(value), true);
      assert.deepEqual(Reflect.ownKeys(value), keys);
    }
    assert.equal(item.continuityAnchorOptions.anchorId, item.anchorId);
    assert.equal(options.operationTimeoutMs, 250);
    assert.equal(options.maxPendingOperations, 2);
    assert.doesNotThrow(() => new continuity.RelayV2ContinuityAnchor(options));
    await authority.read({
      protocolVersion: VERSION,
      anchorId: item.anchorId,
      signal: new AbortController().signal,
    });
  }

  assert.equal(resolverRequests.length, 2, "each binding performs one read attempt");
  assert.equal(transportRequests.length, 2, "each read uses one exchange");
  assert.equal(discards, 0, "a started attempt cannot also be discarded");
  for (const request of resolverRequests) {
    assert.deepEqual({ ...request }, {
      endpoint: ENDPOINT,
      authenticationMode: "workload_identity",
      credentialReference: "credential-ref-a",
      tlsTrustReference: "trust-ref-a",
    });
  }
  for (const request of transportRequests) {
    assert.equal(request.endpoint, ENDPOINT);
    assert.equal(request.headers.Authorization, SECRET);
    const wire = JSON.parse(Buffer.from(request.body).toString("utf8"));
    assert.equal(wire.securityDomainId, SECURITY_DOMAIN);
    assert.ok(binding.namespaceBindings.some(
      (item) => item.namespace === wire.namespace && item.anchorId === wire.anchorId,
    ));
    const encoded = JSON.stringify(wire);
    assert.doesNotMatch(encoded, /broker-owner-a|host-a:epoch-a|workload-secret/);
    assert.equal(Object.hasOwn(wire, "ownerBinding"), false);
  }

  const firstAuthority = binding.namespaceBindings[0].continuityAnchorOptions.authority;
  const providerCallsBeforeBorrow = resolverRequests.length;
  await assert.rejects(Reflect.apply(firstAuthority.read, Object.create(null), [readRequest()]),
    (error) => error.code === "ANCHOR_UNAVAILABLE");
  assert.equal(resolverRequests.length, providerCallsBeforeBorrow, "foreign receiver is inert");
});

test("E0 attempts reject hostile callables, discard pre-start faults, and preserve fault mapping", async () => {
  const config = E0_BASE_CONFIG;
  const bindAuthority = (provider) => configModule
    .bindRelayV2ExternalContinuityAuthorityConfig(config, provider)
    .namespaceBindings[0].continuityAnchorOptions.authority;

  let proxiedResolveCalls = 0;
  const proxiedResolve = new Proxy(() => { proxiedResolveCalls += 1; }, {});
  assert.throws(() => bindAuthority(Object.freeze({ resolveAttempt: proxiedResolve })),
    { name: "TypeError" });
  assert.equal(proxiedResolveCalls, 0);

  for (const [mode, operation, expectedCode] of [
    ["invalid_headers", "read", "ANCHOR_UNAVAILABLE"],
    ["auth_abort", "read", "ANCHOR_UNAVAILABLE"],
    ["auth_proxy", "read", "ANCHOR_UNAVAILABLE"],
    ["start_proxy", "read", "ANCHOR_UNAVAILABLE"],
    ["discard_proxy", "read", "ANCHOR_UNAVAILABLE"],
    ["transport_non_frozen", "read", "ANCHOR_UNAVAILABLE"],
    ["transport_extra_field", "read", "ANCHOR_UNAVAILABLE"],
    ["provider_failure", "read", "ANCHOR_UNAVAILABLE"],
    ["transport_failure", "cas", "ANCHOR_COMMIT_UNCERTAIN"],
  ]) {
    const state = { resolves: 0, auths: 0, starts: 0, aborts: 0, discards: 0 };
    const controller = new AbortController();
    let resolved;
    let transport;
    function authenticationHeaders() {
      assert.equal(this, resolved);
      state.auths += 1;
      if (mode === "auth_abort") controller.abort();
      return mode === "invalid_headers"
        ? { Authorization: `${SECRET}\r\nforged` }
        : { Authorization: SECRET };
    }
    function start() {
      assert.equal(this, transport);
      state.starts += 1;
      if (mode !== "transport_failure") throw new Error(`must not start ${SECRET}`);
      return {
        response: Promise.reject(new Error(`transport failed ${SECRET}`)),
        abort() { state.aborts += 1; },
      };
    }
    function discard() {
      assert.equal(this, transport); state.discards += 1;
    }
    const transportShape = {
      start: mode === "start_proxy" ? new Proxy(start, {}) : start,
      discard: mode === "discard_proxy" ? new Proxy(discard, {}) : discard,
    };
    if (mode === "transport_extra_field") transportShape.future = true;
    transport = mode === "transport_non_frozen"
      ? transportShape : Object.freeze(transportShape);
    resolved = Object.freeze({
      authenticationHeaders: mode === "auth_proxy"
        ? new Proxy(authenticationHeaders, {}) : authenticationHeaders,
      transport,
    });
    const provider = Object.freeze({
      resolveAttempt() {
        state.resolves += 1;
        if (mode === "provider_failure") throw new Error(`provider failed ${SECRET}`);
        return resolved;
      },
    });
    const authority = bindAuthority(provider);
    assert.equal(state.resolves, 0, `${mode} remains lazy`);
    const attempt = operation === "read"
      ? authority.read(readRequest(controller.signal))
      : authority.compareAndSwap(casRequest(controller.signal));
    await assert.rejects(
      attempt,
      (error) => {
        assert.equal(error.code, expectedCode, mode);
        assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /workload-secret/);
        return true;
      },
    );
    assert.equal(state.resolves, 1, mode);
    assert.equal(
      state.auths,
      ["invalid_headers", "auth_abort", "transport_failure"].includes(mode) ? 1 : 0,
      mode,
    );
    assert.equal(state.starts, mode === "transport_failure" ? 1 : 0, mode);
    assert.equal(state.aborts, mode === "transport_failure" ? 1 : 0, mode);
    assert.equal(
      state.discards,
      [
        "invalid_headers", "auth_abort", "auth_proxy", "start_proxy",
        "transport_non_frozen", "transport_extra_field",
      ].includes(mode) ? 1 : 0,
      `${mode} converges once through a valid discard`,
    );
  }
});
