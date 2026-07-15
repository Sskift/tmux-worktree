import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const authority = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/authority.js"
);

const authorityCases = JSON.parse(readFileSync(new URL(
  "../contracts/relay/extensions/agent-transcript-lifecycle/v1/authority-machine-cases.json",
  import.meta.url,
), "utf8"));

const binding = Object.freeze({
  hostId: "host-opaque",
  hostEpoch: "host-epoch-opaque",
  scopeId: "scope-opaque",
  sessionId: "session-opaque",
  timelineEpoch: "timeline-opaque",
});

const noCommitDispositions = new Set([
  "duplicate",
  "source_gap",
  "stale_source",
  "source_history_expired",
  "invalid_transition",
  "terminal_conflict",
  "entry_id_conflict",
  "entry_deleted",
]);

function sourceEvent(sourceSeq, sourceEventId, mutation, sourceEpoch = "source-main", occurredAtMs = 1_000) {
  return { sourceEpoch, sourceSeq, sourceEventId, occurredAtMs, mutation };
}

function apply(state, input, disposition = "applied") {
  const reduction = authority.reduceRelayAgentAuthority(state, input);
  assert.equal(reduction.disposition, disposition);
  return reduction;
}

function expectedObservation(reduction, input) {
  const { state } = reduction;
  const mutation = input.mutation;
  const entryId = mutation.entryId;
  return {
    disposition: reduction.disposition,
    agentEventSeq: reduction.agentEventSeq,
    expectedSourceSeq: reduction.expectedSourceSeq,
    activeSourceEpoch: state.activeSourceEpoch,
    runState: mutation.runId === undefined ? undefined : state.runs[mutation.runId]?.state,
    turnState: mutation.turnId === undefined || mutation.turnId === null
      ? undefined
      : Object.values(state.turns).find((turn) => (
        turn.runId === mutation.runId && turn.turnId === mutation.turnId
      ))?.state,
    entryCount: Object.keys(state.entries).length,
    entryState: entryId === undefined
      ? undefined
      : state.entries[entryId]?.state ?? (state.deletedEntries[entryId] ? "deleted" : undefined),
  };
}

test("shared authority machine cases drive the production reducer and consume every expectation", () => {
  for (const fixture of authorityCases) {
    let state = authority.createRelayAgentAuthorityState(binding);
    for (const [index, step] of fixture.steps.entries()) {
      const before = state;
      const beforeJson = JSON.stringify(before);
      const reduction = authority.reduceRelayAgentAuthority(before, step.input);
      const observed = expectedObservation(reduction, step.input);

      for (const [key, expected] of Object.entries(step.expect)) {
        assert.ok(Object.hasOwn(observed, key), `${fixture.name}[${index}] consumes expect.${key}`);
        assert.deepEqual(observed[key], expected, `${fixture.name}[${index}].expect.${key}`);
      }
      assert.equal(JSON.stringify(before), beforeJson, `${fixture.name}[${index}] mutated prior state`);

      if (reduction.disposition === "applied") {
        assert.notEqual(reduction.state, before, `${fixture.name}[${index}] must return a new state`);
        assert.ok(reduction.publicEvent, `${fixture.name}[${index}] public event`);
        assert.equal(reduction.publicEvent.agentEventSeq, reduction.state.agentEventSeq);
        assert.notEqual(reduction.publicEvent.eventId, step.input.sourceEventId);
        if (step.input.mutation.mutationType === "source.started") {
          assert.equal(reduction.publicEvent.mutation.mutationType, "source.availability");
          assert.equal(reduction.publicEvent.mutation.state, "connected");
        }
        if (step.input.mutation.mutationType === "lifecycle.changed") {
          assert.equal(reduction.publicEvent.mutation.lifecycle.lifecycleEventId, reduction.publicEvent.eventId);
          assert.notEqual(reduction.publicEvent.mutation.lifecycle.lifecycleEventId, step.input.sourceEventId);
        }
      } else if (reduction.disposition === "redundant_terminal") {
        assert.notEqual(reduction.state, before, `${fixture.name}[${index}] must consume source cursor`);
        assert.equal(reduction.publicEvent, null);
      } else if (noCommitDispositions.has(reduction.disposition)) {
        assert.equal(reduction.state, before, `${fixture.name}[${index}] must not half-commit`);
        assert.equal(reduction.publicEvent, null);
      }
      state = reduction.state;
    }
  }
});

test("source dedupe uses the full canonical fingerprint, fences conflicts, and expires without evidence", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  const started = sourceEvent("1", "start-key", { mutationType: "source.started" });
  const first = apply(state, started);
  state = first.state;

  const duplicate = apply(state, structuredClone(started), "duplicate");
  assert.equal(duplicate.state, state);
  assert.equal(duplicate.agentEventSeq, "1");
  assert.equal(duplicate.publicEvent, null);

  const conflicting = structuredClone(started);
  conflicting.occurredAtMs += 1;
  const conflict = apply(state, conflicting, "source_event_conflict");
  assert.notEqual(conflict.state, state);
  assert.equal(conflict.sourceFenced, true);
  assert.equal(conflict.agentEventSeq, "1");
  assert.equal(conflict.state.sources["source-main"].lastSourceSeq, "1");
  assert.equal(conflict.publicEvent, null);

  const fenced = apply(conflict.state, sourceEvent("2", "after-fence", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-after-fence",
    turnId: null,
    state: "running",
    failure: null,
  }), "source_event_conflict");
  assert.equal(fenced.state, conflict.state);

  const restarted = apply(conflict.state, sourceEvent(
    "1",
    "new-source-start",
    { mutationType: "source.started" },
    "source-new",
  ));
  assert.equal(restarted.state.activeSourceEpoch, "source-new");

  state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, started).state;
  const running = sourceEvent("2", "run-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-history",
    turnId: null,
    state: "running",
    failure: null,
  });
  state = apply(state, running).state;

  const retainedDuplicate = apply(state, running, "duplicate");
  assert.equal(retainedDuplicate.state, state, "dedupe evidence wins before old-sequence handling");

  const source = state.sources["source-main"];
  const trimmedDedupe = { ...source.dedupe };
  delete trimmedDedupe["start-key"];
  const trimmedState = {
    ...state,
    sources: {
      ...state.sources,
      "source-main": { ...source, dedupe: trimmedDedupe },
    },
  };
  const expired = apply(trimmedState, started, "source_history_expired");
  assert.equal(expired.state, trimmedState);
  assert.equal(expired.agentEventSeq, "2");
});

test("rejected ordered events leave no cursor evidence, while redundant terminal advances only sourceSeq", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent("1", "start", { mutationType: "source.started" })).state;

  const invalidWaiting = sourceEvent("2", "invalid-waiting", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-sequence",
    turnId: null,
    state: "waiting_for_user",
    failure: null,
  });
  const invalid = apply(state, invalidWaiting, "invalid_transition");
  assert.equal(invalid.state, state);
  assert.equal(state.sources["source-main"].lastSourceSeq, "1");

  state = apply(state, sourceEvent("2", "corrected-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-sequence",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("3", "completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-sequence",
    turnId: null,
    state: "completed",
    failure: null,
  })).state;
  const redundant = apply(state, sourceEvent("4", "completed-again", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-sequence",
    turnId: null,
    state: "completed",
    failure: null,
  }), "redundant_terminal");
  state = redundant.state;
  assert.equal(state.sources["source-main"].lastSourceSeq, "4");
  assert.equal(state.agentEventSeq, "3");
  assert.equal(redundant.publicEvent, null);

  state = apply(state, sourceEvent("5", "next-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-after-redundant",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  assert.equal(state.sources["source-main"].lastSourceSeq, "5");
  assert.equal(state.agentEventSeq, "4");
});

test("run, turn, entry, and terminal prerequisites can be corrected at the same sourceSeq", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent("1", "start", { mutationType: "source.started" })).state;
  state = apply(state, sourceEvent("2", "run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-constraints",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("3", "turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-constraints",
    turnId: "turn-one",
    state: "running",
    failure: null,
  })).state;

  assert.equal(apply(state, sourceEvent("4", "second-active-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-constraints",
    turnId: "turn-two",
    state: "running",
    failure: null,
  }), "invalid_transition").state, state);
  assert.equal(apply(state, sourceEvent("4", "run-waits-too-early", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-constraints",
    turnId: null,
    state: "waiting_for_user",
    failure: null,
  }), "invalid_transition").state, state);

  state = apply(state, sourceEvent("4", "turn-waits", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-constraints",
    turnId: "turn-one",
    state: "waiting_for_user",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("5", "run-waits", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-constraints",
    turnId: null,
    state: "waiting_for_user",
    failure: null,
  })).state;

  assert.equal(apply(state, sourceEvent("6", "agent-cannot-write-while-waiting", {
    mutationType: "text_entry.appended",
    entryId: "agent-entry-rejected",
    runId: "run-constraints",
    turnId: "turn-one",
    role: "agent",
    text: "not authoritative now",
    commandId: null,
  }), "invalid_transition").state, state);
  state = apply(state, sourceEvent("6", "user-can-write-while-waiting", {
    mutationType: "text_entry.appended",
    entryId: "user-entry",
    runId: "run-constraints",
    turnId: "turn-one",
    role: "user",
    text: "more context",
    commandId: "command-correlation-only",
  })).state;

  assert.equal(apply(state, sourceEvent("7", "run-terminal-too-early", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-constraints",
    turnId: null,
    state: "completed",
    failure: null,
  }), "invalid_transition").state, state);
  state = apply(state, sourceEvent("7", "turn-completed", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-constraints",
    turnId: "turn-one",
    state: "completed",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("8", "run-completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-constraints",
    turnId: null,
    state: "completed",
    failure: null,
  })).state;
  assert.equal(apply(state, sourceEvent("9", "terminal-entry", {
    mutationType: "text_entry.appended",
    entryId: "too-late",
    runId: "run-constraints",
    turnId: "turn-one",
    role: "user",
    text: "late",
    commandId: null,
  }), "invalid_transition").state, state);
});

test("restart cannot resume an old run and delete tombstones fence a new source", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent("1", "old-start", { mutationType: "source.started" }, "source-old")).state;
  state = apply(state, sourceEvent("2", "old-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-old",
    turnId: null,
    state: "running",
    failure: null,
  }, "source-old")).state;
  state = apply(state, sourceEvent("3", "old-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-old",
    turnId: "turn-old",
    state: "running",
    failure: null,
  }, "source-old")).state;
  state = apply(state, sourceEvent("4", "old-entry", {
    mutationType: "text_entry.appended",
    entryId: "entry-never-reuse",
    runId: "run-old",
    turnId: "turn-old",
    role: "agent",
    text: "old body",
    commandId: null,
  }, "source-old")).state;
  state = apply(state, sourceEvent("5", "old-delete", {
    mutationType: "entry.deleted",
    entryId: "entry-never-reuse",
    reason: "retention",
  }, "source-old")).state;

  state = apply(state, sourceEvent("1", "new-start", { mutationType: "source.started" }, "source-new")).state;
  assert.equal(apply(state, sourceEvent("2", "reuse-old-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-old",
    turnId: null,
    state: "running",
    failure: null,
  }, "source-new"), "invalid_transition").state, state);
  state = apply(state, sourceEvent("2", "new-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-new",
    turnId: null,
    state: "running",
    failure: null,
  }, "source-new")).state;
  state = apply(state, sourceEvent("3", "new-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-new",
    turnId: "turn-new",
    state: "running",
    failure: null,
  }, "source-new")).state;

  const resurrect = apply(state, sourceEvent("4", "new-source-resurrect", {
    mutationType: "text_entry.appended",
    entryId: "entry-never-reuse",
    runId: "run-new",
    turnId: "turn-new",
    role: "agent",
    text: "new body",
    commandId: null,
  }, "source-new"), "entry_deleted");
  assert.equal(resurrect.state, state);
  state = apply(state, sourceEvent("4", "new-entry-corrected", {
    mutationType: "text_entry.appended",
    entryId: "entry-new",
    runId: "run-new",
    turnId: "turn-new",
    role: "agent",
    text: "new body",
    commandId: null,
  }, "source-new")).state;
  assert.equal(state.entries["entry-never-reuse"], undefined);
  assert.ok(state.deletedEntries["entry-never-reuse"]);
  assert.equal(state.entries["entry-new"].state, "visible");
});

test("the same turnId is independent across different runs", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent("1", "start", { mutationType: "source.started" })).state;
  state = apply(state, sourceEvent("2", "run-one", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-one",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("3", "run-one-shared-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-one",
    turnId: "shared-turn-id",
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("4", "run-one-turn-completed", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-one",
    turnId: "shared-turn-id",
    state: "completed",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("5", "run-one-completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-one",
    turnId: null,
    state: "completed",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("6", "run-two", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-two",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("7", "run-two-shared-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-two",
    turnId: "shared-turn-id",
    state: "running",
    failure: null,
  })).state;

  const matching = Object.values(state.turns).filter((turn) => turn.turnId === "shared-turn-id");
  assert.equal(matching.length, 2);
  assert.deepEqual(matching.map((turn) => [turn.runId, turn.state]).sort(), [
    ["run-one", "completed"],
    ["run-two", "running"],
  ]);
  assert.deepEqual(state.runs["run-one"].turnIds, ["shared-turn-id"]);
  assert.deepEqual(state.runs["run-two"].turnIds, ["shared-turn-id"]);
});

test("controlled source input is closed, bounded, canonical, and excludes inference events", () => {
  const initial = authority.createRelayAgentAuthorityState(binding);
  const validStart = sourceEvent("1", "start", { mutationType: "source.started" });
  const invalidInputs = [
    { ...validStart, unknown: true },
    { ...validStart, sourceSeq: "01" },
    { ...validStart, sourceSeq: "0" },
    { ...validStart, sourceSeq: 1 },
    { ...validStart, sourceEpoch: " source-main" },
    { ...validStart, sourceEventId: "bad\0id" },
    { ...validStart, occurredAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...validStart, mutation: { mutationType: "source.started", extra: true } },
    { ...validStart, mutation: { mutationType: "terminal.output" } },
    { ...validStart, mutation: { mutationType: "command.status" } },
    { ...validStart, mutation: { mutationType: "idle.timeout" } },
    { ...validStart, mutation: { mutationType: "source.started", sourceName: "same-agent-name" } },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => authority.reduceRelayAgentAuthority(initial, input),
      (error) => error instanceof authority.RelayAgentAuthorityInputError
        && error.code === "invalid_source_event",
    );
  }
  assert.throws(
    () => authority.createRelayAgentAuthorityState({ ...binding, sessionId: "" }),
    authority.RelayAgentAuthorityInputError,
  );

  let state = apply(initial, validStart).state;
  state = apply(state, sourceEvent("2", "run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-bounds",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("3", "turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "run-bounds",
    turnId: "turn-bounds",
    state: "running",
    failure: null,
  })).state;

  const exactText = "é".repeat(32_768);
  state = apply(state, sourceEvent("4", "exact-text", {
    mutationType: "text_entry.appended",
    entryId: "entry-exact",
    runId: "run-bounds",
    turnId: "turn-bounds",
    role: "agent",
    text: exactText,
    commandId: null,
  })).state;
  const before = state;
  for (const mutation of [
    {
      mutationType: "text_entry.appended",
      entryId: "entry-too-large",
      runId: "run-bounds",
      turnId: "turn-bounds",
      role: "agent",
      text: `${exactText}a`,
      commandId: null,
    },
    {
      mutationType: "text_entry.appended",
      entryId: "entry-unpaired",
      runId: "run-bounds",
      turnId: "turn-bounds",
      role: "agent",
      text: "\ud800",
      commandId: null,
    },
    {
      mutationType: "text_entry.appended",
      entryId: "entry-command-forged",
      runId: "run-bounds",
      turnId: "turn-bounds",
      role: "agent",
      text: "done",
      commandId: "command-does-not-authorize-state",
    },
    {
      mutationType: "lifecycle.changed",
      scope: "turn",
      runId: "run-bounds",
      turnId: "turn-bounds",
      state: "failed",
      failure: { code: "failure-code", summary: "x".repeat(1_025) },
    },
    {
      mutationType: "lifecycle.changed",
      scope: "turn",
      runId: "run-bounds",
      turnId: "turn-bounds",
      state: "completed",
      failure: { code: "forged", summary: null },
    },
  ]) {
    assert.throws(
      () => authority.reduceRelayAgentAuthority(state, sourceEvent("5", "invalid-bounded", mutation)),
      authority.RelayAgentAuthorityInputError,
    );
    assert.equal(state, before);
  }
});
