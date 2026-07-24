import assert from "node:assert/strict";
import test from "node:test";

const childRuntime = await import("../dist/relay/v2/relayV2DashboardManagementChildRuntime.js");

const RUNTIME_VERSION = "0.0.0-child-test";
const CONTRACT = "tmux-worktree-dashboard-relay-v2-management-ipc";
const RID = { status: `dmgmt2.${"a".repeat(21)}A` };

async function waitFor(condition, label) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeIo() {
  const frames = [];
  const queue = [];
  let waiting = null;
  let eof = false;
  return {
    push(text) {
      const bytes = Uint8Array.from(Buffer.from(text, "utf8"));
      if (waiting !== null) {
        const resolve = waiting;
        waiting = null;
        resolve({ done: false, value: bytes });
      } else {
        queue.push(bytes);
      }
    },
    end() {
      eof = true;
      if (waiting !== null) {
        const resolve = waiting;
        waiting = null;
        resolve({ done: true, value: undefined });
      }
    },
    lines() {
      return frames.join("").split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    },
    raw() {
      return frames.join("");
    },
    io: Object.freeze({
      input: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() });
              if (eof) return Promise.resolve({ done: true, value: undefined });
              return new Promise((resolve) => {
                waiting = resolve;
              });
            },
          };
        },
      },
      writeFrame: (frame) => {
        frames.push(frame);
        return Promise.resolve();
      },
    }),
  };
}

function shipping() {
  return Object.freeze({
    trustedHome: "/tmp/child-runtime-test",
    deployment: Object.freeze({ marker: "deployment" }),
    runtime: Object.freeze({ marker: "runtime" }),
  });
}

async function assertUnavailableSession(channel, run) {
  await waitFor(() => channel.lines().length === 1, "ready frame");
  const ready = channel.lines()[0];
  assert.deepEqual(Object.keys(ready).sort(), ["contract", "protocolVersion", "runtimeVersion"]);
  assert.equal(ready.contract, CONTRACT);
  assert.equal(ready.protocolVersion, 2);
  assert.equal(ready.runtimeVersion, RUNTIME_VERSION);
  channel.push(`${JSON.stringify({
    protocolVersion: 2,
    requestId: RID.status,
    operation: "status",
    input: null,
  })}\n`);
  await waitFor(() => channel.lines().length === 2, "status response");
  const response = channel.lines()[1];
  assert.equal(response.requestId, RID.status);
  assert.equal(response.ok, false);
  assert.equal(response.result, null);
  assert.equal(response.error.code, "UNAVAILABLE");
  channel.end();
  assert.equal(await run, 0);
  assert.equal(channel.lines().length, 2);
}

test("absent or unqualified inputs keep exactly-one ready and typed UNAVAILABLE", async (t) => {
  await t.test("shipping absent selects the fail-closed session", async () => {
    const channel = makeIo();
    await assertUnavailableSession(
      channel,
      childRuntime.runRelayV2DashboardManagementChildStdio({
        runtimeVersion: RUNTIME_VERSION,
        io: channel.io,
      }),
    );
  });

  await t.test("factory failure before the channel still converges to the one UNAVAILABLE session", async () => {
    const calls = [];
    const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(
      async (options) => {
        calls.push(options);
        throw new Error("unqualified");
      },
    );
    const channel = makeIo();
    const inputs = shipping();
    await assertUnavailableSession(channel, runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
      shipping: inputs,
    }));
    assert.equal(calls.length, 1);
    // Shipping inputs pass through verbatim; the child adds only the exact
    // protocol-v2 management channel and never touches the wire itself.
    assert.equal(calls[0].trustedHome, inputs.trustedHome);
    assert.equal(calls[0].deployment, inputs.deployment);
    assert.equal(calls[0].runtime, inputs.runtime);
    assert.equal(calls[0].dashboardManagement.io.input, channel.io.input);
    assert.equal(calls[0].dashboardManagement.io.writeFrame, channel.io.writeFrame);
    assert.equal(calls[0].dashboardManagement.runtimeVersion, RUNTIME_VERSION);
    assert.equal(calls[0].dashboardManagement.signal instanceof AbortSignal, true);
    assert.equal(typeof calls[0].dashboardManagement.clock, "function");
  });

  await t.test("malformed selection options exit ordinary without any ready", async () => {
    const channel = makeIo();
    assert.equal(
      await childRuntime.runRelayV2DashboardManagementChildStdio(new Proxy({
        runtimeVersion: RUNTIME_VERSION,
        io: channel.io,
      }, {})),
      1,
    );
    assert.equal(
      await childRuntime.runRelayV2DashboardManagementChildStdio({
        runtimeVersion: RUNTIME_VERSION,
        io: channel.io,
        shipping: { trustedHome: "/tmp", unexpected: true },
      }),
      1,
    );
    assert.equal(channel.raw(), "");
  });
});

test("qualified owner runs exactly once and drains exactly once", async () => {
  const calls = [];
  const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(async () => ({
    runDashboardManagement: async () => {
      calls.push("run");
      return 0;
    },
    closeAndDrain: async () => {
      calls.push("close");
    },
  }));
  const channel = makeIo();
  assert.equal(await runner({
    runtimeVersion: RUNTIME_VERSION,
    io: channel.io,
    shipping: shipping(),
  }), 0);
  assert.deepEqual(calls, ["run", "close"]);
  // The wrapper never writes a frame of its own on the qualified path.
  assert.equal(channel.raw(), "");
});

test("session or close uncertainty exits ordinary failure without a second session", async (t) => {
  await t.test("session run reject still drains once and never falls back", async () => {
    const calls = [];
    const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(async () => ({
      runDashboardManagement: async () => {
        calls.push("run");
        throw new Error("session exploded");
      },
      closeAndDrain: async () => {
        calls.push("close");
      },
    }));
    const channel = makeIo();
    assert.equal(await runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
      shipping: shipping(),
    }), 1);
    assert.deepEqual(calls, ["run", "close"]);
    assert.equal(channel.raw(), "");
  });

  await t.test("owner close uncertainty propagates as ordinary failure", async () => {
    const calls = [];
    const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(async () => ({
      runDashboardManagement: async () => {
        calls.push("run");
        return 0;
      },
      closeAndDrain: async () => {
        calls.push("close");
        throw new Error("close uncertain");
      },
    }));
    const channel = makeIo();
    assert.equal(await runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
      shipping: shipping(),
    }), 1);
    assert.deepEqual(calls, ["run", "close"]);
    assert.equal(channel.raw(), "");
  });

  await t.test("management resolving an illegal result never earns a second ready", async () => {
    const calls = [];
    const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(
      async (options) => ({
        runDashboardManagement: () => {
          calls.push("run");
          // The frame may already be published before the illegal resolution,
          // so the wrapper must not start the UNAVAILABLE session on top of it.
          return options.dashboardManagement.io.writeFrame(
            `${JSON.stringify({
              contract: CONTRACT,
              protocolVersion: 2,
              runtimeVersion: RUNTIME_VERSION,
            })}\n`,
          ).then(() => null);
        },
        closeAndDrain: async () => {
          calls.push("close");
        },
      }),
    );
    const channel = makeIo();
    assert.equal(await runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
      shipping: shipping(),
    }), 1);
    assert.deepEqual(calls, ["run", "close"]);
    assert.equal(channel.lines().length, 1);
    assert.equal(channel.lines()[0].contract, CONTRACT);
    assert.equal(channel.lines()[0].protocolVersion, 2);
  });

  await t.test("no-management handle with a non-Promise close never falls back", async () => {
    const calls = [];
    const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(async () => ({
      closeAndDrain: () => {
        calls.push("close");
        return "closed";
      },
    }));
    const channel = makeIo();
    assert.equal(await runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
      shipping: shipping(),
    }), 1);
    assert.deepEqual(calls, ["close"]);
    assert.equal(channel.raw(), "");
  });

  await t.test("legitimate no-management handle with a verified clean close still declines to exactly one UNAVAILABLE session", async () => {
    const calls = [];
    const runner = childRuntime.createRelayV2DashboardManagementChildStdioRunner(async () => {
      calls.push("factory");
      return {
        closeAndDrain: async () => {
          calls.push("close");
        },
      };
    });
    const channel = makeIo();
    await assertUnavailableSession(channel, runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
      shipping: shipping(),
    }));
    assert.deepEqual(calls, ["factory", "close"]);
  });
});
