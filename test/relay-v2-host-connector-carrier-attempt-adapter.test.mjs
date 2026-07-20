import assert from "node:assert/strict";
import test from "node:test";

import {
  RelayV2HostCarrierActor,
} from "../dist/relay/v2/hostCarrier.js";
import {
  RelayV2HostConnectorCarrierAttemptAdapter,
  RelayV2HostConnectorCarrierAttemptAdapterError,
  RelayV2HostConnectorCarrierAttemptDrainHandle,
} from "../dist/relay/v2/hostConnectorCarrierAttemptAdapter.js";
import {
  RelayV2HostConnectorController,
  RelayV2HostConnectorControllerError,
} from "../dist/relay/v2/hostConnectorController.js";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "../dist/relay/v2/codec.js";

const IDENTITY = Object.freeze({
  hostId: "mac-admin",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
  credentialReference: "relay-v2-host-credential-ref:primary",
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

function wire(frame) {
  return encodeRelayV2WebSocketFrame("carrier", frame);
}

function decode(frame) {
  return decodeRelayV2WebSocketFrame("carrier", frame).frame;
}

function startInput(requestId) {
  return {
    requestId,
    ...IDENTITY,
    signal: new AbortController().signal,
  };
}

function stopInput(cut, requestId = "adapter.stop") {
  return {
    requestId,
    controllerGeneration: cut.controllerGeneration,
    connectorId: cut.connectorId,
    ...IDENTITY,
    signal: new AbortController().signal,
  };
}

function registeredFrame(hello, connectorId) {
  return wire({
    carrierVersion: 1,
    type: "host.registered",
    requestId: hello.requestId,
    connectorId,
    payload: {
      brokerEpoch: "broker-process-one",
      hostsRevision: "1",
      disposition: "connected",
      supersededHostInstanceId: null,
      limits: {
        maxCarrierFrameBytes: 1_500_000,
        brokerCarrierBufferedBytes: 16_777_216,
        brokerCarrierLowWaterBytes: 8_388_608,
      },
    },
  });
}

function supersededFrame(connectorId) {
  return wire({
    carrierVersion: 1,
    type: "host.superseded",
    connectorId,
    payload: {
      hostId: IDENTITY.hostId,
      losingConnectorId: connectorId,
      winningConnectorId: "new-winning-connector",
      losingHostInstanceId: IDENTITY.hostInstanceId,
      winningHostInstanceId: "new-winning-process",
      reason: "new_authenticated_connector",
    },
  });
}

class FakeTransport {
  sent = [];
  closes = [];

  trySend(frame) {
    this.sent.push(Uint8Array.from(frame));
    return true;
  }

  bufferedAmount() {
    return 0;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

function actorFor(input, sequence) {
  return new RelayV2HostCarrierActor({
    hostId: input.hostId,
    hostEpoch: input.hostEpoch,
    hostInstanceId: input.hostInstanceId,
    credentialReferences: {
      read(reference) {
        return {
          reference,
          version: "1",
          grantId: "host-grant-one",
          accessJti: "host-access-one",
          accessToken: "twcap2.header.payload.mac",
        };
      },
    },
    advertisedCapabilities: [],
    routeSink: {
      onRouteBound() {},
      onClientFrame() {},
      onRouteUnbound() {},
    },
    idFactory: () => `host-hello-${sequence}`,
    onStatus: input.onCarrierStatus,
  });
}

function harness(options = {}) {
  const records = [];
  const factory = Object.freeze({
    createAttempt(input) {
      const sequence = records.length + 1;
      const transport = options.transport?.(sequence) ?? new FakeTransport();
      const drainGate = options.manualDrain ? deferred() : null;
      const record = {
        sequence,
        input,
        actor: null,
        transport,
        connection: null,
        hello: null,
        drainGate,
        drainCalls: 0,
        drainProofs: [],
        handle: null,
      };
      const actor = options.actor?.(input, sequence) ?? actorFor(input, sequence);
      record.actor = actor;
      const handle = new RelayV2HostConnectorCarrierAttemptDrainHandle(Object.freeze({
        transport,
        bindConnection(connection) {
          record.connection = connection;
          record.hello = decode(transport.sent[0]);
          if (options.onBind) options.onBind(record);
          else if (options.autoRegister !== false) {
            connection.receive(registeredFrame(record.hello, `connector-${sequence}`));
          }
        },
        awaitDrained(proof) {
          record.drainCalls += 1;
          record.drainProofs.push(proof);
          if (options.awaitDrained) return options.awaitDrained(record, proof);
          return drainGate === null
            ? Promise.resolve(proof)
            : drainGate.promise.then(() => proof);
        },
      }));
      record.handle = handle;
      records.push(record);
      options.beforeReturn?.(record);
      const result = options.result?.(record) ?? Object.freeze({ actor, transport, drainHandle: handle });
      if (options.factoryGate) return options.factoryGate.promise.then(() => result);
      if (options.factoryError) throw options.factoryError;
      return result;
    },
  });
  const attempts = new RelayV2HostConnectorCarrierAttemptAdapter(Object.freeze({ factory }));
  const controller = new RelayV2HostConnectorController(Object.freeze({
    attempts,
    ...IDENTITY,
  }));
  return { attempts, controller, factory, records };
}

function isControllerFailure(error, code, forbidden = null) {
  return error instanceof RelayV2HostConnectorControllerError
    && error.code === code
    && (forbidden === null || !`${error.name}:${error.message}`.includes(forbidden));
}

test("one controller generation creates one actor attempt and connecting cannot register", async () => {
  const h = harness({ autoRegister: false });
  const start = h.controller.start(startInput("adapter.start-one"));
  await nextTurn();

  assert.equal(h.records.length, 1);
  assert.deepEqual(h.controller.inspectCut(), {
    status: "starting",
    controllerGeneration: "1",
    connectorId: null,
    ...IDENTITY,
  });
  let settled = false;
  void start.then(() => { settled = true; });
  await nextTurn();
  assert.equal(settled, false, "HostCarrier connecting is not registration evidence");

  const record = h.records[0];
  record.connection.receive(registeredFrame(record.hello, "connector-canonical"));
  assert.deepEqual(await start, {
    status: "started",
    requestId: "adapter.start-one",
    controllerGeneration: "1",
    connectorId: "connector-canonical",
    ...IDENTITY,
  });

  const cut = h.controller.inspectCut();
  await h.controller.stopAndDrain(stopInput(cut));
  assert.equal(record.drainCalls, 1);
  assert.deepEqual(record.transport.closes, [{ code: 1000, reason: "host_shutdown" }]);
});

test("synchronous canonical registration is retained before the attempt factory promise settles", async () => {
  const h = harness();
  const start = h.controller.start(startInput("adapter.start-sync-registration"));

  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].actor.status().phase, "registered");
  assert.equal(
    h.controller.inspectCut().status,
    "starting",
    "controller waits for the adapter port even after observing canonical registration",
  );
  assert.equal((await start).connectorId, "connector-1");
  assert.equal(h.records.length, 1);
});

test("stop while the injected factory is pending waits for that exact transport drain", async () => {
  const factoryGate = deferred();
  const h = harness({ factoryGate, manualDrain: true });
  const start = h.controller.start(startInput("adapter.start-pending"));
  const cut = h.controller.inspectCut();
  const stop = h.controller.stopAndDrain(stopInput(cut, "adapter.stop-pending"));
  await assert.rejects(start, (error) => isControllerFailure(error, "ABORTED"));

  let stopped = false;
  void stop.then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false);
  assert.equal(h.records[0].transport.closes.length, 0);

  factoryGate.resolve();
  await nextTurn();
  assert.equal(h.records[0].drainCalls, 1);
  assert.deepEqual(h.records[0].transport.closes, [{ code: 1000, reason: "host_shutdown" }]);
  assert.equal(stopped, false, "transport close is not drain evidence");

  h.records[0].drainGate.resolve();
  assert.deepEqual(await stop, {
    status: "stopped_and_drained",
    requestId: "adapter.stop-pending",
    controllerGeneration: "1",
    connectorId: null,
    ...IDENTITY,
  });
  assert.equal(h.records[0].transport.closes.length, 1);
});

test("a replacement winner ignores every late callback from the drained attempt", async () => {
  const h = harness();
  await h.controller.start(startInput("adapter.start-loser"));
  const loserCut = h.controller.inspectCut();
  await h.controller.stopAndDrain(stopInput(loserCut, "adapter.stop-loser"));

  await h.controller.start(startInput("adapter.start-winner"));
  const winnerCut = h.controller.inspectCut();
  assert.equal(winnerCut.controllerGeneration, "2");
  assert.equal(winnerCut.connectorId, "connector-2");

  const oldCallback = h.records[0].input.onCarrierStatus;
  oldCallback({
    phase: "offline",
    generation: 1,
    connectorId: "connector-1",
    closeCode: 1006,
  });
  oldCallback({
    phase: "superseded",
    generation: 1,
    connectorId: "connector-1",
    closeCode: 4409,
  });
  oldCallback({
    phase: "registered",
    generation: 1,
    connectorId: "late-loser",
    disposition: "connected",
  });
  assert.deepEqual(h.controller.inspectCut(), winnerCut);
  assert.equal(h.records[0].transport.closes.length, 1);
  assert.equal(h.records[1].transport.closes.length, 0);
});

test("offline creates no timer and an explicit retry owns a new controller generation", async () => {
  const h = harness();
  await h.controller.start(startInput("adapter.start-offline"));
  h.records[0].connection.closed(1006);
  assert.deepEqual(h.controller.inspectCut(), {
    status: "failed",
    retryable: true,
    controllerGeneration: "1",
    connectorId: "connector-1",
    ...IDENTITY,
  });
  await nextTurn();
  assert.equal(h.records.length, 1, "offline does not create retry work");

  const retry = h.controller.start(startInput("adapter.explicit-retry"));
  assert.equal((await retry).connectorId, "connector-2");
  assert.deepEqual(h.records.map((record) => record.input.controllerGeneration), ["1", "2"]);
  assert.equal(h.records[0].drainCalls, 1);
  assert.equal(h.records[0].transport.closes.length, 1);
});

test("canonical superseded is terminal, drains once, and never creates a replacement", async () => {
  const h = harness();
  await h.controller.start(startInput("adapter.start-superseded"));
  h.records[0].connection.receive(supersededFrame("connector-1"));
  await nextTurn();

  assert.deepEqual(h.controller.inspectCut(), {
    status: "superseded",
    controllerGeneration: "1",
    connectorId: "connector-1",
    ...IDENTITY,
  });
  assert.equal(h.records[0].drainCalls, 1);
  assert.equal(h.records[0].transport.closes.length, 1);
  await assert.rejects(
    h.controller.start(startInput("adapter.start-after-superseded")),
    (error) => isControllerFailure(error, "SUPERSEDED"),
  );
  assert.equal(h.records.length, 1);
});

test("malformed factory products and uncertain drain proofs fail closed with redacted errors", async (t) => {
  const secret = "twref2.secret-must-not-reflect";

  await t.test("factory throw", async () => {
    const h = harness({ factoryError: new Error(secret) });
    await assert.rejects(
      h.controller.start(startInput("adapter.factory-throw")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records.length, 1);
  });

  await t.test("foreign actor", async () => {
    const h = harness({
      result(record) {
        return Object.freeze({
          actor: Object.freeze({ secret }),
          transport: record.transport,
          drainHandle: record.handle,
        });
      },
    });
    await assert.rejects(
      h.controller.start(startInput("adapter.foreign-actor")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records[0].transport.closes.length, 1);
  });

  await t.test("factory callback cannot impersonate canonical registration", async () => {
    const h = harness({
      beforeReturn(record) {
        record.input.onCarrierStatus({
          phase: "registered",
          generation: 1,
          connectorId: "spoofed-connector",
          disposition: "connected",
          secret,
        });
      },
    });
    await assert.rejects(
      h.controller.start(startInput("adapter.spoofed-registration")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records[0].actor.status(), null);
    assert.equal(h.records[0].transport.closes.length, 1);
  });

  await t.test("accessor transport", async () => {
    const malformed = {};
    Object.defineProperties(malformed, {
      trySend: { get() { throw new Error(secret); } },
      bufferedAmount: { value: () => 0 },
      close: { value: () => {} },
    });
    const h = harness({ transport: () => malformed });
    await assert.rejects(
      h.controller.start(startInput("adapter.malformed-transport")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
  });

  await t.test("foreign drain handle", async () => {
    const h = harness({
      result(record) {
        return Object.freeze({
          actor: record.actor,
          transport: record.transport,
          drainHandle: Object.freeze({ secret }),
        });
      },
    });
    await assert.rejects(
      h.controller.start(startInput("adapter.foreign-drain")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records[0].transport.closes.length, 1);
  });

  await t.test("foreign drain proof", async () => {
    const h = harness({
      awaitDrained() {
        return Promise.resolve(Object.freeze({ secret }));
      },
    });
    await h.controller.start(startInput("adapter.foreign-proof"));
    await assert.rejects(
      h.controller.stopAndDrain(stopInput(h.controller.inspectCut())),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records[0].drainCalls, 1);
    assert.equal(h.records[0].transport.closes.length, 1);
  });

  await t.test("Promise-subclass drain uncertainty", async () => {
    class ForeignPromise extends Promise {
      then() {
        throw new Error(secret);
      }
    }
    const h = harness({
      awaitDrained(_record, proof) {
        return new ForeignPromise((resolve) => resolve(proof));
      },
    });
    await h.controller.start(startInput("adapter.uncertain-drain"));
    await assert.rejects(
      h.controller.stopAndDrain(stopInput(h.controller.inspectCut())),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
  });
});

test("ordinary reflection cannot recover factory, actor, transport, callbacks, or drain authority", async () => {
  const h = harness({ autoRegister: false });
  assert.deepEqual(Reflect.ownKeys(h.attempts), ["startAttempt"]);
  for (const key of [
    "factory", "actor", "transport", "connection", "drainHandle", "onCarrierStatus",
    "send", "receive", "getActor", "getTransport", "debug", "toJSON",
  ]) assert.equal(Reflect.get(h.attempts, key), undefined);

  const statuses = [];
  const attempt = await h.attempts.startAttempt(Object.freeze({
    requestId: "adapter.reflect",
    controllerGeneration: "1",
    ...IDENTITY,
    signal: new AbortController().signal,
    onCarrierStatus: (status) => statuses.push(status),
  }));
  assert.deepEqual(Reflect.ownKeys(attempt), ["disposeAndDrain"]);
  assert.equal(statuses.at(-1).phase, "connecting");
  for (const key of [
    "actor", "transport", "connection", "drainHandle", "onCarrierStatus",
    "send", "receive", "getActor", "getTransport", "debug", "toJSON",
  ]) assert.equal(Reflect.get(attempt, key), undefined);
  assert.deepEqual(Reflect.ownKeys(h.records[0].handle), []);
  assert.equal(Reflect.get(h.records[0].handle, "transport"), undefined);
  assert.equal(RelayV2HostConnectorCarrierAttemptDrainHandle.matches(
    undefined,
    h.records[0].handle,
    h.records[0].transport,
  ), false);
  assert.throws(() => RelayV2HostConnectorCarrierAttemptDrainHandle.bind(
    undefined,
    h.records[0].handle,
    h.records[0].transport,
    h.records[0].connection,
  ), RelayV2HostConnectorCarrierAttemptAdapterError);
  await assert.rejects(
    RelayV2HostConnectorCarrierAttemptDrainHandle.drain(
      undefined,
      h.records[0].handle,
      h.records[0].transport,
    ),
    RelayV2HostConnectorCarrierAttemptAdapterError,
  );

  await attempt.disposeAndDrain(Object.freeze({
    controllerGeneration: "1",
    carrierGeneration: 1,
    connectorId: null,
  }));
});

test("direct adapter failures expose one fixed non-sensitive error", async () => {
  const secret = "twref2.direct-secret";
  const h = harness({ factoryError: new Error(secret) });
  await assert.rejects(
    h.attempts.startAttempt(Object.freeze({
      requestId: "adapter.direct-failure",
      controllerGeneration: "1",
      ...IDENTITY,
      signal: new AbortController().signal,
      onCarrierStatus() {},
    })),
    (error) => error instanceof RelayV2HostConnectorCarrierAttemptAdapterError
      && !`${error.name}:${error.message}`.includes(secret),
  );
});
