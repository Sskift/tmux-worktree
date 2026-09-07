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

test("permission-protected socket serves correlated local requests and shortens long HOME paths", async () => {
  const temp = tempState();
  const socketPath = join(temp.root, "control.sock");
  const abort = new AbortController();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
  });
  const serving = terminalControl.runTerminalControlServer({ socketPath, authority, signal: abort.signal });
  try {
    const deadline = Date.now() + 2_000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    assert.deepEqual(
      await terminalControl.requestTerminalControl(
        { type: "ping" },
        { socketPath, autoStart: false },
      ),
      {
        protocolVersion: 1,
        authority: "local-terminal-control",
        capabilities: ["output.rendered-snapshot", "activity.agent-status", "activity.agent-result"],
      },
    );
    const canonical = new CanonicalTerminalControlSocketClient({ socketPath, timeoutMs: 2_000 });
    assert.deepEqual(await canonical.capabilities(), {
      renderedSnapshot: true,
      agentStatus: true,
      agentResult: true,
    });
    const currentHandle = authority.handle.bind(authority);
    authority.handle = async (request) => request.type === "ping"
      ? { protocolVersion: 1, authority: "local-terminal-control" }
      : currentHandle(request);
    assert.deepEqual(
      await canonical.capabilities(),
      { renderedSnapshot: false, agentStatus: false, agentResult: false },
      "a legacy ping without capabilities must not imply observation support",
    );
    authority.handle = async (request) => request.type === "ping"
      ? {
          protocolVersion: 1,
          authority: "local-terminal-control",
          capabilities: ["output.rendered-snapshot", ""],
        }
      : currentHandle(request);
    await assert.rejects(
      canonical.capabilities(),
      (error) => error?.code === "CONTROLLER_UNAVAILABLE" && /capabilities/.test(error.message),
    );
    authority.handle = currentHandle;
    const target = await canonical.resolveTarget("canonical-rendered");
    const feishu = await canonical.acquireLease(target.controlTargetId, {
      kind: "feishu",
      instanceId: "feishu:canonical-rendered",
    });
    const rendered = await canonical.renderedSnapshot({
      lease: feishu.lease,
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
      maxBytes: 128,
    });
    assert.equal(rendered.controlTargetId, target.controlTargetId);
    assert.equal(rendered.controlEpoch, feishu.lease.controlEpoch);
    assert.equal(rendered.leaseId, feishu.lease.leaseId);
    assert.equal(rendered.fence, feishu.lease.fence);
    assert.equal(rendered.ownerKind, "feishu");
    assert.equal(rendered.outputGeneration, feishu.ownership.outputGeneration);
    assert.equal(rendered.pane, "0");
    assert.equal(
      Buffer.from(rendered.dataBase64, "base64").toString("utf8"),
      "rendered terminal output\n",
    );
    assert.equal(rendered.truncated, false);
    const activity = await canonical.agentStatus({
      lease: feishu.lease,
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
    });
    assert.deepEqual(activity, {
      controlTargetId: target.controlTargetId,
      controlEpoch: feishu.lease.controlEpoch,
      leaseId: feishu.lease.leaseId,
      fence: feishu.lease.fence,
      ownerKind: "feishu",
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
      agentSupported: true,
      agentRunning: true,
      source: structuredClone(backend.agentSource),
    });
    const agentResult = await canonical.agentResult({
      lease: feishu.lease,
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
      source: backend.agentSource,
      maxBytes: 256,
    });
    assert.equal(agentResult.text, "Exact structured final response");
    assert.deepEqual(agentResult.source, backend.agentSource);
    const longHome = join(temp.root, "h".repeat(140));
    const shortened = terminalControl.terminalControlSocketPath(longHome);
    assert.ok(Buffer.byteLength(shortened, "utf8") <= 100, shortened);
    assert.equal(shortened, terminalControl.terminalControlSocketPath(longHome));
  } finally {
    abort.abort();
    await serving;
    temp.cleanup();
  }
});

test("exact auto-start hands the bound socket and state paths to one terminal-control child", async () => {
  const temp = tempState("tc-");
  const exactSocketPath = join(temp.root, "exact.sock");
  const exactStatePath = join(temp.root, "exact-state.json");
  const defaultSocketPath = join(temp.root, "default.sock");
  const defaultStatePath = join(temp.root, "default-state.json");
  const previousSocketPath = process.env.TW_TERMINAL_CONTROL_SOCKET;
  const previousStatePath = process.env.TW_TERMINAL_CONTROL_STATE;
  process.env.TW_TERMINAL_CONTROL_SOCKET = defaultSocketPath;
  process.env.TW_TERMINAL_CONTROL_STATE = defaultStatePath;
  try {
    assert.deepEqual(
      await terminalControl.requestTerminalControl(
        { type: "ping" },
        {
          socketPath: exactSocketPath,
          autoStart: true,
          autoStartCliTarget: {
            executable: process.execPath,
            entrypoint: terminalControlCli,
            idleExitMs: 30_000,
          },
          autoStartStatePath: exactStatePath,
          timeoutMs: 8_000,
        },
      ),
      {
        protocolVersion: 1,
        authority: "local-terminal-control",
        capabilities: [
          "output.rendered-snapshot",
          "activity.agent-status",
          "activity.agent-result",
        ],
      },
    );
    assert.deepEqual(
      terminalControl.loadTerminalControlState(exactStatePath),
      JSON.parse(readFileSync(exactStatePath, "utf8")),
    );
    assert.equal(existsSync(defaultSocketPath), false);
    assert.equal(existsSync(defaultStatePath), false);
  } finally {
    await stopAutoStartedTerminalControl(exactSocketPath);
    await stopAutoStartedTerminalControl(defaultSocketPath);
    if (previousSocketPath === undefined) delete process.env.TW_TERMINAL_CONTROL_SOCKET;
    else process.env.TW_TERMINAL_CONTROL_SOCKET = previousSocketPath;
    if (previousStatePath === undefined) delete process.env.TW_TERMINAL_CONTROL_STATE;
    else process.env.TW_TERMINAL_CONTROL_STATE = previousStatePath;
    temp.cleanup();
  }
});

test("auto-start accepts ping before a slow login shell finishes", async () => {
  const temp = tempState("tc-slow-shell-");
  const socketPath = join(temp.root, "slow-shell.sock");
  const statePath = join(temp.root, "slow-shell-state.json");
  const slowShell = join(temp.root, "slow-login-shell");
  writeFileSync(slowShell, "#!/bin/sh\nexec /bin/sleep 4\n", { mode: 0o700 });
  const previousShell = process.env.SHELL;
  process.env.SHELL = slowShell;
  try {
    const result = await terminalControl.requestTerminalControl(
      { type: "ping" },
      {
        socketPath,
        autoStart: true,
        autoStartCliTarget: {
          executable: process.execPath,
          entrypoint: terminalControlCli,
          idleExitMs: 30_000,
        },
        autoStartStatePath: statePath,
        timeoutMs: 2_000,
      },
    );
    assert.equal(result.authority, "local-terminal-control");
  } finally {
    await stopAutoStartedTerminalControl(socketPath);
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    temp.cleanup();
  }
});

test("explicit ephemeral auto-start exits after idle and removes its owned sockets", async () => {
  const temp = tempState("tc-idle-");
  const socketPath = join(temp.root, "ephemeral.sock");
  const statePath = join(temp.root, "ephemeral-state.json");
  const compoundSocketPath = exactCompound.relayV2RemoteExactCompoundSocketPathV1(socketPath);
  try {
    await terminalControl.requestTerminalControl(
      { type: "ping" },
      {
        socketPath,
        autoStart: true,
        autoStartCliTarget: {
          executable: process.execPath,
          entrypoint: terminalControlCli,
          idleExitMs: 150,
        },
        autoStartStatePath: statePath,
        timeoutMs: 8_000,
      },
    );
    assert.equal(existsSync(socketPath), true);
    const deadline = Date.now() + 3_000;
    while ((existsSync(socketPath) || existsSync(`${socketPath}.server.lock`))
      && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(socketPath), false);
    assert.equal(existsSync(compoundSocketPath), false);
    assert.equal(existsSync(`${socketPath}.server.lock`), false);
  } finally {
    await stopAutoStartedTerminalControl(socketPath);
    temp.cleanup();
  }
});

test("local-development exact auto-start binds the child to its validated managed-state home", async (t) => {
  const sessionName = `tw-term-isolated-auto-start-${process.pid}`;
  const harness = isolatedManagedTmux(t, sessionName, { lifecycleV2: true });
  if (harness === undefined) return;
  const socketPath = join(
    tmpdir(),
    `twv2-home-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
  );
  const statePath = join(
    harness.twHome,
    "terminal-control-state-v1.json",
  );
  const unrelatedHome = join(harness.temp.root, "unrelated-parent-home");
  mkdirSync(unrelatedHome, { mode: 0o700 });
  const isolatedHome = realpathSync.native(harness.home);
  const listExactSession = () => {
    const listed = spawnSync(
      process.execPath,
      [terminalControlCli, "rpc-v2", "list"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: isolatedHome },
      },
    );
    assert.equal(listed.status, 0, listed.stderr);
    const session = JSON.parse(listed.stdout).sessions.find(
      (candidate) => candidate.name === sessionName,
    );
    assert.ok(session);
    return session;
  };
  let exactTargets;
  try {
    process.env.HOME = unrelatedHome;
    assert.deepEqual(
      await terminalControl.requestTerminalControl(
        { type: "ping" },
        {
          socketPath,
          autoStart: true,
          autoStartCliTarget: {
            executable: process.execPath,
            entrypoint: terminalControlCli,
            home: isolatedHome,
            idleExitMs: 30_000,
          },
          autoStartStatePath: statePath,
          timeoutMs: 8_000,
        },
      ),
      {
        protocolVersion: 1,
        authority: "local-terminal-control",
        capabilities: [
          "output.rendered-snapshot",
          "activity.agent-status",
          "activity.agent-result",
        ],
      },
    );
    assert.deepEqual(
      terminalControl.loadTerminalControlState(statePath).targets,
      [],
      "the v2 path must not depend on prior name-only target registration",
    );

    const session = listExactSession();
    const processTarget = {
      kind: "local",
      targetId: "local-development-isolated-home",
    };
    exactTargets = new exactCompound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
      channels: exactCompound.captureRelayV2LocalExactCompoundChannelFactoryV1({
        daemonSocketPath: socketPath,
        processTarget,
      }),
      owner: {
        kind: "relay-v2",
        instanceId: "relay-v2:isolated-home-test",
      },
    });
    const input = {
      schemaVersion: 1,
      hostId: "host-isolated-home",
      scopeId: "scope-isolated-home",
      sessionId: "session-isolated-home",
      pane: 0,
      processTarget,
      backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
        processTarget,
        incarnation: session.incarnation,
      }),
      managedTarget: {
        name: sessionName,
        kind: "terminal",
        incarnation: session.incarnation,
      },
    };
    const evidence = await exactTargets.resolveExactTarget(input);
    const [provisioned] = terminalControl.loadTerminalControlState(statePath).targets;
    assert.equal(provisioned.managedSession.name, sessionName);
    assert.equal(provisioned.managedSession.kind, "terminal");
    assert.equal(
      evidence.exactControlIdentity.controlTargetId,
      provisioned.controlTargetId,
    );
    exactTargets.fenceExactTargetForAdmission(input, evidence);

    const staleControlTargetId = provisioned.controlTargetId;
    const staleTmuxInstanceId = provisioned.backend.tmuxInstanceId;
    await exactTargets.close();
    exactTargets = undefined;
    const beforeReplacement = terminalControl.loadTerminalControlState(statePath)
      .targets.find((candidate) => candidate.controlTargetId === staleControlTargetId);
    assert.equal(beforeReplacement.lifecycle, "ACTIVE");
    assert.equal(beforeReplacement.ownership.state, "FREE");
    const killed = spawnSync(
      harness.wrapper,
      ["kill-session", "-t", `=${sessionName}`],
      { encoding: "utf8" },
    );
    assert.equal(killed.status, 0, killed.stderr);
    const parentHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    try {
      const recreated = managedSessions.createManagedTerminalSession({
        cwd: harness.temp.root,
        profile: "dashboard",
        quiet: true,
        lifecycleV2: {
          reservationCorrelation: null,
          displayLabel: sessionName,
        },
      }, {
        tmuxBin: () => harness.wrapper,
        randomId: () => sessionName.slice("tw-term-".length),
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        setupClipboardBindings: () => {},
      });
      assert.equal(recreated.session, sessionName);
    } finally {
      if (parentHome === undefined) delete process.env.HOME;
      else process.env.HOME = parentHome;
    }
    const replacementSession = listExactSession();
    assert.notEqual(replacementSession.incarnation, session.incarnation);

    exactTargets = new exactCompound.RelayV2RemoteExactTerminalControlCompoundAdapterV1({
      channels: exactCompound.captureRelayV2LocalExactCompoundChannelFactoryV1({
        daemonSocketPath: socketPath,
        processTarget,
      }),
      owner: {
        kind: "relay-v2",
        instanceId: "relay-v2:isolated-home-replacement-test",
      },
    });
    const replacementInput = {
      ...input,
      sessionId: "session-isolated-home-replacement",
      backendInstanceKey: backendIdentity.issueRelayV2CanonicalBackendInstanceKey({
        processTarget,
        incarnation: replacementSession.incarnation,
      }),
      managedTarget: {
        ...input.managedTarget,
        incarnation: replacementSession.incarnation,
      },
    };
    const replacementEvidence = await exactTargets.resolveExactTarget(replacementInput);
    const refreshedTargets = terminalControl.loadTerminalControlState(statePath).targets;
    const stale = refreshedTargets.find(
      (candidate) => candidate.controlTargetId === staleControlTargetId,
    );
    const replacement = refreshedTargets.find(
      (candidate) => candidate.controlTargetId
        === replacementEvidence.exactControlIdentity.controlTargetId,
    );
    assert.equal(stale.lifecycle, "TARGET_GONE");
    assert.ok(replacement);
    assert.equal(replacement.lifecycle, "ACTIVE");
    assert.equal(replacement.managedSession.name, sessionName);
    assert.equal(replacement.managedSession.kind, "terminal");
    assert.equal(replacement.managedSession.createdAt, "2026-07-14T00:00:00.000Z");
    assert.notEqual(replacement.controlTargetId, staleControlTargetId);
    assert.notEqual(replacement.backend.tmuxInstanceId, staleTmuxInstanceId);
    exactTargets.fenceExactTargetForAdmission(replacementInput, replacementEvidence);
  } finally {
    await exactTargets?.close().catch(() => undefined);
    await stopAutoStartedTerminalControl(socketPath);
    process.env.HOME = harness.home;
    await harness.cleanup();
  }
});
