import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const storeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/store.js"
);
const runtimeModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/runtime.js"
);
const codecModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codec.js"
);
const continuityModule = await import("../dist/relay/v2/continuityAnchor.js");

const owner = Object.freeze({ hostId: "host-agent", hostEpoch: "host-epoch-agent" });
const target = Object.freeze({ scopeId: "scope-agent", sessionId: "session-agent" });
const trustedBinding = Object.freeze({ ...owner, ...target });
const retentionMs = codecModule.RELAY_AGENT_MIN_REPLAY_RETENTION_MS;

function mode(path) {
  return statSync(path).mode & 0o777;
}

function sourceEvent(sourceSeq, sourceEventId, mutation, sourceEpoch = "source-agent") {
  return {
    sourceEpoch,
    sourceSeq: String(sourceSeq),
    sourceEventId,
    occurredAtMs: 1_800_000_000_000 + Number(sourceSeq),
    mutation,
  };
}

function sequentialIds(prefix) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function strictJsonCounts(value) {
  let keys = 0;
  let nodes = 0;
  const visit = (item) => {
    nodes += 1;
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === "object") {
      const entries = Object.entries(item);
      keys += entries.length;
      entries.forEach(([, child]) => visit(child));
    }
  };
  visit(value);
  return { keys, nodes };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

class MemoryMonotonicCasAuthority {
  constructor(anchorId) {
    this.anchorId = anchorId;
    this.tokenSequence = 0;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "uninitialized",
      anchorId,
      casToken: "cas-0",
    };
    this.readCalls = 0;
    this.casCalls = 0;
    this.failReads = false;
    this.failNextCas = false;
    this.onRead = null;
    this.onCas = null;
  }

  async read(request) {
    assert.equal(request.anchorId, this.anchorId);
    assert.equal(request.signal instanceof AbortSignal, true);
    this.readCalls += 1;
    if (this.failReads) throw new Error("injected anchor read failure");
    if (this.onRead) return this.onRead(request, () => clone(this.current));
    return clone(this.current);
  }

  async compareAndSwap(request) {
    assert.equal(request.anchorId, this.anchorId);
    assert.equal(request.signal instanceof AbortSignal, true);
    this.casCalls += 1;
    if (this.failNextCas) {
      this.failNextCas = false;
      throw new Error("injected anchor CAS failure");
    }
    if (this.onCas) return this.onCas(request, () => this.defaultCas(request));
    return this.defaultCas(request);
  }

  defaultCas(request) {
    if (request.expected.casToken !== this.current.casToken) {
      return {
        protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
        outcome: "conflict",
        current: clone(this.current),
      };
    }
    this.tokenSequence += 1;
    this.current = {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      status: "committed",
      anchorId: this.anchorId,
      casToken: `cas-${this.tokenSequence}`,
      checkpoint: clone(request.next),
    };
    return {
      protocolVersion: continuityModule.RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
      outcome: "swapped",
      current: clone(this.current),
    };
  }
}

async function harness(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-agent-authority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clock = { value: 1_900_000_000_000 };
  const randomId = sequentialIds("durable-id");
  const randomCursor = sequentialIds("durable-cursor");
  const anchorId = storeModule.relayAgentAuthorityContinuityAnchorId(owner);
  const {
    continuityAuthority = new MemoryMonotonicCasAuthority(anchorId),
    continuityAnchor: continuityAnchorOverride,
    ...storeOverrides
  } = overrides;
  const continuityAnchor = continuityAnchorOverride ?? {
    anchorId,
    authority: continuityAuthority,
    operationTimeoutMs: 500,
    maxPendingOperations: 16,
  };
  const options = {
    ...owner,
    continuityAnchor,
    home,
    eventReplayRetentionMs: retentionMs,
    now: () => clock.value,
    randomId,
    randomCursor,
    ...storeOverrides,
  };
  const open = (extra = {}) => storeModule.RelayAgentAuthorityStore.open({ ...options, ...extra });
  return {
    home,
    clock,
    options,
    open,
    continuityAuthority,
    store: await open(),
  };
}

function runtimeFor(store) {
  return new runtimeModule.RelayAgentTranscriptLifecycleRuntime(store);
}

function routeContext(overrides = {}) {
  return {
    capabilityNegotiated: true,
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    ...owner,
    ...target,
    ...overrides,
  };
}

function requestBytes(type, payload, requestId = `request-${type}`) {
  return Buffer.from(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type,
    requestId,
    hostId: owner.hostId,
    expectedHostEpoch: owner.hostEpoch,
    scopeId: target.scopeId,
    sessionId: target.sessionId,
    payload,
  }));
}

async function ingest(runtime, seq, id, mutation, expected = "applied") {
  const result = await runtime.ingestTrustedSource(trustedBinding, sourceEvent(seq, id, mutation));
  assert.equal(result.reduction.disposition, expected, id);
  return result;
}

async function establishConversation(runtime) {
  await ingest(runtime, 1, "source-started", { mutationType: "source.started" });
  await ingest(runtime, 2, "run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-1",
    turnId: null,
    state: "running",
    failure: null,
  });
  await ingest(runtime, 3, "turn-running", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "running",
    failure: null,
  });
}

test("durable host authority emits real reply/lifecycle identity and pins disconnect replay", async (t) => {
  const h = await harness(t);
  let runtime = runtimeFor(h.store);
  await establishConversation(runtime);

  const reply = await ingest(runtime, 4, "agent-reply-1", {
    mutationType: "text_entry.appended",
    entryId: "entry-agent-1",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "Remote authority reply",
    commandId: null,
  });
  assert.equal(reply.delivery.provenance, "LIVE");
  assert.equal(reply.delivery.frame.payload.agentEventSeq, "4");
  assert.equal(reply.delivery.frame.payload.mutation.entry.role, "agent");
  assert.equal(reply.delivery.frame.payload.mutation.entry.text, "Remote authority reply");

  const waiting = await ingest(runtime, 5, "turn-waiting", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "waiting_for_user",
    failure: null,
  });
  assert.equal(waiting.delivery.frame.payload.mutation.lifecycle.state, "waiting_for_user");
  await ingest(runtime, 6, "user-reply", {
    mutationType: "text_entry.appended",
    entryId: "entry-user-1",
    runId: "run-1",
    turnId: "turn-1",
    role: "user",
    text: "Use staging",
    commandId: "command-user-1",
  });
  await ingest(runtime, 7, "turn-resumed", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "running",
    failure: null,
  });
  await ingest(runtime, 8, "agent-reply-2", {
    mutationType: "text_entry.appended",
    entryId: "entry-agent-2",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "Staging is healthy",
    commandId: null,
  });
  const completed = await ingest(runtime, 9, "turn-completed", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "completed",
    failure: null,
  });
  assert.equal(completed.delivery.frame.payload.mutation.lifecycle.state, "completed");

  const firstReplay = await runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: null,
    limit: 2,
  }, "replay-first"), {}, routeContext());
  assert.equal(firstReplay.provenance, "REPLAY");
  assert.deepEqual(firstReplay.replayEvents.map((item) => item.provenance), ["REPLAY", "REPLAY"]);
  assert.deepEqual(firstReplay.frame.payload.events.map((item) => item.agentEventSeq), ["4", "5"]);
  assert.equal(firstReplay.frame.payload.replayThroughAgentSeq, "9");
  assert.equal(firstReplay.frame.payload.isLast, false);

  await ingest(runtime, 10, "run-completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-1",
    turnId: null,
    state: "completed",
    failure: null,
  });
  const stableEventId = completed.delivery.frame.payload.eventId;
  runtime = runtimeFor(await h.open());
  const secondReplay = await runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: firstReplay.frame.payload.nextCursor,
    limit: 2,
  }, "replay-second"), {}, routeContext());
  assert.equal(secondReplay.frame.payload.replayThroughAgentSeq, "9");
  assert.deepEqual(secondReplay.frame.payload.events.map((item) => item.agentEventSeq), ["6", "7"]);
  const thirdReplay = await runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: secondReplay.frame.payload.nextCursor,
    limit: 2,
  }, "replay-third"), {}, routeContext());
  assert.deepEqual(thirdReplay.frame.payload.events.map((item) => item.agentEventSeq), ["8", "9"]);
  assert.equal(thirdReplay.frame.payload.events.at(-1).eventId, stableEventId);
  assert.equal(thirdReplay.frame.payload.isLast, true);
  assert.equal(thirdReplay.frame.payload.nextCursor, null);

  const retriedFirst = await runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: null,
    limit: 2,
  }, "replay-first-retry"), {}, routeContext());
  assert.deepEqual(retriedFirst.frame.payload, firstReplay.frame.payload);

  await ingest(runtime, 11, "startup-run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-startup",
    turnId: null,
    state: "running",
    failure: null,
  });
  const failed = await ingest(runtime, 12, "startup-run-failed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-startup",
    turnId: null,
    state: "failed",
    failure: { code: "agent_start_failed", summary: "safe summary" },
  });
  assert.equal(failed.delivery.frame.payload.mutation.lifecycle.state, "failed");
  assert.equal(failed.delivery.frame.payload.mutation.lifecycle.failure.code, "agent_start_failed");

  const status = await runtime.handleRequest(
    requestBytes("agent.timeline.status.get", {}, "status"),
    {},
    routeContext(),
  );
  assert.equal(status.provenance, "CONTROL");
  assert.equal(status.frame.payload.support, "available");
  assert.equal(status.frame.payload.currentAgentSeq, "12");
  assert.equal(status.frame.payload.activeSourceEpoch, "source-agent");

  const snapshot = await runtime.handleRequest(requestBytes("agent.timeline.snapshot.get", {
    snapshotRequestId: "snapshot-logical-1",
    snapshotId: null,
    cursor: null,
    nextPageIndex: 0,
  }, "snapshot"), {}, routeContext());
  assert.equal(snapshot.provenance, "SNAPSHOT");
  assert.equal(snapshot.frame.payload.throughAgentSeq, "12");
  assert.ok(snapshot.frame.payload.records.some((item) => (
    item.recordType === "text_entry" && item.text === "Remote authority reply"
  )));
  assert.ok(snapshot.frame.payload.records.some((item) => (
    item.recordType === "lifecycle" && item.state === "completed"
  )));
  assert.ok(snapshot.frame.payload.records.some((item) => (
    item.recordType === "lifecycle" && item.state === "failed" && item.failure.code === "agent_start_failed"
  )));

  const duplicate = await runtime.ingestTrustedSource(
    trustedBinding,
    sourceEvent(10, "run-completed", {
      mutationType: "lifecycle.changed",
      scope: "run",
      runId: "run-1",
      turnId: null,
      state: "completed",
      failure: null,
    }),
  );
  assert.equal(duplicate.reduction.disposition, "duplicate");
  assert.equal(duplicate.delivery, null);
  const invalidTerminal = await ingest(runtime, 13, "run-terminal-regression", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-startup",
    turnId: null,
    state: "running",
    failure: null,
  }, "invalid_transition");
  assert.equal(invalidTerminal.delivery, null);
  assert.equal(invalidTerminal.reduction.agentEventSeq, "12");
  const gap = await ingest(runtime, 14, "source-gap", {
    mutationType: "source.availability",
    state: "interrupted",
    reason: "source_disconnected",
  }, "source_gap");
  assert.equal(gap.reduction.expectedSourceSeq, "13");
  const conflict = await runtime.ingestTrustedSource(trustedBinding, {
    ...sourceEvent(12, "startup-run-failed", {
      mutationType: "lifecycle.changed",
      scope: "run",
      runId: "run-startup",
      turnId: null,
      state: "failed",
      failure: { code: "agent_start_failed", summary: "safe summary" },
    }),
    occurredAtMs: 1_800_000_001_111,
  });
  assert.equal(conflict.reduction.disposition, "source_event_conflict");
  assert.equal(conflict.reduction.sourceFenced, true);
  assert.equal(conflict.delivery, null);

  assert.equal(mode(dirname(h.store.paths.state)), 0o700);
  assert.equal(mode(dirname(h.store.paths.continuity)), 0o700);
  assert.equal(mode(h.store.paths.state), 0o600);
  assert.equal(mode(h.store.paths.continuity), 0o600);
});

test("snapshot and replay cuts freeze only pages that pass the full public wire budget", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  await establishConversation(runtime);
  for (let index = 0; index < 16; index += 1) {
    await ingest(runtime, index + 4, `large-entry-source-${index}`, {
      mutationType: "text_entry.appended",
      entryId: `large-entry-${index}`,
      runId: "run-1",
      turnId: "turn-1",
      role: "agent",
      text: "w".repeat(codecModule.RELAY_AGENT_MAX_TEXT_UTF8_BYTES),
      commandId: null,
    });
  }

  const snapshotPages = [];
  let snapshotId = null;
  let snapshotCursor = null;
  do {
    const pageIndex = snapshotPages.length;
    const page = await runtime.handleRequest(requestBytes("agent.timeline.snapshot.get", {
      snapshotRequestId: "wire-budget-snapshot",
      snapshotId,
      cursor: snapshotCursor,
      nextPageIndex: pageIndex,
    }, `wire-budget-snapshot-${pageIndex}`), {}, routeContext());
    assert.ok(page.bytes.byteLength <= 1_048_576);
    assert.ok(page.frame.payload.records.length <= codecModule.RELAY_AGENT_MAX_PAGE_RECORDS);
    snapshotPages.push(page);
    snapshotId = page.frame.payload.snapshotId;
    snapshotCursor = page.frame.payload.nextCursor;
  } while (snapshotCursor !== null);
  assert.ok(snapshotPages.length > 1, "the aggregate materialized cut exceeds one wire frame");
  assert.equal(
    snapshotPages.flatMap((page) => page.frame.payload.records)
      .filter((record) => record.recordType === "text_entry").length,
    16,
  );

  const timelineEpoch = (await h.store.status(target)).timelineEpoch;
  const replayPages = [];
  let replayCursor = null;
  do {
    const page = await runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
      timelineEpoch,
      afterAgentSeq: "3",
      cursor: replayCursor,
      limit: 256,
    }, `wire-budget-replay-${replayPages.length}`), {}, routeContext());
    assert.ok(page.bytes.byteLength <= 1_048_576);
    assert.ok(page.frame.payload.events.length <= codecModule.RELAY_AGENT_MAX_PAGE_RECORDS);
    replayPages.push(page);
    replayCursor = page.frame.payload.nextCursor;
  } while (replayCursor !== null);
  assert.ok(replayPages.length > 1, "the aggregate replay cut exceeds one wire frame");
  assert.deepEqual(
    replayPages.flatMap((page) => page.frame.payload.events).map((event) => event.agentEventSeq),
    Array.from({ length: 16 }, (_, index) => String(index + 4)),
  );
});

test("redaction/delete revoke body-bearing cuts, advance a prefix floor, and retain used entry identity", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  await establishConversation(runtime);
  const secretBody = "body-that-must-not-survive-redaction";
  await ingest(runtime, 4, "secret-entry", {
    mutationType: "text_entry.appended",
    entryId: "entry-used",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: secretBody,
    commandId: null,
  });
  await ingest(runtime, 5, "turn-waiting", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "waiting_for_user",
    failure: null,
  });
  const status = await h.store.status(target);
  const oldSnapshot = await h.store.snapshot({
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    target,
    snapshotRequestId: "body-bearing-snapshot",
    snapshotId: null,
    cursor: null,
    nextPageIndex: 0,
  });
  assert.ok(oldSnapshot.records.some((item) => item.recordType === "text_entry" && item.text === secretBody));
  const oldReplay = await h.store.replay({
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    target,
    timelineEpoch: status.timelineEpoch,
    afterAgentSeq: "3",
    cursor: null,
    limit: 1,
  });
  assert.equal(oldReplay.events[0].mutation.entry.text, secretBody);
  assert.notEqual(oldReplay.nextCursor, null);

  const redacted = await ingest(runtime, 6, "secret-redacted", {
    mutationType: "entry.redacted",
    entryId: "entry-used",
    reason: "policy",
  });
  assert.deepEqual(redacted.delivery.frame.payload.mutation, {
    mutationType: "entry.redacted",
    entryId: "entry-used",
    reason: "policy",
  });
  await assert.rejects(
    h.store.snapshot({
      principalId: "principal-agent",
      clientInstanceId: "client-agent",
      target,
      snapshotRequestId: "body-bearing-snapshot",
      snapshotId: null,
      cursor: null,
      nextPageIndex: 0,
    }),
    (error) => error instanceof storeModule.RelayAgentTimelineRequestError
      && error.code === "AGENT_SNAPSHOT_EXPIRED",
  );
  await assert.rejects(
    h.store.replay({
      principalId: "principal-agent",
      clientInstanceId: "client-agent",
      target,
      timelineEpoch: status.timelineEpoch,
      afterAgentSeq: "3",
      cursor: oldReplay.nextCursor,
      limit: 1,
    }),
    (error) => error instanceof storeModule.RelayAgentTimelineRequestError
      && error.code === "AGENT_CURSOR_EXPIRED",
  );
  assert.equal(readFileSync(h.store.paths.state, "utf8").includes(secretBody), false);
  assert.equal((await h.store.status(target)).earliestReplaySeq, "5");
  await assert.rejects(
    h.store.replay({
      principalId: "principal-agent",
      clientInstanceId: "client-agent",
      target,
      timelineEpoch: status.timelineEpoch,
      afterAgentSeq: "4",
      cursor: null,
      limit: 256,
    }),
    (error) => error instanceof storeModule.RelayAgentTimelineRequestError
      && error.code === "AGENT_CURSOR_EXPIRED",
  );
  const redactionReplay = await h.store.replay({
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    target,
    timelineEpoch: status.timelineEpoch,
    afterAgentSeq: "5",
    cursor: null,
    limit: 256,
  });
  assert.deepEqual(redactionReplay.events.map((item) => item.agentEventSeq), ["6"]);
  const sanitized = await h.store.snapshot({
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    target,
    snapshotRequestId: "sanitized-snapshot",
    snapshotId: null,
    cursor: null,
    nextPageIndex: 0,
  });
  const sanitizedEntry = sanitized.records.find((item) => item.recordType === "text_entry");
  assert.equal(sanitizedEntry.state, "redacted");
  assert.equal(sanitizedEntry.text, null);

  await ingest(runtime, 7, "secret-deleted", {
    mutationType: "entry.deleted",
    entryId: "entry-used",
    reason: "retention",
  });
  h.clock.value += retentionMs + 1;
  assert.equal((await h.store.status(target)).earliestReplaySeq, "7");
  const reuse = await ingest(runtime, 8, "entry-reuse-after-retention", {
    mutationType: "text_entry.appended",
    entryId: "entry-used",
    runId: "run-1",
    turnId: "turn-1",
    role: "user",
    text: "attempted resurrection",
    commandId: "command-resurrection",
  }, "entry_deleted");
  assert.equal(reuse.reduction.agentEventSeq, "7");
  assert.equal(reuse.delivery, null);
  assert.equal((await (await h.open()).status(target)).currentAgentSeq, "7");
});

test("first durable directory creation fsyncs every new layer and its parent", async (t) => {
  const fsyncedDirectories = [];
  const h = await harness(t, {
    fsyncDirectory(path) {
      fsyncedDirectories.push(path);
      const descriptor = openSync(path, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    },
  });
  const twHome = join(h.home, ".tmux-worktree");
  const extensionHome = dirname(h.store.paths.state);
  assert.ok(fsyncedDirectories.includes(h.home), "creating ~/.tmux-worktree must fsync HOME");
  assert.ok(fsyncedDirectories.includes(twHome), "new extension and state entries must fsync ~/.tmux-worktree");
  assert.ok(fsyncedDirectories.includes(extensionHome), "state publication must fsync its private directory");
  assert.equal(mode(twHome), 0o700);
  assert.equal(mode(extensionHome), 0o700);
});

test("external continuity recovers state-before-anchor and rejects paired rollback, corruption, and unknown ownership", async (t) => {
  const h = await harness(t);
  let runtime = runtimeFor(h.store);
  await ingest(runtime, 1, "source-started", { mutationType: "source.started" });
  const stateA = readFileSync(h.store.paths.state);
  const witnessA = readFileSync(h.store.paths.continuity);
  await ingest(runtime, 2, "run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-1",
    turnId: null,
    state: "running",
    failure: null,
  });
  const stateB = readFileSync(h.store.paths.state);
  const witnessB = readFileSync(h.store.paths.continuity);

  writeFileSync(h.store.paths.continuity, witnessA, { mode: 0o600 });
  assert.equal((await (await h.open()).status(target)).currentAgentSeq, "2");
  assert.deepEqual(readFileSync(h.store.paths.continuity), witnessB);

  writeFileSync(h.store.paths.state, stateA, { mode: 0o600 });
  writeFileSync(h.store.paths.continuity, witnessA, { mode: 0o600 });
  await assert.rejects(h.open(), storeModule.RelayAgentAuthorityStoreCorruptError);
  assert.deepEqual(readFileSync(h.store.paths.state), stateA, "rollback evidence must not be overwritten");
  assert.deepEqual(readFileSync(h.store.paths.continuity), witnessA, "paired rollback evidence must not be repaired locally");
  writeFileSync(h.store.paths.state, stateB, { mode: 0o600 });
  writeFileSync(h.store.paths.continuity, witnessB, { mode: 0o600 });

  const corrupt = Buffer.from(stateB);
  corrupt[corrupt.indexOf(Buffer.from("run-1"))] = "x".charCodeAt(0);
  writeFileSync(h.store.paths.state, corrupt, { mode: 0o600 });
  await assert.rejects(h.open(), storeModule.RelayAgentAuthorityStoreCorruptError);
  assert.deepEqual(readFileSync(h.store.paths.state), corrupt, "corrupt state must remain fail-closed");
  writeFileSync(h.store.paths.state, stateB, { mode: 0o600 });

  const realState = `${h.store.paths.state}.real`;
  renameSync(h.store.paths.state, realState);
  symlinkSync(realState, h.store.paths.state);
  assert.equal(lstatSync(h.store.paths.state).isSymbolicLink(), true);
  await assert.rejects(h.open(), storeModule.RelayAgentAuthorityStoreOwnershipError);
  unlinkSync(h.store.paths.state);
  renameSync(realState, h.store.paths.state);
  chmodSync(h.store.paths.state, 0o600);

  runtime = runtimeFor(await h.open());
  await ingest(runtime, 3, "turn-running", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "running",
    failure: null,
  });
  const beforeCapacity = statSync(h.store.paths.state).size;
  const capped = await h.open({ testMaxPersistedBytes: beforeCapacity + 2_000 });
  await assert.rejects(
    capped.ingest(trustedBinding, sourceEvent(4, "large-entry", {
      mutationType: "text_entry.appended",
      entryId: "large-entry",
      runId: "run-1",
      turnId: "turn-1",
      role: "agent",
      text: "z".repeat(20_000),
      commandId: null,
    })),
    storeModule.RelayAgentAuthorityStoreCapacityError,
  );
  assert.equal((await (await h.open()).status(target)).currentAgentSeq, "3");

  const strictState = readFileSync(h.store.paths.state);
  const strictCounts = strictJsonCounts(JSON.parse(strictState));
  for (const [budgetName, budget] of [
    ["testMaxPersistedJsonKeys", strictCounts.keys + 10],
    ["testMaxPersistedJsonNodes", strictCounts.nodes + 10],
  ]) {
    const strictCapped = await h.open({ [budgetName]: budget });
    await assert.rejects(
      strictCapped.ingest(trustedBinding, sourceEvent(4, `strict-${budgetName}`, {
        mutationType: "text_entry.appended",
        entryId: `strict-${budgetName}`,
        runId: "run-1",
        turnId: "turn-1",
        role: "agent",
        text: "must not be ACKed",
        commandId: null,
      })),
      storeModule.RelayAgentAuthorityStoreCapacityError,
    );
    assert.deepEqual(readFileSync(h.store.paths.state), strictState, `${budgetName} must reject before publish`);
    assert.equal((await (await h.open({ [budgetName]: budget })).status(target)).currentAgentSeq, "3");
  }

  let failPublishedState = true;
  const uncertain = await h.open({
    renameFile(source, destination) {
      renameSync(source, destination);
      if (failPublishedState && destination === h.store.paths.state) {
        failPublishedState = false;
        throw new Error("injected failure after state rename");
      }
    },
  });
  const committedButUnacked = sourceEvent(4, "commit-uncertain-entry", {
    mutationType: "text_entry.appended",
    entryId: "entry-after-crash",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "durably published before ACK",
    commandId: null,
  });
  await assert.rejects(
    uncertain.ingest(trustedBinding, committedButUnacked),
    storeModule.RelayAgentAuthorityStoreCommitUncertainError,
  );
  let recovered = await h.open();
  assert.equal((await recovered.status(target)).currentAgentSeq, "4");
  const exactRetry = await recovered.ingest(trustedBinding, committedButUnacked);
  assert.equal(exactRetry.disposition, "duplicate");
  assert.equal(exactRetry.agentEventSeq, "4");

  const externalCasUnacked = sourceEvent(5, "anchor-commit-uncertain-entry", {
    mutationType: "text_entry.appended",
    entryId: "entry-before-anchor",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "state survived an external CAS uncertainty",
    commandId: null,
  });
  h.continuityAuthority.failNextCas = true;
  await assert.rejects(
    recovered.ingest(trustedBinding, externalCasUnacked),
    storeModule.RelayAgentAuthorityStoreCommitUncertainError,
  );
  recovered = await h.open();
  assert.equal((await recovered.status(target)).currentAgentSeq, "5");
  const externalExactRetry = await recovered.ingest(trustedBinding, externalCasUnacked);
  assert.equal(externalExactRetry.disposition, "duplicate");
  assert.equal(externalExactRetry.agentEventSeq, "5");

  let sawDurableStateBeforeAnchor = false;
  h.continuityAuthority.onCas = (request, commit) => {
    h.continuityAuthority.onCas = null;
    const exactStateBytes = readFileSync(h.store.paths.state);
    assert.equal(
      createHash("sha256").update(exactStateBytes).digest("hex"),
      request.next.stateDigest,
      "the anchor digest must cover the strict-validated exact durable bytes",
    );
    const durable = JSON.parse(exactStateBytes);
    assert.equal(durable.sessions[0].timeline.authority.agentEventSeq, "6");
    sawDurableStateBeforeAnchor = true;
    return commit();
  };
  const acknowledged = await recovered.ingest(trustedBinding, sourceEvent(6, "commit-before-ack-entry", {
    mutationType: "text_entry.appended",
    entryId: "entry-committed-before-ack",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "durable before ACK",
    commandId: null,
  }));
  assert.equal(acknowledged.disposition, "applied");
  assert.equal(sawDurableStateBeforeAnchor, true);
});

test("two store writers use the locked local CAS and only one successor reaches the anchor", async (t) => {
  const h = await harness(t);
  const left = runtimeFor(h.store);
  await establishConversation(left);
  const right = runtimeFor(await h.open());
  const casCallsBeforeRace = h.continuityAuthority.casCalls;
  const readsBeforeRace = h.continuityAuthority.readCalls;
  let rightResult;
  h.continuityAuthority.onRead = async (_request, snapshot) => {
    const captured = snapshot();
    if (h.continuityAuthority.readCalls - readsBeforeRace === 2) {
      h.continuityAuthority.onRead = null;
      rightResult = await ingest(right, 4, "writer-right", {
        mutationType: "text_entry.appended",
        entryId: "entry-writer-right",
        runId: "run-1",
        turnId: "turn-1",
        role: "agent",
        text: "right writer won",
        commandId: null,
      });
    }
    return captured;
  };

  await assert.rejects(
    left.ingestTrustedSource(trustedBinding, sourceEvent(4, "writer-left", {
      mutationType: "text_entry.appended",
      entryId: "entry-writer-left",
      runId: "run-1",
      turnId: "turn-1",
      role: "agent",
      text: "left writer lost",
      commandId: null,
    })),
    storeModule.RelayAgentAuthorityStoreCorruptError,
  );
  assert.equal(rightResult.reduction.disposition, "applied");
  assert.equal(h.continuityAuthority.casCalls, casCallsBeforeRace + 1, "the local CAS loser must not publish externally");
  const exactStateBytes = readFileSync(h.store.paths.state);
  const durable = JSON.parse(exactStateBytes);
  assert.deepEqual(
    durable.sessions[0].timeline.authority.entries.map((item) => item.key),
    ["entry-writer-right"],
  );
  assert.equal(
    h.continuityAuthority.current.checkpoint.stateDigest,
    createHash("sha256").update(exactStateBytes).digest("hex"),
  );
  assert.equal((await (await h.open()).status(target)).currentAgentSeq, "4");
});

test("deferred anchor overlap never holds the file lock across reconcile", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  await establishConversation(runtime);
  const advanceReadStarted = deferred();
  const releaseAdvanceRead = deferred();
  const readsBeforeOverlap = h.continuityAuthority.readCalls;
  const casCallsBeforeOverlap = h.continuityAuthority.casCalls;
  let controlledReads = 0;
  h.continuityAuthority.onRead = async (_request, snapshot) => {
    controlledReads += 1;
    const captured = snapshot();
    if (controlledReads === 2) {
      h.continuityAuthority.onRead = null;
      advanceReadStarted.resolve();
      await releaseAdvanceRead.promise;
    }
    return captured;
  };

  const winner = runtime.ingestTrustedSource(trustedBinding, sourceEvent(4, "overlap-winner", {
    mutationType: "text_entry.appended",
    entryId: "entry-overlap-winner",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "winner",
    commandId: null,
  }));
  await advanceReadStarted.promise;
  const loser = runtime.ingestTrustedSource(trustedBinding, sourceEvent(4, "overlap-loser", {
    mutationType: "text_entry.appended",
    entryId: "entry-overlap-loser",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "loser",
    commandId: null,
  }));
  await nextTurn();

  const releasedAtMs = Date.now();
  releaseAdvanceRead.resolve();
  await nextTurn();
  assert.ok(
    Date.now() - releasedAtMs < 2_000,
    "releasing the deferred anchor read must not expose the five-second blocking lock wait",
  );

  const [winnerResult, loserResult] = await Promise.all([winner, loser]);
  assert.equal(winnerResult.reduction.disposition, "applied");
  assert.equal(loserResult.reduction.disposition, "source_history_expired");
  assert.ok(
    h.continuityAuthority.readCalls >= readsBeforeOverlap + 4,
    "the stale reconcile must re-read the winner checkpoint before running its mutator",
  );
  assert.equal(
    h.continuityAuthority.casCalls,
    casCallsBeforeOverlap + 1,
    "the stale loser must not publish a second external checkpoint",
  );
  const durable = JSON.parse(readFileSync(h.store.paths.state));
  assert.deepEqual(
    durable.sessions[0].timeline.authority.entries.map((item) => item.key),
    ["entry-overlap-winner"],
  );
  assert.equal(h.continuityAuthority.current.checkpoint.sequence, durable.commitSeq);
});

test("trusted-source ingress freezes binding and provides zero-queue admission with a durable close barrier", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  const originalIngest = runtime.ingestTrustedSource.bind(runtime);
  let runtimeCalls = 0;
  runtime.ingestTrustedSource = (...args) => {
    runtimeCalls += 1;
    return originalIngest(...args);
  };
  const ingress = new runtimeModule.RelayAgentTrustedSourceIngressLease(runtime);
  const ingressError = (code) => (error) => (
    error instanceof runtimeModule.RelayAgentTrustedSourceIngressLeaseError
      && error.code === code
  );

  await assert.rejects(
    ingress.ingestTrustedSource(sourceEvent(1, "disabled", { mutationType: "source.started" })),
    ingressError("DISABLED"),
  );
  assert.equal(runtimeCalls, 0);

  const mutableBinding = { ...trustedBinding };
  ingress.enable(mutableBinding);
  mutableBinding.sessionId = "caller-mutated-session";
  const started = await ingress.ingestTrustedSource(
    sourceEvent(1, "leased-source-started", { mutationType: "source.started" }),
  );
  assert.equal(started.reduction.disposition, "applied");
  assert.equal(started.delivery.provenance, "LIVE");
  assert.equal(started.delivery.frame.type, "agent.timeline.event");
  assert.equal(started.delivery.frame.sessionId, trustedBinding.sessionId);
  assert.equal(started.delivery.frame.payload.eventId, started.reduction.publicEvent.eventId);
  assert.equal(
    started.delivery.frame.payload.agentEventSeq,
    started.reduction.publicEvent.agentEventSeq,
  );
  assert.equal(runtimeCalls, 1);

  const gap = await ingress.ingestTrustedSource(sourceEvent(3, "leased-source-gap", {
    mutationType: "source.availability",
    state: "interrupted",
    reason: "source_disconnected",
  }));
  assert.equal(gap.reduction.disposition, "source_gap");
  assert.equal(gap.delivery, null);

  const durableIngestEntered = deferred();
  const releaseDurableIngest = deferred();
  h.continuityAuthority.onCas = async (_request, commit) => {
    h.continuityAuthority.onCas = null;
    durableIngestEntered.resolve();
    await releaseDurableIngest.promise;
    return commit();
  };
  const pending = ingress.ingestTrustedSource(sourceEvent(2, "leased-run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "leased-run",
    turnId: null,
    state: "running",
    failure: null,
  }));
  let pendingSettled = false;
  void pending.then(
    () => { pendingSettled = true; },
    () => { pendingSettled = true; },
  );
  await durableIngestEntered.promise;
  assert.equal(runtimeCalls, 3);
  await assert.rejects(
    ingress.ingestTrustedSource(sourceEvent(3, "must-not-queue", {
      mutationType: "source.availability",
      state: "interrupted",
      reason: "source_disconnected",
    })),
    ingressError("BUSY"),
  );
  assert.equal(runtimeCalls, 3);

  const closing = ingress.close();
  assert.equal(ingress.close(), closing);
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  await assert.rejects(
    ingress.ingestTrustedSource(sourceEvent(3, "closed-admission", {
      mutationType: "source.availability",
      state: "interrupted",
      reason: "source_disconnected",
    })),
    ingressError("CLOSED"),
  );
  await nextTurn();
  assert.equal(pendingSettled, false);
  assert.equal(closeSettled, false);
  assert.equal(runtimeCalls, 3);

  releaseDurableIngest.resolve();
  const applied = await pending;
  assert.equal(applied.reduction.disposition, "applied");
  await closing;
  assert.equal(closeSettled, true);
});

test("trusted-source ingress closes binding publication on extra fields and getter reentry", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  const originalIngest = runtime.ingestTrustedSource.bind(runtime);
  let runtimeCalls = 0;
  runtime.ingestTrustedSource = (...args) => {
    runtimeCalls += 1;
    return originalIngest(...args);
  };
  const ingressError = (code) => (error) => (
    error instanceof runtimeModule.RelayAgentTrustedSourceIngressLeaseError
      && error.code === code
  );

  const extraIngress = new runtimeModule.RelayAgentTrustedSourceIngressLease(runtime);
  assert.throws(
    () => extraIngress.enable({ ...trustedBinding, extra: "must-not-be-normalized-away" }),
    (error) => error?.code === "adapter_binding_invalid",
  );
  await assert.rejects(
    extraIngress.ingestTrustedSource(sourceEvent(1, "extra-rejected", {
      mutationType: "source.started",
    })),
    ingressError("SEALED"),
  );

  const closeIngress = new runtimeModule.RelayAgentTrustedSourceIngressLease(runtime);
  const closeReentrantBinding = { ...trustedBinding };
  Object.defineProperty(closeReentrantBinding, "sessionId", {
    enumerable: true,
    get() {
      void closeIngress.close();
      return trustedBinding.sessionId;
    },
  });
  assert.throws(() => closeIngress.enable(closeReentrantBinding), ingressError("CLOSED"));

  const enableIngress = new runtimeModule.RelayAgentTrustedSourceIngressLease(runtime);
  const enableReentrantBinding = { ...trustedBinding };
  Object.defineProperty(enableReentrantBinding, "sessionId", {
    enumerable: true,
    get() {
      assert.throws(() => enableIngress.enable({ ...trustedBinding }), ingressError("SEALED"));
      return trustedBinding.sessionId;
    },
  });
  assert.throws(() => enableIngress.enable(enableReentrantBinding), ingressError("SEALED"));
  assert.equal(runtimeCalls, 0);
});

test("trusted-source ingress seals after a durable ingest rejection", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  const originalIngest = runtime.ingestTrustedSource.bind(runtime);
  let runtimeCalls = 0;
  runtime.ingestTrustedSource = (...args) => {
    runtimeCalls += 1;
    return originalIngest(...args);
  };
  const ingress = new runtimeModule.RelayAgentTrustedSourceIngressLease(runtime);
  ingress.enable({ ...trustedBinding });
  h.continuityAuthority.failReads = true;

  await assert.rejects(
    ingress.ingestTrustedSource(sourceEvent(1, "fatal-source-started", {
      mutationType: "source.started",
    })),
    storeModule.RelayAgentAuthorityStoreContinuityUnavailableError,
  );
  assert.equal(runtimeCalls, 1);

  h.continuityAuthority.failReads = false;
  await assert.rejects(
    ingress.ingestTrustedSource(sourceEvent(1, "blind-retry", {
      mutationType: "source.started",
    })),
    (error) => error instanceof runtimeModule.RelayAgentTrustedSourceIngressLeaseError
      && error.code === "SEALED",
  );
  assert.equal(runtimeCalls, 1);
  const closing = ingress.close();
  assert.equal(ingress.close(), closing);
  await closing;
  assert.equal(runtimeCalls, 1);
});

test("missing or unavailable external continuity keeps the extension foundation unavailable", async (t) => {
  const missingHome = mkdtempSync(join(tmpdir(), "tw-agent-authority-missing-anchor-"));
  t.after(() => rmSync(missingHome, { recursive: true, force: true }));
  await assert.rejects(
    storeModule.RelayAgentAuthorityStore.open({ ...owner, home: missingHome }),
    storeModule.RelayAgentAuthorityStoreContinuityUnavailableError,
  );

  const h = await harness(t);
  h.continuityAuthority.failReads = true;
  await assert.rejects(h.open(), storeModule.RelayAgentAuthorityStoreContinuityUnavailableError);
  const unavailable = await runtimeFor(h.store).handleRequest(
    requestBytes("agent.timeline.status.get", {}),
    {},
    routeContext(),
  );
  assert.equal(unavailable.frame.type, "agent.timeline.status");
  assert.equal(unavailable.frame.payload.support, "unavailable");
  assert.equal(unavailable.frame.payload.reason, "store_unavailable");
});

test("standalone runtime is capability/route gated and isolates host-epoch and store failures", async (t) => {
  const h = await harness(t);
  const runtime = runtimeFor(h.store);
  let malformedError;
  try {
    await runtime.handleRequest(Buffer.from("{"), {}, routeContext());
  } catch (error) {
    malformedError = error;
  }
  assert.deepEqual(codecModule.relayAgentCodecFailure(malformedError), {
    domain: codecModule.RELAY_AGENT_CODEC_ERROR_DOMAIN,
    code: "INVALID_ENVELOPE",
    failureClass: "malformed-json",
  });
  await assert.rejects(
    runtime.handleRequest(
      requestBytes("agent.timeline.status.get", {}),
      {},
      routeContext({ capabilityNegotiated: false }),
    ),
    runtimeModule.RelayAgentExtensionNotNegotiatedError,
  );
  await assert.rejects(
    runtime.handleRequest(
      requestBytes("agent.timeline.status.get", {}),
      {},
      routeContext({ sessionId: "different-session" }),
    ),
    runtimeModule.RelayAgentExtensionRouteBindingError,
  );

  const staleEpochRequest = JSON.parse(requestBytes("agent.timeline.status.get", {}).toString("utf8"));
  staleEpochRequest.expectedHostEpoch = "old-host-epoch";
  const mismatch = await runtime.handleRequest(
    Buffer.from(JSON.stringify(staleEpochRequest)),
    {},
    routeContext(),
  );
  assert.equal(mismatch.frame.type, "error");
  assert.equal(mismatch.frame.error.code, "HOST_EPOCH_MISMATCH");
  assert.deepEqual(mismatch.frame.error.details, {
    expectedHostEpoch: "old-host-epoch",
    actualHostEpoch: owner.hostEpoch,
  });

  writeFileSync(h.store.paths.state, "{not-json", { mode: 0o600 });
  const unavailable = await runtime.handleRequest(
    requestBytes("agent.timeline.status.get", {}),
    {},
    routeContext(),
  );
  assert.equal(unavailable.frame.type, "agent.timeline.status");
  assert.equal(unavailable.frame.payload.support, "unavailable");
  assert.equal(unavailable.frame.payload.reason, "store_unavailable");
});
