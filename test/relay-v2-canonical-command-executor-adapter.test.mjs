import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adapterModule = await import("../dist/relay/v2/canonicalCommandExecutorAdapter.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const rpcV2 = await import("../dist/rpcV2.js");
const backendIdentityFixture = JSON.parse(readFileSync(
  new URL("./fixtures/relay-v2-canonical-backend-identity-v1.json", import.meta.url),
  "utf8",
));

const HOST_ID = "mac-admin";
const HOST_EPOCH = "host-epoch-1";
const SCOPE_ID = "scope-local";
const INCARNATION = `twinc2.${"A".repeat(43)}`;
const OTHER_INCARNATION = `twinc2.${"B".repeat(43)}`;
const CREATED_AT = "2026-07-12T00:00:01.000Z";
const RAW_WORKTREE_NAME = "demo-fix-backend-1";
const WORKTREE_BRANCH = "demo-fix-7f3";
const WORKTREE_PATH = `/worktrees/demo/${WORKTREE_BRANCH}`;
const WORKTREE_DISPLAY = "fix-1";

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

function prospectiveSession(operation, execution) {
  const terminal = operation === "create_terminal";
  return {
    kind: terminal ? "terminal" : "worktree",
    displayName: execution.publicDisplayName,
    state: "running",
    project: terminal ? null : execution.effectiveProject,
    label: terminal ? execution.publicDisplayName : null,
    cwd: terminal ? execution.canonicalCwd : execution.worktreePath,
    attached: false,
    windowCount: 1,
    createdAtMs: 1_783_700_001_000,
    activityAtMs: 1_783_700_020_000,
  };
}

function resolvedFor(request) {
  const base = { kind: "resolved", ...evidence() };
  if (request.operation === "create_worktree" || request.operation === "create_terminal") {
    const args = structuredClone(request.arguments);
    const execution = request.operation === "create_worktree"
      ? {
          canonicalRepoPath: "/repo/demo",
          effectiveProject: args.project ?? "demo",
          effectiveBaseBranch: args.branch ?? "main",
          rawSessionName: RAW_WORKTREE_NAME,
          publicDisplayName: args.name ? `${args.name}-1` : `${args.project ?? "demo"}-1`,
          worktreeBase: "/worktrees",
          worktreePath: WORKTREE_PATH,
          worktreeBranch: WORKTREE_BRANCH,
        }
      : {
          canonicalCwd: "/repo/demo",
          publicDisplayName: args.label ?? "demo",
        };
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
        arguments: args,
        execution,
        publicDisplayName: execution.publicDisplayName,
        prospectiveSession: prospectiveSession(request.operation, execution),
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

function createSession(operation, request) {
  const terminal = operation === "create-terminal";
  const execution = terminal ? null : request.execution;
  return {
    name: terminal ? "tw-term-a1b2c" : execution.rawSessionName,
    kind: terminal ? "terminal" : "worktree",
    profile: "dashboard",
    project: terminal ? null : execution.effectiveProject,
    label: terminal ? request.arguments.label : execution.publicDisplayName,
    repoPath: terminal ? null : execution.canonicalRepoPath,
    worktreePath: terminal ? null : execution.worktreePath,
    branch: terminal ? null : execution.worktreeBranch,
    baseBranch: terminal ? null : execution.effectiveBaseBranch,
    cwd: terminal ? request.arguments.cwd : execution.worktreePath,
    createdAt: CREATED_AT,
    attached: false,
    windows: 1,
    created: 1_783_700_010,
    activity: 1_783_700_020,
    incarnation: terminal ? INCARNATION : OTHER_INCARNATION,
    lifecycleMarked: true,
    reservationCorrelation: structuredClone(request.reservationCorrelation),
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
    session: createSession(operation, request),
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
    commandId: request.commandId,
    requestFingerprint: structuredClone(request.requestFingerprint),
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
      ["local", ["rpc-v2", "create-worktree-resolved", "--request-json"]],
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
  assert.deepEqual(worktreeRequest.arguments, canonicalRequest("create_worktree").arguments);
  assert.deepEqual(worktreeRequest.execution, resolvedFor(
    canonicalRequest("create_worktree"),
  ).target.execution);
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
  for (const operation of ["create_worktree", "create_terminal", "kill_session"]) {
    assert.match(outcomes[operation].backendOutcome.backendInstanceKey, /^twbk2\.[A-Za-z0-9_-]{43}$/);
  }
  assert.notEqual(outcomes.create_worktree.backendOutcome.backendInstanceKey, OTHER_INCARNATION);
  assert.notEqual(outcomes.create_terminal.backendOutcome.backendInstanceKey, INCARNATION);
  assert.equal(
    outcomes.create_terminal.backendOutcome.backendInstanceKey,
    backendIdentityFixture.vectors.find((vector) => (
      vector.processTarget.kind === "ssh"
      && vector.processTarget.targetId === "configured-devbox"
    )).expected,
  );
  assert.notEqual(
    outcomes.create_terminal.backendOutcome.backendInstanceKey,
    outcomes.kill_session.backendOutcome.backendInstanceKey,
  );
  assert.equal(outcomes.create_worktree.backendOutcome.evidence.session.displayName, WORKTREE_DISPLAY);
  assert.equal(JSON.stringify(outcomes.create_worktree.backendOutcome.evidence).includes(RAW_WORKTREE_NAME), false);
  assert.equal(outcomes.create_terminal.backendOutcome.evidence.session.displayName, "demo");
  assert.equal(outcomes.create_terminal.backendOutcome.evidence.session.label, "demo");

  const { operationId, ...terminalCall } = ports.calls.terminal[0];
  assert.match(operationId, /^twmsg2\.[A-Za-z0-9_-]{43}$/);
  assert.ok(Buffer.byteLength(operationId, "utf8") <= 192);
  assert.deepEqual(terminalCall, {
    scopeId: SCOPE_ID,
    lease: resolvedFor(canonicalRequest("send_agent_message")).target.lease,
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

test("complete not-found evidence is closed over each operation", async (t) => {
  const allowed = {
    create_worktree: new Set(["SCOPE_NOT_FOUND"]),
    create_terminal: new Set(["SCOPE_NOT_FOUND"]),
    send_agent_message: new Set(["SCOPE_NOT_FOUND", "SESSION_NOT_FOUND", "PANE_NOT_FOUND"]),
    kill_session: new Set(["SCOPE_NOT_FOUND", "SESSION_NOT_FOUND"]),
  };
  const codes = [
    "SCOPE_NOT_FOUND", "PROJECT_NOT_FOUND", "SESSION_NOT_FOUND", "PANE_NOT_FOUND",
  ];
  for (const [operation, operationCodes] of Object.entries(allowed)) {
    for (const code of codes) {
      await t.test(`${operation}/${code}`, async () => {
        const ports = fakePorts({
          resolve: () => ({ kind: "not_found", ...evidence("complete"), code }),
        });
        const admission = await executorFor(ports).resolve(canonicalRequest(operation));
        if (operationCodes.has(code)) {
          assert.equal(admission.kind, "immutable_business_failure");
          assert.equal(admission.error.code, code);
        } else {
          assert.equal(admission.kind, "transient_admission_failure");
          assert.equal(admission.error.code, "INTERNAL");
          assert.equal(admission.error.commandDisposition, "not_accepted");
        }
        assert.equal(ports.calls.process.length, 0);
        assert.equal(ports.calls.terminal.length, 0);
      });
    }
  }
});

test("PROJECT_NOT_FOUND is final only for catalog lookup without an explicit path", async () => {
  const ports = fakePorts({
    resolve: () => ({
      kind: "not_found",
      ...evidence("complete"),
      code: "PROJECT_NOT_FOUND",
    }),
  });
  const executor = executorFor(ports);
  const pathPresent = await executor.resolve(canonicalRequest("create_worktree"));
  assert.equal(pathPresent.kind, "transient_admission_failure");
  assert.equal(pathPresent.error.code, "INTERNAL");
  assert.equal(pathPresent.error.commandDisposition, "not_accepted");

  const catalogOnly = await executor.resolve(canonicalRequest("create_worktree", {
    arguments: {
      project: "demo",
      name: "fix",
      branch: "main",
      aiCommand: "codex",
    },
  }));
  assert.equal(catalogOnly.kind, "immutable_business_failure");
  assert.equal(catalogOnly.error.code, "PROJECT_NOT_FOUND");
  assert.equal(ports.calls.process.length, 0);
  assert.equal(ports.calls.terminal.length, 0);
});

test("resolver runtime result variants are exact closed unions", async (t) => {
  const request = canonicalRequest("create_terminal");
  const resolved = resolvedFor(request);
  const unavailable = {
    kind: "unavailable",
    ...evidence("partial"),
    code: "BUSY",
  };
  const malformed = [
    ["unknown kind", { ...resolved, kind: "future_resolved" }],
    ["resolved extra field", { ...resolved, futureField: true }],
    ["resolved illegal coverage", { ...resolved, coverage: "partial" }],
    ["unavailable extra field", { ...unavailable, futureField: true }],
    ["unavailable complete coverage", { ...unavailable, coverage: "complete" }],
    ["unavailable unknown code", { ...unavailable, code: "FUTURE_BUSY" }],
    ["unavailable negative retry", { ...unavailable, retryAfterMs: -1 }],
    ["unavailable fractional retry", { ...unavailable, retryAfterMs: 1.5 }],
    ["not-found extra field", {
      kind: "not_found",
      ...evidence("complete"),
      code: "SCOPE_NOT_FOUND",
      futureField: true,
    }],
    ["resolver evidence extra field", {
      ...resolved,
      evidence: { ...resolved.evidence, futureField: true },
    }],
  ];
  for (const [name, result] of malformed) {
    await t.test(name, async () => {
      const ports = fakePorts({ resolve: () => structuredClone(result) });
      const admission = await executorFor(ports).resolve(request);
      assert.equal(admission.kind, "transient_admission_failure");
      assert.equal(admission.error.code, "INTERNAL");
      assert.equal(admission.error.commandDisposition, "not_accepted");
      assert.equal(ports.calls.process.length, 0);
      assert.equal(ports.calls.terminal.length, 0);
    });
  }
});

test("resolver cannot rewrite accepted pure create arguments", async (t) => {
  const cases = [
    ["aiCommand", "create_worktree", (target) => { target.arguments.aiCommand = "other-agent"; }],
    ["name", "create_worktree", (target) => { target.arguments.name = "other-name"; }],
    ["project", "create_worktree", (target) => { target.arguments.project = "other-project"; }],
    ["branch", "create_worktree", (target) => { target.arguments.branch = "other-branch"; }],
    ["public display", "create_worktree", (target) => {
      target.publicDisplayName = "other-display";
      target.prospectiveSession.displayName = "other-display";
      target.execution.publicDisplayName = "other-display";
    }],
    ["label", "create_terminal", (target) => { target.arguments.label = "other-label"; }],
    ["cwd", "create_terminal", (target) => { target.arguments.cwd = "/other/user-input"; }],
  ];
  for (const [name, operation, mutate] of cases) {
    await t.test(name, async () => {
      const ports = fakePorts({
        resolve: (request) => {
          const resolved = resolvedFor(request);
          mutate(resolved.target);
          return resolved;
        },
      });
      const admission = await executorFor(ports).resolve(canonicalRequest(operation));
      assert.equal(admission.kind, "transient_admission_failure");
      assert.equal(admission.error.commandDisposition, "not_accepted");
      assert.equal(ports.calls.process.length, 0);
      assert.equal(ports.calls.terminal.length, 0);
    });
  }

  await t.test("enumerated canonical path and cwd derivation", async () => {
    const ports = fakePorts({
      resolve: (request) => {
        const resolved = resolvedFor(request);
        if (request.operation === "create_worktree") {
          resolved.target.execution.canonicalRepoPath = "/canonical/repo/demo";
        } else {
          resolved.target.execution.canonicalCwd = "/canonical/repo/demo";
          resolved.target.prospectiveSession.cwd = "/canonical/repo/demo";
        }
        return resolved;
      },
    });
    const executor = executorFor(ports);
    assert.equal((await executor.resolve(canonicalRequest("create_worktree"))).kind, "executable");
    assert.equal((await executor.resolve(canonicalRequest("create_terminal"))).kind, "executable");
    assert.equal(ports.calls.process.length, 0);
  });

  await t.test("path-only effective project is the canonical repo basename", async () => {
    const request = canonicalRequest("create_worktree", {
      arguments: { path: "/catalog/link", aiCommand: "codex" },
    });
    const invalidPorts = fakePorts({
      resolve: (accepted) => {
        const answer = resolvedFor(accepted);
        answer.target.execution.effectiveProject = "resolver-choice";
        answer.target.execution.publicDisplayName = "resolver-choice-1";
        answer.target.execution.worktreePath = `/worktrees/resolver-choice/${WORKTREE_BRANCH}`;
        answer.target.publicDisplayName = "resolver-choice-1";
        answer.target.prospectiveSession.displayName = "resolver-choice-1";
        answer.target.prospectiveSession.project = "resolver-choice";
        answer.target.prospectiveSession.cwd = answer.target.execution.worktreePath;
        return answer;
      },
    });
    const invalid = await executorFor(invalidPorts).resolve(request);
    assert.equal(invalid.kind, "transient_admission_failure");
    assert.equal(invalid.error.commandDisposition, "not_accepted");
    assert.equal(invalidPorts.calls.process.length, 0);

    const validPorts = fakePorts({
      resolve: (accepted) => {
        const answer = resolvedFor(accepted);
        const project = "canonical-project";
        answer.target.execution.canonicalRepoPath = `/real/${project}`;
        answer.target.execution.effectiveProject = project;
        answer.target.execution.publicDisplayName = `${project}-1`;
        answer.target.execution.worktreePath = `/worktrees/${project}/${WORKTREE_BRANCH}`;
        answer.target.publicDisplayName = `${project}-1`;
        answer.target.prospectiveSession.displayName = `${project}-1`;
        answer.target.prospectiveSession.project = project;
        answer.target.prospectiveSession.cwd = answer.target.execution.worktreePath;
        return answer;
      },
    });
    assert.equal((await executorFor(validPorts).resolve(request)).kind, "executable");
  });

  await t.test("omitted terminal label is derived from canonical cwd", async () => {
    const request = canonicalRequest("create_terminal", {
      arguments: { cwd: "/input/link" },
    });
    const invalidPorts = fakePorts({
      resolve: (accepted) => {
        const answer = resolvedFor(accepted);
        answer.target.execution.publicDisplayName = "resolver-choice";
        answer.target.publicDisplayName = "resolver-choice";
        answer.target.prospectiveSession.displayName = "resolver-choice";
        answer.target.prospectiveSession.label = "resolver-choice";
        return answer;
      },
    });
    const invalid = await executorFor(invalidPorts).resolve(request);
    assert.equal(invalid.kind, "transient_admission_failure");
    assert.equal(invalid.error.commandDisposition, "not_accepted");
    assert.equal(invalidPorts.calls.process.length, 0);

    const rootPorts = fakePorts({
      resolve: (accepted) => {
        const answer = resolvedFor(accepted);
        answer.target.execution.canonicalCwd = "/";
        answer.target.execution.publicDisplayName = "Terminal";
        answer.target.publicDisplayName = "Terminal";
        answer.target.prospectiveSession.displayName = "Terminal";
        answer.target.prospectiveSession.label = "Terminal";
        answer.target.prospectiveSession.cwd = "/";
        return answer;
      },
    });
    assert.equal((await executorFor(rootPorts).resolve(request)).kind, "executable");
  });
});

test("resolved worktree freezes omitted defaults without synthesizing public arguments", async () => {
  const request = canonicalRequest("create_worktree", {
    arguments: {
      project: "demo",
      path: "/catalog/demo",
      aiCommand: "codex --resume exact",
    },
  });
  const externalAuthority = {
    canonicalRepoPath: "/real/demo",
    effectiveBaseBranch: "release/2026",
    worktreeBase: "/frozen/worktrees",
    worktreeBranch: "demo-release-91a",
    publicDisplayName: "demo-2",
  };
  const ports = fakePorts({
    resolve: (accepted) => {
      const resolved = resolvedFor(accepted);
      Object.assign(resolved.target.execution, externalAuthority, {
        worktreePath: `${externalAuthority.worktreeBase}/demo/${externalAuthority.worktreeBranch}`,
      });
      resolved.target.publicDisplayName = externalAuthority.publicDisplayName;
      resolved.target.prospectiveSession.displayName = externalAuthority.publicDisplayName;
      resolved.target.prospectiveSession.cwd = resolved.target.execution.worktreePath;
      return resolved;
    },
  });
  const executor = executorFor(ports);
  const plan = await executionPlan(executor, request);
  Object.assign(externalAuthority, {
    canonicalRepoPath: "/drifted/catalog/repo",
    effectiveBaseBranch: "drifted-origin-head",
    worktreeBase: "/drifted/config/worktrees",
    worktreeBranch: "drifted-branch",
    publicDisplayName: "drifted-label",
  });

  assert.equal((await executor.executeTwRpc(plan)).state, "succeeded");
  assert.equal(ports.calls.process.length, 1);
  const sent = JSON.parse(ports.calls.process[0].argv[3]);
  assert.deepEqual(sent.arguments, request.arguments);
  assert.equal(Object.hasOwn(sent.arguments, "name"), false);
  assert.equal(Object.hasOwn(sent.arguments, "branch"), false);
  assert.deepEqual(sent.execution, {
    canonicalRepoPath: "/real/demo",
    effectiveProject: "demo",
    effectiveBaseBranch: "release/2026",
    rawSessionName: RAW_WORKTREE_NAME,
    publicDisplayName: "demo-2",
    worktreeBase: "/frozen/worktrees",
    worktreePath: "/frozen/worktrees/demo/demo-release-91a",
    worktreeBranch: "demo-release-91a",
  });
});

test("backend instance keys bind process target and remain consistent for kill", async () => {
  const targets = [
    { kind: "local", scopeId: SCOPE_ID, targetId: "same-stable-target" },
    { kind: "ssh", scopeId: SCOPE_ID, targetId: "same-stable-target" },
    { kind: "ssh", scopeId: SCOPE_ID, targetId: "configured-devbox-two" },
  ];
  const keys = [];
  for (const target of targets) {
    const ports = fakePorts({
      resolve: (request) => {
        const resolved = resolvedFor(request);
        resolved.target.processTarget = structuredClone(target);
        return resolved;
      },
    });
    const executor = executorFor(ports);
    const create = await executor.executeTwRpc(await executionPlan(
      executor,
      canonicalRequest("create_terminal"),
    ));
    const kill = await executor.executeTwRpc(await executionPlan(
      executor,
      canonicalRequest("kill_session"),
    ));
    assert.equal(create.state, "succeeded");
    assert.equal(kill.state, "succeeded");
    const materializedBackendKey = create.backendOutcome.backendInstanceKey;
    assert.equal(kill.backendOutcome.backendInstanceKey, materializedBackendKey);
    assert.notEqual(materializedBackendKey, INCARNATION);
    keys.push(materializedBackendKey);
  }
  assert.equal(new Set(keys).size, targets.length);
});

test("terminal operation identity binds the full trusted ledger tuple", async () => {
  const ports = fakePorts();
  const executor = executorFor(ports);
  const requests = [
    canonicalRequest("send_agent_message", { commandId: "cmd-shared" }),
    canonicalRequest("send_agent_message", {
      commandId: "cmd-shared",
      principalId: "principal-two",
    }),
    canonicalRequest("send_agent_message", {
      commandId: "cmd-shared",
      hostEpoch: "host-epoch-2",
    }),
    canonicalRequest("send_agent_message", {
      commandId: "cmd-shared",
      hostId: "mac-admin-two",
    }),
    canonicalRequest("send_agent_message", {
      commandId: "cmd-shared",
      requestFingerprint: fingerprint("d"),
    }),
    canonicalRequest("send_agent_message", { commandId: "cmd-shared" }),
  ];
  for (const request of requests) {
    assert.equal((await executor.executeTerminalControl(
      await executionPlan(executor, request),
    )).state, "succeeded");
  }
  const operationIds = ports.calls.terminal.map((call) => call.operationId);
  assert.equal(operationIds[0], operationIds[5]);
  assert.equal(new Set(operationIds).size, requests.length - 1);
  assert.ok(operationIds.every((value) => Buffer.byteLength(value, "utf8") <= 192));
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

  for (const [name, operation, mutate] of [
    ["worktree repo drift", "create_worktree", (session) => { session.repoPath = "/other/repo"; }],
    ["worktree base drift", "create_worktree", (session) => { session.baseBranch = "other"; }],
    ["worktree path drift", "create_worktree", (session) => {
      session.worktreePath = "/other/worktree";
      session.cwd = "/other/worktree";
    }],
    ["worktree branch missing", "create_worktree", (session) => { session.branch = null; }],
    ["worktree cwd drift", "create_worktree", (session) => { session.cwd = "/other/cwd"; }],
    ["worktree raw label leak", "create_worktree", (session) => {
      session.label = RAW_WORKTREE_NAME;
    }],
    ["terminal worktree fields present", "create_terminal", (session) => {
      session.repoPath = "/repo/demo";
      session.worktreePath = "/worktrees/demo/unexpected";
      session.branch = "unexpected";
      session.baseBranch = "main";
    }],
  ]) {
    await t.test(name, async () => {
      const ports = fakePorts({
        process: (call) => {
          const response = successResponseForProcessCall(call);
          mutate(response.session);
          return exitedJson(response);
        },
      });
      const executor = executorFor(ports);
      const outcome = await executor.executeTwRpc(await executionPlan(
        executor,
        canonicalRequest(operation),
      ));
      assert.equal(outcome.state, "in_doubt");
      assert.equal(ports.calls.process.length, 1);
    });
  }

  await t.test("persisted capability uncertainty", async () => {
    const ports = fakePorts();
    const executor = executorFor(ports);
    const plan = await executionPlan(executor, canonicalRequest("create_terminal"));
    plan.adapterState.target.capabilities = plan.adapterState.target.capabilities.slice(1);
    assert.equal((await executor.executeTwRpc(plan)).state, "in_doubt");
    assert.equal(ports.calls.process.length, 0);
  });

  for (const [name, mutate] of [
    ["adapter command identity mismatch", (plan) => { plan.adapterState.commandId = "cmd-other"; }],
    ["adapter fingerprint identity mismatch", (plan) => {
      plan.adapterState.requestFingerprint = fingerprint("d");
    }],
  ]) {
    await t.test(name, async () => {
      const ports = fakePorts();
      const executor = executorFor(ports);
      const plan = await executionPlan(executor, canonicalRequest("create_terminal"));
      mutate(plan);
      assert.equal((await executor.executeTwRpc(plan)).state, "in_doubt");
      assert.equal(ports.calls.process.length, 0, "identity mismatch must fail before process I/O");
      assert.equal(ports.calls.terminal.length, 0);
    });
  }

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
    {
      name: "failed without proof",
      response: {
        state: "failed",
        error: { code: "PERMISSION_DENIED", message: "outcome lacks side-effect proof" },
      },
      expected: "in_doubt",
    },
    {
      name: "failed with ambiguous proof",
      response: {
        state: "failed",
        sideEffect: "unknown",
        error: { code: "PERMISSION_DENIED", message: "input may have been applied" },
      },
      expected: "in_doubt",
    },
    {
      name: "failed with extra field",
      response: {
        state: "failed",
        sideEffect: "not_applied",
        error: { code: "PERMISSION_DENIED", message: "fence rejected before write" },
        futureField: true,
      },
      expected: "in_doubt",
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
      if (scenario.expected === "failed") assert.equal(outcome.sideEffect, "not_applied");
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
