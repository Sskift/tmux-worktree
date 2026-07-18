import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRelayV2BrokerCredentialStateStore } from "./support/inMemoryRelayV2BrokerCredentialStateStore.mjs";

const credential = await import("../dist/relay/v2/brokerCredentialAuthority.js");
const ingress = await import("../dist/relay/v2/brokerCredentialHttpIngress.js");
const issuer = await import("../dist/relay/v2/issuer.js");
const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const NOW_MS = 1_800_000_000_000;
const ANCHOR_ID = "credential-http-ingress-test";
const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
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

const VALID_REQUESTS = Object.freeze({
  enrollment_redeem: Object.freeze({
    path: ingress.RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH,
    body: Object.freeze({
      exchangeAttemptId: "exchange-attempt",
      enrollmentId: "enrollment-one",
      enrollmentCode: "twenroll2.enrollment-code",
      clientInstanceId: "client-instance",
      deviceLabel: "Pixel",
    }),
  }),
  client_refresh: Object.freeze({
    path: ingress.RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
    body: Object.freeze({
      refreshAttemptId: "client-refresh-attempt",
      grantId: "client-grant",
      clientInstanceId: "client-instance",
      refreshToken: REFRESH_TOKEN,
    }),
  }),
  host_refresh: Object.freeze({
    path: ingress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
    body: Object.freeze({
      refreshAttemptId: "host-refresh-attempt",
      grantId: "host-grant",
      hostInstanceId: "host-instance",
      refreshToken: REFRESH_TOKEN,
    }),
  }),
  self_revoke: Object.freeze({
    path: ingress.RELAY_V2_BROKER_SELF_REVOKE_PATH,
    body: Object.freeze({ reason: "user_revoked" }),
  }),
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
  if (options.authorization !== null && options.authorization !== undefined) {
    headers.push({ name: "Authorization", value: options.authorization });
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
          options.onNext?.(state.nextCalls);
          if (options.throwOnNext === state.nextCalls) throw new Error("body read failed");
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
        async return() {
          state.returnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
    async cancel() { state.cancelCalls += 1; },
  };
  return { body, state };
}

function requestFor(path, bytes, body, options = {}) {
  return {
    method: options.method ?? "POST",
    path,
    headers: options.headers ?? headersFor(bytes, options),
    body,
  };
}

class RecordingAuthority {
  constructor() {
    this.events = [];
    this.receipts = new Map();
    this.inputs = [];
    this.admitError = null;
    this.authorizeError = null;
    this.authorizationResult = CLIENT_CONTEXT;
    this.invokeError = null;
    this.clientRefreshEndpoint = "client_refresh";
  }

  async admitHttpSource(input) {
    this.events.push(`admit:${input.endpoint}`);
    if (this.admitError) throw this.admitError;
    const receipt = Object.freeze(() => undefined);
    this.receipts.set(receipt, { ...input });
    return receipt;
  }

  take(receipt, endpoint, sourceKey) {
    const record = this.receipts.get(receipt);
    if (!record || record.endpoint !== endpoint || record.sourceKey !== sourceKey) {
      throw new credential.RelayV2BrokerCredentialAuthorityError("INVALID_ARGUMENT");
    }
    this.receipts.delete(receipt);
  }

  releaseHttpSourceAdmission(receipt, endpoint, sourceKey) {
    this.events.push(`release:${endpoint}`);
    this.take(receipt, endpoint, sourceKey);
  }

  async authorizeAccessToken(token, role) {
    this.events.push("authorize");
    if (this.authorizeError) throw this.authorizeError;
    assert.equal(token, ACCESS_TOKEN);
    assert.equal(role, "client");
    return this.authorizationResult;
  }

  async redeemEnrollment(receipt, sourceKey, input) {
    this.events.push("invoke:enrollment_redeem");
    this.take(receipt, "enrollment_redeem", sourceKey);
    this.inputs.push({ endpoint: "enrollment_redeem", sourceKey, input: structuredClone(input) });
    if (this.invokeError) throw this.invokeError;
    return {
      endpoint: "enrollment_redeem",
      body: { exchangeAttemptId: input.exchangeAttemptId, ...CLIENT_GRANT_BODY },
      replayed: false,
    };
  }

  async refreshClientGrantFromHttp(receipt, sourceKey, input) {
    this.events.push("invoke:client_refresh");
    this.take(receipt, "client_refresh", sourceKey);
    this.inputs.push({ endpoint: "client_refresh", sourceKey, input: structuredClone(input) });
    if (this.invokeError) throw this.invokeError;
    return {
      endpoint: this.clientRefreshEndpoint,
      body: { refreshAttemptId: input.refreshAttemptId, ...CLIENT_GRANT_BODY },
      replayed: false,
    };
  }

  async refreshHostGrantFromHttp(receipt, sourceKey, input) {
    this.events.push("invoke:host_refresh");
    this.take(receipt, "host_refresh", sourceKey);
    this.inputs.push({ endpoint: "host_refresh", sourceKey, input: structuredClone(input) });
    if (this.invokeError) throw this.invokeError;
    return {
      endpoint: "host_refresh",
      body: { refreshAttemptId: input.refreshAttemptId, ...HOST_GRANT_BODY },
      replayed: false,
    };
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
    if (this.invokeError) throw this.invokeError;
    return { grantId: context.grantId, revokedAtMs: NOW_MS, alreadyRevoked: false };
  }
}

async function handleFake(endpoint, options = {}) {
  const authority = options.authority ?? new RecordingAuthority();
  const fixture = VALID_REQUESTS[endpoint];
  const bytes = options.bytes ?? jsonBytes(fixture.body);
  const stream = options.stream ?? controlledBody([bytes]);
  const authorization = endpoint === "self_revoke" ? `Bearer ${ACCESS_TOKEN}` : null;
  const response = await ingress.handleRelayV2BrokerCredentialHttpIngress(
    authority,
    options.sourceKey ?? "trusted-source",
    requestFor(
      options.path ?? fixture.path,
      bytes,
      stream.body,
      { authorization, ...(options.request ?? {}) },
    ),
  );
  return { authority, stream, response };
}

test("four frozen routes require exact POST path and reject every query before body read", async (t) => {
  for (const [endpoint, fixture] of Object.entries(VALID_REQUESTS)) {
    for (const change of [
      { name: "method", method: "GET", path: fixture.path },
      { name: "query", path: `${fixture.path}?credential=forbidden` },
      { name: "trailing slash", path: `${fixture.path}/` },
    ]) {
      await t.test(`${endpoint} ${change.name}`, async () => {
        const bytes = jsonBytes(fixture.body);
        const stream = controlledBody([bytes]);
        const authority = new RecordingAuthority();
        const response = await ingress.handleRelayV2BrokerCredentialHttpIngress(
          authority,
          "trusted-source",
          requestFor(change.path, bytes, stream.body, {
            method: change.method,
            authorization: endpoint === "self_revoke" ? `Bearer ${ACCESS_TOKEN}` : null,
          }),
        );
        assert.equal(response.status, 404);
        assert.equal(responseJson(response).error.code, "INVALID_ENVELOPE");
        assertClosedHeaders(response);
        assert.equal(stream.state.iteratorCalls, 0);
        assert.equal(stream.state.nextCalls, 0);
        assert.equal(stream.state.cancelCalls, 1);
        assert.deepEqual(authority.events, []);
      });
    }
  }
});

test("headers, source admission, counting reader, and strict codec all close before authority input", async (t) => {
  const fixture = VALID_REQUESTS.client_refresh;
  const bytes = jsonBytes(fixture.body);
  for (const item of [
    { name: "declared oversize", request: { contentLength: "16385" }, status: 413 },
    { name: "compressed", request: { contentEncoding: "gzip" }, status: 415 },
    {
      name: "content type parameter",
      request: {
        headers: headersFor(bytes).map((header) => header.name === "Content-Type"
          ? { ...header, value: "application/json; charset=utf-8" }
          : header),
      },
      status: 415,
    },
  ]) {
    await t.test(item.name, async () => {
      const { authority, stream, response } = await handleFake("client_refresh", {
        request: item.request,
      });
      assert.equal(response.status, item.status);
      assert.equal(stream.state.nextCalls, 0);
      assert.equal(stream.state.cancelCalls, 1);
      assert.deepEqual(authority.events, []);
    });
  }

  await t.test("source rate rejection precedes body", async () => {
    const authority = new RecordingAuthority();
    authority.admitError = new credential.RelayV2BrokerCredentialAuthorityError("RATE_LIMITED");
    const stream = controlledBody([jsonBytes("not-json")]);
    const { response } = await handleFake("client_refresh", {
      authority,
      stream,
      bytes: jsonBytes("not-json"),
    });
    assert.equal(response.status, 429);
    assert.equal(stream.state.nextCalls, 0);
    assert.equal(stream.state.cancelCalls, 1);
    assert.deepEqual(authority.events, ["admit:client_refresh"]);
  });

  await t.test("unknown length stops at byte 16385 and releases exact receipt", async () => {
    const stream = controlledBody([new Uint8Array(16_384), Uint8Array.of(1)]);
    const { authority, response } = await handleFake("host_refresh", {
      stream,
      bytes: new Uint8Array(16_384),
      request: { contentLength: null },
    });
    assert.equal(response.status, 413);
    assert.equal(stream.state.nextCalls, 2);
    assert.equal(stream.state.cancelCalls, 1);
    assert.equal(stream.state.returnCalls, 1);
    assert.deepEqual(authority.events, ["admit:host_refresh", "release:host_refresh"]);
    assert.equal(authority.receipts.size, 0);
  });

  const duplicate = JSON.stringify(fixture.body).replace(
    `"grantId":"${fixture.body.grantId}"`,
    `"grantId":"${fixture.body.grantId}","grantId":"${fixture.body.grantId}"`,
  );
  const nested = `${"[".repeat(8)}0${"]".repeat(8)}`;
  const cases = [
    ["malformed", jsonBytes("{")],
    ["invalid utf8", Uint8Array.of(0xff)],
    ["duplicate", jsonBytes(duplicate)],
    ["trailing", jsonBytes(`${JSON.stringify(fixture.body)}{}`)],
    ["non-object", jsonBytes([])],
    ["depth", jsonBytes(`{"refreshAttemptId":"a","grantId":"g","clientInstanceId":${nested},"refreshToken":"twref2.x"}`)],
    ["keys", jsonBytes(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, index])))],
    ["unknown", jsonBytes({ ...fixture.body, accessToken: ACCESS_TOKEN })],
  ];
  for (const [name, invalidBytes] of cases) {
    await t.test(name, async () => {
      const { authority, response } = await handleFake("client_refresh", { bytes: invalidBytes });
      assert.equal(response.status, 400);
      assert.equal(responseJson(response).error.code, "INVALID_ENVELOPE");
      assert.equal(Buffer.from(response.body).includes(Buffer.from(REFRESH_TOKEN)), false);
      assert.deepEqual(authority.events, ["admit:client_refresh", "release:client_refresh"]);
      assert.equal(authority.receipts.size, 0);
    });
  }
});

test("each endpoint dispatches one decoded body and returns only its frozen success schema", async (t) => {
  const expectedBodies = {
    enrollment_redeem: {
      exchangeAttemptId: VALID_REQUESTS.enrollment_redeem.body.exchangeAttemptId,
      ...CLIENT_GRANT_BODY,
    },
    client_refresh: {
      refreshAttemptId: VALID_REQUESTS.client_refresh.body.refreshAttemptId,
      ...CLIENT_GRANT_BODY,
    },
    host_refresh: {
      refreshAttemptId: VALID_REQUESTS.host_refresh.body.refreshAttemptId,
      ...HOST_GRANT_BODY,
    },
    self_revoke: {
      grantId: CLIENT_CONTEXT.grantId,
      revokedAtMs: NOW_MS,
      alreadyRevoked: false,
    },
  };
  for (const endpoint of Object.keys(VALID_REQUESTS)) {
    await t.test(endpoint, async () => {
      const events = [];
      const stream = controlledBody([jsonBytes(VALID_REQUESTS[endpoint].body)], {
        onNext(call) { if (call === 1) events.push("body"); },
      });
      const authority = new RecordingAuthority();
      const originalPush = authority.events.push.bind(authority.events);
      authority.events.push = (...items) => {
        events.push(...items);
        return originalPush(...items);
      };
      const { response } = await handleFake(endpoint, { authority, stream });
      assert.equal(response.status, 200);
      assertClosedHeaders(response);
      assert.deepEqual(responseJson(response), expectedBodies[endpoint]);
      assert.deepEqual(authority.inputs[0].input, VALID_REQUESTS[endpoint].body);
      assert.equal(authority.inputs[0].sourceKey, "trusted-source");
      assert.equal(authority.receipts.size, 0);
      const bodyIndex = events.indexOf("body");
      assert.ok(events.indexOf(`admit:${endpoint}`) < bodyIndex);
      assert.ok(bodyIndex < events.indexOf(`invoke:${endpoint}`));
      if (endpoint === "self_revoke") {
        assert.ok(events.indexOf("authorize") < bodyIndex);
        assert.deepEqual(authority.inputs[0].context, CLIENT_CONTEXT);
      }
    });
  }
});

test("self-revoke authenticates one Bearer before body and body cannot supply identity", async (t) => {
  for (const item of [
    { name: "missing", authorization: null, status: 401, code: "AUTH_REQUIRED" },
    { name: "malformed", authorization: ACCESS_TOKEN, status: 401, code: "AUTH_INVALID" },
    {
      name: "duplicate",
      authorization: `Bearer ${ACCESS_TOKEN}`,
      extraHeaders: [{ name: "authorization", value: `Bearer ${ACCESS_TOKEN}` }],
      status: 401,
      code: "AUTH_INVALID",
    },
  ]) {
    await t.test(item.name, async () => {
      const bytes = jsonBytes(VALID_REQUESTS.self_revoke.body);
      const stream = controlledBody([bytes]);
      const authority = new RecordingAuthority();
      const response = await ingress.handleRelayV2BrokerCredentialHttpIngress(
        authority,
        "self-revoke-source",
        requestFor(ingress.RELAY_V2_BROKER_SELF_REVOKE_PATH, bytes, stream.body, {
          authorization: item.authorization,
          extraHeaders: item.extraHeaders,
        }),
      );
      assert.equal(response.status, item.status);
      assert.equal(responseJson(response).error.code, item.code);
      assert.equal(stream.state.nextCalls, 0);
      assert.equal(stream.state.cancelCalls, 1);
      assert.deepEqual(authority.events, ["admit:self_revoke", "release:self_revoke"]);
      assert.equal(authority.receipts.size, 0);
    });
  }

  await t.test("identity field in body", async () => {
    const bytes = jsonBytes({ reason: "user_revoked", grantId: "body-spoof" });
    const { authority, response } = await handleFake("self_revoke", { bytes });
    assert.equal(response.status, 400);
    assert.equal(responseJson(response).error.code, "INVALID_ENVELOPE");
    assert.deepEqual(authority.events, [
      "admit:self_revoke",
      "authorize",
      "release:self_revoke",
    ]);
    assert.equal(authority.inputs.length, 0);
  });
});

test("closed failures never reflect credential material or collapse a missing live fence", async (t) => {
  await t.test("authority failure", async () => {
    const authority = new RecordingAuthority();
    authority.invokeError = new credential.RelayV2BrokerCredentialAuthorityError(
      "LIVE_AUTHORIZATION_FENCE_UNAVAILABLE",
    );
    const { response } = await handleFake("client_refresh", { authority });
    assert.equal(response.status, 503);
    assert.equal(responseJson(response).error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(Buffer.from(response.body).includes(Buffer.from(REFRESH_TOKEN)), false);
    assertClosedHeaders(response);
  });

  await t.test("invalid success shape", async () => {
    const authority = new RecordingAuthority();
    authority.clientRefreshEndpoint = "host_refresh";
    const { response } = await handleFake("client_refresh", { authority });
    assert.equal(response.status, 500);
    assert.equal(responseJson(response).error.code, "INTERNAL");
    assert.equal(Buffer.from(response.body).includes(Buffer.from(ACCESS_TOKEN)), false);
    assert.equal(Buffer.from(response.body).includes(Buffer.from(REFRESH_TOKEN)), false);
  });

  await t.test("post-revoke authorization is closed as invalid", async () => {
    const authority = new RecordingAuthority();
    authority.authorizeError = new credential.RelayV2BrokerCredentialAuthorityError(
      "PERMISSION_DENIED",
    );
    const { response, stream } = await handleFake("self_revoke", { authority });
    assert.equal(response.status, 401);
    assert.equal(responseJson(response).error.code, "AUTH_INVALID");
    assert.equal(stream.state.nextCalls, 0);
    assert.deepEqual(authority.events, [
      "admit:self_revoke",
      "authorize",
      "release:self_revoke",
    ]);
  });

  await t.test("malformed authorization success releases before ownership transfer", async () => {
    const authority = new RecordingAuthority();
    authority.authorizationResult = { ...CLIENT_CONTEXT };
    delete authority.authorizationResult.authorizationFence;
    const { response, stream } = await handleFake("self_revoke", { authority });
    assert.equal(response.status, 500);
    assert.equal(responseJson(response).error.code, "INTERNAL");
    assert.equal(stream.state.nextCalls, 0);
    assert.deepEqual(authority.events, [
      "admit:self_revoke",
      "authorize",
      "release:self_revoke",
    ]);
    assert.equal(authority.receipts.size, 0);
    assert.equal(authority.inputs.length, 0);
  });
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

  async read() { return structuredClone(this.current); }

  async compareAndSwap(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return { protocolVersion: VERSION, outcome: "conflict", current: structuredClone(this.current) };
    }
    this.current = {
      protocolVersion: VERSION,
      status: "committed",
      anchorId: ANCHOR_ID,
      casToken: `cas-${++this.token}`,
      checkpoint: structuredClone(request.next),
    };
    return { protocolVersion: VERSION, outcome: "swapped", current: structuredClone(this.current) };
  }
}

function authorityOptions(store, external, liveAuthorizationFence) {
  let id = 0;
  let byte = 0;
  return {
    store,
    continuityAnchor: { anchorId: ANCHOR_ID, authority: external, operationTimeoutMs: 100 },
    genesis: {
      issuerKeyring: issuer.createRelayV2IssuerKeyring({
        issuerId: "credential-http-issuer",
        kid: "credential-http-kid",
        secretBase64url: Buffer.alloc(32, 7).toString("base64url"),
        nowSeconds: Math.floor(NOW_MS / 1_000),
      }),
      issuerUrl: "https://relay.example.com/",
      relayUrl: "wss://relay.example.com/client",
    },
    now: () => NOW_MS,
    randomId: () => `credential-http-id-${++id}`,
    randomBytes: (length) => {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) output[index] = (byte + index + 1) % 256;
      byte = (byte + length) % 256;
      return output;
    },
    liveAuthorizationFence,
  };
}

async function realRequest(authority, path, body, options = {}) {
  const bytes = jsonBytes(body);
  return ingress.handleRelayV2BrokerCredentialHttpIngress(
    authority,
    options.sourceKey ?? "real-http-source",
    requestFor(path, bytes, controlledBody([bytes]).body, {
      authorization: options.accessToken ? `Bearer ${options.accessToken}` : null,
    }),
  );
}

test("slow bodies cannot outlive source admission and withdrawal settles the race", async (t) => {
  await t.test("refresh receipt expires at trusted mutation time", async () => {
    let now = NOW_MS;
    const store = new InMemoryRelayV2BrokerCredentialStateStore();
    const options = authorityOptions(
      store,
      new MemoryContinuityAuthority(),
      undefined,
    );
    options.now = () => now;
    const authority = await credential.RelayV2BrokerCredentialAuthority.open(options);
    try {
      const bootstrap = await authority.adminCreateHostBootstrap();
      const bootstrapAdmission = await authority.admitHttpSource({
        endpoint: "host_bootstrap",
        sourceKey: "slow-bootstrap-source",
      });
      const hostCredential = await authority.bootstrapHost(
        bootstrapAdmission,
        "slow-bootstrap-source",
        {
          bootstrapAttemptId: "slow-bootstrap-attempt",
          bootstrapToken: bootstrap.bootstrapToken,
          hostId: "slow-host",
          hostEpoch: "slow-host-epoch",
          hostInstanceId: "slow-host-instance",
        },
      );
      const input = {
        refreshAttemptId: "slow-host-refresh",
        grantId: hostCredential.body.grantId,
        hostInstanceId: "slow-host-instance",
        refreshToken: hostCredential.body.refreshToken,
      };
      const bytes = jsonBytes(input);
      const stream = controlledBody([bytes], {
        onNext(call) {
          if (call === 1) now += 15_001;
        },
      });
      const originalAdmit = authority.admitHttpSource.bind(authority);
      let expiredReceipt;
      authority.admitHttpSource = async (input) => {
        expiredReceipt = await originalAdmit(input);
        return expiredReceipt;
      };
      const comparesBefore = store.compareAndPublishCalls;
      const expired = await ingress.handleRelayV2BrokerCredentialHttpIngress(
        authority,
        "slow-refresh-source",
        requestFor(
          ingress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
          bytes,
          stream.body,
        ),
      );
      assert.equal(expired.status, 400);
      assert.equal(responseJson(expired).error.code, "INVALID_ENVELOPE");
      assert.equal(store.compareAndPublishCalls, comparesBefore + 1);
      assert.equal(
        JSON.parse(Buffer.from(store.snapshotBytes()).toString("utf8"))
          .grants.find((grant) => grant.grantId === hostCredential.body.grantId)
          .credentialVersion,
        "1",
      );
      await assert.rejects(
        authority.refreshHostGrantFromHttp(
          expiredReceipt,
          "slow-refresh-source",
          input,
        ),
        (error) => error instanceof credential.RelayV2BrokerCredentialAuthorityError
          && error.code === "INVALID_ARGUMENT",
      );
      authority.admitHttpSource = originalAdmit;

      const fresh = await realRequest(
        authority,
        ingress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
        input,
        { sourceKey: "fresh-refresh-source" },
      );
      assert.equal(fresh.status, 200);
    } finally {
      await authority.close();
    }
  });

  await t.test("authority withdrawal after admission completes without a dangling receipt", async () => {
    const store = new InMemoryRelayV2BrokerCredentialStateStore();
    const authority = await credential.RelayV2BrokerCredentialAuthority.open(
      authorityOptions(store, new MemoryContinuityAuthority(), undefined),
    );
    const originalAdmit = authority.admitHttpSource.bind(authority);
    let withdrawnReceipt;
    authority.admitHttpSource = async (input) => {
      withdrawnReceipt = await originalAdmit(input);
      return withdrawnReceipt;
    };
    let closing;
    const bytes = jsonBytes(VALID_REQUESTS.enrollment_redeem.body);
    const stream = controlledBody([bytes], {
      onNext(call) {
        if (call === 1) closing = authority.close();
      },
    });
    const response = await ingress.handleRelayV2BrokerCredentialHttpIngress(
      authority,
      "withdraw-race-source",
      requestFor(
        ingress.RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH,
        bytes,
        stream.body,
      ),
    );
    await closing;
    assert.equal(response.status, 503);
    assert.equal(responseJson(response).error.code, "CAPABILITY_UNAVAILABLE");
    assertClosedHeaders(response);
    assert.equal(JSON.parse(Buffer.from(store.snapshotBytes()).toString("utf8")).grants.length, 0);
    assert.equal(authority.authorityContinuityReadiness.status, "closed");
    assert.throws(
      () => authority.releaseHttpSourceAdmission(
        withdrawnReceipt,
        "enrollment_redeem",
        "withdraw-race-source",
      ),
      (error) => error instanceof credential.RelayV2BrokerCredentialAuthorityError
        && error.code === "INVALID_ARGUMENT",
    );
  });
});

test("real authority preserves T2 exact refresh replay and settles self-revoke fence before success", async () => {
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const fenceEvents = [];
  let pendingFence = false;
  store.onCompareAndPublish = ({ defaultPublish }) => {
    const result = defaultPublish();
    if (pendingFence) fenceEvents.push("durable_publish");
    return result;
  };
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), {
      begin(invalidation) {
        fenceEvents.push({ type: "pending", invalidation });
        pendingFence = true;
        return {
          committed(receipt) {
            fenceEvents.push({ type: "committed", receipt });
            pendingFence = false;
          },
          cancelled() { fenceEvents.push({ type: "cancelled" }); pendingFence = false; },
          failClosed() { fenceEvents.push({ type: "fail_closed" }); pendingFence = false; },
        };
      },
      failClosed() {},
    }),
  );
  try {
    const bootstrap = await authority.adminCreateHostBootstrap();
    const bootstrapAdmission = await authority.admitHttpSource({
      endpoint: "host_bootstrap",
      sourceKey: "real-bootstrap-source",
    });
    const hostCredential = await authority.bootstrapHost(
      bootstrapAdmission,
      "real-bootstrap-source",
      {
        bootstrapAttemptId: "real-bootstrap-attempt",
        bootstrapToken: bootstrap.bootstrapToken,
        hostId: "real-host",
        hostEpoch: "real-host-epoch",
        hostInstanceId: "real-host-instance",
      },
    );

    const hostRefreshInput = {
      refreshAttemptId: "real-host-refresh",
      grantId: hostCredential.body.grantId,
      hostInstanceId: "real-host-instance",
      refreshToken: hostCredential.body.refreshToken,
    };
    const firstHostRefresh = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
      hostRefreshInput,
      { sourceKey: "real-host-refresh-source" },
    );
    assert.equal(firstHostRefresh.status, 200);
    await authority.adminRotateReplayKey({ rotationId: "after-host-refresh" });
    const replayedHostRefresh = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
      hostRefreshInput,
      { sourceKey: "real-host-refresh-source" },
    );
    assert.deepEqual(replayedHostRefresh.body, firstHostRefresh.body);
    const oldHostRefresh = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
      { ...hostRefreshInput, refreshAttemptId: "real-host-refresh-new-attempt" },
      { sourceKey: "real-host-refresh-source" },
    );
    assert.equal(oldHostRefresh.status, 401);
    assert.equal(responseJson(oldHostRefresh).error.code, "AUTH_INVALID");

    const hostAuthorization = await authority.authorizeAccessToken(
      responseJson(firstHostRefresh).accessToken,
      "host",
    );
    const enrollment = await authority.handle({
      type: "enrollment.create",
      requestId: "real-enrollment-create",
      connectorId: "real-connector",
      payload: { expiresInMs: 300_000, deviceLabel: "Pixel" },
      currentAuthContext: hostAuthorization,
    });
    assert.equal(enrollment.outcome, "success");
    const redeemInput = {
      exchangeAttemptId: "real-exchange",
      enrollmentId: enrollment.response.payload.enrollmentId,
      enrollmentCode: enrollment.response.payload.enrollmentCode,
      clientInstanceId: "real-client-instance",
      deviceLabel: "Pixel",
    };
    const redeemed = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH,
      redeemInput,
      { sourceKey: "real-redeem-source" },
    );
    assert.equal(redeemed.status, 200);
    const redeemedBody = responseJson(redeemed);

    const clientRefreshInput = {
      refreshAttemptId: "real-client-refresh",
      grantId: redeemedBody.grantId,
      clientInstanceId: "real-client-instance",
      refreshToken: redeemedBody.refreshToken,
    };
    const firstClientRefresh = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
      clientRefreshInput,
      { sourceKey: "real-client-refresh-source" },
    );
    assert.equal(firstClientRefresh.status, 200);
    await authority.adminRotateReplayKey({ rotationId: "after-client-refresh" });
    const replayedClientRefresh = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
      clientRefreshInput,
      { sourceKey: "real-client-refresh-source" },
    );
    assert.deepEqual(replayedClientRefresh.body, firstClientRefresh.body);
    const oldClientRefresh = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
      { ...clientRefreshInput, refreshAttemptId: "real-client-refresh-new-attempt" },
      { sourceKey: "real-client-refresh-source" },
    );
    assert.equal(oldClientRefresh.status, 401);
    const state = JSON.parse(Buffer.from(store.snapshotBytes()).toString("utf8"));
    assert.equal(state.grants.find((grant) => grant.grantId === redeemedBody.grantId).credentialVersion, "2");
    assert.equal(state.grants.find((grant) => grant.grantId === hostCredential.body.grantId).credentialVersion, "2");

    const currentClient = responseJson(firstClientRefresh);
    const selfRevoked = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_SELF_REVOKE_PATH,
      { reason: "user_revoked" },
      { sourceKey: "real-self-revoke-source", accessToken: currentClient.accessToken },
    );
    assert.equal(selfRevoked.status, 200);
    assert.deepEqual(responseJson(selfRevoked), {
      grantId: currentClient.grantId,
      revokedAtMs: NOW_MS,
      alreadyRevoked: false,
    });
    assert.equal(fenceEvents.at(-3).type, "pending");
    assert.equal(fenceEvents.at(-2), "durable_publish");
    assert.equal(fenceEvents.at(-1).type, "committed");
    assert.deepEqual(fenceEvents.at(-3).invalidation, {
      reason: "grant_revoked",
      role: "client",
      hostId: currentClient.hostId,
      grantId: currentClient.grantId,
    });

    const afterCommit = await realRequest(
      authority,
      ingress.RELAY_V2_BROKER_SELF_REVOKE_PATH,
      { reason: "user_revoked" },
      { sourceKey: "real-self-revoke-source", accessToken: currentClient.accessToken },
    );
    assert.equal(afterCommit.status, 401);
    assert.equal(responseJson(afterCommit).error.code, "AUTH_INVALID");
    assertClosedHeaders(afterCommit);
  } finally {
    await authority.close();
  }
});
