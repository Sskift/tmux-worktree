import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const attachmentModule = await import(
  "../dist/relay/v2/hostDynamicCodexRolloutAgentTranscriptLifecycleAttachment.js"
);
const storeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/store.js"
);
const continuityModule = await import("../dist/relay/v2/continuityAnchor.js");

const owner = Object.freeze({ hostId: "host-agent-rollout", hostEpoch: "epoch-agent-rollout" });
const target = Object.freeze({ scopeId: "scope-agent-rollout", sessionId: "session-agent-rollout" });
const cwd = "/Users/fixture/.tmux-worktree/worktrees/repo/agent-rollout";
const sessionName = "tw-repo-agent-rollout";
const incarnation = `twinc2.${"a".repeat(43)}`;
const threadId = "0198a5c4-3d12-7b21-a1d4-8f23cb697e10";
const rolloutPath = "/Users/fixture/.codex/sessions/2026/08/03/rollout-agent.jsonl";

class MemoryContinuityAuthority {
  constructor(anchorId) {
    this.anchorId = anchorId;
    this.sequence = 0;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "uninitialized",
      anchorId,
      casToken: "cas-0",
    };
  }

  async read() { return structuredClone(this.current); }

  async compareAndSwap(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        outcome: "conflict",
        current: structuredClone(this.current),
      };
    }
    this.sequence += 1;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "committed",
      anchorId: this.anchorId,
      casToken: `cas-${this.sequence}`,
      checkpoint: structuredClone(request.next),
    };
    return {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      outcome: "swapped",
      current: structuredClone(this.current),
    };
  }
}

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = frozen(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function requestBytes(requestId, sessionId = target.sessionId) {
  return Buffer.from(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "agent.timeline.status.get",
    requestId,
    hostId: owner.hostId,
    expectedHostEpoch: owner.hostEpoch,
    scopeId: target.scopeId,
    sessionId,
    payload: {},
  }), "utf8");
}

test("self-hosted Agent owner dynamically binds one H2 Session rollout and drains it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "tw-agent-rollout-composition-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let attachment;
  t.after(async () => attachment?.closeAndDrain());
  const anchorId = storeModule.relayAgentAuthorityContinuityAnchorId(owner);
  const store = await storeModule.RelayAgentAuthorityStore.open({
    ...owner,
    home,
    continuityAnchor: {
      anchorId,
      authority: new MemoryContinuityAuthority(anchorId),
      operationTimeoutMs: 500,
      maxPendingOperations: 16,
    },
  });

  const lines = [
    { type: "session_meta", payload: { id: threadId, cwd, cli_version: "0.146.0" } },
    {
      timestamp: "2026-08-03T01:02:01.100Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-aborted-rollout",
        started_at: 1_785_718_921,
        model_context_window: 258_400,
        collaboration_mode_kind: "default",
      },
    },
    {
      timestamp: "2026-08-03T01:02:02.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: "turn-aborted-rollout",
        reason: "user_cancelled",
        started_at: 1_785_718_921,
        completed_at: 1_785_718_922,
        duration_ms: 900,
      },
    },
    {
      timestamp: "2026-08-03T01:02:03.100Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-real-rollout",
        started_at: 1_785_718_923,
        model_context_window: 258_400,
        collaboration_mode_kind: "default",
      },
    },
    {
      timestamp: "2026-08-03T01:02:03.200Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "durably followed from the live rollout",
        phase: "final_answer",
        memory_citation: null,
      },
    },
    {
      timestamp: "2026-08-03T01:02:04.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-real-rollout",
        started_at: 1_785_718_923,
        completed_at: 1_785_718_924,
        duration_ms: 900,
        time_to_first_token_ms: 100,
        last_agent_message: "durably followed from the live rollout",
      },
    },
  ];
  const rolloutBytes = Buffer.from(`${lines.map(JSON.stringify).join("\n")}\n`, "utf8");
  let descriptorCloseCount = 0;
  let adapterOpenCount = 0;
  let failNextInspection = true;
  let pollArmCount = 0;
  let livePollTimers = 0;
  const schedule = (delayMs, callback) => {
    pollArmCount += 1;
    livePollTimers += 1;
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      livePollTimers -= 1;
      callback();
    }, delayMs);
    return () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      livePollTimers -= 1;
    };
  };
  const pane = frozen({
    sessionName,
    managedIncarnation: incarnation,
    paneId: "%7",
    panePid: 100,
    paneTty: "/dev/ttys007",
    cwd,
  });
  const processes = frozen([
    {
      pid: 100, parentPid: 1, processGroupId: 100, foregroundProcessGroupId: 200,
      tty: "ttys007", startToken: "Mon Aug  3 10:00:00 2026",
      executablePath: "/bin/zsh", trustedExecutable: false,
    },
    {
      pid: 200, parentPid: 100, processGroupId: 200, foregroundProcessGroupId: 200,
      tty: "ttys007", startToken: "Mon Aug  3 10:00:01 2026",
      executablePath: "/Applications/Codex/codex", trustedExecutable: true,
    },
  ]);
  const stat = frozen({
    resolvedPath: rolloutPath,
    device: 11n,
    inode: 22n,
    ownerUid: 501n,
    linkCount: 1n,
    regular: true,
    size: BigInt(rolloutBytes.byteLength),
  });
  const inspectionAdapterFactory = async (selection) => {
    adapterOpenCount += 1;
    assert.deepEqual(selection, { sessionName, managedIncarnation: incarnation, expectedCwd: cwd });
    if (failNextInspection) {
      failNextInspection = false;
      throw new Error("injected transient TOFU inspection failure");
    }
    return {
      async inspectSinglePane() { return pane; },
      async inspectPaneDescendants() { return processes; },
      async inspectOpenFiles(pid) {
        return frozen({ pid, trustedExecutableVnode: true, paths: [rolloutPath] });
      },
      async openNoFollow(path) {
        assert.equal(path, rolloutPath);
        return {
          async inspect() { return stat; },
          async read(position, maximumBytes) {
            const start = Number(position);
            return rolloutBytes.subarray(start, start + maximumBytes);
          },
          async close() { descriptorCloseCount += 1; },
        };
      },
    };
  };
  const resolverTarget = frozen({
    authorization: "evidence_only",
    hostEpoch: owner.hostEpoch,
    discoveryGeneration: "generation-agent-rollout",
    scopeId: target.scopeId,
    processTarget: { kind: "local", targetId: "local-agent-rollout" },
    capabilities: [],
    sessionId: target.sessionId,
    backendInstanceKey: "backend-agent-rollout",
    managedTarget: { name: sessionName, kind: "worktree", incarnation },
  });
  const resolver = {
    async captureToken(hostEpoch) {
      return {
        schemaVersion: 1,
        hostEpoch,
        resourceMappingDigest: "mapping-agent-rollout",
        discoveryGeneration: resolverTarget.discoveryGeneration,
      };
    },
    async resolveSession(_token, scopeId, sessionId) {
      if (scopeId !== target.scopeId || sessionId !== target.sessionId) throw new Error("not found");
      return structuredClone(resolverTarget);
    },
  };

  const openAttachment = () => attachmentModule
    .openRelayV2HostDynamicCodexRolloutAgentTranscriptLifecycleAttachment({
      store,
      canonicalResourceResolver: resolver,
      accountHome: "/Users/fixture",
      accountUid: 501,
      tmuxExecutablePath: "/opt/homebrew/bin/tmux",
      inspectionAdapterFactory,
      resolveWorkingDirectory: async () => cwd,
      pollIntervalMs: 10,
      schedule,
    });
  attachment = await openAttachment();
  let ready = false;
  let sinkCloseCount = 0;
  attachment.subscribe({
    apply(value) { ready = value; return true; },
    async publish() {},
    close() { sinkCloseCount += 1; },
  });
  assert.equal(ready, true);

  const context = {
    principalId: "principal-agent-rollout",
    clientInstanceId: "client-agent-rollout",
    ...owner,
    ...target,
  };
  assert.equal(await attachment.authorize({ ...context, sessionId: "wrong-session" }), false);
  const failedRequestBytes = requestBytes("request-agent-rollout-fail-first");
  assert.equal(
    attachment.inspectRequest(failedRequestBytes, { opcode: "text" }).sessionId,
    target.sessionId,
  );
  assert.equal(await attachment.authorize(context), true);
  assert.equal(adapterOpenCount, 1);
  assert.deepEqual(await store.status(target), {
    support: "unavailable",
    reason: "adapter_unavailable",
    liveSource: "absent",
    activeSourceEpoch: null,
    timelineEpoch: null,
    currentAgentSeq: null,
    earliestReplaySeq: null,
    limits: null,
  });
  assert.equal(
    await attachment.authorize(context),
    true,
    "a later explicit authorized request retries the failed same-identity entry",
  );
  assert.equal(adapterOpenCount, 2);

  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await store.status(target);
    if (status.support === "available"
      && status.currentAgentSeq === "10"
      && pollArmCount > 0) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(status.support, "available");
  assert.equal(status.liveSource, "connected");
  assert.equal(status.currentAgentSeq, "10", "the aborted turn closes before its successor");

  const bytes = requestBytes("request-agent-rollout");
  assert.equal(attachment.inspectRequest(bytes, { opcode: "text" }).sessionId, target.sessionId);
  const delivery = await attachment.handleRequest(bytes, { opcode: "text" }, context);
  assert.equal(delivery.frame.type, "agent.timeline.status");
  assert.equal(delivery.frame.payload.support, "available");

  await attachment.closeAndDrain();
  assert.equal(descriptorCloseCount, 1);
  assert.equal(sinkCloseCount, 1);
  assert.equal(livePollTimers, 0, "close/drain cancels the bounded follower poll");

  const previousPollArmCount = pollArmCount;
  attachment = await openAttachment();
  attachment.subscribe({ apply() { return true; }, async publish() {}, close() {} });
  assert.equal(await attachment.authorize(context), true);
  for (let attempt = 0; attempt < 200 && pollArmCount === previousPollArmCount; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(pollArmCount > previousPollArmCount, "the second owner completed bounded replay");
  status = await store.status(target);
  assert.equal(
    status.currentAgentSeq,
    "10",
    "stable source identity deduplicates the same rollout after re-acquisition",
  );
  assert.equal(adapterOpenCount, 3);
  await attachment.closeAndDrain();
  assert.equal(descriptorCloseCount, 2);
  assert.equal(livePollTimers, 0);
});
