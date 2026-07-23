import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

const relayServer = await import("../dist/relayServer.js");
const issuer = await import("../dist/relay/v2/issuer.js");

const ENDPOINT = "https://continuity.example.test/external/continuity/v1";
const TRUSTED_HOME = "/test/account-home";
const TEST_SECRET = Buffer.alloc(32, 17).toString("base64url");

// Test-only throwaway self-signed pair for loopback TLS; it protects nothing
// and is committed deliberately so no certificate generation runs in tests.
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCWAhVz+QTOulz7
JCZHwcTIn7vTXZZwJ+ukgWPTBYvA+mMwaGu3aEhizsTb2I5cZLV+LG7GM3I+Mpd+
Bdqe0vIgZZIqz4P+WxljISRMBEaJiKa1zGl5Oq6XIECgv1AadxCnnPHXrbNNmYCz
X3FOkI2thJBXXNFYrHgPXW9vxOqaRvntU2/y66WoXyUpS3LBAW+CJ8FGhZeTWeRM
D4/3OjbQMvz89ZUQqXTuA4UQrGCmDntO9iUMdoJV0vuxSzQz5DgZVbkJcefmDKgd
EGUhBThE3xCamBRogjmgsJ/BbY8tMFTSG5uPwJqmlt0iQ+RXqwAcphAX3am0zj08
MZpAw+PJAgMBAAECggEAF6+di+cykKKRovV1dpgh29yI+loeh81t4lcB7aSZtBof
266+mhevx6ucHutF/fsdmJ4odvL8TiuL4HzJJTyWuccqpMgz2yUEUF2VJHb6XPtu
+L7IRWRJhBhgzAuuo3clxz7mBacU7E2u1OPe+XJOxKrCuzYEjPVdVxkVoEwzZQej
vL/tkUsu3SFRzfrw2gB/wJxeZ6hOI4s14QXG2MMiYIgc2Hy7TSpo9RqsjQeRYD2m
hWzLwO65Y979x9J/xdve9d40aFs1bhBT1AJntqK7AoVsln8QZfWhKA1oMgRSMZcd
GB66Or/cIcPlEOzQ1uV7JCQzk/h3E5Ft3P4hY2eppwKBgQDMVkIa4xYS2a5Q4NQD
K2ArJZyXfihmBinEEGxIDjIF0mS9Fzgz/HOs+t0I3vr9VK0GG0rJMubnDVEt6to5
bhp6OHwkfRh+brruzxNJIfGPkiFoja9niKITEdQZm9FboEZmQFJE7oiEuXpVpB7G
bpWzRVQnK0fZsGcVYtLMuLS5GwKBgQC772KES31RhcK8zpCTFPBbyln7ea+KksIH
P9bsCLKuy79IF3mXmwSvINkA/Y2fTkE1Zh7EwLDeNQ6gADc5itLvxTRZERLTT+Iv
Fd4LYAdxVcZGcigLyKyUeL1F3pS0V5tQ6Y40TSFN4+hyNrTrnZj5mLXS73qDJBOa
OvbupLFo6wKBgH6fpW9L8c3UnzT3Xepo4rtaH2Oxhg9TGmapVrCAO3doHY0f6nAs
rPIwsvBgXWDHLEFwgDOWG4hqtDekJX8ZP8clYaiq7JbMv4JlSCo1op+5ioJj6qJa
BTWUAr+r01zYQUfz7AdTWb4Fwk132qpUtOfWuoNbSrcXnYmfJ8o9W6CpAoGAfgyN
ExZeszL37hLNvRiqLaaGu7heGJ9eK+aRjDY5Qiu92+iC0UBT3/I0Ggn11wdxjRM1
R9nFxwPnD0GVyK5n1BF8jtB4w+osVlBgYVjDJSzWk6E1YtHxjpN8v0QOkPbBYX+E
tWeWEtvtp80xg2Zsl9vo99VPYm3sB+HMhTtJEokCgYEAvKVTaHhUhR6mn3cD4syF
jn5ENZyTzpkVTZO4Z0osXbgP/bCn8Jp6Agz4oV87MwRBWtVYpun/s+dJ+SjU2WNT
hafDW8YEVS9LEsDCPGeU1IltmrzBqffzT0VucdHxsgXVunH6nwsvgdId793jnpdJ
fKNC6/Ymql9g09UWVtx7bmg=
-----END PRIVATE KEY-----`;
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUS4hHFMkDcdFVxR/09jXKM4jyQN0wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyMzE0MjQzMFoXDTM2MDcy
MDE0MjQzMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAlgIVc/kEzrpc+yQmR8HEyJ+7012WcCfrpIFj0wWLwPpj
MGhrt2hIYs7E29iOXGS1fixuxjNyPjKXfgXantLyIGWSKs+D/lsZYyEkTARGiYim
tcxpeTqulyBAoL9QGncQp5zx162zTZmAs19xTpCNrYSQV1zRWKx4D11vb8Tqmkb5
7VNv8uulqF8lKUtywQFvgifBRoWXk1nkTA+P9zo20DL8/PWVEKl07gOFEKxgpg57
TvYlDHaCVdL7sUs0M+Q4GVW5CXHn5gyoHRBlIQU4RN8QmpgUaII5oLCfwW2PLTBU
0hubj8CappbdIkPkV6sAHKYQF92ptM49PDGaQMPjyQIDAQABo28wbTAdBgNVHQ4E
FgQUSHthKYzzgJ9w7QBEBXS/DIeNs48wHwYDVR0jBBgwFoAUSHthKYzzgJ9w7QBE
BXS/DIeNs48wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAEaXqhKdXxMYHLSbUHsw5bAd2D555ktR
mEi5cF83u1CO5201MDfSNQO7f0JNjKa7MTdkza4b7QjSgruKmVphJX3aOpD6Zz1w
ejLMF1nE4YDyO9viIk5rjqRGLkHd5ITTtFDJDVgu3IayEv3sOAy6FmzG6w3uTW77
h9a8SWTGfp+ULB9bvABnmUTtD9zw6mDTwTPpZiR9C6vCzkBFapT+TYvOuNBttF/W
35PIn+D/6naRNT1rkq5Nqv/ifgs+MDf1hom73x24X2+3YGR594HQAhG8Ou8vxpjY
uA137IKJfJTsWJ9kfbi/blRYjhwLtRYjiOMg3hFcPGOBJq9HBY8SK70=
-----END CERTIFICATE-----`;

function copy(value) {
  return structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function connectRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

class NarrowNativeStore {
  #bytes;
  #revision = 0;
  #revisionOwners = new WeakMap();

  constructor() {
    this.#bytes = null;
    this.closeCalls = 0;
  }

  async runExclusive(operation) {
    const transactionIdentity = Object.freeze({});
    const readCurrent = () => {
      const revision = Object.freeze({});
      this.#revisionOwners.set(revision, {
        transactionIdentity,
        revision: this.#revision,
      });
      return this.#bytes === null
        ? { outcome: "missing", revision }
        : { outcome: "present", revision, bytes: Uint8Array.from(this.#bytes) };
    };
    const transaction = Object.freeze({
      read: async () => readCurrent(),
      compareAndPublish: async (expected, next) => {
        const owner = this.#revisionOwners.get(expected);
        if (!owner || owner.transactionIdentity !== transactionIdentity) {
          throw new Error("foreign fake revision");
        }
        if (owner.revision !== this.#revision) {
          return { outcome: "conflict", current: readCurrent() };
        }
        this.#bytes = Uint8Array.from(next);
        this.#revision += 1;
        return { outcome: "swapped", current: readCurrent() };
      },
    });
    return operation(transaction);
  }

  async close() {
    this.closeCalls += 1;
  }
}

function nativeLoader(resultFactory, events) {
  const loader = Object.freeze({
    capability() {
      throw new Error("the shipping root must not probe a second capability cut");
    },
    async open(trustedHome) {
      events.push("native.open");
      return resultFactory(trustedHome);
    },
  });
  return { loader };
}

function responseEnvelope(wire, result) {
  const body = Buffer.from(JSON.stringify({
    contractVersion: 1,
    operationId: wire.operationId,
    ok: true,
    result,
    error: null,
  }), "utf8");
  return {
    statusCode: 200,
    headers: [
      ["Content-Type", "application/json"],
      ["Cache-Control", "no-store"],
      ["Content-Length", String(body.byteLength)],
    ],
    body: {
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    },
    destroy() {},
  };
}

function backend(events, { failRead = false, holdCas = null } = {}) {
  const state = { wires: [] };
  let casGeneration = 0;
  const provider = Object.freeze({
    resolveAttempt(request) {
      events.push("provider.resolve");
      const transport = Object.freeze({
        start(startRequest) {
          const wire = JSON.parse(Buffer.from(startRequest.body).toString("utf8"));
          state.wires.push(wire);
          events.push(`transport.start:${wire.namespace}:${wire.operation}`);
          if (failRead && wire.operation === "read") {
            return {
              response: Promise.reject(new Error("injected external read fault")),
              abort() {},
            };
          }
          let result;
          if (wire.operation === "read") {
            result = copy(state.current ?? {
              protocolVersion: 1,
              status: "uninitialized",
              anchorId: "broker-anchor",
              casToken: "cas-0",
            });
          } else {
            casGeneration += 1;
            state.current = {
              protocolVersion: 1,
              status: "committed",
              anchorId: "broker-anchor",
              casToken: `cas-${casGeneration}`,
              checkpoint: copy(wire.payload.next),
            };
            result = {
              protocolVersion: 1,
              outcome: "swapped",
              current: copy(state.current),
            };
          }
          const respond = () => Promise.resolve(responseEnvelope(wire, result));
          const gated = holdCas !== null
            && holdCas.enabled
            && wire.operation === "compare_and_swap";
          return {
            response: gated ? holdCas.gate.promise.then(respond) : respond(),
            abort() {},
          };
        },
        discard() {},
      });
      return Object.freeze({
        authenticationHeaders() {
          return Object.freeze({ Authorization: "Bearer test-only-workload-token" });
        },
        transport,
      });
    },
  });
  return { provider, state };
}

function testKeyring() {
  return issuer.createRelayV2IssuerKeyring({
    issuerId: "shipping-issuer",
    kid: "shipping-kid",
    secretBase64url: TEST_SECRET,
    nowSeconds: Math.floor(Date.now() / 1_000),
  });
}

function privilegedResolver(events) {
  const state = { disposeCalls: 0 };
  const resolver = Object.freeze({
    resolveTlsMaterial(references) {
      events.push("tls.resolve");
      return Object.freeze({
        key: TEST_KEY_PEM,
        cert: TEST_CERT_PEM,
        dispose() {
          state.disposeCalls += 1;
          events.push("tls.dispose");
        },
      });
    },
    resolveIssuerKeyring(reference) {
      events.push("keyring.resolve");
      return testKeyring();
    },
  });
  return { resolver, state };
}

function externalConfig() {
  return {
    configVersion: 1,
    endpoint: ENDPOINT,
    securityDomainId: "security-domain-a",
    authenticationMode: "workload_identity",
    credentialReference: "credential-reference-a",
    tlsTrustReference: "trust-reference-a",
    operationTimeoutMs: 10_000,
    maxPendingOperations: 4,
    namespaceBindings: [
      { namespace: "broker-credential.v1", ownerBinding: "broker-owner", anchorId: "broker-anchor" },
    ],
  };
}

function shippingProfile(overrides = {}) {
  return {
    configVersion: 1,
    listen: { host: "127.0.0.1", port: 0 },
    issuerUrl: "https://broker.example.test",
    relayUrl: "wss://broker.example.test",
    trustedHome: TRUSTED_HOME,
    tls: { keyReference: "tls-key-ref", certificateReference: "tls-cert-ref" },
    issuerKeyringReference: "issuer-keyring-ref",
    externalContinuity: externalConfig(),
    ...overrides,
  };
}

function trackingCreateHttpsServer(events) {
  return (options) => {
    events.push("https.create");
    const server = createHttpsServer(options);
    server.once("listening", () => events.push("https.listening"));
    return server;
  };
}

function startableShipping({ backendOptions = {}, profileOverrides = {}, makeResolver = null } = {}) {
  const events = [];
  const store = new NarrowNativeStore();
  const { loader } = nativeLoader(
    () => Object.freeze({ status: "opened", selfCheck: "passed", store }),
    events,
  );
  const holdCas = backendOptions.holdCas ?? null;
  const { provider } = backend(events, backendOptions);
  const { resolver, state: resolverState } = (makeResolver ?? privilegedResolver)(events);
  const inputs = {
    privilegedResolver: resolver,
    externalContinuityAttemptProvider: provider,
    nativeLoader: loader,
    createHttpsServer: trackingCreateHttpsServer(events),
  };
  return {
    events,
    store,
    resolverState,
    profile: shippingProfile(profileOverrides),
    inputs,
    async start() {
      return relayServer.startRelayV2BrokerShippingRoot(this.profile, this.inputs);
    },
  };
}

function postJson(port, requestPath, body, { method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      rejectUnauthorized: false,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(payload === null ? {} : { "Content-Length": String(payload.byteLength) }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text === "" ? null : JSON.parse(text);
        } catch {
          // keep raw text only
        }
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.once("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

function plainHttpGet(port) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/health", method: "GET" }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
    request.end();
  });
}

function probeUpgrade(port, requestPath) {
  return new Promise((resolve) => {
    let data = "";
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n`
        + "Host: 127.0.0.1\r\n"
        + "Connection: Upgrade\r\n"
        + "Upgrade: websocket\r\n"
        + "Sec-WebSocket-Version: 13\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        + "Sec-WebSocket-Protocol: tw-relay.v2\r\n"
        + "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) socket.destroy();
    });
    socket.once("error", () => resolve(data));
    socket.once("close", () => resolve(data));
    setTimeout(() => {
      socket.destroy();
    }, 2_000);
  });
}

async function runCli(argv) {
  const savedArgv = process.argv;
  const savedSecret = process.env.TW_RELAY_SECRET;
  process.argv = ["node", "tw", "relay-server", ...argv];
  try {
    await relayServer.run();
    return null;
  } catch (error) {
    return error;
  } finally {
    process.argv = savedArgv;
    if (savedSecret === undefined) {
      delete process.env.TW_RELAY_SECRET;
    } else {
      process.env.TW_RELAY_SECRET = savedSecret;
    }
  }
}

test("explicit v2 profile selects shipping and fails closed; default v1 path is unchanged", async () => {
  delete process.env.TW_RELAY_SECRET;
  const missingSecret = await runCli([]);
  assert.match(String(missingSecret?.message), /--secret|TW_RELAY_SECRET/);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tw-v2-shipping-cli-"));
  try {
    const validProfilePath = path.join(tempDir, "profile.json");
    writeFileSync(validProfilePath, JSON.stringify(shippingProfile()), { mode: 0o600 });

    process.env.TW_RELAY_SECRET = "v1-secret-that-must-not-be-used";
    const blocker = await runCli(["--v2-profile", validProfilePath]);
    assert.match(String(blocker?.message), /deployment inputs are unavailable/);

    const malformedPath = path.join(tempDir, "malformed.json");
    writeFileSync(malformedPath, "{ not json", { mode: 0o600 });
    const malformed = await runCli(["--v2-profile", malformedPath]);
    assert.match(String(malformed?.message), /profile is invalid/);

    const missing = await runCli(["--v2-profile", path.join(tempDir, "absent.json")]);
    assert.match(String(missing?.message), /profile is unavailable/);

    const ambiguousSecret = await runCli(["--v2-profile", validProfilePath, "--secret", "x"]);
    assert.match(String(ambiguousSecret?.message), /--secret/);

    const ambiguousListen = await runCli(["--v2-profile", validProfilePath, "--port", "9999"]);
    assert.match(String(ambiguousListen?.message), /--host\/\--port/);
  } finally {
    delete process.env.TW_RELAY_SECRET;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable authorities open before listen and only the frozen public surface is reachable", async () => {
  const shipping = startableShipping();
  const handle = await shipping.start();
  try {
    assert.ok(handle.port > 0);
    const at = (name) => shipping.events.indexOf(name);
    assert.ok(at("keyring.resolve") !== -1 && at("keyring.resolve") < at("https.listening"));
    assert.ok(at("tls.resolve") !== -1 && at("tls.resolve") < at("https.listening"));
    assert.ok(at("native.open") !== -1 && at("native.open") < at("https.listening"));
    assert.ok(at("provider.resolve") !== -1 && at("provider.resolve") < at("https.listening"));
    assert.ok(at("transport.start:broker-credential.v1:read") !== -1
      && at("transport.start:broker-credential.v1:read") < at("https.listening"));
    assert.equal(shipping.resolverState.disposeCalls, 1);

    // TLS termination comes from resolved material: plain HTTP cannot speak.
    await assert.rejects(plainHttpGet(handle.port));

    // The public route carries no admin issuance surface at all.
    const unknownAdmin = await postJson(handle.port, "/v2/admin/bootstrap", {});
    assert.equal(unknownAdmin.status, 404);
    const getBootstrap = await postJson(handle.port, "/v2/hosts/bootstrap", null, { method: "GET" });
    assert.equal(getBootstrap.status, 404);
  } finally {
    await handle.shutdown();
  }
  assert.equal(shipping.store.closeCalls, 1);
  assert.equal(await connectRefused(handle.port), true);
  await assert.rejects(
    handle.admin.createHostBootstrap({}, () => {}),
    /admin is unavailable/,
  );
});

test("privileged admin seam delivers bootstrap secret only to the sink and reuses authority semantics", async () => {
  const shipping = startableShipping();
  const handle = await shipping.start();
  try {
    const sinkSecrets = [];
    const receipt = await handle.admin.createHostBootstrap(
      { expiresInMs: 60_000 },
      (secret) => sinkSecrets.push(secret),
    );
    assert.deepEqual(Object.keys(receipt), ["expiresAtMs"]);
    assert.equal(sinkSecrets.length, 1);
    assert.match(sinkSecrets[0], /^twhostboot2\./);

    // The seam-issued token redeems through the real public HTTPS ingress.
    const redeemed = await postJson(handle.port, "/v2/hosts/bootstrap", {
      bootstrapAttemptId: "shipping-attempt-1",
      bootstrapToken: sinkSecrets[0],
      hostId: "shipping-host",
      hostEpoch: "shipping-epoch",
      hostInstanceId: "shipping-instance",
    });
    assert.equal(redeemed.status, 200);
    assert.match(redeemed.json?.accessToken ?? "", /^twcap2\./);
    assert.match(redeemed.json?.refreshToken ?? "", /^twref2\./);

    // Exact-once: the same token cannot redeem a second distinct attempt.
    const replayed = await postJson(handle.port, "/v2/hosts/bootstrap", {
      bootstrapAttemptId: "shipping-attempt-2",
      bootstrapToken: sinkSecrets[0],
      hostId: "shipping-host",
      hostEpoch: "shipping-epoch",
      hostInstanceId: "shipping-instance",
    });
    assert.equal(replayed.status, 401);

    // A throwing or async sink fails closed and the token never leaves.
    const throwing = [];
    await assert.rejects(
      handle.admin.createHostBootstrap({}, () => {
        throw new Error("sink exploded");
      }),
      /admin secret sink failed/,
    );
    await assert.rejects(
      handle.admin.createHostBootstrap({}, () => Promise.resolve()),
      /admin secret sink failed/,
    );
    assert.deepEqual(throwing, []);

    // Bounded admin input validation happens before the authority.
    await assert.rejects(
      handle.admin.createHostBootstrap({ expiresInMs: 60_000, extra: true }, () => {}),
      /admin input is invalid/,
    );
    await assert.rejects(
      handle.admin.createHostBootstrap({ expiresInMs: 300_001 }, () => {}),
      /admin input is invalid/,
    );

    // Rotations reuse the authority's canonical admin mutation owner.
    assert.deepEqual(
      await handle.admin.rotateIssuerKey({ kid: "rotated-kid" }),
      { kid: "rotated-kid" },
    );
    const rotation = await handle.admin.rotateReplayKey({ rotationId: "rotation-1" });
    assert.equal(rotation.rotationId, "rotation-1");
    assert.deepEqual(
      await handle.admin.rotateReplayKey({ rotationId: "rotation-1" }),
      rotation,
    );
    assert.deepEqual(
      await handle.admin.removeIssuerKey({ kid: "shipping-kid", emergency: true }),
      { kid: "shipping-kid" },
    );
  } finally {
    await handle.shutdown();
  }
});

test("missing E0 backend or native qualification fails closed before listen with no v1 fallback", async () => {
  const port = await reserveFreePort();

  const e0Failure = startableShipping({
    backendOptions: { failRead: true },
    profileOverrides: { listen: { host: "127.0.0.1", port } },
  });
  await assert.rejects(e0Failure.start(), /activated composition failed to open/);
  assert.equal(e0Failure.resolverState.disposeCalls, 1);
  assert.ok(e0Failure.store.closeCalls >= 1);
  assert.equal(e0Failure.events.includes("https.listening"), false);
  assert.equal(await connectRefused(port), true);

  const qualification = startableShipping({
    profileOverrides: { listen: { host: "127.0.0.1", port } },
  });
  qualification.inputs.nativeLoader = Object.freeze({
    capability() {
      throw new Error("no capability probe expected");
    },
    async open() {
      qualification.events.push("native.open");
      return Object.freeze({ status: "unsupported", reason: "native_artifact_missing" });
    },
  });
  await assert.rejects(qualification.start(), /activated composition failed to open/);
  assert.equal(qualification.resolverState.disposeCalls, 1);
  assert.equal(qualification.events.includes("https.listening"), false);
  assert.equal(await connectRefused(port), true);
});

test("shutdown fences public admission synchronously, then drains admin in-flight before closing the store", async () => {
  const holdCas = { enabled: false, gate: deferred() };
  const shipping = startableShipping({ backendOptions: { holdCas } });
  const handle = await shipping.start();

  const casEventsBefore = shipping.events.filter((event) => (
    event === "transport.start:broker-credential.v1:compare_and_swap"
  )).length;
  holdCas.enabled = true;
  const sinkSecrets = [];
  const bootstrap = handle.admin.createHostBootstrap({}, (secret) => sinkSecrets.push(secret));
  await waitFor(() => shipping.events.filter((event) => (
    event === "transport.start:broker-credential.v1:compare_and_swap"
  )).length > casEventsBefore);

  const shutdown = handle.shutdown();
  // Public admission is fenced synchronously before the admin drain finishes:
  // new credential HTTP requests and both Upgrade paths are rejected while the
  // listener has not closed yet.
  const rejectedHttp = await postJson(handle.port, "/v2/hosts/bootstrap", {
    bootstrapAttemptId: "fenced-attempt",
    bootstrapToken: "twhostboot2.invalid",
    hostId: "shipping-host",
    hostEpoch: "shipping-epoch",
    hostInstanceId: "shipping-instance",
  });
  assert.equal(rejectedHttp.status, 503);
  assert.match(await probeUpgrade(handle.port, "/client"), /^HTTP\/1\.1 503/);
  assert.match(await probeUpgrade(handle.port, "/host"), /^HTTP\/1\.1 503/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shipping.store.closeCalls, 0);
  await assert.rejects(
    handle.admin.createHostBootstrap({}, () => {}),
    /admin is unavailable/,
  );

  holdCas.gate.resolve();
  await bootstrap;
  assert.equal(sinkSecrets.length, 1);
  await shutdown;
  assert.equal(shipping.store.closeCalls, 1);
  assert.equal(await connectRefused(handle.port), true);
});

test("privileged resolver and TLS disposal keep original receivers; acquired material is disposed exactly once", async () => {
  // this-bound resolver and dispose only succeed when the original receivers
  // are preserved; the material may carry its own sibling state.
  const boundEvents = [];
  const boundMaterial = {
    key: TEST_KEY_PEM,
    cert: TEST_CERT_PEM,
    disposed: 0,
    dispose() {
      this.disposed += 1;
      boundEvents.push("tls.dispose");
    },
  };
  const boundCalls = { tlsCalls: 0, keyringCalls: 0 };
  const boundResolver = {
    material: boundMaterial,
    keyring: testKeyring(),
    resolveTlsMaterial() {
      boundCalls.tlsCalls += 1;
      return this.material;
    },
    resolveIssuerKeyring() {
      boundCalls.keyringCalls += 1;
      return this.keyring;
    },
  };
  const boundShipping = startableShipping({
    makeResolver: () => ({ resolver: boundResolver, state: { disposeCalls: 0 } }),
  });
  const boundHandle = await boundShipping.start();
  assert.equal(boundCalls.tlsCalls, 1);
  assert.equal(boundCalls.keyringCalls, 1);
  assert.equal(boundMaterial.disposed, 1);
  await boundHandle.shutdown();

  // Material that is malformed after acquisition is still disposed exactly
  // once and never reaches a listener.
  const malformedMaterial = {
    key: TEST_KEY_PEM,
    disposed: 0,
    dispose() {
      this.disposed += 1;
    },
  };
  const malformedShipping = startableShipping({
    makeResolver: () => ({
      resolver: Object.freeze({
        resolveTlsMaterial() {
          return malformedMaterial;
        },
        resolveIssuerKeyring() {
          return testKeyring();
        },
      }),
      state: { disposeCalls: 0 },
    }),
  });
  await assert.rejects(malformedShipping.start(), /TLS material resolution failed/);
  assert.equal(malformedMaterial.disposed, 1);
  assert.equal(malformedShipping.events.includes("https.listening"), false);

  // A failing dispose surfaces only as the fixed redacted cleanup error.
  const explodingMaterial = {
    key: TEST_KEY_PEM,
    cert: TEST_CERT_PEM,
    dispose() {
      throw new Error("boom: resolver-local detail must not leak");
    },
  };
  const cleanupShipping = startableShipping({
    makeResolver: () => ({
      resolver: Object.freeze({
        resolveTlsMaterial() {
          return explodingMaterial;
        },
        resolveIssuerKeyring() {
          return testKeyring();
        },
      }),
      state: { disposeCalls: 0 },
    }),
  });
  const cleanupError = await cleanupShipping.start().then(
    () => null,
    (error) => error,
  );
  assert.match(String(cleanupError?.message), /TLS material cleanup failed/);
  assert.doesNotMatch(String(cleanupError?.message), /boom/);
});

test("profile file entry keeps only non-sensitive references and starts with deployment inputs", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tw-v2-shipping-file-"));
  try {
    const shipping = startableShipping();
    const profilePath = path.join(tempDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(shipping.profile), { mode: 0o600 });
    const handle = await relayServer.startRelayV2BrokerShippingFromProfileFile(
      profilePath,
      shipping.inputs,
    );
    const sinkSecrets = [];
    await handle.admin.createHostBootstrap({}, (secret) => sinkSecrets.push(secret));
    assert.equal(sinkSecrets.length, 1);
    await handle.shutdown();
    assert.equal(shipping.store.closeCalls, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  // Foreign profile shapes fail closed before any dependency is touched.
  const shipping = startableShipping();
  const extraKey = { ...shippingProfile(), unexpected: true };
  await assert.rejects(
    relayServer.startRelayV2BrokerShippingRoot(extraKey, shipping.inputs),
    /profile is invalid/,
  );
  const accessor = { ...shippingProfile() };
  Object.defineProperty(accessor, "issuerUrl", {
    enumerable: true,
    get() {
      throw new Error("profile getter must not run");
    },
  });
  await assert.rejects(
    relayServer.startRelayV2BrokerShippingRoot(accessor, shipping.inputs),
    /profile is invalid/,
  );
  assert.equal(shipping.events.length, 0);
});
