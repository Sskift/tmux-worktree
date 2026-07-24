import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const relayServer = await import("../dist/relayServer.js");
const deploymentSource = await import("../dist/relay/v2/brokerShippingDeploymentSource.js");
const loaderModule = await import("../dist/relay/v2/brokerCredentialStateStoreLoader.js");
const nodeAttemptProvider = await import("../dist/relay/v2/externalContinuityAuthorityNodeAttemptProvider.js");
const issuer = await import("../dist/relay/v2/issuer.js");

const ENDPOINT = "https://continuity.example.test/external/continuity/v1";
const TEST_SECRET = Buffer.alloc(32, 17).toString("base64url");
const DEPLOYMENT_SUBDIRECTORIES = ["tls", "issuer", "e0"];

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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeHome(tag) {
  // The source requires trustedHome to equal its own canonical realpath; on
  // macOS the temp root itself is a symlink, so canonicalize the fresh home.
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), tag)));
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

function fakeNativeLoader(store, events, openResult = null) {
  return Object.freeze({
    capability() {
      throw new Error("unexpected capability probe");
    },
    async open() {
      events.push("native.open");
      return openResult ?? Object.freeze({ status: "opened", selfCheck: "passed", store });
    },
  });
}

function trackingCreateHttpsServer(events) {
  return (options) => {
    events.push("https.create");
    const server = createHttpsServer(options);
    server.once("listening", () => events.push("https.listening"));
    return server;
  };
}

/**
 * Fake E0 backend behind the provider's Node httpsRequest seam: records the
 * exact URL/options of every request and answers the frozen outer envelope for
 * read and compare_and_swap, mirroring the shipping-root backend semantics.
 */
function e0HttpsBackend(events) {
  const state = { wires: [], requests: [] };
  let casGeneration = 0;
  const request = (url, options, callback) => {
    state.requests.push({ url: url.toString(), options });
    const client = {
      once() {
        return client;
      },
      end(chunk) {
        const wire = JSON.parse(Buffer.from(chunk).toString("utf8"));
        state.wires.push(wire);
        events.push(`e0.wire:${wire.namespace}:${wire.operation}`);
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
        const body = Buffer.from(JSON.stringify({
          contractVersion: 1,
          operationId: wire.operationId,
          ok: true,
          result,
          error: null,
        }), "utf8");
        const response = {
          statusCode: 200,
          rawHeaders: [
            "Content-Type", "application/json",
            "Cache-Control", "no-store",
            "Content-Length", String(body.byteLength),
          ],
          async *[Symbol.asyncIterator]() {
            yield body;
          },
          destroy() {},
        };
        setImmediate(() => callback(response));
        return client;
      },
      destroy() {},
    };
    return client;
  };
  return { httpsRequest: request, state };
}

function testKeyring() {
  return issuer.createRelayV2IssuerKeyring({
    issuerId: "deployment-issuer",
    kid: "deployment-kid",
    secretBase64url: TEST_SECRET,
    nowSeconds: Math.floor(Date.now() / 1_000),
  });
}

function writeMaterial(filePath, contents) {
  writeFileSync(filePath, contents, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function deploymentRoot(home) {
  return path.join(home, ".tmux-worktree", "relay-v2-broker-deployment");
}

function provisionDeployment(home, { e0CaEntries = 1, keyring = null, headers = null, mutualTls = false } = {}) {
  const root = deploymentRoot(home);
  mkdirSync(path.join(home, ".tmux-worktree"), { mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  for (const subdirectory of DEPLOYMENT_SUBDIRECTORIES) {
    mkdirSync(path.join(root, subdirectory), { mode: 0o700 });
  }
  writeMaterial(path.join(root, "tls", "broker-tls-key.key.pem"), TEST_KEY_PEM);
  writeMaterial(path.join(root, "tls", "broker-tls-cert.cert.pem"), TEST_CERT_PEM);
  writeMaterial(path.join(root, "tls", "broker-tls-trust.ca.pem"), TEST_CERT_PEM);
  writeMaterial(
    path.join(root, "issuer", "broker-issuer.keyring.json"),
    JSON.stringify(keyring ?? testKeyring()),
  );
  writeMaterial(
    path.join(root, "e0", "broker-e0-trust.ca.pem"),
    Array.from({ length: e0CaEntries }, () => TEST_CERT_PEM).join("\n"),
  );
  if (mutualTls) {
    writeMaterial(path.join(root, "e0", "broker-e0-credential.cert.pem"), TEST_CERT_PEM);
    writeMaterial(path.join(root, "e0", "broker-e0-credential.key.pem"), TEST_KEY_PEM);
    return;
  }
  writeMaterial(
    path.join(root, "e0", "broker-e0-credential.headers.json"),
    JSON.stringify(headers ?? {
      authenticationHeaders: { Authorization: "Bearer deployment-file-token" },
    }),
  );
}

function deploymentProfile(home, port, overrides = {}) {
  return {
    configVersion: 1,
    listen: { host: "127.0.0.1", port },
    issuerUrl: "https://broker.example.test",
    relayUrl: "wss://broker.example.test",
    trustedHome: home,
    tls: {
      keyReference: "broker-tls-key",
      certificateReference: "broker-tls-cert",
      trustReference: "broker-tls-trust",
    },
    issuerKeyringReference: "broker-issuer",
    externalContinuity: {
      configVersion: 1,
      endpoint: ENDPOINT,
      securityDomainId: "security-domain-a",
      authenticationMode: "workload_identity",
      credentialReference: "broker-e0-credential",
      tlsTrustReference: "broker-e0-trust",
      operationTimeoutMs: 10_000,
      maxPendingOperations: 4,
      namespaceBindings: [
        { namespace: "broker-credential.v1", ownerBinding: "broker-owner", anchorId: "broker-anchor" },
      ],
    },
    ...overrides,
  };
}

function writeProfile(home, profile) {
  const profilePath = path.join(home, "profile.json");
  writeMaterial(profilePath, JSON.stringify(profile));
  return profilePath;
}

/**
 * Combines the file-backed resolvers with the existing injectable boundaries
 * (the E0 provider factory's documented httpsRequest seam and the injectable
 * shipping root) — tests never inject qualification through the production
 * trusted-activation facade, which exposes no seam at all.
 */
function injectableInputs(profile, { events, store, openResult = null }) {
  const resolvers = deploymentSource.createRelayV2BrokerDeploymentFileResolvers(profile);
  const backend = e0HttpsBackend(events);
  const externalContinuityAttemptProvider =
    nodeAttemptProvider.createRelayV2ExternalContinuityAuthorityNodeAttemptProvider({
      resolver: resolvers.externalContinuityMaterialResolver,
      httpsRequest: backend.httpsRequest,
    });
  return {
    backend,
    inputs: {
      privilegedResolver: resolvers.privilegedResolver,
      externalContinuityAttemptProvider,
      nativeLoader: fakeNativeLoader(store, events, openResult),
      createHttpsServer: trackingCreateHttpsServer(events),
    },
  };
}

function namespaceSnapshot(home) {
  const root = deploymentRoot(home);
  const snapshot = {};
  for (const subdirectory of DEPLOYMENT_SUBDIRECTORIES) {
    for (const name of readdirSync(path.join(root, subdirectory)).sort()) {
      snapshot[`${subdirectory}/${name}`] = readFileSync(path.join(root, subdirectory, name), "utf8");
    }
  }
  return snapshot;
}

function postJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Length": String(payload.byteLength),
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
    request.write(payload);
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

test("explicit v2 profile CLI routes through the trusted deployment source owner", async () => {
  delete process.env.TW_RELAY_SECRET;
  const home = makeHome("tw-v2-deploy-cli-");
  try {
    const port = await reserveFreePort();
    const profilePath = writeProfile(home, deploymentProfile(home, port));

    // No deployment namespace exists under the trusted home: the CLI fails
    // closed through the deployment source before any listener, and the v1
    // shared secret in the environment is never used to start v1 instead.
    process.env.TW_RELAY_SECRET = "v1-secret-that-must-not-be-used";
    const blocker = await runCli(["--v2-profile", profilePath]);
    assert.match(String(blocker?.message), /deployment source is unavailable/);
    assert.equal(await connectRefused(port), true);

    // A reference that is not a strict identifier fails closed as invalid.
    const badPath = writeProfile(home, deploymentProfile(home, port, {
      tls: { keyReference: "../escape", certificateReference: "broker-tls-cert" },
    }));
    const invalid = await runCli(["--v2-profile", badPath]);
    assert.match(String(invalid?.message), /deployment source is invalid/);
    assert.equal(await connectRefused(port), true);

    // Mutual exclusion with v1 flags is unchanged.
    const ambiguousSecret = await runCli(["--v2-profile", profilePath, "--secret", "x"]);
    assert.match(String(ambiguousSecret?.message), /--secret/);
    const ambiguousListen = await runCli(["--v2-profile", profilePath, "--port", "9999"]);
    assert.match(String(ambiguousListen?.message), /--host\/--port/);
  } finally {
    delete process.env.TW_RELAY_SECRET;
    rmSync(home, { recursive: true, force: true });
  }
});

test("fully provisioned trusted deployment starts the shipping root and closes cleanly", async () => {
  const home = makeHome("tw-v2-deploy-ok-");
  const events = [];
  try {
    provisionDeployment(home, { e0CaEntries: 2 });
    const port = await reserveFreePort();
    const profile = deploymentProfile(home, port);
    const store = new NarrowNativeStore();
    const { backend, inputs } = injectableInputs(profile, { events, store });
    const handle = await relayServer.startRelayV2BrokerShippingRoot(profile, inputs);
    try {
      assert.equal(handle.port, port);
      const at = (name) => events.indexOf(name);
      assert.ok(at("native.open") !== -1 && at("native.open") < at("https.listening"));
      assert.ok(at("e0.wire:broker-credential.v1:read") !== -1
        && at("e0.wire:broker-credential.v1:read") < at("https.listening"));

      // TLS termination comes from the deployment key/cert: plain HTTP fails.
      await assert.rejects(plainHttpGet(port));

      // The real Node E0 attempt provider bound the deployment-file CA bundle
      // and workload headers to the profile's exact endpoint.
      assert.ok(backend.state.requests.length >= 1);
      for (const request of backend.state.requests) {
        assert.equal(request.url, ENDPOINT);
        assert.equal(request.options.headers.Authorization, "Bearer deployment-file-token");
        assert.equal(request.options.ca.length, 2);
        assert.match(Buffer.from(request.options.ca[0]).toString("utf8"), /BEGIN CERTIFICATE/);
      }

      // The local admin seam issues a bootstrap secret only to the sink; the
      // token redeems through the real public HTTPS ingress.
      const sinkSecrets = [];
      await handle.admin.createHostBootstrap({}, (secret) => sinkSecrets.push(secret));
      assert.equal(sinkSecrets.length, 1);
      assert.match(sinkSecrets[0], /^twhostboot2\./);
      const redeemed = await postJson(handle.port, "/v2/hosts/bootstrap", {
        bootstrapAttemptId: "deployment-attempt-1",
        bootstrapToken: sinkSecrets[0],
        hostId: "deployment-host",
        hostEpoch: "deployment-epoch",
        hostInstanceId: "deployment-instance",
      });
      assert.equal(redeemed.status, 200);
      assert.match(redeemed.json?.accessToken ?? "", /^twcap2\./);
    } finally {
      await handle.shutdown();
    }
    assert.equal(store.closeCalls, 1);
    assert.equal(await connectRefused(port), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const unsafeScenarios = [
  {
    name: "symlinked material file",
    mutate(root) {
      const target = path.join(root, "tls", "broker-tls-key.key.pem");
      rmSync(target);
      symlinkSync(path.join(root, "tls", "broker-tls-cert.cert.pem"), target);
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE",
  },
  {
    name: "group-readable material file",
    mutate(root) {
      chmodSync(path.join(root, "tls", "broker-tls-key.key.pem"), 0o644);
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE",
  },
  {
    name: "hard-linked material file",
    mutate(root) {
      linkSync(
        path.join(root, "tls", "broker-tls-key.key.pem"),
        path.join(root, "tls", "second-link.pem"),
      );
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE",
  },
  {
    name: "malformed keyring JSON",
    mutate(root) {
      writeMaterial(path.join(root, "issuer", "broker-issuer.keyring.json"), "{ not json");
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_INVALID",
  },
  {
    name: "malformed workload headers JSON",
    mutate(root) {
      writeMaterial(
        path.join(root, "e0", "broker-e0-credential.headers.json"),
        JSON.stringify({ authenticationHeaders: { Authorization: 42 } }),
      );
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_INVALID",
  },
  {
    name: "oversize material file",
    mutate(root) {
      writeMaterial(path.join(root, "tls", "broker-tls-key.key.pem"), Buffer.alloc(16_385, 65));
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE",
  },
  {
    name: "missing material file",
    mutate(root) {
      rmSync(path.join(root, "tls", "broker-tls-key.key.pem"));
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE",
  },
  {
    name: "non-identifier reference",
    mutate() {},
    profileOverrides: {
      tls: { keyReference: "../escape", certificateReference: "broker-tls-cert" },
    },
    code: "RELAY_V2_BROKER_DEPLOYMENT_INVALID",
  },
];

for (const scenario of unsafeScenarios) {
  test(`unsafe deployment source fails closed during trusted activation: ${scenario.name}`, async () => {
    const home = makeHome("tw-v2-deploy-unsafe-");
    try {
      provisionDeployment(home);
      scenario.mutate(deploymentRoot(home));
      const profile = deploymentProfile(home, 8787, scenario.profileOverrides ?? {});
      // Activation capture plus the eager validation pass reject before any
      // native loader, attempt provider, or listener can be involved.
      const error = (() => {
        try {
          deploymentSource.createRelayV2BrokerDeploymentFileResolvers(profile);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      assert.ok(error instanceof deploymentSource.RelayV2BrokerShippingDeploymentSourceError);
      assert.equal(error.code, scenario.code);
      // Fixed redacted surface: no path, identifier, or material detail leaks.
      assert.doesNotMatch(error.message, new RegExp(escapeRegExp(home)));
      assert.doesNotMatch(error.message, /broker-tls|broker-issuer|broker-e0|escape/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("production defaults bind the fixed native loader, frozen resolvers, and the real Node E0 provider", async () => {
  const home = makeHome("tw-v2-deploy-lineage-");
  try {
    provisionDeployment(home);
    const port = await reserveFreePort();
    const profile = deploymentProfile(home, port);

    // Without seams the native loader is exactly the fixed production loader.
    const production = deploymentSource.createRelayV2BrokerShippingDeploymentInputs(profile);
    assert.equal(
      production.nativeLoader,
      loaderModule.relayV2BrokerCredentialStateStoreNativeLoader,
    );
    assert.equal(Object.isFrozen(production), true);
    assert.equal(Object.hasOwn(production, "createHttpsServer"), false);
    assert.equal(Object.isFrozen(production.privilegedResolver), true);
    assert.deepEqual(
      Object.getOwnPropertyNames(production.privilegedResolver).sort(),
      ["resolveIssuerKeyring", "resolveTlsMaterial"],
    );
    for (const name of ["resolveTlsMaterial", "resolveIssuerKeyring"]) {
      const descriptor = Object.getOwnPropertyDescriptor(production.privilegedResolver, name);
      assert.equal(typeof descriptor.value, "function");
      assert.equal(descriptor.get, undefined);
      assert.equal(descriptor.set, undefined);
    }
    assert.equal(Object.isFrozen(production.externalContinuityAttemptProvider), true);
    assert.deepEqual(
      Object.getOwnPropertyNames(production.externalContinuityAttemptProvider),
      ["resolveAttempt"],
    );

    // The real Node attempt provider resolves trust/credential material from
    // the deployment files and binds it to the profile's exact endpoint. The
    // observation below uses only the provider factory's own documented
    // httpsRequest test seam over the file-backed resolver.
    const events = [];
    const resolvers = deploymentSource.createRelayV2BrokerDeploymentFileResolvers(profile);
    const backend = e0HttpsBackend(events);
    const provider = nodeAttemptProvider.createRelayV2ExternalContinuityAuthorityNodeAttemptProvider({
      resolver: resolvers.externalContinuityMaterialResolver,
      httpsRequest: backend.httpsRequest,
    });
    const attempt = provider.resolveAttempt(Object.freeze({
      endpoint: ENDPOINT,
      authenticationMode: "workload_identity",
      credentialReference: "broker-e0-credential",
      tlsTrustReference: "broker-e0-trust",
    }));
    assert.equal(attempt.authenticationHeaders().Authorization, "Bearer deployment-file-token");
    const exchange = attempt.transport.start({
      endpoint: ENDPOINT,
      method: "POST",
      headers: { ...attempt.authenticationHeaders() },
      body: Buffer.from(JSON.stringify({
        operationId: "lineage-read",
        namespace: "broker-credential.v1",
        operation: "read",
      }), "utf8"),
    });
    const response = await exchange.response;
    assert.equal(response.statusCode, 200);
    response.destroy();
    assert.equal(backend.state.requests.length, 1);
    assert.equal(backend.state.requests[0].url, ENDPOINT);
    assert.equal(backend.state.requests[0].options.ca.length, 1);

    // A foreign endpoint, reference, or mode fails closed and redacted.
    const mismatchedEndpoint = provider.resolveAttempt(Object.freeze({
      endpoint: ENDPOINT,
      authenticationMode: "workload_identity",
      credentialReference: "broker-e0-credential",
      tlsTrustReference: "broker-e0-trust",
    }));
    assert.throws(
      () => mismatchedEndpoint.transport.start({
        endpoint: "https://other.example.test/external/continuity/v1",
        method: "POST",
        headers: {},
        body: Buffer.from("{}"),
      }),
      /Node attempt provider resolution failed/,
    );
    for (const mismatch of [
      { credentialReference: "other-credential" },
      { tlsTrustReference: "other-trust" },
      { authenticationMode: "mutual_tls" },
    ]) {
      const request = Object.freeze({
        endpoint: ENDPOINT,
        authenticationMode: "workload_identity",
        credentialReference: "broker-e0-credential",
        tlsTrustReference: "broker-e0-trust",
        ...mismatch,
      });
      assert.throws(
        () => provider.resolveAttempt(request),
        (error) => {
          assert.match(String(error?.message), /Node attempt provider resolution failed/);
          assert.doesNotMatch(String(error?.message), /other|mutual_tls/);
          return true;
        },
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mutual_tls E0 credential material resolves from the fixed namespace files", async () => {
  const home = makeHome("tw-v2-deploy-mtls-");
  const events = [];
  try {
    provisionDeployment(home, { mutualTls: true });
    const port = await reserveFreePort();
    const base = deploymentProfile(home, port);
    const profile = {
      ...base,
      externalContinuity: { ...base.externalContinuity, authenticationMode: "mutual_tls" },
    };
    const backend = e0HttpsBackend(events);
    const resolvers = deploymentSource.createRelayV2BrokerDeploymentFileResolvers(profile);
    const provider = nodeAttemptProvider.createRelayV2ExternalContinuityAuthorityNodeAttemptProvider({
      resolver: resolvers.externalContinuityMaterialResolver,
      httpsRequest: backend.httpsRequest,
    });
    const attempt = provider.resolveAttempt(Object.freeze({
      endpoint: ENDPOINT,
      authenticationMode: "mutual_tls",
      credentialReference: "broker-e0-credential",
      tlsTrustReference: "broker-e0-trust",
    }));
    assert.equal(Object.keys(attempt.authenticationHeaders()).length, 0);
    const exchange = attempt.transport.start({
      endpoint: ENDPOINT,
      method: "POST",
      headers: {},
      body: Buffer.from(JSON.stringify({
        operationId: "mtls-read",
        namespace: "broker-credential.v1",
        operation: "read",
      }), "utf8"),
    });
    const response = await exchange.response;
    assert.equal(response.statusCode, 200);
    response.destroy();
    const seen = backend.state.requests[0].options;
    assert.equal(backend.state.requests[0].url, ENDPOINT);
    assert.match(Buffer.from(seen.cert).toString("utf8"), /BEGIN CERTIFICATE/);
    assert.match(Buffer.from(seen.key).toString("utf8"), /BEGIN PRIVATE KEY/);
    assert.equal(seen.ca.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native qualification failure rolls back before listen and leaves the namespace untouched", async () => {
  const home = makeHome("tw-v2-deploy-rollback-");
  const events = [];
  try {
    provisionDeployment(home);
    const port = await reserveFreePort();
    const profile = deploymentProfile(home, port);
    const snapshotBefore = namespaceSnapshot(home);
    const store = new NarrowNativeStore();
    const { backend, inputs } = injectableInputs(profile, {
      events,
      store,
      openResult: Object.freeze({ status: "unsupported", reason: "native_artifact_missing" }),
    });
    const error = await relayServer.startRelayV2BrokerShippingRoot(profile, inputs)
      .then(() => null, (caught) => caught);
    assert.match(String(error?.message), /activated composition failed to open/);
    assert.equal(events.filter((event) => event === "native.open").length, 1);
    assert.equal(events.includes("https.listening"), false);
    assert.equal(backend.state.requests.length, 0);
    assert.equal(await connectRefused(port), true);
    // The source is strictly read-only: no file was created, removed, or modified.
    assert.deepEqual(namespaceSnapshot(home), snapshotBefore);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
