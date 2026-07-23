import assert from "node:assert/strict";
import test from "node:test";

const codec = await import("../dist/relay/v2/codec.js");
const { RelayV2HostCarrierActor } = await import("../dist/relay/v2/hostCarrier.js");
const { RelayV2HostCredentialAuthority } = await import("../dist/relay/v2/hostCredentialAuthority.js");
const { RelayV2HostCredentialExchangeCoordinator } = await import(
  "../dist/relay/v2/hostCredentialExchangeCoordinator.js"
);
const { RelayV2HostReauthenticationLifecycleOwner } = await import(
  "../dist/relay/v2/hostReauthenticationLifecycleOwner.js"
);
const issuer = await import("../dist/relay/v2/issuer.js");

const NOW_SECONDS = 1_783_700_000;
const HOST_ID = "mac-admin";
const HOST_EPOCH = "host-epoch-uuid";
const HOST_INSTANCE_ID = "host-process-uuid";
const CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:primary";
const BOOTSTRAP_SECRET_REFERENCE = "bootstrap-secret-slot";
const REFRESH_SECRET_REFERENCE = "refresh-secret-slot";
const BOOTSTRAP_TOKEN = "twhostboot2.bootstrap-secret-material";
const PRINCIPAL_ID = "host-principal-uuid";
const GRANT_ID = "host-grant-uuid";
const REFRESH_EXP = 1_786_292_000_000;

function wire(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function decoded(frames) {
  return frames.map((frame) => codec.decodeRelayV2WebSocketFrame("carrier", frame).frame);
}

function reauthenticateFrames(transport) {
  return decoded(transport.sent).filter((frame) => frame.type === "host.reauthenticate");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function signalFor(expiresAtMs, overrides = {}) {
  return {
    grantId: GRANT_ID,
    expiresAtMs,
    refreshRecommendedAtMs: expiresAtMs - 60_000,
    ...overrides,
  };
}

class InMemoryDurableCredentialStorage {
  slots = new Map();
  revisions = new WeakMap();
  operations = 0;

  runExclusive(reference, operation) {
    this.operations += 1;
    const transaction = {
      read: () => this.readCut(reference),
      compareAndSwap: (expected, replacement) => {
        const identity = this.revisions.get(expected);
        const slot = this.slot(reference);
        if (!identity || identity.reference !== reference || identity.revision !== slot.revision) {
          return { status: "conflict", current: this.readCut(reference) };
        }
        slot.state = structuredClone(replacement);
        slot.revision += 1;
        return { status: "swapped" };
      },
    };
    return operation(transaction);
  }

  snapshot(reference) {
    const state = this.slot(reference).state;
    return state === null ? null : structuredClone(state);
  }

  replace(reference, state) {
    const slot = this.slot(reference);
    slot.state = structuredClone(state);
    slot.revision += 1;
  }

  slot(reference) {
    let slot = this.slots.get(reference);
    if (!slot) {
      slot = { state: null, revision: 0 };
      this.slots.set(reference, slot);
    }
    return slot;
  }

  readCut(reference) {
    const slot = this.slot(reference);
    const revision = Object.freeze({ opaque: true });
    this.revisions.set(revision, { reference, revision: slot.revision });
    return {
      state: slot.state === null ? null : deepFreeze(structuredClone(slot.state)),
      revision,
    };
  }
}

/** Refresh secrets track the durable Vault slot: resolve returns the live token. */
class VaultSyncedSecretResolver {
  resolutions = [];

  constructor(storage) {
    this.storage = storage;
  }

  resolve(reference) {
    this.resolutions.push(reference);
    if (reference === BOOTSTRAP_SECRET_REFERENCE) return BOOTSTRAP_TOKEN;
    if (reference === REFRESH_SECRET_REFERENCE) {
      const state = this.storage.snapshot(CREDENTIAL_REFERENCE);
      if (state !== null && typeof state.refreshToken === "string") return state.refreshToken;
    }
    throw new Error("secret source unavailable");
  }
}

function tokenIssuer() {
  let keyring = issuer.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "host-credential-test-key",
    secretBase64url: Buffer.alloc(32, 0x71).toString("base64url"),
    nowSeconds: NOW_SECONDS,
  });
  let issued = 0;
  return () => {
    issued += 1;
    const prepared = issuer.prepareRelayV2AccessTokenIssuance(keyring, {
      role: "host",
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      grantId: GRANT_ID,
      nowSeconds: NOW_SECONDS + issued,
      jti: `host-access-jti-${issued}`,
    });
    keyring = prepared.nextKeyring;
    return {
      token: prepared.token,
      jti: prepared.claims.jti,
      expiresAtMs: prepared.claims.exp * 1_000,
    };
  };
}

class FakeTransport {
  bufferedBytes = 0;
  attempts = 0;
  sent = [];
  closes = [];
  onTrySend = undefined;

  trySend(frame, deliveryToken) {
    this.attempts += 1;
    this.sent.push(Uint8Array.from(frame));
    this.bufferedBytes += frame.byteLength;
    this.onTrySend?.(deliveryToken, Uint8Array.from(frame));
    return true;
  }

  bufferedAmount() {
    return this.bufferedBytes;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

class FakeRefreshHttps {
  calls = [];
  mode = "ok";
  failNextCalls = 0;
  hung = null;
  onRespond = null;
  refreshTokenSeq = 1;

  constructor(issueAccess) {
    this.issueAccess = issueAccess;
  }

  refresh(input, signal) {
    this.calls.push({ input, signal });
    if (this.failNextCalls > 0) {
      this.failNextCalls -= 1;
      throw new Error("exchange unavailable");
    }
    if (this.mode === "hang") {
      return new Promise((resolve) => {
        this.hung = { input, resolve };
      });
    }
    return Promise.resolve().then(() => this.respond(input));
  }

  bootstrap() {
    throw new Error("unexpected bootstrap exchange");
  }

  respond(input) {
    this.onRespond?.(input);
    const access = this.issueAccess();
    this.refreshTokenSeq += 1;
    return {
      refreshAttemptId: input.refreshAttemptId,
      principalId: PRINCIPAL_ID,
      grantId: GRANT_ID,
      hostId: HOST_ID,
      accessToken: access.token,
      accessExpiresAtMs: access.expiresAtMs,
      refreshToken: `twref2.host-refresh-token-${this.refreshTokenSeq}`,
      refreshExpiresAtMs: REFRESH_EXP + this.refreshTokenSeq,
    };
  }

  resolveHung() {
    assert.ok(this.hung, "expected a hung refresh exchange");
    const hung = this.hung;
    this.hung = null;
    hung.resolve(this.respond(hung.input));
  }
}

class ManualScheduler {
  entries = [];

  schedule = (delayMs, callback) => {
    const entry = { delayMs, callback, active: true };
    this.entries.push(entry);
    return () => {
      entry.active = false;
      this.entries = this.entries.filter((candidate) => candidate !== entry);
    };
  };

  fireNext() {
    const entry = this.entries.shift();
    assert.ok(entry?.active, "expected an armed timer");
    entry.callback();
  }

  get size() {
    return this.entries.length;
  }
}

/**
 * Thin test shim mapping the real carrier actor onto the exact managed
 * connector cut contract. Both methods are own function properties that rely
 * on dynamic `this`: they only work when the owner preserves the captured
 * receiver, and they mirror the production handle's revalidation of the exact
 * `{ controllerGeneration, connectorId }` cut before every send.
 */
class ManagedConnectorShim {
  forceAdmissionFalseOnce = false;
  sendCalls = [];

  constructor(parts) {
    this.parts = parts;
    this.inspect = function () {
      const status = this.parts.state.latestStatus;
      assert.ok(status, "expected a carrier status before connector inspection");
      if (status.phase === "registered") {
        return {
          status: "registered_incomplete",
          controllerGeneration: String(status.generation),
          connectorId: status.connectorId,
          acknowledgement: "host.registered",
          negotiatedCapabilityIntersection: [],
        };
      }
      return {
        status: "starting",
        controllerGeneration: String(status.generation),
        connectorId: null,
      };
    };
    this.requestReauthentication = function (input) {
      if (input === null || typeof input !== "object") return false;
      const requestId = input.requestId;
      const controllerGeneration = input.controllerGeneration;
      const connectorId = input.connectorId;
      if (typeof requestId !== "string"
        || typeof controllerGeneration !== "string"
        || typeof connectorId !== "string") return false;
      const status = this.parts.state.latestStatus;
      if (status?.phase !== "registered"
        || String(status.generation) !== controllerGeneration
        || status.connectorId !== connectorId) return false;
      const forced = this.forceAdmissionFalseOnce;
      this.forceAdmissionFalseOnce = false;
      this.sendCalls.push({ requestId, controllerGeneration, connectorId });
      return Reflect.apply(this.parts.actor.requestReauthentication, this.parts.actor, [
        requestId,
        CREDENTIAL_REFERENCE,
        () => {
          const current = this.parts.state.latestStatus;
          return !forced
            && current?.phase === "registered"
            && String(current.generation) === controllerGeneration
            && current.connectorId === connectorId;
        },
      ]);
    };
  }
}

function createParts() {
  const storage = new InMemoryDurableCredentialStorage();
  const secrets = new VaultSyncedSecretResolver(storage);
  const authority = new RelayV2HostCredentialAuthority({ storage, secretResolver: secrets });
  const issueAccess = tokenIssuer();
  const https = new FakeRefreshHttps(issueAccess);
  const coordinator = new RelayV2HostCredentialExchangeCoordinator({
    authority,
    httpsAdapter: https,
  });
  const scheduler = new ManualScheduler();
  const statuses = [];
  const warningOutcomes = [];
  const state = { latestStatus: null };
  let warningHandler = null;
  let nextActorId = 0;
  let nextOwnerId = 0;
  const actor = new RelayV2HostCarrierActor({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReferences: authority,
    routeSink: {
      onRouteBound() {},
      onClientFrame() {},
      onRouteUnbound() {},
    },
    advertisedCapabilities: [],
    clock: () => 1_783_700_100_000,
    idFactory: () => `actor-hello-${++nextActorId}`,
    onStatus: (status) => {
      statuses.push(status);
      state.latestStatus = status;
    },
    onAuthExpiring: (input) => {
      warningHandler?.(input);
    },
  });
  const parts = {
    storage,
    secrets,
    authority,
    issueAccess,
    https,
    coordinator,
    scheduler,
    actor,
    statuses,
    warningOutcomes,
    state,
    setWarningHandler(handler) {
      warningHandler = handler;
    },
  };
  parts.shim = new ManagedConnectorShim(parts);
  parts.validOwnerOptions = () => ({
    hostId: HOST_ID,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReference: CREDENTIAL_REFERENCE,
    refreshSecretReference: REFRESH_SECRET_REFERENCE,
    credentialAuthority: authority,
    credentialExchangeCoordinator: coordinator,
    managedConnector: parts.shim,
    idFactory: () => `owner-id-${++nextOwnerId}`,
    schedule: scheduler.schedule,
  });
  return parts;
}

function createHarness() {
  const parts = createParts();
  const owner = new RelayV2HostReauthenticationLifecycleOwner(parts.validOwnerOptions());
  parts.owner = owner;
  parts.setWarningHandler((input) => parts.warningOutcomes.push(owner.handleAuthExpiring(input)));
  return parts;
}

function installBootstrap(parts) {
  const prepared = parts.authority.prepareBootstrap({
    credentialReference: CREDENTIAL_REFERENCE,
    hostId: HOST_ID,
    attemptId: "host-bootstrap-attempt-1",
    oldSecretReference: BOOTSTRAP_SECRET_REFERENCE,
  });
  const access = parts.issueAccess();
  const committed = parts.authority.applyBootstrapResponse(prepared.fence, {
    bootstrapAttemptId: "host-bootstrap-attempt-1",
    principalId: PRINCIPAL_ID,
    grantId: GRANT_ID,
    hostId: HOST_ID,
    accessToken: access.token,
    accessExpiresAtMs: access.expiresAtMs,
    refreshToken: "twref2.host-refresh-token-1",
    refreshExpiresAtMs: REFRESH_EXP,
  });
  assert.equal(committed.status, "applied");
  assert.equal(committed.credentialVersion, "1");
  return access;
}

function connectRegistered(parts, options = {}) {
  const transport = new FakeTransport();
  const connection = parts.actor.connect(transport, CREDENTIAL_REFERENCE);
  const hello = decoded(transport.sent).at(-1);
  assert.equal(hello.type, "host.hello");
  const connectorId = options.connectorId ?? "connector-uuid";
  connection.receive(wire({
    carrierVersion: 1,
    type: "host.registered",
    requestId: hello.requestId,
    connectorId,
    payload: {
      brokerEpoch: "broker-process-uuid",
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
  return { connection, transport, hello, connectorId };
}

function warn(parts, connection, connectorId, expiresAtMs) {
  const before = parts.warningOutcomes.length;
  connection.receive(wire({
    carrierVersion: 1,
    type: "host.auth_expiring",
    connectorId,
    payload: {
      grantId: GRANT_ID,
      expiresAtMs,
      refreshRecommendedAtMs: expiresAtMs - 60_000,
    },
  }));
  assert.equal(parts.warningOutcomes.length, before + 1, "the carrier forwarded the warning");
  return parts.warningOutcomes.at(-1);
}

function reauthenticatedFrame(connectorId, requestId, accessJti, expiresAtMs) {
  return {
    carrierVersion: 1,
    type: "host.reauthenticated",
    requestId,
    connectorId,
    payload: {
      grantId: GRANT_ID,
      jti: accessJti,
      expiresAtMs,
      deduplicated: false,
    },
  };
}

test("a durable recovered attempt is reused across bounded retries and persists before send", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  // A previous crash left this durable refresh attempt behind; the lifecycle
  // must reuse it instead of minting a replacement.
  h.authority.prepareRefresh({
    credentialReference: CREDENTIAL_REFERENCE,
    attemptId: "recovered-attempt",
    oldSecretReference: REFRESH_SECRET_REFERENCE,
  });
  h.https.failNextCalls = 1;
  const { connection, transport, connectorId } = connectRegistered(h);
  const sendObservations = [];
  transport.onTrySend = (_deliveryToken, bytes) => {
    const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
    if (frame.type !== "host.reauthenticate") return;
    const durable = h.storage.snapshot(CREDENTIAL_REFERENCE);
    sendObservations.push({
      requestId: frame.requestId,
      durableVersion: durable.credentialVersion,
      durablePendingRequestId: durable.pendingReauthentication?.requestId ?? null,
    });
  };

  const warning = warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  await tick();
  assert.equal(h.https.calls.length, 1);
  assert.equal(h.https.calls[0].input.refreshAttemptId, "recovered-attempt");
  assert.equal(reauthenticateFrames(transport).length, 0, "never send before the durable commit");
  assert.equal(h.scheduler.size, 1, "the failed exchange armed the bounded retry");

  h.scheduler.fireNext();
  const outcome = await warning;
  assert.deepEqual(outcome, { status: "requested" });
  assert.equal(h.https.calls.length, 2, "exactly one retry, driven by the timer");
  assert.equal(h.https.calls[1].input.refreshAttemptId, "recovered-attempt");
  // Persist-before-send: when the frame hit the transport, the durable
  // credential had already advanced and carried the exact pending identity.
  assert.equal(sendObservations.length, 1);
  assert.equal(sendObservations[0].durableVersion, "2", "the refresh CAS landed first");
  assert.equal(
    sendObservations[0].durablePendingRequestId,
    sendObservations[0].requestId,
    "the sent request is the persisted pending request",
  );
  assert.equal(h.storage.snapshot(CREDENTIAL_REFERENCE).credentialVersion, "2");
  assert.equal(
    h.authority.inspect(CREDENTIAL_REFERENCE).pendingReauthentication.requestId,
    sendObservations[0].requestId,
  );
  assert.equal(h.scheduler.size, 1, "the bounded ACK-loss replay chain is armed");
});

test("concurrent warnings share one bounded in-flight exchange", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  const { connection, transport, connectorId } = connectRegistered(h);
  h.https.mode = "hang";
  const first = warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  const second = warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  const third = warn(h, connection, connectorId, bootstrapAccess.expiresAtMs - 1);
  assert.strictEqual(second, first, "warnings coalesce onto the same outcome promise");
  assert.strictEqual(third, first);
  await tick();
  assert.equal(h.https.calls.length, 1, "exactly one exchange in flight");

  h.https.mode = "ok";
  h.https.resolveHung();
  const outcomes = await Promise.all([first, second, third]);
  assert.deepEqual(outcomes, [
    { status: "requested" },
    { status: "requested" },
    { status: "requested" },
  ]);
  assert.equal(h.https.calls.length, 1, "no parallel exchange was queued");
  assert.equal(reauthenticateFrames(transport).length, 1);
});

test("ACK loss replays only the exact persisted request identity and a landed ACK stops the chain", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  const { connection, transport, connectorId } = connectRegistered(h);
  const outcome = await warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  assert.deepEqual(outcome, { status: "requested" });
  const initial = reauthenticateFrames(transport);
  assert.equal(initial.length, 1);
  const pending = h.authority.inspect(CREDENTIAL_REFERENCE).pendingReauthentication;
  assert.equal(pending.requestId, initial[0].requestId);

  h.scheduler.fireNext();
  h.scheduler.fireNext();
  const replayed = reauthenticateFrames(transport);
  assert.equal(replayed.length, 3);
  assert.equal(replayed[1].requestId, initial[0].requestId, "replay reuses the persisted identity");
  assert.equal(replayed[2].requestId, initial[0].requestId);
  assert.equal(replayed[1].payload.accessToken, initial[0].payload.accessToken);
  assert.equal(replayed[2].payload.accessToken, initial[0].payload.accessToken);
  assert.equal(h.https.calls.length, 1, "ACK replay never refreshes and never mints");

  const currentExp = h.authority.inspect(CREDENTIAL_REFERENCE).accessExpiresAtMs;
  connection.receive(wire(
    reauthenticatedFrame(connectorId, initial[0].requestId, pending.accessJti, currentExp),
  ));
  assert.equal(
    h.authority.inspect(CREDENTIAL_REFERENCE).pendingReauthentication,
    null,
    "the exact ACK cleared the durable pending",
  );
  h.scheduler.fireNext();
  assert.equal(reauthenticateFrames(transport).length, 3, "no resend after the ACK landed");
  assert.equal(h.scheduler.size, 0, "the replay chain stopped");
});

test("a carrier refusal after the durable persist recovers through the exact pending resend", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  const { connection, transport, connectorId } = connectRegistered(h);
  h.shim.forceAdmissionFalseOnce = true;
  const warning = warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  await tick();
  assert.equal(reauthenticateFrames(transport).length, 0, "the refused admission enqueued nothing");
  const persisted = h.authority.inspect(CREDENTIAL_REFERENCE).pendingReauthentication;
  assert.ok(persisted !== null, "the carrier persisted the exact pending before refusing");
  assert.equal(h.storage.snapshot(CREDENTIAL_REFERENCE).credentialVersion, "2");
  assert.equal(h.scheduler.size, 1, "false after persist armed the bounded retry, not a second warning");

  h.scheduler.fireNext();
  const outcome = await warning;
  assert.deepEqual(outcome, { status: "resent" });
  assert.equal(h.https.calls.length, 1, "recovery reuses the persisted attempt and token");
  const frames = reauthenticateFrames(transport);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].requestId, persisted.requestId, "resend is the exact persisted request");
});

test("a stale refresh commit adopts the authority-proven winner", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  const { connection, transport, connectorId } = connectRegistered(h);
  const winnerAccess = h.issueAccess();
  h.https.onRespond = (input) => {
    h.https.onRespond = null;
    // A competing exchange for the same durable attempt commits first inside
    // the authority, so the coordinator's own apply comes back stale.
    const competing = h.authority.prepareRefresh({
      credentialReference: CREDENTIAL_REFERENCE,
      attemptId: input.refreshAttemptId,
      oldSecretReference: REFRESH_SECRET_REFERENCE,
    });
    assert.equal(
      competing.fence.attemptId,
      input.refreshAttemptId,
      "the competing exchange coalesced onto the same durable attempt",
    );
    const committed = h.authority.applyRefreshResponse(competing.fence, {
      refreshAttemptId: input.refreshAttemptId,
      principalId: PRINCIPAL_ID,
      grantId: GRANT_ID,
      hostId: HOST_ID,
      accessToken: winnerAccess.token,
      accessExpiresAtMs: winnerAccess.expiresAtMs,
      refreshToken: "twref2.host-refresh-token-winner",
      refreshExpiresAtMs: REFRESH_EXP + 9,
    });
    assert.equal(committed.status, "applied");
  };

  const outcome = await warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  assert.deepEqual(outcome, { status: "requested" });
  assert.equal(h.https.calls.length, 1, "the stale commit never drove a second exchange");
  const frames = reauthenticateFrames(transport);
  assert.equal(frames.length, 1);
  assert.equal(
    frames[0].payload.accessToken,
    winnerAccess.token,
    "the carrier sends the authority-proven winner token",
  );
  assert.equal(h.storage.snapshot(CREDENTIAL_REFERENCE).accessJti, winnerAccess.jti);

  // Not sealed: the owner keeps serving later warnings from durable state.
  connection.receive(wire(
    reauthenticatedFrame(connectorId, frames[0].requestId, winnerAccess.jti, winnerAccess.expiresAtMs),
  ));
  const followup = await h.owner.handleAuthExpiring(signalFor(winnerAccess.expiresAtMs - 1));
  assert.deepEqual(followup, { status: "already_current" });
});

test("a replaced connector generation fences the late refresh completion", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  const first = connectRegistered(h, { connectorId: "connector-one" });
  h.https.mode = "hang";
  const warning = warn(h, first.connection, first.connectorId, bootstrapAccess.expiresAtMs);
  await tick();
  assert.equal(h.https.calls.length, 1);

  // The carrier generation is replaced while the exchange hangs.
  first.connection.closed(1006);
  const second = connectRegistered(h, { connectorId: "connector-two" });
  h.https.mode = "ok";
  h.https.resolveHung();
  const outcome = await warning;
  assert.deepEqual(outcome, { status: "carrier_unavailable" });
  assert.equal(
    reauthenticateFrames(second.transport).length,
    0,
    "the new generation never sees the late request",
  );

  // The owner is not sealed: a fresh warning starts a new job bound to the
  // replacement generation.
  const currentExp = h.authority.inspect(CREDENTIAL_REFERENCE).accessExpiresAtMs;
  const followup = warn(h, second.connection, second.connectorId, currentExp);
  assert.deepEqual(await followup, { status: "requested" });
  assert.equal(reauthenticateFrames(second.transport).length, 1);
  assert.equal(h.https.calls.length, 2);
});

test("close aborts the exchange, settles within the deadline, and fences the late completion", async () => {
  const h = createHarness();
  const bootstrapAccess = installBootstrap(h);
  const { connection, transport, connectorId } = connectRegistered(h);
  h.https.mode = "hang";
  const warning = warn(h, connection, connectorId, bootstrapAccess.expiresAtMs);
  await tick();
  assert.equal(h.https.calls.length, 1);

  const closing = h.owner.close();
  assert.strictEqual(h.owner.close(), closing, "close is one-shot");
  assert.equal(
    h.https.calls[0].signal.aborted,
    true,
    "close aborts the canonical exchange signal",
  );
  assert.equal(h.scheduler.size, 1, "the bounded close deadline is armed");
  // The injected port ignores the abort and keeps hanging: the deadline only
  // fences and settles the close barrier.
  h.scheduler.fireNext();
  await closing;

  h.https.resolveHung();
  assert.deepEqual(await warning, { status: "closed" });
  assert.equal(
    reauthenticateFrames(transport).length,
    0,
    "the late completion never reaches the carrier",
  );
  assert.deepEqual(
    await h.owner.handleAuthExpiring(signalFor(bootstrapAccess.expiresAtMs)),
    { status: "closed" },
  );
  assert.equal(h.scheduler.size, 0);
});

test("foreign inputs are rejected without side effects and method receivers stay bound", async (t) => {
  const rejectionCases = [
    {
      name: "Proxy options",
      mutate: (options) => new Proxy(options, {}),
      error: /options are invalid/,
    },
    {
      name: "accessor option member",
      mutate: (options) => {
        Object.defineProperty(options, "idFactory", {
          get: () => () => "id",
          enumerable: true,
          configurable: true,
        });
        return options;
      },
      error: /options are invalid/,
    },
    {
      name: "unbranded credential authority",
      mutate: (options) => ({ ...options, credentialAuthority: {} }),
      error: /options are invalid/,
    },
    {
      name: "coordinator paired with another authority",
      mutate: (options, parts) => {
        const foreignStorage = new InMemoryDurableCredentialStorage();
        const foreignAuthority = new RelayV2HostCredentialAuthority({
          storage: foreignStorage,
          secretResolver: new VaultSyncedSecretResolver(foreignStorage),
        });
        return {
          ...options,
          credentialExchangeCoordinator: new RelayV2HostCredentialExchangeCoordinator({
            authority: foreignAuthority,
            httpsAdapter: parts.https,
          }),
        };
      },
      error: /options are invalid/,
    },
    {
      name: "credential reference outside the authority namespace",
      mutate: (options) => ({ ...options, credentialReference: "credential-1" }),
      error: /options are invalid/,
    },
    {
      name: "Proxy managed connector",
      mutate: (options, parts) => ({
        ...options,
        managedConnector: new Proxy(parts.shim, {}),
      }),
      error: /ports are invalid/,
    },
    {
      name: "managed connector without the cut methods",
      mutate: (options) => ({ ...options, managedConnector: {} }),
      error: /ports are invalid/,
    },
  ];
  for (const scenario of rejectionCases) {
    await t.test(`constructor rejects ${scenario.name}`, () => {
      const parts = createParts();
      const options = scenario.mutate(parts.validOwnerOptions(), parts);
      assert.throws(
        () => new RelayV2HostReauthenticationLifecycleOwner(options),
        scenario.error,
      );
      assert.equal(parts.storage.operations, 0, "construction touched no authority state");
      assert.equal(parts.scheduler.size, 0, "construction armed no timer");
    });
  }

  await t.test("valid options construct an inert owner and preserve method receivers", async () => {
    const parts = createParts();
    const owner = new RelayV2HostReauthenticationLifecycleOwner(parts.validOwnerOptions());
    assert.equal(parts.storage.operations, 0, "construction touched no authority state");
    const bootstrapAccess = installBootstrap(parts);
    const operationsAfterBootstrap = parts.storage.operations;
    await tick();
    assert.equal(parts.storage.operations, operationsAfterBootstrap, "an idle owner stays inert");
    const { connectorId } = connectRegistered(parts);
    // The shim methods read `this.parts`/`this.sendCalls`: a dropped receiver
    // would throw inside the send path and seal the owner instead.
    const outcome = await owner.handleAuthExpiring(signalFor(bootstrapAccess.expiresAtMs));
    assert.deepEqual(outcome, { status: "requested" });
    assert.equal(parts.shim.sendCalls.length, 1, "the this-dependent shim method ran bound");
  });

  await t.test("Proxy and malformed signals seal fail-closed without port activity", async () => {
    const h = createHarness();
    installBootstrap(h);
    const validSignal = signalFor(1_783_703_600_000);
    const operationsBefore = h.storage.operations;
    const malformed = [
      new Proxy(validSignal, {}),
      { grantId: GRANT_ID },
      null,
      { ...validSignal, extra: 1 },
    ];
    for (const input of malformed) {
      assert.deepEqual(await h.owner.handleAuthExpiring(input), {
        status: "failed",
        code: "signal_invalid",
      });
    }
    assert.equal(h.storage.operations, operationsBefore, "malformed signals never reach the authority");
    assert.equal(h.https.calls.length, 0);
    assert.deepEqual(
      await h.owner.handleAuthExpiring(validSignal),
      { status: "failed", code: "signal_invalid" },
      "the seal is sticky",
    );
    assert.equal(h.storage.operations, operationsBefore, "a sealed owner never re-enters the ports");
  });

  await t.test("undecodable durable state seals fail-closed without further port activity", async () => {
    const h = createHarness();
    installBootstrap(h);
    connectRegistered(h);
    const validSignal = signalFor(1_783_703_600_000);
    h.storage.replace(CREDENTIAL_REFERENCE, { credentialVersion: "not-a-counter" });
    assert.deepEqual(await h.owner.handleAuthExpiring(validSignal), {
      status: "failed",
      code: "authority_state_invalid",
    });
    const operationsBefore = h.storage.operations;
    assert.deepEqual(await h.owner.handleAuthExpiring(validSignal), {
      status: "failed",
      code: "authority_state_invalid",
    });
    assert.equal(h.storage.operations, operationsBefore, "a sealed owner never re-enters the authority");
    assert.equal(h.https.calls.length, 0);
  });
});
