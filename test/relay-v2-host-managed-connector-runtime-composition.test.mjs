import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const compositionModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const terminalDurable = await import("../dist/relay/v2/terminalDurableLineage.js");
const terminal = await import("../dist/relay/v2/terminalManager.js");

const HOST_ID = "mac-admin";
const CREDENTIAL_REFERENCE = "relay-v2-host-credential-ref:managed-primary";
const corpus = loadRelayV2FixtureCorpus();

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
  const transportLifecycleFactory = createTransportLifecycleFactory(options, records);
  let helloSequence = 0;
  let credentialReadCount = 0;
  composition = await compositionModule.openRelayV2HostManagedConnectorRuntimeComposition({
    runtime: {
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
    },
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
          prepareReauthentication() { throw new Error("unexpected reauthentication"); },
          acknowledgeReauthentication() { return false; },
        },
        idFactory: () => `managed-host-hello-${++helloSequence}`,
        clock: () => 1_783_700_100_000,
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

function stopInput(cut, requestId = "managed.stop") {
  return {
    requestId,
    controllerGeneration: cut.controllerGeneration,
    connectorId: cut.connectorId,
    signal: new AbortController().signal,
  };
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

test("managed composition bridges the exact actor route and projects empty capability registration", async () => {
  const h = await createHarness();
  try {
    const { result, record } = await startRegistered(h);
    assert.deepEqual(Reflect.ownKeys(record.input), [
      "requestId",
      "controllerGeneration",
      "hostId",
      "hostEpoch",
      "hostInstanceId",
      "credentialReference",
      "signal",
    ]);
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
    assert.deepEqual(Reflect.ownKeys(h.composition), [
      "inspect",
      "start",
      "stopAndDrain",
      "readiness",
      "sendTerminalFrame",
      "closeAndDrain",
    ]);
    for (const forbidden of [
      "actor", "transport", "factory", "sender", "routeSink", "routeOwner", "controller",
    ]) assert.equal(h.composition[forbidden], undefined);

    const pendingStart = h.composition.start(startInput("managed.pending"));
    await settle();
    assert.equal(h.composition.inspect().status, "starting");
    const firstClose = h.composition.closeAndDrain();
    const secondClose = h.composition.closeAndDrain();
    assert.equal(firstClose, secondClose);
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
        assert.deepEqual(Reflect.ownKeys(error), ["stack", "message", "code", "name"]);
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});
