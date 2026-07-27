import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { build } = createRequire(import.meta.url)("esbuild");

const sourcePath = new URL(
  "../src/relay/v2/hostShippingProcessLifecycle.ts",
  import.meta.url,
).pathname;

const plugin = {
  name: "host-shipping-process-lifecycle-fixture",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^\.\/hostCarrier\.js$/ }, () => ({
      path: "hostCarrier",
      namespace: "host-process-lifecycle-stub",
    }));
    esbuild.onLoad(
      { filter: /.*/, namespace: "host-process-lifecycle-stub" },
      () => ({
        contents: "export const RELAY_V2_HOST_SUPERSEDED_EXIT_CODE = 78;",
        loader: "js",
      }),
    );
  },
};

const compiled = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [plugin],
});
const lifecycle = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

function retryThenSupersedeHandle() {
  let inspection = Object.freeze({
    status: "stopped",
    controllerGeneration: "0",
  });
  const events = [];
  let attempt = 0;
  const handle = {
    hostInstanceId: "host-instance-retained-by-one-handle",
    inspect() {
      return inspection;
    },
    async start(input) {
      attempt += 1;
      events.push(["start", attempt, this, input]);
      if (attempt === 1) {
        inspection = Object.freeze({
          status: "registered_incomplete",
          controllerGeneration: "1",
          connectorId: "connector-1",
          acknowledgement: "host.registered",
          negotiatedCapabilityIntersection: Object.freeze([]),
        });
        return { status: "started" };
      }
      inspection = Object.freeze({
        status: "registered_incomplete",
        controllerGeneration: "2",
        connectorId: "connector-2",
        acknowledgement: "host.registered",
        negotiatedCapabilityIntersection: Object.freeze([]),
      });
      return { status: "started" };
    },
    async stopAndDrain(input) {
      events.push(["stopAndDrain", input]);
      const error = new Error("superseded");
      error.code = "SUPERSEDED";
      throw error;
    },
    async closeAndDrain() {
      events.push(["closeAndDrain"]);
    },
  };
  return {
    events,
    handle,
    setRetryableOffline() {
      inspection = Object.freeze({
        status: "failed",
        controllerGeneration: "1",
        connectorId: "connector-1",
        retryable: true,
      });
    },
    setSuperseded() {
      inspection = Object.freeze({
        status: "superseded",
        controllerGeneration: "2",
        connectorId: "connector-2",
      });
    },
  };
}

test("Relay v2 Host normal process lifecycle starts, retries one retained handle, and drains terminal states", async () => {
  const retry = retryThenSupersedeHandle();
  const waits = [];
  const ids = ["start-1", "start-2", "stop-1"];
  const owner = new lifecycle.RelayV2HostShippingProcessLifecycleOwner(
    retry.handle,
    {
      requestIdFactory: () => ids.shift(),
      monitorIntervalMs: 2,
      reconnectInitialDelayMs: 5,
      reconnectMaximumDelayMs: 10,
      wait: async (delayMs) => {
        waits.push(delayMs);
        if (waits.length === 1) retry.setRetryableOffline();
        if (waits.length === 3) retry.setSuperseded();
      },
    },
  );
  const run = owner.run();
  assert.strictEqual(owner.run(), run, "the process owner is one-shot");
  assert.deepEqual(await run, { status: "superseded", exitCode: 78 });
  assert.deepEqual(waits, [2, 5, 2]);
  const starts = retry.events.filter(([name]) => name === "start");
  assert.equal(starts.length, 2);
  assert.ok(starts.every(([, , receiver]) => receiver === retry.handle));
  assert.deepEqual(
    starts.map(([, attempt, , input]) => [attempt, input.requestId]),
    [[1, "start-1"], [2, "start-2"]],
  );
  assert.deepEqual(retry.events.at(-2), [
    "stopAndDrain",
    {
      requestId: "stop-1",
      controllerGeneration: "2",
      connectorId: "connector-2",
      signal: retry.events.at(-2)[1].signal,
    },
  ]);
  assert.equal(retry.events.at(-2)[1].signal.aborted, false);
  assert.deepEqual(retry.events.at(-1), ["closeAndDrain"]);

  const stopController = new AbortController();
  let signalInspection = Object.freeze({
    status: "stopped",
    controllerGeneration: "0",
  });
  const signalEvents = [];
  const signalHandle = {
    inspect: () => signalInspection,
    async start() {
      signalEvents.push("start");
      signalInspection = Object.freeze({
        status: "registered_incomplete",
        controllerGeneration: "1",
        connectorId: "connector-signal",
        acknowledgement: "host.registered",
        negotiatedCapabilityIntersection: Object.freeze([]),
      });
      return { status: "started" };
    },
    async stopAndDrain() {
      signalEvents.push("stopAndDrain");
      signalInspection = Object.freeze({
        status: "stopped",
        controllerGeneration: "1",
      });
      return { status: "stopped_and_drained" };
    },
    async closeAndDrain() {
      signalEvents.push("closeAndDrain");
    },
  };
  const signalled = await lifecycle.runRelayV2HostShippingProcessLifecycle(
    signalHandle,
    {
      signal: stopController.signal,
      requestIdFactory: () => "signal-request",
      wait: async () => stopController.abort(),
      monitorIntervalMs: 1,
      reconnectInitialDelayMs: 1,
      reconnectMaximumDelayMs: 1,
    },
  );
  assert.deepEqual(signalled, { status: "stopped_by_signal", exitCode: 0 });
  assert.deepEqual(signalEvents, ["start", "stopAndDrain", "closeAndDrain"]);

  let failedInspection = Object.freeze({
    status: "stopped",
    controllerGeneration: "0",
  });
  const failureEvents = [];
  const failureHandle = {
    inspect: () => failedInspection,
    async start() {
      failureEvents.push("start");
      failedInspection = Object.freeze({
        status: "failed",
        controllerGeneration: "1",
        connectorId: null,
        retryable: false,
      });
      throw new Error("permanent failure");
    },
    async stopAndDrain() {
      failureEvents.push("stopAndDrain");
    },
    async closeAndDrain() {
      failureEvents.push("closeAndDrain");
    },
  };
  await assert.rejects(
    lifecycle.runRelayV2HostShippingProcessLifecycle(failureHandle, {
      requestIdFactory: () => "failure-request",
      monitorIntervalMs: 1,
      reconnectInitialDelayMs: 1,
      reconnectMaximumDelayMs: 1,
    }),
    /permanent failure/,
  );
  assert.deepEqual(failureEvents, ["start", "stopAndDrain", "closeAndDrain"]);
});
