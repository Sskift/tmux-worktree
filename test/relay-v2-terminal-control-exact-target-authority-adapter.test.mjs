import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const terminalControl = await import("../dist/terminalControl/index.js");
const adapterModule = await import(
  "../dist/relay/v2/terminalControlExactTargetAuthorityAdapter.js"
);
const commandTargetModule = await import(
  "../dist/relay/v2/canonicalCommandTargetAuthorityAdapter.js"
);
const h3TerminalControlModule = await import(
  "../dist/relay/v2/terminalControlAuthorityAdapter.js"
);
const backendIdentity = await import("../dist/relay/v2/canonicalBackendIdentity.js");

const INCARNATION = `twinc2.${"A".repeat(43)}`;
const PROCESS_TARGET = Object.freeze({ kind: "local", targetId: "local-process-one" });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-v2-exact-terminal-"));
  const statePath = join(root, "terminal-control-state-v1.json");
  const calls = { inspect: 0, resolve: 0, prepareOutput: 0, resetOutput: 0, write: 0 };
  const backend = {
    async inspectExactTarget(input) {
      calls.inspect += 1;
      if (input.managedName !== "managed-one"
        || input.managedKind !== "worktree"
        || input.managedIncarnation !== INCARNATION
        || input.pane !== 0) {
        throw new terminalControl.TerminalControlProtocolError("TARGET_GONE", "exact target changed");
      }
      return {
        managedSession: {
          name: "managed-one",
          kind: "worktree",
          profile: "cli",
          cwd: "/repo",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
        managedIncarnation: INCARNATION,
        tmuxInstanceId: "tmux-instance-one",
        paneIdentity: "%1",
      };
    },
    async resolveManagedSession() {
      calls.resolve += 1;
      throw new Error("name-only resolution must not run");
    },
    async assertCurrent() {},
    async prepareOutput() {
      calls.prepareOutput += 1;
      return { generation: "output-generation-one", cursor: 0 };
    },
    async resetOutput() {
      calls.resetOutput += 1;
      return { generation: "output-generation-two", cursor: 0 };
    },
    async sendAgentMessage() { calls.write += 1; },
  };
  terminalControl.saveTerminalControlState({
    version: 1,
    controlEpoch: "control-epoch-one",
    targets: [{
      controlTargetId: "control-target-one",
      lifecycle: "ACTIVE",
      managedSession: {
        name: "managed-one",
        kind: "worktree",
        createdAt: "2026-07-22T00:00:00.000Z",
      },
      backend: { kind: "tmux", tmuxInstanceId: "tmux-instance-one" },
      outputGeneration: "output-generation-one",
      ownership: { state: "FREE", fence: "0" },
      revision: "1",
      completedOperations: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
  }, statePath);
  const authority = new terminalControl.TerminalControlAuthority({
    statePath,
    backend,
    relayV2ProcessTarget: PROCESS_TARGET,
  });
  const adapter = new adapterModule.RelayV2TerminalControlExactTargetAuthorityAdapter({
    authority,
    owner: { kind: "relay-v2", instanceId: "relay-v2-owner-one" },
  });
  const input = {
    schemaVersion: 1,
    hostId: "host-one",
    scopeId: "scope-one",
    sessionId: "session-one",
    pane: 0,
    processTarget: { ...PROCESS_TARGET },
    backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
      processTarget: PROCESS_TARGET,
      incarnation: INCARNATION,
    }),
    managedTarget: {
      name: "managed-one",
      kind: "worktree",
      incarnation: INCARNATION,
    },
  };
  return {
    statePath,
    calls,
    authority,
    adapter,
    input,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("exact preparation is effect-closed and hands one admitted lease to execution", async () => {
  const f = fixture();
  try {
    const evidence = await f.adapter.resolveExactTarget(f.input);
    assert.equal(evidence.exactControlIdentity.controlTargetId, "control-target-one");
    assert.equal(evidence.exactControlIdentity.controlEpoch, "control-epoch-one");
    assert.match(evidence.exactControlIdentity.targetIncarnationProof, /^twct2\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(f.calls, {
      inspect: 1,
      resolve: 0,
      prepareOutput: 0,
      resetOutput: 0,
      write: 0,
    });
    const reserved = terminalControl.loadTerminalControlState(f.statePath).targets[0];
    assert.equal(reserved.ownership.state, "HELD");
    assert.equal(reserved.ownership.owner.kind, "relay-v2");

    f.adapter.fenceExactTargetForAdmission(f.input, evidence);
    f.adapter.fenceNewPreparations();
    await assert.rejects(
      f.adapter.resolveExactTarget(f.input),
      /authority is unavailable/,
    );
    const requests = [];
    const execution = new commandTargetModule.RelayV2CanonicalAgentMessageTerminalExecutionAdapter({
      async request(request) {
        requests.push(structuredClone(request));
        assert.notEqual(request.type, "lease.acquire");
        if (request.type === "input.agent-message") {
          return {
            operationId: request.operationId,
            accepted: true,
            deduplicated: false,
            controlEpoch: request.lease.controlEpoch,
            fence: request.lease.fence,
            outputGeneration: "output-generation-one",
            outputCursor: 0,
          };
        }
        return {
          controlTargetId: request.lease.controlTargetId,
          controlEpoch: request.lease.controlEpoch,
          state: "FREE",
          fence: (BigInt(request.lease.fence) + 1n).toString(10),
          outputGeneration: "output-generation-two",
          outputCursor: 0,
          revision: "3",
        };
      },
    }, f.adapter);
    const outcome = await execution.executeAgentMessage({
      targetBinding: {
        schemaVersion: 1,
        hostId: f.input.hostId,
        scopeId: f.input.scopeId,
        sessionId: f.input.sessionId,
        pane: f.input.pane,
        processTarget: { ...f.input.processTarget },
        backendInstanceKey: f.input.backendInstanceKey,
        managedTarget: { ...f.input.managedTarget },
        exactControlIdentity: structuredClone(evidence.exactControlIdentity),
      },
      owner: { kind: "relay-v2", instanceId: "relay-v2-owner-one" },
      operationId: "twmsg2.owner-primitive-one",
      pane: "0",
      message: "continue",
      submit: true,
    });
    assert.equal(outcome.state, "succeeded");
    assert.deepEqual(requests.map((request) => request.type), [
      "input.agent-message", "lease.release",
    ]);
    assert.throws(
      () => f.adapter.consumePreparedLease(f.input, evidence),
      /lease is unavailable/,
    );
  } finally {
    await f.adapter.close().catch(() => undefined);
    f.cleanup();
  }
});

test("admission fence preserves one admitted H3 claim through exact release", async () => {
  const f = fixture();
  try {
    const evidence = await f.adapter.resolveExactTarget(f.input);
    f.adapter.fenceExactTargetForAdmission(f.input, evidence);
    f.adapter.fenceNewPreparations();
    const requests = [];
    const requestPort = {
      async request(input) {
        requests.push(structuredClone(input));
        return f.authority.handle({
          ...input,
          protocolVersion: 1,
          requestId: `h3-direct-${requests.length}`,
        });
      },
    };
    const h3 = new h3TerminalControlModule.RelayV2TerminalControlAuthorityAdapter(
      requestPort,
      f.adapter,
    );
    const binding = {
      ...f.input,
      exactControlIdentity: structuredClone(evidence.exactControlIdentity),
    };
    const resolvedTarget = {
      hostId: f.input.hostId,
      scopeId: f.input.scopeId,
      sessionId: f.input.sessionId,
      pane: f.input.pane,
      canonicalTargetId: f.input.backendInstanceKey,
      controlTargetId: evidence.exactControlIdentity.controlTargetId,
    };
    const effectTarget = {
      schemaVersion: 1,
      resolvedTarget,
      binding,
      [Symbol.for("tmux-worktree.relay-v2.terminal-exact-effect-target")]: true,
    };
    const owner = {
      kind: "relay-v2",
      instanceId: "relay-v2:stream-generation-one",
    };
    const acquired = await h3.acquire({
      target: effectTarget,
      auth: { principalId: "principal-one", clientInstanceId: "client-one" },
      owner,
    });
    assert.equal(acquired.status, "accepted");
    assert.deepEqual(acquired.lease.owner, owner);
    assert.deepEqual(requests, []);

    await h3.release({
      target: effectTarget,
      auth: { principalId: "principal-one", clientInstanceId: "client-one" },
      owner,
      lease: acquired.lease,
    });
    assert.deepEqual(requests.map((request) => request.type), ["lease.release"]);
    assert.equal(
      terminalControl.loadTerminalControlState(f.statePath).targets[0].ownership.state,
      "FREE",
    );
  } finally {
    await f.adapter.close().catch(() => undefined);
    f.cleanup();
  }
});

test("mismatch, stale authority restart, and handoff fail closed", async () => {
  const mismatch = fixture();
  try {
    await assert.rejects(
      mismatch.adapter.resolveExactTarget({
        ...mismatch.input,
        managedTarget: { ...mismatch.input.managedTarget, incarnation: `twinc2.${"B".repeat(43)}` },
      }),
      /TARGET_GONE|changed|crossed backend authority/,
    );
  } finally {
    await mismatch.adapter.close().catch(() => undefined);
    mismatch.cleanup();
  }

  const restarted = fixture();
  try {
    const evidence = await restarted.adapter.resolveExactTarget(restarted.input);
    await restarted.authority.initializeContinuity();
    assert.throws(
      () => restarted.adapter.fenceExactTargetForAdmission(restarted.input, evidence),
      /not owned|stale|mismatched/,
    );
  } finally {
    await restarted.adapter.close().catch(() => undefined);
    restarted.cleanup();
  }

  const handedOff = fixture();
  try {
    const evidence = await handedOff.adapter.resolveExactTarget(handedOff.input);
    await handedOff.authority.handle({
      protocolVersion: 1,
      requestId: "handoff-one",
      type: "handoff.begin",
      controlTargetId: "control-target-one",
      nextOwner: { kind: "feishu", instanceId: "feishu-owner-one" },
    });
    assert.throws(
      () => handedOff.adapter.fenceExactTargetForAdmission(handedOff.input, evidence),
      /not owned|stale|mismatched/,
    );
  } finally {
    await handedOff.adapter.close().catch(() => undefined);
    handedOff.cleanup();
  }
});

test("rollback and close withdraw unconsumed reservations exactly once", async () => {
  const rolledBack = fixture();
  try {
    const evidence = await rolledBack.adapter.resolveExactTarget(rolledBack.input);
    rolledBack.adapter.fenceExactTargetForAdmission(rolledBack.input, evidence);
    assert.equal(await rolledBack.adapter.rollbackPreparedTarget(rolledBack.input, evidence), true);
    assert.equal(await rolledBack.adapter.rollbackPreparedTarget(rolledBack.input, evidence), false);
    assert.equal(
      terminalControl.loadTerminalControlState(rolledBack.statePath).targets[0].ownership.state,
      "FREE",
    );
  } finally {
    await rolledBack.adapter.close().catch(() => undefined);
    rolledBack.cleanup();
  }

  const closed = fixture();
  try {
    const evidence = await closed.adapter.resolveExactTarget(closed.input);
    await closed.adapter.close();
    assert.equal(
      terminalControl.loadTerminalControlState(closed.statePath).targets[0].ownership.state,
      "FREE",
    );
    assert.throws(
      () => closed.adapter.fenceExactTargetForAdmission(closed.input, evidence),
      /stale|mismatched/,
    );
    await assert.rejects(
      closed.adapter.resolveExactTarget(closed.input),
      /unavailable/,
    );
  } finally {
    await closed.adapter.close().catch(() => undefined);
    closed.cleanup();
  }
});
