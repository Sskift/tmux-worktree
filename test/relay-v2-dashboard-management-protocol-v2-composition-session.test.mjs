import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  createRelayV2DashboardManagementProtocolV2CompositionSession,
} from "../dist/relay/v2/relayV2DashboardManagementProtocolV2CompositionSession.js";
import {
  RelayV2DashboardManagementCompositionClosedError,
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

const cases = JSON.parse(readFileSync(new URL(
  "../contracts/dashboard-relay-v2-management/v2/cases.json",
  import.meta.url,
), "utf8"));
const NOW_MS = 1_783_700_000_000;
const IDENTITY = Object.freeze({
  hostId: "mac-admin",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
  credentialReference: "relay-v2-host-credential-ref:primary",
});
const BOOTSTRAP_SECRET_REFERENCE = "bootstrap-secret-reference-one";
const REFRESH_SECRET_REFERENCE = "refresh-secret-reference-one";
const BOOTSTRAP_TOKEN = "twhostboot2.composition-session-bootstrap-secret";
const REFRESH_TOKEN = "twref2.composition-session-refresh-secret";
const SECRET_MARKER = "twref2.composition-session-private-failure";
const START_FRAME = cases.goldenExchanges.find(
  ({ operation }) => operation === "start_connector",
).requestFrame;
const STATUS_FRAME = cases.goldenExchanges.find(
  ({ operation }) => operation === "status",
).requestFrame;
const REFRESH_FRAME = cases.goldenExchanges.find(
  ({ operation }) => operation === "refresh_host",
).requestFrame;

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

function wire(frame) {
  return encodeRelayV2WebSocketFrame("carrier", frame);
}

function decoded(frames) {
  return frames.map((frame) => decodeRelayV2WebSocketFrame("carrier", frame).frame);
}

class ControlledInput {
  queue = [];
  waiters = [];
  ended = false;

  push(bytes) {
    assert.equal(this.ended, false);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: Uint8Array.from(bytes) });
    else this.queue.push(Uint8Array.from(bytes));
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    const value = this.queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return() {
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }
}

class InMemoryCredentialStorage {
  state = null;
  revision = 0;
  revisions = new WeakMap();

  runExclusive(_reference, operation) {
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
    kid: "composition-session-key-one",
    secretBase64url: Buffer.alloc(32, 0x64).toString("base64url"),
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
  const credentialAuthority = new RelayV2HostCredentialAuthority({
    storage,
    secretResolver: {
      resolve(reference) {
        if (reference === BOOTSTRAP_SECRET_REFERENCE) return BOOTSTRAP_TOKEN;
        if (reference === REFRESH_SECRET_REFERENCE) return REFRESH_TOKEN;
        throw new Error(SECRET_MARKER);
      },
    },
  });
  const credentialExchangeCoordinator = new RelayV2HostCredentialExchangeCoordinator({
    authority: credentialAuthority,
    httpsAdapter: {
      async bootstrap(input) {
        return bootstrapResponse(input, issueToken(input.hostId));
      },
      async refresh() {
        if (options.refreshFailure) throw new Error(SECRET_MARKER);
        throw new Error("refresh is outside this test");
      },
    },
  });

  let statusSink = null;
  const hostCarrierActor = new RelayV2HostCarrierActor({
    ...IDENTITY,
    credentialReferences: credentialAuthority,
    advertisedCapabilities: [],
    idFactory: () => "host-hello-composition-session-one",
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
  const attempts = [];
  const connectorController = new RelayV2HostConnectorController({
    ...IDENTITY,
    attempts: Object.freeze({
      startAttempt(input) {
        statusSink = input.onCarrierStatus;
        const transport = new FakeTransport();
        const connection = hostCarrierActor.connect(transport, input.credentialReference);
        const attempt = { input, transport, connection, drainCalls: [] };
        attempts.push(attempt);
        return Object.freeze({
          async disposeAndDrain(drainInput) {
            attempt.drainCalls.push(structuredClone(drainInput));
            if (options.drainFailure) throw new Error(SECRET_MARKER);
            hostCarrierActor.dispose();
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
    }),
  });
  const abortController = new AbortController();
  const input = new ControlledInput();
  const writes = [];
  let writeCalls = 0;
  const io = {
    input,
    async writeFrame(frame) {
      writeCalls += 1;
      if (options.failWriteCall === writeCalls) throw new Error(SECRET_MARKER);
      writes.push(frame);
    },
  };
  const clock = () => NOW_MS;
  const sessionOptions = {
    credentialAuthority,
    credentialExchangeCoordinator,
    connectorController,
    hostCarrierActor,
    ...IDENTITY,
    bootstrapSecretReference: BOOTSTRAP_SECRET_REFERENCE,
    refreshSecretReference: REFRESH_SECRET_REFERENCE,
    signal: abortController.signal,
    clock,
    runtimeVersion: cases.constants.runtimeVersion,
    io,
  };

  function installReady() {
    const prepared = credentialAuthority.prepareBootstrap({
      credentialReference: IDENTITY.credentialReference,
      hostId: IDENTITY.hostId,
      attemptId: "installed-bootstrap-attempt",
      oldSecretReference: BOOTSTRAP_SECRET_REFERENCE,
    });
    const access = issueToken(IDENTITY.hostId);
    assert.deepEqual(credentialAuthority.applyBootstrapResponse(
      prepared.fence,
      bootstrapResponse({
        bootstrapAttemptId: prepared.fence.attemptId,
        hostId: IDENTITY.hostId,
      }, access),
    ), { status: "applied", credentialVersion: "1" });
  }
  if (options.ready) installReady();
  const session = options.create === false
    ? null
    : createRelayV2DashboardManagementProtocolV2CompositionSession(sessionOptions);
  return {
    abortController,
    attempts,
    connectorController,
    credentialAuthority,
    hostCarrierActor,
    input,
    io,
    session,
    sessionOptions,
    writes,
  };
}

async function registerAttempt(h, connectorId = "connector-composition-session-one") {
  await waitFor(() => h.attempts.length === 1, "connector attempt was not created");
  const attempt = h.attempts[0];
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
  return attempt;
}

function parsedWrites(h) {
  return h.writes.map((frame) => JSON.parse(frame));
}

function compositionOptionsOf(sessionOptions) {
  const { runtimeVersion: _runtimeVersion, io: _io, ...compositionOptions } = sessionOptions;
  return compositionOptions;
}

test("the real dist session constructs the canonical composition before v2 ready and exposes only run/close", async () => {
  const h = harness();
  assert.deepEqual(h.writes, [], "construction alone cannot emit ready");
  assert.deepEqual(Reflect.ownKeys(h.session).sort(), ["closeAndDrain", "run"]);
  assert.deepEqual(Object.keys(Object.getOwnPropertyDescriptors(h.session)).sort(), [
    "closeAndDrain", "run",
  ]);
  for (const key of [
    "composition", "handler", "io", "credential", "controller", "actor", "adapter",
    "secret", "signal", "input", "writeFrame", "toJSON",
  ]) assert.equal(Reflect.get(h.session, key), undefined);
  assert.strictEqual(
    createRelayV2DashboardManagementProtocolV2CompositionSession(h.sessionOptions),
    h.session,
  );
  assert.throws(
    () => createRelayV2DashboardManagementComposition(
      compositionOptionsOf(h.sessionOptions),
    ),
    RelayV2DashboardManagementCompositionClosedError,
    "the public factory cannot reacquire a session-claimed request handle",
  );
  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession({
      ...h.sessionOptions,
      io: { input: h.input, writeFrame: h.io.writeFrame },
    }),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
    "the exact owner set cannot be rebound to replacement IO",
  );

  h.input.push(Buffer.from(STATUS_FRAME));
  h.input.end();
  assert.equal(await h.session.run(), 0);
  const frames = parsedWrites(h);
  assert.deepEqual(frames[0], JSON.parse(cases.startupReadyFrame));
  assert.equal(frames[1].protocolVersion, 2);
  assert.equal(frames[1].requestId, "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw");
  assert.deepEqual(frames[1].result.connector, { status: "stopped" });
  assert.equal(await h.session.run(), 1, "run is permanently one-shot");
  assert.equal(h.writes.length, 2, "a repeated run cannot emit another ready frame");
});

test("an existing used and closed composition cannot be rebound into a stdio session", async () => {
  const h = harness({ create: false, ready: true });
  const composition = createRelayV2DashboardManagementComposition(
    compositionOptionsOf(h.sessionOptions),
  );
  const status = await composition.handleRequest(JSON.parse(STATUS_FRAME));
  assert.equal(status.result.connector.status, "stopped");
  await composition.closeAndDrain();

  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession(h.sessionOptions),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  );
  assert.deepEqual(h.writes, [], "a rejected rebind cannot emit v2 ready");
});

test("AbortSignal Proxy and override surfaces close before activation without live lookup", async (t) => {
  await t.test("own accessor", async () => {
    const h = harness({ create: false });
    let accessorCalls = 0;
    Object.defineProperty(h.abortController.signal, "removeEventListener", {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error(SECRET_MARKER);
      },
    });
    assert.throws(
      () => createRelayV2DashboardManagementProtocolV2CompositionSession(h.sessionOptions),
      (error) => error instanceof
          RelayV2DashboardManagementProtocolV2CompositionSessionClosedError
        && !error.message.includes(SECRET_MARKER)
        && !String(error.stack).includes(SECRET_MARKER),
    );
    assert.equal(accessorCalls, 0);

    delete h.abortController.signal.removeEventListener;
    const session = createRelayV2DashboardManagementProtocolV2CompositionSession(
      h.sessionOptions,
    );
    Object.defineProperty(h.abortController.signal, "removeEventListener", {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error(SECRET_MARKER);
      },
    });
    h.input.end();
    assert.equal(await session.run(), 0);
    assert.equal(accessorCalls, 0, "fixed cleanup cannot read the late accessor");
  });

  await t.test("Proxy", async () => {
    const h = harness({ create: false });
    let getCalls = 0;
    const proxySignal = new Proxy(h.abortController.signal, {
      get() {
        getCalls += 1;
        throw new Error(SECRET_MARKER);
      },
    });
    assert.throws(
      () => createRelayV2DashboardManagementProtocolV2CompositionSession({
        ...h.sessionOptions,
        signal: proxySignal,
      }),
      RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
    );
    assert.equal(getCalls, 0, "native brand validation cannot enter the Proxy get trap");

    const session = createRelayV2DashboardManagementProtocolV2CompositionSession(
      h.sessionOptions,
    );
    await session.closeAndDrain();
  });

});

test("foreign/stale owners and structural composition/handler injection fail before ready", async () => {
  const h = harness({ create: false, ready: true });
  let accessorCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, Symbol.asyncIterator, {
    get() {
      accessorCalls += 1;
      return () => accessorInput;
    },
  });
  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession({
      ...h.sessionOptions,
      io: { input: accessorInput, writeFrame: h.io.writeFrame },
    }),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  );
  assert.equal(accessorCalls, 0, "method admission must not invoke accessors");

  let descriptorTrapCalls = 0;
  let prototypeTrapCalls = 0;
  const proxyInput = new Proxy(h.input, {
    getOwnPropertyDescriptor() {
      descriptorTrapCalls += 1;
      throw new Error(SECRET_MARKER);
    },
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error(SECRET_MARKER);
    },
  });
  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession({
      ...h.sessionOptions,
      io: { input: proxyInput, writeFrame: h.io.writeFrame },
    }),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  );
  assert.deepEqual(
    [descriptorTrapCalls, prototypeTrapCalls],
    [0, 0],
    "Proxy method admission cannot enter descriptor or prototype traps",
  );

  const foreignActor = new RelayV2HostCarrierActor({
    hostId: "foreign-host",
    hostEpoch: IDENTITY.hostEpoch,
    hostInstanceId: IDENTITY.hostInstanceId,
    credentialReferences: h.credentialAuthority,
    routeSink: { onRouteBound() {}, onClientFrame() {}, onRouteUnbound() {} },
  });
  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession({
      ...h.sessionOptions,
      hostCarrierActor: foreignActor,
    }),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  );
  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession({
      ...h.sessionOptions,
      composition: {},
      handler: { handle() {} },
    }),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  );

  const staleStart = h.connectorController.start({
    requestId: "stale-session-owner-start",
    ...IDENTITY,
    signal: h.abortController.signal,
  });
  await registerAttempt(h, "stale-session-owner-connector");
  await staleStart;
  assert.throws(
    () => createRelayV2DashboardManagementProtocolV2CompositionSession(h.sessionOptions),
    RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
  );
  assert.deepEqual(h.writes, []);

  const cut = h.connectorController.inspectCut();
  await h.connectorController.stopAndDrain({
    requestId: "stale-session-owner-cleanup",
    controllerGeneration: cut.controllerGeneration,
    connectorId: cut.connectorId,
    ...IDENTITY,
    signal: h.abortController.signal,
  });
});

test("EOF, bad-frame 64, and ordinary write failure all exactly-once drain the active controller", async (t) => {
  const scenarios = [
    { name: "EOF", tail: "", expected: 0 },
    { name: "bad frame", tail: "{}\n", expected: 64 },
    { name: "write failure", tail: "", expected: 1, failWriteCall: 2 },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const h = harness({ ready: true, failWriteCall: scenario.failWriteCall });
      h.input.push(Buffer.from(`${START_FRAME}${scenario.tail}`));
      h.input.end();
      const running = h.session.run();
      const attempt = await registerAttempt(h);
      assert.equal(await running, scenario.expected);
      assert.equal(attempt.drainCalls.length, 1);
      assert.deepEqual(h.connectorController.inspectCut(), {
        status: "stopped",
        controllerGeneration: "1",
      });
      assert.equal(JSON.stringify(h.writes).includes(SECRET_MARKER), false);
    });
  }
});

test("ordinary handler failure is redacted, returns 1, and drains the registered controller", async () => {
  const h = harness({ ready: true, refreshFailure: true });
  h.input.push(Buffer.from(`${START_FRAME}${REFRESH_FRAME}`));
  h.input.end();
  const running = h.session.run();
  const attempt = await registerAttempt(h);
  assert.equal(await running, 1);
  assert.equal(attempt.drainCalls.length, 1);
  const serialized = JSON.stringify(h.writes);
  assert.equal(serialized.includes(SECRET_MARKER), false);
  assert.equal(serialized.includes(REFRESH_TOKEN), false);
  assert.equal(serialized.includes("twcap2."), false);
});

test("abort and explicit close fence new input and exactly-once drain an active session", async (t) => {
  await t.test("abort", async () => {
    const h = harness({ ready: true });
    let rawSignalLookups = 0;
    for (const key of ["aborted", "addEventListener", "removeEventListener"]) {
      Object.defineProperty(h.abortController.signal, key, {
        configurable: true,
        get() {
          rawSignalLookups += 1;
          throw new Error(SECRET_MARKER);
        },
      });
    }
    h.input.push(Buffer.from(START_FRAME));
    const running = h.session.run();
    const attempt = await registerAttempt(h);
    assert.notStrictEqual(attempt.input.signal, h.abortController.signal);
    await waitFor(() => h.writes.length === 2, "start response was not written");
    h.abortController.abort();
    assert.equal(attempt.input.signal.aborted, true, "external abort reaches the owner signal");
    assert.equal(await running, 1);
    assert.equal(attempt.drainCalls.length, 1);
    assert.equal(rawSignalLookups, 0);
    assert.equal(JSON.stringify(h.writes).includes(SECRET_MARKER), false);
  });

  await t.test("explicit close during a pending request", async () => {
    const h = harness({ ready: true });
    h.input.push(Buffer.from(START_FRAME));
    const running = h.session.run();
    await waitFor(() => h.attempts.length === 1, "pending start was not admitted");
    const attempt = h.attempts[0];
    const firstClose = h.session.closeAndDrain();
    const secondClose = h.session.closeAndDrain();
    assert.strictEqual(secondClose, firstClose);
    await nextTurn();
    assert.equal(attempt.drainCalls.length, 0, "admitted request must settle before drain");
    await registerAttempt(h);
    await Promise.all([firstClose, secondClose]);
    assert.equal(await running, 1);
    assert.equal(attempt.drainCalls.length, 1);
  });
});

test("a concurrent repeated run closes the first run without a second ready frame", async () => {
  const h = harness();
  const first = h.session.run();
  await waitFor(() => h.writes.length === 1, "ready was not written");
  const repeated = h.session.run();
  assert.equal(await repeated, 1);
  assert.equal(await first, 1);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(parsedWrites(h), [JSON.parse(cases.startupReadyFrame)]);
});

test("uncertain drain becomes only ordinary failure and a fixed closed error", async () => {
  const h = harness({ ready: true, drainFailure: true });
  h.input.push(Buffer.from(START_FRAME));
  h.input.end();
  const running = h.session.run();
  const attempt = await registerAttempt(h);
  assert.equal(await running, 1);
  assert.equal(attempt.drainCalls.length, 1);
  await assert.rejects(
    h.session.closeAndDrain(),
    (error) => error instanceof
        RelayV2DashboardManagementProtocolV2CompositionSessionClosedError
      && !error.message.includes(SECRET_MARKER)
      && !String(error.stack).includes(SECRET_MARKER),
  );
  assert.equal(JSON.stringify(h.writes).includes(SECRET_MARKER), false);
});
