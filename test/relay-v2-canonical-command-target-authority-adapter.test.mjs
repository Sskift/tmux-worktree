import assert from "node:assert/strict";
import test from "node:test";

const targetModule = await import(
  "../dist/relay/v2/canonicalCommandTargetAuthorityAdapter.js"
);
const executorModule = await import(
  "../dist/relay/v2/canonicalCommandExecutorAdapter.js"
);
const { RPC_V2_CAPABILITIES } = await import("../dist/rpcV2.js");

const HOST_ID = "host-one";
const HOST_EPOCH = "host-epoch-one";
const SCOPE_ID = "scope-one";
const SESSION_ID = "session-opaque-one";
const INCARNATION = `twinc2.${"A".repeat(43)}`;

function request(operation, overrides = {}) {
  const create = operation === "create_worktree" || operation === "create_terminal";
  const terminal = operation === "send_agent_message";
  const args = {
    create_worktree: {
      project: "demo", path: "/repo/demo", name: "fix", branch: "main", aiCommand: "codex",
    },
    create_terminal: { cwd: "/repo/demo", label: "demo" },
    kill_session: {},
    send_agent_message: { pane: 0, message: "continue", submit: true },
  }[operation];
  return {
    fingerprintSchemaVersion: 1,
    commandId: `cmd-${operation}`,
    requestFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256-rfc8785",
      digest: (terminal ? "b" : create ? "a" : "c").repeat(64),
    },
    authority: terminal ? "terminal_control" : "tw_rpc",
    operation,
    principalId: "principal-one",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    scopeId: SCOPE_ID,
    sessionId: create ? null : SESSION_ID,
    arguments: args,
    ...overrides,
  };
}

function token() {
  return {
    schemaVersion: 1,
    hostEpoch: HOST_EPOCH,
    resourceMappingDigest: "resource-map-one",
    discoveryGeneration: "17",
  };
}

function scopeTarget() {
  return {
    authorization: "evidence_only",
    hostEpoch: HOST_EPOCH,
    discoveryGeneration: "17",
    scopeId: SCOPE_ID,
    processTarget: { kind: "local", targetId: "canonical-local-rpc" },
    capabilities: [...RPC_V2_CAPABILITIES],
  };
}

function sessionTarget() {
  return {
    ...scopeTarget(),
    sessionId: SESSION_ID,
    backendInstanceKey: "backend-instance-one",
    managedTarget: {
      name: "tw-term-one",
      kind: "terminal",
      incarnation: INCARNATION,
    },
  };
}

function h2Fence(req, result) {
  return {
    schemaVersion: 1,
    token: token(),
    expectedScopeId: req.scopeId,
    expectedSessionId: req.sessionId,
    result,
  };
}

function createEvidence(req) {
  if (req.operation === "create_worktree") {
    const execution = {
      canonicalRepoPath: "/repo/demo",
      effectiveProject: "demo",
      effectiveBaseBranch: "main",
      rawSessionName: "demo-fix-one",
      publicDisplayName: "fix-1",
      worktreeBase: "/worktrees",
      worktreePath: "/worktrees/demo/fix-one",
      worktreeBranch: "fix-one",
    };
    return {
      schemaVersion: 1,
      authorityToken: "create-cut-one",
      operation: req.operation,
      arguments: structuredClone(req.arguments),
      execution,
      publicDisplayName: execution.publicDisplayName,
      prospectiveSession: {
        kind: "worktree",
        displayName: execution.publicDisplayName,
        state: "running",
        project: execution.effectiveProject,
        label: null,
        cwd: execution.worktreePath,
        attached: false,
        windowCount: 1,
        createdAtMs: 1_785_000_000_000,
        activityAtMs: 1_785_000_000_000,
      },
    };
  }
  const execution = { canonicalCwd: "/repo/demo", publicDisplayName: "demo" };
  return {
    schemaVersion: 1,
    authorityToken: "create-cut-two",
    operation: req.operation,
    arguments: structuredClone(req.arguments),
    execution,
    publicDisplayName: execution.publicDisplayName,
    prospectiveSession: {
      kind: "terminal",
      displayName: execution.publicDisplayName,
      state: "running",
      project: null,
      label: execution.publicDisplayName,
      cwd: execution.canonicalCwd,
      attached: false,
      windowCount: 1,
      createdAtMs: 1_785_000_000_000,
      activityAtMs: 1_785_000_000_000,
    },
  };
}

function ports(overrides = {}) {
  const calls = { h2Fence: [], createFence: [], exactResolve: [], exactFence: [] };
  const resourceResolver = {
    async captureToken() {
      return token();
    },
    async resolveScopeForAdmission(_token, scopeId) {
      const req = request("create_worktree", { scopeId });
      if (overrides.scopeNegative) {
        return h2Fence(req, { kind: "complete_negative", code: "SCOPE_NOT_FOUND" });
      }
      return h2Fence(req, { kind: "positive", target: scopeTarget() });
    },
    async resolveSessionForAdmission(_token, scopeId, sessionId) {
      const req = request("kill_session", { scopeId, sessionId });
      if (overrides.sessionNegative) {
        return h2Fence(req, { kind: "complete_negative", code: "SESSION_NOT_FOUND" });
      }
      return h2Fence(req, { kind: "positive", target: sessionTarget() });
    },
    fenceResourceCutForAdmission(_transaction, fence) {
      calls.h2Fence.push(structuredClone(fence));
      return overrides.h2Fence?.(fence);
    },
  };
  const createTargetAuthority = {
    async resolveCreateTarget(input) {
      return createEvidence(input.request);
    },
    fenceCreateTargetForAdmission(input, evidence) {
      calls.createFence.push({ input: structuredClone(input), evidence: structuredClone(evidence) });
      return overrides.createFence?.(input, evidence);
    },
  };
  const exactTerminalTarget = {
    async resolveExactTarget(input) {
      calls.exactResolve.push(structuredClone(input));
      return {
        ...structuredClone(input),
        exactControlToken: "exact-terminal-cut-one",
        exactControlIdentity: {
          schemaVersion: 1,
          controlTargetId: "control-target-one",
          controlEpoch: "control-epoch-one",
          targetIncarnationProof: "target-incarnation-one",
        },
      };
    },
    fenceExactTargetForAdmission(input, evidence) {
      calls.exactFence.push({ input: structuredClone(input), evidence: structuredClone(evidence) });
      return overrides.exactFence?.(input, evidence);
    },
  };
  return { calls, resourceResolver, createTargetAuthority, exactTerminalTarget };
}

function resolverFor(p, options = {}) {
  return new targetModule.RelayV2CanonicalCommandTargetAuthorityAdapter({
    resourceResolver: p.resourceResolver,
    createTargetAuthority: p.createTargetAuthority,
    exactTerminalTarget: p.exactTerminalTarget,
    now: () => 1_785_000_000_000,
    ...options,
  });
}

test("one owner composes all four exact targets and only H2 emits complete negative", async () => {
  const p = ports();
  const resolver = resolverFor(p);
  for (const operation of [
    "create_worktree", "create_terminal", "kill_session", "send_agent_message",
  ]) {
    const resolution = await resolver.resolve(request(operation));
    assert.equal(resolution.kind, "resolved", operation);
    assert.equal(resolution.coverage, "complete", operation);
  }
  assert.equal(p.calls.exactResolve.length, 1);

  const scopeNegativePorts = ports({ scopeNegative: true });
  const scopeNegative = await resolverFor(scopeNegativePorts).resolve(request("create_worktree"));
  assert.equal(scopeNegative.kind, "not_found");
  assert.equal(scopeNegative.code, "SCOPE_NOT_FOUND");

  const sessionNegativePorts = ports({ sessionNegative: true });
  const sessionNegative = await resolverFor(sessionNegativePorts).resolve(request("kill_session"));
  assert.equal(sessionNegative.kind, "not_found");
  assert.equal(sessionNegative.code, "SESSION_NOT_FOUND");

  const noCreate = await resolverFor(p, { createTargetAuthority: undefined }).resolve(
    request("create_worktree"),
  );
  assert.equal(noCreate.kind, "unavailable");
  assert.notEqual(noCreate.code, "PROJECT_NOT_FOUND");
  const noPane = await resolverFor(p, { exactTerminalTarget: undefined }).resolve(
    request("send_agent_message"),
  );
  assert.equal(noPane.kind, "unavailable");
  assert.notEqual(noPane.code, "PANE_NOT_FOUND");
});

test("synchronous owner fence binds outer target before delegating H2", async () => {
  const order = [];
  const p = ports({
    exactFence: () => order.push("exact"),
    h2Fence: () => order.push("h2"),
  });
  const resolver = resolverFor(p);
  const req = request("send_agent_message");
  const resolution = await resolver.resolve(req);
  assert.equal(resolution.kind, "resolved");
  const fence = {
    schemaVersion: 1,
    outcome: "positive",
    authority: req.authority,
    operation: req.operation,
    expectedScopeId: req.scopeId,
    expectedSessionId: req.sessionId,
    target: structuredClone(resolution.target),
    evidence: structuredClone(resolution.admissionFence),
  };
  resolver.fenceResolution({ hostEpoch: HOST_EPOCH }, req, fence);
  assert.deepEqual(order, ["exact", "h2"]);

  const tampered = structuredClone(fence);
  tampered.target.targetBinding.managedTarget.incarnation = `twinc2.${"B".repeat(43)}`;
  assert.throws(
    () => resolver.fenceResolution({ hostEpoch: HOST_EPOCH }, req, tampered),
    /changed after resolution/,
  );
  assert.deepEqual(order, ["exact", "h2"]);

  const staleIdentity = structuredClone(fence);
  staleIdentity.target.targetBinding.exactControlIdentity.controlEpoch = "stale-epoch";
  assert.throws(
    () => resolver.fenceResolution({ hostEpoch: HOST_EPOCH }, req, staleIdentity),
    /changed after resolution/,
  );
  assert.equal(p.calls.h2Fence.length, 1);

  const staleEvidence = structuredClone(fence);
  staleEvidence.evidence.commandProof.evidence.exactControlIdentity.controlEpoch = "stale-cut";
  assert.throws(
    () => resolver.fenceResolution({ hostEpoch: HOST_EPOCH }, req, staleEvidence),
    /changed after resolution/,
  );
  assert.equal(p.calls.h2Fence.length, 1);

  const asyncPorts = ports({ exactFence: () => Promise.resolve() });
  const asyncResolver = resolverFor(asyncPorts);
  const asyncResolution = await asyncResolver.resolve(req);
  const asyncFence = { ...fence, target: asyncResolution.target, evidence: asyncResolution.admissionFence };
  assert.throws(
    () => asyncResolver.fenceResolution({ hostEpoch: HOST_EPOCH }, req, asyncFence),
    /must complete synchronously/,
  );
  assert.equal(asyncPorts.calls.h2Fence.length, 0);
});

function successRequestPort(calls, failAt = null) {
  return {
    async request(input) {
      calls.push(structuredClone(input));
      if (input.type === failAt) throw new Error(`${failAt} outcome unknown`);
      if (input.type === "lease.acquire") {
        return {
          lease: {
            controlTargetId: input.controlTargetId,
            controlEpoch: "control-epoch-one",
            leaseId: "lease-one",
            fence: "7",
            owner: input.owner,
            expiresAt: "2026-07-22T12:00:00.000Z",
          },
          ownership: {
            controlTargetId: input.controlTargetId,
            controlEpoch: "control-epoch-one",
            state: "HELD",
            fence: "7",
            ownerKind: "relay-v2",
            leaseExpiresAt: "2026-07-22T12:00:00.000Z",
            outputGeneration: "output-zero",
            outputCursor: 0,
            revision: "1",
          },
        };
      }
      if (input.type === "input.agent-message") {
        return {
          operationId: input.operationId,
          accepted: true,
          deduplicated: false,
          controlEpoch: input.lease.controlEpoch,
          fence: input.lease.fence,
          outputGeneration: "output-one",
          outputCursor: 8,
        };
      }
      return {
        controlTargetId: input.lease.controlTargetId,
        controlEpoch: input.lease.controlEpoch,
        state: "FREE",
        fence: "8",
        outputGeneration: "output-two",
        outputCursor: 8,
        revision: "2",
      };
    },
  };
}

async function terminalPlan(executor, req) {
  const admission = await executor.resolve(req);
  assert.equal(admission.kind, "executable");
  return { admission, plan: {
    schemaVersion: 1,
    commandId: req.commandId,
    requestFingerprint: structuredClone(req.requestFingerprint),
    authority: req.authority,
    operation: req.operation,
    principalId: req.principalId,
    hostId: req.hostId,
    hostEpoch: req.hostEpoch,
    scopeId: req.scopeId,
    sessionId: req.sessionId,
    arguments: structuredClone(req.arguments),
    adapterState: structuredClone(admission.adapterState),
    resourceReservation: null,
  } };
}

test("terminal lease side effects start only at execute and use one exact operationId", async () => {
  const p = ports();
  const calls = [];
  const resolver = resolverFor(p);
  const terminalControl = new targetModule.RelayV2CanonicalAgentMessageTerminalExecutionAdapter(
    successRequestPort(calls),
  );
  const executor = new executorModule.RelayV2CanonicalCommandExecutorAdapter({
    resolver,
    process: { execute: async () => { throw new Error("unexpected RPC"); } },
    terminalControl,
    terminalOwner: { kind: "relay-v2", instanceId: "host-instance-one" },
  });
  const req = request("send_agent_message");
  const { admission, plan } = await terminalPlan(executor, req);
  assert.equal(calls.length, 0);
  executor.fenceResolution({ hostEpoch: HOST_EPOCH }, req, admission.resolutionFence);
  assert.equal(calls.length, 0);

  const outcome = await executor.executeTerminalControl(plan);
  assert.equal(outcome.state, "succeeded");
  assert.deepEqual(calls.map((call) => call.type), [
    "lease.acquire", "input.agent-message", "lease.release",
  ]);
  assert.match(calls[1].operationId, /^twmsg2\.[A-Za-z0-9_-]{43}$/);
  const exactOperationId = calls[1].operationId;
  assert.equal((await executor.executeTerminalControl(plan)).state, "succeeded");
  assert.equal(calls[4].operationId, exactOperationId);
});

test("uncertain acquire, send, or release is IN_DOUBT and never retried", async (t) => {
  const binding = {
    schemaVersion: 1,
    hostId: HOST_ID,
    scopeId: SCOPE_ID,
    sessionId: SESSION_ID,
    pane: 0,
    processTarget: { kind: "local", targetId: "canonical-local-rpc" },
    backendInstanceKey: "backend-instance-one",
    managedTarget: { name: "tw-term-one", kind: "terminal", incarnation: INCARNATION },
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: "control-target-one",
      controlEpoch: "control-epoch-one",
      targetIncarnationProof: "target-incarnation-one",
    },
  };
  for (const [failAt, expectedCalls] of [
    ["lease.acquire", ["lease.acquire"]],
    ["input.agent-message", ["lease.acquire", "input.agent-message", "lease.release"]],
    ["lease.release", ["lease.acquire", "input.agent-message", "lease.release"]],
  ]) {
    await t.test(failAt, async () => {
      const calls = [];
      const adapter = new targetModule.RelayV2CanonicalAgentMessageTerminalExecutionAdapter(
        successRequestPort(calls, failAt),
      );
      const result = await adapter.executeAgentMessage({
        targetBinding: binding,
        owner: { kind: "relay-v2", instanceId: "host-instance-one" },
        operationId: "twmsg2.operation-one",
        pane: "0",
        message: "continue",
        submit: true,
      });
      assert.equal(result.state, "in_doubt");
      assert.deepEqual(calls.map((call) => call.type), expectedCalls);
    });
  }
});
