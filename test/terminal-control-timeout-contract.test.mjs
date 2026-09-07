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

test("Agent cold-resume timeout layers preserve backend and transport ordering", () => {
  assert.equal(
    terminalControl.TERMINAL_CONTROL_AGENT_MESSAGE_BACKEND_MAX_MS,
    terminalControl.TERMINAL_CONTROL_CODEX_ENVIRONMENT_HYDRATION_TIMEOUT_MS
      + terminalControl.TERMINAL_CONTROL_AGENT_RESUME_INPUT_TIMEOUT_MS,
  );
  assert.ok(
    exactCompound.RELAY_V2_REMOTE_EXACT_COMPOUND_REQUEST_TIMEOUT_MS
      > terminalControl.TERMINAL_CONTROL_AGENT_MESSAGE_BACKEND_MAX_MS,
    "the compound transport must leave margin after the longest backend operation",
  );
  assert.equal(
    exactCompound.RELAY_V2_REMOTE_EXACT_COMPOUND_REQUEST_TIMEOUT_MS,
    terminalControl.TERMINAL_CONTROL_AGENT_MESSAGE_REQUEST_TIMEOUT_MS,
  );
  assert.ok(
    terminalControl.TERMINAL_CONTROL_SERVER_SOCKET_IDLE_TIMEOUT_MS
      > terminalControl.TERMINAL_CONTROL_AGENT_MESSAGE_REQUEST_TIMEOUT_MS,
    "the daemon socket must outlive the caller's complete request window",
  );
});
