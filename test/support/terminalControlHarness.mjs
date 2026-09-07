/**
 * Shared harness for terminal-control test files.
 *
 * Centralises the dist imports, isolated tmux wrapper, and helper functions
 * that were previously duplicated inline in the monolithic
 * test/terminal-control.test.mjs.  Each terminal-control-<topic>.test.mjs
 * imports the symbols it needs from here plus any node: builtins it uses
 * directly.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deferred } from "./async.mjs";

// ---------------------------------------------------------------------------
// Dist modules
// ---------------------------------------------------------------------------
const terminalControl = await import("../../dist/terminalControl/index.js");
const managedSessions = await import("../../dist/session.js");
const terminalControlCli = fileURLToPath(new URL("../../dist/cli.cjs", import.meta.url));
const exactCompound = await import(
  "../../dist/relay/v2/remoteExactTerminalControlCompoundV1.js"
);
const backendIdentity = await import("../../dist/relay/v2/canonicalBackendIdentity.js");
const {
  CanonicalTerminalControlSocketClient,
  parseCanonicalAgentResultResult,
  parseCanonicalAgentStatusResult,
  parseCanonicalRenderedSnapshotResult,
} = await import("../../dist/canonicalTerminalControlClient.js");
const contractRoot = new URL("../../contracts/terminal-control/v1/", import.meta.url);

// ---------------------------------------------------------------------------
// Isolated tmux wrapper (one per test process)
// ---------------------------------------------------------------------------
const isolatedTmuxWrapperRoot = mkdtempSync(join(tmpdir(), "tw-terminal-control-tmux-wrapper-"));
const isolatedTmuxWrapper = join(isolatedTmuxWrapperRoot, "isolated-tmux");

after(() => rmSync(isolatedTmuxWrapperRoot, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tempState(prefix = "tw-terminal-control-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    path: join(root, "terminal-control-state-v1.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function stopAutoStartedTerminalControl(socketPath) {
  const lockPath = `${socketPath}.server.lock`;
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) return;
  let pid;
  try {
    pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid;
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid < 2) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 2_000;
  while (existsSync(lockPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(lockPath)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function regularFileBytes(root) {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += regularFileBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function installFullLegacyCapture(harness, controlTargetId, outputGeneration, bytes) {
  const targetDirectory = join(harness.outputRoot, sha256Hex(controlTargetId));
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(targetDirectory, `${sha256Hex(outputGeneration)}.bin`),
    Buffer.alloc(bytes, 0x78),
    { mode: 0o600 },
  );
  const configured = spawnSync(
    harness.wrapper,
    ["set-option", "-t", harness.sessionName, "@tw_terminal_control_output_generation_v1", outputGeneration],
    { encoding: "utf8" },
  );
  assert.equal(configured.status, 0, configured.stderr);
  return targetDirectory;
}

async function persistedLegacyRecovery(harness, previousOwnerKind) {
  const legacyBytes = 8 * 1024 * 1024;
  const controlTargetId = randomUUID();
  const outputGeneration = `legacy-recovery-${sha256Hex(harness.sessionName).slice(0, 16)}`;
  const backend = new terminalControl.TmuxTerminalControlBackend();
  const resolvedBackend = await backend.resolveManagedSession(harness.sessionName);
  const state = terminalControl.emptyTerminalControlState();
  state.targets.push({
    controlTargetId,
    lifecycle: "RECOVERY_REQUIRED",
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
    ownership: { state: "FREE", fence: "7" },
    revision: "2",
    recovery: {
      reason: "OUTPUT_CONTINUITY_UNCERTAIN",
      since: harness.createdAt,
      previousControlEpoch: "legacy-controller-epoch",
      ...(previousOwnerKind === undefined ? {} : { previousOwnerKind }),
    },
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
  return {
    legacyBytes,
    controlTargetId,
    outputGeneration,
    targetDirectory,
    authority: new terminalControl.TerminalControlAuthority({
      statePath: harness.temp.path,
      backend,
    }),
  };
}

function isolatedManagedTmux(t, sessionName, options = {}) {
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("tmux is unavailable");
    return undefined;
  }
  const temp = tempState();
  const home = join(temp.root, "home");
  const twHome = join(home, ".tmux-worktree");
  const outputRoot = join(twHome, "terminal-control-output-v1");
  const wrapper = isolatedTmuxWrapper;
  const socketName = `tw-terminal-control-ring-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const previous = {
    HOME: process.env.HOME,
    TW_TMUX: process.env.TW_TMUX,
    TW_TERMINAL_CONTROL_OUTPUT_DIR: process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR,
  };
  mkdirSync(twHome, { recursive: true, mode: 0o700 });
  writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L ${socketName} -f /dev/null "$@"\n`, { mode: 0o700 });
  process.env.HOME = home;
  process.env.TW_TMUX = wrapper;
  process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR = outputRoot;
  const createdAt = "2026-07-13T00:00:00.000Z";
  if (options.lifecycleV2 === true) {
    const prefix = "tw-term-";
    if (!sessionName.startsWith(prefix)) throw new Error("lifecycle fixture requires a terminal name");
    try {
      const created = managedSessions.createManagedTerminalSession({
        cwd: temp.root,
        profile: "dashboard",
        quiet: true,
        lifecycleV2: {
          reservationCorrelation: null,
          displayLabel: sessionName,
        },
      }, {
        tmuxBin: () => wrapper,
        randomId: () => sessionName.slice(prefix.length),
        now: () => new Date(createdAt),
        setupClipboardBindings: () => {},
      });
      assert.equal(created.session, sessionName);
    } catch (error) {
      restore();
      temp.cleanup();
      throw error;
    }
  } else {
    const created = spawnSync(wrapper, ["new-session", "-d", "-s", sessionName, "-c", temp.root], {
      encoding: "utf8",
    });
    if (created.status !== 0) {
      restore();
      temp.cleanup();
      throw new Error(created.stderr || `could not create isolated tmux session: ${sessionName}`);
    }
    writeFileSync(join(twHome, "state.json"), `${JSON.stringify({
      version: 1,
      sessions: [{
        name: sessionName,
        kind: "terminal",
        profile: "dashboard",
        cwd: temp.root,
        createdAt,
      }],
    })}\n`, { mode: 0o600 });
  }

  function restore() {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.TW_TMUX === undefined) delete process.env.TW_TMUX;
    else process.env.TW_TMUX = previous.TW_TMUX;
    if (previous.TW_TERMINAL_CONTROL_OUTPUT_DIR === undefined) delete process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR;
    else process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR = previous.TW_TERMINAL_CONTROL_OUTPUT_DIR;
  }

  return {
    temp,
    home,
    twHome,
    outputRoot,
    wrapper,
    sessionName,
    createdAt,
    async cleanup() {
      spawnSync(wrapper, ["kill-server"], { encoding: "utf8" });
      restore();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          temp.cleanup();
          return;
        } catch (error) {
          if (attempt === 19 || error.code !== "ENOTEMPTY") throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    },
  };
}

class FakeBackend {
  constructor() {
    this.createdAt = "2026-07-13T00:00:00.000Z";
    this.instance = "tmux-instance-1";
    this.current = true;
    this.writes = [];
    this.gate = null;
    this.started = null;
    this.failWrite = false;
    this.failKill = false;
    this.failAssertUncertain = false;
    this.nextOutputGeneration = 1;
    this.outputGeneration = undefined;
    this.outputs = new Map();
    this.resetCalls = 0;
    this.failReset = false;
    this.renderedOutput = "rendered terminal output\n";
    this.renderedSnapshotCalls = [];
    this.failRenderedSnapshot = undefined;
    this.agentRunning = true;
    this.agentSource = {
      provider: "codex",
      boundary: "exact",
      sourceId: "b".repeat(64),
      sessionId: "codex-session-one",
      turnId: "codex-turn-one",
      startedAt: "2026-07-13T00:30:00.000Z",
    };
    this.agentStatusCalls = [];
    this.agentResultCalls = [];
  }

  async resolveManagedSession(sessionName) {
    if (!this.current) throw new Error("target not found");
    return {
      managedSession: {
        name: sessionName,
        kind: "terminal",
        profile: "dashboard",
        cwd: "/tmp",
        createdAt: this.createdAt,
      },
      tmuxInstanceId: this.instance,
    };
  }

  async assertCurrent(session, instance) {
    if (this.failAssertUncertain) throw new Error("injected backend identity uncertainty");
    if (!this.current || session.createdAt !== this.createdAt || instance !== this.instance) {
      throw new terminalControl.TerminalControlProtocolError("TARGET_GONE", "fake target gone");
    }
  }

  async beforeWrite(kind, value) {
    this.started?.resolve();
    if (this.gate) await this.gate.promise;
    if (this.failWrite instanceof Error) throw this.failWrite;
    if (this.failWrite) throw new Error("injected backend uncertainty");
    this.writes.push({ kind, value });
  }

  async writeRaw(_session, pane, data) {
    await this.beforeWrite("raw", { pane, data: data.toString("utf8") });
  }

  async sendAgentMessage(_session, pane, message, submit) {
    await this.beforeWrite("agent-message", { pane, message, submit });
  }

  async resize(_session, pane, cols, rows) {
    await this.beforeWrite("resize", { pane, cols, rows });
  }

  async scroll(_session, pane, direction, lines) {
    await this.beforeWrite("scroll", { pane, direction, lines });
  }

  async killManaged(session) {
    if (this.failKill) throw new Error("injected managed kill failure");
    this.writes.push({ kind: "lifecycle-kill", value: { session } });
    this.current = false;
  }

  async prepareOutput(controlTargetId, _session, _pane, generation) {
    const next = generation ?? this.outputGeneration ?? `output-${this.nextOutputGeneration++}`;
    this.outputGeneration = next;
    const key = `${controlTargetId}:${next}`;
    if (!this.outputs.has(key)) this.outputs.set(key, Buffer.alloc(0));
    return { generation: next, cursor: this.outputs.get(key).byteLength };
  }

  async resetOutput(controlTargetId) {
    if (this.failReset) throw new Error("injected reset failure");
    this.resetCalls++;
    const generation = `output-${this.nextOutputGeneration++}`;
    this.outputGeneration = generation;
    this.outputs.set(`${controlTargetId}:${generation}`, Buffer.alloc(0));
    return { generation, cursor: 0 };
  }

  async recoverOutput(controlTargetId, _session, _pane, _previousGeneration, recoveryGeneration) {
    this.resetCalls++;
    this.outputGeneration = recoveryGeneration;
    this.outputs.set(`${controlTargetId}:${recoveryGeneration}`, Buffer.alloc(0));
    return { generation: recoveryGeneration, cursor: 0 };
  }

  async tailOutput(controlTargetId, _session, _pane, generation, cursor, maxBytes) {
    const bytes = this.outputs.get(`${controlTargetId}:${generation}`);
    if (!bytes || generation !== this.outputGeneration || cursor > bytes.byteLength) {
      throw new terminalControl.TerminalControlProtocolError("STALE_OUTPUT_CURSOR", "fake cursor stale");
    }
    const chunk = bytes.subarray(cursor, cursor + maxBytes);
    return {
      generation,
      cursor,
      dataBase64: chunk.toString("base64"),
      nextCursor: cursor + chunk.byteLength,
    };
  }

  async captureRenderedSnapshot(session, instance, generation, pane, maxBytes) {
    this.renderedSnapshotCalls.push({
      session: structuredClone(session),
      instance,
      generation,
      pane,
      maxBytes,
    });
    if (this.failRenderedSnapshot) throw this.failRenderedSnapshot;
    const source = Buffer.from(this.renderedOutput, "utf8");
    const data = source.subarray(Math.max(0, source.byteLength - maxBytes));
    return {
      dataBase64: data.toString("base64"),
      truncated: data.byteLength < source.byteLength,
    };
  }

  async agentStatus(session, instance, generation, pane) {
    this.agentStatusCalls.push({
      session: structuredClone(session),
      instance,
      generation,
      pane,
    });
    return {
      agentSupported: true,
      agentRunning: this.agentRunning,
      ...(this.agentRunning ? { source: structuredClone(this.agentSource) } : {}),
    };
  }

  async agentResult(session, instance, generation, pane, source, maxBytes) {
    this.agentResultCalls.push({
      session: structuredClone(session), instance, generation, pane,
      source: structuredClone(source), maxBytes,
    });
    return {
      source: structuredClone(source),
      completedAt: "2026-07-13T01:00:00.000Z",
      text: "Exact structured final response",
      truncated: false,
    };
  }

  appendOutput(controlTargetId, text) {
    const key = `${controlTargetId}:${this.outputGeneration}`;
    const current = this.outputs.get(key) ?? Buffer.alloc(0);
    this.outputs.set(key, Buffer.concat([current, Buffer.from(text, "utf8")]));
  }
}

function owner(kind, suffix) {
  return { kind, instanceId: `${kind}:${suffix}` };
}

async function resolved(authority, sessionName = "managed-terminal") {
  return authority.handle({
    protocolVersion: 1,
    requestId: "resolve",
    type: "target.resolve",
    sessionName,
  });
}

async function acquired(authority, controlTargetId, leaseOwner) {
  return authority.handle({
    protocolVersion: 1,
    requestId: "acquire",
    type: "lease.acquire",
    controlTargetId,
    owner: leaseOwner,
  });
}

function rawRequest(lease, operationId, text) {
  return {
    protocolVersion: 1,
    requestId: operationId,
    type: "input.raw",
    lease,
    operationId,
    pane: "0",
    dataBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}

function scrollRequest(lease, operationId, direction, lines) {
  return {
    protocolVersion: 1,
    requestId: operationId,
    type: "input.scroll",
    lease,
    operationId,
    pane: "0",
    direction,
    lines,
  };
}

function resizeRequest(lease, operationId, cols, rows) {
  return {
    protocolVersion: 1,
    requestId: operationId,
    type: "input.resize",
    lease,
    operationId,
    pane: "0",
    cols,
    rows,
  };
}

export {
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
};
