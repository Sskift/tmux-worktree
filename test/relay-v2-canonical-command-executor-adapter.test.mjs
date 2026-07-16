import assert from "node:assert/strict";
import test from "node:test";

const adapterModule = await import("../dist/relay/v2/canonicalCommandExecutorAdapter.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const rpcV2 = await import("../dist/rpcV2.js");

const HOST_ID = "mac-admin";
const HOST_EPOCH = "host-epoch-1";
const SCOPE_ID = "scope-local";
const INCARNATION = `twinc2.${"A".repeat(43)}`;
const OTHER_INCARNATION = `twinc2.${"B".repeat(43)}`;
const CREATED_AT = "2026-07-12T00:00:01.000Z";

function fingerprint(seed = "a") {
  return {
    schemaVersion: 1,
    algorithm: "sha256-rfc8785",
    digest: seed.repeat(64),
  };
}

function canonicalRequest(operation, overrides = {}) {
  const create = operation === "create_worktree" || operation === "create_terminal";
  const message = operation === "send_agent_message";
  const argumentsByOperation = {
    create_worktree: {
      project: "demo",
      path: "/repo/demo",
      name: "fix",
      branch: "main",
      aiCommand: "codex",
    },
    create_terminal: { cwd: "/repo/demo", label: "demo" },
    send_agent_message: { pane: 0, message: "continue", submit: true },
    kill_session: {},
  };
  return {
    fingerprintSchemaVersion: 1,
    commandId: `cmd-${operation}`,
    requestFingerprint: fingerprint(create ? "a" : message ? "b" : "c"),
    authority: message ? "terminal_control" : "tw_rpc",
    operation,
    principalId: "principal-one",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    scopeId: SCOPE_ID,
    sessionId: create ? null : "ses_opaque_existing",
    arguments: argumentsByOperation[operation],
    ...overrides,
  };
}

function evidence(coverage = "complete") {
  return {
    coverage,
    evidence: {
      authorityId: "canonical-cut-1",
      revision: "42",
      observedAtMs: 1_783_700_200_000,
    },
  };
}

function prospectiveSession(operation) {
  const terminal = operation === "create_terminal";
  return {
    kind: terminal ? "terminal" : "worktree",
    displayName: terminal ? "demo" : "demo-fix",
    state: "running",
    project: terminal ? null : "demo",
    label: terminal ? "demo" : null,
    cwd: terminal ? "/repo/demo" : "/worktrees/demo/demo-fix",
    attached: false,
    windowCount: 1,
    createdAtMs: 1_783_700_001_000,
    activityAtMs: 1_783_700_020_000,
  };
}

function resolvedFor(request) {
  const base = { kind: "resolved", ...evidence() };
  if (request.operation === "create_worktree" || request.operation === "create_terminal") {
    return {
      ...base,
      target: {
        authority: "tw_rpc",
        operation: request.operation,
        processTarget: {
          kind: request.operation === "create_terminal" ? "ssh" : "local",
          scopeId: request.scopeId,
          targetId: request.operation === "create_terminal" ? "configured-devbox" : "bundled-local-cli",
        },
        capabilities: [...rpcV2.RPC_V2_CAPABILITIES],
        arguments: structuredClone(request.arguments),
        prospectiveSession: prospectiveSession(request.operation),
      },
    };
  }
  if (request.operation === "kill_session") {
    return {
      ...base,
      target: {
        authority: "tw_rpc",
        operation: request.operation,
        processTarget: { kind: "local", scopeId: request.scopeId, targetId: "bundled-local-cli" },
        capabilities: [...rpcV2.RPC_V2_CAPABILITIES],
        managedTarget: {
          name: "tw-term-a1b2c",
          kind: "terminal",
          incarnation: INCARNATION,
        },
      },
    };
  }
  return {
    ...base,
    target: {
      authority: "terminal_control",
      operation: request.operation,
      scopeId: request.scopeId,
      pane: "0",
      lease: {
        controlTargetId: "target-exact-1",
        controlEpoch: "control-epoch-1",
        leaseId: "lease-exact-1",
        fence: "7",
        owner: { kind: "relay-v2", instanceId: "relay-v2-host-instance-1" },
        expiresAt: "2026-07-16T12:00:00.000Z",
      },
    },
  };
}

function exitedJson(value, overrides = {}) {
  return {
    kind: "exited",
    exitCode: 0,
    signal: null,
    stdout: new TextEncoder().encode(`${JSON.stringify(value)}\n`),
    stderr: new Uint8Array(),
    elapsedMs: 10,
    ...overrides,
  };
}

function createSession(operation, reservationCorrelation) {
  const terminal = operation === "create-terminal";
  return {
    name: terminal ? "tw-term-a1b2c" : "demo-fix",
    kind: terminal ? "terminal" : "worktree",
    profile: "dashboard",
    project: terminal ? null : "demo",
    label: terminal ? "demo" : null,
    repoPath: terminal ? null : "/repo/demo",
    worktreePath: terminal ? null : "/worktrees/demo/demo-fix",
    branch: terminal ? null : "demo-fix",
    baseBranch: terminal ? null : "main",
    cwd: terminal ? "/repo/demo" : "/worktrees/demo/demo-fix",
    createdAt: CREATED_AT,
    attached: false,
    windows: 1,
    created: 1_783_700_010,
    activity: 1_783_700_020,
    incarnation: terminal ? INCARNATION : OTHER_INCARNATION,
    lifecycleMarked: true,
    reservationCorrelation: structuredClone(reservationCorrelation),
  };
}

function successResponseForProcessCall(call) {
  const operation = call.argv[1];
  const request = JSON.parse(call.argv[3]);
  if (operation === "kill-session") {
    return {
      protocolVersion: 2,
      operation,
      state: "succeeded",
      name: request.name,
      kind: "terminal",
      incarnation: request.expectedIncarnation,
      terminated: true,
      sessionId: "$7",
    };
  }
  return {
    protocolVersion: 2,
    operation,
    state: "succeeded",
    session: createSession(operation, request.reservationCorrelation),
  };
}

function fakePorts(overrides = {}) {
  const calls = { resolve: [], process: [], terminal: [] };
  return {
    calls,
    resolver: {
      async resolve(request) {
        calls.resolve.push(structuredClone(request));
        return overrides.resolve ? overrides.resolve(request) : resolvedFor(request);
      },
    },
    process: {
      async execute(request) {
        calls.process.push(structuredClone(request));
        if (overrides.process) return overrides.process(request);
        return exitedJson(successResponseForProcessCall(request));
      },
    },
    terminalControl: {
      async sendAgentMessage(input) {
        calls.terminal.push(structuredClone(input));
        if (overrides.terminal) return overrides.terminal(input);
        return {
          state: "succeeded",
          result: {
            operationId: input.operationId,
            accepted: true,
            deduplicated: false,
            controlEpoch: input.lease.controlEpoch,
            fence: input.lease.fence,
            outputGeneration: "output-generation-1",
            outputCursor: 12,
          },
        };
      },
    },
  };
}

function executorFor(ports) {
  return new adapterModule.RelayV2CanonicalCommandExecutorAdapter(ports);
}

async function executionPlan(executor, request, reservationId = "reservation-stable-1") {
  const admission = await executor.resolve(request);
  assert.equal(admission.kind, "executable");
  return {
    schemaVersion: 1,
    authority: request.authority,
    operation: request.operation,
    principalId: request.principalId,
    hostId: request.hostId,
    hostEpoch: request.hostEpoch,
    scopeId: request.scopeId,
    sessionId: request.sessionId,
    arguments: structuredClone(request.arguments),
    adapterState: structuredClone(admission.adapterState),
    resourceReservation: request.operation === "create_worktree" || request.operation === "create_terminal"
      ? { schemaVersion: 1, owner: "relay_v2_resource_state", reservationId }
      : null,
  };
}

function hasKey(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKey(item, key));
}

test("create adapter state reserves resources without carrying a public Session ID", async () => {
  const ports = fakePorts();
  const admission = await executorFor(ports).resolve(canonicalRequest("create_worktree"));
  assert.equal(admission.kind, "executable");
  assert.equal(hasKey(admission.adapterState, "sessionId"), false);
  assert.equal(hasKey(admission.resourceReservationPlan, "sessionId"), false);
  for (const sensitiveKey of ["secret", "token", "credential"]) {
    assert.equal(hasKey(admission.adapterState, sensitiveKey), false);
  }
  assert.equal(ports.calls.resolve.length, 1);
  assert.equal(ports.calls.process.length, 0);
  assert.equal(ports.calls.terminal.length, 0);
});

test("canonical executor translates all four operations to one exact authority call", async () => {
  const ports = fakePorts();
  const executor = executorFor(ports);
  const outcomes = {};
  for (const operation of [
    "create_worktree", "create_terminal", "send_agent_message", "kill_session",
  ]) {
    const request = canonicalRequest(operation);
    const plan = await executionPlan(executor, request, `reservation-${operation}`);
    outcomes[operation] = request.authority === "tw_rpc"
      ? await executor.executeTwRpc(plan)
      : await executor.executeTerminalControl(plan);
    assert.equal(outcomes[operation].state, "succeeded", operation);
  }

  assert.equal(ports.calls.resolve.length, 4);
  assert.deepEqual(
    ports.calls.process.map((call) => [call.target.kind, call.argv.slice(0, 3)]),
    [
      ["local", ["rpc-v2", "create-worktree", "--request-json"]],
      ["ssh", ["rpc-v2", "create-terminal", "--request-json"]],
      ["local", ["rpc-v2", "kill-session", "--request-json"]],
    ],
  );
  assert.equal(ports.calls.terminal.length, 1);
  for (const call of ports.calls.process) {
    assert.equal(call.executable, "tw");
    assert.equal(call.stdin, null);
    assert.equal(call.maxStdoutBytes, adapterModule.RELAY_V2_CANONICAL_PROCESS_STDOUT_BYTES);
    assert.equal(call.maxStderrBytes, adapterModule.RELAY_V2_CANONICAL_PROCESS_STDERR_BYTES);
    assert.equal(call.maxResponseFrameBytes, adapterModule.RELAY_V2_CANONICAL_RPC_FRAME_BYTES);
    assert.equal(call.argv.some((value) => /twcap2\.|twref2\.|twenroll2\.|twhostboot2\./.test(value)), false);
  }

  const worktreeRequest = JSON.parse(ports.calls.process[0].argv[3]);
  assert.equal(worktreeRequest.reservationCorrelation.reservationId, "reservation-create_worktree");
  assert.equal(worktreeRequest.reservationCorrelation.commandId, "cmd-create_worktree");
  assert.deepEqual(worktreeRequest.reservationCorrelation.requestFingerprint, fingerprint("a"));
  const terminalRequest = JSON.parse(ports.calls.process[1].argv[3]);
  assert.equal(terminalRequest.reservationCorrelation.reservationId, "reservation-create_terminal");
  const killRequest = JSON.parse(ports.calls.process[2].argv[3]);
  assert.deepEqual(killRequest, {
    name: "tw-term-a1b2c",
    expectedIncarnation: INCARNATION,
  });

  for (const operation of ["create_worktree", "create_terminal"]) {
    assert.equal(hasKey(outcomes[operation].backendOutcome.evidence, "sessionId"), false);
    assert.equal(hasKey(outcomes[operation].commitIntent, "sessionId"), false);
  }
  assert.equal(outcomes.create_worktree.backendOutcome.backendInstanceKey, OTHER_INCARNATION);
  assert.equal(outcomes.create_terminal.backendOutcome.backendInstanceKey, INCARNATION);
  assert.equal(outcomes.kill_session.backendOutcome.backendInstanceKey, INCARNATION);

  assert.deepEqual(ports.calls.terminal[0], {
    scopeId: SCOPE_ID,
    lease: resolvedFor(canonicalRequest("send_agent_message")).target.lease,
    operationId: "relay-v2:cmd-send_agent_message",
    pane: "0",
    message: "continue",
    submit: true,
  });
  assert.deepEqual(outcomes.send_agent_message.result, {
    pane: 0,
    submit: true,
    messageUtf8Bytes: 8,
  });
});

test("resolver coverage alone controls immutable not-found admission", async () => {
  const responses = new Map([
    ["cmd-complete", {
      kind: "not_found",
      ...evidence("complete"),
      code: "SESSION_NOT_FOUND",
    }],
    ["cmd-partial", {
      kind: "not_found",
      ...evidence("partial"),
      code: "SESSION_NOT_FOUND",
    }],
    ["cmd-unreachable", {
      kind: "unavailable",
      ...evidence("unreachable"),
      code: "SCOPE_UNREACHABLE",
      retryAfterMs: 100,
    }],
  ]);
  const ports = fakePorts({ resolve: (request) => responses.get(request.commandId) });
  const executor = executorFor(ports);

  const complete = await executor.resolve(canonicalRequest("kill_session", { commandId: "cmd-complete" }));
  assert.equal(complete.kind, "immutable_business_failure");
  assert.equal(complete.error.code, "SESSION_NOT_FOUND");
  assert.equal(complete.authorityEvidence.coverage, "complete");

  for (const commandId of ["cmd-partial", "cmd-unreachable"]) {
    const admission = await executor.resolve(canonicalRequest("kill_session", { commandId }));
    assert.equal(admission.kind, "transient_admission_failure", commandId);
    assert.equal(admission.error.retryable, true, commandId);
    assert.equal(admission.error.commandDisposition, "not_accepted", commandId);
    assert.notEqual(admission.authorityEvidence.coverage, "complete", commandId);
  }
  assert.equal(ports.calls.process.length, 0);
  assert.equal(ports.calls.terminal.length, 0);

  const missingCapabilityPorts = fakePorts({
    resolve: (request) => {
      const resolved = resolvedFor(request);
      resolved.target.capabilities = resolved.target.capabilities.slice(1);
      return resolved;
    },
  });
  const unavailable = await executorFor(missingCapabilityPorts).resolve(
    canonicalRequest("kill_session"),
  );
  assert.equal(unavailable.kind, "transient_admission_failure");
  assert.equal(unavailable.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(unavailable.error.commandDisposition, "not_accepted");
});

test("TW RPC maps only explicit no-side-effect failure and strict correlated success", async (t) => {
  const scenarios = [
    {
      name: "explicit not-applied",
      result: exitedJson({
        protocolVersion: 2,
        operation: "create-terminal",
        state: "failed",
        sideEffect: "not_applied",
        error: { code: "CREATE_FAILED", message: "preflight rejected" },
      }),
      expected: "failed",
    },
    {
      name: "explicit in-doubt",
      result: exitedJson({
        protocolVersion: 2,
        operation: "create-terminal",
        state: "in_doubt",
        error: { code: "IN_DOUBT", message: "commit uncertain" },
      }),
      expected: "in_doubt",
    },
    {
      name: "timeout",
      result: {
        kind: "timed_out",
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        elapsedMs: 30_000,
      },
      expected: "in_doubt",
    },
    {
      name: "nonzero exit",
      result: exitedJson({}, { exitCode: 1 }),
      expected: "in_doubt",
    },
    {
      name: "malformed frame",
      result: exitedJson({ protocolVersion: 2, operation: "create-terminal", state: "succeeded" }),
      expected: "in_doubt",
    },
    {
      name: "duplicate JSON key",
      result: {
        kind: "exited",
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode('{"protocolVersion":2,"protocolVersion":2}\n'),
        stderr: new Uint8Array(),
        elapsedMs: 1,
      },
      expected: "in_doubt",
    },
    {
      name: "stdout hard limit",
      result: exitedJson({}, {
        stdout: new Uint8Array(adapterModule.RELAY_V2_CANONICAL_PROCESS_STDOUT_BYTES + 1),
      }),
      expected: "in_doubt",
    },
    {
      name: "stderr hard limit",
      result: exitedJson({}, {
        stderr: new Uint8Array(adapterModule.RELAY_V2_CANONICAL_PROCESS_STDERR_BYTES + 1),
      }),
      expected: "in_doubt",
    },
    {
      name: "elapsed hard limit",
      result: exitedJson({}, {
        elapsedMs: adapterModule.RELAY_V2_CANONICAL_MUTATION_TIMEOUT_MS + 1,
      }),
      expected: "in_doubt",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const ports = fakePorts({ process: () => scenario.result });
      const executor = executorFor(ports);
      const plan = await executionPlan(executor, canonicalRequest("create_terminal"));
      const outcome = await executor.executeTwRpc(plan);
      assert.equal(outcome.state, scenario.expected);
      assert.equal(ports.calls.process.length, 1, "must not retry or invoke a fallback");
      assert.equal(ports.calls.terminal.length, 0);
    });
  }

  await t.test("response correlation mismatch", async () => {
    const ports = fakePorts({
      process: (call) => {
        const response = successResponseForProcessCall(call);
        response.session.reservationCorrelation.commandId = "different-command";
        return exitedJson(response);
      },
    });
    const executor = executorFor(ports);
    const plan = await executionPlan(executor, canonicalRequest("create_terminal"));
    assert.equal((await executor.executeTwRpc(plan)).state, "in_doubt");
    assert.equal(ports.calls.process.length, 1);
  });

  await t.test("persisted capability uncertainty", async () => {
    const ports = fakePorts();
    const executor = executorFor(ports);
    const plan = await executionPlan(executor, canonicalRequest("create_terminal"));
    plan.adapterState.target.capabilities = plan.adapterState.target.capabilities.slice(1);
    assert.equal((await executor.executeTwRpc(plan)).state, "in_doubt");
    assert.equal(ports.calls.process.length, 0);
  });

  await t.test("kill explicit not-applied", async () => {
    const ports = fakePorts({
      process: () => exitedJson({
        protocolVersion: 2,
        operation: "kill-session",
        state: "failed",
        sideEffect: "not_applied",
        code: "INCARNATION_MISMATCH",
        message: "the managed incarnation changed before execution",
      }),
    });
    const executor = executorFor(ports);
    const plan = await executionPlan(executor, canonicalRequest("kill_session"));
    const outcome = await executor.executeTwRpc(plan);
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.sideEffect, "not_applied");
    assert.equal(ports.calls.process.length, 1);
    assert.equal(ports.calls.terminal.length, 0);
  });
});

test("terminal-control requires exact success correlation or explicit not-applied proof", async (t) => {
  const scenarios = [
    {
      name: "not-applied",
      response: {
        state: "failed",
        sideEffect: "not_applied",
        error: { code: "PERMISSION_DENIED", message: "fence rejected before write" },
      },
      expected: "failed",
    },
    { name: "ambiguous", response: { state: "ambiguous" }, expected: "in_doubt" },
    { name: "in-doubt", response: { state: "in_doubt" }, expected: "in_doubt" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const ports = fakePorts({ terminal: () => scenario.response });
      const executor = executorFor(ports);
      const plan = await executionPlan(executor, canonicalRequest("send_agent_message"));
      const outcome = await executor.executeTerminalControl(plan);
      assert.equal(outcome.state, scenario.expected);
      assert.equal(ports.calls.terminal.length, 1);
      assert.equal(ports.calls.process.length, 0);
    });
  }

  await t.test("success mismatch", async () => {
    const ports = fakePorts({
      terminal: (input) => ({
        state: "succeeded",
        result: {
          operationId: input.operationId,
          accepted: true,
          deduplicated: false,
          controlEpoch: input.lease.controlEpoch,
          fence: "8",
          outputGeneration: "output-generation-1",
          outputCursor: 0,
        },
      }),
    });
    const executor = executorFor(ports);
    const plan = await executionPlan(executor, canonicalRequest("send_agent_message"));
    assert.equal((await executor.executeTerminalControl(plan)).state, "in_doubt");
    assert.equal(ports.calls.terminal.length, 1);
  });

  await t.test("transport exception", async () => {
    const ports = fakePorts({ terminal: () => { throw new Error("socket outcome unknown"); } });
    const executor = executorFor(ports);
    const plan = await executionPlan(executor, canonicalRequest("send_agent_message"));
    assert.equal((await executor.executeTerminalControl(plan)).state, "in_doubt");
    assert.equal(ports.calls.terminal.length, 1);
  });
});
