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
} from "node:https";
import {
  createRequire,
  syncBuiltinESMExports,
} from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const mutableNodeHttps = require("node:https");
const mutableNodeTls = require("node:tls");
const mutableNodeUtil = require("node:util");
const TEST_REFLECT_APPLY = Reflect.apply;
const TEST_REFLECT_OWN_KEYS = Reflect.ownKeys;
const TEST_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const TEST_OBJECT_FREEZE = Object.freeze;
const TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const TEST_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const TEST_OBJECT_HAS_OWN = Object.hasOwn;
const TEST_OBJECT_IS_FROZEN = Object.isFrozen;
const TEST_JSON_STRINGIFY = JSON.stringify;
const TEST_TYPED_ARRAY_PROTOTYPE =
  TEST_OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype);
const TEST_TYPED_ARRAY_BYTE_LENGTH_DESCRIPTOR =
  TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    TEST_TYPED_ARRAY_PROTOTYPE,
    "byteLength",
  );
const TEST_TYPED_ARRAY_BUFFER_DESCRIPTOR =
  TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    TEST_TYPED_ARRAY_PROTOTYPE,
    "buffer",
  );
const TEST_TYPED_ARRAY_BYTE_OFFSET_DESCRIPTOR =
  TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    TEST_TYPED_ARRAY_PROTOTYPE,
    "byteOffset",
  );
const TEST_TYPED_ARRAY_LENGTH_DESCRIPTOR =
  TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    TEST_TYPED_ARRAY_PROTOTYPE,
    "length",
  );
const TEST_TYPED_ARRAY_BYTE_LENGTH =
    TEST_TYPED_ARRAY_BYTE_LENGTH_DESCRIPTOR.get;
const TEST_TEXT_DECODER = new TextDecoder("utf-8");
const TEST_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TEST_URL_PROTOTYPE = URL.prototype;
const TEST_URL_MEMBER_NAMES = [
  "protocol",
  "hostname",
  "username",
  "password",
  "pathname",
  "search",
  "hash",
  "port",
  "origin",
  "toString",
];
const TEST_URL_MEMBER_DESCRIPTORS = new Map(
  TEST_URL_MEMBER_NAMES.map((name) => [
    name,
    TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TEST_URL_PROTOTYPE, name),
  ]),
);

function installUrlPrototypePoison(onCall) {
  for (const name of TEST_URL_MEMBER_NAMES) {
    const descriptor = TEST_URL_MEMBER_DESCRIPTORS.get(name);
    assert.notEqual(descriptor, undefined);
    const poisoned = { ...descriptor };
    if (typeof descriptor.get === "function") {
      poisoned.get = function poisonedUrlGetter() {
        onCall(name, "get", this);
        return TEST_REFLECT_APPLY(descriptor.get, this, []);
      };
    }
    if (typeof descriptor.set === "function") {
      poisoned.set = function poisonedUrlSetter(value) {
        onCall(name, "set", this);
        return TEST_REFLECT_APPLY(descriptor.set, this, [value]);
      };
    }
    if (typeof descriptor.value === "function") {
      poisoned.value = function poisonedUrlMethod(...args) {
        onCall(name, "value", this);
        return TEST_REFLECT_APPLY(descriptor.value, this, args);
      };
    }
    TEST_OBJECT_DEFINE_PROPERTY(TEST_URL_PROTOTYPE, name, poisoned);
  }
}

function restoreUrlPrototype() {
  for (const name of TEST_URL_MEMBER_NAMES) {
    TEST_OBJECT_DEFINE_PROPERTY(
      TEST_URL_PROTOTYPE,
      name,
      TEST_URL_MEMBER_DESCRIPTORS.get(name),
    );
  }
}

function testTypedArrayByteLength(value) {
  return TEST_REFLECT_APPLY(TEST_TYPED_ARRAY_BYTE_LENGTH, value, []);
}

function fixTestBufferSlots(value) {
  const buffer = TEST_REFLECT_APPLY(
    TEST_TYPED_ARRAY_BUFFER_DESCRIPTOR.get,
    value,
    [],
  );
  const byteOffset = TEST_REFLECT_APPLY(
    TEST_TYPED_ARRAY_BYTE_OFFSET_DESCRIPTOR.get,
    value,
    [],
  );
  const byteLength = testTypedArrayByteLength(value);
  const length = TEST_REFLECT_APPLY(
    TEST_TYPED_ARRAY_LENGTH_DESCRIPTOR.get,
    value,
    [],
  );
  TEST_OBJECT_DEFINE_PROPERTY(value, "buffer", {
    configurable: false,
    enumerable: false,
    value: buffer,
    writable: false,
  });
  TEST_OBJECT_DEFINE_PROPERTY(value, "byteOffset", {
    configurable: false,
    enumerable: false,
    value: byteOffset,
    writable: false,
  });
  TEST_OBJECT_DEFINE_PROPERTY(value, "byteLength", {
    configurable: false,
    enumerable: false,
    value: byteLength,
    writable: false,
  });
  TEST_OBJECT_DEFINE_PROPERTY(value, "length", {
    configurable: false,
    enumerable: false,
    value: length,
    writable: false,
  });
  return value;
}
const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const BUILD_DIRECTORY = await mkdtemp(join(tmpdir(), "tw-host-credential-https-build-"));
const TLS_DIRECTORY = await mkdtemp(join(tmpdir(), "tw-host-credential-https-tls-"));
const PRIVATE_KEY_PATH = join(TLS_DIRECTORY, "localhost-key.pem");
const CERTIFICATE_PATH = join(TLS_DIRECTORY, "localhost-cert.pem");

execFileSync(
  join(REPOSITORY, "node_modules", ".bin", "tsup"),
  [
    "--entry.v2/brokerCore", "src/relay/v2/brokerCore.ts",
    "--entry.v2/hostCredentialHttpsAdapter", "src/relay/v2/hostCredentialHttpsAdapter.ts",
    "--entry.v2/hostCarrier", "src/relay/v2/hostCarrier.ts",
    "--entry.v2/hostCredentialAuthority", "src/relay/v2/hostCredentialAuthority.ts",
    "--entry.v2/hostTlsTrustMaterial", "src/relay/v2/hostTlsTrustMaterial.ts",
    "--entry.v2/hostWssTransportLifecycle", "src/relay/v2/hostWssTransportLifecycle.ts",
    "--entry.v2/issuer", "src/relay/v2/issuer.ts",
    "--entry.v2/singleExchangeHttpsTransport", "src/relay/v2/singleExchangeHttpsTransport.ts",
    "--entry.extensions/agentTranscriptLifecycle/v1/codec",
    "src/relay/extensions/agentTranscriptLifecycle/v1/codec.ts",
    "--entry.extensions/agentChat/v2/codec",
    "src/relay/extensions/agentChat/v2/codec.ts",
    "--entry.extensions/larkBindings/v2/codec",
    "src/relay/extensions/larkBindings/v2/codec.ts",
    "--format", "esm",
    "--target", "node20",
    "--platform", "node",
    "--out-dir", BUILD_DIRECTORY,
    "--clean",
    "--no-splitting",
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
  join(BUILD_DIRECTORY, "v2", "hostCredentialHttpsAdapter.js"),
).href);
const trustMaterialModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "v2", "hostTlsTrustMaterial.js"),
).href);
const carrierModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "v2", "hostCarrier.js"),
).href);
const credentialModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "v2", "hostCredentialAuthority.js"),
).href);
const issuerModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "v2", "issuer.js"),
).href);
const wssModule = await import(pathToFileURL(
  join(BUILD_DIRECTORY, "v2", "hostWssTransportLifecycle.js"),
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
  return Buffer.from(
    typeof value === "string"
      ? value
      : TEST_REFLECT_APPLY(TEST_JSON_STRINGIFY, JSON, [value]),
    "utf8",
  );
}

function assertRedactedError(error, expectedCode) {
  assert.ok(error instanceof adapterModule.RelayV2HostCredentialHttpsAdapterError);
  assert.equal(error.code, expectedCode);
  const diagnostic =
    `${error.name}\n${error.message}\n${String(error.stack)}\n${
      TEST_REFLECT_APPLY(TEST_JSON_STRINGIFY, JSON, [error])
    }`;
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
    "Content-Length": String(testTypedArrayByteLength(bytes)),
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

const WSS_HOST_ID = "mac-admin";
const WSS_HOST_EPOCH = "host-epoch-one";
const WSS_HOST_INSTANCE_ID = "host-instance-one";
const WSS_CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:primary";

class InMemoryCredentialStorage {
  slots = new Map();
  exclusiveDepth = 0;

  runExclusive(reference, operation) {
    if (this.exclusiveDepth !== 0) throw new Error("non-reentrant storage");
    let slot = this.slots.get(reference);
    if (slot === undefined) {
      slot = { state: null, revision: 0 };
      this.slots.set(reference, slot);
    }
    this.exclusiveDepth += 1;
    try {
      return operation({
        read: () => ({
          state: slot.state === null ? null : structuredClone(slot.state),
          revision: TEST_OBJECT_FREEZE({ revision: slot.revision }),
        }),
        compareAndSwap: (_expected, replacement) => {
          slot.state = replacement === null ? null : structuredClone(replacement);
          slot.revision += 1;
          return { status: "swapped" };
        },
      });
    } finally {
      this.exclusiveDepth -= 1;
    }
  }
}

function wssCredentialHarness() {
  const storage = new InMemoryCredentialStorage();
  const authority = new credentialModule.RelayV2HostCredentialAuthority({
    storage,
    secretResolver: {
      resolve(reference) {
        if (reference === "bootstrap-secret-one") return "twhostboot2.bootstrap-one";
        throw new Error("unexpected secret reference");
      },
    },
  });
  const prepared = authority.prepareBootstrap({
    credentialReference: WSS_CREDENTIAL_REFERENCE,
    hostId: WSS_HOST_ID,
    attemptId: "bootstrap-attempt-one",
    oldSecretReference: "bootstrap-secret-one",
  });
  const keyring = issuerModule.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "host-tls-integration-key",
    secretBase64url: Buffer.alloc(32, 0x61).toString("base64url"),
    nowSeconds: 1_783_700_000,
  });
  const issued = issuerModule.prepareRelayV2AccessTokenIssuance(keyring, {
    role: "host",
    hostId: WSS_HOST_ID,
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    nowSeconds: 1_783_700_001,
    jti: "host-access-one",
  });
  const accessToken = issued.token;
  authority.applyBootstrapResponse(prepared.fence, {
    bootstrapAttemptId: "bootstrap-attempt-one",
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: WSS_HOST_ID,
    accessToken,
    accessExpiresAtMs: issued.claims.exp * 1_000,
    refreshToken: "twref2.refresh-one",
    refreshExpiresAtMs: issued.claims.exp * 1_000 + 86_400_000,
  });
  return { authority, accessToken };
}

function inspectingWebSockets() {
  const sockets = [];
  class FakeHandshakeRequest {
    authorization = null;
    setHeaderCalls = 0;
    endCalls = 0;
    destroyCalls = 0;

    setHeader(name, value) {
      this.setHeaderCalls += 1;
      if (name === "Authorization") this.authorization = value;
    }

    end() {
      this.endCalls += 1;
    }

    destroy() {
      this.destroyCalls += 1;
    }
  }

  class FakeWebSocket {
    readyState = 0;
    protocol = "";
    extensions = "";
    bufferedAmount = 0;
    listeners = new Map();

    constructor(address, protocols, options) {
      this.request = new FakeHandshakeRequest();
      this.construction = {
        address,
        protocols: [...protocols],
        optionKeys: TEST_REFLECT_OWN_KEYS(options),
        optionsFrozen: TEST_OBJECT_IS_FROZEN(options),
        rejectUnauthorized: options.rejectUnauthorized,
        checkServerIdentity: options.checkServerIdentity,
        ca: options.ca,
        hasCert: TEST_OBJECT_HAS_OWN(options, "cert"),
        hasKey: TEST_OBJECT_HAS_OWN(options, "key"),
        hasHeaders: TEST_OBJECT_HAS_OWN(options, "headers"),
      };
      sockets.push(this);
      options.finishRequest(this.request, this);
    }

    on(event, listener) {
      this.listeners.set(event, listener);
      return this;
    }

    removeListener(event, listener) {
      if (this.listeners.get(event) === listener) this.listeners.delete(event);
      return this;
    }

    send() {}

    close() {
      this.readyState = 2;
    }

    terminate() {
      this.readyState = 3;
    }

    ping() {}

    emitClose(code = 1000) {
      this.readyState = 3;
      this.listeners.get("close")?.(code);
    }
  }
  return { sockets, FakeWebSocket };
}

function wssAttempt(signal = new AbortController().signal) {
  return TEST_OBJECT_FREEZE({
    requestId: "wss-tls-integration-attempt",
    controllerGeneration: "1",
    hostId: WSS_HOST_ID,
    hostEpoch: WSS_HOST_EPOCH,
    hostInstanceId: WSS_HOST_INSTANCE_ID,
    credentialReference: WSS_CREDENTIAL_REFERENCE,
    signal,
  });
}

function prepareWssLifecycle(factory, authority, input) {
  const admission = wssModule.prepareRelayV2HostWssTransportLifecycleAttempt(
    factory,
    TEST_OBJECT_FREEZE({ ...input, credentialReferences: authority }),
  );
  assert.notEqual(admission, null);
  const lifecycle = factory.createTransportLifecycle(input);
  const actor = new carrierModule.RelayV2HostCarrierActor({
    hostId: WSS_HOST_ID,
    hostEpoch: WSS_HOST_EPOCH,
    hostInstanceId: WSS_HOST_INSTANCE_ID,
    credentialReferences: authority,
    credentialConnectionAdmission: admission,
    routeSink: {
      onRouteBound() {},
      onClientFrame() {},
      onRouteUnbound() {},
    },
    advertisedCapabilities: [],
    clientDialects: ["tw-relay.v2"],
    idFactory: () => "host-hello-one",
    onStatus() {},
  });
  return {
    lifecycle,
    connection: actor.connect(lifecycle.transport, WSS_CREDENTIAL_REFERENCE),
  };
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
    ["Content-Length", String(testTypedArrayByteLength(bytes))],
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
    const credentialIssuerCa = Uint8Array.from(CERTIFICATE);
    const originalNodeHttpsRequest = mutableNodeHttps.request;
    const originalNodeCheckServerIdentity = mutableNodeTls.checkServerIdentity;
    let poisonedNodeHttpsRequestCalls = 0;
    let poisonedNodeCheckServerIdentityCalls = 0;
    mutableNodeHttps.request = function poisonedNodeHttpsRequest(...args) {
      poisonedNodeHttpsRequestCalls += 1;
      return TEST_REFLECT_APPLY(originalNodeHttpsRequest, this, args);
    };
    mutableNodeTls.checkServerIdentity = function poisonedNodeCheckServerIdentity(...args) {
      poisonedNodeCheckServerIdentityCalls += 1;
      return TEST_REFLECT_APPLY(originalNodeCheckServerIdentity, this, args);
    };
    syncBuiltinESMExports();
    let bootstrap;
    let refresh;
    try {
      const adapter = new adapterModule.RelayV2HostCredentialHttpsAdapter({
        issuerUrl: server.issuerUrl,
        tlsTrust: { certificateAuthorities: [credentialIssuerCa] },
      });
      credentialIssuerCa.fill(0);
      bootstrap = await adapter.bootstrap(
        BOOTSTRAP_REQUEST,
        activeSignal(),
      );
      refresh = await adapter.refresh(
        REFRESH_REQUEST,
        activeSignal(),
      );
    } finally {
      mutableNodeHttps.request = originalNodeHttpsRequest;
      mutableNodeTls.checkServerIdentity = originalNodeCheckServerIdentity;
      syncBuiltinESMExports();
    }

    assert.deepEqual(bootstrap, BOOTSTRAP_RESPONSE);
    assert.deepEqual(refresh, REFRESH_RESPONSE);
    assert.equal(poisonedNodeHttpsRequestCalls, 0);
    assert.equal(poisonedNodeCheckServerIdentityCalls, 0);
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
    let ownByteLengthGetterCalls = 0;
    const ownByteLengthEntry = new Uint8Array([1]);
    Object.defineProperty(ownByteLengthEntry, "byteLength", {
      get() {
        ownByteLengthGetterCalls += 1;
        throw new Error("own byteLength getter must not run");
      },
    });
    let subclassByteLengthGetterCalls = 0;
    class ByteLengthSubclass extends Uint8Array {
      get byteLength() {
        subclassByteLengthGetterCalls += 1;
        throw new Error("subclass byteLength getter must not run");
      }
    }
    let proxyTrapCalls = 0;
    const proxyEntry = new Proxy(new Uint8Array([1]), {
      get() { proxyTrapCalls += 1; throw new Error("proxy get trap must not run"); },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("proxy descriptor trap must not run");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("proxy prototype trap must not run");
      },
      ownKeys() { proxyTrapCalls += 1; throw new Error("proxy ownKeys trap must not run"); },
    });
    for (const tlsTrust of [
      { certificateAuthorities: [] },
      { certificateAuthorities: [""] },
      { certificateAuthorities: ["A".repeat(16_385)] },
      { certificateAuthorities: [CERTIFICATE], rejectUnauthorized: false },
      { certificateAuthorities: [CERTIFICATE], cert: CERTIFICATE },
      { certificateAuthorities: [CERTIFICATE], key: PRIVATE_KEY },
      { certificateAuthorities: [CERTIFICATE], checkServerIdentity: () => undefined },
      { certificateAuthorities: [ownByteLengthEntry] },
      { certificateAuthorities: [new ByteLengthSubclass([1])] },
      { certificateAuthorities: [proxyEntry] },
    ]) {
      assert.throws(
        () => new adapterModule.RelayV2HostCredentialHttpsAdapter({
          issuerUrl: server.issuerUrl,
          tlsTrust,
        }),
        (error) => assertRedactedError(error, "CONFIGURATION_INVALID"),
      );
    }
    assert.equal(ownByteLengthGetterCalls, 0);
    assert.equal(subclassByteLengthGetterCalls, 0);
    assert.equal(proxyTrapCalls, 0);
    assert.equal(requests.length, 2, "hostile trust is rejected before network");
  } finally {
    await server.close();
  }
});

test("post-load tampering keeps complete Host HTTPS and WSS TLS lanes fixed", async (t) => {
  let httpsApplicationRequests = 0;
  const httpsResponseBody = fixTestBufferSlots(jsonBytes(BOOTSTRAP_RESPONSE));
  const httpsResponseBodyLength = String(testTypedArrayByteLength(httpsResponseBody));
  const server = await startTlsServer((_request, response) => {
    httpsApplicationRequests += 1;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Encoding": "identity",
      "Content-Length": httpsResponseBodyLength,
    });
    response.end(httpsResponseBody);
  });
  t.after(() => server.close());
  const wssCredential = wssCredentialHarness();
  const inspectingSockets = inspectingWebSockets();
  let ownByteLengthGetterCalls = 0;
  const ownByteLengthEntry = new Uint8Array([1]);
  Object.defineProperty(ownByteLengthEntry, "byteLength", {
    get() {
      ownByteLengthGetterCalls += 1;
      throw new Error("own byteLength getter must not run");
    },
  });
  let subclassByteLengthGetterCalls = 0;
  class ByteLengthSubclass extends Uint8Array {
    get byteLength() {
      subclassByteLengthGetterCalls += 1;
      throw new Error("subclass byteLength getter must not run");
    }
  }
  let proxyTrapCalls = 0;
  const proxyEntry = new Proxy(new Uint8Array([1]), {
    get() { proxyTrapCalls += 1; throw new Error("proxy get trap must not run"); },
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error("proxy descriptor trap must not run");
    },
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error("proxy prototype trap must not run");
    },
    ownKeys() { proxyTrapCalls += 1; throw new Error("proxy ownKeys trap must not run"); },
  });
  let listAccessorCalls = 0;
  const accessorList = [];
  Object.defineProperty(accessorList, "0", {
    configurable: true,
    enumerable: true,
    get() {
      listAccessorCalls += 1;
      throw new Error("list accessor must not run");
    },
  });
  class ArraySubclass extends Array {}
  const subclassList = new ArraySubclass("ca");
  const customPrototypeList = ["ca"];
  Object.setPrototypeOf(customPrototypeList, Object.create(Array.prototype));
  const extraFieldList = ["ca"];
  Object.defineProperty(extraFieldList, "extra", { value: true });
  const extraSymbolList = ["ca"];
  Object.defineProperty(extraSymbolList, Symbol("extra"), { value: true });
  const validBytes = new Uint8Array([0x43, 0x41]);
  const httpsCa = Uint8Array.from(CERTIFICATE);

  const originalObjectGetPrototypeOf = Object.getPrototypeOf;
  const originalObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const originalObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const originalObjectHasOwn = Object.hasOwn;
  const originalObjectFreeze = Object.freeze;
  const originalObjectCreate = Object.create;
  const originalObjectDefineProperty = Object.defineProperty;
  const originalObjectIsFrozen = Object.isFrozen;
  const originalObjectKeys = Object.keys;
  const originalReflectApply = Reflect.apply;
  const originalReflectConstruct = Reflect.construct;
  const originalReflectOwnKeys = Reflect.ownKeys;
  const originalJsonParse = JSON.parse;
  const originalJsonStringify = JSON.stringify;
  const originalWeakMapDelete = WeakMap.prototype.delete;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalWeakMapSet = WeakMap.prototype.set;
  const originalStringCharCodeAt = String.prototype.charCodeAt;
  const originalStringIncludes = String.prototype.includes;
  const originalStringSlice = String.prototype.slice;
  const originalStringSplit = String.prototype.split;
  const originalStringStartsWith = String.prototype.startsWith;
  const originalStringTrim = String.prototype.trim;
  const originalArrayFrom = Array.from;
  const originalArrayIsArray = Array.isArray;
  const originalNumberIsSafeInteger = Number.isSafeInteger;
  const originalBufferAllocUnsafe = Buffer.allocUnsafe;
  const originalBufferByteLength = Buffer.byteLength;
  const originalBufferFrom = Buffer.from;
  const originalBufferToString = Buffer.prototype.toString;
  const originalTextEncoder = globalThis.TextEncoder;
  const originalTextEncoderEncode = originalTextEncoder.prototype.encode;
  const originalTextDecoder = globalThis.TextDecoder;
  const originalTextDecoderDecode = originalTextDecoder.prototype.decode;
  const originalString = globalThis.String;
  const originalArraySome = Array.prototype.some;
  const originalArrayPush = Array.prototype.push;
  const originalRegExpTest = RegExp.prototype.test;
  const originalNodeUtilTypes = mutableNodeUtil.types;
  const originalNodeHttpsRequest = mutableNodeHttps.request;
  const originalNodeCheckServerIdentity = mutableNodeTls.checkServerIdentity;
  const typedArrayPrototype = TEST_TYPED_ARRAY_PROTOTYPE;
  const originalTypedArrayByteLength = TEST_TYPED_ARRAY_BYTE_LENGTH_DESCRIPTOR;
  const originalTypedArrayBuffer = TEST_TYPED_ARRAY_BUFFER_DESCRIPTOR;
  const originalTypedArrayByteOffset = TEST_TYPED_ARRAY_BYTE_OFFSET_DESCRIPTOR;
  const originalTypedArraySet = TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    typedArrayPrototype,
    "set",
  );
  const originalTypedArraySubarray = TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    typedArrayPrototype,
    "subarray",
  );
  let tamperedIntrinsicCalls = 0;
  let lastTamperedIntrinsic = "";
  const poison = (original) => function poisonedIntrinsic(...args) {
    tamperedIntrinsicCalls += 1;
    lastTamperedIntrinsic = original.name;
    return TEST_REFLECT_APPLY(original, this, args);
  };

  let capturedValid;
  let ownRejected = false;
  let subclassRejected = false;
  let proxyRejected = false;
  let accessorListRejected = false;
  let subclassListRejected = false;
  let customPrototypeListRejected = false;
  let extraFieldListRejected = false;
  let extraSymbolListRejected = false;
  let networkStarts = 0;
  let poisonedNodeHttpsRequestCalls = 0;
  let poisonedNodeCheckServerIdentityCalls = 0;
  let httpsAdapter;
  const admitThenStartNetwork = (tlsTrust) => {
    const captured = trustMaterialModule.captureRelayV2HostTlsCaTrust(tlsTrust);
    networkStarts += 1;
    return captured;
  };

  mutableNodeHttps.request = function poisonedNodeHttpsRequest(...args) {
    poisonedNodeHttpsRequestCalls += 1;
    return TEST_REFLECT_APPLY(originalNodeHttpsRequest, this, args);
  };
  mutableNodeTls.checkServerIdentity = function poisonedNodeCheckServerIdentity(...args) {
    poisonedNodeCheckServerIdentityCalls += 1;
    return TEST_REFLECT_APPLY(originalNodeCheckServerIdentity, this, args);
  };
  mutableNodeUtil.types = {
    ...originalNodeUtilTypes,
    isProxy: poison(originalNodeUtilTypes.isProxy),
  };
  syncBuiltinESMExports();
  Object.getPrototypeOf = poison(originalObjectGetPrototypeOf);
  Object.getOwnPropertyDescriptor = poison(originalObjectGetOwnPropertyDescriptor);
  Object.getOwnPropertyDescriptors = poison(originalObjectGetOwnPropertyDescriptors);
  Object.hasOwn = poison(originalObjectHasOwn);
  Object.freeze = poison(originalObjectFreeze);
  Reflect.apply = poison(originalReflectApply);
  Reflect.ownKeys = poison(originalReflectOwnKeys);
  Array.isArray = poison(originalArrayIsArray);
  Number.isSafeInteger = poison(originalNumberIsSafeInteger);
  Buffer.byteLength = poison(originalBufferByteLength);
  globalThis.String = poison(originalString);
  Array.prototype.some = poison(originalArraySome);
  Array.prototype.push = poison(originalArrayPush);
  RegExp.prototype.test = poison(originalRegExpTest);
  TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "byteLength", {
    ...originalTypedArrayByteLength,
    get: poison(originalTypedArrayByteLength.get),
  });
  TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "set", {
    ...originalTypedArraySet,
    value: poison(originalTypedArraySet.value),
  });
  installUrlPrototypePoison((name, kind) => {
    tamperedIntrinsicCalls += 1;
    lastTamperedIntrinsic = `URL.prototype.${name}.${kind}`;
  });
  try {
    httpsAdapter = new adapterModule.RelayV2HostCredentialHttpsAdapter({
      issuerUrl: server.issuerUrl,
      tlsTrust: {
        certificateAuthorities: [httpsCa],
      },
    });
    capturedValid = trustMaterialModule.captureRelayV2HostTlsCaTrust({
      certificateAuthorities: ["private-ca", validBytes],
    });
    try {
      admitThenStartNetwork({ certificateAuthorities: [ownByteLengthEntry] });
    } catch {
      ownRejected = true;
    }
    try {
      admitThenStartNetwork({
        certificateAuthorities: [new ByteLengthSubclass([1])],
      });
    } catch {
      subclassRejected = true;
    }
    try {
      admitThenStartNetwork({ certificateAuthorities: [proxyEntry] });
    } catch {
      proxyRejected = true;
    }
    try {
      admitThenStartNetwork({ certificateAuthorities: accessorList });
    } catch {
      accessorListRejected = true;
    }
    try {
      admitThenStartNetwork({ certificateAuthorities: subclassList });
    } catch {
      subclassListRejected = true;
    }
    try {
      admitThenStartNetwork({ certificateAuthorities: customPrototypeList });
    } catch {
      customPrototypeListRejected = true;
    }
    try {
      admitThenStartNetwork({ certificateAuthorities: extraFieldList });
    } catch {
      extraFieldListRejected = true;
    }
    try {
      admitThenStartNetwork({ certificateAuthorities: extraSymbolList });
    } catch {
      extraSymbolListRejected = true;
    }
    for (const tlsTrust of [
      { certificateAuthorities: [ownByteLengthEntry] },
      { certificateAuthorities: [new ByteLengthSubclass([1])] },
      { certificateAuthorities: [proxyEntry] },
      { certificateAuthorities: accessorList },
      { certificateAuthorities: subclassList },
      { certificateAuthorities: customPrototypeList },
      { certificateAuthorities: extraFieldList },
      { certificateAuthorities: extraSymbolList },
      { certificateAuthorities: ["private-ca"], cert: CERTIFICATE },
      { certificateAuthorities: ["private-ca"], key: PRIVATE_KEY },
    ]) {
      try {
        new adapterModule.RelayV2HostCredentialHttpsAdapter({
          issuerUrl: server.issuerUrl,
          tlsTrust,
        });
      } catch {
        continue;
      }
      throw new Error("hostile HTTPS trust reached transport construction");
    }
  } finally {
    restoreUrlPrototype();
    Object.getPrototypeOf = originalObjectGetPrototypeOf;
    Object.getOwnPropertyDescriptor = originalObjectGetOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = originalObjectGetOwnPropertyDescriptors;
    Object.hasOwn = originalObjectHasOwn;
    Object.freeze = originalObjectFreeze;
    Reflect.apply = originalReflectApply;
    Reflect.ownKeys = originalReflectOwnKeys;
    Array.isArray = originalArrayIsArray;
    Number.isSafeInteger = originalNumberIsSafeInteger;
    Buffer.byteLength = originalBufferByteLength;
    globalThis.String = originalString;
    Array.prototype.some = originalArraySome;
    Array.prototype.push = originalArrayPush;
    RegExp.prototype.test = originalRegExpTest;
    TEST_OBJECT_DEFINE_PROPERTY(
      typedArrayPrototype,
      "byteLength",
      originalTypedArrayByteLength,
    );
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "set", originalTypedArraySet);
    mutableNodeUtil.types = originalNodeUtilTypes;
    mutableNodeHttps.request = originalNodeHttpsRequest;
    mutableNodeTls.checkServerIdentity = originalNodeCheckServerIdentity;
    syncBuiltinESMExports();
  }

  validBytes.fill(0);
  assert.deepEqual(capturedValid.certificateAuthorities, [
    "private-ca",
    new Uint8Array([0x43, 0x41]),
  ]);
  assert.equal(tamperedIntrinsicCalls, 0, lastTamperedIntrinsic);
  assert.equal(ownRejected, true);
  assert.equal(subclassRejected, true);
  assert.equal(proxyRejected, true);
  assert.equal(accessorListRejected, true);
  assert.equal(subclassListRejected, true);
  assert.equal(customPrototypeListRejected, true);
  assert.equal(extraFieldListRejected, true);
  assert.equal(extraSymbolListRejected, true);
  assert.equal(ownByteLengthGetterCalls, 0);
  assert.equal(subclassByteLengthGetterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
  assert.equal(listAccessorCalls, 0);
  assert.equal(networkStarts, 0);
  assert.equal(httpsApplicationRequests, 0);

  const wssTokenSegments = TEST_REFLECT_APPLY(
    originalStringSplit,
    wssCredential.accessToken,
    ["."],
  );
  const tokenBearingMarkers = [
    ...ALL_SECRETS,
    wssCredential.accessToken,
    wssTokenSegments[1],
    wssTokenSegments[2],
  ];
  const isTokenBearingString = (value) => {
    if (typeof value !== "string") return false;
    for (const marker of tokenBearingMarkers) {
      if (typeof marker === "string"
        && TEST_REFLECT_APPLY(originalStringIncludes, value, [marker])) {
        return true;
      }
    }
    return false;
  };
  const typedArrayCarriesSecret = (value) => {
    try {
      const decoded = TEST_REFLECT_APPLY(
        TEST_TEXT_DECODER_DECODE,
        TEST_TEXT_DECODER,
        [value],
      );
      for (const marker of [
        ...ALL_SECRETS,
        wssCredential.accessToken,
        wssTokenSegments[1],
        wssTokenSegments[2],
      ]) {
        if (typeof marker === "string"
          && TEST_REFLECT_APPLY(originalStringIncludes, decoded, [marker])) {
          return true;
        }
      }
    } catch {}
    return false;
  };
  const objectCarriesSecret = (value) => {
    try {
      if (typeof value !== "object" || value === null) return false;
      try {
        TEST_REFLECT_APPLY(TEST_TYPED_ARRAY_BYTE_LENGTH, value, []);
        return typedArrayCarriesSecret(value);
      } catch {}
      const descriptors = TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
      for (const key of TEST_REFLECT_OWN_KEYS(descriptors)) {
        const descriptor = descriptors[key];
        if (TEST_OBJECT_HAS_OWN(descriptor, "value")
          && typeof descriptor.value === "string"
          && isTokenBearingString(descriptor.value)) {
          return true;
        }
      }
    } catch {}
    return false;
  };
  const isOpaqueTokenKey = (value) => {
    try {
      return typeof value === "object"
        && value !== null
        && TEST_OBJECT_GET_PROTOTYPE_OF(value) === null;
    } catch {
      return false;
    }
  };
  let tokenPrimitivePoisonCalls = 0;
  let lastTokenPrimitivePoison = "";
  let tokenPrimitivePoisonRestored = false;
  const observeTokenPrimitive = (label) => {
    tokenPrimitivePoisonCalls += 1;
    lastTokenPrimitivePoison = label;
  };
  const restoreTokenPrimitivePoison = () => {
    if (tokenPrimitivePoisonRestored) return;
    tokenPrimitivePoisonRestored = true;
    WeakMap.prototype.delete = originalWeakMapDelete;
    WeakMap.prototype.get = originalWeakMapGet;
    WeakMap.prototype.set = originalWeakMapSet;
    JSON.parse = originalJsonParse;
    JSON.stringify = originalJsonStringify;
    Object.hasOwn = originalObjectHasOwn;
    Object.keys = originalObjectKeys;
    Array.from = originalArrayFrom;
    Array.isArray = originalArrayIsArray;
    String.prototype.charCodeAt = originalStringCharCodeAt;
    String.prototype.includes = originalStringIncludes;
    String.prototype.slice = originalStringSlice;
    String.prototype.split = originalStringSplit;
    String.prototype.trim = originalStringTrim;
    Buffer.allocUnsafe = originalBufferAllocUnsafe;
    Buffer.byteLength = originalBufferByteLength;
    Buffer.from = originalBufferFrom;
    Buffer.prototype.toString = originalBufferToString;
    RegExp.prototype.test = originalRegExpTest;
    originalTextEncoder.prototype.encode = originalTextEncoderEncode;
    originalTextDecoder.prototype.decode = originalTextDecoderDecode;
    globalThis.TextEncoder = originalTextEncoder;
    globalThis.TextDecoder = originalTextDecoder;
    TEST_OBJECT_DEFINE_PROPERTY(
      typedArrayPrototype,
      "buffer",
      originalTypedArrayBuffer,
    );
    TEST_OBJECT_DEFINE_PROPERTY(
      typedArrayPrototype,
      "byteOffset",
      originalTypedArrayByteOffset,
    );
    TEST_OBJECT_DEFINE_PROPERTY(
      typedArrayPrototype,
      "byteLength",
      originalTypedArrayByteLength,
    );
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "set", originalTypedArraySet);
    TEST_OBJECT_DEFINE_PROPERTY(
      typedArrayPrototype,
      "subarray",
      originalTypedArraySubarray,
    );
  };
  t.after(restoreTokenPrimitivePoison);

  const installTokenPrimitivePoison = () => {
    Object.hasOwn = function poisonedTokenObjectHasOwn(value, key) {
      if (objectCarriesSecret(value)) observeTokenPrimitive("Object.hasOwn");
      return TEST_REFLECT_APPLY(originalObjectHasOwn, this, [value, key]);
    };
    Object.keys = function poisonedTokenObjectKeys(value) {
      if (objectCarriesSecret(value)) observeTokenPrimitive("Object.keys");
      return TEST_REFLECT_APPLY(originalObjectKeys, this, [value]);
    };
    Array.from = function poisonedArrayFrom(value, ...args) {
      if (isTokenBearingString(value)) observeTokenPrimitive("Array.from");
      return TEST_REFLECT_APPLY(originalArrayFrom, this, [value, ...args]);
    };
    Array.isArray = function poisonedTokenArrayIsArray(value) {
      if (objectCarriesSecret(value)) observeTokenPrimitive("Array.isArray");
      return TEST_REFLECT_APPLY(originalArrayIsArray, this, [value]);
    };
    WeakMap.prototype.delete = function poisonedWeakMapDelete(key) {
      if (isOpaqueTokenKey(key)) observeTokenPrimitive("WeakMap.delete");
      return TEST_REFLECT_APPLY(originalWeakMapDelete, this, [key]);
    };
    WeakMap.prototype.get = function poisonedWeakMapGet(key) {
      if (isOpaqueTokenKey(key)) observeTokenPrimitive("WeakMap.get");
      const value = TEST_REFLECT_APPLY(originalWeakMapGet, this, [key]);
      if (value === wssCredential.accessToken) {
        observeTokenPrimitive("WeakMap.get:value");
      }
      return value;
    };
    WeakMap.prototype.set = function poisonedWeakMapSet(key, value) {
      if (isOpaqueTokenKey(key) || value === wssCredential.accessToken) {
        observeTokenPrimitive("WeakMap.set");
      }
      return TEST_REFLECT_APPLY(originalWeakMapSet, this, [key, value]);
    };
    JSON.parse = function poisonedJsonParse(...args) {
      observeTokenPrimitive("JSON.parse");
      return TEST_REFLECT_APPLY(originalJsonParse, this, args);
    };
    JSON.stringify = function poisonedJsonStringify(...args) {
      observeTokenPrimitive("JSON.stringify");
      return TEST_REFLECT_APPLY(originalJsonStringify, this, args);
    };
    String.prototype.charCodeAt = function poisonedStringCharCodeAt(...args) {
      if (isTokenBearingString(this)) observeTokenPrimitive("String.charCodeAt");
      return TEST_REFLECT_APPLY(originalStringCharCodeAt, this, args);
    };
    String.prototype.includes = function poisonedStringIncludes(...args) {
      if (isTokenBearingString(this)) observeTokenPrimitive("String.includes");
      return TEST_REFLECT_APPLY(originalStringIncludes, this, args);
    };
    String.prototype.slice = function poisonedStringSlice(...args) {
      if (isTokenBearingString(this)) observeTokenPrimitive("String.slice");
      return TEST_REFLECT_APPLY(originalStringSlice, this, args);
    };
    String.prototype.split = function poisonedStringSplit(...args) {
      if (isTokenBearingString(this)) observeTokenPrimitive("String.split");
      return TEST_REFLECT_APPLY(originalStringSplit, this, args);
    };
    String.prototype.trim = function poisonedStringTrim(...args) {
      if (isTokenBearingString(this)) observeTokenPrimitive("String.trim");
      return TEST_REFLECT_APPLY(originalStringTrim, this, args);
    };
    Buffer.allocUnsafe = function poisonedBufferAllocUnsafe(...args) {
      if (args[0] === adapterModule.RELAY_V2_HOST_CREDENTIAL_HTTPS_BODY_BYTES) {
        observeTokenPrimitive("Buffer.allocUnsafe");
      }
      return TEST_REFLECT_APPLY(originalBufferAllocUnsafe, this, args);
    };
    Buffer.byteLength = function poisonedBufferByteLength(...args) {
      if (isTokenBearingString(args[0])) {
        observeTokenPrimitive("Buffer.byteLength");
      }
      return TEST_REFLECT_APPLY(originalBufferByteLength, this, args);
    };
    Buffer.from = function poisonedBufferFrom(...args) {
      if (isTokenBearingString(args[0])
        || typedArrayCarriesSecret(args[0])) {
        observeTokenPrimitive("Buffer.from");
      }
      return TEST_REFLECT_APPLY(originalBufferFrom, this, args);
    };
    Buffer.prototype.toString = function poisonedBufferToString(...args) {
      if (args[0] === "base64url" || typedArrayCarriesSecret(this)) {
        observeTokenPrimitive("Buffer.toString");
      }
      return TEST_REFLECT_APPLY(originalBufferToString, this, args);
    };
    RegExp.prototype.test = function poisonedRegExpTest(...args) {
      if (isTokenBearingString(args[0])) observeTokenPrimitive("RegExp.test");
      return TEST_REFLECT_APPLY(originalRegExpTest, this, args);
    };
    originalTextEncoder.prototype.encode = function poisonedTextEncoderEncode(...args) {
      if (isTokenBearingString(args[0])) {
        observeTokenPrimitive("TextEncoder.encode");
      }
      return TEST_REFLECT_APPLY(originalTextEncoderEncode, this, args);
    };
    originalTextDecoder.prototype.decode = function poisonedTextDecoderDecode(...args) {
      if (typedArrayCarriesSecret(args[0])) {
        observeTokenPrimitive("TextDecoder.decode");
      }
      return TEST_REFLECT_APPLY(originalTextDecoderDecode, this, args);
    };
    globalThis.TextEncoder = function poisonedTextEncoder(...args) {
      observeTokenPrimitive("TextEncoder");
      return TEST_REFLECT_APPLY(originalReflectConstruct, Reflect, [
        originalTextEncoder,
        args,
      ]);
    };
    globalThis.TextDecoder = function poisonedTextDecoder(...args) {
      observeTokenPrimitive("TextDecoder");
      return TEST_REFLECT_APPLY(originalReflectConstruct, Reflect, [
        originalTextDecoder,
        args,
      ]);
    };
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "buffer", {
      ...originalTypedArrayBuffer,
      get() {
        if (typedArrayCarriesSecret(this)) {
          observeTokenPrimitive("TypedArray.buffer");
        }
        return TEST_REFLECT_APPLY(originalTypedArrayBuffer.get, this, []);
      },
    });
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "byteOffset", {
      ...originalTypedArrayByteOffset,
      get() {
        if (typedArrayCarriesSecret(this)) {
          observeTokenPrimitive("TypedArray.byteOffset");
        }
        return TEST_REFLECT_APPLY(originalTypedArrayByteOffset.get, this, []);
      },
    });
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "byteLength", {
      ...originalTypedArrayByteLength,
      get() {
        if (typedArrayCarriesSecret(this)) {
          observeTokenPrimitive("TypedArray.byteLength");
        }
        return TEST_REFLECT_APPLY(originalTypedArrayByteLength.get, this, []);
      },
    });
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "set", {
      ...originalTypedArraySet,
      value(...args) {
        if (typedArrayCarriesSecret(this) || typedArrayCarriesSecret(args[0])) {
          observeTokenPrimitive("TypedArray.set");
        }
        return TEST_REFLECT_APPLY(originalTypedArraySet.value, this, args);
      },
    });
    TEST_OBJECT_DEFINE_PROPERTY(typedArrayPrototype, "subarray", {
      ...originalTypedArraySubarray,
      value(...args) {
        if (typedArrayCarriesSecret(this)) {
          observeTokenPrimitive("TypedArray.subarray");
        }
        return TEST_REFLECT_APPLY(originalTypedArraySubarray.value, this, args);
      },
    });
  };

  const tamperedResponse = fakeResponse({ body: BOOTSTRAP_RESPONSE });
  const tamperedExchange = immediateExchange(tamperedResponse.value);
  const tamperedTransport = new RecordingTransport(() => tamperedExchange.exchange);
  installTokenPrimitivePoison();
  mutableNodeHttps.request = function poisonedNodeHttpsRequest(...args) {
    poisonedNodeHttpsRequestCalls += 1;
    return TEST_REFLECT_APPLY(originalNodeHttpsRequest, this, args);
  };
  mutableNodeTls.checkServerIdentity = function poisonedNodeCheckServerIdentity(...args) {
    poisonedNodeCheckServerIdentityCalls += 1;
    return TEST_REFLECT_APPLY(originalNodeCheckServerIdentity, this, args);
  };
  syncBuiltinESMExports();
  let bootstrap;
  try {
    bootstrap = await httpsAdapter.bootstrap(
      BOOTSTRAP_REQUEST,
      new AbortController().signal,
    );
  } finally {
    mutableNodeHttps.request = originalNodeHttpsRequest;
    mutableNodeTls.checkServerIdentity = originalNodeCheckServerIdentity;
    syncBuiltinESMExports();
  }
  try {
    assert.equal(poisonedNodeHttpsRequestCalls, 0);
    assert.equal(poisonedNodeCheckServerIdentityCalls, 0);
    assert.equal(httpsApplicationRequests, 1);
    const systemTrustAdapter =
      new adapterModule.RelayV2HostCredentialHttpsAdapter({
        issuerUrl: server.issuerUrl,
      });
    await assert.rejects(
      systemTrustAdapter.bootstrap(
        BOOTSTRAP_REQUEST,
        new AbortController().signal,
      ),
      (error) => assertRedactedError(error, "EXCHANGE_FAILED"),
    );
    assert.equal(httpsApplicationRequests, 1);
  } finally {
    await server.close();
  }

  const tamperedAdapter = fakeAdapter(tamperedTransport);
  const tamperedBootstrap = await tamperedAdapter.bootstrap(
    BOOTSTRAP_REQUEST,
    new AbortController().signal,
  );
  assert.equal(tamperedTransport.calls.length, 1);
  assert.equal(tamperedResponse.state.bodyReads, 1);

  const validWssTrust = {
    certificateAuthorities: [new Uint8Array([0x43, 0x41])],
  };
  const validWssFactoryOptions = {
    relayUrl: "wss://relay.example.test/",
    credentialAuthority: wssCredential.authority,
    webSocketConstructor: inspectingSockets.FakeWebSocket,
    tlsTrust: validWssTrust,
  };
  const invalidWssFactoryOptions = [
    {
      relayUrl: "wss://relay.example.test/",
      credentialAuthority: wssCredential.authority,
      webSocketConstructor: inspectingSockets.FakeWebSocket,
      tlsTrust: { certificateAuthorities: [ownByteLengthEntry] },
    },
    {
      relayUrl: "wss://relay.example.test/",
      credentialAuthority: wssCredential.authority,
      webSocketConstructor: inspectingSockets.FakeWebSocket,
      tlsTrust: { certificateAuthorities: [new ByteLengthSubclass([1])] },
    },
    {
      relayUrl: "wss://relay.example.test/",
      credentialAuthority: wssCredential.authority,
      webSocketConstructor: inspectingSockets.FakeWebSocket,
      tlsTrust: { certificateAuthorities: [proxyEntry] },
    },
    {
      relayUrl: "wss://relay.example.test/",
      credentialAuthority: wssCredential.authority,
      webSocketConstructor: inspectingSockets.FakeWebSocket,
      tlsTrust: { certificateAuthorities: accessorList },
    },
    {
      relayUrl: "wss://relay.example.test/",
      credentialAuthority: wssCredential.authority,
      webSocketConstructor: inspectingSockets.FakeWebSocket,
      tlsTrust: { certificateAuthorities: ["private-ca"], cert: CERTIFICATE },
    },
  ];
  const wssFactoryTargets = new Set([
    validWssFactoryOptions,
    validWssTrust,
    validWssTrust.certificateAuthorities,
    ...invalidWssFactoryOptions,
    ...invalidWssFactoryOptions.map((options) => options.tlsTrust),
    ownByteLengthEntry,
    proxyEntry,
    accessorList,
    inspectingSockets.FakeWebSocket,
  ]);
  for (const options of invalidWssFactoryOptions) {
    wssFactoryTargets.add(options.tlsTrust.certificateAuthorities);
  }
  let liveWssFactoryIntrinsicCalls = 0;
  let lastLiveWssFactoryIntrinsic = "";
  let liveWssUrlPrototypeCalls = 0;
  let liveWssBearerStartsWithCalls = 0;
  let liveWssBearerReflectApplyCalls = 0;
  let liveWssFinalizationObjectCalls = 0;
  let lastLiveWssFinalizationObject = "";
  let liveWssConstructCalls = 0;
  let liveWssTlsOptionsFreezeCalls = 0;
  const expectedAuthorization = `Bearer ${wssCredential.accessToken}`;
  const isCredentialState = (value) => {
    try {
      return typeof value === "object"
        && value !== null
        && TEST_OBJECT_HAS_OWN(value, "credentialVersion")
        && TEST_OBJECT_HAS_OWN(value, "accessToken")
        && TEST_OBJECT_HAS_OWN(value, "accessJti");
    } catch {
      return false;
    }
  };
  const isFinalizationPort = (value) => {
    try {
      if (typeof value !== "object"
        || value === null
        || TEST_OBJECT_GET_PROTOTYPE_OF(value) !== null) return false;
      const descriptor = TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "finalize");
      return descriptor !== undefined
        && TEST_OBJECT_HAS_OWN(descriptor, "value")
        && typeof descriptor.value === "function";
    } catch {
      return false;
    }
  };
  const isFinalizationDescriptorMap = (value) => {
    try {
      if (typeof value !== "object" || value === null) return false;
      const outer = TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "finalize");
      const inner = outer?.value;
      return inner !== null
        && typeof inner === "object"
        && TEST_OBJECT_HAS_OWN(inner, "value")
        && typeof inner.value === "function";
    } catch {
      return false;
    }
  };
  const isSensitiveObjectTarget = (value) =>
    wssFactoryTargets.has(value)
    || isCredentialState(value)
    || isFinalizationPort(value)
    || isFinalizationDescriptorMap(value);
  const targetPoison = (label, original) => function poisonedWssFactoryIntrinsic(...args) {
    if (isSensitiveObjectTarget(args[0])) {
      liveWssFactoryIntrinsicCalls += 1;
      lastLiveWssFactoryIntrinsic = label;
    }
    return TEST_REFLECT_APPLY(original, this, args);
  };
  const attempt = wssAttempt();
  let wssFactory;
  let preparedWss;
  let socketsBeforeBind = -1;

  mutableNodeUtil.types = {
    ...originalNodeUtilTypes,
    isProxy: targetPoison("nodeTypes.isProxy", originalNodeUtilTypes.isProxy),
  };
  Object.getPrototypeOf =
    targetPoison("Object.getPrototypeOf", originalObjectGetPrototypeOf);
  Object.getOwnPropertyDescriptor =
    targetPoison(
      "Object.getOwnPropertyDescriptor",
      originalObjectGetOwnPropertyDescriptor,
    );
  Object.getOwnPropertyDescriptors =
    targetPoison(
      "Object.getOwnPropertyDescriptors",
      originalObjectGetOwnPropertyDescriptors,
    );
  const tokenPoisonedObjectHasOwn = Object.hasOwn;
  const tokenPoisonedObjectKeys = Object.keys;
  const tokenPoisonedArrayIsArray = Array.isArray;
  Object.hasOwn = targetPoison("Object.hasOwn", tokenPoisonedObjectHasOwn);
  Object.create = function poisonedObjectCreate(prototype, properties) {
    if (prototype === null) {
      liveWssFinalizationObjectCalls += 1;
      lastLiveWssFinalizationObject = "Object.create";
    }
    return properties === undefined
      ? TEST_REFLECT_APPLY(originalObjectCreate, this, [prototype])
      : TEST_REFLECT_APPLY(originalObjectCreate, this, [prototype, properties]);
  };
  Object.defineProperty = function poisonedObjectDefineProperty(
    value,
    property,
    descriptor,
  ) {
    if (property === "finalize") {
      liveWssFinalizationObjectCalls += 1;
      lastLiveWssFinalizationObject = "Object.defineProperty";
    }
    return TEST_REFLECT_APPLY(originalObjectDefineProperty, this, [
      value,
      property,
      descriptor,
    ]);
  };
  Object.freeze = function poisonedObjectFreeze(value) {
    try {
      const descriptors = TEST_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
      if (TEST_OBJECT_HAS_OWN(descriptors, "rejectUnauthorized")
        && TEST_OBJECT_HAS_OWN(descriptors, "checkServerIdentity")
        && TEST_OBJECT_HAS_OWN(descriptors, "finishRequest")) {
        liveWssTlsOptionsFreezeCalls += 1;
      }
      if (isFinalizationPort(value)) {
        liveWssFinalizationObjectCalls += 1;
        lastLiveWssFinalizationObject = "Object.freeze";
      }
    } catch {}
    return TEST_REFLECT_APPLY(originalObjectFreeze, this, [value]);
  };
  Object.isFrozen = function poisonedObjectIsFrozen(value) {
    if (isFinalizationPort(value)) {
      liveWssFinalizationObjectCalls += 1;
      lastLiveWssFinalizationObject = "Object.isFrozen";
    }
    return TEST_REFLECT_APPLY(originalObjectIsFrozen, this, [value]);
  };
  Object.keys = function poisonedObjectKeys(value) {
    if (isCredentialState(value)) {
      liveWssFinalizationObjectCalls += 1;
      lastLiveWssFinalizationObject = "Object.keys";
    }
    return TEST_REFLECT_APPLY(tokenPoisonedObjectKeys, this, [value]);
  };
  Reflect.apply = function poisonedReflectApply(target, receiver, args) {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === expectedAuthorization) {
        liveWssBearerReflectApplyCalls += 1;
      }
    }
    return TEST_REFLECT_APPLY(originalReflectApply, this, [target, receiver, args]);
  };
  Reflect.construct = function poisonedReflectConstruct(target, args, newTarget) {
    if (target === inspectingSockets.FakeWebSocket) liveWssConstructCalls += 1;
    return newTarget === undefined
      ? TEST_REFLECT_APPLY(originalReflectConstruct, this, [target, args])
      : TEST_REFLECT_APPLY(originalReflectConstruct, this, [
          target,
          args,
          newTarget,
        ]);
  };
  Reflect.ownKeys = function poisonedReflectOwnKeys(value) {
    if (isSensitiveObjectTarget(value)) {
      liveWssFactoryIntrinsicCalls += 1;
      lastLiveWssFactoryIntrinsic = "Reflect.ownKeys";
    }
    return TEST_REFLECT_APPLY(originalReflectOwnKeys, this, [value]);
  };
  Array.isArray = targetPoison("Array.isArray", tokenPoisonedArrayIsArray);
  String.prototype.startsWith = function poisonedStringStartsWith(...args) {
    liveWssBearerStartsWithCalls += 1;
    return TEST_REFLECT_APPLY(originalStringStartsWith, this, args);
  };
  mutableNodeTls.checkServerIdentity = function poisonedNodeCheckServerIdentity(...args) {
    poisonedNodeCheckServerIdentityCalls += 1;
    return TEST_REFLECT_APPLY(originalNodeCheckServerIdentity, this, args);
  };
  installUrlPrototypePoison(() => {
    liveWssUrlPrototypeCalls += 1;
  });
  syncBuiltinESMExports();
  try {
    wssFactory = new wssModule.RelayV2HostWssTransportLifecycleFactory(
      validWssFactoryOptions,
    );
    for (const options of invalidWssFactoryOptions) {
      try {
        new wssModule.RelayV2HostWssTransportLifecycleFactory(options);
      } catch {
        continue;
      }
      throw new Error("hostile WSS trust reached socket construction");
    }
    socketsBeforeBind = inspectingSockets.sockets.length;
    preparedWss = prepareWssLifecycle(
      wssFactory,
      wssCredential.authority,
      attempt,
    );
    preparedWss.lifecycle.bindConnection(preparedWss.connection);
  } finally {
    restoreUrlPrototype();
    String.prototype.startsWith = originalStringStartsWith;
    Object.getPrototypeOf = originalObjectGetPrototypeOf;
    Object.getOwnPropertyDescriptor = originalObjectGetOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = originalObjectGetOwnPropertyDescriptors;
    Object.hasOwn = originalObjectHasOwn;
    Object.create = originalObjectCreate;
    Object.defineProperty = originalObjectDefineProperty;
    Object.freeze = originalObjectFreeze;
    Object.isFrozen = originalObjectIsFrozen;
    Object.keys = originalObjectKeys;
    Reflect.apply = originalReflectApply;
    Reflect.construct = originalReflectConstruct;
    Reflect.ownKeys = originalReflectOwnKeys;
    Array.isArray = originalArrayIsArray;
    mutableNodeUtil.types = originalNodeUtilTypes;
    mutableNodeTls.checkServerIdentity = originalNodeCheckServerIdentity;
    restoreTokenPrimitivePoison();
    syncBuiltinESMExports();
  }
  assert.equal(
    liveWssFactoryIntrinsicCalls,
    0,
    lastLiveWssFactoryIntrinsic,
  );
  assert.equal(liveWssUrlPrototypeCalls, 0);
  assert.equal(liveWssBearerStartsWithCalls, 0);
  assert.equal(liveWssBearerReflectApplyCalls, 0);
  assert.equal(
    liveWssFinalizationObjectCalls,
    0,
    lastLiveWssFinalizationObject,
  );
  assert.equal(liveWssConstructCalls, 0);
  assert.equal(liveWssTlsOptionsFreezeCalls, 0);
  assert.equal(
    tokenPrimitivePoisonCalls,
    0,
    lastTokenPrimitivePoison,
  );
  assert.deepEqual(bootstrap, BOOTSTRAP_RESPONSE);
  assert.deepEqual(tamperedBootstrap, BOOTSTRAP_RESPONSE);
  assert.equal(poisonedNodeCheckServerIdentityCalls, 0);
  assert.equal(socketsBeforeBind, 0);
  assert.equal(ownByteLengthGetterCalls, 0);
  assert.equal(subclassByteLengthGetterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
  assert.equal(listAccessorCalls, 0);
  assert.equal(inspectingSockets.sockets.length, 1);
  const socket = inspectingSockets.sockets[0];
  assert.equal(socket.construction.address, "wss://relay.example.test/host");
  assert.equal(socket.construction.optionsFrozen, true);
  assert.equal(socket.construction.rejectUnauthorized, true);
  assert.equal(
    socket.construction.checkServerIdentity,
    originalNodeCheckServerIdentity,
  );
  assert.equal(socket.construction.hasCert, false);
  assert.equal(socket.construction.hasKey, false);
  assert.equal(socket.construction.hasHeaders, false);
  assert.deepEqual(
    [...socket.construction.ca[0]],
    [0x43, 0x41],
  );
  assert.equal(socket.request.setHeaderCalls, 1);
  assert.equal(socket.request.endCalls, 1);
  assert.equal(socket.request.destroyCalls, 0);
  assert.equal(socket.request.authorization, expectedAuthorization);

  preparedWss.lifecycle.transport.close(1000, "host_shutdown");
  const proof = Object.freeze({});
  const drained = preparedWss.lifecycle.awaitDrained(proof);
  socket.emitClose();
  assert.equal(await drained, proof);
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
      tlsTrust: { certificateAuthorities: [Uint8Array.from(CERTIFICATE)] },
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
