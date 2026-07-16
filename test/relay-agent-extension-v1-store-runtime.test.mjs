import assert from "node:assert/strict";
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

function harness(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "tw-agent-authority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clock = { value: 1_900_000_000_000 };
  const randomId = sequentialIds("durable-id");
  const randomCursor = sequentialIds("durable-cursor");
  const options = {
    ...owner,
    home,
    eventReplayRetentionMs: retentionMs,
    now: () => clock.value,
    randomId,
    randomCursor,
    ...overrides,
  };
  const open = (extra = {}) => storeModule.RelayAgentAuthorityStore.open({ ...options, ...extra });
  return { home, clock, options, open, store: open() };
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

function ingest(runtime, seq, id, mutation, expected = "applied") {
  const result = runtime.ingestTrustedSource(trustedBinding, sourceEvent(seq, id, mutation));
  assert.equal(result.reduction.disposition, expected, id);
  return result;
}

function establishConversation(runtime) {
  ingest(runtime, 1, "source-started", { mutationType: "source.started" });
  ingest(runtime, 2, "run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-1",
    turnId: null,
    state: "running",
    failure: null,
  });
  ingest(runtime, 3, "turn-running", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "running",
    failure: null,
  });
}

test("durable host authority emits real reply/lifecycle identity and pins disconnect replay", (t) => {
  const h = harness(t);
  let runtime = runtimeFor(h.store);
  establishConversation(runtime);

  const reply = ingest(runtime, 4, "agent-reply-1", {
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

  const waiting = ingest(runtime, 5, "turn-waiting", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "waiting_for_user",
    failure: null,
  });
  assert.equal(waiting.delivery.frame.payload.mutation.lifecycle.state, "waiting_for_user");
  ingest(runtime, 6, "user-reply", {
    mutationType: "text_entry.appended",
    entryId: "entry-user-1",
    runId: "run-1",
    turnId: "turn-1",
    role: "user",
    text: "Use staging",
    commandId: "command-user-1",
  });
  ingest(runtime, 7, "turn-resumed", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "running",
    failure: null,
  });
  ingest(runtime, 8, "agent-reply-2", {
    mutationType: "text_entry.appended",
    entryId: "entry-agent-2",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: "Staging is healthy",
    commandId: null,
  });
  const completed = ingest(runtime, 9, "turn-completed", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "completed",
    failure: null,
  });
  assert.equal(completed.delivery.frame.payload.mutation.lifecycle.state, "completed");

  const firstReplay = runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
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

  ingest(runtime, 10, "run-completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-1",
    turnId: null,
    state: "completed",
    failure: null,
  });
  const stableEventId = completed.delivery.frame.payload.eventId;
  runtime = runtimeFor(h.open());
  const secondReplay = runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: firstReplay.frame.payload.nextCursor,
    limit: 2,
  }, "replay-second"), {}, routeContext());
  assert.equal(secondReplay.frame.payload.replayThroughAgentSeq, "9");
  assert.deepEqual(secondReplay.frame.payload.events.map((item) => item.agentEventSeq), ["6", "7"]);
  const thirdReplay = runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: secondReplay.frame.payload.nextCursor,
    limit: 2,
  }, "replay-third"), {}, routeContext());
  assert.deepEqual(thirdReplay.frame.payload.events.map((item) => item.agentEventSeq), ["8", "9"]);
  assert.equal(thirdReplay.frame.payload.events.at(-1).eventId, stableEventId);
  assert.equal(thirdReplay.frame.payload.isLast, true);
  assert.equal(thirdReplay.frame.payload.nextCursor, null);

  const retriedFirst = runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
    timelineEpoch: reply.delivery.frame.payload.timelineEpoch,
    afterAgentSeq: "3",
    cursor: null,
    limit: 2,
  }, "replay-first-retry"), {}, routeContext());
  assert.deepEqual(retriedFirst.frame.payload, firstReplay.frame.payload);

  ingest(runtime, 11, "startup-run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-startup",
    turnId: null,
    state: "running",
    failure: null,
  });
  const failed = ingest(runtime, 12, "startup-run-failed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-startup",
    turnId: null,
    state: "failed",
    failure: { code: "agent_start_failed", summary: "safe summary" },
  });
  assert.equal(failed.delivery.frame.payload.mutation.lifecycle.state, "failed");
  assert.equal(failed.delivery.frame.payload.mutation.lifecycle.failure.code, "agent_start_failed");

  const status = runtime.handleRequest(
    requestBytes("agent.timeline.status.get", {}, "status"),
    {},
    routeContext(),
  );
  assert.equal(status.provenance, "CONTROL");
  assert.equal(status.frame.payload.support, "available");
  assert.equal(status.frame.payload.currentAgentSeq, "12");
  assert.equal(status.frame.payload.activeSourceEpoch, "source-agent");

  const snapshot = runtime.handleRequest(requestBytes("agent.timeline.snapshot.get", {
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

  const duplicate = runtime.ingestTrustedSource(
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
  const invalidTerminal = ingest(runtime, 13, "run-terminal-regression", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-startup",
    turnId: null,
    state: "running",
    failure: null,
  }, "invalid_transition");
  assert.equal(invalidTerminal.delivery, null);
  assert.equal(invalidTerminal.reduction.agentEventSeq, "12");
  const gap = ingest(runtime, 14, "source-gap", {
    mutationType: "source.availability",
    state: "interrupted",
    reason: "source_disconnected",
  }, "source_gap");
  assert.equal(gap.reduction.expectedSourceSeq, "13");
  const conflict = runtime.ingestTrustedSource(trustedBinding, {
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

test("snapshot and replay cuts freeze only pages that pass the full public wire budget", (t) => {
  const h = harness(t);
  const runtime = runtimeFor(h.store);
  establishConversation(runtime);
  for (let index = 0; index < 16; index += 1) {
    ingest(runtime, index + 4, `large-entry-source-${index}`, {
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
    const page = runtime.handleRequest(requestBytes("agent.timeline.snapshot.get", {
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

  const timelineEpoch = h.store.status(target).timelineEpoch;
  const replayPages = [];
  let replayCursor = null;
  do {
    const page = runtime.handleRequest(requestBytes("agent.timeline.replay.get", {
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

test("redaction/delete revoke body-bearing cuts, advance a prefix floor, and retain used entry identity", (t) => {
  const h = harness(t);
  const runtime = runtimeFor(h.store);
  establishConversation(runtime);
  const secretBody = "body-that-must-not-survive-redaction";
  ingest(runtime, 4, "secret-entry", {
    mutationType: "text_entry.appended",
    entryId: "entry-used",
    runId: "run-1",
    turnId: "turn-1",
    role: "agent",
    text: secretBody,
    commandId: null,
  });
  ingest(runtime, 5, "turn-waiting", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "waiting_for_user",
    failure: null,
  });
  const status = h.store.status(target);
  const oldSnapshot = h.store.snapshot({
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    target,
    snapshotRequestId: "body-bearing-snapshot",
    snapshotId: null,
    cursor: null,
    nextPageIndex: 0,
  });
  assert.ok(oldSnapshot.records.some((item) => item.recordType === "text_entry" && item.text === secretBody));
  const oldReplay = h.store.replay({
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

  const redacted = ingest(runtime, 6, "secret-redacted", {
    mutationType: "entry.redacted",
    entryId: "entry-used",
    reason: "policy",
  });
  assert.deepEqual(redacted.delivery.frame.payload.mutation, {
    mutationType: "entry.redacted",
    entryId: "entry-used",
    reason: "policy",
  });
  assert.throws(
    () => h.store.snapshot({
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
  assert.throws(
    () => h.store.replay({
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
  assert.equal(h.store.status(target).earliestReplaySeq, "5");
  assert.throws(
    () => h.store.replay({
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
  const redactionReplay = h.store.replay({
    principalId: "principal-agent",
    clientInstanceId: "client-agent",
    target,
    timelineEpoch: status.timelineEpoch,
    afterAgentSeq: "5",
    cursor: null,
    limit: 256,
  });
  assert.deepEqual(redactionReplay.events.map((item) => item.agentEventSeq), ["6"]);
  const sanitized = h.store.snapshot({
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

  ingest(runtime, 7, "secret-deleted", {
    mutationType: "entry.deleted",
    entryId: "entry-used",
    reason: "retention",
  });
  h.clock.value += retentionMs + 1;
  assert.equal(h.store.status(target).earliestReplaySeq, "7");
  const reuse = ingest(runtime, 8, "entry-reuse-after-retention", {
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
  assert.equal(h.open().status(target).currentAgentSeq, "7");
});

test("first durable directory creation fsyncs every new layer and its parent", (t) => {
  const fsyncedDirectories = [];
  const h = harness(t, {
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

test("continuity repair accepts only a published one-ahead commit and rejects rollback/corruption/unknown ownership", (t) => {
  const h = harness(t);
  let runtime = runtimeFor(h.store);
  ingest(runtime, 1, "source-started", { mutationType: "source.started" });
  const stateA = readFileSync(h.store.paths.state);
  const witnessA = readFileSync(h.store.paths.continuity);
  ingest(runtime, 2, "run-running", {
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
  assert.equal(h.open().status(target).currentAgentSeq, "2");
  assert.deepEqual(readFileSync(h.store.paths.continuity), witnessB);

  writeFileSync(h.store.paths.state, stateA, { mode: 0o600 });
  assert.throws(() => h.open(), storeModule.RelayAgentAuthorityStoreCorruptError);
  assert.deepEqual(readFileSync(h.store.paths.state), stateA, "rollback evidence must not be overwritten");
  writeFileSync(h.store.paths.state, stateB, { mode: 0o600 });
  writeFileSync(h.store.paths.continuity, witnessB, { mode: 0o600 });

  const corrupt = Buffer.from(stateB);
  corrupt[corrupt.indexOf(Buffer.from("run-1"))] = "x".charCodeAt(0);
  writeFileSync(h.store.paths.state, corrupt, { mode: 0o600 });
  assert.throws(() => h.open(), storeModule.RelayAgentAuthorityStoreCorruptError);
  assert.deepEqual(readFileSync(h.store.paths.state), corrupt, "corrupt state must remain fail-closed");
  writeFileSync(h.store.paths.state, stateB, { mode: 0o600 });

  const realState = `${h.store.paths.state}.real`;
  renameSync(h.store.paths.state, realState);
  symlinkSync(realState, h.store.paths.state);
  assert.equal(lstatSync(h.store.paths.state).isSymbolicLink(), true);
  assert.throws(() => h.open(), storeModule.RelayAgentAuthorityStoreOwnershipError);
  unlinkSync(h.store.paths.state);
  renameSync(realState, h.store.paths.state);
  chmodSync(h.store.paths.state, 0o600);

  runtime = runtimeFor(h.open());
  ingest(runtime, 3, "turn-running", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-1",
    turnId: "turn-1",
    state: "running",
    failure: null,
  });
  const beforeCapacity = statSync(h.store.paths.state).size;
  const capped = h.open({ testMaxPersistedBytes: beforeCapacity + 2_000 });
  assert.throws(
    () => capped.ingest(trustedBinding, sourceEvent(4, "large-entry", {
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
  assert.equal(h.open().status(target).currentAgentSeq, "3");

  const strictState = readFileSync(h.store.paths.state);
  const strictCounts = strictJsonCounts(JSON.parse(strictState));
  for (const [budgetName, budget] of [
    ["testMaxPersistedJsonKeys", strictCounts.keys + 10],
    ["testMaxPersistedJsonNodes", strictCounts.nodes + 10],
  ]) {
    const strictCapped = h.open({ [budgetName]: budget });
    assert.throws(
      () => strictCapped.ingest(trustedBinding, sourceEvent(4, `strict-${budgetName}`, {
        mutationType: "text_entry.appended",
        entryId: `strict-${budgetName}`,
        runId: "run-1",
        turnId: "turn-1",
        role: "agent",
        text: "must not be ACKed",
        commandId: null,
      })),
      storeModule.RelayAgentAuthorityStoreCapacityError,
      budgetName,
    );
    assert.deepEqual(readFileSync(h.store.paths.state), strictState, `${budgetName} must reject before publish`);
    assert.equal(h.open({ [budgetName]: budget }).status(target).currentAgentSeq, "3");
  }

  let failPublishedState = true;
  const uncertain = h.open({
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
  assert.throws(
    () => uncertain.ingest(trustedBinding, committedButUnacked),
    storeModule.RelayAgentAuthorityStoreCommitUncertainError,
  );
  const recovered = h.open();
  assert.equal(recovered.status(target).currentAgentSeq, "4");
  const exactRetry = recovered.ingest(trustedBinding, committedButUnacked);
  assert.equal(exactRetry.disposition, "duplicate");
  assert.equal(exactRetry.agentEventSeq, "4");
});

test("standalone runtime is capability/route gated and isolates host-epoch and store failures", (t) => {
  const h = harness(t);
  const runtime = runtimeFor(h.store);
  let malformedError;
  try {
    runtime.handleRequest(Buffer.from("{"), {}, routeContext());
  } catch (error) {
    malformedError = error;
  }
  assert.deepEqual(codecModule.relayAgentCodecFailure(malformedError), {
    domain: codecModule.RELAY_AGENT_CODEC_ERROR_DOMAIN,
    code: "INVALID_ENVELOPE",
    failureClass: "malformed-json",
  });
  assert.throws(
    () => runtime.handleRequest(
      requestBytes("agent.timeline.status.get", {}),
      {},
      routeContext({ capabilityNegotiated: false }),
    ),
    runtimeModule.RelayAgentExtensionNotNegotiatedError,
  );
  assert.throws(
    () => runtime.handleRequest(
      requestBytes("agent.timeline.status.get", {}),
      {},
      routeContext({ sessionId: "different-session" }),
    ),
    runtimeModule.RelayAgentExtensionRouteBindingError,
  );

  const staleEpochRequest = JSON.parse(requestBytes("agent.timeline.status.get", {}).toString("utf8"));
  staleEpochRequest.expectedHostEpoch = "old-host-epoch";
  const mismatch = runtime.handleRequest(
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
  const unavailable = runtime.handleRequest(
    requestBytes("agent.timeline.status.get", {}),
    {},
    routeContext(),
  );
  assert.equal(unavailable.frame.type, "agent.timeline.status");
  assert.equal(unavailable.frame.payload.support, "unavailable");
  assert.equal(unavailable.frame.payload.reason, "store_unavailable");
});
