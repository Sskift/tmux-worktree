import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const activationModule = await import("../dist/relay/v2/hostRuntimeComposition.js");
const hostState = await import("../dist/relay/v2/hostState.js");

const corpus = loadRelayV2FixtureCorpus();
const HOST_ID = "mac-admin";
const BASE_TIME = 1_783_700_200_000;

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function auth() {
  return {
    principalId: "h1-readiness-principal",
    clientInstanceId: "h1-readiness-client",
    hostId: HOST_ID,
  };
}

function commandFrame(hostEpoch, windowId, suffix) {
  const frame = fixture("command-execute-send-agent-message");
  frame.requestId = `h1-readiness-request-${suffix}`;
  frame.commandId = `h1-readiness-command-${suffix}`;
  frame.expectedHostEpoch = hostEpoch;
  frame.payload.dedupeWindowId = windowId;
  return frame;
}

function queryFrame(hostEpoch, windowId, commandId, suffix) {
  const frame = fixture("command-query");
  frame.requestId = `h1-readiness-query-${suffix}`;
  frame.expectedHostEpoch = hostEpoch;
  frame.payload.items = [{ commandId, dedupeWindowId: windowId }];
  return frame;
}

function resolutionFence(request) {
  return {
    schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
    outcome: "positive",
    authority: request.authority,
    operation: request.operation,
    expectedScopeId: request.scopeId,
    expectedSessionId: request.sessionId,
    target: { testTarget: request.scopeId },
    evidence: {
      resolverToken: "h1-readiness-cut",
      expectedScopeId: request.scopeId,
      expectedSessionId: request.sessionId,
      result: "positive",
    },
  };
}

function executableAdmission(request) {
  return {
    kind: "executable",
    adapterState: { resolvedTarget: request.scopeId },
    resolutionFence: resolutionFence(request),
  };
}

function terminalSuccess(plan) {
  return {
    state: "succeeded",
    result: {
      pane: plan.arguments.pane,
      submit: plan.arguments.submit,
      messageUtf8Bytes: Buffer.byteLength(plan.arguments.message, "utf8"),
    },
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function commandKey(record) {
  const identity = {
    hostEpoch: record.hostEpoch,
    principalId: record.principalId,
    hostId: record.hostId,
    commandId: record.commandId,
  };
  return `cmd:v1:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`;
}

function windowKey(windowId) {
  return `cmdwin:v1:${createHash("sha256")
    .update(canonicalJson({ windowId }), "utf8")
    .digest("hex")}`;
}

function executorHarness(overrides = {}) {
  const calls = { resolve: [], fence: [], twRpc: [], terminal: [] };
  const executor = {
    async resolve(request) {
      calls.resolve.push(structuredClone(request));
      return overrides.resolve
        ? overrides.resolve(request)
        : executableAdmission(request);
    },
    fenceResolution(transaction, request, fence) {
      calls.fence.push({
        hostEpoch: transaction.hostEpoch,
        request: structuredClone(request),
        fence: structuredClone(fence),
      });
      if (overrides.fenceResolution) {
        return overrides.fenceResolution(transaction, request, fence);
      }
    },
    async executeTwRpc(plan) {
      calls.twRpc.push(structuredClone(plan));
      if (overrides.executeTwRpc) return overrides.executeTwRpc(plan);
      return {
        state: "failed",
        sideEffect: "not_applied",
        error: {
          code: "COMMAND_FAILED",
          message: "Unexpected H1 readiness TW RPC call",
          retryable: false,
          commandDisposition: "completed",
          details: null,
        },
      };
    },
    async executeTerminalControl(plan) {
      calls.terminal.push(structuredClone(plan));
      return overrides.executeTerminalControl
        ? overrides.executeTerminalControl(plan)
        : terminalSuccess(plan);
    },
  };
  return { executor, calls };
}

function capturedExecutorHarness(overrides = {}) {
  const delegate = executorHarness(overrides);
  const reads = {
    resolve: 0,
    fenceResolution: 0,
    executeTwRpc: 0,
    executeTerminalControl: 0,
  };
  const executor = {};
  for (const name of Object.keys(reads)) {
    Object.defineProperty(executor, name, {
      configurable: true,
      enumerable: true,
      get() {
        reads[name] += 1;
        return delegate.executor[name];
      },
    });
  }
  return { executor, reads, calls: delegate.calls };
}

function readinessHarness(apply = () => true) {
  const state = { applied: [], closes: 0 };
  const sink = Object.freeze({
    apply(snapshot) {
      state.applied.push(structuredClone(snapshot));
      return apply(snapshot);
    },
    close() {
      state.closes += 1;
    },
  });
  return { sink, state };
}

async function context() {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-h1-readiness-"));
  const store = await hostState.RelayV2HostStateStore.open({ home });
  const snapshot = await store.read();
  return {
    home,
    store,
    hostEpoch: snapshot.hostEpoch,
    hostInstanceId: snapshot.hostInstanceId,
    now: () => BASE_TIME,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function activationOptions(ctx, candidate, readinessSink, identity = {}) {
  return {
    hostId: identity.hostId ?? HOST_ID,
    hostEpoch: identity.hostEpoch ?? ctx.hostEpoch,
    hostInstanceId: identity.hostInstanceId ?? ctx.hostInstanceId,
    candidate,
    readinessSink,
  };
}

function activate(ctx, candidate, readinessSink, identity) {
  return activationModule.createRelayV2HostH1ReadinessActivation(
    activationOptions(ctx, candidate, readinessSink, identity),
  );
}

async function openCandidate(ctx, executor, recover = true) {
  return commandPlane.RelayV2HostCommandPlane.openRecoveredAuthority({
    store: ctx.store,
    hostId: HOST_ID,
    executor,
    now: ctx.now,
    recover,
  });
}

async function seedCompletedCommand(ctx, executor, suffix = "seed") {
  const plane = await commandPlane.RelayV2HostCommandPlane.open({
    store: ctx.store,
    hostId: HOST_ID,
    executor,
    now: ctx.now,
    recover: false,
  });
  const snapshot = await ctx.store.read();
  const window = await plane.issueDedupeWindow();
  const frame = commandFrame(snapshot.hostEpoch, window.windowId, suffix);
  const response = await plane.execute(auth(), frame);
  assert.equal(response.payload.state, "succeeded");
  return { plane, snapshot, window, frame };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("recovered H1 authority audits one final cut and exposes only three captured call seams", async () => {
  const ctx = await context();
  try {
    const seedExecutor = executorHarness();
    const seeded = await seedCompletedCommand(ctx, seedExecutor.executor);
    const captured = capturedExecutorHarness();
    const candidate = await openCandidate(ctx, captured.executor);
    assert.notEqual(candidate, null);
    assert.deepEqual(captured.reads, {
      resolve: 1,
      fenceResolution: 1,
      executeTwRpc: 1,
      executeTerminalControl: 1,
    });

    const readiness = readinessHarness();
    const activation = activate(ctx, candidate, readiness.sink);
    assert.notEqual(activation, null);
    assert.equal(Object.isFrozen(activation), true);
    assert.equal(activation.plane, undefined);
    assert.equal(activation.candidate, undefined);
    assert.deepEqual(readiness.state.applied, [{
      source: "h1",
      generation: readiness.state.applied[0].generation,
      ready: true,
    }]);
    assert.match(readiness.state.applied[0].generation, /^[1-9][0-9]*$/);

    for (const name of Object.keys(captured.reads)) {
      Object.defineProperty(captured.executor, name, {
        configurable: true,
        enumerable: true,
        value() { throw new Error("uncaptured executor seam was used"); },
      });
    }

    const issued = await activation.issueDedupeWindow();
    assert.equal(typeof issued.windowId, "string");

    const query = await activation.query(auth(), queryFrame(
      seeded.snapshot.hostEpoch,
      seeded.window.windowId,
      seeded.frame.commandId,
      "captured",
    ));
    assert.equal(query.payload.items[0].state, "succeeded");

    const execute = await activation.execute(
      auth(),
      commandFrame(seeded.snapshot.hostEpoch, issued.windowId, "captured"),
    );
    assert.equal(execute.payload.state, "succeeded");
    assert.deepEqual(captured.reads, {
      resolve: 1,
      fenceResolution: 1,
      executeTwRpc: 1,
      executeTerminalControl: 1,
    });

    const firstClose = activation.close();
    const secondClose = activation.close();
    assert.equal(firstClose, secondClose);
    assert.equal(readiness.state.closes, 1);
    await firstClose;
  } finally {
    ctx.cleanup();
  }
});

test("recovered opening with recover false never issues authority", async () => {
  const ctx = await context();
  try {
    const fake = capturedExecutorHarness();
    assert.equal(await openCandidate(ctx, fake.executor, false), null);
    assert.deepEqual(fake.reads, {
      resolve: 1,
      fenceResolution: 1,
      executeTwRpc: 1,
      executeTerminalControl: 1,
    });
  } finally {
    ctx.cleanup();
  }
});

test("recovery-time prototype mutation cannot replace the captured H1 authority", async () => {
  const ctx = await context();
  const executeDescriptor = Object.getOwnPropertyDescriptor(
    commandPlane.RelayV2HostCommandPlane.prototype,
    "execute",
  );
  assert.notEqual(executeDescriptor, undefined);
  let poisonedCalls = 0;
  let mutated = false;
  try {
    const fake = executorHarness();
    const candidate = await commandPlane.RelayV2HostCommandPlane.openRecoveredAuthority({
      store: ctx.store,
      hostId: HOST_ID,
      executor: fake.executor,
      now() {
        if (!mutated) {
          mutated = true;
          Object.defineProperty(commandPlane.RelayV2HostCommandPlane.prototype, "execute", {
            ...executeDescriptor,
            value: async () => {
              poisonedCalls += 1;
              throw new Error("mutated public prototype was invoked");
            },
          });
        }
        return BASE_TIME;
      },
    });
    const readiness = readinessHarness();
    const activation = activate(ctx, candidate, readiness.sink);
    assert.notEqual(activation, null);
    const snapshot = await ctx.store.read();
    const window = await activation.issueDedupeWindow();
    const result = await activation.execute(
      auth(),
      commandFrame(snapshot.hostEpoch, window.windowId, "prototype-fence"),
    );
    assert.equal(result.payload.state, "succeeded");
    assert.equal(poisonedCalls, 0);
    await activation.close();
  } finally {
    Object.defineProperty(
      commandPlane.RelayV2HostCommandPlane.prototype,
      "execute",
      executeDescriptor,
    );
    ctx.cleanup();
  }
});

test("recovered opening rejects malformed H1 records and canonical-key mismatches", async (t) => {
  const cases = [
    {
      name: "command current epoch",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.commands)[0];
        const stale = { ...value, hostEpoch: "stale-host-epoch" };
        transaction.deleteCommandRecord(key);
        transaction.putCommandRecord(commandKey(stale), stale);
      },
    },
    {
      name: "command key identity",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.commands)[0];
        transaction.deleteCommandRecord(key);
        transaction.putCommandRecord("legacy-command-key", value);
      },
    },
    {
      name: "dedupe window current epoch",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.materialized).find(
          ([, record]) => record.recordType === "dedupe_window",
        );
        transaction.putMaterializedRecord(key, {
          ...value,
          hostEpoch: "stale-host-epoch",
        });
      },
    },
    {
      name: "dedupe window key identity",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.materialized).find(
          ([, record]) => record.recordType === "dedupe_window",
        );
        transaction.putMaterializedRecord(key, {
          ...value,
          windowId: `${value.windowId}-mismatch`,
        });
      },
    },
    {
      name: "dedupe window sequence exceeds uint64",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.materialized).find(
          ([, record]) => record.recordType === "dedupe_window",
        );
        transaction.putMaterializedRecord(key, {
          ...value,
          windowSeq: "18446744073709551616",
        });
      },
    },
    {
      name: "dedupe window sequence is duplicated",
      mutate(transaction, snapshot) {
        const value = Object.values(snapshot.materialized).find(
          (record) => record.recordType === "dedupe_window",
        );
        const duplicate = { ...value, windowId: `${value.windowId}-duplicate` };
        transaction.putMaterializedRecord(windowKey(duplicate.windowId), duplicate);
      },
    },
    {
      name: "dedupe window sequence exceeds its revision cut",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.materialized).find(
          ([, record]) => record.recordType === "dedupe_window",
        );
        transaction.putMaterializedRecord(key, { ...value, windowSeq: "2" });
      },
    },
    {
      name: "dedupe window retention is too short",
      mutate(transaction, snapshot) {
        const [key, value] = Object.entries(snapshot.materialized).find(
          ([, record]) => record.recordType === "dedupe_window",
        );
        transaction.putMaterializedRecord(key, {
          ...value,
          queryUntilMs: value.acceptUntilMs
            + commandPlane.RELAY_V2_COMMAND_DEDUPE_RETENTION_MS - 1,
        });
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const ctx = await context();
      try {
        const fake = executorHarness();
        await seedCompletedCommand(ctx, fake.executor, entry.name.replaceAll(" ", "-"));
        const before = await ctx.store.read();
        await ctx.store.transaction((transaction) => entry.mutate(transaction, before));
        await assert.rejects(
          openCandidate(ctx, fake.executor),
          commandPlane.RelayV2HostCommandPlaneStateError,
        );
      } finally {
        ctx.cleanup();
      }
    });
  }
});

test("recovered opening settles a residual RUNNING record before issuing its audited candidate", async () => {
  const ctx = await context();
  let finishOldExecution;
  try {
    const oldExecutor = executorHarness({
      executeTerminalControl: () => new Promise((resolve) => {
        finishOldExecution = resolve;
      }),
    });
    const rawPlane = await commandPlane.RelayV2HostCommandPlane.open({
      store: ctx.store,
      hostId: HOST_ID,
      executor: oldExecutor.executor,
      now: ctx.now,
      recover: false,
    });
    const snapshot = await ctx.store.read();
    const window = await rawPlane.issueDedupeWindow();
    const frame = commandFrame(snapshot.hostEpoch, window.windowId, "residual-running");
    const oldCall = rawPlane.execute(auth(), frame);
    await waitFor(async () => Object.values((await ctx.store.read()).commands).some(
      (record) => record.state === "running",
    ), "command never reached RUNNING");

    const recoveredExecutor = executorHarness();
    const candidate = await openCandidate(ctx, recoveredExecutor.executor);
    assert.notEqual(candidate, null);
    assert.equal(Object.values((await ctx.store.read()).commands).some(
      (record) => record.state === "accepted" || record.state === "running",
    ), false);

    const readiness = readinessHarness();
    const activation = activate(ctx, candidate, readiness.sink);
    assert.notEqual(activation, null);
    await activation.close();

    finishOldExecution(terminalSuccess(oldExecutor.calls.terminal[0]));
    const oldResult = await oldCall;
    assert.equal(oldResult.payload.state, "in_doubt");
  } finally {
    if (finishOldExecution) finishOldExecution({ state: "in_doubt" });
    ctx.cleanup();
  }
});

test("candidate provenance and exact host identity reject copy, proxy, replay, mismatch, and foreign owner", async (t) => {
  const ctx = await context();
  try {
    const fake = executorHarness();
    const rawPlane = await commandPlane.RelayV2HostCommandPlane.open({
      store: ctx.store,
      hostId: HOST_ID,
      executor: fake.executor,
      now: ctx.now,
      recover: false,
    });
    const rawReadiness = readinessHarness();
    assert.equal(activate(ctx, rawPlane, rawReadiness.sink), null);
    assert.deepEqual(rawReadiness.state, { applied: [], closes: 0 });

    const forgedReadiness = readinessHarness();
    assert.equal(activate(ctx, {}, forgedReadiness.sink), null);
    assert.deepEqual(forgedReadiness.state, { applied: [], closes: 0 });

    const candidate = await openCandidate(ctx, fake.executor);
    assert.equal(Reflect.get(
      commandPlane.RelayV2HostCommandPlane,
      Symbol.for("tmux-worktree.relay-v2.host-command-plane-readiness-candidate-capture"),
    ), undefined);
    assert.equal(Reflect.get(
      candidate,
      Symbol.for("tmux-worktree.relay-v2.host-command-plane-readiness-candidate-issuer"),
    ), undefined);
    assert.deepEqual(Reflect.ownKeys(candidate), []);
    const copiedReadiness = readinessHarness();
    assert.equal(activate(ctx, { ...candidate }, copiedReadiness.sink), null);
    assert.deepEqual(copiedReadiness.state, { applied: [], closes: 0 });
    const proxiedReadiness = readinessHarness();
    assert.equal(activate(ctx, new Proxy(candidate, {}), proxiedReadiness.sink), null);
    assert.deepEqual(proxiedReadiness.state, { applied: [], closes: 0 });

    const readiness = readinessHarness();
    const activation = activate(ctx, candidate, readiness.sink);
    assert.notEqual(activation, null);
    const replayReadiness = readinessHarness();
    assert.equal(activate(ctx, candidate, replayReadiness.sink), null);
    assert.deepEqual(replayReadiness.state, { applied: [], closes: 0 });
    await activation.close();

    for (const entry of [
      { name: "hostId", identity: { hostId: `${HOST_ID}-wrong` } },
      { name: "hostEpoch", identity: { hostEpoch: `${ctx.hostEpoch}-wrong` } },
      {
        name: "hostInstanceId",
        identity: { hostInstanceId: `${ctx.hostInstanceId}-wrong` },
      },
    ]) {
      await t.test(entry.name, async () => {
        const mismatchedCandidate = await openCandidate(ctx, fake.executor);
        const mismatchedReadiness = readinessHarness();
        assert.equal(activate(
          ctx,
          mismatchedCandidate,
          mismatchedReadiness.sink,
          entry.identity,
        ), null);
        assert.deepEqual(mismatchedReadiness.state, { applied: [], closes: 0 });
        assert.equal(
          activate(ctx, mismatchedCandidate, readinessHarness().sink),
          null,
          "identity mismatch must burn the one-shot candidate",
        );
      });
    }

    const foreignCommandPlane = await import(
      "../dist/relay/v2/hostCommandPlane.js?h1-readiness-foreign-owner"
    );
    const foreignCandidate = await foreignCommandPlane.RelayV2HostCommandPlane
      .openRecoveredAuthority({
        store: ctx.store,
        hostId: HOST_ID,
        executor: fake.executor,
        now: ctx.now,
      });
    const foreignReadiness = readinessHarness();
    assert.equal(activate(ctx, foreignCandidate, foreignReadiness.sink), null);
    assert.deepEqual(foreignReadiness.state, { applied: [], closes: 0 });
  } finally {
    ctx.cleanup();
  }
});

test("ordinary TypeError and safely finalized command failures do not withdraw H1", async () => {
  const ctx = await context();
  let mode = "resolve_type_error";
  try {
    const fake = executorHarness({
      resolve(request) {
        if (mode === "resolve_type_error") throw new TypeError("ordinary resolver failure");
        return executableAdmission(request);
      },
      executeTerminalControl(plan) {
        if (mode === "structured_failure") {
          return {
            state: "failed",
            sideEffect: "not_applied",
            error: {
              code: "COMMAND_FAILED",
              message: "Canonical terminal-control rejected the input",
              retryable: false,
              commandDisposition: "completed",
              details: null,
            },
          };
        }
        throw new TypeError(`ordinary executor failure for ${plan.commandId}`);
      },
    });
    const candidate = await openCandidate(ctx, fake.executor);
    const readiness = readinessHarness();
    const activation = activate(ctx, candidate, readiness.sink);
    assert.notEqual(activation, null);
    const snapshot = await ctx.store.read();
    const window = await activation.issueDedupeWindow();

    const resolutionFailure = await activation.execute(
      auth(),
      commandFrame(snapshot.hostEpoch, window.windowId, "ordinary-resolution"),
    );
    assert.equal(resolutionFailure.error.code, "INTERNAL");
    assert.equal(readiness.state.closes, 0);

    mode = "structured_failure";
    const structuredFailure = await activation.execute(
      auth(),
      commandFrame(snapshot.hostEpoch, window.windowId, "structured-failure"),
    );
    assert.equal(structuredFailure.payload.state, "failed");
    assert.equal(readiness.state.closes, 0);

    mode = "safe_in_doubt";
    const safeInDoubt = await activation.execute(
      auth(),
      commandFrame(snapshot.hostEpoch, window.windowId, "safe-in-doubt"),
    );
    assert.equal(safeInDoubt.payload.state, "in_doubt");
    assert.equal(readiness.state.closes, 0);
    await activation.close();
  } finally {
    ctx.cleanup();
  }
});

test("exact command-plane StateError withdraws H1 before its rejection is observable", async () => {
  const ctx = await context();
  let fatal = false;
  try {
    const fake = executorHarness({
      resolve(request) {
        if (fatal) {
          throw new commandPlane.RelayV2HostCommandPlaneStateError("fatal H1 state");
        }
        return executableAdmission(request);
      },
    });
    const candidate = await openCandidate(ctx, fake.executor);
    const events = [];
    const readiness = readinessHarness(() => true);
    const sink = Object.freeze({
      apply: readiness.sink.apply,
      close() {
        readiness.sink.close();
        events.push("withdrawn");
      },
    });
    const activation = activate(ctx, candidate, sink);
    assert.notEqual(activation, null);
    const snapshot = await ctx.store.read();
    const window = await activation.issueDedupeWindow();
    fatal = true;
    const visible = activation.execute(
      auth(),
      commandFrame(snapshot.hostEpoch, window.windowId, "fatal"),
    ).catch((error) => {
      events.push("rejected");
      throw error;
    });
    await assert.rejects(visible, commandPlane.RelayV2HostCommandPlaneStateError);
    assert.deepEqual(events, ["withdrawn", "rejected"]);
    assert.equal(readiness.state.closes, 1);
    await assert.rejects(
      activation.query(auth(), queryFrame(snapshot.hostEpoch, window.windowId, "missing", "closed")),
      TypeError,
    );
    await activation.close();
  } finally {
    ctx.cleanup();
  }
});

test("publication StateError survives ordinary fencing failure and withdraws before rejection", async () => {
  const ctx = await context();
  const events = [];
  const fatal = new commandPlane.RelayV2HostCommandPlaneStateError(
    "fatal committed publication",
  );
  try {
    const fake = executorHarness({
      executeTwRpc(plan) {
        const label = plan.arguments.label ?? "h1-publication";
        return {
          state: "succeeded",
          backendOutcome: {
            schemaVersion: commandPlane.RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
            backendInstanceKey: "h1-publication-backend",
            evidence: {
              session: {
                kind: "terminal",
                displayName: label,
                state: "running",
                project: null,
                label,
                cwd: plan.arguments.cwd,
                attached: false,
                windowCount: 1,
                createdAtMs: BASE_TIME,
                activityAtMs: BASE_TIME,
              },
            },
          },
          commitIntent: { change: "upsert" },
        };
      },
    });
    const reservations = new Map();
    const resourceMutationOwner = {
      reserve(transaction) {
        const reservationId = transaction.issueOpaqueId("res");
        const sessionId = transaction.issueOpaqueId("ses");
        reservations.set(reservationId, sessionId);
        transaction.putMaterializedRecord(`h1-reservation:${reservationId}`, { sessionId });
        return {
          kind: "reserved",
          binding: {
            schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
            owner: "relay_v2_resource_state",
            reservationId,
          },
        };
      },
      commit(transaction, intent) {
        const reservationId = intent.reservationBinding.reservationId;
        const sessionId = reservations.get(reservationId);
        transaction.deleteMaterializedRecord(`h1-reservation:${reservationId}`);
        reservations.delete(reservationId);
        return {
          schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
          owner: "relay_v2_resource_state",
          operation: intent.operation,
          principalId: intent.principalId,
          hostId: intent.hostId,
          hostEpoch: intent.hostEpoch,
          scopeId: intent.scopeId,
          sessionId,
          result: {
            session: {
              scopeId: intent.scopeId,
              ...structuredClone(intent.backendOutcome.evidence.session),
              sessionId,
            },
          },
          events: [],
          evidence: {
            source: "h1-publication-test",
            backendInstanceKey: intent.backendOutcome.backendInstanceKey,
          },
        };
      },
      settle() { return "retained"; },
      hasPendingSettlement() { return false; },
      publishCommitted() {
        events.push("publish");
        throw fatal;
      },
      fenceCommitUncertain() {
        events.push("fence");
        throw new Error("ordinary fencing failure");
      },
      fencePersistedCapacity() {},
      fenceMaterializedAuthority() {},
    };
    const candidate = await commandPlane.RelayV2HostCommandPlane.openRecoveredAuthority({
      store: ctx.store,
      hostId: HOST_ID,
      executor: fake.executor,
      resourceMutationOwner,
      now: ctx.now,
    });
    const readiness = readinessHarness();
    const sink = Object.freeze({
      apply: readiness.sink.apply,
      close() {
        readiness.sink.close();
        events.push("withdrawn");
      },
    });
    const activation = activate(ctx, candidate, sink);
    assert.notEqual(activation, null);
    const snapshot = await ctx.store.read();
    const window = await activation.issueDedupeWindow();
    const frame = fixture("command-execute-create-terminal");
    frame.expectedHostEpoch = snapshot.hostEpoch;
    frame.payload.dedupeWindowId = window.windowId;
    const visible = activation.execute(auth(), frame).catch((error) => {
      events.push("rejected");
      assert.equal(error, fatal);
      throw error;
    });
    await assert.rejects(visible, (error) => error === fatal);
    assert.deepEqual(events, ["publish", "fence", "withdrawn", "rejected"]);
    assert.equal(readiness.state.closes, 1);
  } finally {
    ctx.cleanup();
  }
});

test("close withdraws synchronously, returns one barrier, and drains an already admitted call", async () => {
  const ctx = await context();
  let releaseAdmission = null;
  try {
    const fake = executorHarness({
      resolve(request) {
        return new Promise((resolve) => {
          releaseAdmission = () => resolve(executableAdmission(request));
        });
      },
    });
    const candidate = await openCandidate(ctx, fake.executor);
    const readiness = readinessHarness();
    const activation = activate(ctx, candidate, readiness.sink);
    assert.notEqual(activation, null);
    const snapshot = await ctx.store.read();
    const window = await activation.issueDedupeWindow();

    const admitted = activation.execute(
      auth(),
      commandFrame(snapshot.hostEpoch, window.windowId, "close-drain"),
    );
    const firstClose = activation.close();
    const secondClose = activation.close();
    assert.equal(firstClose, secondClose);
    assert.equal(readiness.state.closes, 1);
    let drained = false;
    void firstClose.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    await waitFor(() => releaseAdmission !== null, "executor admission was never entered");
    releaseAdmission();
    assert.equal((await admitted).payload.state, "succeeded");
    await firstClose;
    assert.equal(drained, true);
  } finally {
    ctx.cleanup();
  }
});

test("sink rejection, throw, Promise, and reentry fail closed after one-shot consumption", async (t) => {
  const cases = [
    { name: "literal false", apply: () => false },
    { name: "throw", apply: () => { throw new Error("sink failure"); } },
    { name: "Promise", apply: () => Promise.reject(new Error("async sink failure")) },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const ctx = await context();
      try {
        const fake = executorHarness();
        const candidate = await openCandidate(ctx, fake.executor);
        const readiness = readinessHarness(entry.apply);
        assert.equal(activate(ctx, candidate, readiness.sink), null);
        assert.equal(readiness.state.closes, 1);
        assert.equal(activate(ctx, candidate, readinessHarness().sink), null);
        await Promise.resolve();
      } finally {
        ctx.cleanup();
      }
    });
  }

  await t.test("options descriptor trap reentry", async () => {
    const ctx = await context();
    try {
      const fake = executorHarness();
      const candidate = await openCandidate(ctx, fake.executor);
      const readiness = readinessHarness();
      const plain = activationOptions(ctx, candidate, readiness.sink);
      let nested = "not-called";
      let trapped = false;
      const options = new Proxy(plain, {
        getOwnPropertyDescriptor(target, property) {
          if (!trapped) {
            trapped = true;
            nested = activationModule.createRelayV2HostH1ReadinessActivation(plain);
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      assert.equal(
        activationModule.createRelayV2HostH1ReadinessActivation(options),
        null,
      );
      assert.equal(nested, null);
      assert.equal(readiness.state.closes, 1);
      assert.equal(activationModule.createRelayV2HostH1ReadinessActivation(plain), null);
    } finally {
      ctx.cleanup();
    }
  });

  await t.test("sink descriptor trap reentry", async () => {
    const ctx = await context();
    try {
      const fake = executorHarness();
      const candidate = await openCandidate(ctx, fake.executor);
      const readiness = readinessHarness();
      let nested = "not-called";
      let trapped = false;
      const sink = new Proxy(readiness.sink, {
        getOwnPropertyDescriptor(target, property) {
          if (!trapped) {
            trapped = true;
            nested = activate(ctx, candidate, readiness.sink);
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      assert.equal(activate(ctx, candidate, sink), null);
      assert.equal(nested, null);
      assert.equal(readiness.state.closes, 1);
      assert.equal(activate(ctx, candidate, readiness.sink), null);
    } finally {
      ctx.cleanup();
    }
  });

  await t.test("reentry", async () => {
    const ctx = await context();
    try {
      const fake = executorHarness();
      const candidate = await openCandidate(ctx, fake.executor);
      let sink;
      const readiness = readinessHarness(() => {
        assert.equal(activate(ctx, candidate, sink), null);
        return true;
      });
      sink = readiness.sink;
      assert.equal(activate(ctx, candidate, sink), null);
      assert.equal(readiness.state.closes, 1);
      assert.equal(activate(ctx, candidate, readinessHarness().sink), null);
    } finally {
      ctx.cleanup();
    }
  });
});
