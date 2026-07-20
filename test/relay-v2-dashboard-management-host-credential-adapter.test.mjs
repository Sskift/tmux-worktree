import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents: [
      'export * from "./hostCredentialAuthority.ts";',
      'export * from "./hostCredentialExchangeCoordinator.ts";',
      'export * from "./relayV2DashboardManagementHostCredentialAdapter.ts";',
    ].join("\n"),
    resolveDir: new URL("../src/relay/v2/", import.meta.url).pathname,
    sourcefile: "dashboard-management-host-credential-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const credential = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const issuer = await import("../dist/relay/v2/issuer.js");

const NOW_SECONDS = 1_783_700_000;
const BINDING = Object.freeze({
  credentialReference: "relay-v2-host-credential-ref:primary",
  hostId: "mac-admin",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
  bootstrapSecretReference: "bootstrap-secret-reference-one",
  refreshSecretReference: "refresh-secret-reference-one",
});
const BOOTSTRAP_REQUEST = Object.freeze({ requestId: "dmgmt2.bootstrap-attempt" });
const REFRESH_REQUEST = Object.freeze({ requestId: "dmgmt2.refresh-attempt" });
const BOOTSTRAP_TOKEN = "twhostboot2.bootstrap-secret-material";
const REFRESH_TOKEN_1 = "twref2.host-refresh-token-1";
const REFRESH_TOKEN_2 = "twref2.host-refresh-token-2";
const SECRET_MARKERS = Object.freeze([
  "twcap2.access-secret-marker",
  "twref2.refresh-secret-marker",
  "twhostboot2.bootstrap-secret-marker",
]);

class InMemoryCredentialStorage {
  slots = new Map();
  revisions = new WeakMap();
  compareAttempts = 0;
  uncertainCompareAttempt = null;
  beforeExclusive = null;

  runExclusive(reference, operation) {
    this.beforeExclusive?.(reference);
    const transaction = {
      read: () => this.readCut(reference),
      compareAndSwap: (expected, replacement) => {
        this.compareAttempts += 1;
        const identity = this.revisions.get(expected);
        const slot = this.slot(reference);
        if (!identity
          || identity.reference !== reference
          || identity.revision !== slot.revision) {
          return { status: "conflict", current: this.readCut(reference) };
        }
        if (this.uncertainCompareAttempt === this.compareAttempts) {
          return { status: "uncertain" };
        }
        slot.state = structuredClone(replacement);
        slot.revision += 1;
        return { status: "swapped" };
      },
    };
    return operation(transaction);
  }

  snapshot(reference = BINDING.credentialReference) {
    const state = this.slot(reference).state;
    return state === null ? null : structuredClone(state);
  }

  replace(state, reference = BINDING.credentialReference) {
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
    const revision = Object.freeze({ credentialRevision: true });
    this.revisions.set(revision, { reference, revision: slot.revision });
    return {
      state: slot.state === null ? null : structuredClone(slot.state),
      revision,
    };
  }
}

class RecordingSecretResolver {
  values = new Map([
    [BINDING.bootstrapSecretReference, BOOTSTRAP_TOKEN],
    [BINDING.refreshSecretReference, REFRESH_TOKEN_1],
  ]);
  resolutions = [];
  unavailable = new Set();

  resolve(reference) {
    this.resolutions.push(reference);
    if (this.unavailable.has(reference) || !this.values.has(reference)) {
      throw new Error(`secret unavailable ${SECRET_MARKERS.join(" ")}`);
    }
    return this.values.get(reference);
  }
}

function tokenIssuer() {
  let keyring = issuer.createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid: "dashboard-host-credential-test-key",
    secretBase64url: Buffer.alloc(32, 0x62).toString("base64url"),
    nowSeconds: NOW_SECONDS,
  });
  let issued = 0;
  return (hostId, overrides = {}) => {
    issued += 1;
    const prepared = issuer.prepareRelayV2AccessTokenIssuance(keyring, {
      role: "host",
      hostId,
      principalId: overrides.principalId ?? "host-principal-one",
      grantId: overrides.grantId ?? "host-grant-one",
      nowSeconds: NOW_SECONDS + issued,
      jti: `host-access-jti-${issued}`,
    });
    keyring = prepared.nextKeyring;
    return prepared;
  };
}

function bootstrapResponse(input, access, overrides = {}) {
  return {
    bootstrapAttemptId: input.bootstrapAttemptId,
    principalId: overrides.principalId ?? "host-principal-one",
    grantId: overrides.grantId ?? "host-grant-one",
    hostId: input.hostId,
    accessToken: access.token,
    accessExpiresAtMs: access.claims.exp * 1_000,
    refreshToken: REFRESH_TOKEN_1,
    refreshExpiresAtMs: 1_786_292_000_000,
  };
}

function refreshResponse(input, access) {
  return {
    refreshAttemptId: input.refreshAttemptId,
    principalId: "host-principal-one",
    grantId: "host-grant-one",
    hostId: BINDING.hostId,
    accessToken: access.token,
    accessExpiresAtMs: access.claims.exp * 1_000,
    refreshToken: REFRESH_TOKEN_2,
    refreshExpiresAtMs: 1_786_292_001_000,
  };
}

function assertManagementFailure(code) {
  return (error) => {
    assert.equal(error?.name, "RelayV2DashboardManagementAuthorityFailure");
    assert.equal(error?.code, code);
    const diagnostic = `${error.name}\n${error.message}\n${String(error.stack)}\n${JSON.stringify(error)}`;
    for (const marker of SECRET_MARKERS) assert.equal(diagnostic.includes(marker), false);
    return true;
  };
}

function harness(options = {}) {
  const storage = options.storage ?? new InMemoryCredentialStorage();
  const secrets = options.secrets ?? new RecordingSecretResolver();
  const issueToken = tokenIssuer();
  const authority = new credential.RelayV2HostCredentialAuthority({
    storage,
    secretResolver: secrets,
  });
  const networkCalls = [];
  const httpsAdapter = {
    async bootstrap(input, signal) {
      networkCalls.push(["bootstrap", structuredClone(input), signal]);
      if (options.bootstrapExchange) return options.bootstrapExchange(input, signal, authority);
      return bootstrapResponse(input, issueToken(input.hostId));
    },
    async refresh(input, signal) {
      networkCalls.push(["refresh", structuredClone(input), signal]);
      if (options.refreshExchange) return options.refreshExchange(input, signal, authority);
      return refreshResponse(input, issueToken(BINDING.hostId));
    },
  };
  const coordinator = new credential.RelayV2HostCredentialExchangeCoordinator({
    authority,
    httpsAdapter,
  });
  const owner = coordinator.createOwnerBoundPort();
  const signal = options.signal ?? new AbortController().signal;
  const adapter = new credential.RelayV2DashboardManagementHostCredentialAdapter({
    owner,
    ...BINDING,
    signal,
  });
  return {
    adapter,
    authority,
    coordinator,
    owner,
    storage,
    secrets,
    signal,
    networkCalls,
    issueToken,
  };
}

function installReady(h, overrides = {}) {
  const prepared = h.authority.prepareBootstrap({
    credentialReference: BINDING.credentialReference,
    hostId: overrides.hostId ?? BINDING.hostId,
    attemptId: overrides.attemptId ?? "installed-bootstrap-attempt",
    oldSecretReference: BINDING.bootstrapSecretReference,
  });
  const access = h.issueToken(overrides.hostId ?? BINDING.hostId, overrides);
  const committed = h.authority.applyBootstrapResponse(
    prepared.fence,
    bootstrapResponse({
      bootstrapAttemptId: prepared.fence.attemptId,
      hostId: overrides.hostId ?? BINDING.hostId,
    }, access, overrides),
  );
  assert.deepEqual(committed, { status: "applied", credentialVersion: "1" });
}

function restoreAdapterValidReadyInspection(h) {
  const state = h.storage.snapshot();
  const access = h.issueToken(BINDING.hostId);
  state.principalId = "host-principal-one";
  state.grantId = "host-grant-one";
  state.accessToken = access.token;
  state.accessExpiresAtMs = access.claims.exp * 1_000;
  state.accessJti = access.claims.jti;
  h.storage.replace(state);
}

test("inspect exposes only closed missing, ready, and failed NDM1 projections", () => {
  const h = harness();
  assert.deepEqual(h.adapter.inspect(), { status: "missing" });

  h.authority.prepareBootstrap({
    credentialReference: BINDING.credentialReference,
    hostId: BINDING.hostId,
    attemptId: "durable-bootstrap-attempt",
    oldSecretReference: BINDING.bootstrapSecretReference,
  });
  assert.deepEqual(h.adapter.inspect(), { status: "missing" });

  const readyHarness = harness();
  installReady(readyHarness);
  const ready = readyHarness.adapter.inspect();
  assert.deepEqual(ready, {
    status: "ready",
    hostId: BINDING.hostId,
    credentialReference: BINDING.credentialReference,
    expiresAtMs: readyHarness.authority.inspect(
      BINDING.credentialReference,
    ).accessExpiresAtMs,
  });
  assert.equal(Object.isFrozen(ready), true);
  const serialized = JSON.stringify(ready);
  for (const forbidden of [
    "principalId", "grantId", "accessJti", "refreshExpiresAtMs",
    "accessToken", "refreshToken", "bootstrapToken", ...SECRET_MARKERS,
  ]) assert.equal(serialized.includes(forbidden), false);

  const failed = harness();
  failed.storage.beforeExclusive = () => {
    throw new Error(`storage unavailable ${SECRET_MARKERS.join(" ")}`);
  };
  assert.deepEqual(failed.adapter.inspect(), { status: "failed", retryable: true });
});

test("bootstrap and refresh use the fixed binding, exact signal, and durable attempt", async (t) => {
  await t.test("new bootstrap and refresh", async () => {
    const h = harness();
    assert.equal(await h.adapter.bootstrap(BOOTSTRAP_REQUEST), undefined);
    assert.equal(await h.adapter.refresh(REFRESH_REQUEST), undefined);
    assert.equal(h.networkCalls.length, 2);
    assert.deepEqual(h.networkCalls[0][1], {
      bootstrapAttemptId: BOOTSTRAP_REQUEST.requestId,
      bootstrapToken: BOOTSTRAP_TOKEN,
      hostId: BINDING.hostId,
      hostEpoch: BINDING.hostEpoch,
      hostInstanceId: BINDING.hostInstanceId,
    });
    assert.equal(h.networkCalls[1][1].refreshAttemptId, REFRESH_REQUEST.requestId);
    assert.equal(h.networkCalls[1][1].hostInstanceId, BINDING.hostInstanceId);
    assert.strictEqual(h.networkCalls[0][2], h.signal);
    assert.strictEqual(h.networkCalls[1][2], h.signal);
  });

  await t.test("existing bootstrap and refresh attempts retain exact durable identity", async () => {
    const bootstrap = harness();
    bootstrap.authority.prepareBootstrap({
      credentialReference: BINDING.credentialReference,
      hostId: BINDING.hostId,
      attemptId: "durable-bootstrap-winner",
      oldSecretReference: BINDING.bootstrapSecretReference,
    });
    await bootstrap.adapter.bootstrap(BOOTSTRAP_REQUEST);
    assert.equal(bootstrap.networkCalls[0][1].bootstrapAttemptId, "durable-bootstrap-winner");

    const refresh = harness();
    installReady(refresh);
    refresh.authority.prepareRefresh({
      credentialReference: BINDING.credentialReference,
      attemptId: "durable-refresh-winner",
      oldSecretReference: BINDING.refreshSecretReference,
    });
    await refresh.adapter.refresh(REFRESH_REQUEST);
    assert.equal(refresh.networkCalls[0][1].refreshAttemptId, "durable-refresh-winner");
    assert.equal(refresh.networkCalls.length, 1);
  });
});

test("structural port splicing and conflicting durable bindings close before network", async (t) => {
  assert.throws(
    () => new credential.RelayV2DashboardManagementHostCredentialAdapter({
      owner: {
        inspect() { return null; },
        capture() { return { inspection: null, cut: {} }; },
        bootstrap() { return Promise.resolve({ status: "applied", credentialVersion: "1" }); },
        refresh() { return Promise.resolve({ status: "applied", credentialVersion: "2" }); },
      },
      ...BINDING,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof credential.RelayV2DashboardManagementHostCredentialAdapterClosedError,
  );

  await t.test("refresh pending blocks bootstrap", async () => {
    const h = harness();
    installReady(h);
    h.authority.prepareRefresh({
      credentialReference: BINDING.credentialReference,
      attemptId: "durable-refresh-blocker",
      oldSecretReference: BINDING.refreshSecretReference,
    });
    await assert.rejects(
      h.adapter.bootstrap(BOOTSTRAP_REQUEST),
      assertManagementFailure("BUSY"),
    );
    assert.equal(h.networkCalls.length, 0);
    await h.adapter.refresh(REFRESH_REQUEST);
    assert.equal(h.networkCalls.length, 1);
    assert.equal(h.networkCalls[0][1].refreshAttemptId, "durable-refresh-blocker");
  });

  await t.test("bootstrap pending blocks refresh", async () => {
    const h = harness();
    h.authority.prepareBootstrap({
      credentialReference: BINDING.credentialReference,
      hostId: BINDING.hostId,
      attemptId: "durable-bootstrap-blocker",
      oldSecretReference: BINDING.bootstrapSecretReference,
    });
    await assert.rejects(
      h.adapter.refresh(REFRESH_REQUEST),
      assertManagementFailure("BUSY"),
    );
    assert.equal(h.networkCalls.length, 0);
  });

  await t.test("foreign host binding closes during capture", async () => {
    const h = harness();
    h.authority.prepareBootstrap({
      credentialReference: BINDING.credentialReference,
      hostId: "foreign-host",
      attemptId: "foreign-host-bootstrap",
      oldSecretReference: BINDING.bootstrapSecretReference,
    });
    await assert.rejects(
      h.adapter.bootstrap(BOOTSTRAP_REQUEST),
      assertManagementFailure("BUSY"),
    );
    assert.equal(h.networkCalls.length, 0);
  });

  await t.test("ready credential rejects bootstrap as NOT_READY then admits refresh", async () => {
    const h = harness();
    installReady(h);
    await assert.rejects(
      h.adapter.bootstrap(BOOTSTRAP_REQUEST),
      assertManagementFailure("NOT_READY"),
    );
    assert.equal(h.networkCalls.length, 0);
    await h.adapter.refresh(REFRESH_REQUEST);
    assert.equal(h.networkCalls.length, 1);
    assert.equal(h.networkCalls[0][1].refreshAttemptId, REFRESH_REQUEST.requestId);
  });
});

test("pre-consume validation failure releases its genuine cut for a fresh success", async () => {
  const h = harness();
  const first = h.owner.capture({
    credentialReference: BINDING.credentialReference,
    hostId: BINDING.hostId,
  });
  const comparesBefore = h.storage.compareAttempts;
  const secretsBefore = h.secrets.resolutions.length;
  await assert.rejects(
    h.owner.bootstrap(first.cut, {
      credentialReference: BINDING.credentialReference,
      hostId: BINDING.hostId,
      attemptId: " malformed-attempt-id",
      oldSecretReference: BINDING.bootstrapSecretReference,
      hostEpoch: BINDING.hostEpoch,
      hostInstanceId: BINDING.hostInstanceId,
    }, h.signal),
    (error) => error?.code === "RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT",
  );
  assert.equal(h.storage.compareAttempts, comparesBefore);
  assert.equal(h.secrets.resolutions.length, secretsBefore);
  assert.equal(h.networkCalls.length, 0);
  assert.equal(h.storage.snapshot(), null);

  const fresh = h.owner.capture({
    credentialReference: BINDING.credentialReference,
    hostId: BINDING.hostId,
  });
  assert.notStrictEqual(fresh.cut, first.cut);
  assert.deepEqual(await h.owner.bootstrap(fresh.cut, {
    credentialReference: BINDING.credentialReference,
    hostId: BINDING.hostId,
    attemptId: BOOTSTRAP_REQUEST.requestId,
    oldSecretReference: BINDING.bootstrapSecretReference,
    hostEpoch: BINDING.hostEpoch,
    hostInstanceId: BINDING.hostInstanceId,
  }, h.signal), { status: "applied", credentialVersion: "1" });
  assert.equal(h.networkCalls.length, 1);
});

test("adapter-invalid owner inspection releases each captured cut before a fresh success", async (t) => {
  for (const operation of ["bootstrap", "refresh"]) {
    await t.test(operation, async () => {
      const h = harness();
      installReady(h, { principalId: SECRET_MARKERS[0] });
      const secretsBefore = h.secrets.resolutions.length;
      const comparesBefore = h.storage.compareAttempts;
      await assert.rejects(
        h.adapter[operation](
          operation === "bootstrap" ? BOOTSTRAP_REQUEST : REFRESH_REQUEST,
        ),
        (error) => (
          error instanceof credential.RelayV2DashboardManagementHostCredentialAdapterClosedError
        ),
      );
      assert.equal(h.secrets.resolutions.length, secretsBefore);
      assert.equal(h.storage.compareAttempts, comparesBefore);
      assert.equal(h.networkCalls.length, 0);

      restoreAdapterValidReadyInspection(h);
      await h.adapter.refresh(REFRESH_REQUEST);
      assert.equal(h.networkCalls.length, 1);
      assert.equal(h.networkCalls[0][0], "refresh");
    });
  }
});

test("stale cut after a concurrent pending advance performs zero second mutation and zero network", async () => {
  const h = harness();
  installReady(h);
  const events = [];
  let boundaryCalls = 0;
  h.storage.beforeExclusive = () => {
    boundaryCalls += 1;
    if (boundaryCalls === 1) {
      events.push("capture");
      return;
    }
    assert.equal(boundaryCalls, 2);
    events.push("preflight-barrier");
    h.storage.beforeExclusive = null;
    h.authority.prepareRefresh({
      credentialReference: BINDING.credentialReference,
      attemptId: "concurrent-durable-winner",
      oldSecretReference: BINDING.refreshSecretReference,
    });
    events.push("concurrent-pending-committed");
  };
  const comparesBefore = h.storage.compareAttempts;
  const secretsBefore = h.secrets.resolutions.length;

  await assert.rejects(
    h.adapter.refresh(REFRESH_REQUEST),
    assertManagementFailure("BUSY"),
  );

  assert.deepEqual(events, [
    "capture",
    "preflight-barrier",
    "concurrent-pending-committed",
  ]);
  assert.equal(h.storage.compareAttempts, comparesBefore + 1);
  assert.equal(h.secrets.resolutions.length, secretsBefore + 1);
  assert.equal(h.networkCalls.length, 0);
  assert.equal(
    h.storage.snapshot().pendingCredentialAttempt.attemptId,
    "concurrent-durable-winner",
  );
});

test("fixed typed failures never retry, replay, clean up, or expose a secret", async (t) => {
  await t.test("stale owner apply is terminal", async () => {
    let h;
    h = harness({
      refreshExchange(input, _signal, authority) {
        const access = h.issueToken(BINDING.hostId);
        const response = refreshResponse(input, access);
        const pending = authority.inspect(BINDING.credentialReference)
          .pendingCredentialAttempt;
        assert.deepEqual(authority.applyRefreshResponse({
          credentialReference: BINDING.credentialReference,
          kind: "refresh",
          attemptId: pending.attemptId,
          oldCredentialVersion: pending.oldCredentialVersion,
          oldSecretReference: pending.oldSecretReference,
        }, response), { status: "applied", credentialVersion: "2" });
        return response;
      },
    });
    installReady(h);
    await assert.rejects(
      h.adapter.refresh(REFRESH_REQUEST),
      assertManagementFailure("OPERATION_FAILED"),
    );
    assert.equal(h.networkCalls.length, 1);
  });

  await t.test("secret failure is unavailable before network", async () => {
    const h = harness();
    installReady(h);
    h.secrets.unavailable.add(BINDING.refreshSecretReference);
    await assert.rejects(
      h.adapter.refresh(REFRESH_REQUEST),
      assertManagementFailure("UNAVAILABLE"),
    );
    assert.equal(h.networkCalls.length, 0);
  });

  await t.test("network failure is unavailable after one exchange", async () => {
    const h = harness({
      refreshExchange() {
        const error = new Error(SECRET_MARKERS.join(" "));
        error.name = "RelayV2HostCredentialHttpsAdapterError";
        error.code = "EXCHANGE_FAILED";
        throw error;
      },
    });
    installReady(h);
    await assert.rejects(
      h.adapter.refresh(REFRESH_REQUEST),
      assertManagementFailure("UNAVAILABLE"),
    );
    assert.equal(h.networkCalls.length, 1);
    assert.equal(h.storage.snapshot().pendingCredentialAttempt.attemptId,
      REFRESH_REQUEST.requestId);
  });

  await t.test("commit uncertainty is terminal after one exchange", async () => {
    const h = harness();
    installReady(h);
    h.storage.uncertainCompareAttempt = h.storage.compareAttempts + 2;
    await assert.rejects(
      h.adapter.refresh(REFRESH_REQUEST),
      assertManagementFailure("OPERATION_FAILED"),
    );
    assert.equal(h.networkCalls.length, 1);
    assert.equal(h.storage.snapshot().credentialVersion, "1");
  });
});

test("caller AbortSignal is passed unchanged without timeout or fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({
    signal: controller.signal,
    refreshExchange(_input, signal) {
      assert.strictEqual(signal, controller.signal);
      const error = new Error(SECRET_MARKERS.join(" "));
      error.name = "RelayV2HostCredentialHttpsAdapterError";
      error.code = "ABORTED";
      throw error;
    },
  });
  installReady(h);
  await assert.rejects(
    h.adapter.refresh(REFRESH_REQUEST),
    assertManagementFailure("OPERATION_FAILED"),
  );
  assert.equal(h.networkCalls.length, 1);
  assert.strictEqual(h.networkCalls[0][2], controller.signal);
});

test("corrupt owner state fails closed without repair or credential reflection", async () => {
  const h = harness();
  installReady(h);
  const corrupt = h.storage.snapshot();
  corrupt.accessTokenReflection = SECRET_MARKERS[0];
  h.storage.replace(corrupt);
  assert.deepEqual(h.adapter.inspect(), { status: "failed", retryable: false });
  const before = h.storage.snapshot();
  await assert.rejects(
    h.adapter.refresh(REFRESH_REQUEST),
    assertManagementFailure("OPERATION_FAILED"),
  );
  assert.deepEqual(h.storage.snapshot(), before);
  assert.equal(h.networkCalls.length, 0);
});
