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

test("resize parser preserves exact Relay v2 dimensions and rejects invalid input before dispatch", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "principal:client:resize"));
    const accepted = [
      [1, 1],
      [20, 5],
      [300, 200],
      [1000, 500],
    ];
    for (const [index, [cols, rows]] of accepted.entries()) {
      const operationId = `resize-accepted-${index}`;
      const parsed = terminalControl.parseTerminalControlRequest(
        resizeRequest(relay.lease, operationId, cols, rows),
      );
      await authority.handle(parsed);
    }
    assert.deepEqual(
      backend.writes,
      accepted.map(([cols, rows]) => ({ kind: "resize", value: { pane: "0", cols, rows } })),
    );

    const valid = resizeRequest(relay.lease, "resize-rejected", 80, 24);
    const rejected = [
      { ...valid, cols: 0 },
      { ...valid, cols: 1001 },
      { ...valid, rows: 0 },
      { ...valid, rows: 501 },
      { ...valid, cols: 1.5 },
      { ...valid, rows: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, pane: "01" },
      { ...valid, operationId: "" },
      { ...valid, lease: { ...valid.lease, extra: true } },
      { ...valid, extra: true },
    ];
    for (const request of rejected) {
      assert.throws(
        () => terminalControl.parseTerminalControlRequest(request),
        (error) => error.code === "INVALID_REQUEST",
      );
    }
    assert.equal(backend.writes.length, accepted.length);
  } finally {
    temp.cleanup();
  }
});

test("Dashboard and Relay serialize interactive input ownership", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "dashboard-window:pty-1"),
    );
    await assert.rejects(
      acquired(
        authority,
        target.controlTargetId,
        owner("relay-v2", "connector:android-client:target"),
      ),
      (error) => error.code === "RESOURCE_EXHAUSTED" && error.retryable === true,
    );
    await authority.handle(rawRequest(dashboard.lease, "dashboard-input-1", "from-dashboard"));

    await authority.handle({
      protocolVersion: 1,
      requestId: "dashboard-release-before-relay",
      type: "lease.release",
      lease: dashboard.lease,
    });
    const relay = await acquired(
      authority,
      target.controlTargetId,
      owner("relay-v2", "connector:android-client:target"),
    );
    await authority.handle(rawRequest(relay.lease, "relay-input-2", "apk-still-writable"));

    assert.deepEqual(backend.writes, [
      { kind: "raw", value: { pane: "0", data: "from-dashboard" } },
      { kind: "raw", value: { pane: "0", data: "apk-still-writable" } },
    ]);
  } finally {
    temp.cleanup();
  }
});

test("semantic tmux scroll is lease-fenced, atomic, and deduplicated", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "window:pty-scroll"),
    );
    const request = scrollRequest(dashboard.lease, "dashboard:scroll:1", "up", 3);
    const first = await authority.handle(request);
    const duplicate = await authority.handle(request);
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.deepEqual(backend.writes, [{
      kind: "scroll",
      value: { pane: "0", direction: "up", lines: 3 },
    }]);
    await assert.rejects(
      authority.handle(scrollRequest(dashboard.lease, "dashboard:scroll:1", "down", 3)),
      (error) => error.code === "INVALID_REQUEST",
    );
    await authority.handle({
      protocolVersion: 1,
      requestId: "dashboard-scroll-release",
      type: "lease.release",
      lease: dashboard.lease,
    });
    const feishu = await acquired(
      authority,
      target.controlTargetId,
      owner("feishu", "binding:scroll-owner"),
    );
    await assert.rejects(
      authority.handle(scrollRequest(dashboard.lease, "dashboard:scroll:old-fence", "up", 1)),
      (error) => error.code === "PERMISSION_DENIED",
    );
    assert.equal(feishu.ownership.ownerKind, "feishu");
    assert.equal(backend.writes.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("uncertain backend writes persist RECOVERY_REQUIRED and never auto-retry", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "principal:client:lane"));
    backend.failWrite = true;
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "input-in-doubt", "x")),
      (error) => error.code === "OPERATION_IN_DOUBT",
    );
    const stored = terminalControl.loadTerminalControlState(temp.path);
    assert.equal(stored.targets[0].lifecycle, "RECOVERY_REQUIRED");
    assert.equal(stored.targets[0].inFlight, undefined);
    assert.equal(stored.targets[0].completedOperations.at(-1).operationId, "input-in-doubt");
    assert.equal(stored.targets[0].completedOperations.at(-1).disposition, "in-doubt");
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "must-not-retry", "y")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(backend.writes.length, 0);

    const recovered = await authority.handle({
      protocolVersion: 1,
      requestId: "explicit-recovery",
      type: "handoff.force",
      controlTargetId: target.controlTargetId,
      expectedControlEpoch: stored.controlEpoch,
      nextOwner: owner("local-cli", "local-cli:recovery:1"),
      proof: {
        kind: "operator-acknowledged-in-doubt",
        recordId: "recovery-1",
        recordedAt: "2026-07-13T00:00:30.000Z",
      },
      acknowledgeUncertainOperation: true,
    });
    assert.equal(recovered.ownership.state, "HELD");
    assert.equal(recovered.ownership.ownerKind, "local-cli");
    assert.notEqual(recovered.lease.fence, relay.lease.fence);
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "old-owner-after-recovery", "z")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    backend.failWrite = false;
    await authority.handle(rawRequest(recovered.lease, "new-owner-after-recovery", "ok"));
    assert.deepEqual(backend.writes.at(-1), { kind: "raw", value: { pane: "0", data: "ok" } });
  } finally {
    temp.cleanup();
  }
});

test("invalid logical panes are rejected before an in-flight operation is persisted", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "client:logical-pane"));
    const invalidRequests = [
      {
        ...rawRequest(relay.lease, "invalid-logical-raw", "must-not-write"),
        pane: "1",
      },
      {
        protocolVersion: 1,
        requestId: "invalid-logical-agent",
        type: "input.agent-message",
        lease: relay.lease,
        operationId: "invalid-logical-agent",
        pane: "1",
        message: "must-not-write",
        submit: true,
      },
      {
        protocolVersion: 1,
        requestId: "invalid-logical-resize",
        type: "input.resize",
        lease: relay.lease,
        operationId: "invalid-logical-resize",
        pane: "1",
        cols: 120,
        rows: 40,
      },
    ];

    for (const request of invalidRequests) {
      await assert.rejects(
        authority.handle(request),
        (error) => error.code === "INVALID_REQUEST",
      );
      const stored = terminalControl.loadTerminalControlState(temp.path).targets[0];
      assert.equal(stored.lifecycle, "ACTIVE");
      assert.equal(stored.ownership.state, "HELD");
      assert.equal(stored.inFlight, undefined);
      assert.equal(stored.recovery, undefined);
      assert.equal(
        stored.completedOperations.some(({ operationId }) => operationId === request.operationId),
        false,
      );
    }
    assert.deepEqual(backend.writes, []);

    const accepted = await authority.handle(rawRequest(relay.lease, "valid-after-invalid-pane", "ok"));
    assert.equal(accepted.accepted, true);
    assert.deepEqual(backend.writes, [{ kind: "raw", value: { pane: "0", data: "ok" } }]);
  } finally {
    temp.cleanup();
  }
});

test("backend INVALID_REQUEST after an operation starts remains operation-in-doubt", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "backend-invalid"));
    backend.failWrite = new terminalControl.TerminalControlProtocolError(
      "INVALID_REQUEST",
      "backend rejected after entering its write boundary",
    );

    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "backend-invalid-after-start", "possibly-written")),
      (error) => error.code === "OPERATION_IN_DOUBT",
    );
    const stored = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(stored.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(stored.inFlight, undefined);
    assert.equal(stored.recovery.reason, "OPERATION_IN_DOUBT");
    assert.equal(stored.completedOperations.at(-1).operationId, "backend-invalid-after-start");
    assert.equal(stored.completedOperations.at(-1).disposition, "in-doubt");
    assert.deepEqual(backend.writes, []);
  } finally {
    temp.cleanup();
  }
});
