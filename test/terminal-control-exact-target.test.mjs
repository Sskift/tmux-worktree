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

test("exact target ownership contention is retryable pressure, not missing capability", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"A".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-owner-pressure",
    scopeId: "scope-owner-pressure",
    sessionId: "session-owner-pressure",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-owner-pressure",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:owner-pressure" },
  };
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "active-terminal"),
    );

    await assert.rejects(
      authority.prepareRelayV2ExactTarget(exactInput),
      (error) => error.code === "RESOURCE_EXHAUSTED"
        && error.retryable === true
        && error.message === "exact terminal-control target already has an input owner",
    );
    const held = await authority.handle({
      protocolVersion: 1,
      requestId: "owner-pressure-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(held.state, "HELD");
    assert.equal(held.ownerKind, "dashboard");
    await authority.handle({
      protocolVersion: 1,
      requestId: "owner-pressure-release",
      type: "lease.release",
      lease: dashboard.lease,
    });
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact target reservation safely recovers ownerless output uncertainty", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"R".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-ownerless-recovery",
    scopeId: "scope-ownerless-recovery",
    sessionId: "session-ownerless-recovery",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-ownerless-recovery",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:ownerless-recovery" },
  };
  try {
    const target = await resolved(authority);
    const state = terminalControl.loadTerminalControlState(temp.path);
    const persisted = state.targets.find(
      (candidate) => candidate.controlTargetId === target.controlTargetId,
    );
    persisted.lifecycle = "RECOVERY_REQUIRED";
    persisted.ownership = { state: "FREE", fence: "1" };
    persisted.recovery = {
      reason: "OUTPUT_CONTINUITY_UNCERTAIN",
      since: "2026-07-13T00:10:00.000Z",
      previousControlEpoch: state.controlEpoch,
    };
    persisted.revision = "2";
    persisted.updatedAt = "2026-07-13T00:10:00.000Z";
    terminalControl.saveTerminalControlState(state, temp.path);

    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    const recovered = terminalControl.loadTerminalControlState(temp.path).targets.find(
      (candidate) => candidate.controlTargetId === target.controlTargetId,
    );
    assert.equal(recovered.lifecycle, "ACTIVE");
    assert.equal(recovered.recovery, undefined);
    assert.equal(recovered.ownership.state, "HELD");
    assert.equal(recovered.ownership.owner.kind, "relay-v2");
    assert.equal(recovered.outputGeneration, backend.outputGeneration);
    assert.equal(backend.resetCalls, 1);

    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const lease = authority.consumeRelayV2ExactTarget(preparation.claim, exactInput);
    await authority.handle({
      protocolVersion: 1,
      requestId: "ownerless-recovery-release",
      type: "lease.release",
      lease,
    });
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact Relay reservation recovers around but never replays an in-doubt Agent message", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"I".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-agent-in-doubt",
    scopeId: "scope-agent-in-doubt",
    sessionId: "session-agent-in-doubt",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-agent-in-doubt",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:new-host-generation" },
  };
  const oldOperationId = "agent-chat-old-in-doubt";
  const oldMessage = "possibly submitted old message";
  try {
    const target = await resolved(authority);
    const oldOwner = await acquired(
      authority,
      target.controlTargetId,
      owner("relay-v2", "old-host-generation"),
    );
    backend.failWrite = true;
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: oldOperationId,
        type: "input.agent-message",
        lease: oldOwner.lease,
        operationId: oldOperationId,
        pane: "0",
        message: oldMessage,
        submit: true,
      }),
      (error) => error.code === "OPERATION_IN_DOUBT",
    );
    backend.failWrite = false;

    const uncertain = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(uncertain.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(uncertain.recovery.reason, "OPERATION_IN_DOUBT");
    assert.equal(uncertain.recovery.operationId, oldOperationId);
    assert.equal(uncertain.recovery.previousOwnerKind, "relay-v2");
    assert.equal(uncertain.completedOperations.at(-1).disposition, "in-doubt");
    assert.deepEqual(backend.writes, []);

    // The ordinary v1 lane remains explicitly gated for every owner kind.
    for (const blockedOwner of [
      owner("relay-v2", "ordinary-v1-relay"),
      owner("feishu", "ordinary-v1-feishu"),
    ]) {
      await assert.rejects(
        acquired(authority, target.controlTargetId, blockedOwner),
        (error) => error.code === "RECOVERY_REQUIRED",
      );
    }
    assert.equal(backend.resetCalls, 0);

    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const recoveredLease = authority.consumeRelayV2ExactTarget(
      preparation.claim,
      exactInput,
    );
    assert.equal(backend.resetCalls, 1, "exact recovery uses one planned output generation");

    // A redelivery of the uncertain request may cross a new owner/fence, but
    // it must retain its old in-doubt disposition and never reach the backend.
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "old-agent-redelivery",
        type: "input.agent-message",
        lease: recoveredLease,
        operationId: oldOperationId,
        pane: "0",
        message: oldMessage,
        submit: true,
      }),
      (error) => error.code === "OPERATION_IN_DOUBT",
    );
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "old-agent-payload-conflict",
        type: "input.agent-message",
        lease: recoveredLease,
        operationId: oldOperationId,
        pane: "0",
        message: "different bytes under the old operation id",
        submit: true,
      }),
      (error) => error.code === "INVALID_REQUEST",
    );
    assert.deepEqual(backend.writes, []);

    const freshRequest = {
      protocolVersion: 1,
      requestId: "agent-chat-fresh-after-recovery",
      type: "input.agent-message",
      lease: recoveredLease,
      operationId: "agent-chat-fresh-after-recovery",
      pane: "0",
      message: "fresh message after recovery",
      submit: true,
    };
    const fresh = await authority.handle(freshRequest);
    const freshDuplicate = await authority.handle({
      ...freshRequest,
      requestId: "agent-chat-fresh-redelivery",
    });
    assert.equal(fresh.deduplicated, false);
    assert.equal(freshDuplicate.deduplicated, true);
    assert.deepEqual(backend.writes, [{
      kind: "agent-message",
      value: { pane: "0", message: "fresh message after recovery", submit: true },
    }]);

    const active = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(active.lifecycle, "ACTIVE");
    assert.equal(active.recovery, undefined);
    assert.equal(
      active.completedOperations.find(({ operationId }) => operationId === oldOperationId)
        .disposition,
      "in-doubt",
    );
    assert.equal(
      active.completedOperations.find(
        ({ operationId }) => operationId === freshRequest.operationId,
      ).disposition,
      "committed",
    );

    await authority.handle({
      protocolVersion: 1,
      requestId: "agent-recovery-release",
      type: "lease.release",
      lease: recoveredLease,
    });
    const resetBaseline = backend.resetCalls;
    const persistUnsafeRecovery = (reason, previousOwnerKind, operationId) => {
      const state = terminalControl.loadTerminalControlState(temp.path);
      const record = state.targets[0];
      record.lifecycle = "RECOVERY_REQUIRED";
      record.ownership = {
        state: "FREE",
        fence: terminalControl.nextDecimal(record.ownership.fence),
      };
      record.recovery = {
        reason,
        since: "2026-07-13T02:00:00.000Z",
        previousControlEpoch: state.controlEpoch,
        previousOwnerKind,
        ...(operationId === undefined ? {} : { operationId }),
      };
      record.revision = terminalControl.nextDecimal(record.revision);
      record.updatedAt = "2026-07-13T02:00:00.000Z";
      terminalControl.saveTerminalControlState(state, temp.path);
    };

    persistUnsafeRecovery("DRAIN_UNCERTAIN", "relay-v2");
    await assert.rejects(
      authority.prepareRelayV2ExactTarget(exactInput),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    persistUnsafeRecovery("OPERATION_IN_DOUBT", "feishu", oldOperationId);
    await assert.rejects(
      authority.prepareRelayV2ExactTarget(exactInput),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const rawState = terminalControl.loadTerminalControlState(temp.path);
    const rawRecord = rawState.targets[0];
    rawRecord.completedOperations.push({
      operationId: "raw-in-doubt-must-stay-blocked",
      ownerInstanceId: "relay-v2:raw-owner",
      fence: rawRecord.ownership.fence,
      payloadHash: "a".repeat(64),
      kind: "raw",
      disposition: "in-doubt",
      completedAt: "2026-07-13T02:00:01.000Z",
    });
    rawRecord.recovery = {
      reason: "OPERATION_IN_DOUBT",
      since: "2026-07-13T02:00:01.000Z",
      previousControlEpoch: rawState.controlEpoch,
      previousOwnerKind: "relay-v2",
      operationId: "raw-in-doubt-must-stay-blocked",
    };
    rawRecord.revision = terminalControl.nextDecimal(rawRecord.revision);
    rawRecord.updatedAt = "2026-07-13T02:00:01.000Z";
    terminalControl.saveTerminalControlState(rawState, temp.path);
    await assert.rejects(
      authority.prepareRelayV2ExactTarget(exactInput),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(
      backend.resetCalls,
      resetBaseline,
      "drain, Feishu-owned, and raw-input uncertainty never enter Agent recovery",
    );
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("one exact fence admits only one active interactive producer", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"B".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-single-producer",
    scopeId: "scope-single-producer",
    sessionId: "session-single-producer",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-single-producer",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2-host-reservation" },
  };
  try {
    const target = await resolved(authority);
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const streamOwner = { kind: "relay-v2", instanceId: "relay-v2-stream-one" };
    const streamLease = authority.consumeRelayV2ExactTarget(
      preparation.claim,
      exactInput,
      streamOwner,
    );
    await authority.handle(rawRequest(streamLease, "single-producer-write", "stream-one"));

    await assert.rejects(
      acquired(
        authority,
        target.controlTargetId,
        { kind: "relay-v2", instanceId: "relay-v2-agent-conversation" },
      ),
      (error) => error.code === "RESOURCE_EXHAUSTED"
        && error.retryable === true
        && error.message === "terminal input already has another active producer",
    );
    assert.equal(backend.writes.length, 1);

    await authority.handle({
      protocolVersion: 1,
      requestId: "single-producer-release",
      type: "lease.release",
      lease: streamLease,
    });
    const agent = await acquired(
      authority,
      target.controlTargetId,
      { kind: "relay-v2", instanceId: "relay-v2-agent-conversation" },
    );
    assert.equal(agent.ownership.state, "HELD");
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact claims survive ping and foreign status while same-target status still fences", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"A".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-poll-fence",
    scopeId: "scope-poll-fence",
    sessionId: "session-poll-fence",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-poll-fence",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:poll-fence" },
  };
  try {
    const target = await resolved(authority);
    const foreignTarget = await resolved(authority, "foreign-terminal");
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);

    const ping = await authority.handle({
      protocolVersion: 1,
      requestId: "exact-poll-ping",
      type: "ping",
    });
    assert.equal(ping.authority, "local-terminal-control");
    const foreignStatus = await authority.handle({
      protocolVersion: 1,
      requestId: "exact-poll-foreign-status",
      type: "ownership.status",
      controlTargetId: foreignTarget.controlTargetId,
    });
    assert.equal(foreignStatus.state, "FREE");

    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const opened = await authority.consumeRelayV2ExactObservation(
      preparation.claim,
      exactInput,
      preparation.identity,
    );
    await authority.closeRelayV2ExactObservation(opened.observation);

    const fenced = await authority.prepareRelayV2ExactTarget(exactInput);
    const sameTargetStatus = await authority.handle({
      protocolVersion: 1,
      requestId: "exact-poll-same-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(sameTargetStatus.state, "FREE");
    assert.throws(
      () => authority.fenceRelayV2ExactTarget(fenced.claim, exactInput),
      (error) => error.code === "PERMISSION_DENIED",
    );
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact target external-state entries are TTL-bounded without resurrecting stale claims", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"A".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  let clock = Date.parse("2026-07-22T00:00:00.000Z");
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
    relayV2ExactTargetTtlMs: 1_000,
    now: () => new Date(clock),
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-ttl-bound",
    scopeId: "scope-ttl-bound",
    sessionId: "session-ttl-bound",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-ttl-bound",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:ttl-bound" },
  };
  try {
    const target = await resolved(authority);
    const foreignTarget = await resolved(authority, "foreign-terminal");
    // Prepared before any status touches this target: stamped at epoch 0.
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    // A same-target status creates the external-state entry and fences the claim.
    await authority.handle({
      protocolVersion: 1,
      requestId: "ttl-bound-same-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(authority.relayV2TargetExternalStates.has(target.controlTargetId), true);
    assert.throws(
      () => authority.fenceRelayV2ExactTarget(preparation.claim, exactInput),
      (error) => error.code === "PERMISSION_DENIED",
    );
    // Advance past the claim TTL: the lease expires and the entry becomes evictable.
    clock += 2_000;
    // A foreign-target status triggers the sweep; the stale entry is evicted.
    await authority.handle({
      protocolVersion: 1,
      requestId: "ttl-bound-foreign-status",
      type: "ownership.status",
      controlTargetId: foreignTarget.controlTargetId,
    });
    assert.equal(authority.relayV2TargetExternalStates.has(target.controlTargetId), false,
      "the untouched external-state entry is evicted after the TTL sweep");
    assert.equal(authority.relayV2TargetExternalStates.size, 1,
      "only the freshly-touched foreign entry remains");
    // The epoch-0 claim must not resurrect: its lease has expired, so the
    // missing entry (read as epoch 0) still fails the current check.
    assert.throws(
      () => authority.fenceRelayV2ExactTarget(preparation.claim, exactInput),
      (error) => error.code === "PERMISSION_DENIED",
      "a stale epoch-0 claim must not resurrect after TTL eviction",
    );
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact read observation consumes the admitted claim into a freshly seeded generation", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const openingOrder = [];
  const prepareOutput = backend.prepareOutput.bind(backend);
  backend.prepareOutput = async (...args) => ({
    ...await prepareOutput(...args),
    retainedStartCursor: 0,
  });
  const resetOutput = backend.resetOutput.bind(backend);
  backend.resetOutput = async (controlTargetId, ...args) => {
    openingOrder.push("snapshot");
    const previous = Buffer.from(
      backend.outputs.get(`${controlTargetId}:${backend.outputGeneration}`) ?? Buffer.alloc(0),
    );
    const reset = await resetOutput(controlTargetId, ...args);
    backend.outputs.set(`${controlTargetId}:${reset.generation}`, previous);
    return { ...reset, cursor: previous.byteLength, retainedStartCursor: 0 };
  };
  const resize = backend.resize.bind(backend);
  backend.resize = async (...args) => {
    openingOrder.push("resize");
    return resize(...args);
  };
  const incarnation = `twinc2.${"A".repeat(43)}`;
  backend.inspectExactTarget = async (input) => {
    assert.deepEqual(input, {
      managedName: "managed-terminal",
      managedKind: "terminal",
      managedIncarnation: incarnation,
      pane: 0,
    });
    return {
      managedSession: {
        name: "managed-terminal",
        kind: "terminal",
        profile: "dashboard",
        cwd: "/tmp",
        createdAt: backend.createdAt,
      },
      managedIncarnation: incarnation,
      tmuxInstanceId: backend.instance,
      paneIdentity: "%1",
    };
  };
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-observe",
    scopeId: "scope-observe",
    sessionId: "session-observe",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-observe",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:observer-one" },
  };
  try {
    const target = await resolved(authority);
    backend.appendOutput(target.controlTargetId, "hello\n");
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    // A foreign or tampered identity is rejected before anything is consumed.
    await assert.rejects(
      authority.consumeRelayV2ExactObservation(preparation.claim, exactInput, {
        ...preparation.identity,
        targetIncarnationProof: `twct2.${"B".repeat(43)}`,
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const opened = await authority.consumeRelayV2ExactObservation(
      preparation.claim,
      exactInput,
      preparation.identity,
      { cols: 47, rows: 62 },
    );
    assert.deepEqual(openingOrder.slice(0, 2), ["resize", "snapshot"]);
    assert.deepEqual(backend.writes[0], {
      kind: "resize",
      value: { pane: "0", cols: 47, rows: 62 },
    });
    assert.equal(opened.binding.controlTargetId, target.controlTargetId);
    assert.equal(opened.binding.controlEpoch, target.controlEpoch);
    assert.equal(opened.binding.targetIncarnationProof, preparation.identity.targetIncarnationProof);
    assert.equal(
      opened.binding.outputCursor,
      0,
      "a fresh Relay v2 observation starts at the retained screen seed",
    );
    // Observation consumed the reservation: the target is FREE again and the
    // observer holds no lease and no input ownership.
    const free = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(free.ownership.state, "FREE");
    const firstTail = await authority.tailRelayV2ExactObservation(opened.observation, 0);
    assert.equal(Buffer.from(firstTail.dataBase64, "base64").toString("utf8"), "hello\n");

    // A later interactive lease lifecycle on the same target does not rotate
    // the pinned generation while the observer is active.
    const interactive = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "observed-pty"),
    );
    const written = await authority.handle(rawRequest(interactive.lease, "observed-raw", "x"));
    assert.equal(written.outputGeneration, opened.binding.outputGeneration);
    backend.appendOutput(target.controlTargetId, "world\n");
    const released = await authority.handle({
      protocolVersion: 1,
      requestId: "observed-release",
      type: "lease.release",
      lease: interactive.lease,
    });
    assert.equal(released.state, "FREE");
    assert.equal(released.outputGeneration, opened.binding.outputGeneration);
    assert.equal(backend.resetCalls, 1, "release must not reset output generation while observed");
    const continued = await authority.tailRelayV2ExactObservation(
      opened.observation,
      firstTail.nextCursor,
    );
    assert.equal(Buffer.from(continued.dataBase64, "base64").toString("utf8"), "world\n");

    // Closing the observation is idempotent and runs the deferred reset.
    await authority.closeRelayV2ExactObservation(opened.observation);
    await authority.closeRelayV2ExactObservation(opened.observation);
    assert.equal(backend.resetCalls, 2);
    await assert.rejects(
      authority.tailRelayV2ExactObservation(opened.observation, continued.nextCursor),
      (error) => error.code === "PERMISSION_DENIED",
    );
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact observation consume is single-use, failed deferred reset stays retryable, stale observers retire", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"A".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-observe-race",
    scopeId: "scope-observe-race",
    sessionId: "session-observe-race",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-observe-race",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:observer-race" },
  };
  try {
    const target = await resolved(authority);
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    // The claim is burned synchronously: while the observation consume waits
    // on the canonical lock, no other path can consume the same claim.
    const pending = authority.consumeRelayV2ExactObservation(
      preparation.claim,
      exactInput,
      preparation.identity,
    );
    assert.throws(
      () => authority.consumeRelayV2ExactTarget(preparation.claim, exactInput),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      authority.consumeRelayV2ExactObservation(
        preparation.claim,
        exactInput,
        preparation.identity,
      ),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const opened = await pending;
    assert.equal(
      opened.binding.outputGeneration,
      terminalControl.loadTerminalControlState(temp.path).targets[0].outputGeneration,
    );

    // A failed deferred reset keeps the observation open and the close
    // retryable instead of losing the observer.
    backend.failReset = true;
    await assert.rejects(
      authority.closeRelayV2ExactObservation(opened.observation),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    backend.failReset = false;

    // The next tail recovers the target, rotates the generation, and fences
    // the now-stale observer out of the per-target registry.
    await assert.rejects(
      authority.tailRelayV2ExactObservation(opened.observation, 0),
      (error) => error.code === "STALE_OUTPUT_CURSOR",
    );
    assert.equal(backend.resetCalls, 2);

    // The stale observer must not suppress the reset of a later release.
    const interactive = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "observed-race-pty"),
    );
    const released = await authority.handle({
      protocolVersion: 1,
      requestId: "observed-race-release",
      type: "lease.release",
      lease: interactive.lease,
    });
    assert.equal(released.state, "FREE");
    assert.equal(backend.resetCalls, 3);
    assert.notEqual(released.outputGeneration, opened.binding.outputGeneration);

    // Closing the fenced observation is an idempotent no-op.
    await authority.closeRelayV2ExactObservation(opened.observation);
    await authority.closeRelayV2ExactObservation(opened.observation);
    assert.equal(backend.resetCalls, 3);
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("exact observation consume with a changed live pane invalidates and frees the target persistently", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"A".repeat(43)}`;
  let paneIdentity = "%1";
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity,
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-observe-gone",
    scopeId: "scope-observe-gone",
    sessionId: "session-observe-gone",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-observe-gone",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:observer-gone" },
  };
  try {
    await resolved(authority);
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    // The live pane identity changed between prepare and consume: the burn
    // of the claim must still invalidate and free the persisted target.
    paneIdentity = "%2";
    await assert.rejects(
      authority.consumeRelayV2ExactObservation(
        preparation.claim,
        exactInput,
        preparation.identity,
      ),
      (error) => error.code === "TARGET_GONE",
    );
    const persisted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(persisted.lifecycle, "TARGET_GONE");
    assert.equal(persisted.ownership.state, "FREE");
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("a tail on a backend that deterministically gone mid-read surfaces TARGET_GONE, not RECOVERY_REQUIRED", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"C".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-tail-gone",
    scopeId: "scope-tail-gone",
    sessionId: "session-tail-gone",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-tail-gone",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:tail-gone" },
  };
  try {
    const target = await resolved(authority);
    backend.appendOutput(target.controlTargetId, "seed\n");
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const opened = await authority.consumeRelayV2ExactObservation(
      preparation.claim,
      exactInput,
      preparation.identity,
    );
    // kill_session lands in the read window: the backend proves the pane
    // lifecycle no longer exists. The daemon must retire the incarnation and
    // surface TARGET_GONE (a natural exit) rather than masking it as an
    // uncertain RECOVERY_REQUIRED, which the host would close as backend_error.
    backend.tailOutput = async () => {
      throw new terminalControl.TerminalControlProtocolError(
        "TARGET_GONE",
        "tmux backend lifecycle no longer exists",
      );
    };
    await assert.rejects(
      authority.tailRelayV2ExactObservation(opened.observation, opened.binding.outputCursor),
      (error) => error.code === "TARGET_GONE",
    );
    const persisted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(persisted.lifecycle, "TARGET_GONE");
    assert.equal(persisted.ownership.state, "FREE");
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("a tail whose uncovered tmux sub-call fails RECOVERY_REQUIRED while the incarnation is actually gone re-probes to TARGET_GONE", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"E".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-tail-reprobe-gone",
    scopeId: "scope-tail-reprobe-gone",
    sessionId: "session-tail-reprobe-gone",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-tail-reprobe-gone",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:tail-reprobe-gone" },
  };
  try {
    const target = await resolved(authority);
    backend.appendOutput(target.controlTargetId, "seed\n");
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const opened = await authority.consumeRelayV2ExactObservation(
      preparation.claim,
      exactInput,
      preparation.identity,
    );
    // kill_session lands between the tail's assertTargetCurrent and one of
    // prepareOutput's uncovered sub-calls (the show-options identity read, the
    // stopped pane_pipe check, or the no-generation segment scan). That tmux
    // invocation does not carry the exact "can't find session/pane" text, so it
    // surfaces as RECOVERY_REQUIRED even though the lifecycle is deterministically
    // over. The authority's bounded re-probe then proves the incarnation is gone
    // and must retire it as TARGET_GONE (natural backend_exit), not leave it
    // RECOVERY_REQUIRED (which the host closes as backend_error).
    backend.tailOutput = async () => {
      backend.current = false;
      throw new terminalControl.TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture stopped before the authority could prove continuity",
      );
    };
    await assert.rejects(
      authority.tailRelayV2ExactObservation(opened.observation, opened.binding.outputCursor),
      (error) => error.code === "TARGET_GONE",
    );
    const persisted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(persisted.lifecycle, "TARGET_GONE");
    assert.equal(persisted.ownership.state, "FREE");
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});

test("a tail with a genuinely uncertain mid-read failure stays RECOVERY_REQUIRED", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const incarnation = `twinc2.${"D".repeat(43)}`;
  backend.inspectExactTarget = async () => ({
    managedSession: {
      name: "managed-terminal",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/tmp",
      createdAt: backend.createdAt,
    },
    managedIncarnation: incarnation,
    tmuxInstanceId: backend.instance,
    paneIdentity: "%1",
  });
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    relayV2ProcessTarget: { kind: "local", targetId: "local" },
  });
  const exactInput = {
    schemaVersion: 1,
    hostId: "host-tail-uncertain",
    scopeId: "scope-tail-uncertain",
    sessionId: "session-tail-uncertain",
    pane: 0,
    processTarget: { kind: "local", targetId: "local" },
    backendInstanceKey: "backend-instance-tail-uncertain",
    managedTarget: { name: "managed-terminal", kind: "terminal", incarnation },
    owner: { kind: "relay-v2", instanceId: "relay-v2:tail-uncertain" },
  };
  try {
    const target = await resolved(authority);
    backend.appendOutput(target.controlTargetId, "seed\n");
    const preparation = await authority.prepareRelayV2ExactTarget(exactInput);
    authority.fenceRelayV2ExactTarget(preparation.claim, exactInput);
    const opened = await authority.consumeRelayV2ExactObservation(
      preparation.claim,
      exactInput,
      preparation.identity,
    );
    // A non-deterministic failure (no TARGET_GONE/TARGET_NOT_FOUND code) is not
    // a provable lifecycle end: it must stay RECOVERY_REQUIRED so the host keeps
    // its fail-closed backend_error behavior for continuity it cannot prove.
    backend.tailOutput = async () => {
      throw new Error("tmux capture-pane failed: transient io error");
    };
    await assert.rejects(
      authority.tailRelayV2ExactObservation(opened.observation, opened.binding.outputCursor),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const persisted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(persisted.lifecycle, "RECOVERY_REQUIRED");
  } finally {
    await authority.closeRelayV2ExactTargetAuthority().catch(() => undefined);
    temp.cleanup();
  }
});
