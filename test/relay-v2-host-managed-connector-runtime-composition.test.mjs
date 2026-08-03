import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const broker = await import("../dist/relay/v2/brokerCore.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const { build } = createRequire(import.meta.url)("esbuild");
const shippingProcessLifecycleBuild = await build({
  entryPoints: [new URL(
    "../src/relay/v2/hostShippingProcessLifecycle.ts",
    import.meta.url,
  ).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [{
    name: "managed-h1-shipping-lifecycle-fixture",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^\.\/hostCarrier\.js$/ }, () => ({
        path: "hostCarrier",
        namespace: "managed-h1-shipping-lifecycle-stub",
      }));
      esbuild.onLoad(
        { filter: /.*/, namespace: "managed-h1-shipping-lifecycle-stub" },
        () => ({
          contents: "export const RELAY_V2_HOST_SUPERSEDED_EXIT_CODE = 78;",
          loader: "js",
        }),
      );
    },
  }],
});
const shippingProcessLifecycle = await import(
  `data:text/javascript;base64,${Buffer.from(
    shippingProcessLifecycleBuild.outputFiles[0].text,
  ).toString("base64")}`
);
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
const AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY = "agent.transcript-lifecycle.v1";
const corpus = loadRelayV2FixtureCorpus();
const dashboardManagementContract = JSON.parse(readFileSync(new URL(
  "../contracts/dashboard-relay-v2-management/v2/cases.json",
  import.meta.url,
), "utf8"));
const dashboardManagementStartFrame = dashboardManagementContract.goldenExchanges.find(
  ({ operation }) => operation === "start_connector",
).requestFrame;
const dashboardManagementStopFrame = dashboardManagementContract.goldenExchanges.find(
  ({ operation }) => operation === "stop_connector",
).requestFrame;
const dashboardManagementStatusFrame = dashboardManagementContract.goldenExchanges.find(
  ({ operation }) => operation === "status",
).requestFrame;
const dashboardManagementCreateEnrollmentFrame =
  dashboardManagementContract.goldenExchanges.find(
    ({ operation }) => operation === "create_enrollment",
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

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForRecordCount(harness, count, message) {
  const deadline = Date.now() + 3_000;
  while (harness.records.length < count && Date.now() < deadline) {
    await delay(25);
  }
  assert.equal(harness.records.length, count, message);
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

function readyAgentTranscriptLifecycleAttachment() {
  return Object.freeze({
    capability: AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
    subscribe(sink) {
      sink.apply(true);
      return Object.freeze({ unsubscribe() {} });
    },
    inspectRequest() {
      throw new Error("unexpected Agent extension request inspection");
    },
    async authorize() {
      return false;
    },
    async handleRequest() {
      throw new Error("unexpected Agent extension request handling");
    },
    handleUnavailableRequest() {
      throw new Error("unexpected Agent extension unavailable response");
    },
    isolateFailure() {},
    async closeAndDrain() {},
  });
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
      const copy = typeof bytes === "string"
        ? Uint8Array.from(Buffer.from(bytes, "utf8"))
        : Uint8Array.from(bytes);
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
      const text = Buffer.from(bytes).toString("utf8");
      for (const listener of this.listeners.get("message") ?? []) listener(text, false);
    }
  };
}

async function createHarness(options = {}) {
  const spoolNow = options.spoolNow ?? Date.now;
  const spoolLimits = options.spoolLimits;
  const spoolHooks = options.spoolHooks;
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
    testHooks: options.resourceHooks,
  });
  discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
  if (options.freshH2) {
    discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
  }
  const seeded = await foundation.reconcile();
  const spoolRoot = join(home, "snapshot-spool");
  if (!options.freshH2) {
    const publisherSpool = await foundation.openStateSnapshotSpool({
      hostId: HOST_ID,
      root: spoolRoot,
      ownerInstanceId: store.hostInstanceId,
      now: spoolNow,
      testLimits: spoolLimits,
      testHooks: spoolHooks,
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
  }
  const spool = await foundation.openStateSnapshotSpool({
    hostId: HOST_ID,
    root: spoolRoot,
    ownerInstanceId: store.hostInstanceId,
    now: spoolNow,
    testLimits: spoolLimits,
    testHooks: spoolHooks,
  });
  const h2RecoveryCandidate = options.freshH2
    ? await spool.issueFreshInstallHostH2Candidate()
    : await spool.issueRecoveredHostH2Candidate();
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
      now: options.h1Now ?? (() => 1_783_700_000_000),
      executor: {
        async resolve(request) {
          if (options.h1ExecutorOverrides?.resolve) {
            return options.h1ExecutorOverrides.resolve(request);
          }
          throw new Error("unexpected managed command resolution");
        },
        fenceResolution(transaction, request, fence) {
          return options.h1ExecutorOverrides?.fenceResolution?.(
            transaction,
            request,
            fence,
          );
        },
        async executeTwRpc(plan) {
          if (options.h1ExecutorOverrides?.executeTwRpc) {
            return options.h1ExecutorOverrides.executeTwRpc(plan);
          }
          throw new Error("unexpected managed TW RPC execution");
        },
        async executeTerminalControl(plan) {
          if (options.h1ExecutorOverrides?.executeTerminalControl) {
            return options.h1ExecutorOverrides.executeTerminalControl(plan);
          }
          throw new Error("unexpected managed terminal-control execution");
        },
      },
    });
  assert.notEqual(h1RecoveryCandidate, null);

  const records = [];
  const usesManagedWss = options.managedWss;
  const transportLifecycleFactory = usesManagedWss
    ? null
    : createTransportLifecycleFactory(options, records);
  const managedWssCredential = usesManagedWss
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
  if (options.optionalExtension !== undefined) {
    runtimeOptions.optionalExtension = options.optionalExtension;
  }
  const carrierOptions = {
    idFactory: () => `managed-host-hello-${++helloSequence}`,
    clock: options.carrierClock ?? (() => 1_783_700_100_000),
    schedule: options.carrierSchedule,
  };
  const managedCredentialReferences = {
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
  };
  const localDevelopmentActivation = options.localDevelopment === false
    ? undefined
    : compositionModule.issueRelayV2HostLocalDevelopmentCapabilityActivation(
      usesManagedWss ? managedWssCredential.authority : managedCredentialReferences,
    );
  if (composition === null) composition = options.managedWss
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
    }, localDevelopmentActivation)
    : await compositionModule.openRelayV2HostManagedConnectorRuntimeComposition({
      runtime: runtimeOptions,
      connector: {
        credentialReference: CREDENTIAL_REFERENCE,
        carrier: {
          credentialReferences: managedCredentialReferences,
          ...carrierOptions,
        },
        transportLifecycleFactory,
      },
    }, localDevelopmentActivation);

  assert.equal(await composition.readiness.h0.activate(), true);
  assert.equal(composition.readiness.h3.activate(), true);

  return {
    home,
    discovery,
    foundation,
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
    localDevelopmentActivation,
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

function automaticReauthenticationInput(harness, cut, requestId) {
  const inspection = harness.managedWssCredential.authority.inspect(
    CREDENTIAL_REFERENCE,
  );
  return {
    ...reauthenticationInput(cut, requestId),
    expectedCredential: {
      reference: CREDENTIAL_REFERENCE,
      version: inspection.credentialVersion,
      grantId: inspection.grantId,
      accessJti: inspection.accessJti,
    },
    expectedPendingReauthentication: inspection.pendingReauthentication,
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
      assert.deepEqual(
        record.hello.payload.capabilities,
        [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
      );
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

  await t.test("successor registration retires its exact-current connector orphan", async () => {
    const h = await createHarness({ managedWss: true });
    try {
      const first = await startManagedWssRegistered(
        h,
        "managed.wss.orphan.start.first",
      );
      const firstCut = h.composition.inspect();
      assert.equal(h.composition.requestReauthentication(
        reauthenticationInput(firstCut, "managed.wss.orphan.request"),
      ), true);
      assert.equal(
        h.managedWssCredential.authority.inspect(CREDENTIAL_REFERENCE)
          .pendingReauthentication.requestId,
        "managed.wss.orphan.request",
      );
      await h.composition.stopAndDrain(
        stopInput(firstCut, "managed.wss.orphan.stop.first"),
      );

      const second = await startManagedWssRegistered(
        h,
        "managed.wss.orphan.start.successor",
      );
      assert.notEqual(
        second.result.controllerGeneration,
        first.result.controllerGeneration,
      );
      assert.equal(
        h.managedWssCredential.authority.inspect(CREDENTIAL_REFERENCE)
          .pendingReauthentication,
        null,
      );
      assert.equal(h.managedWssCredential.activity.writes, 2);
      assert.equal(
        second.record.sent
          .map(({ bytes }) => decodeCarrier(bytes))
          .some((frame) => frame.type === "host.reauthenticate"),
        false,
      );
    } finally {
      await h.cleanup();
    }
  });
});

test("local-development activation is opaque, exact-owner-bound, and one-shot", async () => {
  const h = await createHarness({ managedWss: true });
  try {
    assert.equal(Object.isFrozen(h.localDevelopmentActivation), true);
    assert.equal(Object.getPrototypeOf(h.localDevelopmentActivation), null);
    assert.deepEqual(Reflect.ownKeys(h.localDevelopmentActivation), []);
    const options = {
      runtime: {
        hostId: HOST_ID,
        hostEpoch: h.identity.hostEpoch,
        hostInstanceId: h.identity.hostInstanceId,
        authorities: {},
        welcome: {},
      },
      connector: {
        credentialAuthority: h.managedWssCredential.authority,
        credentialReference: CREDENTIAL_REFERENCE,
        carrier: {},
        wss: {
          relayUrl: "wss://relay.example.com/",
          webSocketConstructor: class {},
        },
      },
    };
    const before = structuredClone(h.managedWssEffects);
    await assert.rejects(
      compositionModule.openRelayV2HostManagedWssConnectorRuntimeComposition(
        options,
        h.localDevelopmentActivation,
      ),
      (error) => error?.name === "RelayV2HostConnectorControllerError"
        && error.code === "OPERATION_FAILED",
    );
    const foreignActivation =
      compositionModule.issueRelayV2HostLocalDevelopmentCapabilityActivation({});
    await assert.rejects(
      compositionModule.openRelayV2HostManagedWssConnectorRuntimeComposition(
        options,
        foreignActivation,
      ),
      (error) => error?.name === "RelayV2HostConnectorControllerError"
        && error.code === "OPERATION_FAILED",
    );
    assert.deepEqual(h.managedWssEffects, before);
  } finally {
    await h.cleanup();
  }
});

test("Dashboard-owned connector enrolls while automatic reauth uses its exact closed port", async () => {
  const h = await createHarness({ managedWss: true });
  try {
    const owner = createDashboardManagementOwner(h);
    const beforeConstruction = dashboardManagementEffects(h, owner);
    assert.equal(
      compositionModule.claimRelayV2HostAutomaticReauthenticationPort(
        h.composition.automaticReauthenticationClaim,
        { ...dashboardManagementIdentity(h), hostId: "foreign-host" },
        h.managedWssCredential.authority,
      ),
      null,
    );
    assert.equal(
      compositionModule.claimRelayV2HostAutomaticReauthenticationPort(
        h.composition.automaticReauthenticationClaim,
        dashboardManagementIdentity(h),
        Object.freeze({}),
      ),
      null,
    );
    const automaticReauthentication =
      compositionModule.claimRelayV2HostAutomaticReauthenticationPort(
        h.composition.automaticReauthenticationClaim,
        dashboardManagementIdentity(h),
        h.managedWssCredential.authority,
      );
    assert.notEqual(automaticReauthentication, null);
    assert.equal(
      compositionModule.claimRelayV2HostAutomaticReauthenticationPort(
        h.composition.automaticReauthenticationClaim,
        dashboardManagementIdentity(h),
        h.managedWssCredential.authority,
      ),
      null,
      "the exact automatic reauthentication claim is one-shot",
    );
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
    const run = session.run();
    const record = await registerPendingManagedWss(h);
    let registeredCut;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      registeredCut = h.composition.inspect();
      if (registeredCut.status === "registered_incomplete") break;
      await settle(1);
    }
    assert.equal(registeredCut.status, "registered_incomplete");
    const reauthentication = automaticReauthenticationInput(
      h,
      registeredCut,
      "managed.dashboard.automatic-reauth",
    );
    assert.equal(
      h.composition.requestReauthentication(reauthentication),
      false,
      "the public facade remains gated after Dashboard claims connector lifecycle",
    );
    assert.deepEqual(automaticReauthentication.inspect(), registeredCut);
    const effectsBeforeIncompleteAutomaticInput = dashboardManagementEffects(h, owner);
    assert.equal(
      automaticReauthentication.requestReauthentication(
        reauthenticationInput(registeredCut, "managed.dashboard.incomplete-automatic-reauth"),
      ),
      false,
      "the closed automatic port has no legacy three-field fallback",
    );
    assert.deepEqual(
      dashboardManagementEffects(h, owner),
      effectsBeforeIncompleteAutomaticInput,
    );
    assert.equal(
      automaticReauthentication.requestReauthentication(reauthentication),
      true,
    );
    const reauthenticationFrames = record.sent
      .map(({ bytes }) => decodeCarrier(bytes))
      .filter(({ type }) => type === "host.reauthenticate");
    assert.equal(reauthenticationFrames.length, 1);
    assert.equal(
      reauthenticationFrames[0].connectorId,
      `managed-connector-${record.sequence}`,
    );
    const reauthenticated = fixture("host-reauthenticated");
    reauthenticated.requestId = reauthenticationFrames[0].requestId;
    reauthenticated.connectorId = `managed-connector-${record.sequence}`;
    reauthenticated.payload.grantId = "managed-wss-grant";
    reauthenticated.payload.jti = "managed-wss-access-jti";
    record.socket.receive(carrierWire(reauthenticated));
    await settle();

    owner.input.push(Buffer.from(dashboardManagementCreateEnrollmentFrame));
    owner.input.push(Buffer.from(dashboardManagementStatusFrame));
    owner.input.end();
    let enrollmentCreate;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      enrollmentCreate = record.sent
        .map(({ bytes }) => decodeCarrier(bytes))
        .find(({ type }) => type === "enrollment.create");
      if (enrollmentCreate !== undefined) break;
      await settle(1);
    }
    assert.notEqual(enrollmentCreate, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(enrollmentCreate.payload)), {
      expiresInMs: 300_000,
      deviceLabel: "Pixel",
    });
    const enrollmentCreated = fixture("enrollment-created");
    enrollmentCreated.requestId = enrollmentCreate.requestId;
    enrollmentCreated.connectorId = `managed-connector-${record.sequence}`;
    enrollmentCreated.payload.hostId = HOST_ID;
    record.socket.receive(carrierWire(enrollmentCreated));
    assert.equal(await run, 0);

    const responses = owner.writes.map((frame) => JSON.parse(frame));
    assert.deepEqual(
      responses[0],
      JSON.parse(dashboardManagementContract.startupReadyFrame),
    );
    const startRequestId = JSON.parse(dashboardManagementStartFrame).requestId;
    const createRequestId =
      JSON.parse(dashboardManagementCreateEnrollmentFrame).requestId;
    const statusRequestId = JSON.parse(dashboardManagementStatusFrame).requestId;
    const startResponse = responses.find(({ requestId }) => requestId === startRequestId);
    const createResponse = responses.find(({ requestId }) => requestId === createRequestId);
    const statusResponse = responses.find(({ requestId }) => requestId === statusRequestId);
    assert.equal(startResponse.ok, true);
    assert.equal(createResponse.ok, true);
    assert.equal(statusResponse.ok, true);
    assert.deepEqual(startResponse.result.connector, {
      status: "starting",
      hostId: HOST_ID,
    });
    assert.deepEqual(statusResponse.result.connector, {
      status: "registered",
      acknowledgement: "host.registered",
      hostId: HOST_ID,
      connectorId: `managed-connector-${record.sequence}`,
      negotiatedCapabilityIntersection: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    });
    assert.equal(createResponse.result.enrollment.status, "active");
    assert.equal(
      createResponse.result.enrollment.review.enrollment.enrollmentCode,
      enrollmentCreated.payload.enrollmentCode,
    );
    assert.deepEqual(
      record.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    assert.deepEqual(owner.exchanges, { bootstrap: 0, refresh: 0 });
    assert.equal(h.managedWssCredential.activity.writes, 2);
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

test("Dashboard-owned full-cap retry outlives its promoted H2 client lease and gates H0 loss", async () => {
  let spoolNow = 1_000;
  const h2Evidence = { reservations: 0, verifications: 0, activations: 0 };
  const h = await createHarness({
    managedWss: true,
    spoolNow: () => spoolNow,
    spoolLimits: { idleLeaseMs: 10, absoluteLeaseMs: 20 },
    spoolHooks: {
      afterReservationPersisted() { h2Evidence.reservations += 1; },
      beforeReadinessReceiptVerify() { h2Evidence.verifications += 1; },
      beforeReadinessReceiptActivation() { h2Evidence.activations += 1; },
    },
  });
  try {
    const owner = createDashboardManagementOwner(h);
    const session = dashboardManagementSessionModule
      .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);
    await settle();
    assert.deepEqual(h2Evidence, { reservations: 1, verifications: 1, activations: 1 });
    assert.equal(h.records.length, 0, "cold construction cannot start the connector");

    owner.input.push(Buffer.from(dashboardManagementStartFrame));
    const run = session.run();
    const first = await registerPendingManagedWss(h);
    await settle();
    assert.deepEqual(
      first.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    assert.equal(h.composition.inspect().status, "registered_incomplete");

    spoolNow += 10;
    await h.spool.cleanupExpired();
    await settle();
    assert.deepEqual(first.closes, []);
    assert.equal(readinessReady(h.composition.readiness.current()), true);
    assert.deepEqual(h2Evidence, { reservations: 1, verifications: 1, activations: 1 });
    assert.equal(h.composition.inspect().status, "registered_incomplete");
    assert.deepEqual(owner.exchanges, { bootstrap: 0, refresh: 0 });

    first.socket.terminate();
    await settle();
    assert.deepEqual(h.composition.inspect(), {
      status: "failed",
      controllerGeneration: "1",
      connectorId: "managed-connector-1",
      retryable: true,
    });

    await waitForRecordCount(
      h,
      2,
      "the Dashboard owner did not create the post-expiry successor",
    );
    const successor = await registerPendingManagedWss(h);
    assert.equal(successor.sequence, 2);
    await settle();
    assert.deepEqual(
      successor.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    assert.deepEqual(h.composition.inspect(), {
      status: "registered_incomplete",
      controllerGeneration: "2",
      connectorId: "managed-connector-2",
      acknowledgement: "host.registered",
      negotiatedCapabilityIntersection: [],
    });
    assert.equal(readinessReady(h.composition.readiness.current()), true);

    h.composition.readiness.h0.close();
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assert.deepEqual(successor.closes, [{ code: 1000, reason: "host_shutdown" }]);
    await delay(1_250);
    assert.equal(
      h.records.length,
      2,
      "a missing full pre-carrier offer must fail before creating a socket",
    );
    assert.equal(await h.composition.readiness.h0.activate(), true);
    await waitForRecordCount(
      h,
      3,
      "the Dashboard owner did not retry after canonical H0 recovery",
    );
    const nextSuccessor = await registerPendingManagedWss(h);
    assert.equal(nextSuccessor.sequence, 3);
    await settle();
    assert.deepEqual(
      nextSuccessor.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    assert.deepEqual(h.composition.inspect(), {
      status: "registered_incomplete",
      controllerGeneration: "3",
      connectorId: "managed-connector-3",
      acknowledgement: "host.registered",
      negotiatedCapabilityIntersection: [],
    });

    owner.input.push(Buffer.from(dashboardManagementStatusFrame));
    owner.input.end();
    assert.equal(await run, 0);
    const statusRequestId = JSON.parse(dashboardManagementStatusFrame).requestId;
    const statusResponse = owner.writes
      .map((frame) => JSON.parse(frame))
      .find((candidate) => candidate.requestId === statusRequestId);
    assert.equal(statusResponse.ok, true);
    assert.deepEqual(statusResponse.result.connector, {
      status: "registered",
      acknowledgement: "host.registered",
      hostId: HOST_ID,
      connectorId: "managed-connector-3",
      negotiatedCapabilityIntersection: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    });
    assert.deepEqual(owner.exchanges, { bootstrap: 0, refresh: 0 });
  } finally {
    await h.cleanup();
  }
});

test("Dashboard-owned fresh H2 recovers its full offer after a post-open materialized withdrawal", async () => {
  const h = await createHarness({ managedWss: true, freshH2: true });
  try {
    const owner = createDashboardManagementOwner(h);
    const session = dashboardManagementSessionModule
      .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);
    owner.input.push(Buffer.from(dashboardManagementStatusFrame));
    const run = session.run();
    await settle();
    const initialStatusRequestId = JSON.parse(dashboardManagementStatusFrame).requestId;
    const initialStatus = owner.writes
      .map((frame) => JSON.parse(frame))
      .find(({ requestId }) => requestId === initialStatusRequestId);
    assert.deepEqual(initialStatus.result.connector, {
      status: "stopped",
    });
    assert.equal(h.records.length, 0);

    const beforeReplacement = await h.store.read();
    h.discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
    const replacement = await h.foundation.reconcile();
    assert.equal(replacement.snapshot.eventSeq, beforeReplacement.eventSeq);
    assert.deepEqual(replacement.events, []);

    h.discovery.scans.push({ coverage: "partial", scopes: [] });
    const withdrawn = await h.foundation.reconcile();
    assert.equal(withdrawn.readiness.snapshotMaterializationReady, false);

    h.discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
    const recovered = await h.foundation.reconcile();
    assert.equal(recovered.readiness.snapshotMaterializationReady, true);

    owner.input.push(Buffer.from(dashboardManagementStartFrame));
    const record = await registerPendingManagedWss(h);
    assert.deepEqual(
      record.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    owner.input.push(Buffer.from(dashboardManagementStatusFrame));
    owner.input.end();
    assert.equal(await run, 0);
    const statuses = owner.writes
      .map((frame) => JSON.parse(frame))
      .filter(({ requestId }) => requestId === initialStatusRequestId);
    assert.deepEqual(statuses.at(-1).result.connector, {
      status: "registered",
      acknowledgement: "host.registered",
      hostId: HOST_ID,
      connectorId: `managed-connector-${record.sequence}`,
      negotiatedCapabilityIntersection: [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    });
  } finally {
    await h.cleanup();
  }
});

test("fresh H2 release failure permanently fences authoritative successors", async () => {
  let failRelease = false;
  const h = await createHarness({
    managedWss: true,
    freshH2: true,
    resourceHooks: {
      beforeSnapshotActivationRelease() {
        if (failRelease) throw new Error("injected fresh H2 release failure");
      },
    },
  });
  try {
    failRelease = true;
    h.discovery.scans.push({ coverage: "partial", scopes: [] });
    const withdrawn = await h.foundation.reconcile();
    assert.equal(withdrawn.readiness.snapshotMaterializationReady, false);

    h.discovery.scans.push({ coverage: "complete", scopes: [completeScope()] });
    const recovered = await h.foundation.reconcile();
    assert.equal(recovered.readiness.snapshotMaterializationReady, true);
    await assert.rejects(
      h.composition.start(startInput("managed.fresh-h2.release-failed")),
      (error) => error?.name === "RelayV2HostConnectorControllerError"
        && error.code === "UNAVAILABLE",
    );
    assert.equal(h.records.length, 0,
      "a poisoned fresh H2 lifecycle must not create a successor socket");
  } finally {
    await h.cleanup();
  }
});

test("Dashboard retry stays socket-free after promoted H2 owner withdrawal", async () => {
  const h = await createHarness({ managedWss: true });
  try {
    const owner = createDashboardManagementOwner(h);
    const session = dashboardManagementSessionModule
      .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);
    owner.input.push(Buffer.from(dashboardManagementStartFrame));
    const run = session.run();
    const first = await registerPendingManagedWss(h);
    await settle();
    assert.deepEqual(
      first.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );

    h.composition.readiness.h2.close();
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assert.deepEqual(first.closes, [{ code: 1000, reason: "host_shutdown" }]);
    await delay(1_250);
    assert.equal(
      h.records.length,
      1,
      "a withdrawn live H2 owner must not permit an empty-cap retry socket",
    );

    owner.input.end();
    assert.equal(await run, 0);
  } finally {
    await h.cleanup();
  }
});

test("Dashboard stop and composition close fence a pending desired-state retry", async (t) => {
  for (const operation of ["stop", "close"]) {
    await t.test(operation, async () => {
      const h = await createHarness({ managedWss: true });
      try {
        const owner = createDashboardManagementOwner(h);
        const session = dashboardManagementSessionModule
          .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);
        owner.input.push(Buffer.from(dashboardManagementStartFrame));
        const run = session.run();
        const first = await registerPendingManagedWss(h);
        await settle();
        first.socket.terminate();
        await settle();
        assert.equal(h.composition.inspect().status, "failed");

        await delay(300);
        assert.equal(h.records.length, 1, "retry must still be inside its initial backoff");
        if (operation === "stop") {
          owner.input.push(Buffer.from(dashboardManagementStopFrame));
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (h.composition.inspect().status === "stopped") break;
            await settle(1);
          }
          assert.equal(h.composition.inspect().status, "stopped");
        } else {
          await session.closeAndDrain();
        }

        await delay(1_100);
        assert.equal(h.records.length, 1, `${operation} did not fence the retry timer`);
        if (operation === "stop") {
          owner.input.end();
          assert.equal(await run, 0);
        } else {
          assert.equal(await run, 1);
        }
      } finally {
        await h.cleanup();
      }
    });
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

test("ordinary managed compositions keep capabilities empty and management fail-closed", async (t) => {
  await t.test("injected transport composition", async () => {
    const h = await createHarness({ localDevelopment: false });
    try {
      const { record } = await startRegistered(h, "managed.ordinary.start");
      assert.deepEqual(record.hello.payload.capabilities, []);
      assert.equal(readinessReady(h.composition.readiness.current()), false);
    } finally {
      await h.cleanup();
    }
  });

  await t.test("production-shaped WSS composition", async () => {
    const h = await createHarness({
      managedWss: true,
      localDevelopment: false,
    });
    try {
      const owner = createDashboardManagementOwner(h);
      const session = dashboardManagementSessionModule
        .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);
      owner.input.push(Buffer.from(dashboardManagementStartFrame));
      owner.input.push(Buffer.from(dashboardManagementCreateEnrollmentFrame));
      owner.input.end();
      const run = session.run();
      const record = await registerPendingManagedWss(h);
      assert.equal(await run, 0);
      assert.deepEqual(record.hello.payload.capabilities, []);
      assert.equal(readinessReady(h.composition.readiness.current()), false);
      assert.equal(
        record.sent.map(({ bytes }) => decodeCarrier(bytes))
          .some(({ type }) => type === "enrollment.create"),
        false,
      );
      const createRequestId =
        JSON.parse(dashboardManagementCreateEnrollmentFrame).requestId;
      const createResponse = owner.writes
        .map((frame) => JSON.parse(frame))
        .find(({ requestId }) => requestId === createRequestId);
      assert.deepEqual(createResponse.error, {
        code: "NOT_READY",
        message: "Relay v2 management is not ready",
        retryable: false,
      });
    } finally {
      await h.cleanup();
    }
  });
});

test("local-development activation advertises the atomic full offer and becomes ready", async () => {
  const h = await createHarness();
  try {
    const { result, record } = await startRegistered(h);
    assert.equal(record.input.hostId, HOST_ID);
    assert.equal(record.input.hostEpoch, h.identity.hostEpoch);
    assert.equal(record.input.hostInstanceId, h.identity.hostInstanceId);
    assert.equal(record.input.credentialReference, CREDENTIAL_REFERENCE);
    assert.equal(record.input.onCarrierStatus, undefined);
    assert.equal(record.input.actor, undefined);
    assert.deepEqual(
      record.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
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

test("managed Host hello snapshots only the runtime-ready Agent capability", async () => {
  const ready = await createHarness({
    managedWss: true,
    optionalExtension: readyAgentTranscriptLifecycleAttachment(),
  });
  try {
    const owner = createDashboardManagementOwner(ready);
    const session = dashboardManagementSessionModule
      .createRelayV2DashboardManagementProtocolV2CompositionSession(owner.options);
    owner.input.push(Buffer.from(dashboardManagementStartFrame));
    const run = session.run();
    const record = await registerPendingManagedWss(ready);
    assert.deepEqual(record.hello.payload.capabilities, [
      ...broker.RELAY_V2_REQUIRED_CAPABILITIES,
      AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
    ]);
    owner.input.push(Buffer.from(dashboardManagementStatusFrame));
    owner.input.end();
    assert.equal(await run, 0);
    const statusRequestId = JSON.parse(dashboardManagementStatusFrame).requestId;
    const statusResponse = owner.writes
      .map((frame) => JSON.parse(frame))
      .find((candidate) => candidate.requestId === statusRequestId);
    assert.deepEqual(statusResponse.result.connector, {
      status: "registered",
      acknowledgement: "host.registered",
      hostId: HOST_ID,
      connectorId: `managed-connector-${record.sequence}`,
      negotiatedCapabilityIntersection: [
        ...broker.RELAY_V2_REQUIRED_CAPABILITIES,
        AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      ],
    });
  } finally {
    await ready.cleanup();
  }

  const absent = await createHarness();
  try {
    const { record } = await startRegistered(absent, "managed.agent-capability.absent");
    assert.deepEqual(record.hello.payload.capabilities, [
      ...broker.RELAY_V2_REQUIRED_CAPABILITIES,
    ]);
  } finally {
    await absent.cleanup();
  }
});

test("managed withdrawal fences a consumed offer and recovery requires new generations", async () => {
  const h = await createHarness();
  try {
    const first = await startRegistered(h, "managed.offer.first");
    assert.deepEqual(
      first.record.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    assert.equal(readinessReady(h.composition.readiness.current()), true);

    h.composition.readiness.h0.close();
    assert.equal(readinessReady(h.composition.readiness.current()), false);
    assert.deepEqual(first.record.transport.closes, [{ code: 1000, reason: "host_shutdown" }]);
    assert.equal(h.composition.inspect().status, "failed");
    await settle();
    assert.equal(first.record.drainCalls, 1);

    assert.equal(await h.composition.readiness.h0.activate(), true);
    const second = await startRegistered(h, "managed.offer.second");
    assert.notEqual(
      second.result.controllerGeneration,
      first.result.controllerGeneration,
    );
    assert.deepEqual(
      second.record.hello.payload.capabilities,
      [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
    );
    assert.equal(readinessReady(h.composition.readiness.current()), true);
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
      expectedCredential: {
        reference: CREDENTIAL_REFERENCE,
        version: "1",
        grantId: "managed-host-grant",
        accessJti: "managed-host-access-jti",
      },
      expectedPendingReauthentication: null,
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
      reads: 2,
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

test("shipping lifecycle starts an H1 rotation successor with a fresh window", async () => {
  let now = 1_783_700_000_000;
  let executions = 0;
  const scheduled = [];
  const lifecycleWaits = [];
  const lifecycleStop = new AbortController();
  let lifecycleRequestSequence = 0;
  let lifecycleRun = null;
  const h = await createHarness({
    h1Now: () => now,
    carrierClock: () => now,
    carrierSchedule(delayMs, callback) {
      const timer = {
        deadlineMs: now + delayMs,
        callback,
        cancelled: false,
      };
      scheduled.push(timer);
      return () => { timer.cancelled = true; };
    },
    h1ExecutorOverrides: {
      resolve(request) {
        return {
          kind: "executable",
          adapterState: { resolvedTarget: request.sessionId },
          resolutionFence: {
            schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
            outcome: "positive",
            authority: request.authority,
            operation: request.operation,
            expectedScopeId: request.scopeId,
            expectedSessionId: request.sessionId,
            target: { sessionId: request.sessionId },
            evidence: { source: "managed-h1-rotation-test" },
          },
        };
      },
      executeTerminalControl(plan) {
        executions += 1;
        return {
          state: "succeeded",
          result: {
            pane: plan.arguments.pane,
            submit: plan.arguments.submit,
            messageUtf8Bytes: Buffer.byteLength(plan.arguments.message, "utf8"),
          },
        };
      },
    },
  });
  try {
    const lifecycleOwner =
      new shippingProcessLifecycle.RelayV2HostShippingProcessLifecycleOwner(
        h.composition,
        {
          signal: lifecycleStop.signal,
          requestIdFactory: () =>
            `managed-h1-lifecycle-${++lifecycleRequestSequence}`,
          monitorIntervalMs: 2,
          reconnectInitialDelayMs: 5,
          reconnectMaximumDelayMs: 10,
          wait(delayMs, signal) {
            const gate = deferred();
            let settled = false;
            const release = () => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", release);
              gate.resolve();
            };
            signal.addEventListener("abort", release, { once: true });
            if (signal.aborted) release();
            lifecycleWaits.push({ delayMs, release });
            return gate.promise;
          },
        },
      );
    lifecycleRun = lifecycleOwner.run();
    await settle(12);
    assert.equal(h.records.length, 1);
    const first = h.records[0];
    assert.notEqual(first.connection, null);
    const firstCut = h.composition.inspect();
    assert.equal(firstCut.status, "registered_incomplete");
    assert.equal(lifecycleWaits.length, 1);
    assert.equal(lifecycleWaits[0].delayMs, 2);

    const firstRoute = openRoute(first, "h1-first");
    const firstHello = fixture("client-hello-fresh");
    firstHello.hostId = HOST_ID;
    firstHello.payload.clientInstanceId =
      firstRoute.route.payload.authContext.clientInstanceId;
    sendClientFrame(firstRoute, firstHello);
    await settle();
    const firstWelcome = hostDataFrames(first).find(
      (frame) => frame.type === "host.welcome",
    );
    assert.notEqual(firstWelcome, undefined);
    const firstWindow = structuredClone(firstWelcome.payload.commandDedupeWindow);
    acknowledgeAll(first);

    const historical = fixture("command-execute-send-agent-message");
    historical.expectedHostEpoch = h.identity.hostEpoch;
    historical.requestId = "managed-h1-history-attempt";
    historical.commandId = "managed-h1-history-command";
    historical.payload.dedupeWindowId = firstWindow.windowId;
    sendClientFrame(firstRoute, historical);
    await settle();
    assert.equal(
      hostDataFrames(first).find(
        (frame) => frame.requestId === historical.requestId,
      )?.payload.state,
      "succeeded",
    );
    assert.equal(executions, 1);
    acknowledgeAll(first);

    const rotation = scheduled.find((timer) => !timer.cancelled);
    assert.notEqual(rotation, undefined);
    assert.equal(rotation.deadlineMs, firstWindow.acceptUntilMs - 60_000);
    now = rotation.deadlineMs;
    rotation.callback();
    await settle(8);

    assert.equal(first.transport.closes.length, 1);
    assert.deepEqual(h.composition.inspect(), {
      status: "failed",
      controllerGeneration: firstCut.controllerGeneration,
      connectorId: firstCut.connectorId,
      retryable: true,
    });
    assert.equal(h.records.length, 1, "shipping backoff owns successor creation");
    lifecycleWaits.shift().release();
    await settle(4);
    assert.equal(lifecycleWaits.length, 1);
    assert.equal(lifecycleWaits[0].delayMs, 5);
    lifecycleWaits.shift().release();
    await settle(16);

    assert.equal(h.records.length, 2, "shipping owner creates the successor attempt");
    const successor = h.records[1];
    assert.notEqual(successor.connection, null);
    const successorCut = h.composition.inspect();
    assert.equal(successorCut.status, "registered_incomplete");
    assert.notEqual(successorCut.controllerGeneration, firstCut.controllerGeneration);
    assert.equal(h.credentialActivity().reads, 2);

    const stale = fixture("command-execute-send-agent-message");
    stale.expectedHostEpoch = h.identity.hostEpoch;
    stale.requestId = "managed-h1-stale-route-attempt";
    stale.commandId = "managed-h1-stale-route-command";
    stale.payload.dedupeWindowId = firstWindow.windowId;
    const oldSent = first.transport.sent.length;
    sendClientFrame(firstRoute, stale);
    await settle();
    assert.equal(first.transport.sent.length, oldSent);
    assert.equal(executions, 1, "the retired route cannot re-enter H1");

    const secondRoute = openRoute(successor, "h1-successor");
    const secondHello = fixture("client-hello-fresh");
    secondHello.requestId = "managed-h1-successor-hello";
    secondHello.hostId = HOST_ID;
    secondHello.payload.clientInstanceId =
      secondRoute.route.payload.authContext.clientInstanceId;
    sendClientFrame(secondRoute, secondHello);
    await settle();
    const secondWindow = hostDataFrames(successor).find(
      (frame) => frame.type === "host.welcome",
    )?.payload.commandDedupeWindow;
    assert.notEqual(secondWindow, undefined);
    assert.notEqual(secondWindow.windowId, firstWindow.windowId);
    assert.equal(BigInt(secondWindow.windowSeq), BigInt(firstWindow.windowSeq) + 1n);
    acknowledgeAll(successor);

    const fresh = fixture("command-execute-send-agent-message");
    fresh.expectedHostEpoch = h.identity.hostEpoch;
    fresh.requestId = "managed-h1-fresh-attempt";
    fresh.commandId = "managed-h1-fresh-command";
    fresh.payload.dedupeWindowId = secondWindow.windowId;
    sendClientFrame(secondRoute, fresh);
    await settle();
    assert.equal(
      hostDataFrames(successor).find(
        (frame) => frame.requestId === fresh.requestId,
      )?.payload.state,
      "succeeded",
    );
    assert.equal(executions, 2);
    acknowledgeAll(successor);

    now = firstWindow.acceptUntilMs + 1;
    const expired = fixture("command-execute-send-agent-message");
    expired.expectedHostEpoch = h.identity.hostEpoch;
    expired.requestId = "managed-h1-expired-attempt";
    expired.commandId = "managed-h1-expired-command";
    expired.payload.dedupeWindowId = firstWindow.windowId;
    sendClientFrame(secondRoute, expired);
    await settle();
    assert.equal(
      hostDataFrames(successor).find(
        (frame) => frame.requestId === expired.requestId,
      )?.error.code,
      "COMMAND_WINDOW_EXPIRED",
    );
    assert.equal(executions, 2);
  } finally {
    lifecycleStop.abort();
    for (const waiter of lifecycleWaits.splice(0)) waiter.release();
    if (lifecycleRun !== null) await lifecycleRun.catch(() => undefined);
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
