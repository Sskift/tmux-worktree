import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { InMemoryRelayV2BrokerCredentialStateStore } from "./support/inMemoryRelayV2BrokerCredentialStateStore.mjs";

const credential = await import("../dist/relay/v2/brokerCredentialAuthority.js");
const issuer = await import("../dist/relay/v2/issuer.js");
const continuity = await import("../dist/relay/v2/continuityAnchor.js");

const ANCHOR_ID = "credential-authority-test";
const VERSION = continuity.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION;
const NOW_MS = 1_800_000_000_000;
const TEST_SECRET = Buffer.alloc(32, 7).toString("base64url");

function clone(value) {
  return structuredClone(value);
}

class MemoryContinuityAuthority {
  constructor() {
    this.token = 0;
    this.current = {
      protocolVersion: VERSION,
      status: "uninitialized",
      anchorId: ANCHOR_ID,
      casToken: "cas-0",
    };
    this.readCalls = 0;
    this.casCalls = 0;
    this.onRead = null;
    this.onCas = null;
  }

  async read(request) {
    assert.equal(request.protocolVersion, VERSION);
    assert.equal(request.anchorId, ANCHOR_ID);
    assert.equal(request.signal instanceof AbortSignal, true);
    this.readCalls += 1;
    return this.onRead ? await this.onRead(request, this) : clone(this.current);
  }

  async compareAndSwap(request) {
    assert.equal(request.protocolVersion, VERSION);
    assert.equal(request.anchorId, ANCHOR_ID);
    assert.equal(request.signal instanceof AbortSignal, true);
    this.casCalls += 1;
    return this.onCas ? await this.onCas(request, this) : this.defaultCas(request);
  }

  defaultCas(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return { protocolVersion: VERSION, outcome: "conflict", current: clone(this.current) };
    }
    this.token += 1;
    this.current = {
      protocolVersion: VERSION,
      status: "committed",
      anchorId: ANCHOR_ID,
      casToken: `cas-${this.token}`,
      checkpoint: clone(request.next),
    };
    return { protocolVersion: VERSION, outcome: "swapped", current: clone(this.current) };
  }
}

function keyring() {
  return issuer.createRelayV2IssuerKeyring({
    issuerId: "credential-test-issuer",
    kid: "credential-test-kid",
    secretBase64url: TEST_SECRET,
    nowSeconds: Math.floor(NOW_MS / 1_000),
  });
}

function authorityOptions(store, external, overrides = {}) {
  const { idPrefix = "default", ...optionOverrides } = overrides;
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
      issuerKeyring: keyring(),
      issuerUrl: "https://relay.example.com/",
      relayUrl: "wss://relay.example.com/client",
    },
    now: () => NOW_MS,
    randomId: () => `authority-id-${idPrefix}-${++id}`,
    randomBytes: (length) => {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) output[index] = (byte + index + 1) % 256;
      byte = (byte + length) % 256;
      return output;
    },
    ...optionOverrides,
  };
}

function errorCode(code) {
  return (error) => error instanceof credential.RelayV2BrokerCredentialAuthorityError
    && error.code === code;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function hostContext(overrides = {}) {
  return {
    scheme: "twcap2",
    role: "host",
    hostId: "host-one",
    principalId: "principal-one",
    grantId: "grant-one",
    clientInstanceId: null,
    jti: "jti-one",
    kid: "credential-test-kid",
    expiresAtMs: NOW_MS + 60_000,
    ...overrides,
  };
}

function decodeState(bytes) {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function encodeState(state) {
  return Buffer.from(JSON.stringify(state), "utf8");
}

function checkpointForStateBytes(bytes) {
  const state = decodeState(bytes);
  return {
    protocolVersion: VERSION,
    anchorId: ANCHOR_ID,
    sequence: state.commitSequence,
    commitId: state.commitId,
    parentCommitId: state.parentCommitId,
    stateDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function continuityAtStateBytes(bytes) {
  const external = new MemoryContinuityAuthority();
  external.current = {
    protocolVersion: VERSION,
    status: "committed",
    anchorId: ANCHOR_ID,
    casToken: "cas-seeded",
    checkpoint: checkpointForStateBytes(bytes),
  };
  return external;
}

function hostBootstrapInput(bootstrapToken, overrides = {}) {
  return {
    bootstrapAttemptId: "host-bootstrap-attempt-one",
    bootstrapToken,
    hostId: "host-one",
    hostEpoch: "host-epoch-one",
    hostInstanceId: "host-instance-one",
    ...overrides,
  };
}

async function admitHostBootstrap(authority, sourceKey) {
  return authority.admitHttpSource({ endpoint: "host_bootstrap", sourceKey });
}

test("missing genesis publishes opaque bytes, anchors their exact digest, and reopens explicitly", async () => {
  const external = new MemoryContinuityAuthority();
  const firstStore = new InMemoryRelayV2BrokerCredentialStateStore();
  const first = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(firstStore, external, { idPrefix: "first" }),
  );
  const bytes = firstStore.snapshotBytes();
  assert.equal(bytes instanceof Uint8Array, true);
  assert.equal(firstStore.compareAndPublishCalls, 1);
  assert.equal(first.authorityContinuityReadiness.status, "ready");
  assert.equal(
    external.current.checkpoint.stateDigest,
    createHash("sha256").update(bytes).digest("hex"),
  );
  await first.close();
  assert.equal(first.authorityContinuityReadiness.status, "closed");

  const reopenedStore = new InMemoryRelayV2BrokerCredentialStateStore({ initialBytes: bytes });
  const reopened = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(reopenedStore, external, { idPrefix: "reopened" }),
  );
  assert.equal(reopenedStore.compareAndPublishCalls, 0);
  assert.equal(reopened.authorityContinuityReadiness.status, "ready");
  await reopened.close();
});

test("malformed current bytes and a different concurrent genesis fail closed without overwrite", async (t) => {
  await t.test("malformed definitive current", async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x01]);
    const store = new InMemoryRelayV2BrokerCredentialStateStore({ initialBytes: bytes });
    await assert.rejects(
      credential.RelayV2BrokerCredentialAuthority.open(
        authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "malformed" }),
      ),
      errorCode("STATE_INVALID"),
    );
    assert.deepEqual(store.snapshotBytes(), bytes);
    assert.equal(store.closeCalls, 1);
    assert.equal(store.closed, true);
  });

  await t.test("genesis conflict", async () => {
    const store = new InMemoryRelayV2BrokerCredentialStateStore();
    store.onCompareAndPublish = ({ defaultPublish }) => {
      store.replaceBytesForTest(Uint8Array.from([1, 2, 3]));
      return defaultPublish();
    };
    await assert.rejects(
      credential.RelayV2BrokerCredentialAuthority.open(
        authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "conflict" }),
      ),
      errorCode("STATE_CONFLICT"),
    );
    assert.deepEqual(store.snapshotBytes(), Uint8Array.from([1, 2, 3]));
    assert.equal(store.compareAndPublishCalls, 1);
    assert.equal(store.closeCalls, 1);
  });
});

test("N0 already_same converges before an injected revision conflict", async () => {
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  store.onCompareAndPublish = ({ next, defaultPublish }) => {
    store.replaceBytesForTest(next);
    return defaultPublish();
  };
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "same" }),
  );
  assert.equal(authority.authorityContinuityReadiness.status, "ready");
  assert.equal(store.compareAndPublishCalls, 1);
  await authority.close();
});

test("open owns a recognizable store across constructor and initialization failures", async (t) => {
  const cases = [
    {
      name: "invalid genesis",
      expected: "INVALID_ARGUMENT",
      change: { genesis: { issuerKeyring: {}, issuerUrl: "bad", relayUrl: "bad" } },
    },
    {
      name: "invalid continuity",
      expected: "INVALID_ARGUMENT",
      change: { continuityAnchor: { anchorId: ANCHOR_ID, authority: {} } },
    },
    {
      name: "invalid random seam result",
      expected: "STATE_INVALID",
      change: { randomBytes: () => new Uint8Array(1) },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const store = new InMemoryRelayV2BrokerCredentialStateStore();
      await assert.rejects(
        credential.RelayV2BrokerCredentialAuthority.open({
          ...authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: item.name }),
          ...item.change,
        }),
        errorCode(item.expected),
      );
      assert.equal(store.closeCalls, 1);
      assert.equal(store.closed, true);
    });
  }

  await t.test("constructor close barrier failure remains unclosed", async () => {
    const store = new InMemoryRelayV2BrokerCredentialStateStore({
      onClose: async () => { throw new Error("injected close failure"); },
    });
    await assert.rejects(
      credential.RelayV2BrokerCredentialAuthority.open({
        ...authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "close-fail" }),
        genesis: { issuerKeyring: {}, issuerUrl: "bad", relayUrl: "bad" },
      }),
      (error) => errorCode("CLOSE_BARRIER_FAILED")(error)
        && error.withdrawalReason === "INVALID_ARGUMENT",
    );
    assert.equal(store.closeCalls, 1);
    assert.equal(store.closed, false);
  });
});

test("external continuity failures are distinct and always close the transferred store", async (t) => {
  await t.test("read unavailable", async () => {
    const external = new MemoryContinuityAuthority();
    external.onRead = async () => { throw new Error("injected read outage"); };
    const store = new InMemoryRelayV2BrokerCredentialStateStore();
    await assert.rejects(
      credential.RelayV2BrokerCredentialAuthority.open(
        authorityOptions(store, external, { idPrefix: "read-outage" }),
      ),
      errorCode("EXTERNAL_CONTINUITY_UNAVAILABLE"),
    );
    assert.equal(store.closeCalls, 1);
  });

  await t.test("anchor publication uncertain", async () => {
    const external = new MemoryContinuityAuthority();
    external.onCas = async () => { throw new Error("injected anchor outage"); };
    const store = new InMemoryRelayV2BrokerCredentialStateStore();
    await assert.rejects(
      credential.RelayV2BrokerCredentialAuthority.open(
        authorityOptions(store, external, { idPrefix: "anchor-outage" }),
      ),
      errorCode("EXTERNAL_ANCHOR_UNCERTAIN"),
    );
    assert.equal(store.closeCalls, 1);
    assert.equal(store.snapshotBytes() instanceof Uint8Array, true);
  });

  await t.test("anchor CAS conflict", async () => {
    const external = new MemoryContinuityAuthority();
    external.onCas = async (_request, state) => ({
      protocolVersion: VERSION,
      outcome: "conflict",
      current: { ...clone(state.current), casToken: "cas-other" },
    });
    const store = new InMemoryRelayV2BrokerCredentialStateStore();
    await assert.rejects(
      credential.RelayV2BrokerCredentialAuthority.open(
        authorityOptions(store, external, { idPrefix: "anchor-conflict" }),
      ),
      errorCode("EXTERNAL_ANCHOR_CONFLICT"),
    );
    assert.equal(store.closeCalls, 1);
  });
});

test("unknown post-publication failure withdraws admission, closes, and recovers only in a new instance", async () => {
  const external = new MemoryContinuityAuthority();
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, external, { idPrefix: "uncertain-first" }),
  );
  store.onCompareAndPublish = ({ defaultPublish }) => {
    defaultPublish();
    throw new Error("injected post-publication failure");
  };
  await assert.rejects(
    authority.adminRotateIssuerKey({ kid: "rotated-kid", secretBase64url: Buffer.alloc(32, 9).toString("base64url") }),
    errorCode("STORE_PUBLICATION_UNCERTAIN"),
  );
  assert.equal(store.compareAndPublishCalls, 2);
  assert.equal(store.closeCalls, 1);
  assert.equal(authority.authorityContinuityReadiness.status, "closed");
  const callsAfterClose = store.runExclusiveCalls;
  const unavailable = await authority.handle({
    type: "grant.revoke",
    requestId: "request-after-withdraw",
    connectorId: "connector-after-withdraw",
    payload: { grantId: "grant-one", reason: "user_revoked" },
    currentAuthContext: hostContext(),
  });
  assert.equal(unavailable.outcome, "reject");
  assert.equal(unavailable.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(store.runExclusiveCalls, callsAfterClose);

  const recoveredStore = new InMemoryRelayV2BrokerCredentialStateStore({
    initialBytes: store.snapshotBytes(),
  });
  const recovered = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(recoveredStore, external, { idPrefix: "uncertain-recovered" }),
  );
  assert.equal(recovered.authorityContinuityReadiness.status, "ready");
  await recovered.close();
});

test("fatal publication withdraws queued callbacks before the N0 lease is released", async () => {
  const external = new MemoryContinuityAuthority();
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, external, { idPrefix: "queued-fatal" }),
  );
  const enteredAnchor = deferred();
  const releaseAnchor = deferred();
  external.onCas = async () => {
    enteredAnchor.resolve();
    await releaseAnchor.promise;
    throw new Error("injected queued anchor outage");
  };

  const active = authority.adminRotateIssuerKey({
    kid: "queued-fatal-kid",
    secretBase64url: Buffer.alloc(32, 11).toString("base64url"),
  });
  await enteredAnchor.promise;
  const readsBeforeQueuedCallback = store.readCalls;
  const queued = authority.authorizeAccessToken("twcap2.not-a-valid-token", "host");
  const activeRejected = assert.rejects(active, errorCode("EXTERNAL_ANCHOR_UNCERTAIN"));
  const queuedRejected = assert.rejects(
    queued,
    (error) => errorCode("AUTHORITY_NOT_READY")(error)
      || errorCode("AUTHORITY_CLOSED")(error),
  );

  releaseAnchor.resolve();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(store.readCalls, readsBeforeQueuedCallback);
  assert.equal(store.closeCalls, 1);
  assert.equal(store.closed, true);
  assert.equal(authority.authorityContinuityReadiness.status, "closed");
});

test("proven pre-publication capacity leaves prior bytes and authority readiness intact", async () => {
  const external = new MemoryContinuityAuthority();
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const options = authorityOptions(store, external, { idPrefix: "capacity" });
  options.randomId = () => "same-commit-id";
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(options);
  const beforeBytes = store.snapshotBytes();
  const beforeCompares = store.compareAndPublishCalls;
  const beforeAnchorCas = external.casCalls;

  await assert.rejects(
    authority.adminRotateIssuerKey({
      kid: "capacity-rotation-kid",
      secretBase64url: Buffer.alloc(32, 10).toString("base64url"),
    }),
    errorCode("STATE_CAPACITY_EXHAUSTED"),
  );
  assert.deepEqual(store.snapshotBytes(), beforeBytes);
  assert.equal(store.compareAndPublishCalls, beforeCompares);
  assert.equal(external.casCalls, beforeAnchorCas);
  assert.equal(store.closeCalls, 0);
  assert.equal(authority.authorityContinuityReadiness.status, "ready");
  await authority.close();
});

test("close is a synchronous admission withdrawal and a truthful barrier", async (t) => {
  await t.test("pending barrier", async () => {
    let finishClose;
    const closeGate = new Promise((resolve) => { finishClose = resolve; });
    const store = new InMemoryRelayV2BrokerCredentialStateStore({ onClose: () => closeGate });
    const authority = await credential.RelayV2BrokerCredentialAuthority.open(
      authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "barrier" }),
    );
    const closing = authority.close();
    assert.deepEqual(authority.authorityContinuityReadiness, {
      status: "withdrawn",
      reason: "close_requested",
    });
    const calls = store.runExclusiveCalls;
    const decision = await authority.handle({
      type: "enrollment.create",
      requestId: "request-closed",
      connectorId: "connector-closed",
      payload: { expiresInMs: 300_000, deviceLabel: null },
      currentAuthContext: hostContext(),
    });
    assert.equal(decision.outcome, "reject");
    assert.equal(decision.error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(store.runExclusiveCalls, calls);
    finishClose();
    await closing;
    assert.equal(authority.authorityContinuityReadiness.status, "closed");
  });

  await t.test("failed barrier", async () => {
    const store = new InMemoryRelayV2BrokerCredentialStateStore({
      onClose: async () => { throw new Error("injected close failure"); },
    });
    const authority = await credential.RelayV2BrokerCredentialAuthority.open(
      authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "failed-barrier" }),
    );
    await assert.rejects(authority.close(), errorCode("CLOSE_BARRIER_FAILED"));
    assert.equal(authority.authorityContinuityReadiness.status, "withdrawn");
    assert.equal(store.closed, false);
    await assert.rejects(authority.close(), errorCode("CLOSE_BARRIER_FAILED"));
    assert.equal(store.closeCalls, 1);
  });
});

test("pre-body source admission is durable, source-bound, one-use, rate-limited, and capacity-bounded", async () => {
  let now = NOW_MS;
  const external = new MemoryContinuityAuthority();
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open({
    ...authorityOptions(store, external, { idPrefix: "source" }),
    now: () => now,
  });
  const receipts = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    receipts.push(await authority.admitHttpSource({
      endpoint: "enrollment_redeem",
      sourceKey: "source-one",
    }));
  }
  const comparesAfterLimit = store.compareAndPublishCalls;
  await assert.rejects(
    authority.admitHttpSource({ endpoint: "enrollment_redeem", sourceKey: "source-one" }),
    errorCode("RATE_LIMITED"),
  );
  assert.equal(store.compareAndPublishCalls, comparesAfterLimit);
  assert.equal(JSON.stringify(receipts[0]), undefined);
  assert.throws(() => structuredClone(receipts[0]));

  await assert.rejects(
    authority.redeemEnrollment(receipts[0], "different-source", {
      exchangeAttemptId: "exchange-one",
      enrollmentId: "missing-enrollment",
      enrollmentCode: "twenroll2.not-the-code",
      clientInstanceId: "client-one",
      deviceLabel: "device",
    }),
    errorCode("INVALID_ARGUMENT"),
  );
  const beforeUnknownRedeem = store.compareAndPublishCalls;
  await assert.rejects(
    authority.redeemEnrollment(receipts[0], "source-one", {
      exchangeAttemptId: "exchange-one",
      enrollmentId: "missing-enrollment",
      enrollmentCode: "twenroll2.not-the-code",
      clientInstanceId: "client-one",
      deviceLabel: "device",
    }),
    (error) => errorCode("AUTH_INVALID")(error)
      && !error.message.includes("not-the-code"),
  );
  assert.equal(store.compareAndPublishCalls, beforeUnknownRedeem);
  await assert.rejects(
    authority.redeemEnrollment(receipts[0], "source-one", {
      exchangeAttemptId: "exchange-one",
      enrollmentId: "missing-enrollment",
      enrollmentCode: "twenroll2.not-the-code",
      clientInstanceId: "client-one",
      deviceLabel: "device",
    }),
    errorCode("INVALID_ARGUMENT"),
  );

  for (let index = receipts.length - 1; index < 256; index += 1) {
    receipts.push(await authority.admitHttpSource({
      endpoint: "enrollment_redeem",
      sourceKey: `source-${index}`,
    }));
  }
  const beforeCapacity = store.compareAndPublishCalls;
  await assert.rejects(
    authority.admitHttpSource({ endpoint: "enrollment_redeem", sourceKey: "source-over-cap" }),
    errorCode("BUSY"),
  );
  assert.equal(store.compareAndPublishCalls, beforeCapacity);

  now += 60_000;
  await assert.rejects(
    authority.redeemEnrollment(receipts[1], "source-one", {
      exchangeAttemptId: "exchange-expired",
      enrollmentId: "missing-enrollment",
      enrollmentCode: "twenroll2.not-the-code",
      clientInstanceId: "client-one",
      deviceLabel: "device",
    }),
    errorCode("INVALID_ARGUMENT"),
  );
  await authority.close();
});

test("HTTP source admission release is exact, one-use, non-refunding, and closed with the authority", async () => {
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), {
      idPrefix: "source-release",
    }),
  );
  const receipt = await admitHostBootstrap(authority, "released-source");
  assert.throws(
    () => authority.releaseHttpSourceAdmission(
      receipt,
      "enrollment_redeem",
      "released-source",
    ),
    errorCode("INVALID_ARGUMENT"),
  );
  assert.throws(
    () => authority.releaseHttpSourceAdmission(
      receipt,
      "host_bootstrap",
      "different-source",
    ),
    errorCode("INVALID_ARGUMENT"),
  );
  assert.throws(
    () => authority.releaseHttpSourceAdmission(
      Object.freeze(() => undefined),
      "host_bootstrap",
      "released-source",
    ),
    errorCode("INVALID_ARGUMENT"),
  );
  authority.releaseHttpSourceAdmission(
    receipt,
    "host_bootstrap",
    "released-source",
  );
  assert.throws(
    () => authority.releaseHttpSourceAdmission(
      receipt,
      "host_bootstrap",
      "released-source",
    ),
    errorCode("INVALID_ARGUMENT"),
  );
  assert.deepEqual(decodeState(store.snapshotBytes()).rateLimits, [{
    scope: "host.bootstrap.source",
    subjectHash: createHash("sha256").update("released-source").digest("hex"),
    windowStartedAtMs: NOW_MS,
    attempts: 1,
  }]);

  const clearedByClose = await admitHostBootstrap(authority, "close-source");
  await authority.close();
  assert.throws(
    () => authority.releaseHttpSourceAdmission(
      clearedByClose,
      "host_bootstrap",
      "close-source",
    ),
    errorCode("INVALID_ARGUMENT"),
  );
});

test("fresh host bootstrap issues the frozen host credential once and exactly replays ACK loss", async () => {
  const external = new MemoryContinuityAuthority();
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, external, { idPrefix: "host-bootstrap-success" }),
  );
  const created = await authority.adminCreateHostBootstrap();
  assert.equal(created.expiresAtMs, NOW_MS + 300_000);
  const beforeInvalidTtl = store.compareAndPublishCalls;
  await assert.rejects(
    authority.adminCreateHostBootstrap({ expiresInMs: 300_001 }),
    errorCode("INVALID_ARGUMENT"),
  );
  assert.equal(store.compareAndPublishCalls, beforeInvalidTtl);
  const tokenParts = created.bootstrapToken.split(".");
  assert.equal(tokenParts.length, 3);
  assert.equal(tokenParts[0], "twhostboot2");
  assert.equal(Buffer.from(tokenParts[1], "base64url").byteLength, 16);
  assert.equal(Buffer.from(tokenParts[2], "base64url").byteLength, 32);

  const createdStateText = Buffer.from(store.snapshotBytes()).toString("utf8");
  const createdState = JSON.parse(createdStateText);
  assert.equal(createdStateText.includes(created.bootstrapToken), false);
  assert.equal(createdStateText.includes(tokenParts[2]), false);
  assert.deepEqual(Object.keys(createdState.hostBootstraps[0]).sort(), [
    "createdAtMs",
    "expiresAtMs",
    "failedAttempts",
    "selector",
    "terminalAtMs",
    "terminalReason",
    "tokenHash",
  ]);
  assert.equal(createdState.hostBootstraps[0].selector, tokenParts[1]);
  assert.equal(
    createdState.hostBootstraps[0].tokenHash,
    createHash("sha256").update(created.bootstrapToken).digest("hex"),
  );

  const request = hostBootstrapInput(created.bootstrapToken);
  const firstAdmission = await admitHostBootstrap(authority, "bootstrap-source-one");
  const first = await authority.bootstrapHost(
    firstAdmission,
    "bootstrap-source-one",
    request,
  );
  assert.equal(first.endpoint, "host_bootstrap");
  assert.equal(first.replayed, false);
  assert.equal(first.body.bootstrapAttemptId, request.bootstrapAttemptId);
  assert.equal(first.body.hostId, request.hostId);
  assert.equal(first.body.accessExpiresAtMs, NOW_MS + 60 * 60 * 1_000);
  assert.equal(first.body.refreshExpiresAtMs, NOW_MS + 30 * 24 * 60 * 60 * 1_000);

  const replayAdmission = await admitHostBootstrap(authority, "bootstrap-source-one");
  const beforeReplay = store.compareAndPublishCalls;
  const replay = await authority.bootstrapHost(
    replayAdmission,
    "bootstrap-source-one",
    request,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(store.compareAndPublishCalls, beforeReplay);
  const replayStateText = Buffer.from(store.snapshotBytes()).toString("utf8");
  assert.equal(replayStateText.includes(created.bootstrapToken), false);
  assert.equal(replayStateText.includes(tokenParts[2]), false);

  const differentSecret = `twhostboot2.${tokenParts[1]}.${Buffer.alloc(32, 255).toString("base64url")}`;
  const conflictAdmission = await admitHostBootstrap(authority, "bootstrap-source-one");
  await assert.rejects(
    authority.bootstrapHost(
      conflictAdmission,
      "bootstrap-source-one",
      hostBootstrapInput(differentSecret),
    ),
    (error) => errorCode("IDEMPOTENCY_CONFLICT")(error)
      && !error.message.includes(differentSecret),
  );

  const fingerprintConflictAdmission = await admitHostBootstrap(
    authority,
    "bootstrap-source-one",
  );
  await assert.rejects(
    authority.bootstrapHost(
      fingerprintConflictAdmission,
      "bootstrap-source-one",
      hostBootstrapInput(created.bootstrapToken, { hostEpoch: "different-host-epoch" }),
    ),
    errorCode("IDEMPOTENCY_CONFLICT"),
  );

  const reusedAdmission = await admitHostBootstrap(authority, "bootstrap-source-one");
  await assert.rejects(
    authority.bootstrapHost(
      reusedAdmission,
      "bootstrap-source-one",
      hostBootstrapInput(created.bootstrapToken, {
        bootstrapAttemptId: "host-bootstrap-attempt-two",
      }),
    ),
    (error) => errorCode("AUTH_INVALID")(error)
      && !error.message.includes(created.bootstrapToken),
  );
  assert.equal(decodeState(store.snapshotBytes()).grants.length, 1);

  const context = await authority.authorizeAccessToken(first.body.accessToken, "host");
  assert.deepEqual({
    role: context.role,
    hostId: context.hostId,
    principalId: context.principalId,
    grantId: context.grantId,
    clientInstanceId: context.clientInstanceId,
  }, {
    role: "host",
    hostId: request.hostId,
    principalId: first.body.principalId,
    grantId: first.body.grantId,
    clientInstanceId: null,
  });
  const refreshed = await authority.refreshGrant({
    refreshAttemptId: "host-refresh-after-restart",
    grantId: first.body.grantId,
    refreshToken: first.body.refreshToken,
    hostInstanceId: "different-host-process",
  });
  assert.equal(refreshed.endpoint, "host_refresh");
  assert.equal(refreshed.body.grantId, first.body.grantId);
  assert.equal(refreshed.body.principalId, first.body.principalId);
  await authority.close();
});

test("host bootstrap selector attribution counts only known-selector failures and atomically exhausts at five", async () => {
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), {
      idPrefix: "host-bootstrap-failures",
    }),
  );
  const created = await authority.adminCreateHostBootstrap({ expiresInMs: 120_000 });
  const [, selector, secret] = created.bootstrapToken.split(".");

  const malformedTokens = [
    `twhostboot2.${selector}`,
    `twhostboot2.${selector}.${secret}.extra`,
    `twhostboot2.${selector}.${secret}=`,
  ];
  for (const [index, malformedToken] of malformedTokens.entries()) {
    const admission = await admitHostBootstrap(authority, "failure-source");
    await assert.rejects(
      authority.bootstrapHost(
        admission,
        "failure-source",
        hostBootstrapInput(malformedToken, {
          bootstrapAttemptId: `malformed-bootstrap-${index}`,
        }),
      ),
      (error) => errorCode("AUTH_INVALID")(error)
        && !error.message.includes(malformedToken),
    );
  }
  const invalidIdentifierAdmission = await admitHostBootstrap(authority, "failure-source");
  await assert.rejects(
    authority.bootstrapHost(
      invalidIdentifierAdmission,
      "failure-source",
      hostBootstrapInput(created.bootstrapToken, { hostId: "" }),
    ),
    errorCode("INVALID_ARGUMENT"),
  );
  assert.equal(decodeState(store.snapshotBytes()).hostBootstraps[0].failedAttempts, 0);

  const unknownSelectorToken = `twhostboot2.${Buffer.alloc(16, 254).toString("base64url")}.${Buffer.alloc(32, 253).toString("base64url")}`;
  const unknownAdmission = await admitHostBootstrap(authority, "failure-source");
  const beforeUnknown = store.compareAndPublishCalls;
  await assert.rejects(
    authority.bootstrapHost(
      unknownAdmission,
      "failure-source",
      hostBootstrapInput(unknownSelectorToken, {
        bootstrapAttemptId: "unknown-selector-attempt",
      }),
    ),
    (error) => errorCode("AUTH_INVALID")(error)
      && !error.message.includes(unknownSelectorToken),
  );
  assert.equal(store.compareAndPublishCalls, beforeUnknown);
  assert.equal(decodeState(store.snapshotBytes()).hostBootstraps[0].failedAttempts, 0);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const wrongToken = `twhostboot2.${selector}.${Buffer.alloc(32, 100 + attempt).toString("base64url")}`;
    const admission = await admitHostBootstrap(authority, "failure-source");
    await assert.rejects(
      authority.bootstrapHost(
        admission,
        "failure-source",
        hostBootstrapInput(wrongToken, {
          bootstrapAttemptId: `known-selector-failure-${attempt}`,
        }),
      ),
      (error) => errorCode("AUTH_INVALID")(error) && !error.message.includes(wrongToken),
    );
    const record = decodeState(store.snapshotBytes()).hostBootstraps[0];
    assert.equal(record.failedAttempts, attempt);
    assert.equal(record.terminalAtMs, attempt === 5 ? NOW_MS : null);
    assert.equal(record.terminalReason, attempt === 5 ? "failures_exhausted" : null);
  }

  const correctAdmission = await admitHostBootstrap(authority, "failure-source");
  await assert.rejects(
    authority.bootstrapHost(
      correctAdmission,
      "failure-source",
      hostBootstrapInput(created.bootstrapToken, {
        bootstrapAttemptId: "correct-after-exhaustion",
      }),
    ),
    errorCode("AUTH_INVALID"),
  );
  assert.equal(decodeState(store.snapshotBytes()).grants.length, 0);
  await authority.close();
});

test("host bootstrap pre-body admission is limited to twenty attempts per source per minute", async () => {
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), {
      idPrefix: "host-bootstrap-source-rate",
    }),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await admitHostBootstrap(authority, "one-source-ip");
  }
  const beforeLimited = store.compareAndPublishCalls;
  await assert.rejects(
    admitHostBootstrap(authority, "one-source-ip"),
    errorCode("RATE_LIMITED"),
  );
  assert.equal(store.compareAndPublishCalls, beforeLimited);
  const state = decodeState(store.snapshotBytes());
  assert.deepEqual(state.rateLimits.find((item) => (
    item.scope === "host.bootstrap.source"
  )), {
    scope: "host.bootstrap.source",
    subjectHash: createHash("sha256").update("one-source-ip").digest("hex"),
    windowStartedAtMs: NOW_MS,
    attempts: 20,
  });
  await authority.close();
});

test("credential envelope revisions read legacy v1 and publish only explicit v2 successors", async () => {
  const seedStore = new InMemoryRelayV2BrokerCredentialStateStore();
  const seed = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(seedStore, new MemoryContinuityAuthority(), {
      idPrefix: "legacy-seed",
    }),
  );
  await seed.close();
  const legacyState = decodeState(seedStore.snapshotBytes());
  assert.equal(legacyState.version, 2);
  legacyState.version = 1;
  delete legacyState.hostBootstraps;
  legacyState.enrollments.push({
    enrollmentId: "preserved-legacy-enrollment",
    hostId: "preserved-legacy-host",
    codeHash: createHash("sha256").update("legacy-code").digest("hex"),
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 300_000,
    failedAttempts: 0,
    consumedAtMs: null,
  });
  const legacyBytes = encodeState(legacyState);
  const store = new InMemoryRelayV2BrokerCredentialStateStore({
    initialBytes: legacyBytes,
  });
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), {
      idPrefix: "legacy-open",
    }),
  );
  assert.equal(Buffer.from(store.snapshotBytes()).equals(legacyBytes), true);
  const created = await authority.adminCreateHostBootstrap();
  const upgraded = decodeState(store.snapshotBytes());
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.commitSequence, "1");
  assert.equal(upgraded.parentCommitId, legacyState.commitId);
  assert.deepEqual(upgraded.enrollments, legacyState.enrollments);
  assert.equal(upgraded.hostBootstraps.length, 1);
  assert.equal(
    upgraded.hostBootstraps[0].selector,
    created.bootstrapToken.split(".")[1],
  );
  await authority.close();
});

test("credential envelope cross-revision shapes and malformed bootstrap collections fail closed", async (t) => {
  const seedStore = new InMemoryRelayV2BrokerCredentialStateStore();
  const seed = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(seedStore, new MemoryContinuityAuthority(), {
      idPrefix: "invalid-bootstrap-state-seed",
    }),
  );
  const seedBootstrap = await seed.adminCreateHostBootstrap();
  const seedAdmission = await admitHostBootstrap(seed, "invalid-state-seed-source");
  await seed.bootstrapHost(
    seedAdmission,
    "invalid-state-seed-source",
    hostBootstrapInput(seedBootstrap.bootstrapToken, {
      bootstrapAttemptId: "invalid-state-seed-attempt",
    }),
  );
  await seed.close();
  const base = decodeState(seedStore.snapshotBytes());
  const selectorFor = (index) => {
    const bytes = Buffer.alloc(16);
    bytes.writeUInt32BE(index, 12);
    return bytes.toString("base64url");
  };
  const recordFor = (index) => ({
    selector: selectorFor(index),
    tokenHash: createHash("sha256").update(`bootstrap-${index}`).digest("hex"),
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 300_000,
    failedAttempts: 0,
    terminalAtMs: null,
    terminalReason: null,
  });
  const sorted = (records) => records.sort((left, right) => (
    Buffer.compare(Buffer.from(left.selector, "utf8"), Buffer.from(right.selector, "utf8"))
  ));
  const sortedReplays = (records) => records.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.operation}\0${left.subjectId}\0${left.attemptId}`, "utf8"),
    Buffer.from(`${right.operation}\0${right.subjectId}\0${right.attemptId}`, "utf8"),
  ));
  const cases = [
    {
      name: "v1 with v2 field",
      mutate(state) { state.version = 1; },
    },
    {
      name: "v2 without v2 field",
      mutate(state) { delete state.hostBootstraps; },
    },
    {
      name: "v1 with v2 rate vocabulary",
      mutate(state) {
        state.version = 1;
        delete state.hostBootstraps;
        state.replays = state.replays.filter((record) => record.operation !== "host.bootstrap");
      },
    },
    {
      name: "unknown envelope version",
      mutate(state) { state.version = 3; },
    },
    {
      name: "record unknown field",
      mutate(state) { state.hostBootstraps[0].unknown = true; },
    },
    {
      name: "expiry exceeds maximum",
      mutate(state) {
        state.hostBootstraps[0].expiresAtMs = state.hostBootstraps[0].createdAtMs + 300_001;
      },
    },
    {
      name: "records are not sorted",
      mutate(state) { state.hostBootstraps = sorted([recordFor(1), recordFor(2)]).reverse(); },
    },
    {
      name: "token hash is not unique",
      mutate(state) {
        const records = sorted([recordFor(3), recordFor(4)]);
        records[1].tokenHash = records[0].tokenHash;
        state.hostBootstraps = records;
      },
    },
    {
      name: "terminal relationship is impossible",
      mutate(state) {
        state.hostBootstraps[0].failedAttempts = 4;
        state.hostBootstraps[0].terminalAtMs = NOW_MS;
        state.hostBootstraps[0].terminalReason = "failures_exhausted";
      },
    },
    {
      name: "host bootstrap replay is orphaned",
      mutate(state) { state.hostBootstraps = []; },
    },
    {
      name: "consumed record has no replay",
      mutate(state) {
        state.replays = state.replays.filter((record) => record.operation !== "host.bootstrap");
      },
    },
    {
      name: "selector has duplicate replays",
      mutate(state) {
        const replay = clone(state.replays.find((record) => (
          record.operation === "host.bootstrap"
        )));
        replay.attemptId = "second-attempt-for-same-selector";
        state.replays.push(replay);
        sortedReplays(state.replays);
      },
    },
    {
      name: "replay expiry does not match consumed terminal",
      mutate(state) {
        state.replays.find((record) => (
          record.operation === "host.bootstrap"
        )).expiresAtMs += 1;
      },
    },
    {
      name: "failure-exhausted record has replay",
      mutate(state) {
        state.hostBootstraps[0].failedAttempts = 5;
        state.hostBootstraps[0].terminalReason = "failures_exhausted";
      },
    },
    {
      name: "active record has replay",
      mutate(state) {
        state.hostBootstraps[0].terminalAtMs = null;
        state.hostBootstraps[0].terminalReason = null;
      },
    },
    {
      name: "expired record has replay",
      mutate(state) {
        state.hostBootstraps[0].createdAtMs = NOW_MS - 300_000;
        state.hostBootstraps[0].expiresAtMs = NOW_MS;
        state.hostBootstraps[0].terminalAtMs = null;
        state.hostBootstraps[0].terminalReason = null;
      },
    },
    {
      name: "record capacity is exceeded",
      mutate(state) {
        state.hostBootstraps = sorted(Array.from({ length: 2_049 }, (_, index) => (
          recordFor(index)
        )));
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const state = clone(base);
      item.mutate(state);
      const bytes = encodeState(state);
      const store = new InMemoryRelayV2BrokerCredentialStateStore({ initialBytes: bytes });
      await assert.rejects(
        credential.RelayV2BrokerCredentialAuthority.open(
          authorityOptions(store, continuityAtStateBytes(bytes), {
            idPrefix: `invalid-${item.name}`,
          }),
        ),
        errorCode("STATE_INVALID"),
      );
      assert.equal(Buffer.from(store.snapshotBytes()).equals(bytes), true);
      assert.equal(store.closeCalls, 1);
    });
  }
});

test("host bootstrap rejects grant capacity before consuming its secret or issuing credentials", async () => {
  const seedStore = new InMemoryRelayV2BrokerCredentialStateStore();
  const seed = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(seedStore, new MemoryContinuityAuthority(), {
      idPrefix: "bootstrap-capacity-seed",
    }),
  );
  const created = await seed.adminCreateHostBootstrap();
  await seed.close();
  const capacityState = decodeState(seedStore.snapshotBytes());
  capacityState.grants = Array.from({ length: 4_096 }, (_, index) => ({
    role: "host",
    hostId: `capacity-host-${String(index).padStart(4, "0")}`,
    principalId: `capacity-principal-${String(index).padStart(4, "0")}`,
    grantId: `capacity-grant-${String(index).padStart(4, "0")}`,
    clientInstanceId: null,
    refreshTokenHash: createHash("sha256").update(`refresh-${index}`).digest("hex"),
    credentialVersion: "1",
    refreshExpiresAtMs: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
    maxAccessExpiresAtMs: NOW_MS + 60 * 60 * 1_000,
    revokedAtMs: null,
  }));
  const capacityBytes = encodeState(capacityState);
  const store = new InMemoryRelayV2BrokerCredentialStateStore({
    initialBytes: capacityBytes,
  });
  let randomCalls = 0;
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, continuityAtStateBytes(capacityBytes), {
      idPrefix: "bootstrap-capacity",
      randomBytes: (length) => {
        randomCalls += 1;
        return new Uint8Array(length);
      },
    }),
  );
  const admission = await admitHostBootstrap(authority, "capacity-source");
  const beforeBytes = store.snapshotBytes();
  const beforeCompares = store.compareAndPublishCalls;
  await assert.rejects(
    authority.bootstrapHost(
      admission,
      "capacity-source",
      hostBootstrapInput(created.bootstrapToken, {
        bootstrapAttemptId: "bootstrap-capacity-attempt",
      }),
    ),
    errorCode("STATE_CAPACITY_EXHAUSTED"),
  );
  assert.deepEqual(store.snapshotBytes(), beforeBytes);
  assert.equal(store.compareAndPublishCalls, beforeCompares);
  assert.equal(randomCalls, 0);
  const after = decodeState(store.snapshotBytes());
  assert.equal(after.hostBootstraps[0].terminalAtMs, null);
  assert.equal(after.hostBootstraps[0].failedAttempts, 0);
  assert.equal(after.grants.length, 4_096);
  await authority.close();
});

test("carrier and token authorization preserve frozen error classifications on reachable empty state", async () => {
  const store = new InMemoryRelayV2BrokerCredentialStateStore();
  const authority = await credential.RelayV2BrokerCredentialAuthority.open(
    authorityOptions(store, new MemoryContinuityAuthority(), { idPrefix: "classifications" }),
  );
  const missingGrant = await authority.handle({
    type: "grant.revoke",
    requestId: "revoke-one",
    connectorId: "connector-one",
    payload: { grantId: "client-grant", reason: "user_revoked" },
    currentAuthContext: hostContext(),
  });
  assert.equal(missingGrant.outcome, "reject");
  assert.equal(missingGrant.error.code, "GRANT_NOT_FOUND");

  const wrongRole = await authority.handle({
    type: "enrollment.create",
    requestId: "enroll-one",
    connectorId: "connector-one",
    payload: { expiresInMs: 300_000, deviceLabel: null },
    currentAuthContext: hostContext({ role: "client", clientInstanceId: "client-one" }),
  });
  assert.equal(wrongRole.outcome, "reject");
  assert.equal(wrongRole.error.code, "ROLE_MISMATCH");

  const prepared = issuer.prepareRelayV2AccessTokenIssuance(keyring(), {
    role: "host",
    hostId: "host-one",
    principalId: "principal-one",
    grantId: "missing-token-grant",
    nowSeconds: Math.floor(NOW_MS / 1_000),
    jti: "token-jti-one",
  });
  await assert.rejects(
    authority.authorizeAccessToken(prepared.token, "host"),
    errorCode("GRANT_NOT_FOUND"),
  );
  await assert.rejects(
    authority.authorizeAccessToken(prepared.token, "client"),
    errorCode("ROLE_MISMATCH"),
  );
  const invalidToken = "twcap2.not-a-valid-token";
  await assert.rejects(
    authority.authorizeAccessToken(invalidToken, "host"),
    (error) => errorCode("AUTH_INVALID")(error) && !error.message.includes(invalidToken),
  );
  const wrongPrefix = "not-twcap2.replacement";
  const malformedAccessTokens = [
    wrongPrefix,
    "twcap2.contains\0nul",
    `twcap2.${"a".repeat(8_193)}`,
  ];
  for (const malformedAccessToken of malformedAccessTokens) {
    await assert.rejects(
      authority.authorizeAccessToken(malformedAccessToken, "host"),
      (error) => errorCode("AUTH_INVALID")(error)
        && !error.message.includes(malformedAccessToken),
    );
  }
  await assert.rejects(
    authority.authorizeAccessToken(42, "host"),
    errorCode("INVALID_ARGUMENT"),
  );
  const malformedReauth = await authority.handle({
    type: "host.reauthenticate",
    requestId: "reauth-malformed",
    connectorId: "connector-one",
    accessToken: wrongPrefix,
    currentAuthContext: hostContext(),
  });
  assert.equal(malformedReauth.outcome, "reject");
  assert.equal(malformedReauth.error.code, "AUTH_INVALID");
  assert.equal(malformedReauth.error.message.includes(wrongPrefix), false);

  const malformedEnrollmentCodes = [
    "wrong-enrollment-prefix.value",
    "twenroll2.contains\0nul",
    `twenroll2.${"a".repeat(513)}`,
  ];
  for (const [index, enrollmentCode] of malformedEnrollmentCodes.entries()) {
    const sourceKey = `malformed-enrollment-source-${index}`;
    const admission = await authority.admitHttpSource({
      endpoint: "enrollment_redeem",
      sourceKey,
    });
    await assert.rejects(
      authority.redeemEnrollment(admission, sourceKey, {
        exchangeAttemptId: `malformed-enrollment-attempt-${index}`,
        enrollmentId: "missing-enrollment",
        enrollmentCode,
        clientInstanceId: "client-one",
        deviceLabel: "device",
      }),
      (error) => errorCode("AUTH_INVALID")(error)
        && !error.message.includes(enrollmentCode),
    );
  }
  const nonStringEnrollmentSource = "non-string-enrollment-source";
  const nonStringEnrollmentAdmission = await authority.admitHttpSource({
    endpoint: "enrollment_redeem",
    sourceKey: nonStringEnrollmentSource,
  });
  await assert.rejects(
    authority.redeemEnrollment(nonStringEnrollmentAdmission, nonStringEnrollmentSource, {
      exchangeAttemptId: "non-string-enrollment-attempt",
      enrollmentId: "missing-enrollment",
      enrollmentCode: 42,
      clientInstanceId: "client-one",
      deviceLabel: "device",
    }),
    errorCode("INVALID_ARGUMENT"),
  );

  const malformedRefreshTokens = [
    "wrong-refresh-prefix.value",
    "twref2.contains\0nul",
    `twref2.${"a".repeat(513)}`,
  ];
  for (const [index, refreshToken] of malformedRefreshTokens.entries()) {
    await assert.rejects(
      authority.refreshGrant({
        refreshAttemptId: `malformed-refresh-attempt-${index}`,
        grantId: "missing-refresh-grant",
        refreshToken,
        clientInstanceId: "client-one",
      }),
      (error) => errorCode("AUTH_INVALID")(error)
        && !error.message.includes(refreshToken),
    );
  }
  await assert.rejects(
    authority.refreshGrant({
      refreshAttemptId: "non-string-refresh-attempt",
      grantId: "missing-refresh-grant",
      refreshToken: 42,
      clientInstanceId: "client-one",
    }),
    errorCode("INVALID_ARGUMENT"),
  );
  await assert.rejects(
    authority.refreshGrant({
      refreshAttemptId: "missing-refresh-attempt",
      grantId: "missing-refresh-grant",
      refreshToken: "twref2.not-the-token",
      clientInstanceId: "client-one",
    }),
    (error) => errorCode("AUTH_INVALID")(error)
      && !error.message.includes("not-the-token"),
  );
  await authority.close();
});
