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

test("missing raw output capture is rebuilt for an idle Dashboard owner but never for Feishu", async () => {
  const dashboardTemp = tempState();
  const dashboardBackend = new FakeBackend();
  const dashboardAuthority = new terminalControl.TerminalControlAuthority({
    statePath: dashboardTemp.path,
    backend: dashboardBackend,
  });
  try {
    const target = await resolved(dashboardAuthority, "dashboard-capture-repair");
    const held = await acquired(
      dashboardAuthority,
      target.controlTargetId,
      owner("dashboard", "active-pty"),
    );
    dashboardBackend.rawInputPosition = async () => {
      throw new terminalControl.TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture file is missing",
      );
    };
    dashboardBackend.writeRawFenced = async (_session, _instance, _generation, pane, data) => {
      await dashboardBackend.beforeWrite("raw", { pane, data: data.toString("utf8") });
    };
    const sent = await dashboardAuthority.handle(rawRequest(held.lease, "dashboard-repaired-input", "ok"));
    assert.equal(sent.accepted, true);
    assert.equal(dashboardBackend.resetCalls, 1);
    assert.deepEqual(dashboardBackend.writes, [{ kind: "raw", value: { pane: "0", data: "ok" } }]);
    const status = await dashboardAuthority.handle({
      protocolVersion: 1,
      requestId: "dashboard-after-repair",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "HELD");
    assert.equal(status.ownerKind, "dashboard");
  } finally {
    dashboardTemp.cleanup();
  }

  const feishuTemp = tempState();
  const feishuBackend = new FakeBackend();
  const feishuAuthority = new terminalControl.TerminalControlAuthority({
    statePath: feishuTemp.path,
    backend: feishuBackend,
  });
  try {
    const target = await resolved(feishuAuthority, "feishu-capture-strict");
    const held = await acquired(feishuAuthority, target.controlTargetId, owner("feishu", "binding:daemon"));
    feishuBackend.rawInputPosition = async () => {
      throw new terminalControl.TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture file is missing",
      );
    };
    feishuBackend.writeRawFenced = async () => {
      throw new Error("Feishu write must not run after lost output continuity");
    };
    await assert.rejects(
      feishuAuthority.handle(rawRequest(held.lease, "feishu-missing-capture", "blocked")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(feishuBackend.resetCalls, 0);
    const status = await feishuAuthority.handle({
      protocolVersion: 1,
      requestId: "feishu-after-capture-loss",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "feishu");
  } finally {
    feishuTemp.cleanup();
  }
});

test("same-name backend recreation gets a new target and tombstones the old target", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const first = await resolved(authority, "same-name");
    const lease = await acquired(authority, first.controlTargetId, owner("feishu", "binding-3:daemon-1"));
    backend.createdAt = "2026-07-13T00:01:00.000Z";
    backend.instance = "tmux-instance-2";
    const second = await resolved(authority, "same-name");
    assert.notEqual(second.controlTargetId, first.controlTargetId);
    const oldStatus = await authority.handle({
      protocolVersion: 1,
      requestId: "old-status",
      type: "ownership.status",
      controlTargetId: first.controlTargetId,
    });
    assert.equal(oldStatus.state, "TARGET_GONE");
    await assert.rejects(
      authority.handle(rawRequest(lease.lease, "old-target-input", "stale")),
      (error) => error.code === "TARGET_GONE",
    );
  } finally {
    temp.cleanup();
  }
});

test("lease renewal preserves liveness while expiry enters recovery instead of FREE", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  let clock = Date.parse("2026-07-13T00:00:00.000Z");
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    now: () => new Date(clock),
  });
  try {
    const target = await resolved(authority);
    const held = await authority.handle({
      protocolVersion: 1,
      requestId: "short-acquire",
      type: "lease.acquire",
      controlTargetId: target.controlTargetId,
      owner: owner("feishu", "binding-liveness:daemon-1"),
      ttlMs: terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS,
    });
    clock += terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS - 1;
    const renewed = await authority.handle({
      protocolVersion: 1,
      requestId: "renew-before-expiry",
      type: "lease.renew",
      lease: held.lease,
      ttlMs: terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS,
    });
    assert.notEqual(renewed.lease.expiresAt, held.lease.expiresAt);
    await authority.handle(rawRequest(held.lease, "old-expiry-view-after-renew", "still-live"));
    clock += terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS + 1;
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "expired-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "feishu");
    await assert.rejects(
      authority.handle(rawRequest(renewed.lease, "after-expiry", "must-not-write")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(backend.writes.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("an idle expired non-Feishu lease is fenced and safely returns to FREE", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  let clock = Date.parse("2026-07-13T00:00:00.000Z");
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    now: () => new Date(clock),
  });
  try {
    const target = await resolved(authority);
    const dashboard = await authority.handle({
      protocolVersion: 1,
      requestId: "short-dashboard-acquire",
      type: "lease.acquire",
      controlTargetId: target.controlTargetId,
      owner: owner("dashboard", "mounted-hidden-pty"),
      ttlMs: terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS,
    });
    clock += terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS + 1;
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "expired-dashboard-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "FREE");
    assert.equal(status.ownerKind, undefined);
    assert.equal(backend.resetCalls, 1, "safe abandonment must rebuild output capture");
    await assert.rejects(
      authority.handle(rawRequest(dashboard.lease, "expired-dashboard-input", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "phone-after-expiry"));
    assert.equal(relay.ownership.state, "HELD");
    assert.equal(relay.ownership.ownerKind, "relay-v2");
  } finally {
    temp.cleanup();
  }
});

test("persisted idle non-Feishu recovery self-heals but uncertain operations and handoffs do not", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(authority, target.controlTargetId, owner("dashboard", "old-dashboard"));
    const state = terminalControl.loadTerminalControlState(temp.path);
    const record = state.targets[0];
    record.lifecycle = "RECOVERY_REQUIRED";
    record.ownership = {
      state: "FREE",
      fence: terminalControl.nextDecimal(record.ownership.fence),
    };
    record.recovery = {
      reason: "OUTPUT_CONTINUITY_UNCERTAIN",
      since: new Date().toISOString(),
      previousControlEpoch: state.controlEpoch,
      previousOwnerKind: "dashboard",
    };
    record.revision = terminalControl.nextDecimal(record.revision);
    record.updatedAt = new Date().toISOString();
    terminalControl.saveTerminalControlState(state, temp.path);

    const recovered = await authority.handle({
      protocolVersion: 1,
      requestId: "safe-recovery-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(recovered.state, "FREE");
    assert.equal(backend.resetCalls, 1);
    await assert.rejects(
      authority.handle(rawRequest(dashboard.lease, "old-recovery-lease", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );

    const current = await acquired(authority, target.controlTargetId, owner("feishu", "handoff-owner"));
    await authority.handle({
      protocolVersion: 1,
      requestId: "feishu-handoff",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "next-owner"),
      currentLease: current.lease,
    });
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    await restarted.initializeContinuity();
    const persisted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(persisted.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(persisted.recovery.reason, "DRAIN_UNCERTAIN");
    const blocked = await restarted.handle({
      protocolVersion: 1,
      requestId: "handoff-restart-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(blocked.state, "RECOVERY_REQUIRED");
    await assert.rejects(
      acquired(restarted, target.controlTargetId, owner("dashboard", "must-not-auto-recover")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
  } finally {
    temp.cleanup();
  }
});

test("ambiguous backend identity enters recovery instead of tombstoning a possibly live target", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const held = await acquired(authority, target.controlTargetId, owner("dashboard", "identity-uncertain"));
    backend.failAssertUncertain = true;
    await assert.rejects(
      authority.handle(rawRequest(held.lease, "must-not-write-on-uncertain-identity", "blocked")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const stored = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(stored.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(stored.recovery.reason, "BACKEND_IDENTITY_UNCERTAIN");
    assert.equal(backend.writes.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("controller restart rotates epoch and fences held ownership until explicit recovery", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const firstAuthority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(firstAuthority);
    const feishu = await acquired(firstAuthority, target.controlTargetId, owner("feishu", "binding-restart:daemon-1"));
    const oldEpoch = feishu.lease.controlEpoch;
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    const newEpoch = await restarted.initializeContinuity();
    assert.notEqual(newEpoch, oldEpoch);
    const status = await restarted.handle({
      protocolVersion: 1,
      requestId: "status-after-restart",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "feishu");
    await assert.rejects(
      restarted.handle(rawRequest(feishu.lease, "old-epoch-input", "stale")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const recovered = await restarted.handle({
      protocolVersion: 1,
      requestId: "recover-after-restart",
      type: "handoff.force",
      controlTargetId: target.controlTargetId,
      expectedControlEpoch: newEpoch,
      nextOwner: owner("local-cli", "restart-recovery"),
      proof: {
        kind: "operator-acknowledged-in-doubt",
        recordId: "restart-recovery-1",
        recordedAt: new Date().toISOString(),
      },
      acknowledgeUncertainOperation: true,
    });
    assert.equal(recovered.ownership.state, "HELD");
    assert.equal(recovered.lease.controlEpoch, newEpoch);
    assert.notEqual(recovered.lease.fence, feishu.lease.fence);
  } finally {
    temp.cleanup();
  }
});

test("controller restart safely abandons an idle Dashboard lease and rebuilds capture", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const first = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(first);
    const dashboard = await acquired(first, target.controlTargetId, owner("dashboard", "stale-app-pty"));
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    const nextEpoch = await restarted.initializeContinuity();
    const interrupted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(interrupted.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(interrupted.recovery.reason, "CONTROLLER_RESTARTED");
    assert.equal(interrupted.recovery.previousOwnerKind, "dashboard");

    const status = await restarted.handle({
      protocolVersion: 1,
      requestId: "dashboard-restart-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "FREE");
    assert.equal(status.controlEpoch, nextEpoch);
    assert.equal(backend.resetCalls, 1);
    await assert.rejects(
      restarted.handle(rawRequest(dashboard.lease, "old-dashboard-after-restart", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const next = await acquired(restarted, target.controlTargetId, owner("dashboard", "new-app-pty"));
    assert.equal(next.ownership.state, "HELD");
    assert.equal(next.lease.controlEpoch, nextEpoch);
  } finally {
    temp.cleanup();
  }
});

test("controller restart preserves an existing in-doubt operation instead of making it auto-recoverable", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "in-doubt-owner"));
    backend.failWrite = true;
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "persist-across-restart", "x")),
      (error) => error.code === "OPERATION_IN_DOUBT",
    );
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    await restarted.initializeContinuity();
    const stored = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(stored.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(stored.recovery.reason, "OPERATION_IN_DOUBT");
    assert.equal(stored.recovery.operationId, "persist-across-restart");
    const status = await restarted.handle({
      protocolVersion: 1,
      requestId: "in-doubt-after-restart-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "relay-v2");
    await assert.rejects(
      acquired(restarted, target.controlTargetId, owner("dashboard", "must-not-auto-recover")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
  } finally {
    temp.cleanup();
  }
});
