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
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const terminalControl = await import("../dist/terminalControl/index.js");
const {
  CanonicalTerminalControlSocketClient,
  parseCanonicalAgentResultResult,
  parseCanonicalAgentStatusResult,
  parseCanonicalRenderedSnapshotResult,
} = await import("../dist/canonicalTerminalControlClient.js");
const contractRoot = new URL("../contracts/terminal-control/v1/", import.meta.url);
const isolatedTmuxWrapperRoot = mkdtempSync(join(tmpdir(), "tw-terminal-control-tmux-wrapper-"));
const isolatedTmuxWrapper = join(isolatedTmuxWrapperRoot, "isolated-tmux");

after(() => rmSync(isolatedTmuxWrapperRoot, { recursive: true, force: true }));

function tempState() {
  const root = mkdtempSync(join(tmpdir(), "tw-terminal-control-"));
  return {
    root,
    path: join(root, "terminal-control-state-v1.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function isolatedManagedTmux(t, sessionName) {
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
    this.resetCalls++;
    const generation = `output-${this.nextOutputGeneration++}`;
    this.outputGeneration = generation;
    this.outputs.set(`${controlTargetId}:${generation}`, Buffer.alloc(0));
    return { generation, cursor: 0 };
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

test("agent status requires the exact Feishu lease and output generation", async () => {
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
      { type: "system", subtype: "turn_duration", uuid: "claude-duration-2", parentUuid: "claude-final", timestamp: "2026-07-21T01:03:02.000Z", cwd: claudeCwd, sessionId: claudeSessionId, isSidechain: false },
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
      { type: "response_item", timestamp: "2026-07-21T02:01:00.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex final answer" }] } },
      { type: "event_msg", timestamp: "2026-07-21T02:01:01.000Z", payload: { type: "task_complete", turn_id: codexTurnId, last_agent_message: "Codex final answer" } },
    );
    writeFileSync(codexPath, `${codexRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    assert.equal(terminalControl.readCompletedAgentResult({
      source: codexSource, cwd: codexCwd, home: root, maxBytes: 1024,
    }).text, "Codex final answer");
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

test("ownership handoff has one durable commit point and fences every old input", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
  });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-1:daemon-1"));
    const dashboardOwner = owner("dashboard", "instance-1:pty-1");

    await assert.rejects(
      acquired(authority, target.controlTargetId, dashboardOwner),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await authority.handle(rawRequest(feishu.lease, "feishu-input-1", "first"));
    assert.deepEqual(backend.writes, [{ kind: "raw", value: { pane: "0", data: "first" } }]);

    const draining = await authority.handle({
      protocolVersion: 1,
      requestId: "handoff-begin",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: dashboardOwner,
    });
    assert.equal(draining.ownership.state, "DRAINING");
    await assert.rejects(
      authority.handle(rawRequest(feishu.lease, "late-feishu-input", "late")),
      (error) => error.code === "HANDOFF_PENDING",
    );

    const committed = await authority.handle({
      protocolVersion: 1,
      requestId: "handoff-commit",
      type: "handoff.commit",
      handoffId: draining.ownership.handoffId,
      currentLease: feishu.lease,
      drain: {
        disposition: "drained",
        recordId: "feishu-turn-settled-1",
        recordedAt: "2026-07-13T00:00:30.000Z",
      },
    });
    assert.equal(BigInt(committed.lease.fence), BigInt(feishu.lease.fence) + 1n);
    assert.deepEqual(committed.lease.owner, dashboardOwner);
    await assert.rejects(
      authority.handle(rawRequest(feishu.lease, "post-commit-feishu-input", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    await authority.handle(rawRequest(committed.lease, "dashboard-input-1", "local"));
    assert.equal(backend.writes.at(-1).value.data, "local");
  } finally {
    temp.cleanup();
  }
});

test("only the exact pending next owner can withdraw an uncommitted handoff", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-1:daemon-1"));
    const nextOwner = owner("local-cli", "process-1:attach-1");
    const draining = await authority.handle({
      protocolVersion: 1,
      requestId: "begin-withdraw",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner,
    });
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "wrong-withdraw",
        type: "handoff.withdraw",
        controlTargetId: target.controlTargetId,
        handoffId: draining.ownership.handoffId,
        nextOwner: owner("local-cli", "other-process"),
      }),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const restored = await authority.handle({
      protocolVersion: 1,
      requestId: "exact-withdraw",
      type: "handoff.withdraw",
      controlTargetId: target.controlTargetId,
      handoffId: draining.ownership.handoffId,
      nextOwner,
    });
    assert.equal(restored.state, "HELD");
    await authority.handle(rawRequest(feishu.lease, "after-withdraw", "still-feishu"));
    assert.equal(backend.writes.at(-1).value.data, "still-feishu");
  } finally {
    temp.cleanup();
  }
});

test("managed kill is fenced in the authority critical section and deterministic failure keeps the lease", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(authority, target.controlTargetId, owner("dashboard", "instance-1:pty-1"));
    backend.failKill = true;
    await assert.rejects(
      authority.handle({
        protocolVersion: 1,
        requestId: "failed-kill",
        type: "lifecycle.kill",
        lease: dashboard.lease,
        operationId: "failed-kill",
      }),
      /injected managed kill failure/,
    );
    await authority.handle(rawRequest(dashboard.lease, "after-failed-kill", "still-live"));
    backend.failKill = false;
    await authority.handle({
      protocolVersion: 1,
      requestId: "successful-kill",
      type: "lifecycle.kill",
      lease: dashboard.lease,
      operationId: "successful-kill",
    });
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "status-after-kill",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "TARGET_GONE");
    await assert.rejects(
      authority.handle(rawRequest(dashboard.lease, "after-successful-kill", "stale")),
      (error) => error.code === "TARGET_GONE",
    );
  } finally {
    temp.cleanup();
  }
});

test("handoff waits behind an accepted backend write and cannot split agent body from submit", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  backend.gate = deferred();
  backend.started = deferred();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const feishu = await acquired(authority, target.controlTargetId, owner("feishu", "binding-2:daemon-1"));
    const write = authority.handle({
      protocolVersion: 1,
      requestId: "agent-write",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "agent-write",
      pane: "0",
      message: "do the work",
      submit: true,
    });
    await backend.started.promise;
    let handoffResolved = false;
    const handoff = authority.handle({
      protocolVersion: 1,
      requestId: "handoff-race",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "instance-2:pty-1"),
    }).then((value) => {
      handoffResolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(handoffResolved, false, "handoff must wait for the backend critical section");
    backend.gate.resolve();
    await write;
    const draining = await handoff;
    assert.equal(draining.ownership.state, "DRAINING");
    assert.deepEqual(backend.writes, [{
      kind: "agent-message",
      value: { pane: "0", message: "do the work", submit: true },
    }]);
  } finally {
    temp.cleanup();
  }
});

test("operation IDs deduplicate exact retries and reject payload reuse", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v1", "connector:client:target"));
    const first = await authority.handle(rawRequest(relay.lease, "stream-1:input-1", "abc"));
    const duplicate = await authority.handle(rawRequest(relay.lease, "stream-1:input-1", "abc"));
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(backend.writes.length, 1);
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "stream-1:input-1", "different")),
      (error) => error.code === "INVALID_REQUEST",
    );
  } finally {
    temp.cleanup();
  }
});

test("Dashboard and Relay share interactive input without fencing each other", async () => {
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
    const relay = await acquired(
      authority,
      target.controlTargetId,
      owner("relay-v1", "connector:android-client:target"),
    );

    assert.equal(relay.lease.leaseId, dashboard.lease.leaseId);
    assert.equal(relay.lease.fence, dashboard.lease.fence);
    await authority.handle(rawRequest(dashboard.lease, "dashboard-input-1", "from-dashboard"));
    await authority.handle(rawRequest(relay.lease, "relay-input-1", "from-apk"));

    await authority.handle({
      protocolVersion: 1,
      requestId: "dashboard-release-with-relay-active",
      type: "lease.release",
      lease: dashboard.lease,
    });
    await authority.handle(rawRequest(relay.lease, "relay-input-2", "apk-still-writable"));

    assert.deepEqual(backend.writes, [
      { kind: "raw", value: { pane: "0", data: "from-dashboard" } },
      { kind: "raw", value: { pane: "0", data: "from-apk" } },
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
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v1", "client:logical-pane"));
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
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v1", "backend-invalid"));
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

test("missing raw output capture is rebuilt for an idle Dashboard owner but never for Feishu", async () => {
  const dashboardTemp = tempState();
  const dashboardBackend = new FakeBackend();
  const dashboardAuthority = new terminalControl.TerminalControlAuthority({
    statePath: dashboardTemp.path,
    backend: dashboardBackend,
  });
  try {
    const target = await resolved(dashboardAuthority, "dashboard-capture-repair");
    const held = await acquired(
      dashboardAuthority,
      target.controlTargetId,
      owner("dashboard", "active-pty"),
    );
    dashboardBackend.rawInputPosition = async () => {
      throw new terminalControl.TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture file is missing",
      );
    };
    dashboardBackend.writeRawFenced = async (_session, _instance, _generation, pane, data) => {
      await dashboardBackend.beforeWrite("raw", { pane, data: data.toString("utf8") });
    };
    const sent = await dashboardAuthority.handle(rawRequest(held.lease, "dashboard-repaired-input", "ok"));
    assert.equal(sent.accepted, true);
    assert.equal(dashboardBackend.resetCalls, 1);
    assert.deepEqual(dashboardBackend.writes, [{ kind: "raw", value: { pane: "0", data: "ok" } }]);
    const status = await dashboardAuthority.handle({
      protocolVersion: 1,
      requestId: "dashboard-after-repair",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "HELD");
    assert.equal(status.ownerKind, "dashboard");
  } finally {
    dashboardTemp.cleanup();
  }

  const feishuTemp = tempState();
  const feishuBackend = new FakeBackend();
  const feishuAuthority = new terminalControl.TerminalControlAuthority({
    statePath: feishuTemp.path,
    backend: feishuBackend,
  });
  try {
    const target = await resolved(feishuAuthority, "feishu-capture-strict");
    const held = await acquired(feishuAuthority, target.controlTargetId, owner("feishu", "binding:daemon"));
    feishuBackend.rawInputPosition = async () => {
      throw new terminalControl.TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture file is missing",
      );
    };
    feishuBackend.writeRawFenced = async () => {
      throw new Error("Feishu write must not run after lost output continuity");
    };
    await assert.rejects(
      feishuAuthority.handle(rawRequest(held.lease, "feishu-missing-capture", "blocked")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(feishuBackend.resetCalls, 0);
    const status = await feishuAuthority.handle({
      protocolVersion: 1,
      requestId: "feishu-after-capture-loss",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "feishu");
  } finally {
    feishuTemp.cleanup();
  }
});

test("same-name backend recreation gets a new target and tombstones the old target", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const first = await resolved(authority, "same-name");
    const lease = await acquired(authority, first.controlTargetId, owner("feishu", "binding-3:daemon-1"));
    backend.createdAt = "2026-07-13T00:01:00.000Z";
    backend.instance = "tmux-instance-2";
    const second = await resolved(authority, "same-name");
    assert.notEqual(second.controlTargetId, first.controlTargetId);
    const oldStatus = await authority.handle({
      protocolVersion: 1,
      requestId: "old-status",
      type: "ownership.status",
      controlTargetId: first.controlTargetId,
    });
    assert.equal(oldStatus.state, "TARGET_GONE");
    await assert.rejects(
      authority.handle(rawRequest(lease.lease, "old-target-input", "stale")),
      (error) => error.code === "TARGET_GONE",
    );
  } finally {
    temp.cleanup();
  }
});

test("lease renewal preserves liveness while expiry enters recovery instead of FREE", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  let clock = Date.parse("2026-07-13T00:00:00.000Z");
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    now: () => new Date(clock),
  });
  try {
    const target = await resolved(authority);
    const held = await authority.handle({
      protocolVersion: 1,
      requestId: "short-acquire",
      type: "lease.acquire",
      controlTargetId: target.controlTargetId,
      owner: owner("feishu", "binding-liveness:daemon-1"),
      ttlMs: terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS,
    });
    clock += terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS - 1;
    const renewed = await authority.handle({
      protocolVersion: 1,
      requestId: "renew-before-expiry",
      type: "lease.renew",
      lease: held.lease,
      ttlMs: terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS,
    });
    assert.notEqual(renewed.lease.expiresAt, held.lease.expiresAt);
    await authority.handle(rawRequest(held.lease, "old-expiry-view-after-renew", "still-live"));
    clock += terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS + 1;
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "expired-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "feishu");
    await assert.rejects(
      authority.handle(rawRequest(renewed.lease, "after-expiry", "must-not-write")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(backend.writes.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("an idle expired non-Feishu lease is fenced and safely returns to FREE", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  let clock = Date.parse("2026-07-13T00:00:00.000Z");
  const authority = new terminalControl.TerminalControlAuthority({
    statePath: temp.path,
    backend,
    now: () => new Date(clock),
  });
  try {
    const target = await resolved(authority);
    const dashboard = await authority.handle({
      protocolVersion: 1,
      requestId: "short-dashboard-acquire",
      type: "lease.acquire",
      controlTargetId: target.controlTargetId,
      owner: owner("dashboard", "mounted-hidden-pty"),
      ttlMs: terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS,
    });
    clock += terminalControl.TERMINAL_CONTROL_MIN_LEASE_TTL_MS + 1;
    const status = await authority.handle({
      protocolVersion: 1,
      requestId: "expired-dashboard-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "FREE");
    assert.equal(status.ownerKind, undefined);
    assert.equal(backend.resetCalls, 1, "safe abandonment must rebuild output capture");
    await assert.rejects(
      authority.handle(rawRequest(dashboard.lease, "expired-dashboard-input", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v1", "phone-after-expiry"));
    assert.equal(relay.ownership.state, "HELD");
    assert.equal(relay.ownership.ownerKind, "relay-v1");
  } finally {
    temp.cleanup();
  }
});

test("persisted idle non-Feishu recovery self-heals but uncertain operations and handoffs do not", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const dashboard = await acquired(authority, target.controlTargetId, owner("dashboard", "old-dashboard"));
    const state = terminalControl.loadTerminalControlState(temp.path);
    const record = state.targets[0];
    record.lifecycle = "RECOVERY_REQUIRED";
    record.ownership = {
      state: "FREE",
      fence: terminalControl.nextDecimal(record.ownership.fence),
    };
    record.recovery = {
      reason: "OUTPUT_CONTINUITY_UNCERTAIN",
      since: new Date().toISOString(),
      previousControlEpoch: state.controlEpoch,
      previousOwnerKind: "dashboard",
    };
    record.revision = terminalControl.nextDecimal(record.revision);
    record.updatedAt = new Date().toISOString();
    terminalControl.saveTerminalControlState(state, temp.path);

    const recovered = await authority.handle({
      protocolVersion: 1,
      requestId: "safe-recovery-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(recovered.state, "FREE");
    assert.equal(backend.resetCalls, 1);
    await assert.rejects(
      authority.handle(rawRequest(dashboard.lease, "old-recovery-lease", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );

    const current = await acquired(authority, target.controlTargetId, owner("feishu", "handoff-owner"));
    await authority.handle({
      protocolVersion: 1,
      requestId: "feishu-handoff",
      type: "handoff.begin",
      controlTargetId: target.controlTargetId,
      nextOwner: owner("dashboard", "next-owner"),
      currentLease: current.lease,
    });
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    await restarted.initializeContinuity();
    const persisted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(persisted.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(persisted.recovery.reason, "DRAIN_UNCERTAIN");
    const blocked = await restarted.handle({
      protocolVersion: 1,
      requestId: "handoff-restart-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(blocked.state, "RECOVERY_REQUIRED");
    await assert.rejects(
      acquired(restarted, target.controlTargetId, owner("dashboard", "must-not-auto-recover")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
  } finally {
    temp.cleanup();
  }
});

test("ambiguous backend identity enters recovery instead of tombstoning a possibly live target", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const held = await acquired(authority, target.controlTargetId, owner("dashboard", "identity-uncertain"));
    backend.failAssertUncertain = true;
    await assert.rejects(
      authority.handle(rawRequest(held.lease, "must-not-write-on-uncertain-identity", "blocked")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const stored = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(stored.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(stored.recovery.reason, "BACKEND_IDENTITY_UNCERTAIN");
    assert.equal(backend.writes.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("controller restart rotates epoch and fences held ownership until explicit recovery", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const firstAuthority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(firstAuthority);
    const feishu = await acquired(firstAuthority, target.controlTargetId, owner("feishu", "binding-restart:daemon-1"));
    const oldEpoch = feishu.lease.controlEpoch;
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    const newEpoch = await restarted.initializeContinuity();
    assert.notEqual(newEpoch, oldEpoch);
    const status = await restarted.handle({
      protocolVersion: 1,
      requestId: "status-after-restart",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "feishu");
    await assert.rejects(
      restarted.handle(rawRequest(feishu.lease, "old-epoch-input", "stale")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const recovered = await restarted.handle({
      protocolVersion: 1,
      requestId: "recover-after-restart",
      type: "handoff.force",
      controlTargetId: target.controlTargetId,
      expectedControlEpoch: newEpoch,
      nextOwner: owner("local-cli", "restart-recovery"),
      proof: {
        kind: "operator-acknowledged-in-doubt",
        recordId: "restart-recovery-1",
        recordedAt: new Date().toISOString(),
      },
      acknowledgeUncertainOperation: true,
    });
    assert.equal(recovered.ownership.state, "HELD");
    assert.equal(recovered.lease.controlEpoch, newEpoch);
    assert.notEqual(recovered.lease.fence, feishu.lease.fence);
  } finally {
    temp.cleanup();
  }
});

test("controller restart safely abandons an idle Dashboard lease and rebuilds capture", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const first = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(first);
    const dashboard = await acquired(first, target.controlTargetId, owner("dashboard", "stale-app-pty"));
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    const nextEpoch = await restarted.initializeContinuity();
    const interrupted = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(interrupted.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(interrupted.recovery.reason, "CONTROLLER_RESTARTED");
    assert.equal(interrupted.recovery.previousOwnerKind, "dashboard");

    const status = await restarted.handle({
      protocolVersion: 1,
      requestId: "dashboard-restart-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "FREE");
    assert.equal(status.controlEpoch, nextEpoch);
    assert.equal(backend.resetCalls, 1);
    await assert.rejects(
      restarted.handle(rawRequest(dashboard.lease, "old-dashboard-after-restart", "stale")),
      (error) => error.code === "PERMISSION_DENIED",
    );
    const next = await acquired(restarted, target.controlTargetId, owner("dashboard", "new-app-pty"));
    assert.equal(next.ownership.state, "HELD");
    assert.equal(next.lease.controlEpoch, nextEpoch);
  } finally {
    temp.cleanup();
  }
});

test("controller restart preserves an existing in-doubt operation instead of making it auto-recoverable", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
    const relay = await acquired(authority, target.controlTargetId, owner("relay-v2", "in-doubt-owner"));
    backend.failWrite = true;
    await assert.rejects(
      authority.handle(rawRequest(relay.lease, "persist-across-restart", "x")),
      (error) => error.code === "OPERATION_IN_DOUBT",
    );
    const restarted = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
    await restarted.initializeContinuity();
    const stored = terminalControl.loadTerminalControlState(temp.path).targets[0];
    assert.equal(stored.lifecycle, "RECOVERY_REQUIRED");
    assert.equal(stored.recovery.reason, "OPERATION_IN_DOUBT");
    assert.equal(stored.recovery.operationId, "persist-across-restart");
    const status = await restarted.handle({
      protocolVersion: 1,
      requestId: "in-doubt-after-restart-status",
      type: "ownership.status",
      controlTargetId: target.controlTargetId,
    });
    assert.equal(status.state, "RECOVERY_REQUIRED");
    assert.equal(status.ownerKind, "relay-v2");
    await assert.rejects(
      acquired(restarted, target.controlTargetId, owner("dashboard", "must-not-auto-recover")),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
  } finally {
    temp.cleanup();
  }
});

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

test("only a controlled local owner can cross the explicit force-recovery boundary", async () => {
  const temp = tempState();
  const backend = new FakeBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath: temp.path, backend });
  try {
    const target = await resolved(authority);
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
    assert.equal(opened.outputCursor, 0);
    const currentGeneration = opened.outputGeneration;

    const dashboard = await acquired(
      authority,
      controlTargetId,
      owner("dashboard", "legacy-open:pty-1"),
    );
    const marker = "TW_LEGACY_CAPTURE_CONTINUED";
    const accepted = await authority.handle({
      protocolVersion: 1,
      requestId: "legacy-continue-input",
      type: "input.agent-message",
      lease: dashboard.lease,
      operationId: "legacy-continue-input",
      pane: "0",
      message: `printf '${marker}\\n'`,
      submit: true,
    });
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
    assert.equal(opened.outputCursor, 0);
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
    const accepted = await authority.handle({
      protocolVersion: 1,
      requestId: "ring-output-input",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "ring-output-input",
      pane: "0",
      message: `${shellSingleQuote(process.execPath)} -e ${shellSingleQuote(script)}`,
      submit: true,
    });
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
      const chunk = await authority.handle({
        protocolVersion: 1,
        requestId: `ring-tail-${healthy.outputCursor}`,
        type: "output.tail",
        controlTargetId: target.controlTargetId,
        controlEpoch: accepted.controlEpoch,
        outputGeneration: originalGeneration,
        cursor,
        maxBytes: 4096,
      });
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
    const sent = await authority.handle({
      protocolVersion: 1,
      requestId: "real-tmux-agent-message",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "real-tmux-agent-message",
      pane: "0",
      message: "printf '[[notify-group]]real-output[[/notify-group]]\\n'",
      submit: true,
    });
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
    const renderedTurn = await authority.handle({
      protocolVersion: 1,
      requestId: "real-tmux-rendered-message",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "real-tmux-rendered-message",
      pane: "0",
      message: `printf '%s' '${renderedPayload}' | base64 -d`,
      submit: true,
    });
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
    const history = await authority.handle({
      protocolVersion: 1,
      requestId: "real-tmux-history",
      type: "input.agent-message",
      lease: feishu.lease,
      operationId: "real-tmux-history",
      pane: "0",
      message: "seq 1 200",
      submit: true,
    });
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
