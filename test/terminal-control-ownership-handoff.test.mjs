import test from "node:test";
import {
  assert,
  spawn,
  spawnSync,
  createHash,
  randomUUID,
  appendFileSync,
  mkdtempSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  tmpdir,
  join,
  fileURLToPath,
  deferred,
  terminalControl,
  managedSessions,
  terminalControlCli,
  exactCompound,
  backendIdentity,
  CanonicalTerminalControlSocketClient,
  parseCanonicalAgentResultResult,
  parseCanonicalAgentStatusResult,
  parseCanonicalRenderedSnapshotResult,
  contractRoot,
  isolatedTmuxWrapper,
  tempState,
  stopAutoStartedTerminalControl,
  sha256Hex,
  regularFileBytes,
  shellSingleQuote,
  installFullLegacyCapture,
  persistedLegacyRecovery,
  isolatedManagedTmux,
  FakeBackend,
  owner,
  resolved,
  acquired,
  rawRequest,
  scrollRequest,
  resizeRequest,
} from "./support/terminalControlHarness.mjs";

test("ownership handoff has one durable commit point and fences every old input", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
  });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-1:daemon-1"));
    const dashboardOwner = owner("dashboard", "instance-1:pty-1");

    await assert.rejects(
      acquired(authority, target.controlTargetId, dashboardOwner),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await authority.handle(rawRequest(feishu.lease, "feishu-input-1", "first"));
    assert.deepEqual(backend.writes, [{ kind: "raw", value: { pane: "0", data: "first" } }]);

    const draining = await authority.handle({
      protocolVersion: 1,
      requestId: "handoff-begin",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: dashboardOwner,
    });
    assert.equal(draining.ownership.state, "DRAINING");
    await assert.rejects(
      authority.handle(rawRequest(feishu.lease, "late-feishu-input", "late")),
      (error) => error.code === "HANDOFF_PENDING",
    );

    const committed = await authority.handle({
      protocolVersion: 1,
      requestId: "handoff-commit",
      type: "handoff.commit",
      handoffId: draining.ownership.handoffId,
      currentLease: feishu.lease,
      drain: {
        disposition: "drained",
        recordId: "feishu-turn-settled-1",
        recordedAt: "2026-07-13T00:00:30.000Z",
      },
    });
    assert.equal(BigInt(committed.lease.fence), BigInt(feishu.lease.fence) + 1n);
    assert.deepEqual(committed.lease.owner, dashboardOwner);
    await assert.rejects(
      authority.handle(rawRequest(feishu.lease, "post-commit-feishu-input", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await authority.handle(rawRequest(committed.lease, "dashboard-input-1", "local"));
    assert.equal(backend.writes.at(-1).value.data, "local");
  } finally {
    temp.cleanup();
  }
});

test("only the exact pending next owner can withdraw an uncommitted handoff", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-1:daemon-1"));
    const nextOwner = owner("local-cli", "process-1:attach-1");
    const draining = await authority.handle({
      protocolVersion: 1,
      requestId: "begin-withdraw",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner,
    });
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "wrong-withdraw",
        type: "handoff.withdraw",
        controlTargetId: target.controlTargetId,
        handoffId: draining.ownership.handoffId,
        nextOwner: owner("local-cli", "other-process"),
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const restored = await authority.handle({
      protocolVersion: 1,
      requestId: "exact-withdraw",
      type: "handoff.withdraw",
      controlTargetId: target.controlTargetId,
      handoffId: draining.ownership.handoffId,
      nextOwner,
    });
    assert.equal(restored.state, "HELD");
    await authority.handle(rawRequest(feishu.lease, "after-withdraw", "still-feishu"));
    assert.equal(backend.writes.at(-1).value.data, "still-feishu");
  } finally {
    temp.cleanup();
  }
});

test("managed kill is fenced in the authority critical section and deterministic failure keeps the lease", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(authority, target.controlTargetId, owner("dashboard", "instance-1:pty-1"));
    backend.failKill = true;
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "failed-kill",
        type: "lifecycle.kill",
        lease: dashboard.lease,
        operationId: "failed-kill",
      }),
      /injected managed kill failure/,
    );
    await authority.handle(rawRequest(dashboard.lease, "after-failed-kill", "still-live"));
    backend.failKill = false;
    await authority.handle({
      protocolVersion: 1,
      requestId: "successful-kill",
      type: "lifecycle.kill",
      lease: dashboard.lease,
      operationId: "successful-kill",
    });
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "status-after-kill",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "TARGET_GONE");
    await assert.rejects(
      authority.handle(rawRequest(dashboard.lease, "after-successful-kill", "stale")),
      (error) => error.code === "TARGET_GONE",
    );
  } finally {
    temp.cleanup();
  }
});

test("handoff waits behind an accepted backend write and cannot split agent body from submit", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  backend.gate = deferred();
  backend.started = deferred();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-2:daemon-1"));
    const write = authority.handle({
      protocolVersion: 1,
      requestId: "agent-write",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "agent-write",
      pane: "0",
      message: "do the work",
      submit: true,
    });
    await backend.started.promise;
    let handoffResolved = false;
    const handoff = authority.handle({
      protocolVersion: 1,
      requestId: "handoff-race",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "instance-2:pty-1"),
    }).then((value) => {
      handoffResolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(handoffResolved, false, "handoff must wait for the backend critical section");
    backend.gate.resolve();
    await write;
    const draining = await handoff;
    assert.equal(draining.ownership.state, "DRAINING");
    assert.deepEqual(backend.writes, [{
      kind: "agent-message",
      value: { pane: "0", message: "do the work", submit: true },
    }]);
  } finally {
    temp.cleanup();
  }
});

test("proved-unapplied agent runtime failure clears in-flight state and permits exact retry", async () => {
  const temp = tempState();
  class RuntimeBackend extends FakeBackend {
    attempts = 0;

    async sendAgentMessageFenced(_session, _instance, _generation, pane, message, submit, runtime) {
      this.attempts += 1;
      if (this.attempts === 1) {
        throw new terminalControl.TerminalControlAgentMessageNotAppliedError(
          "INVALID_REQUEST",
          "runtime settings unsupported",
        );
      }
      await this.beforeWrite("agent-message", { pane, message, submit, runtime });
    }
  }
  const backend = new RuntimeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "runtime-settings"),
    );
    const request = {
      protocolVersion: 1,
      requestId: "runtime-failed",
      type: "input.agent-message",
      lease: dashboard.lease,
      operationId: "runtime-failed",
      pane: "0",
      message: "do the work",
      submit: true,
      runtime: { model: "gpt-5.6-sol", reasoningEffort: "high", mode: "default" },
    };
    await assert.rejects(authority.handle(request), (error) => (
      error.code === "INVALID_REQUEST" && error.message === "runtime settings unsupported"
    ));
    assert.equal((await authority.handle({
      protocolVersion: 1,
      requestId: "runtime-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    })).state, "HELD");
    await authority.handle({ ...request, requestId: "runtime-retry" });
    assert.equal(backend.writes.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("operation IDs deduplicate exact retries and reject payload reuse", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "connector:client:target"));
    const first = await authority.handle(rawRequest(relay.lease, "stream-1:input-1", "abc"));
    const duplicate = await authority.handle(rawRequest(relay.lease, "stream-1:input-1", "abc"));
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(backend.writes.length, 1);
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "stream-1:input-1", "different")),
      (error) => error.code === "INVALID_REQUEST",
    );
  } finally {
    temp.cleanup();
  }
});
