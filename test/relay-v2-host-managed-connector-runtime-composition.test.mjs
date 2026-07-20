import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const credentialAuthorityModule = await import("../dist/relay/v2/hostCredentialAuthority.js");
const credentialExchangeModule = await import(
  "../dist/relay/v2/hostCredentialExchangeCoordinator.js"
);
const dashboardManagementSessionModule = await import(
  "../dist/relay/v2/relayV2DashboardManagementProtocolV2CompositionSession.js"
);
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const terminalDurable = await import("../dist/relay/v2/terminalDurableLineage.js");
const terminal = await import("../dist/relay/v2/terminalManager.js");

const HOST_ID = "mac-admin";
const CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:managed-primary";
const corpus = loadRelayV2FixtureCorpus();
const dashboardManagementContract = JSON.parse(readFileSync(new URL(
  "../contracts/dashboard-relay-v2-management/v2/cases.json",
  import.meta.url,
), "utf8"));
const dashboardManagementStartFrame = dashboardManagementContract.goldenExchanges.find(
  ({ operation }) => operation === "start_connector",
).requestFrame;
const dashboardManagementStatusFrame = dashboardManagementContract.goldenExchanges.find(
  ({ operation }) => operation === "status",
).requestFrame;

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function carrierWire(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function publicWire(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
}

function decodeCarrier(bytes) {
  return codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
}

function settle(turns = 8) {
  return Array.from({ length: turns }).reduce(
    (tail) => tail.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );
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
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
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

function readinessReady(snapshot) {
  return Object.values(snapshot.capabilities).every((ready) => ready === true);
}

class QueueDiscovery {
  scans = [];

  async scan() {
    const scan = this.scans.shift();
    if (!scan) throw new Error("unexpected managed composition discovery");
    return structuredClone(scan);
  }
}

class FakeTransport {
  bufferedBytes = 0;
  pending = [];
  sent = [];
  closes = [];

  trySend(bytes, deliveryToken) {
    const copy = Uint8Array.from(bytes);
    this.sent.push(copy);
    this.bufferedBytes += copy.byteLength;
    this.pending.push({ deliveryToken, byteLength: copy.byteLength });
    return true;
  }

  bufferedAmount() {
    return this.bufferedBytes;
  }

  confirmNext() {
    const delivery = this.pending.shift();
    assert.ok(delivery, "missing managed composition delivery");
    this.bufferedBytes -= delivery.byteLength;
    return delivery.deliveryToken;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

function completeScope() {
  return {
    backendIdentity: "local",
    displayName: "Local",
    kind: "local",
    reachability: "online",
    sessionsCompleteness: "complete",
    sessions: [],
    error: null,
  };
}

function registeredFrame(record, disposition = "connected") {
  const registered = fixture("host-registered");
  registered.requestId = record.hello.requestId;
  registered.connectorId = `managed-connector-${record.sequence}`;
  registered.payload.disposition = disposition;
  registered.payload.supersededHostInstanceId = disposition === "replaced"
    ? "previous-managed-host-instance"
    : null;
  return carrierWire(registered);
}

function supersededFrame(record) {
  const frame = fixture("host-superseded");
  frame.connectorId = `managed-connector-${record.sequence}`;
  frame.payload.hostId = HOST_ID;
  frame.payload.losingConnectorId = frame.connectorId;
  frame.payload.losingHostInstanceId = record.input.hostInstanceId;
  frame.payload.winningConnectorId = "managed-winning-connector";
  frame.payload.winningHostInstanceId = "managed-winning-host-instance";
  return carrierWire(frame);
}

function createTransportLifecycleFactory(options, records) {
  return Object.freeze({
    createTransportLifecycle(input) {
      const sequence = records.length + 1;
      const record = {
        sequence,
        input,
        transport: new FakeTransport(),
        connection: null,
        hello: null,
        drainGate: options.manualDrain ? deferred() : null,
        drainCalls: 0,
        drainProofs: [],
        factoryGate: options.factoryGate?.(sequence) ?? null,
      };
      records.push(record);
      const lifecycle = () => Object.freeze({
        transport: record.transport,
        bindConnection(connection) {
          record.connection = connection;
          record.hello = decodeCarrier(record.transport.sent[0]);
          if (options.autoRegister !== false) {
            const disposition = options.registrationDisposition?.(sequence) ?? "connected";
            connection.receive(registeredFrame(record, disposition));
          }
          return options.bindReturn?.(sequence);
        },
        awaitDrained(proof) {
          record.drainCalls += 1;
          record.drainProofs.push(proof);
          if (record.drainGate !== null) {
            return record.drainGate.promise.then(() => proof);
          }
          return Promise.resolve(proof);
        },
      });
      if (options.factoryError) throw options.factoryError;
      return record.factoryGate === null
        ? lifecycle()
        : record.factoryGate.promise.then(lifecycle);
    },
  });
}

function hostAccessToken({ hostId = HOST_ID, jti = "managed-wss-access-jti" } = {}) {
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    iss: "managed-wss-issuer",
    aud: "tw-relay-ws",
    kid: "managed-wss-kid",
    tokenUse: "access",
    role: "host",
    hostId,
    principalId: "managed-wss-principal",
    grantId: "managed-wss-grant",
    iat: 1_783_700_000,
    nbf: 1_783_700_000,
    exp: 1_783_703_600,
    jti,
  })).toString("base64url");
  return `twcap2.${payload}.${Buffer.alloc(32, 7).toString("base64url")}`;
}

function createManagedWssCredentialAuthority() {
  const accessToken = hostAccessToken();
  let revision = 1;
  let state = {
    credentialVersion: "1",
    hostId: HOST_ID,
    principalId: "managed-wss-principal",
    grantId: "managed-wss-grant",
    accessToken,
    accessExpiresAtMs: 1_783_703_600_000,
    refreshToken: "twref2.managed-wss-refresh",
    refreshExpiresAtMs: 1_786_292_000_000,
    accessJti: "managed-wss-access-jti",
    pendingCredentialAttempt: null,
    pendingReauthentication: null,
  };
  const activity = {
    references: [],
    reads: 0,
    writes: 0,
    secretResolutions: 0,
  };
  const authority = new credentialAuthorityModule.RelayV2HostCredentialAuthority({
    storage: {
      runExclusive(reference, operation) {
        activity.references.push(reference);
        return operation({
          read() {
            activity.reads += 1;
            return { state: structuredClone(state), revision };
          },
          compareAndSwap(expected, replacement) {
            if (expected !== revision) {
              return {
                status: "conflict",
                current: { state: structuredClone(state), revision },
              };
            }
            state = structuredClone(replacement);
            revision += 1;
            activity.writes += 1;
            return { status: "swapped" };
          },
        });
      },
    },
    secretResolver: {
      resolve() {
        activity.secretResolutions += 1;
        throw new Error("managed WSS composition must not resolve refresh/bootstrap secrets");
      },
    },
  });
  return { authority, accessToken, activity };
}

function createManagedWssConstructor(records, effects) {
  return class FakeManagedWss {
    readyState = 1;
    protocol = "tw-relay.host.v2";
    extensions = "";
    listeners = new Map();

    constructor(address, protocols, options) {
      effects.socketConstructions += 1;
      const record = {
        sequence: records.length + 1,
        address,
        protocols: [...protocols],
        options,
        headers: [],
        requestEnds: 0,
        requestDestroys: 0,
        sent: [],
        closes: [],
        socket: this,
        hello: null,
      };
      records.push(record);
      const request = {
        setHeader(name, value) { record.headers.push([name, value]); },
        end() { record.requestEnds += 1; },
        destroy() { record.requestDestroys += 1; },
      };
      options.finishRequest(request, this);
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    removeListener(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    }

    send(bytes, options, callback) {
      const record = records.find((candidate) => candidate.socket === this);
      const copy = Uint8Array.from(bytes);
      record.sent.push({ bytes: copy, options });
      record.hello ??= decodeCarrier(copy);
      queueMicrotask(() => callback());
    }

    close(code, reason) {
      const record = records.find((candidate) => candidate.socket === this);
      record.closes.push({ code, reason });
      this.readyState = 3;
      for (const listener of this.listeners.get("close") ?? []) listener(code);
    }

    terminate() {
      this.readyState = 3;
      for (const listener of this.listeners.get("close") ?? []) listener(1006);
    }

    receive(bytes) {
      for (const listener of this.listeners.get("message") ?? []) listener(bytes, true);
    }
  };
}

async function createHarness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-managed-runtime-"));
  const store = await hostState.RelayV2HostStateStore.open({
    paths: hostState.relayV2HostStatePaths(home),
  });
  const discovery = new QueueDiscovery();
  const foundation = new resourceState.RelayV2MaterializedStateFoundation({
    hostId: HOST_ID,
    discovery,
    store,
    readinessSink: { apply: () => true },
  });
  discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
  const seeded = await foundation.reconcile();
  const spoolRoot = join(home, "snapshot-spool");
  const publisherSpool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  await publisherSpool.get({
    principalId: "managed-runtime-readiness-principal",
    clientInstanceId: "managed-composition-client",
    expectedHostEpoch: seeded.snapshot.hostEpoch,
    snapshotRequestId: "managed-runtime-readiness",
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  await publisherSpool.close();
  const spool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
  });
  const h2RecoveryCandidate = await spool.issueRecoveredHostH2Candidate();
  assert.notEqual(h2RecoveryCandidate, null);

  const identity = {
    hostEpoch: seeded.snapshot.hostEpoch,
    hostInstanceId: store.hostInstanceId,
  };
  let expectedWelcome = null;
  let composition = null;
  const lineage = new terminalDurable.RelayV2TerminalDurableLineageAuthority({ store });
  const terminalManager = new terminal.RelayV2TerminalManager({
    hostId: HOST_ID,
    hostEpoch: identity.hostEpoch,
    hostInstanceId: identity.hostInstanceId,
    resolver: { async resolve() { throw new Error("unexpected terminal resolve"); } },
    lineage,
    backend: { async open() { throw new Error("unexpected terminal backend open"); } },
    terminalControl: {},
    async send(route, frame, responseLineage) {
      await composition.sendTerminalFrame(route, frame, responseLineage);
    },
  });
  const h3RecoveryCandidate = await lineage.recoverForHostH3(terminalManager);
  const h1RecoveryCandidate = await commandPlane.RelayV2HostCommandPlane
    .openRecoveredAuthority({
      store,
      hostId: HOST_ID,
      now: () => 1_783_700_000_000,
      executor: {
        async resolve() { throw new Error("unexpected managed command resolution"); },
        fenceResolution() { return undefined; },
        async executeTwRpc() { throw new Error("unexpected managed TW RPC execution"); },
        async executeTerminalControl() {
          throw new Error("unexpected managed terminal-control execution");
        },
      },
    });
  assert.notEqual(h1RecoveryCandidate, null);

  const records = [];
  const transportLifecycleFactory = options.managedWss
    ? null
    : createTransportLifecycleFactory(options, records);
  const managedWssCredential = options.managedWss
    ? createManagedWssCredentialAuthority()
    : null;
  const managedWssEffects = {
    socketConstructions: 0,
    timerSchedules: 0,
  };
  const managedWssConstructor = options.managedWss
    ? createManagedWssConstructor(records, managedWssEffects)
    : null;
  let helloSequence = 0;
  let credentialReadCount = 0;
  const reauthenticationPreparations = [];
  const reauthenticationAcknowledgements = [];
  const runtimeOptions = {
    hostId: HOST_ID,
    hostEpoch: identity.hostEpoch,
    hostInstanceId: identity.hostInstanceId,
    authorities: {
      h0: store.h0ReadinessPort,
      h1RecoveryCandidate,
      h2RecoveryCandidate,
      h3RecoveryCandidate,
      nextDedupeWindowBounds() {
        return {
          acceptUntilMs: 1_783_786_400_000,
          queryUntilMs: 1_784_391_200_000,
        };
      },
    },
    welcome: {
      build(input) {
        const welcome = fixture("host-welcome-snapshot-required");
        welcome.requestId = input.hello.requestId;
        welcome.hostId = HOST_ID;
        welcome.hostEpoch = input.cut.hostEpoch;
        welcome.hostInstanceId = input.cut.hostInstanceId;
        welcome.payload.eventSeq = input.cut.eventSeq;
        welcome.payload.capabilities = [...input.capabilities];
        welcome.payload.commandDedupeWindow = structuredClone(input.commandDedupeWindow);
        expectedWelcome = structuredClone(welcome);
        return welcome;
      },
    },
  };
  const carrierOptions = {
    idFactory: () => `managed-host-hello-${++helloSequence}`,
    clock: () => 1_783_700_100_000,
  };
  composition = options.managedWss
    ? await compositionModule.openRelayV2HostManagedWssConnectorRuntimeComposition({
      runtime: runtimeOptions,
      connector: {
        credentialAuthority: managedWssCredential.authority,
        credentialReference: CREDENTIAL_REFERENCE,
        carrier: carrierOptions,
        wss: {
          relayUrl: "wss://relay.example.com/",
          webSocketConstructor: managedWssConstructor,
          scheduleCloseDrain() {
            managedWssEffects.timerSchedules += 1;
            return () => undefined;
          },
        },
      },
    })
    : await compositionModule.openRelayV2HostManagedConnectorRuntimeComposition({
      runtime: runtimeOptions,
      connector: {
        credentialReference: CREDENTIAL_REFERENCE,
        carrier: {
          credentialReferences: {
            read(reference) {
              credentialReadCount += 1;
              if (options.rejectCredentialRead?.(credentialReadCount) === true) {
                throw new Error("injected credential read rejection");
              }
              return {
                reference,
                version: "1",
                grantId: "managed-host-grant",
                accessJti: "managed-host-access-jti",
                accessToken: "twcap2.host.payload.mac",
              };
            },
            prepareReauthentication(input) {
              reauthenticationPreparations.push(structuredClone(input));
              const prepared = {
                fence: {
                  reference: CREDENTIAL_REFERENCE,
                  version: "2",
                  requestId: "managed-reauth-authority-winner",
                  grantId: "managed-host-grant",
                  accessJti: "managed-host-access-jti-2",
                },
                accessToken: "twcap2.managed-reauth.payload.mac",
              };
              return options.prepareReauthentication?.(input, prepared) ?? prepared;
            },
            acknowledgeReauthentication(fence) {
              reauthenticationAcknowledgements.push(structuredClone(fence));
              return true;
            },
          },
          ...carrierOptions,
        },
        transportLifecycleFactory,
      },
    });

  assert.equal(await composition.readiness.h0.activate(), true);
  assert.equal(composition.readiness.h3.activate(), true);

  return {
    home,
    spool,
    store,
    composition,
    identity,
    records,
    expectedWelcome: () => expectedWelcome,
    credentialActivity: () => ({
      reads: credentialReadCount,
      preparations: reauthenticationPreparations.length,
      acknowledgements: reauthenticationAcknowledgements.length,
    }),
    reauthenticationPreparations,
    reauthenticationAcknowledgements,
    managedWssCredential,
    managedWssEffects,
    async cleanup() {
      for (const record of records) record.factoryGate?.resolve();
      for (const record of records) record.drainGate?.resolve();
      await composition.closeAndDrain().catch(() => undefined);
      store.close();
      await spool.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function startInput(requestId) {
  return { requestId, signal: new AbortController().signal };
}

async function startRegistered(harness, requestId = "managed.start") {
  const result = await harness.composition.start(startInput(requestId));
  const record = harness.records.at(-1);
  assert.notEqual(record, undefined);
  assert.notEqual(record.connection, null);
  return { result, record };
}

async function startManagedWssRegistered(harness, requestId = "managed.wss.start") {
  const pending = harness.composition.start(startInput(requestId));
  await settle();
  const record = harness.records.at(-1);
  assert.notEqual(record, undefined);
  assert.notEqual(record.hello, null);
  record.socket.receive(registeredFrame(record));
  return { result: await pending, record };
}

async function registerPendingManagedWss(harness) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = harness.records.at(-1);
    if (record?.hello) {
      record.socket.receive(registeredFrame(record));
      return record;
    }
    await settle(1);
  }
  assert.fail("Dashboard management did not reach the managed WSS registration cut");
}

function createDashboardManagementOwner(harness, overrides = {}) {
  const exchanges = { bootstrap: 0, refresh: 0 };
  const credentialExchangeCoordinator =
    new credentialExchangeModule.RelayV2HostCredentialExchangeCoordinator({
      authority: harness.managedWssCredential.authority,
      httpsAdapter: {
        async bootstrap() {
          exchanges.bootstrap += 1;
          throw new Error("unexpected Dashboard management bootstrap exchange");
        },
        async refresh() {
          exchanges.refresh += 1;
          throw new Error("unexpected Dashboard management refresh exchange");
        },
      },
    });
  const input = new ControlledInput();
  const writes = [];
  const abortController = new AbortController();
  const io = {
    input,
    async writeFrame(frame) {
      writes.push(frame);
    },
  };
  const options = {
    credentialAuthority: harness.managedWssCredential.authority,
    credentialExchangeCoordinator,
    hostManagementPort: harness.composition.dashboardManagementPort,
    hostId: HOST_ID,
    hostEpoch: harness.identity.hostEpoch,
    hostInstanceId: harness.identity.hostInstanceId,
    credentialReference: CREDENTIAL_REFERENCE,
    bootstrapSecretReference: "managed-dashboard-bootstrap-secret",
    refreshSecretReference: "managed-dashboard-refresh-secret",
    signal: abortController.signal,
    clock: () => 1_783_700_100_000,
    runtimeVersion: dashboardManagementContract.constants.runtimeVersion,
    io,
    ...overrides,
  };
  return {
    abortController,
    exchanges,
    input,
    io,
    options,
    writes,
  };
}

function dashboardManagementEffects(harness, owner) {
  return structuredClone({
    credential: harness.managedWssCredential.activity,
    exchanges: owner.exchanges,
    managedWss: harness.managedWssEffects,
    records: harness.records.length,
    writes: owner.writes.length,
  });
}

function dashboardManagementIdentity(harness) {
  return {
    hostId: HOST_ID,
    hostEpoch: harness.identity.hostEpoch,
    hostInstanceId: harness.identity.hostInstanceId,
    credentialReference: CREDENTIAL_REFERENCE,
  };
}

function stopInput(cut, requestId = "managed.stop") {
  return {
    requestId,
    controllerGeneration: cut.controllerGeneration,
    connectorId: cut.connectorId,
    signal: new AbortController().signal,
  };
}

function reauthenticationInput(cut, requestId = "managed.reauthenticate") {
  return {
    requestId,
    controllerGeneration: cut.controllerGeneration,
    connectorId: cut.connectorId,
  };
}

function assertReauthenticationRejectedWithoutTouch(harness, input) {
  const activity = harness.credentialActivity();
  const sentCounts = harness.records.map((record) => record.transport.sent.length);
  assert.equal(harness.composition.requestReauthentication(input), false);
  assert.deepEqual(harness.credentialActivity(), activity);
  assert.deepEqual(
    harness.records.map((record) => record.transport.sent.length),
    sentCounts,
  );
}

function acknowledgeAll(record) {
  while (record.transport.pending.length > 0) {
    record.connection.acknowledge(record.transport.confirmNext());
  }
}

function openRoute(record, suffix = "shared") {
  const route = fixture("route-open");
  route.connectorId = record.hello.connectorId ?? `managed-connector-${record.sequence}`;
  route.routeId = `managed-route-${suffix}`;
  route.routeFence = `managed-fence-${suffix}`;
  route.payload.connectionId = `managed-connection-${suffix}`;
  route.payload.authContext.hostId = HOST_ID;
  route.payload.authContext.principalId = "managed-runtime-principal";
  route.payload.authContext.clientInstanceId = "managed-composition-client";
  record.connection.receive(carrierWire(route));
  assert.equal(decodeCarrier(record.transport.sent.at(-1)).type, "route.opened");
  acknowledgeAll(record);
  return { record, route, nextClientSequence: 0 };
}

function sendClientFrame(activeRoute, frame) {
  activeRoute.nextClientSequence += 1;
  activeRoute.record.connection.receive(carrierWire({
    carrierVersion: 1,
    type: "route.data",
    connectorId: activeRoute.route.connectorId,
    routeId: activeRoute.route.routeId,
    routeFence: activeRoute.route.routeFence,
    direction: "client_to_host",
    seq: String(activeRoute.nextClientSequence),
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(publicWire(frame)).toString("base64"),
    },
  }));
}

function hostDataFrames(record) {
  return record.transport.sent
    .map(decodeCarrier)
    .filter((frame) => frame.type === "route.data")
    .map((frame) => codec.decodeRelayV2WebSocketFrame(
      "public",
      Uint8Array.from(Buffer.from(frame.payload.data, "base64")),
    ).frame);
}

test("managed WSS composition keeps construction inert and binds one credential owner cut", async (t) => {
  await t.test("construction and close before start", async () => {
    const h = await createHarness({ managedWss: true });
    try {
      assert.deepEqual(h.composition.inspect(), {
        status: "stopped",
        controllerGeneration: "0",
      });
      assert.deepEqual(h.managedWssEffects, {
        socketConstructions: 0,
        timerSchedules: 0,
      });
      assert.deepEqual(h.managedWssCredential.activity, {
        references: [],
        reads: 0,
        writes: 0,
        secretResolutions: 0,
      });
      for (const forbidden of [
        "credentialAuthority", "credentialReference", "credentialReferences",
        "transportLifecycleFactory", "webSocketConstructor", "accessToken", "token",
        "actor", "transport", "fallback",
      ]) assert.equal(h.composition[forbidden], undefined);

      await h.composition.closeAndDrain();
      assert.deepEqual(h.managedWssEffects, {
        socketConstructions: 0,
        timerSchedules: 0,
      });
      assert.deepEqual(h.managedWssCredential.activity, {
        references: [],
        reads: 0,
        writes: 0,
        secretResolutions: 0,
      });
    } finally {
      await h.cleanup();
    }
  });

  await t.test("start, registration, and explicit reauthentication", async () => {
    const h = await createHarness({ managedWss: true });
    try {
      const { result, record } = await startManagedWssRegistered(h);
      assert.equal(record.address, "wss://relay.example.com/host");
      assert.deepEqual(record.protocols, ["tw-relay.host.v2"]);
      assert.deepEqual(record.headers, [[
        "Authorization",
        `Bearer ${h.managedWssCredential.accessToken}`,
      ]]);
      assert.equal(record.requestEnds, 1);
      assert.equal(record.requestDestroys, 0);
      assert.deepEqual(record.hello.payload.capabilities, []);
      assert.deepEqual(record.hello.payload.clientDialects, ["tw-relay.v2"]);
      assert.deepEqual(h.composition.inspect(), {
        status: "registered_incomplete",
        controllerGeneration: result.controllerGeneration,
        connectorId: result.connectorId,
        acknowledgement: "host.registered",
        negotiatedCapabilityIntersection: [],
      });
      assert.equal(h.managedWssCredential.activity.secretResolutions, 0);
      assert.equal(
        h.managedWssCredential.activity.references.every(
          (reference) => reference === CREDENTIAL_REFERENCE,
        ),
        true,
      );

      assert.equal(h.composition.requestReauthentication(
        reauthenticationInput(h.composition.inspect(), "managed.wss.reauthenticate"),
      ), true);
      const frames = record.sent.map(({ bytes }) => decodeCarrier(bytes));
      const reauthentication = frames.find((frame) => frame.type === "host.reauthenticate");
      assert.notEqual(reauthentication, undefined);
      assert.equal(reauthentication.payload.accessToken, h.managedWssCredential.accessToken);
      assert.equal(h.managedWssCredential.activity.writes, 1);
      assert.equal(h.managedWssCredential.activity.secretResolutions, 0);
      assert.equal(
        h.managedWssCredential.activity.references.every(
          (reference) => reference === CREDENTIAL_REFERENCE,
        ),
        true,
      );
    } finally {
      await h.cleanup();
    }
  });
});

test("exact current Dashboard management port is claimed once through the protocol-v2 session", async () => {
  const h = await createHarness({ managedWss: true });
  try {
    const owner = createDashboardManagementOwner(h);
    const beforeConstruction = dashboardManagementEffects(h, owner);
    const session = dashboardManagementSessionModule
      .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);

    assert.deepEqual(dashboardManagementEffects(h, owner), beforeConstruction);
    assert.equal(typeof session.run, "function");
    assert.equal(typeof session.closeAndDrain, "function");
    assert.strictEqual(
      dashboardManagementSessionModule
        .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options),
      session,
    );
    assert.equal(compositionModule.claimRelayV2HostDashboardManagementPort(
      h.composition.dashboardManagementPort,
      dashboardManagementIdentity(h),
      h.managedWssCredential.authority,
    ), null, "the session's exact port claim is one-shot");
    for (const forbidden of [
      "actor", "controller", "credentialAuthority", "credentialExchangeCoordinator",
      "accessToken", "token", "credentialOwner", "binding", "composition",
    ]) {
      assert.equal(session[forbidden], undefined);
      assert.equal(h.composition.dashboardManagementPort[forbidden], undefined);
    }

    owner.input.push(Buffer.from(dashboardManagementStartFrame));
    owner.input.push(Buffer.from(dashboardManagementStatusFrame));
    owner.input.end();
    const run = session.run();
    const record = await registerPendingManagedWss(h);
    assert.equal(await run, 0);

    const responses = owner.writes.map((frame) => JSON.parse(frame));
    assert.deepEqual(
      responses[0],
      JSON.parse(dashboardManagementContract.startupReadyFrame),
    );
    const startRequestId = JSON.parse(dashboardManagementStartFrame).requestId;
    const statusRequestId = JSON.parse(dashboardManagementStatusFrame).requestId;
    const startResponse = responses.find(({ requestId }) => requestId === startRequestId);
    const statusResponse = responses.find(({ requestId }) => requestId === statusRequestId);
    assert.equal(startResponse.ok, true);
    assert.equal(statusResponse.ok, true);
    for (const response of [startResponse, statusResponse]) {
      assert.deepEqual(response.result.connector, {
        status: "registered_incomplete",
        acknowledgement: "host.registered",
        hostId: HOST_ID,
        connectorId: `managed-connector-${record.sequence}`,
        negotiatedCapabilityIntersection: [],
      });
    }
    assert.deepEqual(record.hello.payload.capabilities, []);
    assert.equal(
      record.sent.some(({ bytes }) => decodeCarrier(bytes).type === "host.reauthenticate"),
      false,
    );
    assert.deepEqual(owner.exchanges, { bootstrap: 0, refresh: 0 });
    assert.equal(h.managedWssCredential.activity.writes, 0);
    assert.equal(h.managedWssCredential.activity.secretResolutions, 0);
    assert.deepEqual(h.composition.inspect(), {
      status: "stopped",
      controllerGeneration: "1",
    });
    assert.equal(record.closes.length, 1);
    assert.equal(await session.run(), 1);
  } finally {
    await h.cleanup();
  }
});

test("foreign, copied, proxied, replayed, stale, and closed Dashboard ports reject without side effects", async () => {
  const scenarios = [
    {
      name: "foreign identity",
      async prepare(h) {
        const owner = createDashboardManagementOwner(h, { hostId: "foreign-mac-admin" });
        return { owner, attempt: () => dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options) };
      },
    },
    {
      name: "foreign credential owner",
      async prepare(h) {
        const foreignCredential = createManagedWssCredentialAuthority();
        const owner = createDashboardManagementOwner(h, {
          credentialAuthority: foreignCredential.authority,
        });
        return {
          owner,
          attempt: () => dashboardManagementSessionModule
            .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options),
          verify: () => assert.deepEqual(foreignCredential.activity, {
            references: [],
            reads: 0,
            writes: 0,
            secretResolutions: 0,
          }),
        };
      },
    },
    {
      name: "copied port",
      async prepare(h) {
        const owner = createDashboardManagementOwner(h, {
          hostManagementPort: { ...h.composition.dashboardManagementPort },
        });
        return { owner, attempt: () => dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options) };
      },
    },
    {
      name: "bound port",
      async prepare(h) {
        const port = h.composition.dashboardManagementPort;
        const owner = createDashboardManagementOwner(h, {
          hostManagementPort: port.bind(port),
        });
        return { owner, attempt: () => dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options) };
      },
    },
    {
      name: "bound binding",
      async prepare(h) {
        const identity = dashboardManagementIdentity(h);
        const binding = compositionModule.claimRelayV2HostDashboardManagementPort(
          h.composition.dashboardManagementPort,
          identity,
          h.managedWssCredential.authority,
        );
        assert.notEqual(binding, null);
        const owner = createDashboardManagementOwner(h);
        return {
          owner,
          expectNull: true,
          attempt: () => compositionModule.consumeRelayV2HostDashboardManagementBinding(
            binding.bind(binding),
            identity,
            h.managedWssCredential.authority,
          ),
          cleanup() {
            assert.equal(compositionModule.abortRelayV2HostDashboardManagementBinding(
              binding,
              identity,
              h.managedWssCredential.authority,
            ), true);
          },
        };
      },
    },
    {
      name: "proxied port",
      async prepare(h) {
        let traps = 0;
        const hostManagementPort = new Proxy(h.composition.dashboardManagementPort, {
          get() { traps += 1; },
          getOwnPropertyDescriptor() { traps += 1; },
          getPrototypeOf() { traps += 1; },
          ownKeys() { traps += 1; },
        });
        const owner = createDashboardManagementOwner(h, { hostManagementPort });
        return {
          owner,
          attempt: () => dashboardManagementSessionModule
            .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options),
          verify: () => assert.equal(traps, 0),
        };
      },
    },
    {
      name: "replayed port",
      async prepare(h) {
        const firstOwner = createDashboardManagementOwner(h);
        const firstSession = dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(firstOwner.options);
        const owner = createDashboardManagementOwner(h);
        return {
          owner,
          attempt: () => dashboardManagementSessionModule
            .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options),
          cleanup: () => firstSession.closeAndDrain(),
        };
      },
    },
    {
      name: "invalid secret activation rollback",
      async prepare(h) {
        const owner = createDashboardManagementOwner(h, {
          bootstrapSecretReference: "twref2.invalid-dashboard-secret-reference",
        });
        return {
          owner,
          attempt: () => dashboardManagementSessionModule
            .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options),
          async verify() {
            const aborted = new AbortController();
            aborted.abort();
            await assert.rejects(
              h.composition.start({
                requestId: "managed.port.rollback.public-start",
                signal: aborted.signal,
              }),
              (error) => error.name === "RelayV2HostConnectorControllerError"
                && error.code === "ABORTED",
            );
            assert.deepEqual(h.composition.inspect(), {
              status: "stopped",
              controllerGeneration: "0",
            });
            const retryOwner = createDashboardManagementOwner(h);
            const retrySession = dashboardManagementSessionModule
              .createRelayV2DashboardManagementProtocolV2CompositionSession(
                retryOwner.options,
              );
            assert.deepEqual(dashboardManagementEffects(h, retryOwner), {
              credential: {
                references: [],
                reads: 0,
                writes: 0,
                secretResolutions: 0,
              },
              exchanges: { bootstrap: 0, refresh: 0 },
              managedWss: { socketConstructions: 0, timerSchedules: 0 },
              records: 0,
              writes: 0,
            });
            await retrySession.closeAndDrain();
          },
        };
      },
    },
    {
      name: "stale port after stop",
      async prepare(h) {
        const registered = await startManagedWssRegistered(h, "managed.port.stale");
        await h.composition.stopAndDrain(stopInput(
          h.composition.inspect(),
          "managed.port.stale.stop",
        ));
        assert.equal(registered.record.closes.length, 1);
        const owner = createDashboardManagementOwner(h);
        return { owner, attempt: () => dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options) };
      },
    },
    {
      name: "closed port",
      async prepare(h) {
        const owner = createDashboardManagementOwner(h);
        await h.composition.closeAndDrain();
        return { owner, attempt: () => dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options) };
      },
    },
  ];

  for (const scenario of scenarios) {
    const h = await createHarness({ managedWss: true });
    let prepared = null;
    try {
      prepared = await scenario.prepare(h);
      const before = dashboardManagementEffects(h, prepared.owner);
      if (prepared.expectNull) {
        assert.equal(prepared.attempt(), null, scenario.name);
      } else {
        assert.throws(
          prepared.attempt,
          dashboardManagementSessionModule
            .RelayV2DashboardManagementProtocolV2CompositionSessionClosedError,
          scenario.name,
        );
      }
      assert.deepEqual(
        dashboardManagementEffects(h, prepared.owner),
        before,
        `${scenario.name} changed an external owner`,
      );
      await prepared.verify?.();
    } finally {
      try { await prepared?.cleanup?.(); } catch {}
      await h.cleanup();
    }
  }
});

test("managed WSS composition rejects malformed or foreign ownership input before side effects", async () => {
  const credential = createManagedWssCredentialAuthority();
  const effects = { socketConstructions: 0, timerSchedules: 0 };
  const records = [];
  const webSocketConstructor = createManagedWssConstructor(records, effects);
  const validConnector = {
    credentialAuthority: credential.authority,
    credentialReference: CREDENTIAL_REFERENCE,
    carrier: {},
    wss: { relayUrl: "wss://relay.example.com/", webSocketConstructor },
  };
  const inertRuntime = {
    hostId: HOST_ID,
    hostEpoch: "managed-wss-malformed-host-epoch",
    hostInstanceId: "managed-wss-malformed-host-instance",
    authorities: {},
    welcome: {},
  };
  const cases = [
    ["malformed runtime", { runtime: null, connector: validConnector }],
    ["foreign authority", {
      runtime: inertRuntime,
      connector: { ...validConnector, credentialAuthority: {} },
    }],
    ["unknown carrier key", {
      runtime: inertRuntime,
      connector: {
        ...validConnector,
        carrier: { accessToken: credential.accessToken },
      },
    }],
    ["second carrier owner", {
      runtime: inertRuntime,
      connector: {
        ...validConnector,
        carrier: { credentialReferences: credential.authority },
      },
    }],
    ["second WSS owner", {
      runtime: inertRuntime,
      connector: {
        ...validConnector,
        wss: {
          ...validConnector.wss,
          credentialAuthority: credential.authority,
        },
      },
    }],
  ];
  for (const [name, options] of cases) {
    await assert.rejects(
      compositionModule.openRelayV2HostManagedWssConnectorRuntimeComposition(options),
      (error) => {
        assert.equal(error.name, "RelayV2HostConnectorControllerError", name);
        assert.equal(error.code, "OPERATION_FAILED", name);
        return true;
      },
    );
  }
  assert.deepEqual(effects, { socketConstructions: 0, timerSchedules: 0 });
  assert.deepEqual(records, []);
  assert.deepEqual(credential.activity, {
    references: [],
    reads: 0,
    writes: 0,
    secretResolutions: 0,
  });
});

test("managed composition bridges the exact actor route and projects empty capability registration", async () => {
  const h = await createHarness();
  try {
    const { result, record } = await startRegistered(h);
    assert.equal(record.input.hostId, HOST_ID);
    assert.equal(record.input.hostEpoch, h.identity.hostEpoch);
    assert.equal(record.input.hostInstanceId, h.identity.hostInstanceId);
    assert.equal(record.input.credentialReference, CREDENTIAL_REFERENCE);
    assert.equal(record.input.onCarrierStatus, undefined);
    assert.equal(record.input.actor, undefined);
    assert.deepEqual(record.hello.payload.capabilities, []);
    assert.deepEqual(record.hello.payload.clientDialects, ["tw-relay.v2"]);
    assert.equal(result.connectorId, `managed-connector-${record.sequence}`);
    assert.deepEqual(h.composition.inspect(), {
      status: "registered_incomplete",
      controllerGeneration: result.controllerGeneration,
      connectorId: result.connectorId,
      acknowledgement: "host.registered",
      negotiatedCapabilityIntersection: [],
    });
    assert.equal(readinessReady(h.composition.readiness.current()), true);

    const activeRoute = openRoute(record, "bridge");
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = activeRoute.route.payload.authContext.clientInstanceId;
    sendClientFrame(activeRoute, hello);
    await settle();
    assert.deepEqual(
      JSON.parse(JSON.stringify(hostDataFrames(record))),
      [h.expectedWelcome()],
    );

    record.connection.acknowledge(record.transport.confirmNext());
    const query = fixture("command-query");
    query.expectedHostEpoch = h.identity.hostEpoch;
    sendClientFrame(activeRoute, query);
    await settle();
    const frames = hostDataFrames(record);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].type, "command.statuses");
    assert.equal(frames[1].requestId, query.requestId);
  } finally {
    await h.cleanup();
  }
});

test("managed reauthentication delegates one exact registered cut and closes hostile input before owner entry", async () => {
  const h = await createHarness();
  try {
    const { result, record } = await startRegistered(h, "managed.reauth.start");
    const cut = h.composition.inspect();
    assert.equal(h.composition.requestReauthentication(
      reauthenticationInput(cut, "managed.reauth.caller"),
    ), true);
    assert.deepEqual(h.reauthenticationPreparations, [{
      credentialReference: CREDENTIAL_REFERENCE,
      requestId: "managed.reauth.caller",
    }]);
    const reauthenticationFrames = record.transport.sent
      .map(decodeCarrier)
      .filter((frame) => frame.type === "host.reauthenticate");
    assert.equal(reauthenticationFrames.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(reauthenticationFrames[0])), {
      carrierVersion: 1,
      type: "host.reauthenticate",
      requestId: "managed-reauth-authority-winner",
      connectorId: result.connectorId,
      payload: {
        accessToken: "twcap2.managed-reauth.payload.mac",
      },
    });

    const acknowledged = fixture("host-reauthenticated");
    acknowledged.requestId = reauthenticationFrames[0].requestId;
    acknowledged.connectorId = result.connectorId;
    acknowledged.payload.grantId = "managed-host-grant";
    acknowledged.payload.jti = "managed-host-access-jti-2";
    record.connection.receive(carrierWire(acknowledged));
    assert.deepEqual(h.reauthenticationAcknowledgements, [{
      reference: CREDENTIAL_REFERENCE,
      version: "2",
      requestId: "managed-reauth-authority-winner",
      grantId: "managed-host-grant",
      accessJti: "managed-host-access-jti-2",
    }]);

    const activityBeforeExpiring = h.credentialActivity();
    const sentBeforeExpiring = record.transport.sent.length;
    const authExpiring = fixture("host-auth-expiring");
    authExpiring.connectorId = result.connectorId;
    authExpiring.payload.grantId = "managed-host-grant";
    record.connection.receive(carrierWire(authExpiring));
    assert.deepEqual(h.credentialActivity(), activityBeforeExpiring);
    assert.equal(record.transport.sent.length, sentBeforeExpiring);

    const hostileState = { getterCalls: 0, proxyTrapCalls: 0 };
    const accessorInput = {
      controllerGeneration: cut.controllerGeneration,
      connectorId: cut.connectorId,
    };
    Object.defineProperty(accessorInput, "requestId", {
      enumerable: true,
      get() {
        hostileState.getterCalls += 1;
        h.composition.requestReauthentication(
          reauthenticationInput(cut, "managed.reauth.nested"),
        );
        return "managed.reauth.accessor";
      },
    });
    const proxyTarget = reauthenticationInput(cut, "managed.reauth.proxy");
    const proxyInput = new Proxy(proxyTarget, {
      ownKeys(target) {
        hostileState.proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    for (const input of [
      accessorInput,
      proxyInput,
      { ...reauthenticationInput(cut), unknown: true },
      { ...reauthenticationInput(cut), controllerGeneration: "0" },
      { ...reauthenticationInput(cut), controllerGeneration: "999" },
      { ...reauthenticationInput(cut), connectorId: "stale-managed-connector" },
    ]) {
      assertReauthenticationRejectedWithoutTouch(h, input);
    }
    assert.deepEqual(hostileState, { getterCalls: 0, proxyTrapCalls: 0 });
  } finally {
    await h.cleanup();
  }
});

test("managed reauthentication revalidates its exact cut after synchronous authority reentry", async (t) => {
  for (const operation of ["stop", "close"]) {
    await t.test(operation, async () => {
      let h;
      let cut;
      let drain;
      h = await createHarness({
        manualDrain: true,
        prepareReauthentication(_input, prepared) {
          drain = operation === "stop"
            ? h.composition.stopAndDrain(stopInput(cut, `managed.reauth.${operation}`))
            : h.composition.closeAndDrain();
          return prepared;
        },
      });
      try {
        const active = await startRegistered(h, `managed.reauth.${operation}.start`);
        cut = h.composition.inspect();
        const sentBefore = active.record.transport.sent.length;

        assert.equal(h.composition.requestReauthentication(
          reauthenticationInput(cut, `managed.reauth.${operation}.caller`),
        ), false);
        assert.equal(h.credentialActivity().preparations, 1);
        assert.equal(active.record.transport.sent.length, sentBefore);
        assert.equal(
          active.record.transport.sent.map(decodeCarrier)
            .some((frame) => frame.type === "host.reauthenticate"),
          false,
        );
        assertReauthenticationRejectedWithoutTouch(
          h,
          reauthenticationInput(cut, `managed.reauth.${operation}.fenced`),
        );

        await settle();
        assert.equal(active.record.drainCalls, 1);
        active.record.drainGate.resolve();
        await drain;
        assert.deepEqual(h.composition.inspect(), {
          status: "stopped",
          controllerGeneration: cut.controllerGeneration,
        });
      } finally {
        await h.cleanup();
      }
    });
  }
});

test("managed reauthentication redacts synchronous credential authority failures", async () => {
  const secret = "twcap2.sensitive-reauthentication-authority-detail";
  const h = await createHarness({
    prepareReauthentication() {
      throw new Error(secret);
    },
  });
  try {
    const { record } = await startRegistered(h, "managed.reauth.throw.start");
    const cut = h.composition.inspect();
    const sentBefore = record.transport.sent.length;
    let result;
    assert.doesNotThrow(() => {
      result = h.composition.requestReauthentication(
        reauthenticationInput(cut, "managed.reauth.throw.caller"),
      );
    });
    assert.equal(result, false);
    assert.equal(String(result).includes(secret), false);
    assert.deepEqual(h.credentialActivity(), {
      reads: 1,
      preparations: 1,
      acknowledgements: 0,
    });
    assert.equal(record.transport.sent.length, sentBefore);
    assert.equal(
      record.transport.sent.map(decodeCarrier)
        .some((frame) => frame.type === "host.reauthenticate"),
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test("offline retry, replacement, superseded, and late callbacks converge on their exact actors", async () => {
  const h = await createHarness({
    registrationDisposition: (sequence) => sequence === 2 ? "replaced" : "connected",
  });
  try {
    const first = await startRegistered(h, "managed.retry.first");
    first.record.connection.closed(1006);
    assert.deepEqual(h.composition.inspect(), {
      status: "failed",
      controllerGeneration: first.result.controllerGeneration,
      connectorId: first.result.connectorId,
      retryable: true,
    });
    assert.equal(readinessReady(h.composition.readiness.current()), false);

    const second = await startRegistered(h, "managed.retry.second");
    assert.equal(first.record.drainCalls, 1);
    assert.notEqual(second.result.controllerGeneration, first.result.controllerGeneration);
    assert.notEqual(second.record.connection, first.record.connection);
    assert.notEqual(second.record.hello.requestId, first.record.hello.requestId);
    assert.equal(second.result.connectorId, "managed-connector-2");
    assert.equal(readinessReady(h.composition.readiness.current()), true);
    assertReauthenticationRejectedWithoutTouch(
      h,
      reauthenticationInput(first.result, "managed.reauth.replaced"),
    );

    first.record.connection.receive(registeredFrame(first.record));
    first.record.connection.closed(4409);
    await settle();
    assert.equal(h.composition.inspect().connectorId, second.result.connectorId);
    assert.equal(h.composition.inspect().status, "registered_incomplete");

    second.record.connection.receive(supersededFrame(second.record));
    await settle();
    assert.deepEqual(h.composition.inspect(), {
      status: "superseded",
      controllerGeneration: second.result.controllerGeneration,
      connectorId: second.result.connectorId,
    });
    assert.equal(second.record.drainCalls, 1);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assertReauthenticationRejectedWithoutTouch(
      h,
      reauthenticationInput(second.result, "managed.reauth.superseded"),
    );
    second.record.connection.receive(registeredFrame(second.record));
    second.record.connection.closed(1006);
    await settle();
    assert.equal(h.composition.inspect().status, "superseded");
  } finally {
    await h.cleanup();
  }
});

test("stop waits for exact drain evidence, withdraws readiness, and releases route ownership", async () => {
  const h = await createHarness({ manualDrain: true });
  try {
    const first = await startRegistered(h, "managed.stop.first");
    openRoute(first.record, "reusable");
    const cut = h.composition.inspect();
    const stop = h.composition.stopAndDrain(stopInput(cut));
    assertReauthenticationRejectedWithoutTouch(
      h,
      reauthenticationInput(cut, "managed.reauth.stopping"),
    );
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await settle();
    assert.equal(stopped, false);
    assert.equal(first.record.drainCalls, 1);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assert.deepEqual(first.record.transport.closes, [{ code: 1000, reason: "host_shutdown" }]);

    first.record.drainGate.resolve();
    await stop;
    assert.deepEqual(h.composition.inspect(), {
      status: "stopped",
      controllerGeneration: cut.controllerGeneration,
    });
    assertReauthenticationRejectedWithoutTouch(
      h,
      reauthenticationInput(cut, "managed.reauth.stopped"),
    );

    const secondStart = h.composition.start(startInput("managed.stop.second"));
    await settle();
    const secondRecord = h.records.at(-1);
    const second = await secondStart;
    openRoute(secondRecord, "reusable");
    assert.equal(second.connectorId, "managed-connector-2");
    secondRecord.drainGate.resolve();
  } finally {
    await h.cleanup();
  }
});

test("a rejection before drain binding detaches its actor and permits a later stopped retry", async () => {
  const h = await createHarness({
    rejectCredentialRead: (readCount) => readCount === 1,
  });
  try {
    await assert.rejects(
      h.composition.start(startInput("managed.pre-drain-reject")),
      (error) => error.name === "RelayV2HostConnectorControllerError"
        && error.code === "OPERATION_FAILED",
    );
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assert.equal(h.records[0].connection, null);
    assert.equal(h.records[0].drainCalls, 1);
    assert.equal(Object.isFrozen(h.records[0].drainProofs[0]), true);
    assert.deepEqual(h.records[0].transport.closes, [{
      code: 1000,
      reason: "host_shutdown",
    }]);

    const failed = h.composition.inspect();
    assert.deepEqual(failed, {
      status: "failed",
      controllerGeneration: "1",
      connectorId: null,
      retryable: false,
    });
    await h.composition.stopAndDrain(stopInput(failed, "managed.pre-drain-stop"));
    const retry = await startRegistered(h, "managed.pre-drain-retry");
    assert.equal(retry.result.controllerGeneration, "2");
    assert.equal(h.composition.inspect().status, "registered_incomplete");
    assert.equal(readinessReady(h.composition.readiness.current()), true);
  } finally {
    await h.cleanup();
  }
});

test("synchronous registration followed by bind rejection never publishes durable readiness", async () => {
  let h;
  let readinessDuringRejectedBind = null;
  h = await createHarness({
    bindReturn(sequence) {
      if (sequence !== 1) return undefined;
      readinessDuringRejectedBind = readinessReady(h.composition.readiness.current());
      return "invalid-bind-result";
    },
  });
  try {
    await assert.rejects(
      h.composition.start(startInput("managed.bind-reject")),
      (error) => error.name === "RelayV2HostConnectorControllerError"
        && error.code === "OPERATION_FAILED",
    );
    assert.notEqual(h.records[0].connection, null);
    assert.equal(h.records[0].drainCalls, 1);
    assert.equal(readinessDuringRejectedBind, false);
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    const failed = h.composition.inspect();
    assert.deepEqual(failed, {
      status: "failed",
      controllerGeneration: "1",
      connectorId: null,
      retryable: false,
    });

    await h.composition.stopAndDrain(stopInput(failed, "managed.bind-reject-stop"));
    const retry = await startRegistered(h, "managed.bind-reject-retry");
    assert.equal(retry.result.controllerGeneration, "2");
    assert.equal(readinessReady(h.composition.readiness.current()), true);
    h.records[0].connection.closed(1006);
    h.records[0].connection.receive(registeredFrame(h.records[0]));
    await settle();
    assert.equal(h.composition.inspect().connectorId, retry.result.connectorId);
    assert.equal(readinessReady(h.composition.readiness.current()), true);
  } finally {
    await h.cleanup();
  }
});

test("close fences pending starts, converges concurrent close, and exposes no lifecycle authority", async () => {
  const factoryGate = deferred();
  const h = await createHarness({ factoryGate: () => factoryGate });
  try {
    assert.equal(Object.isFrozen(h.composition), true);
    for (const forbidden of [
      "actor", "transport", "factory", "sender", "routeSink", "routeOwner", "controller",
      "credentialReference", "credentialReferences", "accessToken", "token",
    ]) assert.equal(h.composition[forbidden], undefined);

    const pendingStart = h.composition.start(startInput("managed.pending"));
    await settle();
    assert.equal(h.composition.inspect().status, "starting");
    const firstClose = h.composition.closeAndDrain();
    const secondClose = h.composition.closeAndDrain();
    assert.equal(firstClose, secondClose);
    assertReauthenticationRejectedWithoutTouch(h, {
      requestId: "managed.reauth.closing",
      controllerGeneration: "1",
      connectorId: "managed-closing-connector",
    });
    await assert.rejects(
      h.composition.start(startInput("managed.after-close")),
      (error) => error.name === "RelayV2HostConnectorControllerError"
        && error.code === "UNAVAILABLE",
    );
    factoryGate.resolve();
    await assert.rejects(
      pendingStart,
      (error) => error.name === "RelayV2HostConnectorControllerError"
        && error.code === "ABORTED",
    );
    await firstClose;
    assert.equal(h.records[0].drainCalls, 1);
    assert.deepEqual(h.composition.inspect(), {
      status: "stopped",
      controllerGeneration: "1",
    });
    assert.equal(readinessReady(h.composition.readiness.current()), false);
  } finally {
    await h.cleanup();
  }

  const registered = await createHarness({ manualDrain: true });
  try {
    const active = await startRegistered(registered, "managed.close.registered");
    const cut = registered.composition.inspect();
    const close = registered.composition.closeAndDrain();
    assertReauthenticationRejectedWithoutTouch(
      registered,
      reauthenticationInput(cut, "managed.reauth.close-fenced"),
    );
    await settle();
    assert.equal(active.record.drainCalls, 1);
    active.record.drainGate.resolve();
    await close;
  } finally {
    await registered.cleanup();
  }
});

test("transport lifecycle failures are reflected only as typed redacted controller failures", async () => {
  const secret = "twcap2.secret-transport-factory-detail";
  const h = await createHarness({ factoryError: new Error(secret) });
  try {
    await assert.rejects(
      h.composition.start(startInput("managed.redacted")),
      (error) => {
        assert.equal(error.name, "RelayV2HostConnectorControllerError");
        assert.equal(error.code, "OPERATION_FAILED");
        assert.equal(error.message, "Relay v2 host connector controller operation failed");
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});
