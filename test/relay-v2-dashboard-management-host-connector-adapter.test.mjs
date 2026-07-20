import assert from "node:assert/strict";
import test from "node:test";

import {
  RelayV2DashboardManagementHostConnectorAdapter,
  RelayV2DashboardManagementHostConnectorAdapterClosedError,
  RelayV2DashboardManagementHostConnectorControllerError,
} from "../dist/relay/v2/relayV2DashboardManagementHostConnectorAdapter.js";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES,
} from "../dist/relay/v2/relayV2DashboardManagementProtocolV2.js";

const REQUIRED = Object.freeze([
  ...RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES,
]);
const BINDING = Object.freeze({
  hostId: "mac-admin",
  hostEpoch: "host-epoch-one",
  hostInstanceId: "host-instance-one",
  credentialReference: "relay-v2-host-credential-ref:primary",
});
const START_ONE = Object.freeze({ requestId: "dmgmt2.start-one" });
const START_TWO = Object.freeze({ requestId: "dmgmt2.start-two" });
const STOP_ONE = Object.freeze({ requestId: "dmgmt2.stop-one" });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function binding(controllerGeneration = "1", connectorId = "connector-one") {
  return { controllerGeneration, connectorId, ...BINDING };
}

function registeredCut(
  controllerGeneration = "1",
  connectorId = "connector-one",
  capabilities = REQUIRED,
) {
  return {
    status: "registered",
    ...binding(controllerGeneration, connectorId),
    acknowledgement: "host.registered",
    negotiatedCapabilityIntersection: [...capabilities],
  };
}

function startingCut(controllerGeneration = "1", connectorId = "connector-one") {
  return { status: "starting", ...binding(controllerGeneration, connectorId) };
}

function startResult(
  requestId = START_ONE.requestId,
  controllerGeneration = "1",
  connectorId = "connector-one",
) {
  return {
    status: "started",
    requestId,
    ...binding(controllerGeneration, connectorId),
  };
}

function stopResult(
  requestId = STOP_ONE.requestId,
  controllerGeneration = "1",
  connectorId = "connector-one",
) {
  return {
    status: "stopped_and_drained",
    requestId,
    ...binding(controllerGeneration, connectorId),
  };
}

function harness(options = {}) {
  const signal = options.signal ?? new AbortController().signal;
  let cut = structuredClone(options.cut ?? { status: "stopped", controllerGeneration: "0" });
  const calls = { inspect: 0, start: [], stop: [] };
  let startImpl = options.start ?? ((input) => startResult(input.requestId));
  let stopImpl = options.stop ?? ((input) => stopResult(
    input.requestId,
    input.controllerGeneration,
    input.connectorId,
  ));
  const controller = {
    inspectCut() {
      calls.inspect += 1;
      if (options.inspect) return options.inspect(cut, calls.inspect);
      return structuredClone(cut);
    },
    start(input) {
      calls.start.push(input);
      return startImpl(input);
    },
    stopAndDrain(input) {
      calls.stop.push(input);
      return stopImpl(input);
    },
  };
  const adapter = new RelayV2DashboardManagementHostConnectorAdapter({
    controller,
    ...BINDING,
    signal,
  });
  return {
    adapter,
    calls,
    controller,
    signal,
    setCut(value) { cut = structuredClone(value); },
    setStart(value) { startImpl = value; },
    setStop(value) { stopImpl = value; },
  };
}

function isAuthorityFailure(error, code) {
  return error?.name === "RelayV2DashboardManagementAuthorityFailure"
    && error.code === code;
}

test("inspectCut consumes one atomic controller cut and canonicalizes only the frozen subset", async () => {
  const cut = registeredCut("7", "connector-seven", [...REQUIRED].reverse());
  const gate = deferred();
  let firstInspection = true;
  const h = harness({
    cut,
    inspect(current) {
      if (!firstInspection) return structuredClone(current);
      firstInspection = false;
      return gate.promise;
    },
  });
  let settled = false;
  const pendingProjection = h.adapter.inspectCut().then((value) => {
    settled = true;
    return value;
  });

  assert.equal(h.calls.inspect, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve(cut);
  const projection = await pendingProjection;
  assert.deepEqual(projection, {
    status: "registered",
    acknowledgement: "host.registered",
    hostId: BINDING.hostId,
    connectorId: "connector-seven",
    negotiatedCapabilityIntersection: REQUIRED,
  });
  assert.equal(JSON.stringify(projection).includes("twcap2."), false);
  assert.equal(JSON.stringify(projection).includes("twref2."), false);

  h.setCut(registeredCut("8", "connector-eight", REQUIRED.slice(0, 5).reverse()));
  assert.deepEqual(await h.adapter.inspectCut(), {
    status: "registered",
    acknowledgement: "host.registered",
    hostId: BINDING.hostId,
    connectorId: "connector-eight",
    negotiatedCapabilityIntersection: REQUIRED.slice(0, 5),
  });
  assert.equal(h.calls.inspect, 2, "each projection consumes exactly one atomic cut");
});

test("the adapter captures one controller and rejects foreign lineage, generation, and connector cuts", async (t) => {
  await t.test("captured controller method cannot be replaced", async () => {
    const h = harness({ cut: startingCut("1", "captured-connector") });
    let replacementCalls = 0;
    h.controller.inspectCut = () => {
      replacementCalls += 1;
      return startingCut("99", "foreign-connector");
    };
    assert.deepEqual(await h.adapter.inspectCut(), {
      status: "starting",
      hostId: BINDING.hostId,
    });
    assert.equal(replacementCalls, 0);
    assert.equal(h.calls.inspect, 1);
  });

  for (const [name, changed] of [
    ["hostId", { hostId: "foreign-host" }],
    ["hostEpoch", { hostEpoch: "foreign-epoch" }],
    ["hostInstanceId", { hostInstanceId: "foreign-instance" }],
    ["credentialReference", {
      credentialReference: "relay-v2-host-credential-ref:foreign",
    }],
  ]) {
    await t.test(`foreign ${name}`, async () => {
      const h = harness({ cut: { ...startingCut(), ...changed } });
      await assert.rejects(
        h.adapter.inspectCut(),
        RelayV2DashboardManagementHostConnectorAdapterClosedError,
      );
    });
  }

  await t.test("generation regression", async () => {
    const h = harness({ cut: registeredCut("3", "connector-three") });
    await h.adapter.inspectCut();
    h.setCut(registeredCut("2", "connector-two"));
    await assert.rejects(
      h.adapter.inspectCut(),
      RelayV2DashboardManagementHostConnectorAdapterClosedError,
    );
  });

  await t.test("same-generation connector replacement", async () => {
    const h = harness({ cut: registeredCut("3", "connector-three") });
    await h.adapter.inspectCut();
    h.setCut(registeredCut("3", "foreign-connector"));
    await assert.rejects(
      h.adapter.inspectCut(),
      RelayV2DashboardManagementHostConnectorAdapterClosedError,
    );
  });
});

test("only exact host.registered evidence can produce a registered cut", async (t) => {
  assert.deepEqual(await harness({ cut: startingCut() }).adapter.inspectCut(), {
    status: "starting",
    hostId: BINDING.hostId,
  });

  const malformed = [
    { ...startingCut(), connected: true },
    { ...startingCut(), socketOpen: true },
    { ...registeredCut(), acknowledgement: "host.connected" },
    { ...registeredCut(), token: "twcap2.forbidden" },
    { ...registeredCut(), negotiatedCapabilityIntersection: [...REQUIRED, "unknown.v1"] },
  ];
  for (const [index, cut] of malformed.entries()) {
    await t.test(`malformed evidence ${index + 1}`, async () => {
      const h = harness({ cut });
      await assert.rejects(
        h.adapter.inspectCut(),
        (error) => error instanceof RelayV2DashboardManagementHostConnectorAdapterClosedError
          && !error.message.includes("twcap2.forbidden"),
      );
      await assert.rejects(
        h.adapter.inspectCut(),
        RelayV2DashboardManagementHostConnectorAdapterClosedError,
      );
      assert.equal(h.calls.inspect, 1, "malformed output poisons without restart");
    });
  }
});

test("one pending start request shares its exact promise and controller attempt", async () => {
  const gate = deferred();
  const h = harness({ start: () => gate.promise });

  const first = h.adapter.start(START_ONE);
  const duplicate = h.adapter.start(START_ONE);
  const conflicting = h.adapter.start(START_TWO);

  assert.equal(first, duplicate);
  await assert.rejects(conflicting, (error) => isAuthorityFailure(error, "BUSY"));
  assert.equal(h.calls.start.length, 1);
  assert.deepEqual(
    { ...h.calls.start[0], signal: undefined },
    {
      requestId: START_ONE.requestId,
      ...BINDING,
      signal: undefined,
    },
  );
  assert.equal(h.calls.start[0].signal, h.signal, "the original AbortSignal is passed through");

  let settled = false;
  first.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the adapter adds no timeout to the owner attempt");
  gate.resolve(startResult());
  await Promise.all([first, duplicate]);
  assert.equal(settled, true);
  assert.equal(h.calls.start.length, 1);
});

test("stop uses the captured generation and connector and waits exact drain", async (t) => {
  await t.test("replacement fences a late loser result without touching the winner", async () => {
    const gate = deferred();
    const h = harness({
      cut: registeredCut("7", "loser-connector"),
      stop: () => gate.promise,
    });
    const stop = h.adapter.stop(STOP_ONE);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.stop.length, 1);
    assert.equal(h.calls.stop[0].controllerGeneration, "7");
    assert.equal(h.calls.stop[0].connectorId, "loser-connector");
    assert.equal(h.calls.stop[0].signal, h.signal);

    h.setCut(registeredCut("8", "winner-connector"));
    assert.equal((await h.adapter.inspectCut()).connectorId, "winner-connector");
    gate.resolve(stopResult(STOP_ONE.requestId, "7", "loser-connector"));
    await assert.rejects(stop, (error) => isAuthorityFailure(error, "NOT_READY"));
    assert.equal((await h.adapter.inspectCut()).connectorId, "winner-connector");
    assert.equal(h.calls.stop.length, 1, "the adapter never restarts a fenced stop");
  });

  await t.test("success is withheld until stop-and-drain settles", async () => {
    const gate = deferred();
    const h = harness({
      cut: registeredCut("9", "draining-connector"),
      stop: () => gate.promise,
    });
    let settled = false;
    const stop = h.adapter.stop(STOP_ONE).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    gate.resolve(stopResult(STOP_ONE.requestId, "9", "draining-connector"));
    await stop;
    assert.equal(settled, true);
    assert.equal(h.calls.stop.length, 1);
  });
});

test("controller failures map one-for-one and malformed output closes without fallback", async (t) => {
  const mappings = Object.freeze({
    ABORTED: "OPERATION_FAILED",
    BUSY: "BUSY",
    UNAVAILABLE: "UNAVAILABLE",
    SUPERSEDED: "NOT_READY",
    OPERATION_FAILED: "OPERATION_FAILED",
  });
  for (const [controllerCode, protocolCode] of Object.entries(mappings)) {
    await t.test(controllerCode, async () => {
      const h = harness({
        start: () => Promise.reject(
          new RelayV2DashboardManagementHostConnectorControllerError(controllerCode),
        ),
      });
      await assert.rejects(
        h.adapter.start(START_ONE),
        (error) => isAuthorityFailure(error, protocolCode),
      );
      assert.equal(h.calls.start.length, 1);
    });
  }

  await t.test("unknown failure", async () => {
    const marker = "twref2.secret-must-not-reflect";
    const h = harness({ start: () => Promise.reject(new Error(marker)) });
    await assert.rejects(
      h.adapter.start(START_ONE),
      (error) => error instanceof RelayV2DashboardManagementHostConnectorAdapterClosedError
        && !error.message.includes(marker),
    );
    assert.throws(
      () => h.adapter.start(START_ONE),
      RelayV2DashboardManagementHostConnectorAdapterClosedError,
    );
    assert.equal(h.calls.start.length, 1);
  });

  await t.test("malformed result", async () => {
    const h = harness({
      start: () => ({ ...startResult(), token: "twcap2.must-not-reflect" }),
    });
    await assert.rejects(
      h.adapter.start(START_ONE),
      (error) => error instanceof RelayV2DashboardManagementHostConnectorAdapterClosedError
        && !error.message.includes("twcap2.must-not-reflect"),
    );
    assert.throws(
      () => h.adapter.start(START_ONE),
      RelayV2DashboardManagementHostConnectorAdapterClosedError,
    );
    assert.equal(h.calls.start.length, 1);
  });
});
