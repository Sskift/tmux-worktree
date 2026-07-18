import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [new URL(
    "../src/relay/v2/hostCredentialExchangeCoordinator.ts",
    import.meta.url,
  ).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
});
const coordinatorModule = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

const BOOTSTRAP_INPUT = Object.freeze({
  credentialReference: "relay-v2-host-credential-ref:primary",
  hostId: "caller-host-must-not-overwrite-durable-winner",
  attemptId: "caller-bootstrap-attempt-must-not-overwrite-durable-winner",
  oldSecretReference: "caller-bootstrap-secret-reference",
  bootstrapToken: "twhostboot2.caller-token-must-not-overwrite-durable-winner",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
  forbiddenAuthorityField: "must-not-be-spread",
});
const REFRESH_INPUT = Object.freeze({
  credentialReference: "relay-v2-host-credential-ref:primary",
  attemptId: "caller-refresh-attempt-must-not-overwrite-durable-winner",
  oldSecretReference: "caller-refresh-secret-reference",
  grantId: "caller-grant-must-not-overwrite-durable-winner",
  refreshToken: "twref2.caller-token-must-not-overwrite-durable-winner",
  hostInstanceId: "host-instance-two",
  forbiddenAuthorityField: "must-not-be-spread",
});

function bootstrapPrepared() {
  return {
    fence: {
      credentialReference: BOOTSTRAP_INPUT.credentialReference,
      kind: "bootstrap",
      attemptId: "durable-bootstrap-attempt-winner",
      oldCredentialVersion: "0",
      oldSecretReference: BOOTSTRAP_INPUT.oldSecretReference,
    },
    credential: {
      bootstrapToken: "twhostboot2.durable-bootstrap-token",
      hostId: "durable-host-winner",
    },
  };
}

function refreshPrepared() {
  return {
    fence: {
      credentialReference: REFRESH_INPUT.credentialReference,
      kind: "refresh",
      attemptId: "durable-refresh-attempt-winner",
      oldCredentialVersion: "7",
      oldSecretReference: REFRESH_INPUT.oldSecretReference,
    },
    credential: {
      grantId: "durable-grant-winner",
      refreshToken: "twref2.durable-refresh-token",
    },
  };
}

function bootstrapResponse(label = "winner") {
  return {
    bootstrapAttemptId: "durable-bootstrap-attempt-winner",
    principalId: `principal-${label}`,
    grantId: `grant-${label}`,
    hostId: "durable-host-winner",
    accessToken: `twcap2.access-${label}`,
    accessExpiresAtMs: 1_800_003_600_000,
    refreshToken: `twref2.next-${label}`,
    refreshExpiresAtMs: 1_800_086_400_000,
  };
}

function refreshResponse(label = "winner") {
  return {
    refreshAttemptId: "durable-refresh-attempt-winner",
    principalId: `principal-${label}`,
    grantId: "durable-grant-winner",
    hostId: "durable-host-winner",
    accessToken: `twcap2.access-${label}`,
    accessExpiresAtMs: 1_800_003_600_000,
    refreshToken: `twref2.next-${label}`,
    refreshExpiresAtMs: 1_800_086_400_000,
  };
}

function coordinator(authority, httpsAdapter) {
  return new coordinatorModule.RelayV2HostCredentialExchangeCoordinator({
    authority,
    httpsAdapter,
  });
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

test("bootstrap and refresh strictly order prepare, one exchange, and exact apply", async (t) => {
  await t.test("bootstrap projects inputs and uses the durable prepared winner", async () => {
    const events = [];
    const winner = bootstrapPrepared();
    const replaced = {
      fence: {
        ...winner.fence,
        attemptId: "replaced-bootstrap-attempt-must-not-be-observed",
      },
      credential: {
        bootstrapToken: "twhostboot2.replaced-token-must-not-be-observed",
        hostId: "replaced-host-must-not-be-observed",
      },
    };
    const preparedReads = { fence: 0, credential: 0 };
    const prepared = Object.defineProperties({}, {
      fence: {
        enumerable: true,
        get() {
          preparedReads.fence += 1;
          return preparedReads.fence === 1 ? winner.fence : replaced.fence;
        },
      },
      credential: {
        enumerable: true,
        get() {
          preparedReads.credential += 1;
          return preparedReads.credential === 1 ? winner.credential : replaced.credential;
        },
      },
    });
    const response = bootstrapResponse();
    const applied = { status: "applied", credentialVersion: "1" };
    const signal = new AbortController().signal;
    let authorityInput;
    let httpsInput;
    let observedSignal;
    let appliedFence;
    let appliedResponse;
    const authority = {
      prepareBootstrap(input) {
        events.push("prepare");
        authorityInput = input;
        return prepared;
      },
      applyBootstrapResponse(fence, value) {
        events.push("apply");
        appliedFence = fence;
        appliedResponse = value;
        return applied;
      },
    };
    const httpsAdapter = {
      async bootstrap(input, value) {
        events.push("network");
        httpsInput = input;
        observedSignal = value;
        return response;
      },
    };

    const result = await coordinator(authority, httpsAdapter).bootstrap(
      BOOTSTRAP_INPUT,
      signal,
    );

    assert.deepEqual(events, ["prepare", "network", "apply"]);
    assert.deepEqual(authorityInput, {
      credentialReference: BOOTSTRAP_INPUT.credentialReference,
      hostId: BOOTSTRAP_INPUT.hostId,
      attemptId: BOOTSTRAP_INPUT.attemptId,
      oldSecretReference: BOOTSTRAP_INPUT.oldSecretReference,
    });
    assert.notStrictEqual(authorityInput, BOOTSTRAP_INPUT);
    assert.deepEqual(httpsInput, {
      bootstrapAttemptId: winner.fence.attemptId,
      bootstrapToken: winner.credential.bootstrapToken,
      hostId: winner.credential.hostId,
      hostEpoch: BOOTSTRAP_INPUT.hostEpoch,
      hostInstanceId: BOOTSTRAP_INPUT.hostInstanceId,
    });
    assert.deepEqual(preparedReads, { fence: 1, credential: 1 });
    assert.strictEqual(observedSignal, signal);
    assert.strictEqual(appliedFence, winner.fence);
    assert.strictEqual(appliedResponse, response);
    assert.strictEqual(result, applied);
  });

  await t.test("refresh projects inputs and uses the durable prepared winner", async () => {
    const events = [];
    const winner = refreshPrepared();
    const replaced = {
      fence: {
        ...winner.fence,
        attemptId: "replaced-refresh-attempt-must-not-be-observed",
      },
      credential: {
        grantId: "replaced-grant-must-not-be-observed",
        refreshToken: "twref2.replaced-token-must-not-be-observed",
      },
    };
    const preparedReads = { fence: 0, credential: 0 };
    const prepared = Object.defineProperties({}, {
      fence: {
        enumerable: true,
        get() {
          preparedReads.fence += 1;
          return preparedReads.fence === 1 ? winner.fence : replaced.fence;
        },
      },
      credential: {
        enumerable: true,
        get() {
          preparedReads.credential += 1;
          return preparedReads.credential === 1 ? winner.credential : replaced.credential;
        },
      },
    });
    const response = refreshResponse();
    const stale = { status: "stale", credentialVersion: "8" };
    const signal = new AbortController().signal;
    let authorityInput;
    let httpsInput;
    let observedSignal;
    let appliedFence;
    let appliedResponse;
    const authority = {
      prepareRefresh(input) {
        events.push("prepare");
        authorityInput = input;
        return prepared;
      },
      applyRefreshResponse(fence, value) {
        events.push("apply");
        appliedFence = fence;
        appliedResponse = value;
        return stale;
      },
    };
    const httpsAdapter = {
      async refresh(input, value) {
        events.push("network");
        httpsInput = input;
        observedSignal = value;
        return response;
      },
    };

    const result = await coordinator(authority, httpsAdapter).refresh(REFRESH_INPUT, signal);

    assert.deepEqual(events, ["prepare", "network", "apply"]);
    assert.deepEqual(authorityInput, {
      credentialReference: REFRESH_INPUT.credentialReference,
      attemptId: REFRESH_INPUT.attemptId,
      oldSecretReference: REFRESH_INPUT.oldSecretReference,
    });
    assert.notStrictEqual(authorityInput, REFRESH_INPUT);
    assert.deepEqual(httpsInput, {
      refreshAttemptId: winner.fence.attemptId,
      grantId: winner.credential.grantId,
      hostInstanceId: REFRESH_INPUT.hostInstanceId,
      refreshToken: winner.credential.refreshToken,
    });
    assert.deepEqual(preparedReads, { fence: 1, credential: 1 });
    assert.strictEqual(observedSignal, signal);
    assert.strictEqual(appliedFence, winner.fence);
    assert.strictEqual(appliedResponse, response);
    assert.strictEqual(result, stale);
  });
});

test("prepare failures perform zero network and zero apply without reconciliation", async (t) => {
  const cases = [
    {
      name: "deterministic prepare rejection",
      operation: "bootstrap",
      input: BOOTSTRAP_INPUT,
      pending: null,
      error: Object.assign(new Error("attempt conflict"), {
        code: "RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT",
      }),
    },
    {
      name: "prepare commit uncertain after a possible durable winner",
      operation: "refresh",
      input: REFRESH_INPUT,
      pending: refreshPrepared().fence,
      error: Object.assign(new Error("commit uncertain"), {
        code: "RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN",
      }),
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const state = {
        pending: item.pending,
        prepareCalls: 0,
        networkCalls: 0,
        applyCalls: 0,
        clearCalls: 0,
      };
      const authority = {
        prepareBootstrap() { state.prepareCalls += 1; throw item.error; },
        prepareRefresh() { state.prepareCalls += 1; throw item.error; },
        applyBootstrapResponse() { state.applyCalls += 1; },
        applyRefreshResponse() { state.applyCalls += 1; },
        clearPending() { state.clearCalls += 1; state.pending = null; },
      };
      const httpsAdapter = {
        bootstrap() { state.networkCalls += 1; return Promise.reject(new Error("must not run")); },
        refresh() { state.networkCalls += 1; return Promise.reject(new Error("must not run")); },
      };

      await assert.rejects(
        coordinator(authority, httpsAdapter)[item.operation](
          item.input,
          new AbortController().signal,
        ),
        (error) => error === item.error,
      );
      assert.equal(state.prepareCalls, 1);
      assert.equal(state.networkCalls, 0);
      assert.equal(state.applyCalls, 0);
      assert.equal(state.clearCalls, 0);
      assert.strictEqual(state.pending, item.pending);
    });
  }
});

test("abort, transport, decode, and rejection failures stay one-exchange with pending retained", async (t) => {
  const cases = [
    ["abort", "bootstrap", Object.assign(new Error("aborted"), { code: "ABORTED" })],
    ["transport", "refresh", Object.assign(new Error("transport"), { code: "EXCHANGE_FAILED" })],
    ["decode", "bootstrap", Object.assign(new Error("decode"), { code: "EXCHANGE_FAILED" })],
    ["retryable rejection", "refresh", Object.assign(new Error("busy"), {
      code: "CREDENTIAL_REJECTED",
      retryable: true,
      retryAfterMs: 1,
    })],
  ];
  for (const [name, operation, exchangeError] of cases) {
    await t.test(name, async () => {
      const prepared = operation === "bootstrap" ? bootstrapPrepared() : refreshPrepared();
      const state = {
        pending: prepared.fence,
        networkCalls: 0,
        applyCalls: 0,
        clearCalls: 0,
        signal: null,
      };
      const authority = {
        prepareBootstrap() { return prepared; },
        prepareRefresh() { return prepared; },
        applyBootstrapResponse() { state.applyCalls += 1; state.pending = null; },
        applyRefreshResponse() { state.applyCalls += 1; state.pending = null; },
        clearPending() { state.clearCalls += 1; state.pending = null; },
      };
      const httpsAdapter = {
        bootstrap(_input, signal) {
          state.networkCalls += 1;
          state.signal = signal;
          return Promise.reject(exchangeError);
        },
        refresh(_input, signal) {
          state.networkCalls += 1;
          state.signal = signal;
          return Promise.reject(exchangeError);
        },
      };
      const signal = new AbortController().signal;

      await assert.rejects(
        coordinator(authority, httpsAdapter)[operation](
          operation === "bootstrap" ? BOOTSTRAP_INPUT : REFRESH_INPUT,
          signal,
        ),
        (error) => error === exchangeError,
      );
      assert.equal(state.networkCalls, 1);
      assert.equal(state.applyCalls, 0);
      assert.equal(state.clearCalls, 0);
      assert.strictEqual(state.signal, signal);
      assert.strictEqual(state.pending, prepared.fence);
    });
  }
});

test("apply failures are attempted once and leave the authority-owned pending state untouched", async (t) => {
  for (const applyError of [
    Object.assign(new Error("commit uncertain"), {
      code: "RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN",
    }),
    Object.assign(new Error("response rejected"), {
      code: "RELAY_V2_HOST_CREDENTIAL_STATE_INVALID",
    }),
  ]) {
    await t.test(applyError.code, async () => {
      const prepared = refreshPrepared();
      const response = refreshResponse();
      const state = {
        pending: prepared.fence,
        networkCalls: 0,
        applyCalls: 0,
        clearCalls: 0,
        fence: null,
        response: null,
      };
      const authority = {
        prepareRefresh() { return prepared; },
        applyRefreshResponse(fence, value) {
          state.applyCalls += 1;
          state.fence = fence;
          state.response = value;
          throw applyError;
        },
        clearPending() { state.clearCalls += 1; state.pending = null; },
      };
      const httpsAdapter = {
        async refresh() { state.networkCalls += 1; return response; },
      };

      await assert.rejects(
        coordinator(authority, httpsAdapter).refresh(
          REFRESH_INPUT,
          new AbortController().signal,
        ),
        (error) => error === applyError,
      );
      assert.equal(state.networkCalls, 1);
      assert.equal(state.applyCalls, 1);
      assert.equal(state.clearCalls, 0);
      assert.strictEqual(state.fence, prepared.fence);
      assert.strictEqual(state.response, response);
      assert.strictEqual(state.pending, prepared.fence);
    });
  }
});

test("concurrent late responses return the authority's exact winner and stale decisions", async () => {
  const prepared = refreshPrepared();
  const firstExchange = deferred();
  const secondExchange = deferred();
  const exchanges = [firstExchange, secondExchange];
  const responses = [refreshResponse("late"), refreshResponse("winner")];
  const applied = { status: "applied", credentialVersion: "8" };
  const stale = { status: "stale", credentialVersion: "8" };
  const state = {
    applyCalls: 0,
    networkCalls: 0,
    winnerSettled: false,
    appliedArguments: [],
  };
  const authority = {
    prepareRefresh() { return prepared; },
    applyRefreshResponse(fence, response) {
      state.applyCalls += 1;
      state.appliedArguments.push([fence, response]);
      if (!state.winnerSettled) {
        state.winnerSettled = true;
        return applied;
      }
      return stale;
    },
  };
  const httpsAdapter = {
    refresh() {
      const exchange = exchanges[state.networkCalls];
      state.networkCalls += 1;
      return exchange.promise;
    },
  };
  const owner = coordinator(authority, httpsAdapter);

  const lateOperation = owner.refresh(REFRESH_INPUT, new AbortController().signal);
  const winnerOperation = owner.refresh(REFRESH_INPUT, new AbortController().signal);
  assert.equal(state.networkCalls, 2);

  secondExchange.resolve(responses[1]);
  assert.strictEqual(await winnerOperation, applied);
  firstExchange.resolve(responses[0]);
  assert.strictEqual(await lateOperation, stale);

  assert.equal(state.applyCalls, 2);
  assert.deepEqual(state.appliedArguments, [
    [prepared.fence, responses[1]],
    [prepared.fence, responses[0]],
  ]);
});
