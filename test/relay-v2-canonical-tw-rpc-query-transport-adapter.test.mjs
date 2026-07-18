import assert from "node:assert/strict";
import test from "node:test";

import { RPC_V2_CAPABILITIES } from "../dist/rpcV2.js";
import {
  RelayV2CanonicalTwRpcDiscoveryAdapter,
} from "../dist/relay/v2/canonicalTwRpcDiscovery.js";
import {
  RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_NODES,
  RELAY_V2_CANONICAL_TW_RPC_QUERY_STDERR_MAX_BYTES,
  RELAY_V2_CANONICAL_TW_RPC_QUERY_STDOUT_MAX_BYTES,
  RelayV2CanonicalTwRpcQueryTransportAdapter,
} from "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js";

const encoder = new TextEncoder();

function asyncBytes(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function exitedProcess({
  stdout = encoder.encode("{}\n"),
  stderr = new Uint8Array(),
  exitCode = 0,
  signal = null,
  onKill = () => {},
} = {}) {
  return {
    stdout: asyncBytes(stdout),
    stderr: asyncBytes(stderr),
    exited: Promise.resolve({ exitCode, signal }),
    kill: onKill,
  };
}

function jsonProcess(value, overrides = {}) {
  return exitedProcess({
    stdout: encoder.encode(`${JSON.stringify(value)}\n`),
    ...overrides,
  });
}

function fakeRunner(handler) {
  const calls = [];
  return {
    calls,
    spawn(request) {
      calls.push({
        executable: request.executable,
        argv: [...request.argv],
        shell: request.shell,
        stdin: request.stdin,
        stdout: request.stdout,
        stderr: request.stderr,
      });
      return handler(request, calls.length - 1);
    },
  };
}

function capabilities() {
  return {
    protocolVersion: 2,
    app: "tmux-worktree",
    capabilities: [...RPC_V2_CAPABILITIES],
  };
}

function localTarget() {
  return {
    kind: "local",
    targetId: "bundled-local-cli",
    executable: "/opt/tw-node/bin/node",
    argvPrefix: ["/opt/tw-dashboard/tw-cli/cli.cjs"],
  };
}

function sshTarget() {
  return {
    kind: "ssh",
    targetId: "configured-devbox",
    host: "devbox.example.com",
    knownHostsFile: "/configured/ssh/known_hosts",
    sshExecutable: "/usr/bin/ssh",
    user: "builder",
    port: 2222,
    identityFile: "/configured/ssh/id_ed25519",
    twExecutable: "/opt/tw/bin/tw",
  };
}

function query(command, processTarget, overrides = {}) {
  const base = {
    processTarget,
    command,
    timeoutMs: 100,
    signal: new AbortController().signal,
    ...overrides,
  };
  return command === "list" ? { ...base, maxSessions: 10 } : base;
}

function assertTransportCode(code) {
  return (error) => error?.name === "RelayV2CanonicalTwRpcQueryTransportError"
    && error.code === code;
}

test("query transport invokes only structured no-shell canonical read entrypoints for explicit targets", async () => {
  const runner = fakeRunner((request) => {
    const command = request.argv.at(-1);
    return command === "capabilities"
      ? jsonProcess(capabilities())
      : jsonProcess({ protocolVersion: 2, sessions: [] });
  });
  const adapter = new RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [localTarget(), sshTarget()],
    runner,
  });

  const localResult = await adapter.query(query(
    "capabilities",
    { kind: "local", targetId: "bundled-local-cli" },
  ));
  const sshResult = await adapter.query(query(
    "list",
    { kind: "ssh", targetId: "configured-devbox" },
  ));

  assert.equal(localResult.protocolVersion, 2);
  assert.deepEqual(sshResult.sessions, []);
  assert.deepEqual(runner.calls[0], {
    executable: "/opt/tw-node/bin/node",
    argv: ["/opt/tw-dashboard/tw-cli/cli.cjs", "rpc-v2", "capabilities"],
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.deepEqual(runner.calls[1], {
    executable: "/usr/bin/ssh",
    argv: [
      "-F", "/dev/null",
      "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/configured/ssh/known_hosts",
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "ClearAllForwardings=yes",
      "-o", "RequestTTY=no",
      "-o", "ConnectTimeout=1",
      "-o", "IdentitiesOnly=yes",
      "-i", "/configured/ssh/id_ed25519",
      "-p", "2222",
      "-l", "builder",
      "--",
      "devbox.example.com",
      "/opt/tw/bin/tw",
      "rpc-v2",
      "list",
    ],
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(JSON.stringify(runner.calls).includes("tmux"), false);
  assert.equal(JSON.stringify(runner.calls).includes('"rpc"'), false);

  await assert.rejects(
    adapter.query({
      ...query("capabilities", { kind: "local", targetId: "bundled-local-cli" }),
      command: "kill-session",
    }),
    assertTransportCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    adapter.query(query("list", { kind: "ssh", targetId: "ssh-config-alias" })),
    assertTransportCode("TARGET_UNAVAILABLE"),
  );
  assert.throws(
    () => new RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [{ ...sshTarget(), twExecutable: "/opt/tw;tmux" }],
      runner,
    }),
    /invalid canonical remote tw executable/,
  );
  assert.equal(runner.calls.length, 2, "rejection must not invoke a mutation or fallback");
});

test("query transport accepts exactly one bounded strict UTF-8 JSON object", async (t) => {
  const tooManyNodes = encoder.encode(`${JSON.stringify({
    values: Array.from(
      { length: RELAY_V2_CANONICAL_TW_RPC_QUERY_JSON_MAX_NODES },
      () => null,
    ),
  })}\n`);
  const cases = [
    {
      name: "extra JSON value",
      process: () => exitedProcess({ stdout: encoder.encode("{}{}\n") }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "trailing output line",
      process: () => exitedProcess({ stdout: encoder.encode("{}\nlog\n") }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "duplicate key",
      process: () => exitedProcess({ stdout: encoder.encode('{"a":1,"a":2}\n') }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "non-object root",
      process: () => exitedProcess({ stdout: encoder.encode("[]\n") }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "malformed UTF-8",
      process: () => exitedProcess({
        stdout: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d, 0x0a]),
      }),
      code: "INVALID_RESPONSE",
    },
    {
      name: "stdout hard limit",
      process: (kills) => exitedProcess({
        stdout: new Uint8Array(RELAY_V2_CANONICAL_TW_RPC_QUERY_STDOUT_MAX_BYTES + 1),
        onKill: () => { kills.count += 1; },
      }),
      code: "OUTPUT_LIMIT",
      killed: true,
    },
    {
      name: "stderr hard limit",
      process: (kills) => exitedProcess({
        stderr: new Uint8Array(RELAY_V2_CANONICAL_TW_RPC_QUERY_STDERR_MAX_BYTES + 1),
        onKill: () => { kills.count += 1; },
      }),
      code: "OUTPUT_LIMIT",
      killed: true,
    },
    {
      name: "JSON node hard limit",
      process: () => exitedProcess({ stdout: tooManyNodes }),
      code: "INVALID_RESPONSE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const kills = { count: 0 };
      const runner = fakeRunner(() => item.process(kills));
      const adapter = new RelayV2CanonicalTwRpcQueryTransportAdapter({
        targets: [localTarget()],
        runner,
      });
      await assert.rejects(
        adapter.query(query(
          "capabilities",
          { kind: "local", targetId: "bundled-local-cli" },
        )),
        assertTransportCode(item.code),
      );
      assert.equal(runner.calls.length, 1, "must not retry or fall back");
      assert.equal(kills.count, item.killed ? 1 : 0);
    });
  }
});

function controlledProcess(events) {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const stream = {
    async *[Symbol.asyncIterator]() {
      await barrier;
    },
  };
  return {
    handle: {
      stdout: stream,
      stderr: stream,
      exited: barrier.then(() => {
        events.push("exit");
        return { exitCode: null, signal: "SIGKILL" };
      }),
      kill(signal) {
        assert.equal(signal, "SIGKILL");
        events.push("kill");
      },
    },
    release,
  };
}

test("timeout and AbortSignal kill once and reject only after the exit barrier", async (t) => {
  await t.test("timeout", async () => {
    const events = [];
    const controlled = controlledProcess(events);
    const runner = fakeRunner(() => controlled.handle);
    const adapter = new RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [localTarget()],
      runner,
    });
    let settled = false;
    const pending = adapter.query(query(
      "capabilities",
      { kind: "local", targetId: "bundled-local-cli" },
      { timeoutMs: 5 },
    ));
    pending.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(events, ["kill"]);
    assert.equal(settled, false, "timeout must await child exit");
    controlled.release();
    await assert.rejects(pending, assertTransportCode("TIMED_OUT"));
    events.push("rejected");
    assert.deepEqual(events, ["kill", "exit", "rejected"]);
    assert.equal(runner.calls.length, 1);
  });

  await t.test("AbortSignal", async () => {
    const events = [];
    const controlled = controlledProcess(events);
    const runner = fakeRunner(() => controlled.handle);
    const adapter = new RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [localTarget()],
      runner,
    });
    const controller = new AbortController();
    let settled = false;
    const pending = adapter.query(query(
      "list",
      { kind: "local", targetId: "bundled-local-cli" },
      { timeoutMs: 100, signal: controller.signal },
    ));
    pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    controller.abort();
    await Promise.resolve();

    assert.deepEqual(events, ["kill"]);
    assert.equal(settled, false, "abort must await child exit");
    controlled.release();
    await assert.rejects(pending, assertTransportCode("ABORTED"));
    events.push("rejected");
    assert.deepEqual(events, ["kill", "exit", "rejected"]);
    assert.equal(runner.calls.length, 1);
  });
});

test("process and response failures stay partial through discovery and never authorize empty deletion", async (t) => {
  const scenarios = [
    {
      name: "nonzero capability exit",
      handler: () => exitedProcess({ exitCode: 23 }),
      expectedCode: "SCOPE_UNREACHABLE",
      expectedReachability: "unreachable",
      expectedCalls: 1,
    },
    {
      name: "malformed capability response",
      handler: () => jsonProcess({}),
      expectedCode: "CAPABILITY_UNAVAILABLE",
      expectedReachability: "online",
      expectedCalls: 1,
    },
    {
      name: "malformed list response",
      handler: (request) => request.argv.at(-1) === "capabilities"
        ? jsonProcess(capabilities())
        : jsonProcess({ protocolVersion: 2, sessions: "not-an-array" }),
      expectedCode: "INTERNAL",
      expectedReachability: "online",
      expectedCalls: 2,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const runner = fakeRunner(scenario.handler);
      const transport = new RelayV2CanonicalTwRpcQueryTransportAdapter({
        targets: [sshTarget()],
        runner,
      });
      const discovery = new RelayV2CanonicalTwRpcDiscoveryAdapter({
        scopes: [{
          backendIdentity: "configured-scope",
          displayName: "Configured devbox",
          kind: "ssh",
          processTarget: { kind: "ssh", targetId: "configured-devbox" },
        }],
        queryPort: transport,
        queryTimeoutMs: 50,
      });

      const scan = await discovery.scan();

      assert.equal(scan.coverage, "partial");
      assert.equal(scan.scopes[0].sessionsCompleteness, "partial");
      assert.deepEqual(scan.scopes[0].sessions, []);
      assert.equal(scan.scopes[0].reachability, scenario.expectedReachability);
      assert.equal(scan.scopes[0].error.code, scenario.expectedCode);
      assert.equal(runner.calls.length, scenario.expectedCalls);
      assert.ok(runner.calls.every((call) => call.argv.includes("rpc-v2")));
      assert.ok(runner.calls.every((call) => !call.argv.includes("rpc")));
      assert.ok(runner.calls.every((call) => !call.argv.includes("tmux")));
    });
  }
});
