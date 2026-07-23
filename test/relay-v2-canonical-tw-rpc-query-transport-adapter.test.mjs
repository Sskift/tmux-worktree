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
  createRelayV2CanonicalTwRpcConfigSnapshotFoundation,
} from "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js";
import {
  RelayV2CanonicalStructuredProcessAdapter,
} from "../dist/relay/v2/canonicalStructuredProcessAdapter.js";

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
    adapter.processTarget("local", "bundled-local-cli"),
  ));
  const sshResult = await adapter.query(query(
    "list",
    adapter.processTarget("ssh", "configured-devbox"),
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
      ...query("capabilities", adapter.processTarget("local", "bundled-local-cli")),
      command: "kill-session",
    }),
    assertTransportCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    adapter.query(query("list", {
      kind: "ssh",
      targetId: "ssh-config-alias",
    })),
    assertTransportCode("TARGET_UNAVAILABLE"),
  );
  assert.throws(
    () => new RelayV2CanonicalTwRpcQueryTransportAdapter({
      targets: [{ ...sshTarget(), twExecutable: "/opt/tw;tmux" }],
      runner,
    }),
    /invalid canonical remote tw executable/,
  );
  for (const missing of ["knownHostsFile", "user", "port", "identityFile", "twExecutable"]) {
    const incomplete = { ...sshTarget() };
    delete incomplete[missing];
    assert.throws(
      () => new RelayV2CanonicalTwRpcQueryTransportAdapter({
        targets: [incomplete],
        runner,
      }),
      /invalid canonical TW RPC v2 SSH query target/,
      `SSH target must explicitly bind ${missing}`,
    );
  }
  assert.equal(runner.calls.length, 2, "rejection must not invoke a mutation or fallback");
});

test("default-off config factory derives only local plus explicit Hosts and retires old descriptors before replacement", async () => {
  let configSnapshot = {
    hosts: [{
      id: "stable-host-id",
      label: "Configured build host",
      host: "old.example.com",
      user: "builder",
      port: 2222,
      identityFile: "/configured/ssh/old_ed25519",
      twPath: "/opt/tw/bin/tw",
    }],
  };
  let releaseOld;
  const oldBarrier = new Promise((resolve) => { releaseOld = resolve; });
  let oldKills = 0;
  let blockOld = false;
  const runner = fakeRunner((request) => {
    const command = request.argv.at(-1);
    if (request.argv.includes("old.example.com") && blockOld) {
      return {
        stdout: {
          async *[Symbol.asyncIterator]() {
            await oldBarrier;
            yield encoder.encode(`${JSON.stringify(capabilities())}\n`);
          },
        },
        stderr: { async *[Symbol.asyncIterator]() { await oldBarrier; } },
        exited: oldBarrier.then(() => ({ exitCode: 0, signal: null })),
        kill(signal) {
          assert.equal(signal, "SIGKILL");
          oldKills += 1;
        },
      };
    }
    return command === "capabilities"
      ? jsonProcess(capabilities())
      : jsonProcess({ protocolVersion: 2, sessions: [] });
  });
  const foundation = createRelayV2CanonicalTwRpcConfigSnapshotFoundation({
    configLoader: () => structuredClone(configSnapshot),
    localTarget: localTarget(),
    knownHostsFile: "/configured/ssh/known_hosts",
    sshExecutable: "/usr/bin/ssh",
    runner,
  });
  assert.equal(runner.calls.length, 0, "factory construction must not spawn");

  const initialScan = await foundation.discovery.scan();
  const oldTarget = initialScan[Symbol.for("tmux-worktree.relay-v2.resource-resolver-cut")]
    .scopeTargets.find((target) => target.processTarget.kind === "ssh").processTarget;
  assert.ok(oldTarget);
  assert.throws(
    () => foundation.queryPort.installContentAddressedTargets([{
      ...sshTarget(),
      targetId: oldTarget.targetId,
      host: "masquerade.example.com",
    }]),
    /not content-addressed/,
  );
  const oldLocalTarget = initialScan[Symbol.for("tmux-worktree.relay-v2.resource-resolver-cut")]
    .scopeTargets.find((target) => target.processTarget.kind === "local").processTarget;
  const callsBeforeOldStructured = runner.calls.length;
  const oldLocalMutation = await foundation.structuredProcess.execute(structuredRequest(oldLocalTarget));
  const oldSshMutation = await foundation.structuredProcess.execute(structuredRequest(oldTarget));
  assert.equal(oldLocalMutation.kind, "exited");
  assert.equal(oldSshMutation.kind, "exited");
  assert.equal(
    runner.calls.length,
    callsBeforeOldStructured + 2,
    "structuredProcess must share the discovery/query runner",
  );
  assert.equal(runner.calls.at(-2).executable, "/opt/tw-node/bin/node");
  assert.equal(runner.calls.at(-1).executable, "/usr/bin/ssh");
  assert.equal(runner.calls.at(-1).argv.includes("old.example.com"), true);
  blockOld = true;
  const callsBeforeBlockedScan = runner.calls.length;
  const oldScanPromise = foundation.discovery.scan();
  while (runner.calls.length === callsBeforeBlockedScan) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(runner.calls.at(-1).argv.includes("old.example.com"), true);
  configSnapshot = {
    hosts: [{
      ...configSnapshot.hosts[0],
      host: "new.example.com",
      identityFile: "/configured/ssh/new_ed25519",
    }],
  };
  const reconfigured = foundation.reconfigure();
  const currentScanPromise = foundation.discovery.scan();
  const callsDuringRetirement = runner.calls.length;
  await assert.rejects(
    foundation.queryPort.query(query("capabilities", oldTarget)),
    assertTransportCode("TARGET_UNAVAILABLE"),
  );
  assert.equal(
    runner.calls.length,
    callsDuringRetirement,
    "retirement window must synchronously withdraw the old binding",
  );
  while (oldKills === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runner.calls.some((call) => call.argv.includes("new.example.com")), false);

  releaseOld();
  await oldScanPromise;
  await reconfigured;
  assert.equal(
    initialScan[Symbol.for("tmux-worktree.relay-v2.resource-resolver-cut")].isCurrent(),
    false,
  );
  const currentScan = await currentScanPromise;
  const callsBeforeOldPlan = runner.calls.length;
  await assert.rejects(
    foundation.queryPort.query(query("capabilities", oldTarget)),
    assertTransportCode("TARGET_UNAVAILABLE"),
  );
  await assert.rejects(
    foundation.structuredProcess.execute(structuredRequest(oldTarget)),
    assertStructuredCode("TARGET_UNAVAILABLE"),
  );
  assert.equal(runner.calls.length, callsBeforeOldPlan, "retired plan must reach zero spawns");

  const currentTarget = currentScan[
    Symbol.for("tmux-worktree.relay-v2.resource-resolver-cut")
  ].scopeTargets.find((target) => target.processTarget.kind === "ssh").processTarget;
  assert.match(oldTarget.targetId, /^twcfg2\.[A-Za-z0-9_-]{43}$/);
  assert.match(currentTarget.targetId, /^twcfg2\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(currentTarget.targetId, oldTarget.targetId);
  assert.equal(currentScan.scopes.some((item) => item.backendIdentity === "configured-host:stable-host-id"), true);
  assert.equal(runner.calls.some((call) => call.argv.includes("new.example.com")), true);
  const currentLocalTarget = currentScan[Symbol.for("tmux-worktree.relay-v2.resource-resolver-cut")]
    .scopeTargets.find((target) => target.processTarget.kind === "local").processTarget;
  const callsBeforeCurrentStructured = runner.calls.length;
  const currentLocalMutation = await foundation.structuredProcess.execute(
    structuredRequest(currentLocalTarget),
  );
  const currentSshMutation = await foundation.structuredProcess.execute(structuredRequest(currentTarget));
  assert.equal(currentLocalMutation.kind, "exited");
  assert.equal(currentSshMutation.kind, "exited");
  assert.equal(
    runner.calls.length,
    callsBeforeCurrentStructured + 2,
    "structuredProcess must re-resolve the live generation",
  );
  assert.equal(runner.calls.at(-2).executable, "/opt/tw-node/bin/node");
  assert.equal(runner.calls.at(-1).executable, "/usr/bin/ssh");
  assert.equal(runner.calls.at(-1).argv.includes("new.example.com"), true);
  assert.equal(oldKills, 1);
});

test("config factory rejects incomplete Host provenance before any process spawn", () => {
  const validHost = {
    id: "configured",
    host: "configured.example.com",
    user: "builder",
    port: 2222,
    identityFile: "/configured/ssh/id_ed25519",
    twPath: "/opt/tw/bin/tw",
  };
  const runner = fakeRunner(() => assert.fail("invalid config must not spawn"));
  for (const missing of ["user", "port", "identityFile", "twPath"]) {
    const host = { ...validHost };
    delete host[missing];
    assert.throws(
      () => createRelayV2CanonicalTwRpcConfigSnapshotFoundation({
        configLoader: () => ({ hosts: [host] }),
        localTarget: localTarget(),
        knownHostsFile: "/configured/ssh/known_hosts",
        sshExecutable: "/usr/bin/ssh",
        runner,
      }),
      /lacks explicit/,
      missing,
    );
  }
  assert.throws(
    () => createRelayV2CanonicalTwRpcConfigSnapshotFoundation({
      configLoader: () => ({ hosts: [validHost] }),
      localTarget: localTarget(),
      knownHostsFile: "known_hosts",
      sshExecutable: "/usr/bin/ssh",
      runner,
    }),
    /absolute paths/,
  );
  assert.throws(
    () => createRelayV2CanonicalTwRpcConfigSnapshotFoundation({
      configLoader: () => ({ hosts: [validHost] }),
      localTarget: localTarget(),
      sshExecutable: "/usr/bin/ssh",
      runner,
    }),
    /absolute paths/,
  );
  assert.equal(runner.calls.length, 0);
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
          adapter.processTarget("local", "bundled-local-cli"),
        )),
        assertTransportCode(item.code),
      );
      assert.equal(runner.calls.length, 1, "must not retry or fall back");
      assert.equal(kills.count, item.killed ? 1 : 0);
    });
  }
});

function controlledProcess(events) {
  let releaseExit;
  let releaseStdout;
  let releaseStderr;
  const exitBarrier = new Promise((resolve) => { releaseExit = resolve; });
  const stdoutBarrier = new Promise((resolve) => { releaseStdout = resolve; });
  const stderrBarrier = new Promise((resolve) => { releaseStderr = resolve; });
  return {
    handle: {
      stdout: {
        async *[Symbol.asyncIterator]() {
          await stdoutBarrier;
          events.push("stdout");
        },
      },
      stderr: {
        async *[Symbol.asyncIterator]() {
          await stderrBarrier;
          events.push("stderr");
        },
      },
      exited: exitBarrier.then(() => {
        events.push("exit");
        return { exitCode: null, signal: "SIGKILL" };
      }),
      kill(signal) {
        assert.equal(signal, "SIGKILL");
        events.push("kill");
      },
    },
    releaseExit,
    releaseStdout,
    releaseStderr,
  };
}

test("timeout and AbortSignal reject only after kill, exit, stdout, and stderr settle", async (t) => {
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
      adapter.processTarget("local", "bundled-local-cli"),
      { timeoutMs: 5 },
    ));
    pending.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(events, ["kill"]);
    assert.equal(settled, false, "timeout must await child resources");
    controlled.releaseExit();
    await Promise.resolve();
    assert.equal(settled, false, "timeout must await stdout and stderr after exit");
    controlled.releaseStdout();
    await Promise.resolve();
    assert.equal(settled, false, "timeout must await stderr after stdout");
    controlled.releaseStderr();
    await assert.rejects(pending, assertTransportCode("TIMED_OUT"));
    events.push("rejected");
    assert.deepEqual(events, ["kill", "exit", "stdout", "stderr", "rejected"]);
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
      adapter.processTarget("local", "bundled-local-cli"),
      { timeoutMs: 100, signal: controller.signal },
    ));
    pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    controller.abort();
    await Promise.resolve();

    assert.deepEqual(events, ["kill"]);
    assert.equal(settled, false, "abort must await child resources");
    controlled.releaseStderr();
    await Promise.resolve();
    assert.equal(settled, false, "abort must await exit and stdout after stderr");
    controlled.releaseExit();
    await Promise.resolve();
    assert.equal(settled, false, "abort must await stdout after exit");
    controlled.releaseStdout();
    await assert.rejects(pending, assertTransportCode("ABORTED"));
    events.push("rejected");
    assert.deepEqual(events, ["kill", "stderr", "exit", "stdout", "rejected"]);
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
          processTarget: transport.processTarget("ssh", "configured-devbox"),
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

const KILL_REQUEST_JSON = JSON.stringify({
  protocolVersion: 2,
  operation: "kill-session",
  name: "tw-term-a1b2c",
  expectedIncarnation: `twinc2.${"A".repeat(43)}`,
});

const KILL_RESPONSE = {
  protocolVersion: 2,
  operation: "kill-session",
  state: "succeeded",
  name: "tw-term-a1b2c",
  kind: "terminal",
  incarnation: `twinc2.${"A".repeat(43)}`,
  terminated: true,
  sessionId: "$7",
};

function structuredRequest(target, overrides = {}) {
  return {
    target: { kind: target.kind, scopeId: "scope-local", targetId: target.targetId },
    executable: "tw",
    argv: ["rpc-v2", "kill-session", "--request-json", KILL_REQUEST_JSON],
    stdin: null,
    timeoutMs: 50,
    maxStdoutBytes: 1_048_576,
    maxStderrBytes: 65_536,
    maxResponseFrameBytes: 1_048_575,
    ...overrides,
  };
}

function assertStructuredCode(code) {
  return (error) => error?.name === "RelayV2CanonicalStructuredProcessError"
    && error.code === code;
}

test("structured mutation process lane invokes only the exact configured target and reports exited", async () => {
  const runner = fakeRunner(() => jsonProcess(KILL_RESPONSE));
  const authority = new RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [localTarget(), sshTarget()],
    runner,
  });
  const process = new RelayV2CanonicalStructuredProcessAdapter({ targets: authority, runner });

  const localResult = await process.execute(structuredRequest({
    kind: "local",
    targetId: "bundled-local-cli",
  }));
  const sshResult = await process.execute(structuredRequest(
    { kind: "ssh", targetId: "configured-devbox" },
    { timeoutMs: 120_000 },
  ));

  for (const result of [localResult, sshResult]) {
    assert.equal(result.kind, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(new TextDecoder().decode(result.stdout), `${JSON.stringify(KILL_RESPONSE)}\n`);
    assert.equal(result.stderr.byteLength, 0);
    assert.ok(Number.isSafeInteger(result.elapsedMs) && result.elapsedMs >= 0);
  }
  assert.deepEqual(runner.calls[0], {
    executable: "/opt/tw-node/bin/node",
    argv: [
      "/opt/tw-dashboard/tw-cli/cli.cjs",
      "rpc-v2",
      "kill-session",
      "--request-json",
      KILL_REQUEST_JSON,
    ],
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
      "-o", "ConnectTimeout=120",
      "-o", "IdentitiesOnly=yes",
      "-i", "/configured/ssh/id_ed25519",
      "-p", "2222",
      "-l", "builder",
      "--",
      "devbox.example.com",
      `'/opt/tw/bin/tw' 'rpc-v2' 'kill-session' '--request-json' '${KILL_REQUEST_JSON}'`,
    ],
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(JSON.stringify(runner.calls).includes("tmux"), false);
  assert.equal(JSON.stringify(runner.calls).includes('"rpc"'), false);

  await assert.rejects(
    process.execute(structuredRequest({ kind: "ssh", targetId: "ssh-config-alias" })),
    assertStructuredCode("TARGET_UNAVAILABLE"),
  );
  await assert.rejects(
    process.execute(structuredRequest(
      { kind: "local", targetId: "bundled-local-cli" },
      { target: { kind: "local", scopeId: " scope-local", targetId: "bundled-local-cli" } },
    )),
    assertStructuredCode("INVALID_REQUEST"),
  );
  authority.beginContentAddressedTargetTransition();
  await assert.rejects(
    process.execute(structuredRequest({ kind: "local", targetId: "bundled-local-cli" })),
    assertStructuredCode("TARGET_UNAVAILABLE"),
  );
  assert.equal(
    runner.calls.length,
    2,
    "unknown, malformed, or retired targets must fail closed before spawn",
  );
});

test("structured mutation timeout kills with SIGKILL and reports timed_out only after a full drain", async () => {
  const events = [];
  const controlled = controlledProcess(events);
  const runner = fakeRunner(() => controlled.handle);
  const authority = new RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [localTarget()],
    runner,
  });
  const process = new RelayV2CanonicalStructuredProcessAdapter({ targets: authority, runner });

  let settled = false;
  const pending = process.execute(structuredRequest(
    { kind: "local", targetId: "bundled-local-cli" },
    { timeoutMs: 5 },
  ));
  pending.then(() => { settled = true; }, () => { settled = true; });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(events, ["kill"]);
  assert.equal(settled, false, "timed_out must await the child exit barrier");
  controlled.releaseExit();
  await Promise.resolve();
  assert.equal(settled, false, "timed_out must await stdout and stderr after exit");
  controlled.releaseStdout();
  await Promise.resolve();
  assert.equal(settled, false, "timed_out must await stderr after stdout");
  controlled.releaseStderr();
  const result = await pending;
  assert.equal(result.kind, "timed_out");
  assert.ok(result.elapsedMs >= 5);
  assert.deepEqual(events, ["kill", "exit", "stdout", "stderr"]);
  assert.equal(runner.calls.length, 1);
});

test("structured mutation spawn failure reports exact spawn_failed without retry", async () => {
  const runner = fakeRunner(() => { throw new Error("ENOENT"); });
  const authority = new RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [localTarget()],
    runner,
  });
  const process = new RelayV2CanonicalStructuredProcessAdapter({ targets: authority, runner });
  const result = await process.execute(structuredRequest({
    kind: "local",
    targetId: "bundled-local-cli",
  }));
  assert.equal(result.kind, "spawn_failed");
  assert.equal(result.stdout.byteLength, 0);
  assert.equal(result.stderr.byteLength, 0);
  assert.ok(Number.isSafeInteger(result.elapsedMs));
  assert.equal(runner.calls.length, 1);
});

test("structured mutation response overflow kills immediately and rejects only after a full drain", async () => {
  const events = [];
  let releaseExit;
  let releaseStdout;
  let releaseStderr;
  const exitBarrier = new Promise((resolve) => { releaseExit = resolve; });
  const stdoutBarrier = new Promise((resolve) => { releaseStdout = resolve; });
  const stderrBarrier = new Promise((resolve) => { releaseStderr = resolve; });
  const handle = {
    stdout: {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(32);
        await stdoutBarrier;
        events.push("stdout");
      },
    },
    stderr: {
      async *[Symbol.asyncIterator]() {
        await stderrBarrier;
        events.push("stderr");
      },
    },
    exited: exitBarrier.then(() => {
      events.push("exit");
      return { exitCode: null, signal: "SIGKILL" };
    }),
    kill(signal) {
      assert.equal(signal, "SIGKILL");
      events.push("kill");
    },
  };
  const runner = fakeRunner(() => handle);
  const authority = new RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [localTarget()],
    runner,
  });
  const process = new RelayV2CanonicalStructuredProcessAdapter({ targets: authority, runner });

  let settled = false;
  const pending = process.execute(structuredRequest(
    { kind: "local", targetId: "bundled-local-cli" },
    { timeoutMs: 10_000, maxResponseFrameBytes: 16 },
  ));
  pending.then(() => { settled = true; }, () => { settled = true; });

  while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(events, ["kill"], "first overflowing chunk must kill immediately");
  assert.equal(settled, false);
  releaseExit();
  await Promise.resolve();
  assert.equal(settled, false, "overflow must await the stdout drain after exit");
  releaseStdout();
  await Promise.resolve();
  assert.equal(settled, false, "overflow must await the stderr drain after stdout");
  releaseStderr();
  await assert.rejects(pending, assertStructuredCode("OUTPUT_LIMIT"));
  events.push("rejected");
  assert.deepEqual(events, ["kill", "exit", "stdout", "stderr", "rejected"]);
  assert.equal(runner.calls.length, 1);
});

test("structured mutation SSH lane POSIX-encodes every remote argument into one command string", async () => {
  const dangerousJson = `{"op":"x y's $(whoami)"}`;
  const runner = fakeRunner(() => jsonProcess(KILL_RESPONSE));
  const authority = new RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [sshTarget()],
    runner,
  });
  const process = new RelayV2CanonicalStructuredProcessAdapter({ targets: authority, runner });

  const result = await process.execute(structuredRequest(
    { kind: "ssh", targetId: "configured-devbox" },
    { argv: ["rpc-v2", "kill-session", "--request-json", dangerousJson] },
  ));

  assert.equal(result.kind, "exited");
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.executable, "/usr/bin/ssh");
  assert.equal(call.shell, false);
  assert.equal(call.stdin, "ignore");
  const hostIndex = call.argv.indexOf("devbox.example.com");
  assert.ok(hostIndex > 0);
  assert.equal(
    call.argv.length,
    hostIndex + 2,
    "the remote command must be exactly one argv item after the host",
  );
  const remoteCommand = call.argv[hostIndex + 1];
  assert.equal(
    remoteCommand,
    `'/opt/tw/bin/tw' 'rpc-v2' 'kill-session' '--request-json' '{"op":"x y'\\''s $(whoami)"}'`,
  );
  assert.equal(
    remoteCommand.includes(dangerousJson),
    false,
    "raw request JSON must never cross the remote shell boundary unencoded",
  );
  assert.equal(JSON.stringify(runner.calls).includes("tmux"), false);
  assert.equal(JSON.stringify(runner.calls).includes('"rpc"'), false);
});
