import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { FeishuBridge, extractFeishuMarkedReply, feishuTurnMarkers } = await import("../dist/feishuBridge.js");
const {
  FeishuBridgeStore,
  feishuBridgePaths,
  feishuBridgeSocketPath,
} = await import("../dist/feishuBridgeStorage.js");
const { FeishuBridgeClient, FeishuBridgeServer } = await import("../dist/feishuBridgeServer.js");
const {
  CanonicalTerminalControlSocketClient,
  canonicalTerminalControlSocketPath,
} = await import("../dist/canonicalTerminalControlClient.js");
const {
  larkCliCommandArgs,
  parseFeishuBotOpenId,
  parseFeishuInboundEvent,
  parseFeishuMessageDetail,
} = await import("../dist/larkCliBridge.js");
const terminalControl = await import("../dist/terminalControl/index.js");

class JointTerminalBackend {
  constructor() {
    this.createdAt = "2026-07-13T00:00:00.000Z";
    this.instance = "joint-tmux-instance";
    this.writes = [];
    this.outputGeneration = undefined;
    this.nextOutputGeneration = 1;
    this.outputs = new Map();
  }

  async resolveManagedSession(sessionName) {
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
    assert.equal(session.createdAt, this.createdAt);
    assert.equal(instance, this.instance);
  }

  async writeRaw(_session, pane, data) {
    this.writes.push({ kind: "raw", pane, data: data.toString("utf8") });
  }

  async sendAgentMessage(_session, pane, message, submit) {
    this.writes.push({ kind: "agent-message", pane, message, submit });
  }

  async resize(_session, pane, cols, rows) {
    this.writes.push({ kind: "resize", pane, cols, rows });
  }

  async killManaged(session) {
    this.writes.push({ kind: "lifecycle-kill", session });
  }

  async prepareOutput(controlTargetId, _session, _pane, generation) {
    const next = generation ?? this.outputGeneration ?? `joint-output-${this.nextOutputGeneration++}`;
    this.outputGeneration = next;
    const key = `${controlTargetId}:${next}`;
    if (!this.outputs.has(key)) this.outputs.set(key, Buffer.alloc(0));
    return { generation: next, cursor: this.outputs.get(key).byteLength };
  }

  async resetOutput(controlTargetId) {
    const generation = `joint-output-${this.nextOutputGeneration++}`;
    this.outputGeneration = generation;
    this.outputs.set(`${controlTargetId}:${generation}`, Buffer.alloc(0));
    return { generation, cursor: 0 };
  }

  async tailOutput(controlTargetId, _session, _pane, generation, cursor, maxBytes) {
    const bytes = this.outputs.get(`${controlTargetId}:${generation}`);
    if (!bytes || generation !== this.outputGeneration || cursor > bytes.byteLength) {
      throw new terminalControl.TerminalControlProtocolError(
        "STALE_OUTPUT_CURSOR",
        "joint output cursor is stale",
      );
    }
    const chunk = bytes.subarray(cursor, cursor + maxBytes);
    return {
      generation,
      cursor,
      dataBase64: chunk.toString("base64"),
      nextCursor: cursor + chunk.byteLength,
    };
  }

  appendOutput(controlTargetId, text) {
    const key = `${controlTargetId}:${this.outputGeneration}`;
    const current = this.outputs.get(key) ?? Buffer.alloc(0);
    this.outputs.set(key, Buffer.concat([current, Buffer.from(text, "utf8")]));
  }
}
class FakeControlClient {
  constructor() {
    this.requests = [];
    this.inputs = [];
    this.output = "";
    this.failRelease = false;
    this.failRenew = false;
    this.tailFence = undefined;
    this.tailOwnerKind = undefined;
    this.tailChunkBytes = undefined;
    this.beforeInput = undefined;
    this.beforeCommit = undefined;
    this.failInputAfterCommit = false;
    this.outputGenerationSequence = 1;
    this.target = {
      controlEpoch: "epoch-one",
      controlTargetId: "ct-one",
      sessionName: "managed-one",
      state: "FREE",
      fence: "0",
      revision: "1",
      outputGeneration: "out-one",
    };
  }

  record(type, fields) {
    this.requests.push({ type, fields });
  }

  nextFence() {
    this.target.fence = (BigInt(this.target.fence) + 1n).toString();
    this.target.revision = (BigInt(this.target.revision) + 1n).toString();
  }

  rotateOutput() {
    this.outputGenerationSequence += 1;
    this.target.outputGeneration = `out-${this.outputGenerationSequence}`;
    this.output = "";
  }

  ownership() {
    return {
      controlTargetId: this.target.controlTargetId,
      controlEpoch: this.target.controlEpoch,
      state: this.target.state,
      fence: this.target.fence,
      revision: this.target.revision,
      outputGeneration: this.target.outputGeneration,
      outputCursor: Buffer.byteLength(this.output, "utf8"),
      ...(this.target.owner ? {
        ownerKind: this.target.owner.kind,
        leaseExpiresAt: this.target.expiresAt,
      } : {}),
      ...(this.target.handoff ? {
        handoffId: this.target.handoff.handoffId,
        nextOwnerKind: this.target.handoff.nextOwner.kind,
      } : {}),
    };
  }

  lease() {
    return {
      controlTargetId: this.target.controlTargetId,
      controlEpoch: this.target.controlEpoch,
      leaseId: this.target.leaseId,
      fence: this.target.fence,
      owner: structuredClone(this.target.owner),
      expiresAt: this.target.expiresAt,
    };
  }

  leaseResult() {
    return { lease: this.lease(), ownership: this.ownership() };
  }

  assertLease(lease, allowDraining = false) {
    if (lease.controlTargetId !== this.target.controlTargetId
      || lease.controlEpoch !== this.target.controlEpoch
      || lease.leaseId !== this.target.leaseId
      || lease.fence !== this.target.fence
      || lease.owner.kind !== this.target.owner?.kind
      || lease.owner.instanceId !== this.target.owner?.instanceId
      || (this.target.state !== "HELD" && !(allowDraining && this.target.state === "DRAINING"))) {
      const error = new Error("stale canonical lease");
      error.code = this.target.state === "DRAINING" && !allowDraining
        ? "HANDOFF_PENDING"
        : "PERMISSION_DENIED";
      throw error;
    }
  }

  async resolveTarget(sessionName) {
    this.record("target.resolve", { sessionName });
    if (sessionName !== this.target.sessionName) {
      const error = new Error("not managed");
      error.code = "TARGET_NOT_FOUND";
      throw error;
    }
    return {
      controlTargetId: this.target.controlTargetId,
      controlEpoch: this.target.controlEpoch,
      managedSession: {
        name: this.target.sessionName,
        kind: "terminal",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
      ownership: this.ownership(),
    };
  }

  async ownershipStatus(controlTargetId) {
    this.record("ownership.status", { controlTargetId });
    assert.equal(controlTargetId, this.target.controlTargetId);
    return this.ownership();
  }

  async acquireLease(controlTargetId, owner, ttlMs) {
    this.record("lease.acquire", { controlTargetId, owner, ...(ttlMs === undefined ? {} : { ttlMs }) });
    if (this.target.state === "HELD"
      && this.target.owner?.kind === owner.kind
      && this.target.owner?.instanceId === owner.instanceId) {
      return this.leaseResult();
    }
    if (this.target.state !== "FREE") {
      const error = new Error("owned");
      error.code = "PERMISSION_DENIED";
      throw error;
    }
    this.nextFence();
    this.target.state = "HELD";
    this.target.owner = structuredClone(owner);
    this.target.leaseId = `lease-${this.target.fence}`;
    this.target.expiresAt = new Date(Date.now() + 60_000).toISOString();
    return this.leaseResult();
  }

  async renewLease(lease, ttlMs) {
    this.record("lease.renew", { lease: structuredClone(lease), ...(ttlMs === undefined ? {} : { ttlMs }) });
    this.assertLease(lease, true);
    if (this.failRenew) {
      const error = new Error("lease renewal entered recovery");
      error.code = "RECOVERY_REQUIRED";
      throw error;
    }
    this.target.expiresAt = new Date(Date.now() + 60_000).toISOString();
    this.target.revision = (BigInt(this.target.revision) + 1n).toString();
    return this.leaseResult();
  }

  async releaseLease(lease) {
    this.record("lease.release", { lease: structuredClone(lease) });
    this.assertLease(lease);
    if (this.failRelease) throw new Error("release acknowledgement lost");
    this.rotateOutput();
    this.nextFence();
    this.target.state = "FREE";
    delete this.target.owner;
    delete this.target.leaseId;
    delete this.target.expiresAt;
    return this.ownership();
  }

  async beginHandoff(controlTargetId, nextOwner, currentLease) {
    this.record("handoff.begin", { controlTargetId, nextOwner, ...(currentLease ? { currentLease } : {}) });
    if (this.target.state === "DRAINING") {
      if (this.target.handoff.nextOwner.kind === nextOwner.kind
        && this.target.handoff.nextOwner.instanceId === nextOwner.instanceId) {
        return { ownership: this.ownership() };
      }
      const error = new Error("another handoff is pending");
      error.code = "HANDOFF_PENDING";
      throw error;
    }
    if (currentLease) this.assertLease(currentLease);
    else if (this.target.owner?.kind !== "feishu"
      || (nextOwner.kind !== "dashboard" && nextOwner.kind !== "local-cli")) {
      const error = new Error("lease-less handoff denied");
      error.code = "PERMISSION_DENIED";
      throw error;
    }
    this.target.state = "DRAINING";
    this.target.handoff = { handoffId: `handoff-${this.target.revision}`, nextOwner: structuredClone(nextOwner) };
    this.target.revision = (BigInt(this.target.revision) + 1n).toString();
    return { ownership: this.ownership() };
  }

  async commitHandoff(handoffId, currentLease, drain, ttlMs) {
    this.record("handoff.commit", {
      handoffId,
      currentLease: structuredClone(currentLease),
      drain: structuredClone(drain),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
    this.assertLease(currentLease, true);
    assert.equal(handoffId, this.target.handoff.handoffId);
    if (this.beforeCommit) await this.beforeCommit({ handoffId, currentLease, drain });
    if (drain.disposition === "uncertain") {
      this.nextFence();
      this.target.state = "RECOVERY_REQUIRED";
      delete this.target.owner;
      delete this.target.leaseId;
      delete this.target.expiresAt;
      delete this.target.handoff;
      const error = new Error("uncertain drain requires recovery");
      error.code = "RECOVERY_REQUIRED";
      throw error;
    }
    const nextOwner = this.target.handoff.nextOwner;
    this.rotateOutput();
    this.nextFence();
    this.target.state = "HELD";
    this.target.owner = nextOwner;
    this.target.leaseId = `lease-${this.target.fence}`;
    this.target.expiresAt = new Date(Date.now() + 60_000).toISOString();
    delete this.target.handoff;
    return this.leaseResult();
  }

  async cancelHandoff(handoffId, currentLease) {
    this.record("handoff.cancel", { handoffId, currentLease: structuredClone(currentLease) });
    this.assertLease(currentLease, true);
    assert.equal(this.target.state, "DRAINING");
    assert.equal(handoffId, this.target.handoff.handoffId);
    this.target.state = "HELD";
    delete this.target.handoff;
    this.target.revision = (BigInt(this.target.revision) + 1n).toString();
    return this.ownership();
  }

  async withdrawHandoff(controlTargetId, handoffId, nextOwner) {
    this.record("handoff.withdraw", { controlTargetId, handoffId, nextOwner: structuredClone(nextOwner) });
    if (this.target.state !== "DRAINING"
      || this.target.handoff.handoffId !== handoffId
      || this.target.handoff.nextOwner.kind !== nextOwner.kind
      || this.target.handoff.nextOwner.instanceId !== nextOwner.instanceId) {
      const error = new Error("only exact next owner may withdraw");
      error.code = "PERMISSION_DENIED";
      throw error;
    }
    this.target.state = "HELD";
    delete this.target.handoff;
    this.target.revision = (BigInt(this.target.revision) + 1n).toString();
    return this.ownership();
  }

  recoverLocally(nextOwner = { kind: "dashboard", instanceId: "dashboard:recovery:pty-one" }) {
    this.rotateOutput();
    this.nextFence();
    this.target.state = "HELD";
    this.target.owner = structuredClone(nextOwner);
    this.target.leaseId = `lease-${this.target.fence}`;
    this.target.expiresAt = new Date(Date.now() + 60_000).toISOString();
    delete this.target.handoff;
    return this.lease();
  }

  async sendAgentMessage(input) {
    this.record("input.agent-message", structuredClone(input));
    if (this.beforeInput) await this.beforeInput(input);
    this.assertLease(input.lease);
    this.inputs.push(structuredClone(input));
    if (this.failInputAfterCommit) {
      const error = new Error("canonical terminal-control closed before replying");
      error.code = "CONTROLLER_UNAVAILABLE";
      throw error;
    }
    return {
      operationId: input.operationId,
      accepted: true,
      deduplicated: false,
      controlEpoch: this.target.controlEpoch,
      fence: this.target.fence,
      outputGeneration: this.target.outputGeneration,
      outputCursor: Buffer.byteLength(this.output, "utf8"),
    };
  }

  async tailOutput(input) {
    this.record("output.tail", structuredClone(input));
    if (input.controlEpoch !== this.target.controlEpoch) {
      const error = new Error("stale output epoch");
      error.code = "RECOVERY_REQUIRED";
      throw error;
    }
    if (input.outputGeneration !== this.target.outputGeneration) {
      const error = new Error("stale output generation");
      error.code = "STALE_OUTPUT_CURSOR";
      throw error;
    }
    const source = Buffer.from(this.output, "utf8");
    const maxBytes = Math.min(input.maxBytes, this.tailChunkBytes ?? input.maxBytes);
    const data = source.subarray(input.cursor, input.cursor + maxBytes);
    return {
      controlTargetId: this.target.controlTargetId,
      controlEpoch: this.target.controlEpoch,
      fence: this.tailFence ?? this.target.fence,
      ownerKind: this.tailOwnerKind ?? this.target.owner?.kind,
      outputGeneration: this.target.outputGeneration,
      cursor: input.cursor,
      dataBase64: data.toString("base64"),
      nextCursor: input.cursor + data.length,
    };
  }
}

class FakeLark {
  constructor() {
    this.details = new Map();
    this.replies = [];
    this.failReply = false;
  }

  subscribe() {
    return { child: undefined, done: new Promise(() => {}), stop() {} };
  }

  async messageDetail(messageId) {
    return this.details.get(messageId) ?? {
      senderId: "ou-owner",
      senderType: "user",
      mentionedIds: ["ou-bot"],
      text: "please inspect",
    };
  }

  async reply(messageId, text, idempotencyKey) {
    this.replies.push({ messageId, text, idempotencyKey });
    if (this.failReply) throw new Error("reply acknowledgement lost");
    return { messageId: `reply-${this.replies.length}`, raw: {} };
  }

  async listGroups() {
    return [{ chatId: "oc-one", name: "bridge group" }];
  }

  async botOpenId() {
    return "ou-bot";
  }
}

function event(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    event_id: "evt-one",
    message_id: "om-one",
    chat_id: "oc-one",
    chat_type: "group",
    message_type: "text",
    sender_id: "ou-owner",
    content: "@bot please inspect",
    ...overrides,
  };
}

function harness(options = {}) {
  const root = mkdtempSync(join("/tmp", "tw-fb-"));
  const paths = feishuBridgePaths(root);
  const control = new FakeControlClient();
  const lark = new FakeLark();
  const store = new FeishuBridgeStore(paths);
  const bridge = new FeishuBridge({
    control,
    lark,
    store,
    instanceId: "daemon-one",
    botOpenId: "ou-bot",
    ...(options.now ? { now: options.now } : {}),
  });
  return { root, paths, control, lark, store, bridge };
}

function currentTurn(h) {
  return h.store.read().turns.at(-1);
}

function marked(h, text) {
  const turn = currentTurn(h);
  const markers = feishuTurnMarkers(turn.markerNonce);
  return `${markers.open}${text}${markers.close}`;
}

test("canonical socket path matches Relay long-HOME fallback semantics", () => {
  const configured = process.env.TW_TERMINAL_CONTROL_SOCKET;
  delete process.env.TW_TERMINAL_CONTROL_SOCKET;
  try {
    assert.equal(
      canonicalTerminalControlSocketPath("/short-home"),
      join("/short-home", ".tmux-worktree", "terminal-control-v1.sock"),
    );
    const longHome = join(tmpdir(), "canonical-home-".repeat(20));
    const first = canonicalTerminalControlSocketPath(longHome);
    assert.equal(first, canonicalTerminalControlSocketPath(longHome));
    assert.match(first, /tw-terminal-control-[0-9a-f]{16}\/v1\.sock$/);
    assert.ok(Buffer.byteLength(first, "utf8") <= 100);
    const bridge = feishuBridgeSocketPath(longHome);
    assert.equal(bridge, feishuBridgeSocketPath(longHome));
    assert.match(bridge, /tw-feishu-bridge-[0-9a-f]{16}\/v1\.sock$/);
    assert.ok(Buffer.byteLength(bridge, "utf8") <= 100);
  } finally {
    if (configured === undefined) delete process.env.TW_TERMINAL_CONTROL_SOCKET;
    else process.env.TW_TERMINAL_CONTROL_SOCKET = configured;
  }
});

test("canonical terminal client emits Relay envelopes and preserves output correlation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-canonical-client-"));
  const socketPath = join(root, "control.sock");
  const requests = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline));
      requests.push(request);
      const result = request.type === "input.agent-message"
        ? {
            operationId: request.operationId,
            accepted: true,
            deduplicated: false,
            controlEpoch: request.lease.controlEpoch,
            fence: request.lease.fence,
            outputGeneration: "out-canonical",
            outputCursor: 17,
          }
        : request.type === "output.tail" ? {
            controlTargetId: request.controlTargetId,
            controlEpoch: request.controlEpoch,
            fence: "9",
            ownerKind: "feishu",
            outputGeneration: request.outputGeneration,
            cursor: request.cursor,
            dataBase64: Buffer.from("answer", "utf8").toString("base64"),
            nextCursor: 23,
          } : {
            controlTargetId: lease.controlTargetId,
            controlEpoch: lease.controlEpoch,
            state: "HELD",
            fence: lease.fence,
            revision: "12",
            ownerKind: "feishu",
            leaseExpiresAt: lease.expiresAt,
            outputGeneration: "out-canonical",
            outputCursor: 23,
          };
      socket.end(`${JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: true,
        result,
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const lease = {
    controlTargetId: "target-canonical",
    controlEpoch: "epoch-canonical",
    leaseId: "lease-canonical",
    fence: "9",
    owner: { kind: "feishu", instanceId: "feishu-binding:one:daemon" },
    expiresAt: "2026-07-13T01:00:00.000Z",
  };
  try {
    const client = new CanonicalTerminalControlSocketClient({ socketPath });
    const accepted = await client.sendAgentMessage({
      lease,
      operationId: "operation-one",
      pane: "0",
      message: "body",
      submit: true,
    });
    assert.equal(accepted.outputGeneration, "out-canonical");
    assert.equal(accepted.outputCursor, 17);
    const output = await client.tailOutput({
      controlTargetId: lease.controlTargetId,
      controlEpoch: lease.controlEpoch,
      outputGeneration: accepted.outputGeneration,
      cursor: accepted.outputCursor,
      maxBytes: 64,
    });
    assert.equal(Buffer.from(output.dataBase64, "base64").toString("utf8"), "answer");
    assert.equal(output.nextCursor, 23);
    assert.equal(output.fence, "9");
    assert.equal(output.ownerKind, "feishu");
    assert.equal(requests[0].type, "input.agent-message");
    assert.equal(requests[0].lease.fence, "9");
    assert.deepEqual(requests[0].lease.owner, lease.owner);
    assert.equal(Object.hasOwn(requests[0], "operation"), false);
    assert.equal(Object.hasOwn(requests[0], "params"), false);
    assert.deepEqual(requests[1], {
      protocolVersion: 1,
      requestId: requests[1].requestId,
      type: "output.tail",
      controlTargetId: "target-canonical",
      controlEpoch: "epoch-canonical",
      outputGeneration: "out-canonical",
      cursor: 17,
      maxBytes: 64,
    });
    await client.cancelHandoff("handoff-one", lease);
    await client.withdrawHandoff(
      lease.controlTargetId,
      "handoff-two",
      { kind: "local-cli", instanceId: "local-one" },
    );
    assert.deepEqual(requests[2], {
      protocolVersion: 1,
      requestId: requests[2].requestId,
      type: "handoff.cancel",
      handoffId: "handoff-one",
      currentLease: lease,
    });
    assert.deepEqual(requests[3], {
      protocolVersion: 1,
      requestId: requests[3].requestId,
      type: "handoff.withdraw",
      controlTargetId: lease.controlTargetId,
      handoffId: "handoff-two",
      nextOwner: { kind: "local-cli", instanceId: "local-one" },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("real terminal-control authority and Feishu bridge share one fenced writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-feishu-joint-"));
  const statePath = join(root, "terminal-control-state-v1.json");
  const socketPath = join(root, "terminal-control-v1.sock");
  const backend = new JointTerminalBackend();
  const authority = new terminalControl.TerminalControlAuthority({ statePath, backend });
  const abort = new AbortController();
  const serving = terminalControl.runTerminalControlServer({
    socketPath,
    authority,
    signal: abort.signal,
  });
  let bridge;
  try {
    const deadline = Date.now() + 2_000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(socketPath), "terminal-control server did not become ready");
    const client = new CanonicalTerminalControlSocketClient({ socketPath, timeoutMs: 2_000 });
    const target = await client.resolveTarget("managed-joint");
    const initialDashboard = await client.acquireLease(target.controlTargetId, {
      kind: "dashboard",
      instanceId: "dashboard:joint:initial",
    });
    const lark = new FakeLark();
    const store = new FeishuBridgeStore(feishuBridgePaths(root));
    bridge = new FeishuBridge({
      control: client,
      lark,
      store,
      instanceId: "feishu-joint-daemon",
      botOpenId: "ou-bot",
    });
    const binding = await bridge.createBinding({
      chatId: "oc-one",
      chatName: "joint bridge group",
      sessionName: "managed-joint",
      createdBy: "ou-owner",
      dashboardLease: initialDashboard.lease,
    });
    const feishuLease = structuredClone(bridge.leases.get(binding.id));
    assert.equal(feishuLease.owner.kind, "feishu");
    assert.notEqual(feishuLease.fence, initialDashboard.lease.fence);

    await assert.rejects(
      terminalControl.requestTerminalControl({
        type: "input.raw",
        lease: initialDashboard.lease,
        operationId: "joint-old-dashboard-input",
        pane: "0",
        dataBase64: Buffer.from("must-not-write", "utf8").toString("base64"),
      }, { socketPath, autoStart: false }),
      (error) => error?.code === "PERMISSION_DENIED",
    );
    assert.equal(backend.writes.length, 0);

    await bridge.handleEvent(event({ event_id: "evt-joint", message_id: "om-joint" }));
    assert.equal(backend.writes.filter(({ kind }) => kind === "agent-message").length, 1);
    const turn = store.read().turns.at(-1);
    const markers = feishuTurnMarkers(turn.markerNonce);
    backend.appendOutput(target.controlTargetId, `${markers.open}joint answer${markers.close}`);
    await bridge.pollTurns();
    assert.deepEqual(lark.replies.map(({ messageId, text }) => ({ messageId, text })), [
      { messageId: "om-joint", text: "joint answer" },
    ]);

    const dashboardLease = await bridge.takeoverBinding(
      binding.id,
      "dashboard:joint:takeover",
    );
    const ownership = await client.ownershipStatus(target.controlTargetId);
    assert.equal(ownership.state, "HELD");
    assert.equal(ownership.ownerKind, "dashboard");
    assert.equal(ownership.fence, dashboardLease.fence);
    await assert.rejects(
      client.sendAgentMessage({
        lease: feishuLease,
        operationId: "joint-old-feishu-input",
        pane: "0",
        message: "must-not-write",
        submit: true,
      }),
      (error) => error?.code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      client.tailOutput({
        controlTargetId: target.controlTargetId,
        controlEpoch: turn.controlEpoch,
        outputGeneration: turn.outputGeneration,
        cursor: turn.cursor,
        maxBytes: 64,
      }),
      (error) => error?.code === "STALE_OUTPUT_CURSOR",
    );
    assert.equal(backend.writes.filter(({ kind }) => kind === "agent-message").length, 1);
    assert.equal(lark.replies.length, 1);
  } finally {
    if (bridge) await bridge.close();
    abort.abort();
    await serving.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("Lark CLI bridge pins every command to an explicitly selected profile", () => {
  const command = ["im", "+messages-mget", "--message-ids", "om_one", "--as", "bot"];
  assert.deepEqual(larkCliCommandArgs(command, "bot"), ["--profile", "bot", ...command]);
  assert.deepEqual(larkCliCommandArgs(command), command);
  assert.notEqual(larkCliCommandArgs(command), command, "command arguments must be copied");
  assert.throws(() => larkCliCommandArgs(command, ""), /invalid lark-cli profile/);
  assert.throws(() => larkCliCommandArgs(command, "bad\0profile"), /invalid lark-cli profile/);
  assert.equal(parseFeishuBotOpenId({
    ok: true,
    identities: { bot: { status: "ready", openId: "ou_bot_profile" } },
  }), "ou_bot_profile");
});

test("Feishu event and message detail parsers keep the verified routing fields", () => {
  assert.equal(parseFeishuInboundEvent(event()).event_id, "evt-one");
  const detail = parseFeishuMessageDetail({
    data: {
      items: [{
        sender: { sender_type: "user", sender_id: { open_id: "ou-owner" } },
        mentions: [{ id: { open_id: "ou-bot" } }],
        body: { content: JSON.stringify({ text: "hello" }) },
      }],
    },
  });
  assert.equal(detail.senderId, "ou-owner");
  assert.equal(detail.senderType, "user");
  assert.deepEqual(detail.mentionedIds, ["ou-bot"]);
  assert.equal(detail.text, "hello");
  const markers = feishuTurnMarkers("nonce-one");
  assert.deepEqual(extractFeishuMarkedReply(
    `noise\n\x1b[31m${markers.open}public answer${markers.close}`,
    "nonce-one",
  ), {
    reply: "public answer",
    complete: true,
  });
});

test("one authorized mentioned message owns the target, writes once, and posts only marked output", async () => {
  const h = harness();
  try {
    const binding = await h.bridge.createBinding({
      chatId: "oc-one",
      chatName: "bridge group",
      sessionName: "managed-one",
      createdBy: "ou-owner",
    });
    assert.equal(binding.status, "active");
    assert.equal(h.control.target.owner.kind, "feishu");

    await h.bridge.handleEvent(event());
    await h.bridge.handleEvent(event());
    assert.equal(h.control.inputs.length, 1, "event dedup must prevent a second terminal operation");
    const turn = currentTurn(h);
    const markers = feishuTurnMarkers(turn.markerNonce);
    assert.equal(h.control.inputs[0].message.includes(markers.open), false, "prompt echo must not contain the parser token");
    assert.equal(h.control.inputs[0].message.includes(markers.close), false, "prompt echo must not contain the parser token");
    assert.equal(h.control.inputs[0].submit, true, "prompt body and submit must be one canonical operation");
    assert.equal(h.lark.replies.length, 0);

    h.control.output += `tool trace\n${marked(h, "safe group answer")}\nprivate tail`;
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.length, 1);
    assert.equal(h.lark.replies[0].text, "safe group answer");
    assert.equal(h.bridge.snapshot().activeTurns.length, 0);

    const persisted = h.store.read();
    assert.equal(persisted.turns.at(-1).status, "completed");
    assert.equal(persisted.replies.at(-1).status, "sent");
    for (const path of [h.paths.bindings, h.paths.dedup, h.paths.turns, h.paths.replies]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("agent-message output correlation, not a pre-input inspect cursor, starts the Feishu turn", async () => {
  const h = harness();
  try {
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    const oldMarkers = feishuTurnMarkers("old-turn-nonce");
    h.control.output = `${oldMarkers.open}old answer must stay private${oldMarkers.close}\n`;
    const expectedCursor = Buffer.byteLength(h.control.output, "utf8");
    await h.bridge.handleEvent(event());
    const prepared = h.store.read().turns.at(-1);
    assert.equal(prepared.cursor, expectedCursor);
    assert.equal(prepared.outputGeneration, "out-one");

    h.control.output += `${marked(h, "new correlated answer")}\n`;
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.length, 1);
    assert.equal(h.lark.replies[0].text, "new correlated answer");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("Dashboard binding creation atomically hands its lease to Feishu and requires a closed reply marker", async () => {
  const h = harness();
  try {
    h.control.target.state = "HELD";
    h.control.target.owner = { kind: "dashboard", instanceId: "dashboard-one:pty-one" };
    h.control.target.leaseId = "lease-dashboard";
    h.control.target.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const dashboardLease = h.control.lease();
    let persistedBeforeCommit;
    h.control.beforeCommit = () => {
      persistedBeforeCommit = h.store.read().bindings[0].handoff;
      assert.equal(persistedBeforeCommit.status, "prepared");
      assert.equal(persistedBeforeCommit.drain.disposition, "drained");
    };
    const binding = await h.bridge.createBinding({
      chatId: "oc-one",
      chatName: "bridge group",
      sessionName: "managed-one",
      createdBy: "ou-owner",
      dashboardLease,
    });
    assert.equal(binding.status, "active");
    assert.equal(h.control.target.owner.kind, "feishu");
    assert.equal(h.control.target.fence, "1");
    assert.equal(h.control.requests.filter(({ type }) => type === "lease.acquire").length, 0);
    assert.deepEqual(
      h.control.requests.filter(({ type }) => type.startsWith("handoff.")).map(({ type }) => type),
      ["handoff.begin", "handoff.commit"],
    );
    const commit = h.control.requests.find(({ type }) => type === "handoff.commit");
    assert.equal(commit.fields.drain.disposition, "drained");
    assert.match(commit.fields.drain.recordId, /^binding:/);
    assert.equal(persistedBeforeCommit.handoffId, commit.fields.handoffId);
    assert.equal(h.store.read().bindings[0].handoff.status, "committed");

    await h.bridge.handleEvent(event());
    const markers = feishuTurnMarkers(currentTurn(h).markerNonce);
    h.control.output = `${markers.open}incomplete private tail`;
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.length, 0, "an unterminated marker must never be sent to the group");
    h.control.output += markers.close;
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies[0].text, "incomplete private tail");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("an uncertain lease release leaves the binding stale instead of pretending to be paused", async () => {
  const h = harness();
  try {
    const binding = await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    h.control.failRelease = true;
    await assert.rejects(h.bridge.pauseBinding(binding.id), /release acknowledgement lost/);
    assert.equal(h.store.read().bindings[0].status, "stale");
  } finally {
    h.control.failRelease = false;
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("lease renewal carries the full canonical token and failure fences an active turn", async () => {
  const h = harness();
  try {
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.renewLeases();
    const renewal = h.control.requests.find(({ type }) => type === "lease.renew");
    assert.equal(typeof renewal.fields.lease.fence, "string");
    assert.equal(renewal.fields.lease.owner.kind, "feishu");
    assert.match(renewal.fields.lease.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

    await h.bridge.handleEvent(event());
    h.control.failRenew = true;
    await h.bridge.renewLeases();
    h.control.output += marked(h, "late after renewal failure");
    await h.bridge.pollTurns();
    const state = h.store.read();
    assert.equal(state.bindings[0].status, "stale");
    assert.equal(state.turns.at(-1).status, "recovery-required");
    assert.equal(h.lark.replies.length, 0);
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("external local takeover renews while DRAINING, drains an active turn, then commits", async () => {
  const h = harness();
  try {
    const binding = await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.handleEvent(event());
    const localOwner = { kind: "local-cli", instanceId: "local-cli:external-one" };
    const pending = await h.control.beginHandoff(binding.controlTargetId, localOwner);
    assert.equal(pending.ownership.state, "DRAINING");

    await h.bridge.renewLeases();
    const renewal = h.control.requests.filter(({ type }) => type === "lease.renew").at(-1);
    assert.equal(renewal.fields.lease.fence, h.control.target.fence);
    assert.equal(h.store.read().bindings[0].status, "active");

    let persistedDrain;
    h.control.beforeCommit = () => {
      persistedDrain = h.store.read().bindings[0].handoff;
      assert.equal(persistedDrain.status, "prepared");
    };
    h.control.output += marked(h, "settled before local control");
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.at(-1).text, "settled before local control");
    assert.equal(h.control.target.state, "DRAINING", "reply completion alone must not transfer authority");

    await h.bridge.reconcileHandoffs();
    assert.equal(persistedDrain.nextOwnerKind, "local-cli");
    assert.equal(h.control.target.state, "HELD");
    assert.equal(h.control.target.owner.kind, "local-cli");
    assert.equal(h.store.read().bindings[0].status, "paused");
    assert.equal(h.store.read().bindings[0].handoff.status, "committed");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("exact pending next owner may withdraw and the Feishu lease continues unchanged", async () => {
  const h = harness();
  try {
    const binding = await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.handleEvent(event());
    const originalFence = h.control.target.fence;
    const localOwner = { kind: "dashboard", instanceId: "dashboard:external:pty-one" };
    const pending = await h.control.beginHandoff(binding.controlTargetId, localOwner);
    await assert.rejects(
      h.control.withdrawHandoff(
        binding.controlTargetId,
        pending.ownership.handoffId,
        { kind: "dashboard", instanceId: "dashboard:wrong" },
      ),
      /exact next owner/,
    );
    await h.control.withdrawHandoff(binding.controlTargetId, pending.ownership.handoffId, localOwner);
    await h.bridge.reconcileHandoffs();
    await h.bridge.renewLeases();
    assert.equal(h.control.target.state, "HELD");
    assert.equal(h.control.target.owner.kind, "feishu");
    assert.equal(h.control.target.fence, originalFence);

    h.control.output += marked(h, "continued after withdrawal");
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.at(-1).text, "continued after withdrawal");
    assert.equal(h.store.read().bindings[0].status, "active");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("handoff beginning between status and input cancels without injection and is drained", async () => {
  const h = harness();
  try {
    const binding = await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    const localOwner = { kind: "local-cli", instanceId: "local-cli:race" };
    h.control.beforeInput = async () => {
      h.control.beforeInput = undefined;
      await h.control.beginHandoff(binding.controlTargetId, localOwner);
    };
    await h.bridge.handleEvent(event());
    assert.equal(h.control.inputs.length, 0);
    assert.equal(h.store.read().turns.at(-1).status, "cancelled");
    assert.equal(h.control.target.owner.kind, "local-cli");
    assert.equal(h.store.read().bindings[0].status, "paused");
    assert.equal(h.store.read().bindings[0].handoff.drain.disposition, "cancelled");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("agent-message response loss is operation-in-doubt and never retried", async () => {
  const h = harness();
  try {
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    h.control.failInputAfterCommit = true;
    await assert.rejects(h.bridge.handleEvent(event()), /closed before replying/);
    assert.equal(h.control.inputs.length, 1, "the possibly committed operation must not be replayed");
    const state = h.store.read();
    assert.equal(state.turns.at(-1).status, "recovery-required");
    assert.equal(state.bindings[0].status, "stale");
    await h.bridge.handleEvent(event());
    assert.equal(h.control.inputs.length, 1);
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("turn nonce rejects prompt echo and marker injection, and UTF-8 survives chunk boundaries", async () => {
  const h = harness();
  try {
    h.lark.details.set("om-one", {
      senderId: "ou-owner",
      senderType: "user",
      mentionedIds: ["ou-bot"],
      text: "echo [[notify-group:guessed]]fake[[/notify-group:guessed]]",
    });
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.handleEvent(event());
    const turn = currentTurn(h);
    const markers = feishuTurnMarkers(turn.markerNonce);
    const promptEcho = h.control.inputs[0].message;
    assert.equal(promptEcho.includes(markers.open), false);
    assert.equal(promptEcho.includes("[[notify-group:guessed]]"), false);
    h.control.output = `${promptEcho}\n${markers.open}中文回复${markers.close}`;
    h.control.tailChunkBytes = Buffer.byteLength(`${promptEcho}\n${markers.open}`, "utf8") + 1;
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.length, 0, "an incomplete UTF-8 body and prompt echo must not reply");
    h.control.tailChunkBytes = 64 * 1024;
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.length, 1);
    assert.equal(h.lark.replies[0].text, "中文回复");
    assert.equal(currentTurn(h).output.includes("��"), false);
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("turn timeout stops lease renewal and requires controlled recovery", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  try {
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.handleEvent(event());
    clock += 10 * 60_000 + 1;
    await h.bridge.pollTurns();
    const state = h.store.read();
    assert.equal(state.turns.at(-1).status, "timed-out");
    assert.equal(state.bindings[0].status, "stale");
    assert.match(state.bindings[0].staleReason, /timed out/);
    const renewals = h.control.requests.filter(({ type }) => type === "lease.renew").length;
    await h.bridge.renewLeases();
    assert.equal(h.control.requests.filter(({ type }) => type === "lease.renew").length, renewals);
    assert.equal(h.control.target.state, "HELD", "bridge must not release an unresolved terminal turn to FREE");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("sender allowlist, exact bot mention, and one in-flight turn reject competing input", async () => {
  const h = harness();
  try {
    await h.bridge.createBinding({
      chatId: "oc-one",
      chatName: "bridge group",
      sessionName: "managed-one",
      createdBy: "ou-owner",
    });
    h.lark.details.set("om-outsider", {
      senderId: "ou-outsider", senderType: "user", mentionedIds: ["ou-bot"], text: "bad",
    });
    await h.bridge.handleEvent(event({ event_id: "evt-outsider", message_id: "om-outsider", sender_id: "ou-outsider" }));
    h.lark.details.set("om-wrong-mention", {
      senderId: "ou-owner", senderType: "user", mentionedIds: ["ou-someone"], text: "not for bot",
    });
    await h.bridge.handleEvent(event({ event_id: "evt-wrong", message_id: "om-wrong-mention" }));
    assert.equal(h.control.inputs.length, 0);

    await h.bridge.handleEvent(event());
    await h.bridge.handleEvent(event({ event_id: "evt-two", message_id: "om-two" }));
    assert.equal(h.control.inputs.length, 1);
    assert.equal(h.lark.replies.length, 1);
    assert.match(h.lark.replies[0].text, /上一条群消息/);
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("late output after a fence change and uncertain Feishu ACK fail closed", async () => {
  const h = harness();
  try {
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.handleEvent(event());
    h.control.output = marked(h, "must not escape");
    h.control.target.fence = (BigInt(h.control.target.fence) + 1n).toString();
    h.control.target.leaseId = "new-lease";
    await h.bridge.pollTurns();
    assert.equal(h.lark.replies.length, 0);
    assert.equal(h.store.read().turns.at(-1).status, "recovery-required");
    assert.equal(h.store.read().bindings[0].status, "stale");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }

  const uncertain = harness();
  try {
    await uncertain.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await uncertain.bridge.handleEvent(event());
    uncertain.control.output = marked(uncertain, "possibly sent");
    uncertain.lark.failReply = true;
    await uncertain.bridge.pollTurns();
    const state = uncertain.store.read();
    assert.equal(state.replies.at(-1).status, "uncertain");
    assert.equal(state.turns.at(-1).status, "recovery-required");
    assert.equal(state.bindings[0].status, "stale");
  } finally {
    await uncertain.bridge.close();
    rmSync(uncertain.root, { recursive: true, force: true });
  }
});

test("late controller epoch or output generation never posts a marked reply", async () => {
  for (const scenario of [
    { name: "epoch", mutate: (control) => { control.target.controlEpoch = "epoch-late"; } },
    { name: "generation", mutate: (control) => { control.target.outputGeneration = "out-late"; } },
  ]) {
    const h = harness();
    try {
      await h.bridge.createBinding({
        chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
      });
      await h.bridge.handleEvent(event());
      h.control.output = marked(h, `late ${scenario.name}`);
      scenario.mutate(h.control);
      await h.bridge.pollTurns();
      assert.equal(h.lark.replies.length, 0, scenario.name);
      assert.equal(h.store.read().turns.at(-1).status, "recovery-required", scenario.name);
      assert.equal(h.store.read().bindings[0].status, "stale", scenario.name);
    } finally {
      await h.bridge.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  }
});

test("tail response fence and ownerKind are checked before marked output can reply", async () => {
  for (const scenario of [
    { name: "fence", mutate: (control) => { control.tailFence = "999"; } },
    { name: "ownerKind", mutate: (control) => { control.tailOwnerKind = "dashboard"; } },
  ]) {
    const h = harness();
    try {
      await h.bridge.createBinding({
        chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
      });
      await h.bridge.handleEvent(event());
      h.control.output = marked(h, `bad ${scenario.name} tail`);
      scenario.mutate(h.control);
      await h.bridge.pollTurns();
      assert.equal(h.lark.replies.length, 0, scenario.name);
      assert.equal(h.store.read().turns.at(-1).status, "recovery-required", scenario.name);
      assert.equal(h.store.read().bindings[0].status, "stale", scenario.name);
    } finally {
      await h.bridge.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  }
});

test("explicit takeover cancellation drains before normal handoff and return reverses ownership", async () => {
  const h = harness();
  try {
    const binding = await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    await h.bridge.handleEvent(event());
    await assert.rejects(
      h.bridge.takeoverBinding(binding.id, "dashboard-one:pty-one"),
      /Feishu turn is active/,
    );
    assert.equal(h.control.target.owner.kind, "feishu");
    const dashboardLease = await h.bridge.takeoverBinding(
      binding.id,
      "dashboard-one:pty-one",
      true,
    );
    assert.equal(h.control.target.owner.kind, "dashboard");
    assert.equal(h.control.target.fence, "2");
    assert.equal(h.store.read().turns.at(-1).status, "cancelled");
    assert.equal(h.store.read().bindings[0].status, "paused");

    await h.bridge.returnBinding(binding.id, dashboardLease);
    assert.equal(h.control.target.owner.kind, "feishu");
    assert.equal(h.control.target.fence, "3");
    assert.equal(h.store.read().bindings[0].status, "active");
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("restart recovery stays stale until a controlled local owner returns the lease", async () => {
  const h = harness();
  try {
    await h.bridge.createBinding({
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    const acquireCount = h.control.requests.filter(({ type }) => type === "lease.acquire").length;
    const restarted = new FeishuBridge({
      control: h.control,
      lark: h.lark,
      store: h.store,
      instanceId: "daemon-two",
      botOpenId: "ou-bot",
    });
    restarted.initializeAfterRestart();
    assert.equal(restarted.snapshot().bindings[0].status, "stale");
    assert.equal(
      h.control.requests.filter(({ type }) => type === "lease.acquire").length,
      acquireCount,
    );
    h.control.target.controlEpoch = "epoch-two";
    h.control.target.state = "RECOVERY_REQUIRED";
    h.control.nextFence();
    delete h.control.target.owner;
    delete h.control.target.leaseId;
    delete h.control.target.expiresAt;
    const repaired = await restarted.repairBinding("bind-does-not-exist").catch((error) => error);
    assert.match(String(repaired), /binding not found/);
    const bindingId = restarted.snapshot().bindings[0].id;
    const stillStale = await restarted.repairBinding(bindingId);
    assert.equal(stillStale.status, "stale");
    assert.match(stillStale.staleReason, /controlled local owner/);
    assert.equal(h.control.requests.some(({ type }) => type === "handoff.force"), false);

    const localLease = h.control.recoverLocally();
    assert.equal((await restarted.repairBinding(bindingId)).status, "stale");
    assert.match(restarted.snapshot().bindings[0].staleReason, /Return to Feishu/);
    assert.equal((await restarted.returnBinding(bindingId, localLease)).status, "active");
    assert.equal(h.control.target.owner.kind, "feishu");
    assert.deepEqual(
      h.control.requests.filter(({ type }) => type.startsWith("handoff.")).map(({ type }) => type),
      ["handoff.begin", "handoff.commit"],
    );
  } finally {
    await h.bridge.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("Feishu bridge UDS is private and exposes closed management operations", async () => {
  const h = harness();
  const server = await FeishuBridgeServer.create({
    paths: h.paths,
    control: h.control,
    lark: h.lark,
    botOpenId: "ou-bot",
  });
  try {
    await server.start();
    assert.equal(statSync(h.paths.socket).mode & 0o777, 0o600);
    const client = new FeishuBridgeClient(h.paths.socket);
    const snapshot = await client.request("bridge.snapshot", {});
    assert.deepEqual(snapshot.bindings, []);
    assert.deepEqual(await client.request("groups.list", {}), [
      { chatId: "oc-one", name: "bridge group" },
    ]);
    const binding = await client.request("binding.create", {
      chatId: "oc-one", chatName: "bridge group", sessionName: "managed-one", createdBy: "ou-owner",
    });
    assert.equal(binding.status, "active");
    await assert.rejects(
      client.request("binding.pause", { bindingId: binding.id, unknown: true }),
      /invalid binding.pause params/,
    );
  } finally {
    await server.stop();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("corrupt Feishu bridge storage is preserved and refused", () => {
  const h = harness();
  try {
    writeFileSync(h.paths.bindings, '{"version":1,"bindings":[],"future":true}\n', { mode: 0o600 });
    assert.throws(() => new FeishuBridgeStore(h.paths).read(), /malformed Feishu bridge state/);
    assert.match(readFileSync(h.paths.bindings, "utf8"), /future/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
