import assert from "node:assert/strict";
import test from "node:test";
import {
  RelayV2DashboardManagementCompositionClosedError,
  claimRelayV2DashboardManagementCompositionForProtocolV2Session,
  createRelayV2DashboardManagementComposition,
} from "../dist/relay/v2/relayV2DashboardManagementComposition.js";
import {
  RelayV2HostCarrierActor,
} from "../dist/relay/v2/hostCarrier.js";
import {
  RelayV2HostConnectorController,
} from "../dist/relay/v2/hostConnectorController.js";
import {
  RelayV2HostCredentialAuthority,
} from "../dist/relay/v2/hostCredentialAuthority.js";
import {
  RelayV2HostCredentialExchangeCoordinator,
} from "../dist/relay/v2/hostCredentialExchangeCoordinator.js";
import {
  createRelayV2IssuerKeyring,
  prepareRelayV2AccessTokenIssuance,
} from "../dist/relay/v2/issuer.js";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "../dist/relay/v2/codec.js";
import {
  decodeRelayV2DashboardManagementProtocolV2Request,
} from "../dist/relay/v2/relayV2DashboardManagementProtocolV2.js";

const NOW_MS = 1_783_700_000_000;
const IDENTITY = Object.freeze({
  hostId: "mac-admin",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
  credentialReference: "relay-v2-host-credential-ref:primary",
});
const BOOTSTRAP_SECRET_REFERENCE = "bootstrap-secret-reference-one";
const REFRESH_SECRET_REFERENCE = "refresh-secret-reference-one";
const BOOTSTRAP_TOKEN = "twhostboot2.composition-bootstrap-secret";
const REFRESH_TOKEN = "twref2.composition-refresh-secret";
const SECRET_MARKERS = Object.freeze([
  BOOTSTRAP_TOKEN,
  REFRESH_TOKEN,
  "twcap2.",
]);
const IDS = Object.freeze({
  status: "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw",
  bootstrap: "dmgmt2.wkHofchV36_U1sOtXF-hvA",
  start: "dmgmt2.GGg3IoUgDIXzfENx8QbHlw",
  create: "dmgmt2.ocsJ9anwzHRz4iyXdA5cjA",
  revoke: "dmgmt2._rgZ2FBzDmkt9MwqnM3uDg",
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

function request(operation, input = null) {
  const requestId = {
    status: IDS.status,
    bootstrap_host: IDS.bootstrap,
    start_connector: IDS.start,
    create_enrollment: IDS.create,
    revoke_client_grant: IDS.revoke,
  }[operation];
  return decodeRelayV2DashboardManagementProtocolV2Request(Buffer.from(JSON.stringify({
    protocolVersion: 2,
    requestId,
    operation,
    input,
  })));
}

function wire(frame) {
  return encodeRelayV2WebSocketFrame("carrier", frame);
}

function decoded(frames) {
  return frames.map((frame) => decodeRelayV2WebSocketFrame("carrier", frame).frame);
}

class InMemoryCredentialStorage {
  state = null;
  revision = 0;
  revisions = new WeakMap();
  failed = false;

  runExclusive(_reference, operation) {
    if (this.failed) throw new Error("twref2.storage-secret-must-not-reflect");
    const read = () => {
      const revision = Object.freeze({ revision: true });
      this.revisions.set(revision, this.revision);
      return {
        state: this.state === null ? null : structuredClone(this.state),
        revision,
      };
    };
    return operation({
      read,
      compareAndSwap: (expected, replacement) => {
        if (this.revisions.get(expected) !== this.revision) {
          return { status: "conflict", current: read() };
        }
        this.state = structuredClone(replacement);
        this.revision += 1;
        return { status: "swapped" };
      },
    });
  }
}

class FakeTransport {
  sent = [];
  pending = [];
  bufferedBytes = 0;
  closes = [];

  trySend(frame, deliveryToken) {
    const bytes = Uint8Array.from(frame);
    this.sent.push(bytes);
    this.pending.push({ deliveryToken, byteLength: bytes.byteLength });
    this.bufferedBytes += bytes.byteLength;
    return true;
  }

  bufferedAmount() {
    return this.bufferedBytes;
  }

  confirmNext() {
    const next = this.pending.shift();
    assert.ok(next);
    this.bufferedBytes -= next.byteLength;
    return next.deliveryToken;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

function tokenIssuer() {
  let keyring = createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "composition-key-one",
    secretBase64url: Buffer.alloc(32, 0x63).toString("base64url"),
    nowSeconds: NOW_MS / 1_000,
  });
  let sequence = 0;
  return (hostId) => {
    sequence += 1;
    const prepared = prepareRelayV2AccessTokenIssuance(keyring, {
      role: "host",
      hostId,
      principalId: "host-principal-one",
      grantId: "host-grant-one",
      nowSeconds: NOW_MS / 1_000 + sequence,
      jti: `host-access-jti-${sequence}`,
    });
    keyring = prepared.nextKeyring;
    return prepared;
  };
}

function bootstrapResponse(input, access) {
  return {
    bootstrapAttemptId: input.bootstrapAttemptId,
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: input.hostId,
    accessToken: access.token,
    accessExpiresAtMs: access.claims.exp * 1_000,
    refreshToken: REFRESH_TOKEN,
    refreshExpiresAtMs: NOW_MS + 2_592_000_000,
  };
}

function harness(options = {}) {
  const storage = new InMemoryCredentialStorage();
  const issueToken = tokenIssuer();
  const authority = new RelayV2HostCredentialAuthority({
    storage,
    secretResolver: {
      resolve(reference) {
        if (reference === BOOTSTRAP_SECRET_REFERENCE) return BOOTSTRAP_TOKEN;
        if (reference === REFRESH_SECRET_REFERENCE) return REFRESH_TOKEN;
        throw new Error("twhostboot2.unknown-secret-must-not-reflect");
      },
    },
  });
  const networkCalls = [];
  const coordinator = new RelayV2HostCredentialExchangeCoordinator({
    authority,
    httpsAdapter: {
      async bootstrap(input, signal) {
        networkCalls.push({ operation: "bootstrap", input: structuredClone(input), signal });
        if (options.bootstrapGate) await options.bootstrapGate.promise;
        return bootstrapResponse(input, issueToken(input.hostId));
      },
      async refresh() {
        throw new Error("refresh is outside this suite");
      },
    },
  });
  const attempts = [];
  let statusSink = null;
  let actor;
  actor = new RelayV2HostCarrierActor({
    ...IDENTITY,
    credentialReferences: authority,
    advertisedCapabilities: [],
    idFactory: () => "host-hello-composition-one",
    clock: () => NOW_MS,
    onStatus(status) {
      statusSink?.(status);
    },
    routeSink: {
      onRouteBound() {},
      onClientFrame() {},
      onRouteUnbound() {},
    },
  });
  const attemptFactory = Object.freeze({
    startAttempt(input) {
      statusSink = input.onCarrierStatus;
      const transport = new FakeTransport();
      const connection = actor.connect(transport, input.credentialReference);
      const attempt = {
        input,
        transport,
        connection,
        drainCalls: [],
        drainGate: options.drainGate ?? null,
      };
      attempts.push(attempt);
      return Object.freeze({
        async disposeAndDrain(drainInput) {
          attempt.drainCalls.push(structuredClone(drainInput));
          if (attempt.drainGate) await attempt.drainGate.promise;
          actor.dispose();
          statusSink = null;
          return {
            status: "closed_and_drained",
            controllerGeneration: drainInput.controllerGeneration,
            carrierGeneration: drainInput.carrierGeneration,
            connectorId: drainInput.connectorId,
          };
        },
      });
    },
  });
  const controller = new RelayV2HostConnectorController({
    attempts: attemptFactory,
    ...IDENTITY,
  });
  const signal = new AbortController().signal;
  const clock = () => NOW_MS;
  const compositionOptions = {
    credentialAuthority: authority,
    credentialExchangeCoordinator: coordinator,
    connectorController: controller,
    hostCarrierActor: actor,
    ...IDENTITY,
    bootstrapSecretReference: BOOTSTRAP_SECRET_REFERENCE,
    refreshSecretReference: REFRESH_SECRET_REFERENCE,
    signal,
    clock,
  };

  function installReady() {
    const prepared = authority.prepareBootstrap({
      credentialReference: IDENTITY.credentialReference,
      hostId: IDENTITY.hostId,
      attemptId: "installed-bootstrap-attempt",
      oldSecretReference: BOOTSTRAP_SECRET_REFERENCE,
    });
    const access = issueToken(IDENTITY.hostId);
    assert.deepEqual(authority.applyBootstrapResponse(
      prepared.fence,
      bootstrapResponse({
        bootstrapAttemptId: prepared.fence.attemptId,
        hostId: IDENTITY.hostId,
      }, access),
    ), { status: "applied", credentialVersion: "1" });
  }
  if (options.ready) installReady();
  const composition = options.activate === false
    ? null
    : createRelayV2DashboardManagementComposition(compositionOptions);
  return {
    actor,
    attempts,
    authority,
    composition,
    compositionOptions,
    controller,
    coordinator,
    installReady,
    networkCalls,
    storage,
  };
}

async function registerStartedAttempt(h, connectorId = "connector-composition-one") {
  const start = h.composition.handleRequest(request("start_connector"));
  await nextTurn();
  const attempt = h.attempts.at(-1);
  assert.ok(attempt);
  const hello = decoded(attempt.transport.sent).find(({ type }) => type === "host.hello");
  assert.ok(hello);
  attempt.connection.receive(wire({
    carrierVersion: 1,
    type: "host.registered",
    requestId: hello.requestId,
    connectorId,
    payload: {
      brokerEpoch: "broker-epoch-one",
      hostsRevision: "1",
      disposition: "connected",
      supersededHostInstanceId: null,
      limits: {
        maxCarrierFrameBytes: 1_500_000,
        brokerCarrierBufferedBytes: 16_777_216,
        brokerCarrierLowWaterBytes: 8_388_608,
      },
    },
  }));
  attempt.connection.acknowledge(attempt.transport.confirmNext());
  return { attempt, response: await start, connectorId };
}

test("the real adapter composition projects stopped through registered_incomplete and uses one HostCarrier control", async () => {
  const h = harness({ ready: true });
  const initial = await h.composition.handleRequest(request("status"));
  assert.equal(initial.result.hostCredential.status, "ready");
  assert.deepEqual(initial.result.connector, { status: "stopped" });

  const registered = await registerStartedAttempt(h);
  assert.deepEqual(registered.response.result.connector, {
    status: "registered_incomplete",
    acknowledgement: "host.registered",
    hostId: IDENTITY.hostId,
    connectorId: registered.connectorId,
    negotiatedCapabilityIntersection: [],
  });

  const create = await h.composition.handleRequest(request(
    "create_enrollment",
    { deviceLabel: "Pixel" },
  ));
  assert.equal(create.error.code, "NOT_READY");
  assert.equal(
    decoded(registered.attempt.transport.sent).some(({ type }) => type === "enrollment.create"),
    false,
    "empty negotiated capability evidence cannot generate an enrollment",
  );

  const revokePending = h.composition.handleRequest(request(
    "revoke_client_grant",
    { grantId: "client-grant-one", reason: "user_revoked" },
  ));
  await nextTurn();
  const revokeFrames = decoded(registered.attempt.transport.sent)
    .filter(({ type }) => type === "grant.revoke");
  assert.deepEqual(JSON.parse(JSON.stringify(revokeFrames)), [{
    carrierVersion: 1,
    type: "grant.revoke",
    requestId: IDS.revoke,
    connectorId: registered.connectorId,
    payload: { grantId: "client-grant-one", reason: "user_revoked" },
  }]);
  registered.attempt.connection.receive(wire({
    carrierVersion: 1,
    type: "grant.revoked",
    requestId: IDS.revoke,
    connectorId: registered.connectorId,
    payload: {
      grantId: "client-grant-one",
      revokedAtMs: NOW_MS + 100,
      alreadyRevoked: false,
    },
  }));
  const revoked = await revokePending;
  assert.deepEqual(revoked.result.knownClientGrant, {
    status: "revoked",
    grantId: "client-grant-one",
    revokedAtMs: NOW_MS + 100,
    alreadyRevoked: false,
  });
  for (const response of [initial, registered.response, create, revoked]) {
    const serialized = JSON.stringify(response);
    for (const marker of SECRET_MARKERS) assert.equal(serialized.includes(marker), false);
  }
});

test("credential missing and authority failure remain closed non-secret projections", async (t) => {
  await t.test("missing", async () => {
    const h = harness();
    const status = await h.composition.handleRequest(request("status"));
    assert.deepEqual(status.result.hostCredential, { status: "missing" });
  });
  await t.test("failed", async () => {
    const h = harness();
    h.storage.failed = true;
    const status = await h.composition.handleRequest(request("status"));
    assert.deepEqual(status.result.hostCredential, { status: "failed", retryable: true });
    assert.equal(JSON.stringify(status).includes("storage-secret-must-not-reflect"), false);
  });
});

test("the serial authority holds later requests behind one real credential exchange", async () => {
  const bootstrapGate = deferred();
  const h = harness({ bootstrapGate });
  const bootstrap = h.composition.handleRequest(request("bootstrap_host"));
  let statusSettled = false;
  const status = h.composition.handleRequest(request("status")).then((value) => {
    statusSettled = true;
    return value;
  });
  await nextTurn();
  assert.equal(h.networkCalls.length, 1);
  assert.equal(statusSettled, false);
  bootstrapGate.resolve();
  const [bootstrapped, observed] = await Promise.all([bootstrap, status]);
  assert.equal(bootstrapped.result.hostCredential.status, "ready");
  assert.equal(observed.result.hostCredential.status, "ready");
  assert.equal(h.networkCalls.length, 1);
});

test("close fences new requests, waits admitted management work, and drains only the exact controller", async () => {
  const drainGate = deferred();
  const h = harness({ ready: true, drainGate });
  const registered = await registerStartedAttempt(h);
  const revokePending = h.composition.handleRequest(request(
    "revoke_client_grant",
    { grantId: "client-grant-one", reason: "user_revoked" },
  ));
  await nextTurn();
  const close = h.composition.closeAndDrain();
  assert.strictEqual(h.composition.closeAndDrain(), close);
  await assert.rejects(
    h.composition.handleRequest(request("status")),
    RelayV2DashboardManagementCompositionClosedError,
  );
  await nextTurn();
  assert.equal(registered.attempt.drainCalls.length, 0);

  registered.attempt.connection.receive(wire({
    carrierVersion: 1,
    type: "grant.revoked",
    requestId: IDS.revoke,
    connectorId: registered.connectorId,
    payload: {
      grantId: "client-grant-one",
      revokedAtMs: NOW_MS + 200,
      alreadyRevoked: false,
    },
  }));
  await revokePending;
  await nextTurn();
  assert.equal(registered.attempt.drainCalls.length, 1);
  assert.deepEqual(registered.attempt.drainCalls[0], {
    controllerGeneration: "1",
    carrierGeneration: 1,
    connectorId: registered.connectorId,
  });
  let closeSettled = false;
  void close.then(() => { closeSettled = true; });
  await nextTurn();
  assert.equal(closeSettled, false);
  drainGate.resolve();
  await close;
  assert.equal(closeSettled, true);
  assert.deepEqual(h.controller.inspectCut(), {
    status: "stopped",
    controllerGeneration: "1",
  });
});

test("activation rejects foreign lineages, structural ports, stale owners, and replacement", async (t) => {
  await t.test("structural controller", () => {
    const h = harness({ activate: false });
    assert.throws(
      () => createRelayV2DashboardManagementComposition({
        ...h.compositionOptions,
        connectorController: {
          inspectCut: () => ({ status: "stopped", controllerGeneration: "0" }),
          start: async () => {},
          stopAndDrain: async () => {},
        },
      }),
      RelayV2DashboardManagementCompositionClosedError,
    );
  });

  await t.test("foreign coordinator authority", () => {
    const h = harness({ activate: false });
    const foreignAuthority = new RelayV2HostCredentialAuthority({
      storage: new InMemoryCredentialStorage(),
      secretResolver: { resolve: () => BOOTSTRAP_TOKEN },
    });
    const foreignCoordinator = new RelayV2HostCredentialExchangeCoordinator({
      authority: foreignAuthority,
      httpsAdapter: { bootstrap: async () => {}, refresh: async () => {} },
    });
    assert.throws(
      () => createRelayV2DashboardManagementComposition({
        ...h.compositionOptions,
        credentialExchangeCoordinator: foreignCoordinator,
      }),
      RelayV2DashboardManagementCompositionClosedError,
    );
  });

  await t.test("foreign actor lineage", () => {
    const h = harness({ activate: false });
    const foreignActor = new RelayV2HostCarrierActor({
      hostId: "foreign-host",
      hostEpoch: IDENTITY.hostEpoch,
      hostInstanceId: IDENTITY.hostInstanceId,
      credentialReferences: h.authority,
      routeSink: {
        onRouteBound() {}, onClientFrame() {}, onRouteUnbound() {},
      },
    });
    assert.throws(
      () => createRelayV2DashboardManagementComposition({
        ...h.compositionOptions,
        hostCarrierActor: foreignActor,
      }),
      RelayV2DashboardManagementCompositionClosedError,
    );
  });

  await t.test("stale controller", async () => {
    const h = harness({ activate: false });
    const staleController = new RelayV2HostConnectorController({
      ...IDENTITY,
      attempts: {
        startAttempt(input) {
          input.onCarrierStatus({
            phase: "offline", generation: 1, connectorId: null, closeCode: 1006,
          });
          return { disposeAndDrain: (value) => ({ status: "closed_and_drained", ...value }) };
        },
      },
    });
    await assert.rejects(staleController.start({
      requestId: "stale-controller-start",
      ...IDENTITY,
      signal: h.compositionOptions.signal,
    }));
    assert.throws(
      () => createRelayV2DashboardManagementComposition({
        ...h.compositionOptions,
        connectorController: staleController,
      }),
      RelayV2DashboardManagementCompositionClosedError,
    );
  });

  await t.test("duplicate activate is idempotent and replacement is rejected", () => {
    const h = harness();
    assert.strictEqual(
      createRelayV2DashboardManagementComposition(h.compositionOptions),
      h.composition,
    );
    const replacementActor = new RelayV2HostCarrierActor({
      ...IDENTITY,
      credentialReferences: h.authority,
      routeSink: {
        onRouteBound() {}, onClientFrame() {}, onRouteUnbound() {},
      },
    });
    assert.throws(
      () => createRelayV2DashboardManagementComposition({
        ...h.compositionOptions,
        hostCarrierActor: replacementActor,
      }),
      RelayV2DashboardManagementCompositionClosedError,
    );
  });

  await t.test("exclusive protocol-v2 session claim rejects an existing activation", () => {
    const h = harness();
    assert.throws(
      () => claimRelayV2DashboardManagementCompositionForProtocolV2Session(
        h.compositionOptions,
      ),
      RelayV2DashboardManagementCompositionClosedError,
    );
  });
});

test("the public handle has no reflective owner, adapter, actor, credential, or secret surface", () => {
  const h = harness();
  assert.deepEqual(Reflect.ownKeys(h.composition).sort(), ["closeAndDrain", "handleRequest"]);
  assert.deepEqual(Object.keys(Object.getOwnPropertyDescriptors(h.composition)).sort(), [
    "closeAndDrain",
    "handleRequest",
  ]);
  for (const key of [
    "authority", "credential", "connector", "carrierControl", "controller", "actor",
    "credentialAuthority", "credentialReference", "owner", "secret", "signal", "clock",
    "#authority", "#controller", "#actor", "toJSON",
  ]) assert.equal(Reflect.get(h.composition, key), undefined);
  assert.equal(Object.values(h.composition).includes(h.authority), false);
  assert.equal(Object.values(h.composition).includes(h.controller), false);
  assert.equal(Object.values(h.composition).includes(h.actor), false);
  const serialized = JSON.stringify(h.composition);
  for (const marker of SECRET_MARKERS) assert.equal(serialized.includes(marker), false);
});
