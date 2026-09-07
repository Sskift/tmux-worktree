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

test("production backend fails closed when managed state has duplicate session identities", async () => {
  const temp = tempState();
  const home = join(temp.root, "home");
  const twHome = join(home, ".tmux-worktree");
  const previousHome = process.env.HOME;
  mkdirSync(twHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(twHome, "state.json"), `${JSON.stringify({
    version: 1,
    sessions: [
      {
        name: "duplicate",
        kind: "terminal",
        profile: "dashboard",
        cwd: temp.root,
        createdAt: "2026-07-13T00:00:00.000Z",
      },
      {
        name: "duplicate",
        kind: "worktree",
        profile: "cli",
        project: "project",
        repoPath: temp.root,
        worktreePath: join(temp.root, "worktree"),
        branch: "duplicate",
        baseBranch: "master",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ],
  })}\n`, { mode: 0o600 });
  process.env.HOME = home;
  try {
    const backend = new terminalControl.TmuxTerminalControlBackend();
    await assert.rejects(
      backend.resolveManagedSession("duplicate"),
      (error) => error.code === "RECOVERY_REQUIRED" && /ambiguous session identity/.test(error.message),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    temp.cleanup();
  }
});

test("production backend seeds an existing pane before live Relay v2 input", async (t) => {
  const harness = isolatedManagedTmux(t, "relay-v2-initial-pane");
  if (!harness) return;
  const existingMarker = "__relay_v2_existing_prompt__";
  const inputMarker = "__relay_v2_input_reached_tmux__";
  try {
    const sendExisting = spawnSync(
      harness.wrapper,
      [
        "send-keys",
        "-t",
        harness.sessionName,
        `printf '${existingMarker}\\n'`,
        "C-m",
      ],
      { encoding: "utf8" },
    );
    assert.equal(sendExisting.status, 0, sendExisting.stderr);
    const visibleDeadline = Date.now() + 2_000;
    let visible = "";
    while (!visible.includes(existingMarker) && Date.now() < visibleDeadline) {
      const captured = spawnSync(
        harness.wrapper,
        ["capture-pane", "-p", "-t", harness.sessionName],
        { encoding: "utf8" },
      );
      assert.equal(captured.status, 0, captured.stderr);
      visible = captured.stdout;
      if (!visible.includes(existingMarker)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.match(visible, new RegExp(existingMarker));

    const backend = new terminalControl.TmuxTerminalControlBackend();
    const resolvedBackend = await backend.resolveManagedSession(harness.sessionName);
    const controlTargetId = randomUUID();
    const generation = randomUUID();
    const emptyGeneration = await backend.prepareOutput(
      controlTargetId,
      harness.sessionName,
      "0",
      generation,
      false,
    );
    assert.equal(emptyGeneration.generation, generation);
    assert.equal(emptyGeneration.cursor, 0);

    // A previous controller can leave a valid live pipe whose generation is
    // nevertheless empty.  Opening an exact phone observation explicitly
    // requests a pane capture and must repair that state immediately.
    const opened = await backend.prepareOutput(
      controlTargetId,
      harness.sessionName,
      "0",
      generation,
      true,
    );
    assert.notEqual(opened.generation, generation);
    assert.equal(opened.retainedStartCursor, 0);
    assert.ok(opened.cursor > 0, "the initial generation must contain the rendered pane");
    const initial = await backend.tailOutput(
      controlTargetId,
      harness.sessionName,
      "0",
      opened.generation,
      opened.retainedStartCursor,
      64 * 1024,
    );
    assert.match(
      Buffer.from(initial.dataBase64, "base64").toString("utf8"),
      new RegExp(existingMarker),
    );

    await backend.writeRawFenced(
      resolvedBackend.managedSession,
      resolvedBackend.tmuxInstanceId,
      opened.generation,
      "0",
      Buffer.from(`printf '${inputMarker}\\n'\r`, "utf8"),
    );
    let cursor = opened.cursor;
    let live = "";
    const inputDeadline = Date.now() + 2_000;
    while (!live.includes(inputMarker) && Date.now() < inputDeadline) {
      const chunk = await backend.tailOutput(
        controlTargetId,
        harness.sessionName,
        "0",
        opened.generation,
        cursor,
        64 * 1024,
      );
      cursor = chunk.nextCursor;
      live += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      if (!chunk.dataBase64) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(live, new RegExp(inputMarker));

    // Relay v2 closes the last observation by rotating the output generation. A phone that
    // re-enters the same terminal must receive the current pane again instead of observing an
    // empty generation until the next command happens to produce output.
    const reset = await backend.resetOutput(
      controlTargetId,
      harness.sessionName,
      "0",
      opened.generation,
    );
    assert.notEqual(reset.generation, opened.generation);
    assert.equal(reset.retainedStartCursor, 0);
    assert.ok(reset.cursor > 0, "the reset generation must contain the rendered pane");
    const resetInitial = await backend.tailOutput(
      controlTargetId,
      harness.sessionName,
      "0",
      reset.generation,
      reset.retainedStartCursor,
      64 * 1024,
    );
    assert.match(
      Buffer.from(resetInitial.dataBase64, "base64").toString("utf8"),
      new RegExp(inputMarker),
    );
  } finally {
    await harness.cleanup();
  }
});

test("production Agent paste brackets one complete composer edit before submit", async (t) => {
  const harness = isolatedManagedTmux(t, "agent-bracketed-paste");
  if (!harness) return;
  const appPath = join(harness.temp.root, "fake-agent-paste.cjs");
  const eventsPath = join(harness.temp.root, "agent-paste-events.jsonl");
  const paneTarget = `=${harness.sessionName}:`;
  const rawMessage = "reply ruby";
  const bracketedMessage = "reply topaz";
  const readEvents = () => {
    if (!existsSync(eventsPath)) return [];
    const contents = readFileSync(eventsPath, "utf8").trim();
    return contents ? contents.split("\n").map((line) => JSON.parse(line)) : [];
  };
  const waitForEvents = async (count) => {
    const deadline = Date.now() + 2_000;
    let events = readEvents();
    while (events.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events = readEvents();
    }
    return events;
  };
  try {
    writeFileSync(eventsPath, "", { mode: 0o600 });
    writeFileSync(appPath, [
      'const { appendFileSync } = require("node:fs")',
      `const eventsPath = ${JSON.stringify(eventsPath)}`,
      'const bracketStart = "\\x1b[200~"',
      'const bracketEnd = "\\x1b[201~"',
      'let wire = ""',
      'let body = ""',
      'let bracketed = false',
      'let explicitPasteReady = false',
      'let rawEnterSuppressed = false',
      'const record = (event) => appendFileSync(eventsPath, `${JSON.stringify(event)}\\n`)',
      'const resetBody = () => { body = ""; explicitPasteReady = false }',
      'const consume = () => {',
      '  while (wire.length > 0) {',
      '    if (!bracketed && wire.startsWith(bracketStart)) {',
      '      bracketed = true',
      '      wire = wire.slice(bracketStart.length)',
      '      continue',
      '    }',
      '    if (bracketed && wire.startsWith(bracketEnd)) {',
      '      bracketed = false',
      '      explicitPasteReady = true',
      '      wire = wire.slice(bracketEnd.length)',
      '      continue',
      '    }',
      '    if (wire.charCodeAt(0) === 27',
      '      && (bracketStart.startsWith(wire) || bracketEnd.startsWith(wire))) return',
      '    const ch = wire[0]',
      '    wire = wire.slice(1)',
      '    if (ch !== "\\r") { body += ch; continue }',
      '    if (explicitPasteReady) {',
      '      record({ kind: "submitted", mode: "bracketed", body })',
      '      resetBody()',
      '      continue',
      '    }',
      '    if (!rawEnterSuppressed) {',
      '      rawEnterSuppressed = true',
      '      record({ kind: "suppressed", mode: "raw", body })',
      '      continue',
      '    }',
      '    record({ kind: "submitted", mode: "raw", body: body.slice(0, -1) })',
      '    resetBody()',
      '  }',
      '}',
      'process.stdin.setRawMode(true)',
      'process.stdin.resume()',
      'process.stdin.on("data", (chunk) => { wire += chunk.toString("latin1"); consume() })',
      'process.stdout.write("\\x1b[?2004hFAKE_AGENT_READY\\n")',
      'setInterval(() => {}, 1000)',
    ].join("\n"), { mode: 0o600 });

    const started = spawnSync(harness.wrapper, [
      "respawn-pane",
      "-k",
      "-t", paneTarget,
      `${shellSingleQuote(process.execPath)} ${shellSingleQuote(appPath)}`,
    ], { encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    let ready = "";
    const readyDeadline = Date.now() + 2_000;
    while (!ready.includes("FAKE_AGENT_READY") && Date.now() < readyDeadline) {
      const captured = spawnSync(
        harness.wrapper,
        ["capture-pane", "-p", "-t", paneTarget],
        { encoding: "utf8" },
      );
      assert.equal(captured.status, 0, captured.stderr);
      ready = captured.stdout;
      if (!ready.includes("FAKE_AGENT_READY")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.match(ready, /FAKE_AGENT_READY/);

    // Model the Codex fallback path that motivated this regression: without
    // bracketed framing a rapid character stream can suppress the first Enter,
    // then a later retry can submit a body whose tail was not committed.
    const rawBuffer = `raw-agent-${randomUUID()}`;
    const rawPaste = spawnSync(harness.wrapper, [
      "load-buffer", "-b", rawBuffer, "-",
      ";", "paste-buffer", "-b", rawBuffer, "-d", "-r", "-t", paneTarget,
    ], { input: rawMessage, encoding: "utf8" });
    assert.equal(rawPaste.status, 0, rawPaste.stderr);
    const firstRawSubmit = spawnSync(
      harness.wrapper,
      ["send-keys", "-t", paneTarget, "C-m"],
      { encoding: "utf8" },
    );
    assert.equal(firstRawSubmit.status, 0, firstRawSubmit.stderr);
    let events = await waitForEvents(1);
    assert.deepEqual(events[0], { kind: "suppressed", mode: "raw", body: rawMessage });
    const retriedRawSubmit = spawnSync(
      harness.wrapper,
      ["send-keys", "-t", paneTarget, "C-m"],
      { encoding: "utf8" },
    );
    assert.equal(retriedRawSubmit.status, 0, retriedRawSubmit.stderr);
    events = await waitForEvents(2);
    assert.deepEqual(events[1], {
      kind: "submitted",
      mode: "raw",
      body: rawMessage.slice(0, -1),
    });

    const backend = new terminalControl.TmuxTerminalControlBackend();
    await backend.sendAgentMessage(harness.sessionName, "0", bracketedMessage, true);
    events = await waitForEvents(3);
    assert.deepEqual(events[2], {
      kind: "submitted",
      mode: "bracketed",
      body: bracketedMessage,
    });
    assert.equal(
      events.filter((event) => event.kind === "submitted" && event.mode === "bracketed").length,
      1,
      "one Agent operation must produce one exact bracketed submission",
    );
  } finally {
    await harness.cleanup();
  }
});

test("cold-resumed Agent input accepts a turn that completes before transcript polling", async (t) => {
  const harness = isolatedManagedTmux(t, "agent-submit-retry");
  if (!harness) return;
  const agentBin = join(harness.home, ".local", "bin");
  const transcriptRoot = join(harness.home, ".codex", "sessions", "2026", "07", "13");
  const sessionId = "019f5555-5555-7555-8555-555555555555";
  const transcriptPath = join(
    transcriptRoot,
    `rollout-2026-07-13T00-00-00-${sessionId}.jsonl`,
  );
  const appPath = join(harness.temp.root, "fake-codex.cjs");
  const paneCwd = realpathSync(harness.temp.root);
  const message = "confirm submit after startup";
  const paneTarget = `=${harness.sessionName}:`;
  try {
    mkdirSync(agentBin, { recursive: true, mode: 0o700 });
    mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
    symlinkSync(process.execPath, join(agentBin, "codex-agent-marker"));
    writeFileSync(transcriptPath, `${JSON.stringify({
      timestamp: "2026-07-13T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: paneCwd },
    })}\n`, { mode: 0o600 });
    writeFileSync(appPath, [
      'const { appendFileSync } = require("node:fs")',
      `const transcript = ${JSON.stringify(transcriptPath)}`,
      `const expected = ${JSON.stringify(message)}`,
      "let body = ''",
      "let submits = 0",
      "let accepted = false",
      "process.stdin.setRawMode(true)",
      "process.stdin.resume()",
      'process.stdout.write("\\x1b]2;Codex\\x07FAKE_CODEX_READY\\n")',
      "process.stdin.on('data', (chunk) => {",
      "  for (const byte of chunk) {",
      "    if (byte !== 13) { body += Buffer.from([byte]).toString('utf8'); continue }",
      "    submits += 1",
      "    if (accepted || submits < 3 || body !== expected) continue",
      "    accepted = true",
      "    const timestamp = new Date().toISOString()",
      "    const turnId = '019f6666-6666-7666-8666-666666666666'",
      "    const rows = [",
      "      { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },",
      "      { timestamp, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text: expected }] } } },",
      "      { timestamp, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'AgentMessage', content: [{ type: 'text', text: 'FAST-ACK' }] } } },",
      "      { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'FAST-ACK' } },",
      "    ]",
      "    appendFileSync(transcript, rows.map(JSON.stringify).join('\\n') + '\\n')",
      "    process.stdout.write('\\x1b]2;Codex\\x07AGENT_TURN_CONFIRMED\\n')",
      "  }",
      "})",
      "setInterval(() => {}, 1000)",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(agentBin, "codex"), [
      "#!/bin/sh",
      `marker=${shellSingleQuote(join(agentBin, "codex-agent-marker"))}`,
      `app=${shellSingleQuote(appPath)}`,
      '"$marker" -e "setInterval(() => {}, 1000)" &',
      "marker_pid=$!",
      'trap \'kill "$marker_pid" >/dev/null 2>&1 || true\' EXIT INT TERM',
      '"$marker" "$app"',
    ].join("\n") + "\n", { mode: 0o700 });

    const keepFailedPane = spawnSync(
      harness.wrapper,
      ["set-option", "-t", harness.sessionName, "remain-on-exit", "on"],
      { encoding: "utf8" },
    );
    assert.equal(keepFailedPane.status, 0, keepFailedPane.stderr);
    const started = spawnSync(harness.wrapper, [
      "respawn-pane",
      "-k",
      "-t", paneTarget,
      "-c", harness.temp.root,
      `PATH=${shellSingleQuote(agentBin)}:$PATH codex`,
    ], { encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    let ready = "";
    const readyDeadline = Date.now() + 2_000;
    while (!ready.includes("FAKE_CODEX_READY") && Date.now() < readyDeadline) {
      const captured = spawnSync(
        harness.wrapper,
        ["capture-pane", "-p", "-t", paneTarget],
        { encoding: "utf8" },
      );
      assert.equal(captured.status, 0, captured.stderr);
      ready = captured.stdout;
      if (!ready.includes("FAKE_CODEX_READY")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.match(ready, /FAKE_CODEX_READY/);

    const backend = new terminalControl.TmuxTerminalControlBackend();
    const resolvedBackend = await backend.resolveManagedSession(harness.sessionName);
    const output = await backend.prepareOutput(
      randomUUID(),
      harness.sessionName,
      "0",
      randomUUID(),
      true,
    );
    await backend.sendAgentMessageFenced(
      resolvedBackend.managedSession,
      resolvedBackend.tmuxInstanceId,
      output.generation,
      "0",
      message,
      true,
    );
    const records = readFileSync(transcriptPath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.payload?.type === "task_started").length, 1);
    assert.equal(records.filter((record) => record.payload?.type === "task_complete").length, 1);
    assert.equal(
      records.find((record) => record.payload?.type === "item_completed")
        ?.payload.item.content[0].text,
      message,
    );
  } finally {
    await harness.cleanup();
  }
});

test("cold-resumed Agent input excludes hydration and binds a delayed transcript", async (t) => {
  const harness = isolatedManagedTmux(t, "agent-delayed-transcript");
  if (!harness) return;
  const agentBin = join(harness.home, ".local", "bin");
  const transcriptRoot = join(harness.home, ".codex", "sessions", "2026", "07", "14");
  const sessionId = "019f7777-7777-7777-8777-777777777777";
  const transcriptPath = join(
    transcriptRoot,
    `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`,
  );
  const appPath = join(harness.temp.root, "fake-delayed-codex.cjs");
  const slowShell = join(harness.temp.root, "slow-login-shell");
  const paneCwd = realpathSync(harness.temp.root);
  const message = "confirm delayed cold resume";
  const paneTarget = `=${harness.sessionName}:`;
  const previousShell = process.env.SHELL;
  try {
    mkdirSync(agentBin, { recursive: true, mode: 0o700 });
    mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
    symlinkSync(process.execPath, join(agentBin, "codex-agent-marker"));
    writeFileSync(transcriptPath, `${JSON.stringify({
      timestamp: "2026-07-14T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: paneCwd },
    })}\n`, { mode: 0o600 });
    writeFileSync(appPath, [
      'const { appendFileSync } = require("node:fs")',
      `const transcript = ${JSON.stringify(transcriptPath)}`,
      `const expected = ${JSON.stringify(message)}`,
      "let body = ''",
      "let scheduled = false",
      "process.stdin.setRawMode(true)",
      "process.stdin.resume()",
      'process.stdout.write("\\x1b]2;Codex\\x07FAKE_DELAYED_CODEX_READY\\n")',
      "process.stdin.on('data', (chunk) => {",
      "  for (const byte of chunk) {",
      "    if (byte !== 13) { body += Buffer.from([byte]).toString('utf8'); continue }",
      "    if (scheduled || body !== expected) continue",
      "    scheduled = true",
      "    setTimeout(() => {",
      "      const timestamp = new Date().toISOString()",
      "      const turnId = '019f8888-8888-7888-8888-888888888888'",
      "      const rows = [",
      "        { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },",
      "        { timestamp, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text: expected }] } } },",
      "        { timestamp, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'AgentMessage', content: [{ type: 'text', text: 'DELAYED-ACK' }] } } },",
      "        { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'DELAYED-ACK' } },",
      "      ]",
      "      appendFileSync(transcript, rows.map(JSON.stringify).join('\\n') + '\\n')",
      "    }, 1200)",
      "  }",
      "})",
      "setInterval(() => {}, 1000)",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(agentBin, "codex"), [
      "#!/bin/sh",
      `marker=${shellSingleQuote(join(agentBin, "codex-agent-marker"))}`,
      `app=${shellSingleQuote(appPath)}`,
      '"$marker" -e "setInterval(() => {}, 1000)" &',
      "marker_pid=$!",
      'trap \'kill "$marker_pid" >/dev/null 2>&1 || true\' EXIT INT TERM',
      '"$marker" "$app"',
    ].join("\n") + "\n", { mode: 0o700 });
    writeFileSync(slowShell, [
      "#!/bin/sh",
      "sleep 1.2",
      "printf '\\0'",
      "env -0",
    ].join("\n") + "\n", { mode: 0o700 });

    const started = spawnSync(harness.wrapper, [
      "respawn-pane",
      "-k",
      "-t", paneTarget,
      "-c", harness.temp.root,
      `PATH=${shellSingleQuote(agentBin)}:$PATH codex`,
    ], { encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    let ready = "";
    const readyDeadline = Date.now() + 2_000;
    while (!ready.includes("FAKE_DELAYED_CODEX_READY") && Date.now() < readyDeadline) {
      const captured = spawnSync(
        harness.wrapper,
        ["capture-pane", "-p", "-t", paneTarget],
        { encoding: "utf8" },
      );
      assert.equal(captured.status, 0, captured.stderr);
      ready = captured.stdout;
      if (!ready.includes("FAKE_DELAYED_CODEX_READY")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.match(ready, /FAKE_DELAYED_CODEX_READY/);

    process.env.SHELL = slowShell;
    void terminalControl.inheritCodexResumeEnvironmentFromLoginShellAsync();
    const backend = new terminalControl.TmuxTerminalControlBackend({
      agentResumeInputTimeoutMs: 800,
    });
    const resolvedBackend = await backend.resolveManagedSession(harness.sessionName);
    const output = await backend.prepareOutput(
      randomUUID(),
      harness.sessionName,
      "0",
      randomUUID(),
      true,
    );
    const submittedAt = Date.now();
    await backend.sendAgentMessageFenced(
      resolvedBackend.managedSession,
      resolvedBackend.tmuxInstanceId,
      output.generation,
      "0",
      message,
      true,
    );
    assert.ok(
      Date.now() - submittedAt >= 1_100,
      "the backend waits for hydration before starting the input budget",
    );
    assert.equal(
      readFileSync(transcriptPath, "utf8").includes("DELAYED-ACK"),
      false,
      "the exact tmux submission is accepted before delayed transcript publication",
    );

    const publicationDeadline = Date.now() + 2_000;
    while (!readFileSync(transcriptPath, "utf8").includes("DELAYED-ACK")
      && Date.now() < publicationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = await backend.agentStatus(
      resolvedBackend.managedSession,
      resolvedBackend.tmuxInstanceId,
      output.generation,
      "0",
    );
    assert.equal(status.agentRunning, true);
    assert.equal(status.source?.turnId, "019f8888-8888-7888-8888-888888888888");
    const settled = await backend.agentStatus(
      resolvedBackend.managedSession,
      resolvedBackend.tmuxInstanceId,
      output.generation,
      "0",
    );
    assert.equal(
      settled.agentRunning,
      false,
      "the correlated boundary is consumed instead of replaying a completed source forever",
    );
    const result = await backend.agentResult(
      resolvedBackend.managedSession,
      resolvedBackend.tmuxInstanceId,
      output.generation,
      "0",
      status.source,
      terminalControl.TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES,
    );
    assert.equal(result.text, "DELAYED-ACK");
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    await harness.cleanup();
  }
});

test("production backend resumes a full legacy capture without explicit recovery", async (t) => {
  const harness = isolatedManagedTmux(t, "legacy-capture");
  if (!harness) return;
  const legacyBytes = 8 * 1024 * 1024;
  const controlTargetId = randomUUID();
  const outputGeneration = "legacy-output-generation-1";
  try {
    const backend = new terminalControl.TmuxTerminalControlBackend();
    const resolvedBackend = await backend.resolveManagedSession(harness.sessionName);
    const state = terminalControl.emptyTerminalControlState();
    state.targets.push({
      controlTargetId,
      lifecycle: "ACTIVE",
      managedSession: {
        name: harness.sessionName,
        kind: "terminal",
        createdAt: harness.createdAt,
      },
      backend: {
        kind: "tmux",
        tmuxInstanceId: resolvedBackend.tmuxInstanceId,
      },
      outputGeneration,
      ownership: { state: "FREE", fence: "0" },
      revision: "1",
      completedOperations: [],
      updatedAt: harness.createdAt,
    });
    terminalControl.saveTerminalControlState(state, harness.temp.path);

    const targetDirectory = installFullLegacyCapture(
      harness,
      controlTargetId,
      outputGeneration,
      legacyBytes,
    );

    const authority = new terminalControl.TerminalControlAuthority({
      statePath: harness.temp.path,
      backend,
    });
    const opened = await authority.handle({
      protocolVersion: 1,
      requestId: "legacy-open",
      type: "ownership.status",
      controlTargetId,
    });
    assert.equal(opened.state, "FREE");
    assert.notEqual(opened.outputGeneration, outputGeneration);
    assert.ok(opened.outputCursor > 0, "legacy rotation must seed the current pane");
    const currentGeneration = opened.outputGeneration;

    const dashboard = await acquired(
      authority,
      controlTargetId,
      owner("dashboard", "legacy-open:pty-1"),
    );
    const marker = "TW_LEGACY_CAPTURE_CONTINUED";
    const accepted = await authority.handle(rawRequest(
      dashboard.lease,
      "legacy-continue-input",
      `printf '${marker}\\n'\r`,
    ));
    assert.equal(accepted.outputGeneration, currentGeneration);
    let cursor = accepted.outputCursor;
    let observed = "";
    const deadline = Date.now() + 3_000;
    while (!observed.includes(marker) && Date.now() < deadline) {
      const chunk = await authority.handle({
        protocolVersion: 1,
        requestId: `legacy-continue-tail-${cursor}`,
        type: "output.tail",
        controlTargetId,
        controlEpoch: accepted.controlEpoch,
        outputGeneration: currentGeneration,
        cursor,
        maxBytes: 4096,
      });
      cursor = chunk.nextCursor;
      observed += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      if (!chunk.dataBase64) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(observed, new RegExp(marker));
    const healthy = await authority.handle({
      protocolVersion: 1,
      requestId: "legacy-open-health",
      type: "ownership.status",
      controlTargetId,
    });
    assert.equal(healthy.state, "HELD");
    assert.equal(healthy.outputGeneration, currentGeneration);
    assert.ok(regularFileBytes(targetDirectory) < legacyBytes / 2);
  } finally {
    await harness.cleanup();
  }
});

test("production backend auto-recovers a persisted full legacy capture with no previous owner", async (t) => {
  const harness = isolatedManagedTmux(t, "legacy-ownerless-recovery");
  if (!harness) return;
  try {
    const recovery = await persistedLegacyRecovery(harness, undefined);
    const opened = await recovery.authority.handle({
      protocolVersion: 1,
      requestId: "legacy-ownerless-recovery-open",
      type: "ownership.status",
      controlTargetId: recovery.controlTargetId,
    });
    assert.equal(opened.state, "FREE");
    assert.notEqual(opened.outputGeneration, recovery.outputGeneration);
    assert.ok(opened.outputCursor > 0, "ownerless recovery must seed the current pane");
    const persisted = terminalControl.loadTerminalControlState(harness.temp.path).targets[0];
    assert.equal(persisted.lifecycle, "ACTIVE");
    assert.equal(persisted.recovery, undefined);
    assert.equal(persisted.outputGeneration, opened.outputGeneration);
    assert.ok(regularFileBytes(recovery.targetDirectory) < recovery.legacyBytes / 2);
  } finally {
    await harness.cleanup();
  }
});

test("production backend keeps a full legacy capture with a previous Feishu owner in recovery", async (t) => {
  const harness = isolatedManagedTmux(t, "legacy-feishu-recovery");
  if (!harness) return;
  try {
    const recovery = await persistedLegacyRecovery(harness, "feishu");
    const opened = await recovery.authority.handle({
      protocolVersion: 1,
      requestId: "legacy-feishu-recovery-open",
      type: "ownership.status",
      controlTargetId: recovery.controlTargetId,
    });
    assert.equal(opened.state, "RECOVERY_REQUIRED");
    assert.equal(opened.ownerKind, "feishu");
    assert.equal(opened.outputGeneration, recovery.outputGeneration);
    assert.equal(opened.outputCursor, 0);
    const persisted = terminalControl.loadTerminalControlState(harness.temp.path).targets[0];
    assert.equal(persisted.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(persisted.recovery.previousOwnerKind, "feishu");
    assert.equal(persisted.outputGeneration, recovery.outputGeneration);
    assert.equal(regularFileBytes(recovery.targetDirectory), recovery.legacyBytes);
  } finally {
    await harness.cleanup();
  }
});

test("production backend fails closed when a held capture pipe disappears", async (t) => {
  const harness = isolatedManagedTmux(t, "missing-held-capture");
  if (!harness) return;
  try {
    const authority = new terminalControl.TerminalControlAuthority({
      statePath: harness.temp.path,
      backend: new terminalControl.TmuxTerminalControlBackend(),
    });
    const target = await resolved(authority, harness.sessionName);
    const feishu = await acquired(
      authority,
      target.controlTargetId,
      owner("feishu", "missing-capture:binding-1"),
    );
    const generation = feishu.ownership.outputGeneration;
    const cursor = feishu.ownership.outputCursor;
    const activePipe = spawnSync(
      harness.wrapper,
      ["display-message", "-p", "-t", harness.sessionName, "#{pane_pipe}"],
      { encoding: "utf8" },
    );
    assert.equal(activePipe.stdout.trim(), "1");
    const detached = spawnSync(
      harness.wrapper,
      ["pipe-pane", "-t", harness.sessionName],
      { encoding: "utf8" },
    );
    assert.equal(detached.status, 0, detached.stderr);
    const uncaptured = spawnSync(
      harness.wrapper,
      ["send-keys", "-t", harness.sessionName, "printf 'uncaptured-gap\\n'", "C-m"],
      { encoding: "utf8" },
    );
    assert.equal(uncaptured.status, 0, uncaptured.stderr);

    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "missing-held-capture-status",
        type: "ownership.status",
        controlTargetId: target.controlTargetId,
      }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const persisted = terminalControl.loadTerminalControlState(harness.temp.path).targets[0];
    assert.equal(persisted.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(persisted.recovery.reason, "OUTPUT_CONTINUITY_UNCERTAIN");
    const recovery = await authority.handle({
      protocolVersion: 1,
      requestId: "missing-held-capture-recovery-view",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(recovery.state, "RECOVERY_REQUIRED");
    assert.equal(recovery.ownerKind, "feishu");
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "missing-held-capture-tail",
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: target.controlEpoch,
        outputGeneration: generation,
        cursor,
        maxBytes: 4096,
      }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
  } finally {
    await harness.cleanup();
  }
});

test("explicit recovery resumes only its exact planned output generation after interruption", async (t) => {
  const harness = isolatedManagedTmux(t, "planned-generation-recovery");
  if (!harness) return;
  try {
    const tmux = (...args) => {
      const result = spawnSync(harness.wrapper, args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const setGeneration = (generation) => tmux(
      "set-option",
      "-t",
      harness.sessionName,
      "@tw_terminal_control_output_generation_v1",
      generation,
    );
    const captureState = () => tmux(
      "display-message",
      "-p",
      "-t",
      harness.sessionName,
      "#{@tw_terminal_control_output_generation_v1}\u001f#{pane_pipe}",
    ).split("\u001f");
    class InterruptingRecoveryBackend extends terminalControl.TmuxTerminalControlBackend {
      interrupted = false;
      plannedGeneration = undefined;

      async recoverOutput(...args) {
        const output = await super.recoverOutput(...args);
        this.plannedGeneration = output.generation;
        if (!this.interrupted) {
          this.interrupted = true;
          throw new Error("injected interruption after output recovery");
        }
        return output;
      }
    }
    const backend = new InterruptingRecoveryBackend();
    const authority = new terminalControl.TerminalControlAuthority({
      statePath: harness.temp.path,
      backend,
    });
    const target = await resolved(authority, harness.sessionName);
    await acquired(
      authority,
      target.controlTargetId,
      owner("feishu", "planned-generation:binding-1"),
    );
    tmux("pipe-pane", "-t", harness.sessionName);
    setGeneration("interrupted-generation-outside-authority");

    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "planned-generation-status",
        type: "ownership.status",
        controlTargetId: target.controlTargetId,
      }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const recoveryState = terminalControl.loadTerminalControlState(harness.temp.path);
    assert.equal(recoveryState.targets[0].recovery.reason, "OUTPUT_CONTINUITY_UNCERTAIN");
    const forceRequest = (expectedControlEpoch, requestId) => ({
      protocolVersion: 1,
      requestId,
      type: "handoff.force",
      controlTargetId: target.controlTargetId,
      expectedControlEpoch,
      nextOwner: owner("dashboard", "planned-generation:pty-1"),
      proof: {
        kind: "operator-acknowledged-in-doubt",
        recordId: requestId,
        recordedAt: new Date().toISOString(),
      },
      acknowledgeUncertainOperation: true,
    });

    await assert.rejects(
      authority.handle(forceRequest(recoveryState.controlEpoch, "planned-generation-interrupted")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.ok(backend.plannedGeneration);
    assert.deepEqual(captureState(), [backend.plannedGeneration, "1"]);
    assert.deepEqual(
      terminalControl.loadTerminalControlState(harness.temp.path).targets[0],
      recoveryState.targets[0],
    );

    const restarted = new terminalControl.TerminalControlAuthority({ statePath: harness.temp.path, backend });
    const restartedEpoch = await restarted.initializeContinuity();
    const recovered = await restarted.handle(
      forceRequest(restartedEpoch, "planned-generation-resumed"),
    );
    assert.equal(recovered.ownership.state, "HELD");
    assert.equal(recovered.ownership.ownerKind, "dashboard");
    assert.equal(recovered.ownership.outputGeneration, backend.plannedGeneration);
    assert.deepEqual(captureState(), [backend.plannedGeneration, "1"]);

    setGeneration("unrelated-active-generation");
    await assert.rejects(
      restarted.handle({
        protocolVersion: 1,
        requestId: "unrelated-generation-status",
        type: "ownership.status",
        controlTargetId: target.controlTargetId,
      }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const unrelatedState = terminalControl.loadTerminalControlState(harness.temp.path);
    await assert.rejects(
      restarted.handle(forceRequest(unrelatedState.controlEpoch, "unrelated-generation-force")),
      (error) => error.code === "RECOVERY_REQUIRED"
        && /generation changed outside the recovery transaction/.test(error.message),
    );
    assert.deepEqual(
      terminalControl.loadTerminalControlState(harness.temp.path).targets[0],
      unrelatedState.targets[0],
    );
    assert.deepEqual(captureState(), ["unrelated-active-generation", "1"]);
  } finally {
    await harness.cleanup();
  }
});

test("production capture rolls over with an absolute cursor and garbage-collects old generations", async (t) => {
  const harness = isolatedManagedTmux(t, "rolling-capture");
  if (!harness) return;
  const retainedLimit = 8 * 1024 * 1024;
  const emittedBytes = 9 * 1024 * 1024;
  try {
    const backend = new terminalControl.TmuxTerminalControlBackend();
    const authority = new terminalControl.TerminalControlAuthority({
      statePath: harness.temp.path,
      backend,
    });
    const target = await resolved(authority, harness.sessionName);
    const feishu = await acquired(
      authority,
      target.controlTargetId,
      owner("feishu", "ring:binding-1"),
    );
    const marker = "TW_RING_CAPTURE_TAIL";
    const script = `process.stdout.write("x".repeat(${emittedBytes}));process.stdout.write("\\n${marker}\\n")`;
    const accepted = await authority.handle(rawRequest(
      feishu.lease,
      "ring-output-input",
      `${shellSingleQuote(process.execPath)} -e ${shellSingleQuote(script)}\r`,
    ));
    const originalGeneration = accepted.outputGeneration;
    const originalCursor = accepted.outputCursor;
    let healthy;
    let tail = "";
    const deadline = Date.now() + 10_000;
    while (!tail.includes(marker) && Date.now() < deadline) {
      healthy = await authority.handle({
        protocolVersion: 1,
        requestId: `ring-health-${Date.now()}`,
        type: "ownership.status",
        controlTargetId: target.controlTargetId,
      });
      assert.equal(healthy.state, "HELD");
      assert.equal(healthy.outputGeneration, originalGeneration);
      const cursor = Math.max(originalCursor, healthy.outputCursor - 4096);
      let chunk;
      try {
        chunk = await authority.handle({
          protocolVersion: 1,
          requestId: `ring-tail-${healthy.outputCursor}`,
          type: "output.tail",
          controlTargetId: target.controlTargetId,
          controlEpoch: accepted.controlEpoch,
          outputGeneration: originalGeneration,
          cursor,
          maxBytes: 4096,
        });
      } catch (error) {
        if (error?.code === "STALE_OUTPUT_CURSOR") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        throw error;
      }
      tail = Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      if (!tail.includes(marker)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(healthy.outputCursor >= originalCursor + emittedBytes, String(healthy.outputCursor));
    assert.equal(healthy.outputGeneration, originalGeneration);
    assert.match(tail, new RegExp(marker));

    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "ring-stale-retained-cursor",
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: accepted.controlEpoch,
        outputGeneration: originalGeneration,
        cursor: originalCursor,
        maxBytes: 4096,
      }),
      (error) => error.code === "STALE_OUTPUT_CURSOR",
    );
    const afterStale = await authority.handle({
      protocolVersion: 1,
      requestId: "ring-health-after-stale",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(afterStale.state, "HELD");
    assert.equal(afterStale.outputGeneration, originalGeneration);

    const targetDirectory = join(harness.outputRoot, sha256Hex(target.controlTargetId));
    const retainedBytes = regularFileBytes(targetDirectory);
    assert.ok(retainedBytes <= retainedLimit, `${retainedBytes} capture bytes remain`);

    const released = await authority.handle({
      protocolVersion: 1,
      requestId: "ring-release",
      type: "lease.release",
      lease: feishu.lease,
    });
    assert.equal(released.state, "FREE");
    assert.notEqual(released.outputGeneration, originalGeneration);
    const afterGenerationReset = regularFileBytes(targetDirectory);
    assert.ok(
      afterGenerationReset < retainedBytes / 2,
      `${afterGenerationReset} bytes remain after replacing ${retainedBytes} bytes of the old generation`,
    );
  } finally {
    await harness.cleanup();
  }
});

test("production scroll delegates to an alternate-screen SGR mouse application", async (t) => {
  const harness = isolatedManagedTmux(t, "alternate-scroll");
  if (!harness) return;
  const inputPath = join(harness.temp.root, "mouse-input.bin");
  const appPath = join(harness.temp.root, "mouse-app.cjs");
  try {
    writeFileSync(appPath, [
      'const { appendFileSync } = require("node:fs")',
      "process.stdin.setRawMode(true)",
      "process.stdin.resume()",
      'process.stdout.write("\\x1b[?1049h\\x1b[?1003h\\x1b[?1006h")',
      "process.stdin.on(\"data\", (chunk) => appendFileSync(process.argv[2], chunk))",
      "setInterval(() => {}, 1000)",
    ].join(";\n"), { mode: 0o600 });
    const paneTarget = `=${harness.sessionName}:`;
    const command = [process.execPath, appPath, inputPath].map(shellSingleQuote).join(" ");
    const typed = spawnSync(
      harness.wrapper,
      ["send-keys", "-t", paneTarget, "-l", command],
      { encoding: "utf8" },
    );
    assert.equal(typed.status, 0, typed.stderr);
    const submitted = spawnSync(
      harness.wrapper,
      ["send-keys", "-t", paneTarget, "Enter"],
      { encoding: "utf8" },
    );
    assert.equal(submitted.status, 0, submitted.stderr);

    let state;
    const readyDeadline = Date.now() + 2_000;
    while (Date.now() < readyDeadline) {
      state = spawnSync(
        harness.wrapper,
        [
          "display-message",
          "-p",
          "-t",
          paneTarget,
          "#{alternate_on}\u001f#{mouse_any_flag}\u001f#{mouse_sgr_flag}\u001f#{pane_width}\u001f#{pane_height}",
        ],
        { encoding: "utf8" },
      );
      if (state.status === 0 && state.stdout.startsWith("1\u001f1\u001f1\u001f")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state?.status, 0, state?.stderr);
    const [alternateOn, mouseAny, mouseSgr, widthRaw, heightRaw] = state.stdout.trim().split("\u001f");
    assert.deepEqual([alternateOn, mouseAny, mouseSgr], ["1", "1", "1"]);
    const x = Math.ceil(Number(widthRaw) / 2);
    const y = Math.ceil(Number(heightRaw) / 2);

    const backend = new terminalControl.TmuxTerminalControlBackend();
    await backend.scroll(harness.sessionName, "0", "up", 3);
    await backend.scroll(harness.sessionName, "0", "down", 2);
    const expected = Buffer.from(
      `\x1b[<64;${x};${y}M`.repeat(3) + `\x1b[<65;${x};${y}M`.repeat(2),
      "ascii",
    );
    const inputDeadline = Date.now() + 2_000;
    while ((!existsSync(inputPath) || statSync(inputPath).size < expected.byteLength) && Date.now() < inputDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(readFileSync(inputPath), expected);
    const mode = spawnSync(
      harness.wrapper,
      ["display-message", "-p", "-t", paneTarget, "#{pane_in_mode}"],
      { encoding: "utf8" },
    );
    assert.equal(mode.status, 0, mode.stderr);
    assert.equal(mode.stdout.trim(), "0", "application scroll must not enter tmux copy-mode");
  } finally {
    await harness.cleanup();
  }
});

test("production tmux backend captures bounded correlated output on an isolated server", async (t) => {
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const temp = tempState();
  const home = join(temp.root, "home");
  const twHome = join(home, ".tmux-worktree");
  const wrapper = isolatedTmuxWrapper;
  const socketName = `tw-terminal-control-test-${process.pid}-${Date.now()}`;
  const previous = {
    HOME: process.env.HOME,
    TW_TMUX: process.env.TW_TMUX,
    TW_TERMINAL_CONTROL_OUTPUT_DIR: process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR,
  };
  mkdirSync(twHome, { recursive: true, mode: 0o700 });
  writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L ${socketName} -f /dev/null "$@"\n`, { mode: 0o700 });
  process.env.HOME = home;
  process.env.TW_TMUX = wrapper;
  process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR = join(twHome, "terminal-control-output-v1");
  let readonlyClient;
  let linkedClient;
  try {
    const bootstrap = spawnSync(wrapper, ["new-session", "-d", "-s", "bootstrap"], {
      encoding: "utf8",
    });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const paneBase = spawnSync(wrapper, ["set-option", "-g", "pane-base-index", "1"], {
      encoding: "utf8",
    });
    assert.equal(paneBase.status, 0, paneBase.stderr);
    const created = spawnSync(wrapper, ["new-session", "-d", "-s", "controlled", "-c", temp.root], {
      encoding: "utf8",
    });
    assert.equal(created.status, 0, created.stderr);
    spawnSync(wrapper, ["kill-session", "-t", "bootstrap"], { encoding: "utf8" });
    const physicalPane = spawnSync(wrapper, ["list-panes", "-t", "controlled", "-F", "#{pane_index}"], {
      encoding: "utf8",
    });
    assert.equal(physicalPane.stdout.trim(), "1", "test must cover non-zero physical pane index");
    writeFileSync(join(twHome, "state.json"), `${JSON.stringify({
      version: 1,
      sessions: [{
        name: "controlled",
        kind: "terminal",
        profile: "dashboard",
        cwd: temp.root,
        createdAt: "2026-07-13T00:00:00.000Z",
      }],
    })}\n`, { mode: 0o600 });
    const backend = new terminalControl.TmuxTerminalControlBackend();
    const authority = new terminalControl.TerminalControlAuthority({
      statePath: temp.path,
      backend,
    });
    const target = await resolved(authority, "controlled");
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "real-tmux:daemon-1"));
    readonlyClient = spawn(
      wrapper,
      [
        "-C",
        "attach-session",
        "-E",
        "-f",
        "read-only,ignore-size,no-output",
        "-t",
        "=controlled",
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const clientDeadline = Date.now() + 2_000;
    let readonlyAttached = false;
    while (!readonlyAttached && Date.now() < clientDeadline) {
      const clients = spawnSync(wrapper, ["list-clients", "-F", "#{client_readonly}"], {
        encoding: "utf8",
      });
      readonlyAttached = clients.status === 0 && clients.stdout.split("\n").includes("1");
      if (!readonlyAttached) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(readonlyAttached, true, "test must cover a read-only observer client");
    const linked = spawnSync(
      wrapper,
      ["new-session", "-d", "-t", "=controlled", "-s", "tw-mobile-linked"],
      { encoding: "utf8" },
    );
    assert.equal(linked.status, 0, linked.stderr);
    const canonicalIdentity = spawnSync(
      wrapper,
      ["display-message", "-p", "-t", "=controlled:", "#{pane_id}"],
      { encoding: "utf8" },
    );
    assert.equal(canonicalIdentity.status, 0, canonicalIdentity.stderr);
    const linkedIdentity = spawnSync(
      wrapper,
      [
        "display-message",
        "-p",
        "-t",
        "=tw-mobile-linked:",
        "#{pane_id}\u001f#{@tw_terminal_control_instance_v1}\u001f#{@tw_terminal_control_output_generation_v1}",
      ],
      { encoding: "utf8" },
    );
    assert.equal(linkedIdentity.status, 0, linkedIdentity.stderr);
    const [linkedPaneId, linkedInstanceId, linkedGeneration] = linkedIdentity.stdout.trim().split("\u001f");
    assert.equal(linkedPaneId, canonicalIdentity.stdout.trim());
    assert.equal(linkedInstanceId, "", "grouped mobile session must not inherit canonical session fencing");
    assert.equal(linkedGeneration, "", "grouped mobile session must not inherit canonical output fencing");
    linkedClient = spawn(
      wrapper,
      [
        "-C",
        "attach-session",
        "-E",
        "-f",
        "read-only,ignore-size,no-output",
        "-t",
        "=tw-mobile-linked",
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const linkedClientDeadline = Date.now() + 2_000;
    let linkedAttached = false;
    while (!linkedAttached && Date.now() < linkedClientDeadline) {
      const clients = spawnSync(wrapper, ["list-clients", "-F", "#{session_name}:#{client_readonly}"], {
        encoding: "utf8",
      });
      linkedAttached = clients.status === 0
        && clients.stdout.split("\n").includes("tw-mobile-linked:1");
      if (!linkedAttached) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(linkedAttached, true, "test must cover a grouped mobile observer client");
    const paneTargetContext = spawnSync(
      wrapper,
      ["display-message", "-p", "-t", linkedPaneId, "#{session_name}"],
      { encoding: "utf8" },
    );
    assert.equal(paneTargetContext.status, 0, paneTargetContext.stderr);
    assert.equal(
      paneTargetContext.stdout.trim(),
      "tw-mobile-linked",
      "the shared pane target must reproduce the mobile linked-session context",
    );
    const raw = await authority.handle({
      protocolVersion: 1,
      requestId: "real-tmux-fenced-raw",
      type: "input.raw",
      lease: feishu.lease,
      operationId: "real-tmux-fenced-raw",
      pane: "0",
      dataBase64: Buffer.from("printf 'fast-raw-path\\n'\r", "utf8").toString("base64"),
    });
    assert.equal(raw.accepted, true);
    assert.equal(raw.deduplicated, false);
    const emptyRaw = await authority.handle({
      protocolVersion: 1,
      requestId: "real-tmux-empty-raw",
      type: "input.raw",
      lease: feishu.lease,
      operationId: "real-tmux-empty-raw",
      pane: "0",
      dataBase64: "",
    });
    assert.equal(emptyRaw.accepted, true);
    assert.equal(emptyRaw.deduplicated, false);
    const rawKey = (operationId, data) => authority.handle({
      protocolVersion: 1,
      requestId: operationId,
      type: "input.raw",
      lease: feishu.lease,
      operationId,
      pane: "0",
      dataBase64: Buffer.from(data, "latin1").toString("base64"),
    });
    await rawKey("real-key-right-text", "touch key-right-okX");
    await rawKey("real-key-right-left", "\x1bOD");
    await rawKey("real-key-right-right", "\x1bOC");
    await rawKey("real-key-right-backspace", "\x7f");
    await rawKey("real-key-right-submit", "\r");
    await rawKey("real-key-delete-text", "touch key-delete-okX");
    await rawKey("real-key-delete-left", "\x1bOD");
    await rawKey("real-key-delete-forward", "\x1b[3~");
    await rawKey("real-key-delete-submit", "\r");
    const keyDeadline = Date.now() + 2_000;
    while (
      (!existsSync(join(temp.root, "key-right-ok")) || !existsSync(join(temp.root, "key-delete-ok")))
      && Date.now() < keyDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(join(temp.root, "key-right-ok")), true);
    assert.equal(existsSync(join(temp.root, "key-delete-ok")), true);
    const sent = await authority.handle(rawRequest(
      feishu.lease,
      "real-tmux-agent-message",
      "printf '[[notify-group]]real-output[[/notify-group]]\\n'\r",
    ));
    let cursor = sent.outputCursor;
    let observed = "";
    const deadline = Date.now() + 3_000;
    while (!observed.includes("[[notify-group]]real-output[[/notify-group]]") && Date.now() < deadline) {
      const chunk = await authority.handle({
        protocolVersion: 1,
        requestId: `real-tail-${cursor}`,
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: sent.controlEpoch,
        outputGeneration: sent.outputGeneration,
        cursor,
        maxBytes: 4096,
      });
      cursor = chunk.nextCursor;
      observed += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      if (!chunk.dataBase64) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(observed, /\[\[notify-group\]\]real-output\[\[\/notify-group\]\]/);
    const renderedOpenMarker = "[[notify-group:rendered]]";
    const renderedCloseMarker = "[[/notify-group:rendered]]";
    const renderedPayload = Buffer.from([
      "\x1b[2J\x1b[10;1H",
      renderedOpenMarker,
      "public rendered answer",
      "\x1b[s",
      "\x1b[H\x1b[2Kinput box",
      "\x1b[2;1H\x1b[2Kfooter",
      "\x1b[u",
      renderedCloseMarker,
      "\n",
    ].join(""), "utf8").toString("base64");
    const renderedTurn = await authority.handle(rawRequest(
      feishu.lease,
      "real-tmux-rendered-message",
      `printf '%s' '${renderedPayload}' | base64 -d\r`,
    ));
    let renderedRawCursor = renderedTurn.outputCursor;
    let renderedRaw = "";
    const renderedRawDeadline = Date.now() + 3_000;
    while (!renderedRaw.includes(renderedCloseMarker) && Date.now() < renderedRawDeadline) {
      const chunk = await authority.handle({
        protocolVersion: 1,
        requestId: `real-rendered-tail-${renderedRawCursor}`,
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: renderedTurn.controlEpoch,
        outputGeneration: renderedTurn.outputGeneration,
        cursor: renderedRawCursor,
        maxBytes: 64 * 1024,
      });
      renderedRawCursor = chunk.nextCursor;
      renderedRaw += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      if (!chunk.dataBase64) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const repaintSequence = [
      renderedOpenMarker,
      "\x1b[s",
      "\x1b[H",
      "\x1b[2K",
      "input box",
      "\x1b[2;1H",
      "\x1b[2K",
      "footer",
      "\x1b[u",
      renderedCloseMarker,
    ];
    const renderedRawPositions = [];
    let repaintOffset = 0;
    for (const item of repaintSequence) {
      const position = renderedRaw.indexOf(item, repaintOffset);
      renderedRawPositions.push(position);
      if (position >= 0) repaintOffset = position + item.length;
    }
    assert.ok(
      renderedRawPositions.every((position, index) => (
        position >= 0 && (index === 0 || position > renderedRawPositions[index - 1])
      )),
      `raw pipe output must retain repaint bytes in chronological order: ${renderedRawPositions.join(",")}`,
    );
    let rendered;
    let renderedText = "";
    const renderedDeadline = Date.now() + 3_000;
    while (!renderedText.includes(renderedCloseMarker) && Date.now() < renderedDeadline) {
      rendered = await authority.handle({
        protocolVersion: 1,
        requestId: `real-rendered-${Date.now()}`,
        type: "output.rendered-snapshot",
        lease: feishu.lease,
        outputGeneration: renderedTurn.outputGeneration,
        pane: "0",
        maxBytes: 64 * 1024,
      });
      renderedText = Buffer.from(rendered.dataBase64, "base64").toString("utf8");
      if (!renderedText.includes(renderedCloseMarker)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(rendered.controlTargetId, target.controlTargetId);
    assert.equal(rendered.leaseId, feishu.lease.leaseId);
    assert.equal(rendered.fence, feishu.lease.fence);
    assert.equal(rendered.ownerKind, "feishu");
    assert.equal(rendered.outputGeneration, renderedTurn.outputGeneration);
    assert.equal(rendered.pane, "0");
    assert.equal(rendered.truncated, false);
    assert.doesNotMatch(renderedText, /\x1b/);
    const renderedOpenPosition = renderedText.indexOf(renderedOpenMarker);
    const renderedClosePosition = renderedText.indexOf(renderedCloseMarker, renderedOpenPosition);
    assert.ok(renderedOpenPosition >= 0);
    assert.ok(renderedClosePosition > renderedOpenPosition);
    const renderedInputPosition = renderedText.indexOf("input box");
    const renderedFooterPosition = renderedText.indexOf("footer");
    assert.ok(renderedInputPosition >= 0);
    assert.ok(renderedFooterPosition > renderedInputPosition);
    assert.ok(renderedOpenPosition > renderedFooterPosition);
    assert.equal(
      renderedText.slice(renderedOpenPosition + renderedOpenMarker.length, renderedClosePosition),
      "public rendered answer",
    );
    const history = await authority.handle(rawRequest(
      feishu.lease,
      "real-tmux-history",
      "seq 1 200\r",
    ));
    cursor = history.outputCursor;
    observed = "";
    const historyDeadline = Date.now() + 3_000;
    while (!/(?:^|\r?\n)200(?:\r?\n|$)/.test(observed) && Date.now() < historyDeadline) {
      const chunk = await authority.handle({
        protocolVersion: 1,
        requestId: `real-history-tail-${cursor}`,
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: history.controlEpoch,
        outputGeneration: history.outputGeneration,
        cursor,
        maxBytes: 64 * 1024,
      });
      cursor = chunk.nextCursor;
      observed += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      if (!chunk.dataBase64) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(observed, /(?:^|\r?\n)200(?:\r?\n|$)/);
    const scrolled = await authority.handle(scrollRequest(
      feishu.lease,
      "real-tmux-scroll-up",
      "up",
      5,
    ));
    assert.equal(scrolled.accepted, true);
    const scrollState = spawnSync(
      wrapper,
      ["display-message", "-p", "-t", "controlled:0.1", "#{pane_in_mode}:#{scroll_position}"],
      { encoding: "utf8" },
    );
    assert.equal(scrollState.status, 0, scrollState.stderr);
    const [paneInMode, scrollPosition] = scrollState.stdout.trim().split(":");
    assert.equal(paneInMode, "1");
    assert.ok(Number(scrollPosition) >= 5, scrollState.stdout);
    const released = await authority.handle({
      protocolVersion: 1,
      requestId: "real-release",
      type: "lease.release",
      lease: feishu.lease,
    });
    assert.equal(released.state, "FREE");
    assert.notEqual(released.outputGeneration, sent.outputGeneration);
    const extraWindow = spawnSync(wrapper, ["new-window", "-d", "-t", "controlled"], {
      encoding: "utf8",
    });
    assert.equal(extraWindow.status, 0, extraWindow.stderr);
    const currentBackend = await backend.resolveManagedSession("controlled");
    await assert.rejects(
      backend.writeRawFenced(
        currentBackend.managedSession,
        currentBackend.tmuxInstanceId,
        released.outputGeneration,
        "0",
        Buffer.from("must-not-write"),
      ),
      (error) => error.code === "RECOVERY_REQUIRED" && /single-pane shape changed/.test(error.message),
    );
    await assert.rejects(
      backend.writeRaw("controlled", "0", Buffer.from("must-not-write")),
      (error) => error.code === "RECOVERY_REQUIRED" && /2 live panes/.test(error.message),
    );
    await assert.rejects(
      backend.captureRenderedSnapshot(
        currentBackend.managedSession,
        currentBackend.tmuxInstanceId,
        released.outputGeneration,
        "0",
        terminalControl.TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES,
      ),
      (error) => error.code === "RECOVERY_REQUIRED" && /single-pane shape changed/.test(error.message),
    );
  } finally {
    if (linkedClient) {
      linkedClient.stdin?.end();
      linkedClient.kill("SIGTERM");
    }
    if (readonlyClient) {
      readonlyClient.stdin?.end();
      readonlyClient.kill("SIGTERM");
    }
    spawnSync(wrapper, ["kill-server"], { encoding: "utf8" });
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.TW_TMUX === undefined) delete process.env.TW_TMUX;
    else process.env.TW_TMUX = previous.TW_TMUX;
    if (previous.TW_TERMINAL_CONTROL_OUTPUT_DIR === undefined) delete process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR;
    else process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR = previous.TW_TERMINAL_CONTROL_OUTPUT_DIR;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        temp.cleanup();
        break;
      } catch (error) {
        if (attempt === 19 || error.code !== "ENOTEMPTY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
});
