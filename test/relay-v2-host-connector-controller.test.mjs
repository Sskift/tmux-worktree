import assert from "node:assert/strict";
import test from "node:test";

import {
  RelayV2HostConnectorController,
  RelayV2HostConnectorControllerError,
} from "../dist/relay/v2/hostConnectorController.js";
import {
  RelayV2DashboardManagementHostConnectorAdapter,
} from "../dist/relay/v2/relayV2DashboardManagementHostConnectorAdapter.js";
import {
  RelayV2DashboardManagementAuthority,
} from "../dist/relay/v2/relayV2DashboardManagementAuthority.js";

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

function startInput(requestId, signal = new AbortController().signal) {
  return { requestId, ...IDENTITY, signal };
}

function stopInput(cut, requestId = "controller.stop-one") {
  return {
    requestId,
    controllerGeneration: cut.controllerGeneration,
    connectorId: cut.connectorId,
    ...IDENTITY,
    signal: new AbortController().signal,
  };
}

function drainEvidence(input) {
  return {
    status: "closed_and_drained",
    controllerGeneration: input.controllerGeneration,
    carrierAttemptGeneration: input.carrierAttemptGeneration,
    carrierGeneration: input.carrierGeneration,
    connectorId: input.connectorId,
  };
}

function harness(options = {}) {
  const records = [];
  const attempts = Object.freeze({
    startAttempt(input) {
      const carrierAttemptGeneration = String(records.length + 1);
      const record = {
        input,
        emit: input.onCarrierStatus,
        fenceAttempt: input.onCarrierAttemptFenced,
        carrierAttemptGeneration,
        fenceCalls: [],
        drainCalls: [],
        drainGate: null,
        port: null,
      };
      const port = Object.freeze({
        fence(fenceInput) {
          record.fenceCalls.push(fenceInput);
          return fenceInput.controllerGeneration === input.controllerGeneration
            && fenceInput.carrierAttemptGeneration === carrierAttemptGeneration;
        },
        disposeAndDrain(drainInput) {
          record.drainCalls.push(drainInput);
          const finish = () => drainEvidence(drainInput);
          return record.drainGate === null
            ? finish()
            : record.drainGate.promise.then(finish);
        },
      });
      record.port = port;
      records.push(record);
      input.onCarrierAttemptPrepared({
        controllerGeneration: input.controllerGeneration,
        carrierAttemptGeneration,
      });
      return options.startAttempt ? options.startAttempt(record, port) : port;
    },
  });
  const controller = new RelayV2HostConnectorController({ attempts, ...IDENTITY });
  return { attempts, controller, records };
}

function emitConnecting(record, carrierGeneration = 1) {
  record.emit({
    phase: "connecting",
    generation: carrierGeneration,
    connectorId: null,
  });
}

function emitRegistered(
  record,
  connectorId = "broker-connector-one",
  carrierGeneration = 1,
) {
  record.emit({
    phase: "registered",
    generation: carrierGeneration,
    connectorId,
    disposition: "connected",
  });
}

async function registeredAttempt(
  h,
  requestId = "controller.start-one",
  connectorId = "broker-connector-one",
  carrierGeneration = 1,
) {
  const start = h.controller.start(startInput(requestId));
  const record = h.records.at(-1);
  emitRegistered(record, connectorId, carrierGeneration);
  const result = await start;
  return { record, result, cut: h.controller.inspectCut() };
}

function isControllerFailure(error, code, forbidden = null) {
  return error instanceof RelayV2HostConnectorControllerError
    && error.code === code
    && (forbidden === null || !`${error.name}:${error.message}`.includes(forbidden));
}

test("one generation owns one attempt and resolves only exact host.registered", async () => {
  const h = harness();
  assert.deepEqual(h.controller.inspectCut(), {
    status: "stopped",
    controllerGeneration: "0",
  });
  assert.deepEqual(Reflect.ownKeys(h.controller), []);
  for (const key of [
    "attempts",
    "attemptFactory",
    "startAttempt",
    "current",
    "generation",
    "pending",
    "#attemptFactory",
    "#current",
  ]) {
    assert.equal(Reflect.get(h.controller, key), undefined);
  }

  const first = h.controller.start(startInput("controller.start-one"));
  const duplicate = h.controller.start(startInput("controller.start-one"));
  const conflicting = h.controller.start(startInput("controller.start-two"));
  assert.equal(first, duplicate);
  await assert.rejects(conflicting, (error) => isControllerFailure(error, "BUSY"));
  assert.equal(h.records.length, 1);
  assert.equal(Object.values(h.controller).includes(h.attempts), false);
  assert.equal(Object.values(h.controller).includes(h.records[0].port), false);

  const starting = h.controller.inspectCut();
  assert.deepEqual(starting, {
    status: "starting",
    controllerGeneration: "1",
    connectorId: null,
    ...IDENTITY,
  });
  assert.equal(Object.isFrozen(starting), true);

  let settled = false;
  void first.then(() => { settled = true; });
  emitConnecting(h.records[0], 17);
  await nextTurn();
  assert.equal(settled, false, "socket progress cannot complete controller start");
  assert.deepEqual(starting, {
    status: "starting",
    controllerGeneration: "1",
    connectorId: null,
    ...IDENTITY,
  }, "an earlier inspect cut remains atomic");

  emitRegistered(h.records[0], "broker-connector-17", 17);
  assert.deepEqual(await first, {
    status: "started",
    requestId: "controller.start-one",
    controllerGeneration: "1",
    connectorId: "broker-connector-17",
    ...IDENTITY,
  });
  assert.deepEqual(h.controller.inspectCut(), {
    status: "registered",
    controllerGeneration: "1",
    connectorId: "broker-connector-17",
    ...IDENTITY,
    acknowledgement: "host.registered",
    negotiatedCapabilityIntersection: [],
  });
});

test("stop fences new work, disposes exactly once, and returns only after drain", async () => {
  const h = harness();
  const registered = await registeredAttempt(h);
  registered.record.drainGate = deferred();
  const input = stopInput(registered.cut);
  const first = h.controller.stopAndDrain(input);
  const retry = h.controller.stopAndDrain(input);

  await nextTurn();
  assert.equal(registered.record.drainCalls.length, 1);
  assert.deepEqual(registered.record.drainCalls[0], {
    controllerGeneration: "1",
    carrierAttemptGeneration: "1",
    carrierGeneration: 1,
    connectorId: "broker-connector-one",
  });
  assert.deepEqual(registered.record.fenceCalls, [registered.record.drainCalls[0]]);
  await assert.rejects(
    h.controller.start(startInput("controller.start-while-draining")),
    (error) => isControllerFailure(error, "BUSY"),
  );
  await assert.rejects(
    h.controller.start(startInput("controller.start-one")),
    (error) => isControllerFailure(error, "BUSY"),
  );
  let stopped = false;
  void first.then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false);

  registered.record.drainGate.resolve();
  assert.deepEqual(await first, {
    status: "stopped_and_drained",
    requestId: input.requestId,
    controllerGeneration: "1",
    connectorId: "broker-connector-one",
    ...IDENTITY,
  });
  await retry;
  await h.controller.stopAndDrain({ ...input, requestId: "controller.stop-retry" });
  assert.equal(registered.record.drainCalls.length, 1);
  assert.deepEqual(h.controller.inspectCut(), {
    status: "stopped",
    controllerGeneration: "1",
  });
});

test("an exact synchronous capability fence retires the attempt before drain", async () => {
  const h = harness();
  const registered = await registeredAttempt(h);
  registered.record.drainGate = deferred();

  registered.record.fenceAttempt({
    reason: "capability_withdrawn",
    controllerGeneration: registered.cut.controllerGeneration,
    carrierAttemptGeneration: registered.record.carrierAttemptGeneration,
    offerGeneration: "4",
  });

  assert.deepEqual(h.controller.inspectCut(), {
    status: "failed",
    retryable: true,
    controllerGeneration: "1",
    connectorId: "broker-connector-one",
    ...IDENTITY,
  });
  await nextTurn();
  assert.equal(registered.record.fenceCalls.length, 1);
  assert.equal(registered.record.drainCalls.length, 1);
  let retried = false;
  const retry = h.controller.start(startInput("controller.after-capability-fence"));
  void retry.then(() => { retried = true; });
  await nextTurn();
  assert.equal(retried, false);
  registered.record.drainGate.resolve();
  await nextTurn();
  emitRegistered(h.records[1], "broker-connector-after-fence", 2);
  assert.equal((await retry).controllerGeneration, "2");
});

test("old stop and callbacks cannot affect a replacement generation", async () => {
  const h = harness();
  const loser = await registeredAttempt(h, "controller.start-loser", "loser", 3);
  const loserStop = stopInput(loser.cut, "controller.stop-loser");
  await h.controller.stopAndDrain(loserStop);

  const winnerStart = h.controller.start(startInput("controller.start-winner"));
  const winnerRecord = h.records.at(-1);
  assert.equal(winnerRecord.input.controllerGeneration, "2");
  emitRegistered(winnerRecord, "winner", 4);
  await winnerStart;

  loser.record.emit({
    phase: "offline",
    generation: 3,
    connectorId: "loser",
    closeCode: 1006,
  });
  loser.record.emit({
    phase: "superseded",
    generation: 3,
    connectorId: "loser",
    closeCode: 4409,
  });
  await h.controller.stopAndDrain({ ...loserStop, requestId: "controller.late-loser-stop" });
  assert.deepEqual(h.controller.inspectCut(), {
    status: "registered",
    controllerGeneration: "2",
    connectorId: "winner",
    ...IDENTITY,
    acknowledgement: "host.registered",
    negotiatedCapabilityIntersection: [],
  });
  assert.equal(loser.record.drainCalls.length, 1);
  assert.equal(winnerRecord.drainCalls.length, 0);
});

test("unexpected offline is retryable but creates no attempt until explicit restart", async () => {
  const h = harness();
  const first = h.controller.start(startInput("controller.start-offline"));
  h.records[0].emit({
    phase: "offline",
    generation: 8,
    connectorId: null,
    closeCode: 1006,
  });
  await assert.rejects(first, (error) => isControllerFailure(error, "UNAVAILABLE"));
  assert.deepEqual(h.controller.inspectCut(), {
    status: "failed",
    retryable: true,
    controllerGeneration: "1",
    connectorId: null,
    ...IDENTITY,
  });
  await nextTurn();
  assert.equal(h.records.length, 1, "offline schedules neither backoff nor reconnect");

  const second = h.controller.start(startInput("controller.explicit-retry"));
  await nextTurn();
  assert.equal(h.records[0].drainCalls.length, 1);
  assert.equal(h.records.length, 2);
  assert.equal(h.records[1].input.controllerGeneration, "2");
  emitRegistered(h.records[1], "broker-connector-retry", 9);
  assert.equal((await second).connectorId, "broker-connector-retry");
});

test("superseded is irreversible and drains without a replacement", async () => {
  const h = harness();
  const start = h.controller.start(startInput("controller.start-superseded"));
  h.records[0].emit({
    phase: "superseded",
    generation: 12,
    connectorId: null,
    closeCode: 4409,
  });
  await assert.rejects(start, (error) => isControllerFailure(error, "SUPERSEDED"));
  await nextTurn();
  assert.equal(h.records[0].drainCalls.length, 1);
  assert.deepEqual(h.controller.inspectCut(), {
    status: "superseded",
    controllerGeneration: "1",
    connectorId: null,
    ...IDENTITY,
  });
  await assert.rejects(
    h.controller.start(startInput("controller.start-after-superseded")),
    (error) => isControllerFailure(error, "SUPERSEDED"),
  );
  await assert.rejects(
    h.controller.stopAndDrain(stopInput(h.controller.inspectCut())),
    (error) => isControllerFailure(error, "SUPERSEDED"),
  );
  h.records[0].emit({
    phase: "registered",
    generation: 12,
    connectorId: "late-registration",
    disposition: "connected",
  });
  assert.equal(h.controller.inspectCut().status, "superseded");
  assert.equal(h.records.length, 1);
});

test("empty controller capabilities project as registered_incomplete and cannot enroll", async () => {
  const h = harness();
  await registeredAttempt(h);
  const adapter = new RelayV2DashboardManagementHostConnectorAdapter({
    controller: h.controller,
    ...IDENTITY,
    signal: new AbortController().signal,
  });
  assert.deepEqual(await adapter.inspectCut(), {
    status: "registered",
    acknowledgement: "host.registered",
    hostId: IDENTITY.hostId,
    connectorId: "broker-connector-one",
    negotiatedCapabilityIntersection: [],
  });

  let enrollmentCalls = 0;
  const authority = new RelayV2DashboardManagementAuthority({
    credential: {
      inspect: () => ({
        status: "ready",
        hostId: IDENTITY.hostId,
        credentialReference: IDENTITY.credentialReference,
        expiresAtMs: 1_800_000_100_000,
      }),
      bootstrap: async () => {},
      refresh: async () => {},
    },
    connector: adapter,
    carrierControl: {
      createEnrollment: async () => {
        enrollmentCalls += 1;
        throw new Error("must not create enrollment");
      },
      revokeGrant: async () => {
        throw new Error("must not revoke grant");
      },
    },
    clock: () => 1_800_000_000_000,
  });
  const status = await authority.handle({
    protocolVersion: 2,
    requestId: "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw",
    operation: "status",
    input: null,
  });
  assert.equal(status.result.connector.status, "registered_incomplete");
  assert.deepEqual(status.result.connector.negotiatedCapabilityIntersection, []);
  const enrollment = await authority.handle({
    protocolVersion: 2,
    requestId: "dmgmt2.ocsJ9anwzHRz4iyXdA5cjA",
    operation: "create_enrollment",
    input: { deviceLabel: null },
  });
  assert.equal(enrollment.error.code, "NOT_READY");
  assert.equal(enrollmentCalls, 0);
});

test("abort, malformed output, unknown failure, and authority mismatch fail closed", async (t) => {
  const secret = "twref2.secret-must-not-reflect";

  await t.test("abort drains the attempt and exposes only a typed failure", async () => {
    const h = harness();
    const abort = new AbortController();
    const start = h.controller.start(startInput("controller.abort", abort.signal));
    abort.abort(secret);
    await assert.rejects(
      start,
      (error) => isControllerFailure(error, "ABORTED", secret),
    );
    assert.equal(h.records[0].drainCalls.length, 1);
    assert.equal(JSON.stringify(h.controller.inspectCut()).includes(secret), false);
  });

  await t.test("malformed carrier evidence poisons one attempt without retry", async () => {
    const h = harness();
    const start = h.controller.start(startInput("controller.malformed-status"));
    h.records[0].emit({
      phase: "registered",
      generation: 1,
      connectorId: "broker-connector-one",
      disposition: "connected",
      accessToken: secret,
    });
    await assert.rejects(
      start,
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    await nextTurn();
    assert.equal(h.records.length, 1);
    assert.equal(JSON.stringify(h.controller.inspectCut()).includes(secret), false);
  });

  await t.test("malformed attempt output has no trusted drain or fallback path", async () => {
    const h = harness({
      startAttempt(_record, port) {
        return { ...port, refreshToken: secret };
      },
    });
    await assert.rejects(
      h.controller.start(startInput("controller.malformed-attempt")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].drainCalls.length, 0);
  });

  await t.test("unknown attempt failure is redacted and does not retry", async () => {
    const h = harness({
      startAttempt() {
        throw new Error(secret);
      },
    });
    await assert.rejects(
      h.controller.start(startInput("controller.unknown-failure")),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    await nextTurn();
    assert.equal(h.records.length, 1);
  });

  await t.test("foreign authority is rejected before any attempt", async () => {
    const h = harness();
    await assert.rejects(
      h.controller.start({
        ...startInput("controller.foreign-authority"),
        hostInstanceId: "foreign-instance",
      }),
      (error) => isControllerFailure(error, "OPERATION_FAILED", secret),
    );
    assert.equal(h.records.length, 0);
    assert.deepEqual(h.controller.inspectCut(), {
      status: "stopped",
      controllerGeneration: "0",
    });
  });
});
