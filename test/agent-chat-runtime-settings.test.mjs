import assert from "node:assert/strict";
import test from "node:test";

import * as terminalControl from "../dist/terminalControl/index.js";
import {
  decodeRelayAgentChatFrame,
  encodeRelayAgentChatFrame,
} from "../dist/relay/extensions/agentChat/v2/codec.js";

const lease = {
  controlTargetId: "target-1",
  controlEpoch: "1",
  leaseId: "lease-1",
  fence: "1",
  owner: { kind: "relay-v2", instanceId: "owner-1" },
  expiresAt: "2026-08-13T12:00:00.000Z",
};

test("agent chat runtime settings codec is strict and backward compatible", () => {
  const base = {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.send",
    requestId: "request-1",
    hostId: "host-1",
    expectedHostEpoch: "epoch-1",
    scopeId: "local",
    sessionId: "session-1",
    payload: { session: "session-1", message: "hello" },
  };
  assert.equal(
    JSON.stringify(decodeRelayAgentChatFrame(encodeRelayAgentChatFrame(base)).frame),
    JSON.stringify(base),
  );
  const configured = {
    ...base,
    payload: {
      ...base.payload,
      settings: { model: "gpt-5.6-terra", reasoningEffort: "high", mode: "plan" },
    },
  };
  assert.equal(
    JSON.stringify(decodeRelayAgentChatFrame(encodeRelayAgentChatFrame(configured)).frame),
    JSON.stringify(configured),
  );
  const advancedPlan = {
    ...configured,
    payload: {
      ...configured.payload,
      settings: { model: "gpt-5.6-sol", reasoningEffort: "ultra", mode: "plan" },
    },
  };
  assert.equal(
    JSON.stringify(decodeRelayAgentChatFrame(encodeRelayAgentChatFrame(advancedPlan)).frame),
    JSON.stringify(advancedPlan),
  );
  assert.throws(() => encodeRelayAgentChatFrame({
    ...configured,
    payload: {
      ...configured.payload,
      settings: { model: "gpt-5.6-luna", reasoningEffort: "ultra", mode: "plan" },
    },
  }));
});

test("runtime settings availability is negotiated for one exact Session", () => {
  const history = {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.history",
    requestId: "history-1",
    hostId: "host-1",
    expectedHostEpoch: "epoch-1",
    scopeId: "local",
    sessionId: "session-1",
    payload: {
      session: "session-1",
      includeRuntimeSettingsStatus: true,
    },
  };
  assert.equal(
    JSON.stringify(decodeRelayAgentChatFrame(encodeRelayAgentChatFrame(history)).frame),
    JSON.stringify(history),
  );

  const result = {
    protocolVersion: 2,
    kind: "response",
    type: "agent.chat.history.result",
    requestId: "history-1",
    hostId: "host-1",
    hostEpoch: "epoch-1",
    scopeId: "local",
    sessionId: "session-1",
    payload: {
      session: "session-1",
      turns: [],
      runtimeSettingsStatus: {
        available: true,
        provider: "codex",
        reason: "available",
      },
    },
  };
  assert.equal(
    JSON.stringify(decodeRelayAgentChatFrame(encodeRelayAgentChatFrame(result)).frame),
    JSON.stringify(result),
  );
  assert.throws(() => encodeRelayAgentChatFrame({
    ...result,
    payload: {
      ...result.payload,
      runtimeSettingsStatus: {
        available: true,
        provider: "claude",
        reason: "available",
      },
    },
  }));
});

test("terminal runtime settings parse and form a resumable Codex command", () => {
  const runtime = { model: "gpt-5.6-terra", reasoningEffort: "high", mode: "plan" };
  const parsed = terminalControl.parseTerminalControlRequest({
    protocolVersion: 1,
    requestId: "request-1",
    type: "input.agent-message",
    lease,
    operationId: "operation-1",
    pane: "0",
    message: "hello",
    submit: true,
    runtime,
  });
  assert.deepEqual(parsed.runtime, runtime);
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const command = terminalControl.buildCodexResumeCommand(sessionId, runtime);
  assert.match(command, /-m 'gpt-5\.6-terra'/);
  assert.match(command, /model_reasoning_effort="high"/);
  assert.match(command, /plan_mode_reasoning_effort="high"/);
  assert.equal(
    terminalControl.resumedAgentSessionIdFromStartCommand(`${command};`, "codex"),
    sessionId,
  );
});

test("Codex mode detection uses only the anchored status tail", () => {
  assert.equal(
    terminalControl.codexModeFromRenderedSnapshot("user wrote Plan mode\n\n› prompt\n  gpt-5.6-sol high · /tmp/project"),
    "default",
  );
  assert.equal(
    terminalControl.codexModeFromRenderedSnapshot("model: loading\n› prompt"),
    null,
  );
  assert.equal(
    terminalControl.codexModeFromRenderedSnapshot("old text\n\n› prompt\n  gpt-5.6-sol high · /tmp/project             Plan mode"),
    "plan",
  );
});

test("Plan mode accepts advanced effort while Luna rejects unsupported ultra", () => {
  const planUltra = terminalControl.parseTerminalControlRequest({
    protocolVersion: 1,
    requestId: "request-1",
    type: "input.agent-message",
    lease,
    operationId: "operation-1",
    pane: "0",
    message: "hello",
    submit: true,
    runtime: { model: "gpt-5.6-sol", reasoningEffort: "ultra", mode: "plan" },
  });
  assert.equal(planUltra.runtime.reasoningEffort, "ultra");
  assert.throws(() => terminalControl.parseTerminalControlRequest({
    ...planUltra,
    requestId: "request-2",
    runtime: { model: "gpt-5.6-luna", reasoningEffort: "ultra", mode: "plan" },
  }), /Luna does not support ultra/);
});
