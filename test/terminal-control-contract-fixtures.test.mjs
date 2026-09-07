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

test("agent activity classifier matches the Dashboard Braille-spinner contract", () => {
  assert.equal(terminalControl.agentRunningFromPaneTitle("⠴ running task"), true);
  assert.equal(terminalControl.agentRunningFromPaneTitle("  ⠇ another task"), true);
  assert.equal(terminalControl.agentRunningFromPaneTitle("✳ Claude Code"), false);
  assert.equal(terminalControl.agentRunningFromPaneTitle("⠴not-a-status-prefix"), false);
  assert.equal(terminalControl.agentRunningFromPaneTitle(""), false);
});

test("terminal-control v1 contract fixtures are closed and storage fixtures are strict", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", contractRoot), "utf8"));
  assert.equal(manifest.contract, "tmux-worktree-local-terminal-control");
  assert.equal(manifest.version, terminalControl.TERMINAL_CONTROL_PROTOCOL_VERSION);
  assert.equal(manifest.schema, "closed");

  const requests = JSON.parse(readFileSync(new URL("requests.json", contractRoot), "utf8"));
  for (const fixture of requests) {
    assert.deepEqual(
      terminalControl.parseTerminalControlRequest(fixture.message),
      fixture.message,
      fixture.name,
    );
  }
  assert.throws(
    () => terminalControl.parseTerminalControlRequest({ ...requests[0].message, extra: true }),
    /invalid or unknown request type/,
  );
  const renderedSnapshot = requests.find(({ message }) => message.type === "output.rendered-snapshot");
  assert.ok(renderedSnapshot);
  assert.throws(
    () => terminalControl.parseTerminalControlRequest({ ...renderedSnapshot.message, extra: true }),
    /invalid or unknown request type/,
  );
  assert.throws(
    () => terminalControl.parseTerminalControlRequest({
      ...renderedSnapshot.message,
      maxBytes: terminalControl.TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES + 1,
    }),
    /maxBytes is invalid/,
  );
  const agentStatus = requests.find(({ message }) => message.type === "activity.agent-status");
  assert.ok(agentStatus);
  assert.throws(
    () => terminalControl.parseTerminalControlRequest({ ...agentStatus.message, extra: true }),
    /invalid or unknown request type/,
  );
  const agentResultRequest = requests.find(({ message }) => message.type === "activity.agent-result");
  assert.ok(agentResultRequest);

  const responses = JSON.parse(readFileSync(new URL("responses.json", contractRoot), "utf8"));
  for (const fixture of responses) {
    assert.deepEqual(
      terminalControl.parseTerminalControlResponse(fixture.message, fixture.message.requestId),
      fixture.message,
      fixture.name,
    );
  }
  assert.throws(
    () => terminalControl.parseTerminalControlResponse({ ...responses[0].message, extra: true }),
    /response envelope is invalid/,
  );
  assert.throws(
    () => terminalControl.parseTerminalControlResponse(responses[0].message, "another-request"),
    /requestId does not match/,
  );
  const renderedResponse = responses.find(({ message }) =>
    message.requestId === renderedSnapshot.message.requestId && message.ok);
  assert.ok(renderedResponse);
  const renderedInput = {
    lease: renderedSnapshot.message.lease,
    outputGeneration: renderedSnapshot.message.outputGeneration,
    pane: renderedSnapshot.message.pane,
    maxBytes: renderedSnapshot.message.maxBytes,
  };
  assert.deepEqual(
    parseCanonicalRenderedSnapshotResult(renderedResponse.message.result, renderedInput),
    renderedResponse.message.result,
  );
  assert.throws(
    () => parseCanonicalRenderedSnapshotResult(
      { ...renderedResponse.message.result, extra: true },
      renderedInput,
    ),
    /invalid rendered snapshot/,
  );
  const agentStatusResponse = responses.find(({ message }) =>
    message.requestId === agentStatus.message.requestId && message.ok);
  assert.ok(agentStatusResponse);
  const agentStatusInput = {
    lease: agentStatus.message.lease,
    outputGeneration: agentStatus.message.outputGeneration,
    pane: agentStatus.message.pane,
  };
  assert.deepEqual(
    parseCanonicalAgentStatusResult(agentStatusResponse.message.result, agentStatusInput),
    agentStatusResponse.message.result,
  );
  assert.throws(
    () => parseCanonicalAgentStatusResult(
      { ...agentStatusResponse.message.result, extra: true },
      agentStatusInput,
    ),
    /invalid agent status/,
  );
  assert.throws(
    () => parseCanonicalAgentStatusResult(
      { ...agentStatusResponse.message.result, fence: "8" },
      agentStatusInput,
    ),
    /mismatched agent status correlation/,
  );
  const agentResultResponse = responses.find(({ message }) =>
    message.requestId === agentResultRequest.message.requestId && message.ok);
  assert.ok(agentResultResponse);
  const agentResultInput = {
    lease: agentResultRequest.message.lease,
    outputGeneration: agentResultRequest.message.outputGeneration,
    pane: agentResultRequest.message.pane,
    source: agentResultRequest.message.source,
    maxBytes: agentResultRequest.message.maxBytes,
  };
  assert.deepEqual(
    parseCanonicalAgentResultResult(agentResultResponse.message.result, agentResultInput),
    agentResultResponse.message.result,
  );
  assert.throws(
    () => parseCanonicalAgentResultResult(
      { ...agentResultResponse.message.result, source: {
        ...agentResultResponse.message.result.source,
        turnId: "another-turn",
      } },
      agentResultInput,
    ),
    /mismatched Agent final response correlation/,
  );

  const storage = JSON.parse(readFileSync(new URL("storage-cases.json", contractRoot), "utf8"));
  for (const fixture of storage.valid) {
    assert.deepEqual(terminalControl.parseTerminalControlState(fixture.value), fixture.value);
  }
  for (const fixture of storage.invalid) {
    assert.throws(() => terminalControl.parseTerminalControlState(fixture.value), undefined, fixture.name);
  }
});
