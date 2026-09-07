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

test("agent input atomically returns a bounded generation-fenced output cursor", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    backend.appendOutput(target.controlTargetId, "prompt\n");
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-output:daemon-1"));
    const sent = await authority.handle({
      protocolVersion: 1,
      requestId: "feishu-agent-input",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "feishu-agent-input",
      pane: "0",
      message: "do the work",
      submit: true,
    });
    assert.equal(sent.outputCursor, Buffer.byteLength("prompt\n"));
    backend.appendOutput(target.controlTargetId, "[[notify-group]]done[[/notify-group]]\n");
    const tail = await authority.handle({
      protocolVersion: 1,
      requestId: "tail-after-input",
      type: "output.tail",
      controlTargetId: target.controlTargetId,
      controlEpoch: sent.controlEpoch,
      outputGeneration: sent.outputGeneration,
      cursor: sent.outputCursor,
      maxBytes: 256,
    });
    assert.equal(
      Buffer.from(tail.dataBase64, "base64").toString("utf8"),
      "[[notify-group]]done[[/notify-group]]\n",
    );
    const draining = await authority.handle({
      protocolVersion: 1,
      requestId: "output-handoff",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "output-pty"),
    });
    await authority.handle({
      protocolVersion: 1,
      requestId: "output-handoff-commit",
      type: "handoff.commit",
      handoffId: draining.ownership.handoffId,
      currentLease: feishu.lease,
      drain: {
        disposition: "drained",
        recordId: "reply-confirmed-1",
        recordedAt: new Date().toISOString(),
      },
    });
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "late-output-tail",
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: sent.controlEpoch,
        outputGeneration: sent.outputGeneration,
        cursor: tail.nextCursor,
      }),
      (error) => error.code === "STALE_OUTPUT_CURSOR",
    );
  } finally {
    temp.cleanup();
  }
});

test("rendered snapshots require the exact Feishu lease and remain readable while draining", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(
      authority,
      target.controlTargetId,
      owner("feishu", "binding-rendered:daemon-1"),
    );
    backend.renderedOutput = "private prefix\nrendered public output\n";
    const request = (requestId, overrides = {}) => authority.handle({
      protocolVersion: 1,
      requestId,
      type: "output.rendered-snapshot",
      lease: feishu.lease,
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
      maxBytes: 23,
      ...overrides,
    });

    const held = await request("rendered-held");
    assert.deepEqual(held, {
      controlTargetId: target.controlTargetId,
      controlEpoch: feishu.lease.controlEpoch,
      leaseId: feishu.lease.leaseId,
      fence: feishu.lease.fence,
      ownerKind: "feishu",
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
      dataBase64: Buffer.from("rendered public output\n", "utf8").toString("base64"),
      truncated: true,
    });

    const handoff = await authority.handle({
      protocolVersion: 1,
      requestId: "rendered-handoff",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "rendered-handoff"),
    });
    assert.equal(handoff.ownership.state, "DRAINING");
    const draining = await request("rendered-draining");
    assert.equal(Buffer.from(draining.dataBase64, "base64").toString("utf8"), "rendered public output\n");

    const callsBeforeRejections = backend.renderedSnapshotCalls.length;
    await assert.rejects(
      request("rendered-stale-generation", { outputGeneration: "stale-generation" }),
      (error) => error.code === "STALE_OUTPUT_CURSOR",
    );
    await assert.rejects(
      request("rendered-stale-fence", {
        lease: { ...feishu.lease, fence: (BigInt(feishu.lease.fence) + 1n).toString() },
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      request("rendered-non-feishu", {
        lease: {
          ...feishu.lease,
          owner: owner("dashboard", "forged-rendered-reader"),
        },
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    assert.equal(backend.renderedSnapshotCalls.length, callsBeforeRejections);

    backend.failRenderedSnapshot = new terminalControl.TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      "injected bounded snapshot overflow",
    );
    await assert.rejects(
      request("rendered-bounded-overflow"),
      (error) => error.code === "RESOURCE_EXHAUSTED",
    );
    const afterOverflow = await authority.handle({
      protocolVersion: 1,
      requestId: "rendered-status-after-overflow",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(afterOverflow.state, "DRAINING");
    assert.equal(afterOverflow.fence, feishu.lease.fence);
  } finally {
    temp.cleanup();
  }
});

test("clean ownership release rotates output generation and fences every old marker cursor", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-release:daemon-1"));
    const sent = await authority.handle({
      protocolVersion: 1,
      requestId: "release-correlation",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "release-correlation",
      pane: "0",
      message: "work",
      submit: true,
    });
    const released = await authority.handle({
      protocolVersion: 1,
      requestId: "release-owner",
      type: "lease.release",
      lease: feishu.lease,
    });
    assert.equal(released.state, "FREE");
    assert.notEqual(released.outputGeneration, sent.outputGeneration);
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "tail-after-release",
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: sent.controlEpoch,
        outputGeneration: sent.outputGeneration,
        cursor: sent.outputCursor,
      }),
      (error) => error.code === "STALE_OUTPUT_CURSOR",
    );
  } finally {
    temp.cleanup();
  }
});

test("force recovery requires a durable recovery target and a controlled local owner", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "healthy-target-force",
        type: "handoff.force",
        controlTargetId: target.controlTargetId,
        expectedControlEpoch: target.controlEpoch,
        nextOwner: owner("dashboard", "dashboard:healthy-force"),
        proof: {
          kind: "operator-acknowledged-in-doubt",
          recordId: "healthy-target-force-proof",
          recordedAt: new Date().toISOString(),
        },
        acknowledgeUncertainOperation: true,
      }),
      (error) => error.code === "PERMISSION_DENIED"
        && /durably fenced recovery target/.test(error.message),
    );
    await acquired(authority, target.controlTargetId, owner("feishu", "binding-force:daemon-old"));
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "feishu-self-force",
        type: "handoff.force",
        controlTargetId: target.controlTargetId,
        expectedControlEpoch: target.controlEpoch,
        nextOwner: owner("feishu", "binding-force:daemon-new"),
        proof: {
          kind: "owner-unreachable",
          recordId: "feishu-self-force-proof",
          recordedAt: new Date().toISOString(),
        },
        acknowledgeUncertainOperation: true,
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
  } finally {
    temp.cleanup();
  }
});

test("an uncertain drain persists recovery and never transfers through FREE", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-drain:daemon-1"));
    const draining = await authority.handle({
      protocolVersion: 1,
      requestId: "uncertain-begin",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "uncertain-pty"),
    });
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "uncertain-commit",
        type: "handoff.commit",
        handoffId: draining.ownership.handoffId,
        currentLease: feishu.lease,
        drain: {
          disposition: "uncertain",
          recordId: "reply-ack-lost-1",
          recordedAt: new Date().toISOString(),
        },
      }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "uncertain-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    await assert.rejects(
      acquired(authority, target.controlTargetId, owner("dashboard", "uncertain-pty")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
  } finally {
    temp.cleanup();
  }
});
