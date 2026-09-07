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

test("agent status requires an exact Agent consumer lease and output generation", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
  });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(
      authority,
      target.controlTargetId,
      owner("dashboard", "activity-pty"),
    );
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "dashboard-agent-status",
        type: "activity.agent-status",
        lease: dashboard.lease,
        outputGeneration: dashboard.ownership.outputGeneration,
        pane: "0",
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await authority.handle({
      protocolVersion: 1,
      requestId: "release-dashboard-activity",
      type: "lease.release",
      lease: dashboard.lease,
    });
    const feishu = await acquired(
      authority,
      target.controlTargetId,
      owner("feishu", "activity-binding:daemon"),
    );
    const request = {
      protocolVersion: 1,
      requestId: "feishu-agent-status",
      type: "activity.agent-status",
      lease: feishu.lease,
      outputGeneration: feishu.ownership.outputGeneration,
      pane: "0",
    };
    assert.deepEqual(await authority.handle(request), {
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
    assert.equal(backend.agentStatusCalls.length, 1);
    await assert.rejects(
      authority.handle({ ...request, requestId: "stale-agent-generation", outputGeneration: "stale" }),
      (error) => error.code === "STALE_OUTPUT_CURSOR",
    );
    await assert.rejects(
      authority.handle({
        ...request,
        requestId: "stale-agent-fence",
        lease: { ...feishu.lease, fence: (BigInt(feishu.lease.fence) + 1n).toString() },
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await authority.handle({
      protocolVersion: 1,
      requestId: "release-feishu-activity",
      type: "lease.release",
      lease: feishu.lease,
    });
    const relayV2 = await acquired(
      authority,
      target.controlTargetId,
      owner("relay-v2", "agent-lifecycle:android-client"),
    );
    const relayStatus = await authority.handle({
      ...request,
      requestId: "relay-v2-agent-status",
      lease: relayV2.lease,
      outputGeneration: relayV2.ownership.outputGeneration,
    });
    assert.equal(relayStatus.ownerKind, "relay-v2");
    assert.equal(relayStatus.agentSupported, true);
  } finally {
    temp.cleanup();
  }
});

test("structured Claude and Codex transcripts yield only the exact final assistant response", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-agent-transcript-"));
  const claudeCwd = join(root, "claude-worktree");
  const claudeSessionId = "11111111-1111-4111-8111-111111111111";
  const claudeDirectory = join(root, ".claude", "projects", claudeCwd.replace(/[^A-Za-z0-9]/g, "-"));
  const claudePath = join(claudeDirectory, `${claudeSessionId}.jsonl`);
  const claudeRows = [
    { type: "user", uuid: "claude-user-1", timestamp: "2026-07-21T01:00:00.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false, message: { role: "user", content: "investigate" } },
    { type: "assistant", uuid: "claude-intermediate", timestamp: "2026-07-21T01:01:00.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "intermediate status" }] } },
    { type: "system", subtype: "turn_duration", uuid: "claude-duration-1", parentUuid: "claude-intermediate", timestamp: "2026-07-21T01:01:01.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false },
    { type: "user", uuid: "claude-notification", timestamp: "2026-07-21T01:02:00.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false, message: { role: "user", content: "<task-notification>worker finished</task-notification>" } },
  ];
  try {
    mkdirSync(claudeDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(claudePath, `${claudeRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const claudeSource = terminalControl.discoverActiveAgentSource({
      provider: "claude", cwd: claudeCwd, home: root,
    });
    assert.equal(claudeSource.boundary, "after");
    claudeRows.push(
      { type: "assistant", uuid: "claude-final", timestamp: "2026-07-21T01:03:00.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Claude final answer" }, { type: "tool_use", name: "ignored-tool" }] } },
      { type: "user", uuid: "claude-tool-result", timestamp: "2026-07-21T01:03:01.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "composer footer must stay private" }] } },
      { type: "system", subtype: "stop_hook_summary", uuid: "claude-stop-hook", parentUuid: "claude-final", timestamp: "2026-07-21T01:03:02.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false },
      { type: "system", subtype: "turn_duration", uuid: "claude-duration-2", parentUuid: "claude-stop-hook", timestamp: "2026-07-21T01:03:03.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false },
    );
    writeFileSync(claudePath, `${claudeRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const claudeResult = terminalControl.readCompletedAgentResult({
      source: claudeSource, cwd: claudeCwd, home: root, maxBytes: 1024,
    });
    assert.equal(claudeResult.text, "Claude final answer");
    assert.doesNotMatch(claudeResult.text, /composer footer|ignored-tool/);

    const codexCwd = join(root, "codex-worktree");
    const codexSessionId = "019f1111-1111-7111-8111-111111111111";
    const codexTurnId = "019f2222-2222-7222-8222-222222222222";
    const codexDirectory = join(root, ".codex", "sessions", "2026", "07", "21");
    const codexPath = join(codexDirectory, `rollout-2026-07-21T01-00-00-${codexSessionId}.jsonl`);
    const codexRows = [
      { type: "session_meta", timestamp: "2026-07-21T02:00:00.000Z", payload: { id: codexSessionId, cwd: codexCwd } },
      { type: "event_msg", timestamp: "2026-07-21T02:00:01.000Z", payload: { type: "task_started", turn_id: codexTurnId } },
      { type: "session_meta", timestamp: "2026-07-21T02:00:02.000Z", payload: { id: codexSessionId, cwd: codexCwd } },
    ];
    mkdirSync(codexDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const codexSource = terminalControl.discoverActiveAgentSource({
      provider: "codex", cwd: codexCwd, home: root,
    });
    assert.equal(codexSource.boundary, "exact");
    codexRows.push(
      { type: "event_msg", timestamp: "2026-07-21T02:00:30.000Z", payload: { type: "agent_message", phase: "commentary", message: "Checking the current state" } },
      { type: "response_item", timestamp: "2026-07-21T02:00:31.000Z", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "sensitive command" } },
      { type: "response_item", timestamp: "2026-07-21T02:00:32.000Z", payload: { type: "function_call_output", call_id: "call-1", output: "sensitive output" } },
      { type: "response_item", timestamp: "2026-07-21T02:01:00.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex final answer" }] } },
      { type: "event_msg", timestamp: "2026-07-21T02:01:01.000Z", payload: { type: "task_complete", turn_id: codexTurnId, last_agent_message: "Codex final answer" } },
    );
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const codexProgress = terminalControl.readAgentProgress({
      source: codexSource, cwd: codexCwd, home: root,
    });
    assert.deepEqual(codexProgress.map(({ kind, title, status }) => ({ kind, title, status })), [
      { kind: "status", title: "Checking the current state", status: "completed" },
      { kind: "tool", title: "执行命令", status: "completed" },
    ]);
    assert.doesNotMatch(JSON.stringify(codexProgress), /sensitive command|sensitive output/);
    assert.equal(terminalControl.readCompletedAgentResult({
      source: codexSource, cwd: codexCwd, home: root, maxBytes: 1024,
    }).text, "Codex final answer");

    assert.equal(terminalControl.resumedAgentSessionIdFromStartCommand(
      `export PATH='/bin'; codex resume '${codexSessionId}'; exec /bin/zsh -l`,
      "codex",
    ), codexSessionId);
    assert.equal(terminalControl.resumedAgentSessionIdFromStartCommand(
      `export PATH='/bin'; codex -c check_for_update_on_startup=false resume '${codexSessionId}'; exec /bin/zsh -l`,
      "codex",
    ), codexSessionId);
    assert.equal(terminalControl.resumedAgentSessionIdFromStartCommand(
      `export PATH='/bin'; codex -c 'check_for_update_on_startup=false' -m 'gpt-5.6-terra' -c 'model_reasoning_effort="high"' -c 'plan_mode_reasoning_effort="high"' resume '${codexSessionId}'; exec /bin/zsh -l`,
      "codex",
    ), codexSessionId);
    const preBoundaryTurnId = "019f3333-3333-7333-8333-333333333333";
    codexRows.push(
      { type: "event_msg", timestamp: "2026-07-21T02:02:00.000Z", payload: { type: "task_started", turn_id: preBoundaryTurnId } },
    );
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });

    const staleSessionId = "019f4444-4444-7444-8444-444444444444";
    const staleTurnId = "019f5555-5555-7555-8555-555555555555";
    const stalePath = join(codexDirectory, `rollout-2026-07-21T02-02-30-${staleSessionId}.jsonl`);
    writeFileSync(stalePath, `${[
      { type: "session_meta", timestamp: "2026-07-21T02:02:30.000Z", payload: { id: staleSessionId, cwd: codexCwd } },
      { type: "event_msg", timestamp: "2026-07-21T02:02:31.000Z", payload: { type: "task_started", turn_id: staleTurnId } },
    ].map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const mtime = new Date();
    utimesSync(codexPath, new Date(mtime.getTime() - 1_000), new Date(mtime.getTime() - 1_000));
    utimesSync(stalePath, mtime, mtime);
    assert.equal(terminalControl.discoverActiveAgentSource({
      provider: "codex", cwd: codexCwd, home: root,
    }).sessionId, staleSessionId);

    const startedAtNotBefore = "2026-07-21T02:03:00.000Z";
    assert.throws(
      () => terminalControl.discoverActiveAgentSource({
        provider: "codex",
        cwd: codexCwd,
        home: root,
        sessionId: codexSessionId,
        startedAtNotBefore,
      }),
      (error) => error.code === "RESOURCE_EXHAUSTED" && error.retryable === true,
    );
    codexRows.push({
      type: "event_msg",
      timestamp: "2026-07-21T02:03:00.001Z",
      payload: {
        type: "item_completed",
        turn_id: preBoundaryTurnId,
        item: { type: "UserMessage", content: [{ type: "text", text: "mobile input" }] },
      },
    });
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    assert.equal(terminalControl.discoverActiveAgentSource({
      provider: "codex",
      cwd: codexCwd,
      home: root,
      sessionId: codexSessionId,
      startedAtNotBefore,
      expectedUserMessage: "mobile input",
    }).turnId, preBoundaryTurnId);
    codexRows.push({
      type: "event_msg",
      timestamp: "2026-07-21T02:03:00.002Z",
      payload: { type: "task_complete", turn_id: preBoundaryTurnId, last_agent_message: "done" },
    });
    const freshTurnId = "019f6666-6666-7666-8666-666666666666";
    codexRows.push(
      { type: "event_msg", timestamp: "2026-07-21T02:03:01.000Z", payload: { type: "task_started", turn_id: freshTurnId } },
    );
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const freshSource = terminalControl.discoverActiveAgentSource({
      provider: "codex",
      cwd: codexCwd,
      home: root,
      sessionId: codexSessionId,
      startedAtNotBefore,
    });
    assert.equal(freshSource.sessionId, codexSessionId);
    assert.equal(freshSource.turnId, freshTurnId);
    codexRows.push(
      { type: "event_msg", timestamp: "2026-07-21T02:03:02.000Z", payload: { type: "task_complete", turn_id: freshTurnId, last_agent_message: "fresh answer" } },
    );

    const unauthorizedTurnId = "019f7777-7777-7777-8777-777777777777";
    codexRows.push(
      { type: "event_msg", timestamp: "2026-07-21T02:04:00.000Z", payload: { type: "task_started", turn_id: unauthorizedTurnId } },
    );
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const unauthorizedSource = terminalControl.discoverActiveAgentSource({
      provider: "codex",
      cwd: codexCwd,
      home: root,
      sessionId: codexSessionId,
      startedAtNotBefore: "2026-07-21T02:04:00.000Z",
    });
    codexRows.push({
      type: "event_msg",
      timestamp: "2026-07-21T02:04:01.000Z",
      payload: {
        type: "task_complete",
        turn_id: unauthorizedTurnId,
        last_agent_message: null,
        error: {
          message: "sensitive provider authentication detail",
          codex_error_info: "unauthorized",
        },
      },
    });
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    assert.throws(
      () => terminalControl.readCompletedAgentResult({
        source: unauthorizedSource, cwd: codexCwd, home: root, maxBytes: 1024,
      }),
      (error) => error.code === "PERMISSION_DENIED"
        && error.message === "Agent authentication is required",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex discovery ignores unrelated oversized transcripts and parses the target bounded tail", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-agent-transcript-window-"));
  const codexDirectory = join(root, ".codex", "sessions", "2026", "07", "23");
  const cwd = join(root, "target-worktree");
  const sessionId = "019f3333-3333-7333-8333-333333333333";
  const turnId = "019f4444-4444-7444-8444-444444444444";
  const targetPath = join(
    codexDirectory,
    `rollout-2026-07-23T01-00-00-${sessionId}.jsonl`,
  );
  const unrelatedPath = join(
    codexDirectory,
    "rollout-2026-07-23T02-00-00-019f5555-5555-7555-8555-555555555555.jsonl",
  );
  try {
    mkdirSync(codexDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-23T01:00:00.000Z",
      payload: { id: sessionId, cwd },
    })}\n`, { mode: 0o600 });
    truncateSync(targetPath, 65 * 1024 * 1024);
    appendFileSync(targetPath, `\n${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-23T01:00:01.000Z",
      payload: { type: "task_started", turn_id: turnId },
    })}\n`);

    writeFileSync(unrelatedPath, `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-23T02:00:00.000Z",
      payload: {
        id: "019f5555-5555-7555-8555-555555555555",
        cwd: join(root, "other-worktree"),
      },
    })}\n`, { mode: 0o600 });
    truncateSync(unrelatedPath, 66 * 1024 * 1024);
    const now = new Date();
    utimesSync(targetPath, new Date(now.getTime() - 2_000), new Date(now.getTime() - 2_000));
    utimesSync(unrelatedPath, now, now);

    const source = terminalControl.discoverActiveAgentSource({
      provider: "codex", cwd, home: root,
    });
    assert.equal(source.sessionId, sessionId);
    assert.equal(source.turnId, turnId);

    appendFileSync(targetPath, `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-23T01:01:00.000Z",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        last_agent_message: "Oversized Codex final answer",
      },
    })}\n`);
    assert.equal(terminalControl.readCompletedAgentResult({
      source, cwd, home: root, maxBytes: 1024,
    }).text, "Oversized Codex final answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
