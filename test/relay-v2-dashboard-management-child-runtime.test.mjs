import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { build } = createRequire(import.meta.url)("esbuild");
const sourcePath = new URL(
  "../src/relay/v2/relayV2DashboardManagementChildRuntime.ts",
  import.meta.url,
).pathname;
const compiled = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [{
    name: "trusted-host-dashboard-management-source",
    setup(esbuild) {
      esbuild.onResolve(
        { filter: /^\.\/hostShippingDeploymentSource\.js$/ },
        () => ({
          path: "hostShippingDeploymentSource.js",
          namespace: "trusted-host-source",
        }),
      );
      esbuild.onLoad(
        { filter: /.*/, namespace: "trusted-host-source" },
        () => ({
          contents: `
            export async function startRelayV2HostDashboardManagementFromTrustedDeployment(
              options,
            ) {
              return globalThis.__relayV2DashboardManagementTrustedHostFactory(options);
            }
            export async function startRelayV2HostDashboardManagementFromSelfHostedDarwinArm64(
              selection,
              options,
            ) {
              return globalThis.__relayV2DashboardManagementSelfHostedHostFactory(
                selection,
                options,
              );
            }
          `,
          loader: "js",
        }),
      );
    },
  }],
});
const childRuntime = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

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

test("trusted activation gaps keep exactly-one ready and typed UNAVAILABLE", async (t) => {
  await t.test("production selection always calls the trusted opener", async () => {
    const calls = [];
    globalThis.__relayV2DashboardManagementTrustedHostFactory = async (options) => {
      calls.push(options);
      throw new Error("unqualified");
    };
    const channel = makeIo();
    await assertUnavailableSession(
      channel,
      childRuntime.runRelayV2DashboardManagementChildStdio({
        runtimeVersion: RUNTIME_VERSION,
        io: channel.io,
      }),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(Reflect.ownKeys(calls[0]).sort(), [
      "clock", "io", "runtimeVersion", "signal",
    ]);
    assert.equal(calls[0].io.input, channel.io.input);
    assert.equal(calls[0].io.writeFrame, channel.io.writeFrame);
    assert.equal(calls[0].runtimeVersion, RUNTIME_VERSION);
    assert.equal(calls[0].signal instanceof AbortSignal, true);
    assert.equal(typeof calls[0].clock, "function");
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
    await assertUnavailableSession(channel, runner({
      runtimeVersion: RUNTIME_VERSION,
      io: channel.io,
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].io.input, channel.io.input);
    assert.equal(calls[0].io.writeFrame, channel.io.writeFrame);
    assert.equal(calls[0].runtimeVersion, RUNTIME_VERSION);
    assert.equal(calls[0].signal instanceof AbortSignal, true);
    assert.equal(typeof calls[0].clock, "function");
  });

  await t.test("malformed or raw shipping selection options exit ordinary without any ready", async () => {
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
        shipping: {
          trustedHome: "/tmp",
          deployment: {},
          runtime: {},
        },
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
  }), 0);
  assert.deepEqual(calls, ["run", "close"]);
  // The wrapper never writes a frame of its own on the qualified path.
  assert.equal(channel.raw(), "");
});

test("explicit self-hosted argv is closed, exact, and never falls back to production", async () => {
  const calls = [];
  globalThis.__relayV2DashboardManagementTrustedHostFactory = async () => {
    assert.fail("self-hosted selection must not call the production opener");
  };
  globalThis.__relayV2DashboardManagementSelfHostedHostFactory =
    async (selection, options) => {
      calls.push({ selection, options });
      return {
        runDashboardManagement: async () => 0,
        closeAndDrain: async () => {},
      };
    };
  const channel = makeIo();
  assert.equal(await childRuntime.runRelayV2DashboardManagementChildStdio({
    runtimeVersion: RUNTIME_VERSION,
    io: channel.io,
    selectionArguments: [
      "--self-hosted",
      "--credential-https-ca-input", "/private/credential-ca.pem",
      "--carrier-wss-ca-input", "/private/carrier-ca.pem",
      "--provision-profile-input", "/private/profile.json",
      "--bootstrap-secret-input", "/private/bootstrap",
    ],
  }), 0);
  assert.equal(channel.raw(), "");
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0].selection }, {
    credentialHttpsCaInputPath: "/private/credential-ca.pem",
    carrierWssCaInputPath: "/private/carrier-ca.pem",
    provisionProfileInputPath: "/private/profile.json",
    bootstrapSecretInputPath: "/private/bootstrap",
  });
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);

  for (const selectionArguments of [
    ["--self-hosted"],
    [
      "--self-hosted",
      "--credential-https-ca-input", "/private/a",
      "--carrier-wss-ca-input", "/private/b",
      "--trusted-home", "/Users/isolated",
    ],
    [
      "--self-hosted",
      "--credential-https-ca-input", "/private/a",
      "--credential-https-ca-input", "/private/replay",
      "--carrier-wss-ca-input", "/private/b",
    ],
    [
      "--credential-https-ca-input", "/private/a",
      "--carrier-wss-ca-input", "/private/b",
    ],
  ]) {
    const rejected = makeIo();
    assert.equal(await childRuntime.runRelayV2DashboardManagementChildStdio({
      runtimeVersion: RUNTIME_VERSION,
      io: rejected.io,
      selectionArguments,
    }), 1);
    assert.equal(rejected.raw(), "");
  }

  globalThis.__relayV2DashboardManagementSelfHostedHostFactory = async () => {
    throw new Error("activation failed");
  };
  const failed = makeIo();
  assert.equal(await childRuntime.runRelayV2DashboardManagementChildStdio({
    runtimeVersion: RUNTIME_VERSION,
    io: failed.io,
    selectionArguments: [
      "--self-hosted",
      "--credential-https-ca-input", "/private/a",
      "--carrier-wss-ca-input", "/private/b",
    ],
  }), 1);
  assert.equal(failed.raw(), "", "explicit failure never opens production UNAVAILABLE");
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
          return options.io.writeFrame(
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
    }));
    assert.deepEqual(calls, ["factory", "close"]);
  });
});

test.after(() => {
  delete globalThis.__relayV2DashboardManagementTrustedHostFactory;
});
