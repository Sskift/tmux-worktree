import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const trustedAdapterBinding = Object.freeze({
  hostId: binding.hostId,
  hostEpoch: binding.hostEpoch,
  scopeId: binding.scopeId,
  sessionId: binding.sessionId,
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function eventIdForTest(agentEventSeq) {
  const digest = createHash("sha256").update(canonicalJson({
    kind: "relay-agent-authority-event-v1",
    ...binding,
    agentEventSeq,
  })).digest("hex");
  return `agent-event-${digest}`;
}

function sourceEvent(sourceSeq, sourceEventId, mutation, sourceEpoch = "source-main", occurredAtMs = 1_000) {
  return { sourceEpoch, sourceSeq, sourceEventId, occurredAtMs, mutation };
}

function apply(state, input, disposition = "applied") {
  const reduction = authority.reduceRelayAgentAuthority(state, input, trustedAdapterBinding);
  assert.equal(reduction.disposition, disposition);
  return reduction;
}

function buildBudgetState(capacityOverride) {
  let state = authority.createRelayAgentAuthorityState(binding, capacityOverride);
  let sourceSeq = 1;
  const ingest = (sourceEventId, mutation) => {
    state = apply(state, sourceEvent(String(sourceSeq), sourceEventId, mutation)).state;
    sourceSeq += 1;
  };
  ingest("budget-map-start", { mutationType: "source.started" });
  for (let runNumber = 1; runNumber <= 5; runNumber += 1) {
    const runId = `budget-map-run-${runNumber}`;
    ingest(`budget-map-run-${runNumber}`, {
      mutationType: "lifecycle.changed",
      scope: "run",
      runId,
      turnId: null,
      state: "running",
      failure: null,
    });
    const turnTotal = runNumber === 5 ? 2 : 1;
    for (let turnNumber = 1; turnNumber <= turnTotal; turnNumber += 1) {
      const turnId = `budget-map-turn-${runNumber}-${turnNumber}`;
      ingest(`budget-map-turn-${runNumber}-${turnNumber}`, {
        mutationType: "lifecycle.changed",
        scope: "turn",
        runId,
        turnId,
        state: "running",
        failure: null,
      });
      if (runNumber === 1) {
        for (let entryNumber = 1; entryNumber <= 11; entryNumber += 1) {
          ingest(`budget-map-entry-${entryNumber}`, {
            mutationType: "text_entry.appended",
            entryId: `budget-map-entry-${entryNumber}`,
            runId,
            turnId,
            role: "agent",
            text: `entry ${entryNumber}`,
            commandId: null,
          });
        }
        for (let entryNumber = 1; entryNumber <= 4; entryNumber += 1) {
          ingest(`budget-map-delete-${entryNumber}`, {
            mutationType: "entry.deleted",
            entryId: `budget-map-entry-${entryNumber}`,
            reason: "retention",
          });
        }
      }
      if (runNumber >= 3) {
        ingest(`budget-map-turn-${runNumber}-${turnNumber}-completed`, {
          mutationType: "lifecycle.changed",
          scope: "turn",
          runId,
          turnId,
          state: "completed",
          failure: null,
        });
      }
    }
  }
  for (const suffix of ["two", "three"]) {
    state = apply(state, sourceEvent(
      "1",
      `budget-map-source-${suffix}-started`,
      { mutationType: "source.started" },
      `budget-map-source-${suffix}`,
    )).state;
  }
  return state;
}

function callWithMutableInputProbe(input, operation) {
  const inputBefore = structuredClone(input);
  const serializedBefore = JSON.stringify(input);
  const rootSentinel = Symbol("root-sentinel");
  const mutationSentinel = Symbol("mutation-sentinel");
  Object.defineProperty(input, rootSentinel, { value: "before", writable: true, configurable: true });
  Object.defineProperty(input.mutation, mutationSentinel, { value: "before", writable: true, configurable: true });
  try {
    return { inputBefore, value: operation() };
  } finally {
    assert.equal(JSON.stringify(input), serializedBefore, "reducer must not mutate caller source input");
    assert.equal(Object.getOwnPropertyDescriptor(input, rootSentinel).writable, true);
    assert.equal(Object.getOwnPropertyDescriptor(input.mutation, mutationSentinel).writable, true);
    input[rootSentinel] = "after";
    input.mutation[mutationSentinel] = "after";
    assert.equal(input[rootSentinel], "after");
    assert.equal(input.mutation[mutationSentinel], "after");
    assert.equal(delete input[rootSentinel], true);
    assert.equal(delete input.mutation[mutationSentinel], true);
  }
}

function stateSnapshot(state) {
  return structuredClone({
    schemaVersion: state.schemaVersion,
    binding: state.binding,
    limits: state.limits,
    agentEventSeq: state.agentEventSeq,
    activeSourceEpoch: state.activeSourceEpoch,
    activeSourceAvailability: state.activeSourceAvailability,
    sources: [...state.sources.entries()].map(([key, value]) => ({ key, value })),
    dedupe: [...state.dedupe.values()].map((value) => ({
      key: { sourceEpoch: value.sourceEpoch, sourceEventId: value.sourceEventId },
      value,
    })),
    runs: [...state.runs.entries()].map(([key, value]) => ({ key, value })),
    turns: [...state.turns.values()].map((value) => ({
      key: { runId: value.runId, turnId: value.turnId },
      value,
    })),
    activeTurns: [...state.activeTurns.entries()].map(([key, value]) => ({ key, value })),
    entries: [...state.entries.entries()].map(([key, value]) => ({ key, value })),
    deletedEntries: [...state.deletedEntries.entries()].map(([key, value]) => ({ key, value })),
  });
}

function snapshotHeader(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    binding: snapshot.binding,
    limits: snapshot.limits,
    agentEventSeq: snapshot.agentEventSeq,
    activeSourceEpoch: snapshot.activeSourceEpoch,
    activeSourceAvailability: snapshot.activeSourceAvailability,
    sources: [],
    dedupe: [],
    runs: [],
    turns: [],
    activeTurns: [],
    entries: [],
    deletedEntries: [],
  };
}

function snapshotResourceBytes(items, keyOf) {
  return items.reduce((total, item, index) => (
    total + canonicalBytes({ key: keyOf(item), value: item.value }) + (index === 0 ? 0 : 1)
  ), 0);
}

function restoreState(snapshot) {
  return authority.restoreRelayAgentAuthorityState(snapshot, binding);
}

function assertRestoreRejectsWithoutMutation(snapshot, label) {
  const before = JSON.stringify(snapshot);
  assert.throws(
    () => restoreState(snapshot),
    (error) => error instanceof authority.RelayAgentAuthorityRestoreError
      || error instanceof authority.RelayAgentAuthorityCapacityError,
    label,
  );
  assert.equal(JSON.stringify(snapshot), before, `${label} leaves caller snapshot unchanged`);
  assert.equal(Object.isFrozen(snapshot), false, `${label} leaves caller snapshot mutable`);
}

function assertCapacityRestoreRejectsWithoutMutation(snapshot, expected, label) {
  const before = JSON.stringify(snapshot);
  assert.throws(
    () => restoreState(snapshot),
    (error) => error instanceof authority.RelayAgentAuthorityCapacityError
      && error.resource === expected.resource
      && error.limit === expected.limit
      && error.attempted === expected.attempted,
    label,
  );
  assert.equal(JSON.stringify(snapshot), before, `${label} leaves caller snapshot unchanged`);
  assert.equal(Object.isFrozen(snapshot), false, `${label} leaves caller snapshot mutable`);
}

function applyFixtureArrangement(state, arrange, label) {
  if (arrange === undefined) return state;
  assert.deepEqual(Object.keys(arrange), ["expireSourceDedupeEvidence"], `${label}.arrange`);
  const snapshot = stateSnapshot(state);
  for (const key of arrange.expireSourceDedupeEvidence) {
    const source = state.sources.get(key.sourceEpoch);
    assert.ok(source, `${label} source exists before dedupe expiry`);
    const beforeLength = snapshot.dedupe.length;
    snapshot.dedupe = snapshot.dedupe.filter((item) => !(
      item.key.sourceEpoch === key.sourceEpoch && item.key.sourceEventId === key.sourceEventId
    ));
    assert.equal(snapshot.dedupe.length, beforeLength - 1, `${label} evidence exists before expiry`);
  }
  return restoreState(snapshot);
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
    activeSourceAvailability: state.activeSourceAvailability,
    sourceFenced: reduction.sourceFenced,
    runStates: [...state.runs.values()].map((run) => [run.runId, run.state]).sort(),
    runState: mutation.runId === undefined ? undefined : state.runs.get(mutation.runId)?.state,
    turnState: mutation.turnId === undefined || mutation.turnId === null
      ? undefined
      : authority.getRelayAgentAuthorityTurn(state, mutation.runId, mutation.turnId)?.state,
    entryCount: state.entries.size,
    entryState: entryId === undefined
      ? undefined
      : state.entries.get(entryId)?.state ?? (state.deletedEntries.get(entryId) ? "deleted" : undefined),
  };
}

function assertPublicProjection(reduction, before, input, knownEntryTexts, label) {
  const projected = reduction.publicEvent.mutation;
  switch (input.mutation.mutationType) {
    case "source.started":
      assert.deepEqual(projected, {
        mutationType: "source.availability",
        state: "connected",
        sourceEpoch: input.sourceEpoch,
        reason: before.activeSourceEpoch === null ? null : "source_restarted",
      }, `${label} source.started projection`);
      assert.equal(
        reduction.state.sources.get(input.sourceEpoch).activationAgentEventSeq,
        reduction.agentEventSeq,
        `${label} initializes immutable activation sequence`,
      );
      assert.equal(
        reduction.state.sources.get(input.sourceEpoch).activationEventId,
        reduction.publicEvent.eventId,
        `${label} initializes immutable activation identity`,
      );
      break;
    case "source.availability":
      assert.deepEqual(projected, {
        mutationType: "source.availability",
        state: input.mutation.state,
        sourceEpoch: input.sourceEpoch,
        reason: input.mutation.reason,
      }, `${label} source availability projection`);
      assert.equal(
        reduction.state.sources.get(input.sourceEpoch).activationAgentEventSeq,
        before.sources.get(input.sourceEpoch).activationAgentEventSeq,
        `${label} preserves immutable activation sequence`,
      );
      assert.equal(
        reduction.state.sources.get(input.sourceEpoch).activationEventId,
        before.sources.get(input.sourceEpoch).activationEventId,
        `${label} preserves immutable activation identity`,
      );
      break;
    case "lifecycle.changed":
      assert.deepEqual(projected, {
        mutationType: "lifecycle.changed",
        lifecycle: {
          recordType: "lifecycle",
          lifecycleEventId: reduction.publicEvent.eventId,
          sourceEpoch: input.sourceEpoch,
          scope: input.mutation.scope,
          runId: input.mutation.runId,
          turnId: input.mutation.turnId,
          state: input.mutation.state,
          failure: input.mutation.failure,
          occurredAtMs: input.occurredAtMs,
          agentEventSeq: reduction.agentEventSeq,
        },
      }, `${label} lifecycle projection`);
      break;
    case "text_entry.appended":
      assert.deepEqual(projected, {
        mutationType: "text_entry.appended",
        entry: {
          recordType: "text_entry",
          entryId: input.mutation.entryId,
          runId: input.mutation.runId,
          turnId: input.mutation.turnId,
          role: input.mutation.role,
          state: "visible",
          text: input.mutation.text,
          redactionReason: null,
          commandId: input.mutation.commandId,
          createdAtMs: input.occurredAtMs,
          createdAgentSeq: reduction.agentEventSeq,
          lastModifiedAgentSeq: reduction.agentEventSeq,
        },
      }, `${label} text append projection`);
      knownEntryTexts.set(input.mutation.entryId, input.mutation.text);
      break;
    case "entry.redacted":
      assert.deepEqual(projected, {
        mutationType: "entry.redacted",
        entryId: input.mutation.entryId,
        reason: input.mutation.reason,
      }, `${label} redaction projection excludes text`);
      assert.equal(Object.hasOwn(projected, "text"), false, `${label} redaction has no text field`);
      assert.ok(knownEntryTexts.has(input.mutation.entryId), `${label} tracks the removed text`);
      assert.equal(reduction.state.entries.get(input.mutation.entryId).text, null, `${label} clears materialized text`);
      break;
    case "entry.deleted":
      assert.deepEqual(projected, {
        mutationType: "entry.deleted",
        entryId: input.mutation.entryId,
        reason: input.mutation.reason,
      }, `${label} delete projection excludes text`);
      assert.equal(Object.hasOwn(projected, "text"), false, `${label} delete has no text field`);
      assert.ok(knownEntryTexts.has(input.mutation.entryId), `${label} tracks the deleted text`);
      assert.equal(reduction.state.entries.get(input.mutation.entryId), undefined, `${label} removes materialized entry`);
      assert.ok(reduction.state.deletedEntries.get(input.mutation.entryId), `${label} retains delete tombstone`);
      break;
  }
}

test("shared authority machine cases drive the production reducer and consume every expectation", () => {
  for (const fixture of authorityCases) {
    let state = authority.createRelayAgentAuthorityState(binding);
    const knownEntryTexts = new Map();
    for (const [index, step] of fixture.steps.entries()) {
      state = applyFixtureArrangement(state, step.arrange, `${fixture.name}[${index}]`);
      const before = state;
      const beforeJson = JSON.stringify(stateSnapshot(before));
      const { inputBefore, value: reduction } = callWithMutableInputProbe(
        step.input,
        () => authority.reduceRelayAgentAuthority(before, step.input, trustedAdapterBinding),
      );
      const observed = expectedObservation(reduction, inputBefore);

      for (const [key, expected] of Object.entries(step.expect)) {
        assert.ok(Object.hasOwn(observed, key), `${fixture.name}[${index}] consumes expect.${key}`);
        assert.deepEqual(observed[key], expected, `${fixture.name}[${index}].expect.${key}`);
      }
      assert.equal(JSON.stringify(stateSnapshot(before)), beforeJson, `${fixture.name}[${index}] mutated prior state`);

      if (reduction.disposition === "applied") {
        assert.notEqual(reduction.state, before, `${fixture.name}[${index}] must return a new state`);
        assert.ok(reduction.publicEvent, `${fixture.name}[${index}] public event`);
        assert.equal(reduction.publicEvent.agentEventSeq, reduction.state.agentEventSeq);
        assert.notEqual(reduction.publicEvent.eventId, inputBefore.sourceEventId);
        assertPublicProjection(
          reduction,
          before,
          inputBefore,
          knownEntryTexts,
          `${fixture.name}[${index}]`,
        );
        if (inputBefore.mutation.mutationType === "lifecycle.changed") {
          assert.equal(reduction.publicEvent.mutation.lifecycle.lifecycleEventId, reduction.publicEvent.eventId);
          assert.notEqual(reduction.publicEvent.mutation.lifecycle.lifecycleEventId, inputBefore.sourceEventId);
        }
      } else if (reduction.disposition === "redundant_terminal") {
        assert.notEqual(reduction.state, before, `${fixture.name}[${index}] must consume source cursor`);
        assert.equal(reduction.publicEvent, null);
      } else if (reduction.disposition === "source_event_conflict") {
        assert.equal(reduction.publicEvent, null);
        assert.equal(reduction.state.sources.get(inputBefore.sourceEpoch).fenced, true);
      } else if (noCommitDispositions.has(reduction.disposition)) {
        assert.equal(reduction.state, before, `${fixture.name}[${index}] must not half-commit`);
        assert.equal(reduction.publicEvent, null);
      }
      state = reduction.state;
    }
  }
});

test("a new source at seq 1 without source.started is invalid, while seq above 1 is a gap", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent(
    "1",
    "old-source-start",
    { mutationType: "source.started" },
    "source-old",
  )).state;
  const before = state;
  const nonStart = {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-new",
    turnId: null,
    state: "running",
    failure: null,
  };

  const invalid = apply(state, sourceEvent(
    "1",
    "new-source-not-started",
    nonStart,
    "source-new",
  ), "invalid_transition");
  assert.equal(invalid.state, before);
  assert.equal(invalid.expectedSourceSeq, null);

  const gap = apply(state, sourceEvent(
    "2",
    "new-source-skips-start",
    nonStart,
    "source-new",
  ), "source_gap");
  assert.equal(gap.state, before);
  assert.equal(gap.expectedSourceSeq, "1");

  state = apply(state, sourceEvent(
    "1",
    "new-source-corrected-start",
    { mutationType: "source.started" },
    "source-new",
  )).state;
  assert.equal(state.activeSourceEpoch, "source-new");
});

test("plain snapshots require the explicit closed restore boundary", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent("1", "restore-start", { mutationType: "source.started" })).state;
  state = apply(state, sourceEvent("2", "restore-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "restore-run",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("3", "restore-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "restore-run",
    turnId: "restore-turn",
    state: "running",
    failure: null,
  })).state;
  state = apply(state, sourceEvent("4", "restore-entry", {
    mutationType: "text_entry.appended",
    entryId: "restore-entry",
    runId: "restore-run",
    turnId: "restore-turn",
    role: "agent",
    text: "restored text",
    commandId: null,
  })).state;

  const plain = JSON.parse(JSON.stringify(stateSnapshot(state)));
  const beforePlain = JSON.stringify(plain);
  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      plain,
      sourceEvent("5", "plain-must-not-reduce", {
        mutationType: "source.availability",
        state: "interrupted",
        reason: "source_disconnected",
      }),
      trustedAdapterBinding,
    ),
    authority.RelayAgentAuthorityStateError,
  );

  const restored = restoreState(plain);
  assert.equal(JSON.stringify(plain), beforePlain, "restore does not mutate or freeze caller input");
  assert.equal(Object.isFrozen(plain), false);
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(restored.entries.get("restore-entry").text, "restored text");
  assert.equal(authority.getRelayAgentAuthorityTurn(restored, "restore-run", "restore-turn").state, "running");
  const interrupted = apply(restored, sourceEvent("5", "restored-interrupted", {
    mutationType: "source.availability",
    state: "interrupted",
    reason: "source_disconnected",
  }));
  assert.equal(interrupted.state.activeSourceAvailability, "interrupted");
  assert.equal(JSON.stringify(plain), beforePlain);

  const corruptions = [
    ["closed schema", (snapshot) => { snapshot.unknown = true; }],
    ["schema downgrade", (snapshot) => { snapshot.schemaVersion = 0; }],
    ["source/dedupe cursor binding", (snapshot) => {
      snapshot.dedupe[0].value.sourceSeq = "5";
    }],
    ["run/turn/active index mirror", (snapshot) => { snapshot.activeTurns = []; }],
    ["entry/tombstone identity", (snapshot) => {
      snapshot.deletedEntries.push({
        key: "restore-entry",
        value: {
          entryId: "restore-entry",
          sourceEpoch: "source-main",
          reason: "retention",
          deletedAgentSeq: "4",
        },
      });
    }],
    ["public sequence reuse", (snapshot) => {
      snapshot.entries[0].value.createdAgentSeq = "2";
      snapshot.entries[0].value.lastModifiedAgentSeq = "2";
    }],
    ["final public watermark", (snapshot) => { snapshot.agentEventSeq = "5"; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const corrupted = structuredClone(plain);
    corrupt(corrupted);
    assertRestoreRejectsWithoutMutation(corrupted, label);
  }

  const missingActive = structuredClone(plain);
  missingActive.activeSourceEpoch = null;
  missingActive.activeSourceAvailability = null;
  assertRestoreRejectsWithoutMutation(missingActive, "nonempty sources require an active source");

  const dualSourceState = apply(state, sourceEvent(
    "1",
    "restore-new-source",
    { mutationType: "source.started" },
    "restore-source-new",
  )).state;
  const rolledBackActive = stateSnapshot(dualSourceState);
  const forgedAvailabilitySequence = (BigInt(rolledBackActive.agentEventSeq) + 1n).toString();
  const oldSource = rolledBackActive.sources.find((item) => item.key === "source-main").value;
  oldSource.availability = "connected";
  oldSource.availabilityAgentEventSeq = forgedAvailabilitySequence;
  oldSource.availabilityEventId = eventIdForTest(forgedAvailabilitySequence);
  oldSource.availabilityOccurredAtMs += 1;
  rolledBackActive.agentEventSeq = forgedAvailabilitySequence;
  rolledBackActive.activeSourceEpoch = "source-main";
  rolledBackActive.activeSourceAvailability = "connected";
  assertRestoreRejectsWithoutMutation(
    rolledBackActive,
    "mutable availability cannot revive a source with an older immutable activation",
  );
  assert.throws(
    () => authority.restoreRelayAgentAuthorityState(
      plain,
      { ...binding, timelineEpoch: "wrong-timeline" },
    ),
    authority.RelayAgentAuthorityRestoreError,
  );
});

test("index-safe opaque identities survive create, transition, and restore", () => {
  let state = authority.createRelayAgentAuthorityState(binding);
  state = apply(state, sourceEvent(
    "1",
    "constructor",
    { mutationType: "source.started" },
    "__proto__",
  )).state;
  state = apply(state, sourceEvent("2", "run-special", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "constructor",
    turnId: null,
    state: "running",
    failure: null,
  }, "__proto__")).state;
  state = apply(state, sourceEvent("3", "turn-special", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "constructor",
    turnId: "__proto__",
    state: "running",
    failure: null,
  }, "__proto__")).state;
  state = apply(state, sourceEvent("4", "entry-special", {
    mutationType: "text_entry.appended",
    entryId: "__proto__",
    runId: "constructor",
    turnId: "__proto__",
    role: "agent",
    text: "safe",
    commandId: null,
  }, "__proto__")).state;
  const restored = restoreState(stateSnapshot(state));
  assert.equal(restored.sources.get("__proto__").sourceEpoch, "__proto__");
  assert.equal(restored.runs.get("constructor").runId, "constructor");
  assert.equal(authority.getRelayAgentAuthorityTurn(restored, "constructor", "__proto__").turnId, "__proto__");
  assert.equal(restored.entries.get("__proto__").text, "safe");
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
  assert.equal(conflict.state.sources.get("source-main").lastSourceSeq, "1");
  assert.equal(conflict.publicEvent, null);

  const acceptedReplay = apply(conflict.state, started, "duplicate");
  assert.equal(acceptedReplay.state, conflict.state);
  assert.equal(acceptedReplay.agentEventSeq, "1");
  assert.equal(acceptedReplay.publicEvent, null);
  assert.equal(acceptedReplay.sourceFenced, true, "exact replay preserves the fenced signal");

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

  const snapshot = stateSnapshot(state);
  snapshot.dedupe = snapshot.dedupe.filter((item) => item.key.sourceEventId !== "start-key");
  const trimmedState = restoreState(snapshot);
  const expired = apply(trimmedState, started, "source_history_expired");
  assert.equal(expired.state, trimmedState);
  assert.equal(expired.agentEventSeq, "2");
});

test("dedupe evidence hard capacity fails closed after retained duplicates are checked", () => {
  let state = authority.createRelayAgentAuthorityState(binding, {
    maxDedupeEvidenceCount: 3,
  });
  const started = sourceEvent("1", "capacity-start", { mutationType: "source.started" });
  const running = sourceEvent("2", "capacity-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-capacity",
    turnId: null,
    state: "running",
    failure: null,
  });
  const completed = sourceEvent("3", "capacity-completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-capacity",
    turnId: null,
    state: "completed",
    failure: null,
  });
  state = apply(state, started).state;
  state = apply(state, running).state;
  state = apply(state, completed).state;
  assert.equal(state.usage.dedupeEvidenceCount, 3);
  assert.equal(state.dedupe.size, 3);

  const duplicate = apply(state, structuredClone(started), "duplicate");
  assert.equal(duplicate.state, state, "retained exact evidence wins at capacity");
  assert.equal(duplicate.publicEvent, null);

  const beforeJson = JSON.stringify(stateSnapshot(state));
  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      state,
      sourceEvent("4", "capacity-redundant", {
        mutationType: "lifecycle.changed",
        scope: "run",
        runId: "run-capacity",
        turnId: null,
        state: "completed",
        failure: null,
      }),
      trustedAdapterBinding,
    ),
    (error) => error instanceof authority.RelayAgentAuthorityCapacityError
      && error.code === "authority_capacity_exceeded"
      && error.resource === "dedupe"
      && error.limit === 3,
  );
  assert.equal(JSON.stringify(stateSnapshot(state)), beforeJson);
  assert.equal(state.sources.get("source-main").lastSourceSeq, "3");
  assert.equal(state.agentEventSeq, "3");

  assert.throws(
    () => authority.createRelayAgentAuthorityState(binding, {
      maxDedupeEvidenceCount:
        authority.RELAY_AGENT_AUTHORITY_HARD_LIMITS.maxDedupeEvidenceCount + 1,
    }),
    authority.RelayAgentAuthorityStateError,
  );
});

test("text bytes and domain records have independent fail-closed budgets", () => {
  let textState = authority.createRelayAgentAuthorityState(binding, {
    maxEntryCanonicalBytes: 500,
  });
  textState = apply(textState, sourceEvent("1", "text-budget-start", { mutationType: "source.started" })).state;
  textState = apply(textState, sourceEvent("2", "text-budget-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "text-budget-run",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  textState = apply(textState, sourceEvent("3", "text-budget-turn", {
    mutationType: "lifecycle.changed",
    scope: "turn",
    runId: "text-budget-run",
    turnId: "text-budget-turn",
    state: "running",
    failure: null,
  })).state;
  const textBefore = JSON.stringify(stateSnapshot(textState));
  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      textState,
      sourceEvent("4", "text-budget-entry", {
        mutationType: "text_entry.appended",
        entryId: "text-budget-entry",
        runId: "text-budget-run",
        turnId: "text-budget-turn",
        role: "agent",
        text: "x".repeat(8_000),
        commandId: null,
      }),
      trustedAdapterBinding,
    ),
    (error) => error instanceof authority.RelayAgentAuthorityCapacityError
      && error.resource === "entries_canonical_bytes",
  );
  assert.equal(JSON.stringify(stateSnapshot(textState)), textBefore);
  assert.equal(textState.entries.size, 0);

  let runState = authority.createRelayAgentAuthorityState(binding, { maxRunCount: 1 });
  runState = apply(runState, sourceEvent("1", "run-budget-start", { mutationType: "source.started" })).state;
  runState = apply(runState, sourceEvent("2", "run-budget-first", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-budget-first",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  const runBefore = JSON.stringify(stateSnapshot(runState));
  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      runState,
      sourceEvent("3", "run-budget-second", {
        mutationType: "lifecycle.changed",
        scope: "run",
        runId: "run-budget-second",
        turnId: null,
        state: "running",
        failure: null,
      }),
      trustedAdapterBinding,
    ),
    (error) => error instanceof authority.RelayAgentAuthorityCapacityError
      && error.resource === "runs",
  );
  assert.equal(JSON.stringify(stateSnapshot(runState)), runBefore);
  assert.equal(runState.runs.size, 1);
});

test("all resource count and canonical-byte budgets map to snapshot indexes", () => {
  const state = buildBudgetState();
  const snapshot = stateSnapshot(state);
  const rows = [
    ["sources", "sources", "sourceCount", "sourceCanonicalBytes", "maxSourceCount", "maxSourceCanonicalBytes", (item) => item.key],
    ["dedupe", "dedupe", "dedupeEvidenceCount", "dedupeCanonicalBytes", "maxDedupeEvidenceCount", "maxDedupeCanonicalBytes", (item) => canonicalJson([item.key.sourceEpoch, item.key.sourceEventId])],
    ["runs", "runs", "runCount", "runCanonicalBytes", "maxRunCount", "maxRunCanonicalBytes", (item) => item.key],
    ["turns", "turns", "turnCount", "turnCanonicalBytes", "maxTurnCount", "maxTurnCanonicalBytes", (item) => canonicalJson([item.key.runId, item.key.turnId])],
    ["entries", "entries", "entryCount", "entryCanonicalBytes", "maxEntryCount", "maxEntryCanonicalBytes", (item) => item.key],
    ["tombstones", "deletedEntries", "tombstoneCount", "tombstoneCanonicalBytes", "maxTombstoneCount", "maxTombstoneCanonicalBytes", (item) => item.key],
    ["activeTurns", "activeTurns", "activeTurnIndexCount", "activeTurnIndexCanonicalBytes", "maxActiveTurnIndexCount", "maxActiveTurnIndexCanonicalBytes", (item) => item.key],
  ];
  assert.equal(
    new Set(rows.map(([, snapshotField]) => snapshot[snapshotField].length)).size,
    rows.length,
    "every resource count is distinguishable",
  );

  let independentResourceTotal = 0;
  for (const [resource, snapshotField, countField, byteField, countLimit, byteLimit, keyOf] of rows) {
    const items = snapshot[snapshotField];
    const independentBytes = snapshotResourceBytes(items, keyOf);
    assert.equal(state.usage[countField], items.length, `${resource} count mapping`);
    assert.equal(state.usage[byteField], independentBytes, `${resource} byte mapping`);
    independentResourceTotal += independentBytes;

    const exact = structuredClone(snapshot);
    exact.limits[countLimit] = items.length;
    exact.limits[byteLimit] = independentBytes;
    const exactState = restoreState(exact);
    assert.equal(exactState.usage[countField], exactState.limits[countLimit], `${resource} exact count limit`);
    assert.equal(exactState.usage[byteField], exactState.limits[byteLimit], `${resource} exact byte limit`);

    const oneOverCount = structuredClone(exact);
    oneOverCount.limits[countLimit] -= 1;
    assertCapacityRestoreRejectsWithoutMutation(oneOverCount, {
      resource,
      limit: items.length - 1,
      attempted: items.length,
    }, `${resource} count +1 is unavailable`);
    const oneOverBytes = structuredClone(exact);
    oneOverBytes.limits[byteLimit] -= 1;
    assertCapacityRestoreRejectsWithoutMutation(oneOverBytes, {
      resource: `${resource}_canonical_bytes`,
      limit: independentBytes - 1,
      attempted: independentBytes,
    }, `${resource} canonical bytes +1 is unavailable`);
  }
  assert.equal(
    state.usage.totalCanonicalBytes,
    independentResourceTotal + canonicalBytes(snapshotHeader(snapshot)),
    "total canonical bytes include every resource and the closed state header",
  );

  const exactTotalSnapshot = structuredClone(snapshot);
  let exactTotal = state.usage.totalCanonicalBytes;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    exactTotalSnapshot.limits.maxCanonicalBytes = exactTotal;
    exactTotal = independentResourceTotal + canonicalBytes(snapshotHeader(exactTotalSnapshot));
  }
  assert.equal(exactTotalSnapshot.limits.maxCanonicalBytes, exactTotal, "total limit accounting converges");
  const exactTotalState = buildBudgetState({ maxCanonicalBytes: exactTotal });
  assert.equal(exactTotalState.usage.totalCanonicalBytes, exactTotal, "final transition commits exactly at total budget");
  const exactTotalBefore = JSON.stringify(stateSnapshot(exactTotalState));
  const oneOverInput = sourceEvent("2", "budget-map-total-overflow", {
    mutationType: "source.availability",
    state: "interrupted",
    reason: "source_disconnected",
  }, "budget-map-source-three");
  assert.throws(
    () => callWithMutableInputProbe(
      oneOverInput,
      () => authority.reduceRelayAgentAuthority(exactTotalState, oneOverInput, trustedAdapterBinding),
    ),
    (error) => error instanceof authority.RelayAgentAuthorityCapacityError
      && error.resource === "total_canonical_bytes",
  );
  assert.equal(JSON.stringify(stateSnapshot(exactTotalState)), exactTotalBefore);
});

test("dedupe expiry cannot free saturated domain capacity", () => {
  let state = authority.createRelayAgentAuthorityState(binding, { maxRunCount: 1 });
  state = apply(state, sourceEvent("1", "domain-cap-start", { mutationType: "source.started" })).state;
  state = apply(state, sourceEvent("2", "domain-cap-run", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "domain-cap-run",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  const snapshot = stateSnapshot(state);
  snapshot.dedupe = snapshot.dedupe.filter((item) => item.key.sourceEventId !== "domain-cap-start");
  state = restoreState(snapshot);
  assert.equal(state.usage.dedupeEvidenceCount, 1);
  assert.equal(state.usage.runCount, 1);
  const before = JSON.stringify(stateSnapshot(state));
  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      state,
      sourceEvent("3", "domain-cap-second-run", {
        mutationType: "lifecycle.changed",
        scope: "run",
        runId: "domain-cap-second-run",
        turnId: null,
        state: "running",
        failure: null,
      }),
      trustedAdapterBinding,
    ),
    (error) => error instanceof authority.RelayAgentAuthorityCapacityError
      && error.resource === "runs",
  );
  assert.equal(JSON.stringify(stateSnapshot(state)), before);
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
  assert.equal(state.sources.get("source-main").lastSourceSeq, "1");

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
  assert.equal(state.sources.get("source-main").lastSourceSeq, "4");
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
  assert.equal(state.sources.get("source-main").lastSourceSeq, "5");
  assert.equal(state.agentEventSeq, "4");
});

test("UINT64 public sequence exhaustion preserves non-public dispositions", () => {
  let terminal = authority.createRelayAgentAuthorityState(binding);
  terminal = apply(terminal, sourceEvent("1", "max-start", { mutationType: "source.started" })).state;
  terminal = apply(terminal, sourceEvent("2", "max-running", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "max-run",
    turnId: null,
    state: "running",
    failure: null,
  })).state;
  terminal = apply(terminal, sourceEvent("3", "max-completed", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "max-run",
    turnId: null,
    state: "completed",
    failure: null,
  })).state;
  const snapshot = stateSnapshot(terminal);
  const maxSequence = "18446744073709551615";
  snapshot.agentEventSeq = maxSequence;
  snapshot.runs[0].value.lifecycle.agentEventSeq = maxSequence;
  snapshot.runs[0].value.lifecycle.lifecycleEventId = eventIdForTest(maxSequence);
  const maxState = restoreState(snapshot);
  const before = JSON.stringify(stateSnapshot(maxState));

  const cases = [
    ["redundant_terminal", {
      mutationType: "lifecycle.changed",
      scope: "run",
      runId: "max-run",
      turnId: null,
      state: "completed",
      failure: null,
    }],
    ["invalid_transition", {
      mutationType: "lifecycle.changed",
      scope: "run",
      runId: "max-run",
      turnId: null,
      state: "waiting_for_user",
      failure: null,
    }],
    ["terminal_conflict", {
      mutationType: "lifecycle.changed",
      scope: "run",
      runId: "max-run",
      turnId: null,
      state: "failed",
      failure: { code: "different-terminal", summary: null },
    }],
  ];
  for (const [disposition, mutation] of cases) {
    const input = sourceEvent("4", `max-${disposition}`, mutation);
    const { value: reduction } = callWithMutableInputProbe(
      input,
      () => authority.reduceRelayAgentAuthority(maxState, input, trustedAdapterBinding),
    );
    assert.equal(reduction.disposition, disposition);
    assert.equal(reduction.agentEventSeq, maxSequence);
    assert.equal(reduction.publicEvent, null);
    if (disposition === "redundant_terminal") {
      assert.notEqual(reduction.state, maxState);
      assert.equal(reduction.state.sources.get("source-main").lastSourceSeq, "4");
    } else {
      assert.equal(reduction.state, maxState);
    }
  }

  const appliedInput = sourceEvent("4", "max-applied", {
    mutationType: "lifecycle.changed",
    scope: "run",
    runId: "run-needs-public-sequence",
    turnId: null,
    state: "running",
    failure: null,
  });
  assert.throws(
    () => callWithMutableInputProbe(
      appliedInput,
      () => authority.reduceRelayAgentAuthority(maxState, appliedInput, trustedAdapterBinding),
    ),
    (error) => error instanceof authority.RelayAgentAuthorityStateError
      && error.message.includes("agentEventSeq is exhausted"),
  );
  assert.equal(JSON.stringify(stateSnapshot(maxState)), before);
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
  assert.equal(state.entries.get("entry-never-reuse"), undefined);
  assert.ok(state.deletedEntries.get("entry-never-reuse"));
  assert.equal(state.entries.get("entry-new").state, "visible");
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

  const matching = [...state.turns.values()].filter((turn) => turn.turnId === "shared-turn-id");
  assert.equal(matching.length, 2);
  assert.deepEqual(matching.map((turn) => [turn.runId, turn.state]).sort(), [
    ["run-one", "completed"],
    ["run-two", "running"],
  ]);
  assert.equal(state.runs.get("run-one").turnCount, 1);
  assert.equal(state.runs.get("run-two").turnCount, 1);
});

test("trusted adapter binding is checked before source parsing and cannot be self-reported", () => {
  const state = authority.createRelayAgentAuthorityState(binding);
  const beforeJson = JSON.stringify(stateSnapshot(state));
  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      state,
      { malformed: "source payload must not be parsed first" },
      { ...trustedAdapterBinding, sessionId: "wrong-session" },
    ),
    (error) => error instanceof authority.RelayAgentAuthorityBindingError
      && error.code === "adapter_binding_mismatch",
  );
  assert.equal(state.agentEventSeq, "0");
  assert.equal(state.activeSourceEpoch, null);
  assert.equal(JSON.stringify(stateSnapshot(state)), beforeJson);

  assert.throws(
    () => authority.reduceRelayAgentAuthority(
      state,
      { ...sourceEvent("1", "self-reported", { mutationType: "source.started" }), sessionId: binding.sessionId },
      trustedAdapterBinding,
    ),
    authority.RelayAgentAuthorityInputError,
  );

  const applied = apply(state, sourceEvent("1", "trusted-start", { mutationType: "source.started" }));
  assert.deepEqual(
    {
      hostId: applied.publicEvent.hostId,
      hostEpoch: applied.publicEvent.hostEpoch,
      scopeId: applied.publicEvent.scopeId,
      sessionId: applied.publicEvent.sessionId,
    },
    trustedAdapterBinding,
  );
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
    { ...validStart, mutation: { mutationType: "source.availability", state: "interrupted", reason: "source_restarted" } },
    { ...validStart, mutation: { mutationType: "source.availability", state: "absent", reason: "source_disconnected" } },
    { ...validStart, mutation: { mutationType: "terminal.output" } },
    { ...validStart, mutation: { mutationType: "command.status" } },
    { ...validStart, mutation: { mutationType: "idle.timeout" } },
    { ...validStart, mutation: { mutationType: "source.started", sourceName: "same-agent-name" } },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => authority.reduceRelayAgentAuthority(initial, input, trustedAdapterBinding),
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
      () => authority.reduceRelayAgentAuthority(
        state,
        sourceEvent("5", "invalid-bounded", mutation),
        trustedAdapterBinding,
      ),
      authority.RelayAgentAuthorityInputError,
    );
    assert.equal(state, before);
  }
});
