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

test("terminal-control storage is private, atomic, and preserves malformed state", () => {
  const temp = tempState();
  try {
    const state = terminalControl.emptyTerminalControlState();
    terminalControl.saveTerminalControlState(state, temp.path);
    assert.equal(statSync(temp.path).mode & 0o777, 0o600);
    assert.deepEqual(terminalControl.loadTerminalControlState(temp.path), state);

    const malformed = '{"version":1,"controlEpoch":"epoch","targets":[';
    writeFileSync(temp.path, malformed);
    assert.throws(
      () => terminalControl.loadTerminalControlState(temp.path),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(readFileSync(temp.path, "utf8"), malformed);
  } finally {
    temp.cleanup();
  }
});

test("terminal-control storage bounds retired journals and uses compact durable JSON", () => {
  const temp = tempState();
  try {
    const state = terminalControl.emptyTerminalControlState();
    const operation = (suffix) => ({
      operationId: `operation-${suffix}`,
      ownerInstanceId: `owner-${suffix}`,
      fence: "1",
      payloadHash: "a".repeat(64),
      kind: "raw",
      disposition: "committed",
      completedAt: "2026-07-13T00:00:00.000Z",
    });
    const target = (suffix, lifecycle, updatedAt) => ({
      controlTargetId: `target-${suffix}`,
      lifecycle,
      managedSession: {
        name: `managed-${suffix}`,
        kind: "terminal",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
      backend: { kind: "tmux", tmuxInstanceId: `tmux-${suffix}` },
      outputGeneration: `output-${suffix}`,
      ownership: { state: "FREE", fence: "1" },
      revision: "1",
      completedOperations: [operation(suffix)],
      updatedAt,
    });
    state.targets.push(target("active", "ACTIVE", "2026-07-14T00:00:00.000Z"));
    for (let index = 0; index < 80; index += 1) {
      state.targets.push(target(
        `gone-${index}`,
        "TARGET_GONE",
        new Date(Date.UTC(2026, 6, 13, 0, index)).toISOString(),
      ));
    }

    terminalControl.saveTerminalControlState(state, temp.path);

    const persisted = terminalControl.loadTerminalControlState(temp.path);
    const active = persisted.targets.find((candidate) => candidate.lifecycle === "ACTIVE");
    const retired = persisted.targets.filter((candidate) => candidate.lifecycle === "TARGET_GONE");
    assert.equal(retired.length, terminalControl.TERMINAL_CONTROL_MAX_RETIRED_TARGETS);
    assert.equal(retired.every((candidate) => candidate.completedOperations.length === 0), true);
    assert.equal(active.completedOperations.length, 1);
    assert.equal(retired.some((candidate) => candidate.controlTargetId === "target-gone-79"), true);
    assert.equal(retired.some((candidate) => candidate.controlTargetId === "target-gone-0"), false);
    const wire = readFileSync(temp.path, "utf8");
    assert.equal(wire.split("\n").length, 2, "durable state should be one compact JSON line");
  } finally {
    temp.cleanup();
  }
});
