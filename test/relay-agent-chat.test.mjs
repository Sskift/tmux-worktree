import assert from "node:assert/strict";
import test from "node:test";
import { AgentChatEngine } from "../dist/relay/agentChat.js";

function makeLease(overrides = {}) {
  return {
    controlTargetId: "target-1",
    controlEpoch: "epoch-1",
    leaseId: "lease-1",
    fence: "fence-1",
    owner: { kind: "relay-v1", instanceId: "relay-v1:test" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeControl(state) {
  return {
    async resolveTarget() {
      return { controlTargetId: "target-1", controlEpoch: "epoch-1" };
    },
    async acquireLease() {
      return state.lease;
    },
    async sendAgentMessage(input) {
      state.lastOperationId = input.operationId;
      state.lastMessage = input.message;
      // Extract the marker nonce from the prompt so the fake terminal output
      // uses the same nonce the engine generated.
      const nonceMatch = input.message.match(/notify-group:" \+ "([^"]+)"/);
      if (nonceMatch) state.markerNonce = nonceMatch[1];
      return {
        operationId: input.operationId,
        controlEpoch: state.lease.controlEpoch,
        fence: state.lease.fence,
        outputGeneration: "gen-1",
        outputCursor: 0,
      };
    },
    async tailOutput(input) {
      const data = state.outputFn ? state.outputFn(state) : state.outputBase64 ?? "";
      const decodedLength = data ? Buffer.from(data, "base64").length : 0;
      return {
        controlTargetId: input.controlTargetId,
        controlEpoch: input.controlEpoch,
        fence: state.lease.fence,
        ownerKind: "relay-v1",
        outputGeneration: input.outputGeneration,
        cursor: input.cursor,
        dataBase64: data,
        nextCursor: input.cursor + decodedLength,
      };
    },
    async renderedSnapshot(input) {
      const data = state.snapshotFn
        ? state.snapshotFn(state)
        : state.snapshotBase64 ?? (state.outputFn ? state.outputFn(state) : state.outputBase64 ?? "");
      return {
        controlTargetId: state.lease.controlTargetId,
        controlEpoch: state.lease.controlEpoch,
        leaseId: state.lease.leaseId,
        fence: state.lease.fence,
        ownerKind: "relay-v1",
        outputGeneration: input.outputGeneration,
        pane: input.pane,
        dataBase64: data,
        truncated: false,
      };
    },
    async ownershipStatus() {
      return state.ownershipFn ? state.ownershipFn(state) : {
        controlTargetId: state.lease.controlTargetId,
        controlEpoch: state.lease.controlEpoch,
        state: "HELD",
        fence: state.lease.fence,
        ownerKind: state.lease.owner.kind,
        outputGeneration: "gen-1",
        outputCursor: 100,
        revision: "rev-1",
      };
    },
  };
}

function waitFor(condition, { timeout = 5_000, interval = 20 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = condition();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - start > timeout) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

test("agent chat turn completes with marked reply", async () => {
  const replyText = "Hello from the agent";
  const state = {
    lease: makeLease(),
    outputFn: (s) => {
      if (!s.markerNonce) return "";
      const marked = `some prefix [[notify-group:${s.markerNonce}]]${replyText}[[/notify-group:${s.markerNonce}]] suffix`;
      return Buffer.from(marked).toString("base64");
    },
  };
  const control = makeControl(state);
  const engine = new AgentChatEngine(control);

  const events = [];
  const { turnId } = await engine.startOrSteerTurn("session-1", "hello", {
    onEvent: (turn) => events.push(turn),
  });

  assert.equal(typeof turnId, "string");
  assert.ok(turnId.length > 0);

  const replied = await waitFor(() => events.find((t) => t.status === "replied"));
  assert.equal(replied.turnId, turnId);
  assert.equal(replied.status, "replied");
  assert.equal(replied.reply, replyText);
  assert.equal(replied.userMessage, "hello");
  assert.ok(replied.completedAt);
  engine.disposeSession("session-1");
});

test("agent chat steering merges into the in-flight turn", async () => {
  const state = {
    lease: makeLease(),
    outputBase64: "",
    snapshotBase64: "",
  };
  const control = makeControl(state);
  const engine = new AgentChatEngine(control);

  const events = [];
  const first = await engine.startOrSteerTurn("session-2", "first message", {
    onEvent: (turn) => events.push(turn),
  });

  // Before the first turn completes, send a second message → steering.
  const second = await engine.startOrSteerTurn("session-2", "steer message", {
    onEvent: (turn) => events.push(turn),
  });

  assert.equal(second.turnId, first.turnId, "steering returns the same turnId");

  const turns = engine.listTurns("session-2");
  const turn = turns.find((t) => t.turnId === first.turnId);
  assert.equal(turn.steeredMessages.length, 1);
  assert.equal(turn.steeredMessages[0].message, "steer message");
  engine.disposeSession("session-2");
});

test("agent chat correlation drift enters recovery-required", async () => {
  const state = {
    lease: makeLease(),
    outputBase64: "",
    snapshotBase64: "",
  };
  const control = makeControl(state);
  // Override ownershipStatus to return a drifted outputGeneration.
  control.ownershipStatus = async () => ({
    controlTargetId: state.lease.controlTargetId,
    controlEpoch: state.lease.controlEpoch,
    state: "HELD",
    fence: state.lease.fence,
    ownerKind: state.lease.owner.kind,
    outputGeneration: "gen-DRIFTED",
    outputCursor: 100,
    revision: "rev-1",
  });

  const engine = new AgentChatEngine(control);
  const events = [];
  await engine.startOrSteerTurn("session-3", "hello", {
    onEvent: (turn) => events.push(turn),
  });

  const recovery = await waitFor(() => events.find((t) => t.status === "recovery-required"));
  assert.equal(recovery.status, "recovery-required");
  assert.ok(recovery.error);
  engine.disposeSession("session-3");
});
