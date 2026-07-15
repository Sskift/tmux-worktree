import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const codec = await import("../dist/relay/v2/codec.js");
const corpus = loadRelayV2FixtureCorpus();

const BASE_TIME = 1_783_700_200_000;
const HOST_ID = "mac-admin";

function harness() {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-command-plane-"));
  let now = BASE_TIME;
  return {
    home,
    now: () => now,
    setNow: (value) => { now = value; },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function auth(principalId = "principal-one", clientInstanceId = "android-one") {
  return { principalId, clientInstanceId, hostId: HOST_ID };
}

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function commandFrame(name, hostEpoch, windowId) {
  const frame = fixture(name);
  frame.expectedHostEpoch = hostEpoch;
  frame.payload.dedupeWindowId = windowId;
  return frame;
}

function queryFrame(hostEpoch, items) {
  const frame = fixture("command-query");
  frame.expectedHostEpoch = hostEpoch;
  frame.payload.items = structuredClone(items);
  return frame;
}

function backendSessionEvidence(plan) {
  const terminal = plan.operation === "create_terminal";
  const label = terminal ? (plan.arguments.label ?? "demo") : null;
  return {
    scopeId: plan.scopeId,
    kind: terminal ? "terminal" : "worktree",
    displayName: terminal ? label : (plan.arguments.project ?? "demo"),
    state: "running",
    project: terminal ? null : (plan.arguments.project ?? "demo"),
    label,
    cwd: terminal ? plan.arguments.cwd : "/worktrees/demo",
    attached: false,
    windowCount: 1,
    createdAtMs: BASE_TIME,
    activityAtMs: BASE_TIME,
  };
}

function successFor(plan) {
  switch (plan.operation) {
    case "create_worktree":
    case "create_terminal":
      return {
        state: "succeeded",
        backendOutcome: {
          schemaVersion: commandPlane.RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
          backendInstanceKey: `backend-${plan.operation}`,
          evidence: { session: backendSessionEvidence(plan) },
        },
        commitIntent: { change: "upsert" },
      };
    case "send_agent_message":
      return {
        state: "succeeded",
        result: {
          pane: plan.arguments.pane,
          submit: plan.arguments.submit,
          messageUtf8Bytes: Buffer.byteLength(plan.arguments.message, "utf8"),
        },
      };
    case "kill_session":
      return {
        state: "succeeded",
        backendOutcome: {
          schemaVersion: commandPlane.RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
          backendInstanceKey: "backend-existing-session",
          evidence: { terminated: true },
        },
        commitIntent: { change: "delete" },
      };
  }
}

function authorityEvidence(request, coverage = "complete") {
  return {
    schemaVersion: commandPlane.RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION,
    coverage,
    authority: request.authority,
    hostId: request.hostId,
    hostEpoch: request.hostEpoch,
    scopeId: request.scopeId,
    sessionId: request.sessionId,
    evidence: { resolver: "test-canonical-authority" },
  };
}

function fakeExecutor(overrides = {}) {
  const calls = {
    resolve: [],
    twRpc: [],
    terminalControl: [],
  };
  return {
    calls,
    executor: {
      async resolve(request) {
        calls.resolve.push(structuredClone(request));
        if (overrides.resolve) return overrides.resolve(request);
        return { kind: "executable", adapterState: { resolvedTarget: request.scopeId } };
      },
      async executeTwRpc(plan) {
        calls.twRpc.push(structuredClone(plan));
        if (overrides.executeTwRpc) return overrides.executeTwRpc(plan);
        return successFor(plan);
      },
      async executeTerminalControl(plan) {
        calls.terminalControl.push(structuredClone(plan));
        if (overrides.executeTerminalControl) return overrides.executeTerminalControl(plan);
        return successFor(plan);
      },
    },
  };
}

function fakeResourceMutationOwner(overrides = {}) {
  const calls = { commit: [] };
  return {
    calls,
    owner: {
      commit(transaction, intent) {
        calls.commit.push(structuredClone(intent));
        assert.equal(transaction.getCommandRecord, undefined);
        assert.equal(transaction.putCommandRecord, undefined);
        assert.equal(transaction.deleteCommandRecord, undefined);
        assert.equal(transaction.hostEpoch, undefined);
        assert.equal(typeof intent.backendOutcome.backendInstanceKey, "string");
        assert.ok(intent.backendOutcome.backendInstanceKey.length > 0);
        if (overrides.commit) return overrides.commit(transaction, intent);
        const sessionId = intent.operation === "kill_session"
          ? intent.sessionId
          : transaction.issueOpaqueId("ses");
        const result = intent.operation === "kill_session"
          ? { sessionId, terminated: true }
          : {
              session: {
                ...structuredClone(intent.backendOutcome.evidence.session),
                sessionId,
              },
            };
        const revision = transaction.allocateRevision(`sessions:${intent.scopeId}`);
        const eventSeq = transaction.allocateEventSeq();
        transaction.putMaterializedRecord(`test-h2-session:${sessionId}`, {
          schemaVersion: 1,
          operation: intent.operation,
          sessionId,
          revision,
          eventSeq,
          backendInstanceKey: intent.backendOutcome.backendInstanceKey,
        });
        return {
          schemaVersion: commandPlane.RELAY_V2_COMMAND_RESOURCE_COMMIT_SCHEMA_VERSION,
          owner: "relay_v2_resource_state",
          operation: intent.operation,
          principalId: intent.principalId,
          hostId: intent.hostId,
          hostEpoch: intent.hostEpoch,
          scopeId: intent.scopeId,
          sessionId,
          result,
          evidence: {
            source: "test-h2-owner",
            backendInstanceKey: intent.backendOutcome.backendInstanceKey,
            revision,
            eventSeq,
          },
        };
      },
    },
  };
}

async function setup(h, executor, recover = true, resource = fakeResourceMutationOwner()) {
  const store = await hostState.RelayV2HostStateStore.open({ home: h.home });
  const plane = await commandPlane.RelayV2HostCommandPlane.open({
    store,
    hostId: HOST_ID,
    executor,
    resourceMutationOwner: resource.owner,
    now: h.now,
    recover,
  });
  const snapshot = await store.read();
  const window = await plane.issueDedupeWindow({
    acceptUntilMs: h.now() + 60_000,
    queryUntilMs: h.now() + 60_000 + commandPlane.RELAY_V2_COMMAND_DEDUPE_RETENTION_MS,
  });
  return { store, plane, snapshot, window, resource };
}

function assertCodecFrame(frame) {
  assert.doesNotThrow(() => codec.encodeRelayV2WebSocketFrame("public", frame));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function recomputeStoredFingerprint(record) {
  const input = {
    schemaVersion: commandPlane.RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION,
    operation: record.operation,
    dedupeWindowId: record.dedupeWindowId,
    hostEpoch: record.hostEpoch,
    hostId: record.hostId,
    scopeId: record.scopeId,
  };
  if (record.sessionId !== null) input.sessionId = record.sessionId;
  input.arguments = structuredClone(record.arguments);
  record.fingerprint = {
    schemaVersion: commandPlane.RELAY_V2_COMMAND_FINGERPRINT_SCHEMA_VERSION,
    algorithm: "sha256-rfc8785",
    digest: createHash("sha256").update(canonicalJson(input), "utf8").digest("hex"),
  };
  return record;
}

test("Relay v2 command fixtures persist RUNNING before routing each fixed operation to its canonical authority", async () => {
  const h = harness();
  try {
    let store;
    const fake = fakeExecutor({
      executeTwRpc: async (plan) => {
        const snapshot = await store.read();
        const records = Object.values(snapshot.commands);
        assert.ok(records.some((record) => (
          record.commandId === plan.adapterState.commandId
          && record.state === "running"
        )), `${plan.operation} must be durably RUNNING before TW RPC`);
        return successFor(plan);
      },
      executeTerminalControl: async (plan) => {
        const snapshot = await store.read();
        const records = Object.values(snapshot.commands);
        assert.ok(records.some((record) => (
          record.commandId === plan.adapterState.commandId
          && record.state === "running"
        )), "send_agent_message must be durably RUNNING before terminal-control");
        return successFor(plan);
      },
    });
    const configured = await setup(h, fake.executor);
    store = configured.store;

    const cases = [
      ["command-execute-create-worktree", "tw_rpc"],
      ["command-execute-create-terminal", "tw_rpc"],
      ["command-execute-send-agent-message", "terminal_control"],
      ["command-execute-kill-session", "tw_rpc"],
    ];
    for (const [name, authority] of cases) {
      const frame = commandFrame(name, configured.snapshot.hostEpoch, configured.window.windowId);
      // The fake resolver echoes this test-only value only in its private
      // adapterState; it never changes the frozen public command arguments.
      const commandId = frame.commandId;
      fake.executor.resolve = async (request) => {
        fake.calls.resolve.push(structuredClone(request));
        assert.equal(request.authority, authority);
        return { kind: "executable", adapterState: { commandId } };
      };
      const response = await configured.plane.execute(auth(), frame);
      assert.equal(response.type, "command.status", name);
      assert.equal(response.payload.state, "succeeded", name);
      assert.equal(response.payload.deduplicated, false, name);
      assertCodecFrame(response);
    }

    assert.deepEqual(
      fake.calls.twRpc.map((plan) => plan.operation),
      ["create_worktree", "create_terminal", "kill_session"],
    );
    assert.deepEqual(
      fake.calls.terminalControl.map((plan) => plan.operation),
      ["send_agent_message"],
    );
    const persisted = await store.read();
    assert.equal(Object.values(persisted.commands).length, 4);
    assert.ok(Object.values(persisted.commands).every((record) => (
      record.state === "succeeded"
      && record.fingerprint.schemaVersion === 1
      && record.fingerprint.algorithm === "sha256-rfc8785"
      && record.executionPlan === null
    )));
  } finally {
    h.cleanup();
  }
});

test("duplicate and cross-client response-loss retry share one principal ledger while fingerprint changes conflict", async () => {
  const h = harness();
  try {
    let releaseExecution;
    let executionStarted;
    const started = new Promise((resolve) => { executionStarted = resolve; });
    const release = new Promise((resolve) => { releaseExecution = resolve; });
    const fake = fakeExecutor({
      executeTerminalControl: async (plan) => {
        executionStarted();
        await release;
        return successFor(plan);
      },
    });
    const configured = await setup(h, fake.executor);
    const original = commandFrame(
      "command-execute-send-agent-message",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const firstPending = configured.plane.execute(auth(), original);
    await started;

    const duplicate = structuredClone(original);
    duplicate.requestId = "duplicate-attempt";
    const duplicateResponse = await configured.plane.execute(
      auth("principal-one", "android-two"),
      duplicate,
    );
    assert.equal(duplicateResponse.payload.state, "running");
    assert.equal(duplicateResponse.payload.deduplicated, true);

    const conflict = structuredClone(original);
    conflict.requestId = "conflicting-attempt";
    conflict.payload.arguments.message = "different";
    const conflictResponse = await configured.plane.execute(auth(), conflict);
    assert.equal(conflictResponse.type, "error");
    assert.equal(conflictResponse.error.code, "IDEMPOTENCY_CONFLICT");

    releaseExecution();
    const firstResponse = await firstPending;
    assert.equal(firstResponse.payload.state, "succeeded");
    assert.equal(fake.calls.terminalControl.length, 1);

    const finalDuplicate = structuredClone(duplicate);
    finalDuplicate.requestId = "final-duplicate-attempt";
    const finalResponse = await configured.plane.execute(
      auth("principal-one", "android-two"),
      finalDuplicate,
    );
    assert.equal(finalResponse.payload.state, "succeeded");
    assert.equal(finalResponse.payload.deduplicated, true);
    assert.deepEqual(finalResponse.payload.result, firstResponse.payload.result);
    assert.equal(fake.calls.terminalControl.length, 1);

    const otherPrincipal = structuredClone(original);
    otherPrincipal.requestId = "other-principal-attempt";
    const otherResponse = await configured.plane.execute(auth("principal-two"), otherPrincipal);
    assert.equal(otherResponse.payload.state, "succeeded");
    assert.equal(fake.calls.terminalControl.length, 2);

    const persistedRecords = Object.values((await configured.store.read()).commands);
    assert.equal(persistedRecords.length, 2);
    const persisted = persistedRecords
      .find(({ principalId, commandId }) => (
        principalId === "principal-one" && commandId === original.commandId
      ));
    assert.equal(persisted.acceptedClientInstanceId, "android-one");

    const otherClientConflict = structuredClone(original);
    otherClientConflict.requestId = "other-client-conflicting-retry";
    otherClientConflict.payload.arguments.message = "changed-after-response-loss";
    const otherClientConflictResponse = await configured.plane.execute(
      auth("principal-one", "android-two"),
      otherClientConflict,
    );
    assert.equal(otherClientConflictResponse.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(fake.calls.terminalControl.length, 2);
  } finally {
    h.cleanup();
  }
});

test("two command-plane instances sharing H0 claim one RUNNING winner", async () => {
  const h = harness();
  try {
    let executionStarted;
    let releaseExecution;
    const started = new Promise((resolve) => { executionStarted = resolve; });
    const release = new Promise((resolve) => { releaseExecution = resolve; });
    const fake = fakeExecutor({
      executeTerminalControl: async (plan) => {
        executionStarted();
        await release;
        return successFor(plan);
      },
    });
    const configured = await setup(h, fake.executor);
    const secondPlane = await commandPlane.RelayV2HostCommandPlane.open({
      store: configured.store,
      hostId: HOST_ID,
      executor: fake.executor,
      resourceMutationOwner: configured.resource.owner,
      now: h.now,
      recover: false,
    });
    const frame = commandFrame(
      "command-execute-send-agent-message",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const first = configured.plane.execute(auth(), frame);
    const competingFrame = structuredClone(frame);
    competingFrame.requestId = "competing-plane-attempt";
    const second = secondPlane.execute(auth(), competingFrame);
    await started;
    assert.equal(fake.calls.terminalControl.length, 1);
    releaseExecution();
    const responses = await Promise.all([first, second]);
    assert.ok(responses.some(({ payload }) => payload.state === "succeeded"));
    assert.equal(fake.calls.terminalControl.length, 1);

    const responseLossRetry = structuredClone(frame);
    responseLossRetry.requestId = "second-client-after-response-loss";
    const retry = await secondPlane.execute(auth("principal-one", "android-two"), responseLossRetry);
    assert.equal(retry.payload.state, "succeeded");
    assert.equal(retry.payload.deduplicated, true);
    assert.equal(fake.calls.terminalControl.length, 1);
  } finally {
    h.cleanup();
  }
});

test("durable ACCEPTED work keeps a single live runner across admission uncertainty and a pre-rename RUNNING failure", async (t) => {
  await t.test("admission commit uncertainty is recovered without restart", async () => {
    const h = harness();
    try {
      const fake = fakeExecutor();
      const configured = await setup(h, fake.executor);
      let failWitnessRename = true;
      const store = await hostState.RelayV2HostStateStore.open({
        paths: configured.store.paths,
        renameFile: (source, destination) => {
          if (failWitnessRename && destination === configured.store.paths.continuity) {
            failWitnessRename = false;
            throw new Error("injected lost admission commit acknowledgement");
          }
          renameSync(source, destination);
        },
      });
      const plane = await commandPlane.RelayV2HostCommandPlane.open({
        store,
        hostId: HOST_ID,
        executor: fake.executor,
        resourceMutationOwner: configured.resource.owner,
        now: h.now,
        recover: false,
      });
      const frame = commandFrame(
        "command-execute-send-agent-message",
        configured.snapshot.hostEpoch,
        configured.window.windowId,
      );
      const response = await plane.execute(auth(), frame);
      assert.equal(response.payload.state, "succeeded");
      assert.equal(fake.calls.terminalControl.length, 1);
      assert.ok(Object.values((await store.read()).commands).some((record) => (
        record.commandId === frame.commandId && record.state === "succeeded"
      )));
    } finally {
      h.cleanup();
    }
  });

  await t.test("an existing ACCEPTED retry joins the runner after RUNNING rename failures", async () => {
    const h = harness();
    try {
      const fake = fakeExecutor();
      const configured = await setup(h, fake.executor);
      let allowRunningRename = false;
      let stateRenames = 0;
      let rejectedRunningRenames = 0;
      const store = await hostState.RelayV2HostStateStore.open({
        paths: configured.store.paths,
        renameFile: (source, destination) => {
          if (destination === configured.store.paths.state) {
            stateRenames += 1;
            if (stateRenames >= 2 && !allowRunningRename) {
              rejectedRunningRenames += 1;
              throw new Error("injected failure before RUNNING state rename");
            }
          }
          renameSync(source, destination);
        },
      });
      const plane = await commandPlane.RelayV2HostCommandPlane.open({
        store,
        hostId: HOST_ID,
        executor: fake.executor,
        resourceMutationOwner: configured.resource.owner,
        now: h.now,
        recover: false,
      });
      const frame = commandFrame(
        "command-execute-send-agent-message",
        configured.snapshot.hostEpoch,
        configured.window.windowId,
      );
      const first = plane.execute(auth(), frame);
      await waitFor(
        () => rejectedRunningRenames > 0,
        "runner did not reach the injected pre-rename RUNNING failure",
      );
      assert.equal(fake.calls.terminalControl.length, 0);
      assert.ok(Object.values((await store.read()).commands).some(({ state }) => state === "accepted"));

      const duplicate = structuredClone(frame);
      duplicate.requestId = "accepted-live-runner-duplicate";
      const second = plane.execute(auth(), duplicate);
      allowRunningRename = true;
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      assert.equal(firstResponse.payload.state, "succeeded");
      assert.equal(secondResponse.payload.state, "succeeded");
      assert.equal(secondResponse.payload.deduplicated, true);
      assert.equal(fake.calls.terminalControl.length, 1);
    } finally {
      h.cleanup();
    }
  });
});

test("host epoch mismatch is rejected before resolution and leaves the command ledger untouched", async () => {
  const h = harness();
  try {
    const fake = fakeExecutor();
    const configured = await setup(h, fake.executor);
    const before = await configured.store.read();
    const frame = commandFrame(
      "command-execute-kill-session",
      "stale-host-epoch",
      configured.window.windowId,
    );
    frame.payload.arguments = { malformedButNotYetAuthorizedForSchema: true };
    const response = await configured.plane.execute(auth(), frame);
    assert.equal(response.type, "error");
    assert.equal(response.error.code, "HOST_EPOCH_MISMATCH");
    assert.deepEqual(response.error.details, {
      expectedHostEpoch: "stale-host-epoch",
      actualHostEpoch: configured.snapshot.hostEpoch,
    });
    assert.equal(fake.calls.resolve.length, 0);
    const after = await configured.store.read();
    assert.equal(after.commitSeq, before.commitSeq);
    assert.deepEqual({ ...after.commands }, {});
  } finally {
    h.cleanup();
  }
});

test("route permission is denied before any H0 access and does not disclose the host epoch", async () => {
  let h0Calls = 0;
  const inaccessibleStore = {
    read() {
      h0Calls += 1;
      throw new Error("H0 must not be read for a denied route");
    },
    serialize() {
      h0Calls += 1;
      throw new Error("H0 must not be serialized for a denied route");
    },
    transaction() {
      h0Calls += 1;
      throw new Error("H0 must not be mutated for a denied route");
    },
  };
  const fake = fakeExecutor();
  const plane = await commandPlane.RelayV2HostCommandPlane.open({
    store: inaccessibleStore,
    hostId: HOST_ID,
    executor: fake.executor,
    recover: false,
  });
  const denied = { principalId: "principal-one", clientInstanceId: "android-one", hostId: "other-host" };
  const execute = fixture("command-execute-kill-session");
  execute.payload.arguments = { forged: "schema detail must remain hidden" };
  const executeResponse = await plane.execute(denied, execute);
  assert.equal(executeResponse.error.code, "PERMISSION_DENIED");
  assert.equal(Object.hasOwn(executeResponse, "hostEpoch"), false);
  assert.equal(executeResponse.error.details, null);

  const query = fixture("command-query");
  query.payload.items = "not-an-array";
  const queryResponse = await plane.query(denied, query);
  assert.equal(queryResponse.error.code, "PERMISSION_DENIED");
  assert.equal(Object.hasOwn(queryResponse, "hostEpoch"), false);
  assert.equal(queryResponse.error.details, null);
  assert.equal(h0Calls, 0);
  assert.equal(fake.calls.resolve.length, 0);
});

test("H1 rejects non-message command whitespace before resolution or ledger work", async () => {
  const h = harness();
  try {
    const fake = fakeExecutor();
    const configured = await setup(h, fake.executor);
    const before = await configured.store.read();
    const frame = commandFrame(
      "command-execute-create-terminal",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    frame.payload.arguments.cwd = ` ${frame.payload.arguments.cwd}`;
    await assert.rejects(
      () => configured.plane.execute(auth(), frame),
      (error) => error?.name === "RelayV2CodecError" && error?.failureClass === "invalid-argument",
    );
    const after = await configured.store.read();
    assert.equal(after.commitSeq, before.commitSeq);
    assert.equal(fake.calls.resolve.length, 0);
  } finally {
    h.cleanup();
  }
});

test("immutable admission and canonical executor failures become durable final failed states", async () => {
  const h = harness();
  try {
    const fake = fakeExecutor({
      resolve: async (request) => request.operation === "kill_session"
        ? {
            kind: "immutable_business_failure",
            authorityEvidence: authorityEvidence(request),
            error: {
              code: "SESSION_NOT_FOUND",
              message: "Session does not exist in the complete authority view",
              retryable: false,
              commandDisposition: "completed",
              details: null,
            },
          }
        : { kind: "executable", adapterState: { resolvedTarget: request.scopeId } },
      executeTwRpc: async () => ({
        state: "failed",
        error: {
          code: "COMMAND_FAILED",
          message: "Canonical TW RPC rejected the mutation",
          retryable: false,
          commandDisposition: "completed",
          details: null,
        },
      }),
    });
    const configured = await setup(h, fake.executor);
    const immutable = commandFrame(
      "command-execute-kill-session",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const immutableResponse = await configured.plane.execute(auth(), immutable);
    assert.equal(immutableResponse.payload.state, "failed");
    assert.equal(immutableResponse.error.code, "SESSION_NOT_FOUND");
    assert.equal(fake.calls.twRpc.length, 0);

    const executorFailure = commandFrame(
      "command-execute-create-terminal",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const executorResponse = await configured.plane.execute(auth(), executorFailure);
    assert.equal(executorResponse.payload.state, "failed");
    assert.equal(executorResponse.error.code, "COMMAND_FAILED");
    assert.equal(fake.calls.twRpc.length, 1);

    const duplicate = structuredClone(executorFailure);
    duplicate.requestId = "failed-duplicate";
    const duplicateResponse = await configured.plane.execute(auth(), duplicate);
    assert.equal(duplicateResponse.payload.state, "failed");
    assert.equal(duplicateResponse.payload.deduplicated, true);
    assert.equal(fake.calls.twRpc.length, 1);

    const queried = await configured.plane.query(auth(), queryFrame(
      configured.snapshot.hostEpoch,
      [
        { commandId: immutable.commandId, dedupeWindowId: configured.window.windowId },
        { commandId: executorFailure.commandId, dedupeWindowId: configured.window.windowId },
      ],
    ));
    assert.deepEqual(
      queried.payload.items.map((item) => [item.state, item.error.code]),
      [["failed", "SESSION_NOT_FOUND"], ["failed", "COMMAND_FAILED"]],
    );
  } finally {
    h.cleanup();
  }
});

test("partial or unreachable resolver evidence cannot create an immutable NOT_FOUND ledger row", async () => {
  const h = harness();
  try {
    let resolution = 0;
    const fake = fakeExecutor({
      resolve: async (request) => {
        resolution += 1;
        if (resolution === 1) {
          return {
            kind: "immutable_business_failure",
            authorityEvidence: authorityEvidence(request, "partial"),
            error: {
              code: "SESSION_NOT_FOUND",
              message: "Partial discovery did not find the Session",
              retryable: false,
              commandDisposition: "completed",
              details: null,
            },
          };
        }
        return {
          kind: "transient_admission_failure",
          authorityEvidence: authorityEvidence(request, "partial"),
          error: {
            code: "SESSION_NOT_FOUND",
            message: "Partial lookup did not observe the Session",
            retryable: false,
            commandDisposition: "not_accepted",
            details: null,
          },
        };
      },
    });
    const configured = await setup(h, fake.executor);
    const partial = commandFrame(
      "command-execute-kill-session",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const partialResponse = await configured.plane.execute(auth(), partial);
    assert.equal(partialResponse.error.code, "SCOPE_UNREACHABLE");
    assert.equal(partialResponse.error.retryable, true);
    assert.equal(partialResponse.error.commandDisposition, "not_accepted");

    const unreachable = structuredClone(partial);
    unreachable.requestId = "unreachable-resolution";
    unreachable.commandId = "cmd-unreachable-resolution";
    const unreachableResponse = await configured.plane.execute(auth(), unreachable);
    assert.equal(unreachableResponse.error.code, "SCOPE_UNREACHABLE");
    assert.equal(unreachableResponse.error.retryable, true);
    assert.equal(unreachableResponse.error.commandDisposition, "not_accepted");
    assert.deepEqual({ ...(await configured.store.read()).commands }, {});
    assert.equal(fake.calls.twRpc.length, 0);
  } finally {
    h.cleanup();
  }
});

test("recovery revalidates closed plans, command semantics, results, and errors before dispatch", async () => {
  const h = harness();
  try {
    const seedExecutor = fakeExecutor();
    const configured = await setup(h, seedExecutor.executor);
    const frame = commandFrame(
      "command-execute-send-agent-message",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    assert.equal((await configured.plane.execute(auth(), frame)).payload.state, "succeeded");
    const snapshot = await configured.store.read();
    const [key, finalRecord] = Object.entries(snapshot.commands).find(([, record]) => (
      record.commandId === frame.commandId
    ));
    const validPlan = seedExecutor.calls.terminalControl[0];
    const corruptions = [
      {
        name: "unknown authority",
        mutate: (record) => ({
          ...record,
          executionPlan: { ...record.executionPlan, authority: "future_control" },
        }),
      },
      {
        name: "unknown plan key",
        mutate: (record) => ({
          ...record,
          executionPlan: { ...record.executionPlan, futureField: true },
        }),
      },
      {
        name: "unknown record key",
        mutate: (record) => ({ ...record, futureRecordField: true }),
      },
      {
        name: "principal mismatch",
        mutate: (record) => ({
          ...record,
          executionPlan: { ...record.executionPlan, principalId: "other-principal" },
        }),
      },
      {
        name: "self-consistent operation arguments",
        mutate: (record) => {
          record.arguments.pane = "0";
          record.executionPlan.arguments.pane = "0";
          return recomputeStoredFingerprint(record);
        },
      },
      {
        name: "self-consistent target relationship",
        mutate: (record) => {
          record.sessionId = null;
          record.executionPlan.sessionId = null;
          return recomputeStoredFingerprint(record);
        },
      },
      {
        name: "state-specific result relationship",
        mutate: () => ({
          ...structuredClone(finalRecord),
          result: {
            ...structuredClone(finalRecord.result),
            messageUtf8Bytes: finalRecord.result.messageUtf8Bytes + 1,
          },
        }),
      },
      {
        name: "state-specific failed error disposition",
        mutate: () => ({
          ...structuredClone(finalRecord),
          state: "failed",
          result: null,
          error: {
            code: "COMMAND_FAILED",
            message: "semantically invalid retryable final error",
            retryable: true,
            commandDisposition: "not_accepted",
            details: null,
          },
        }),
      },
      {
        name: "state-specific in-doubt error",
        mutate: () => ({
          ...structuredClone(finalRecord),
          state: "in_doubt",
          result: null,
          error: {
            code: "COMMAND_IN_DOUBT",
            message: "forged non-canonical uncertainty",
            retryable: false,
            commandDisposition: "in_doubt",
            details: null,
          },
        }),
      },
    ];
    const acceptedRecord = {
      ...structuredClone(finalRecord),
      executionPlan: structuredClone(validPlan),
      authorityEvidence: null,
      state: "accepted",
      finalizedAtMs: null,
      resultUntilMs: null,
      dedupeUntilMs: null,
      result: null,
      error: null,
    };
    for (const corruption of corruptions) {
      await configured.store.transaction((transaction) => {
        transaction.putCommandRecord(key, corruption.mutate(structuredClone(acceptedRecord)));
      });
      const recoveryExecutor = fakeExecutor();
      await assert.rejects(
        () => commandPlane.RelayV2HostCommandPlane.open({
          store: configured.store,
          hostId: HOST_ID,
          executor: recoveryExecutor.executor,
          resourceMutationOwner: configured.resource.owner,
          now: h.now,
        }),
        commandPlane.RelayV2HostCommandPlaneStateError,
        corruption.name,
      );
      assert.equal(recoveryExecutor.calls.resolve.length, 0, corruption.name);
      assert.equal(recoveryExecutor.calls.twRpc.length, 0, corruption.name);
      assert.equal(recoveryExecutor.calls.terminalControl.length, 0, corruption.name);
    }
  } finally {
    h.cleanup();
  }
});

test("an exception after the RUNNING boundary becomes durable in_doubt and is never replayed", async () => {
  const h = harness();
  try {
    let observedRunning = false;
    let store;
    const fake = fakeExecutor({
      executeTerminalControl: async () => {
        const snapshot = await store.read();
        observedRunning = Object.values(snapshot.commands).some(({ state }) => state === "running");
        throw new Error("injected crash after terminal-control may have accepted input");
      },
    });
    const configured = await setup(h, fake.executor);
    store = configured.store;
    const frame = commandFrame(
      "command-execute-send-agent-message",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const response = await configured.plane.execute(auth(), frame);
    assert.equal(observedRunning, true);
    assert.equal(response.payload.state, "in_doubt");
    assert.equal(response.error.code, "COMMAND_IN_DOUBT");
    assert.equal(response.error.commandDisposition, "in_doubt");

    const retry = structuredClone(frame);
    retry.requestId = "uncertain-retry";
    const retryResponse = await configured.plane.execute(auth(), retry);
    assert.equal(retryResponse.payload.state, "in_doubt");
    assert.equal(retryResponse.payload.deduplicated, true);
    assert.equal(fake.calls.terminalControl.length, 1);

    const query = queryFrame(configured.snapshot.hostEpoch, [{
      commandId: frame.commandId,
      dedupeWindowId: configured.window.windowId,
    }]);
    const queryResponse = await configured.plane.query(auth(), query);
    assert.equal(queryResponse.payload.items[0].state, "in_doubt");
    assert.equal(queryResponse.payload.items[0].error.code, "COMMAND_IN_DOUBT");
  } finally {
    h.cleanup();
  }
});

test("H2 resource owner allocates opaque Session identity and commits it atomically with the ledger", async (t) => {
  await t.test("successful create commits the H2 mapping and terminal ledger in one cut", async () => {
    const h = harness();
    try {
      const fake = fakeExecutor();
      const configured = await setup(h, fake.executor);
      const frame = commandFrame(
        "command-execute-create-terminal",
        configured.snapshot.hostEpoch,
        configured.window.windowId,
      );
      const response = await configured.plane.execute(auth(), frame);
      assert.equal(response.payload.state, "succeeded");
      assert.equal(configured.resource.calls.commit.length, 1);
      const intent = configured.resource.calls.commit[0];
      assert.equal(intent.sessionId, null);
      assert.equal(Object.hasOwn(intent.backendOutcome, "sessionId"), false);
      assert.equal(Object.hasOwn(intent.backendOutcome.evidence, "sessionId"), false);
      assert.equal(Object.hasOwn(intent.backendOutcome.evidence.session, "sessionId"), false);
      assert.match(response.payload.result.session.sessionId, /^ses_[0-9a-f]{32}$/);
      const snapshot = await configured.store.read();
      const ledger = Object.values(snapshot.commands).find(({ commandId }) => commandId === frame.commandId);
      const mapping = snapshot.materialized[
        `test-h2-session:${response.payload.result.session.sessionId}`
      ];
      assert.equal(ledger.state, "succeeded");
      assert.equal(mapping.sessionId, response.payload.result.session.sessionId);
      assert.equal(mapping.revision, snapshot.revisions[`sessions:${frame.scopeId}`]);
      assert.equal(mapping.eventSeq, snapshot.eventSeq);
    } finally {
      h.cleanup();
    }
  });

  await t.test("a failed final state rename publishes neither the H2 draft nor success ledger", async () => {
    const h = harness();
    try {
      const fake = fakeExecutor();
      const configured = await setup(h, fake.executor);
      let stateRenames = 0;
      const store = await hostState.RelayV2HostStateStore.open({
        paths: configured.store.paths,
        renameFile: (source, destination) => {
          if (destination === configured.store.paths.state) {
            stateRenames += 1;
            if (stateRenames === 3) {
              throw new Error("injected failure before final ledger/resource state rename");
            }
          }
          renameSync(source, destination);
        },
      });
      const resource = fakeResourceMutationOwner();
      const plane = await commandPlane.RelayV2HostCommandPlane.open({
        store,
        hostId: HOST_ID,
        executor: fake.executor,
        resourceMutationOwner: resource.owner,
        now: h.now,
        recover: false,
      });
      const frame = commandFrame(
        "command-execute-create-terminal",
        configured.snapshot.hostEpoch,
        configured.window.windowId,
      );
      const response = await plane.execute(auth(), frame);
      assert.equal(response.payload.state, "in_doubt");
      assert.equal(fake.calls.twRpc.length, 1);
      assert.equal(resource.calls.commit.length, 1);
      const snapshot = await store.read();
      assert.equal(
        Object.keys(snapshot.materialized).some((key) => key.startsWith("test-h2-session:")),
        false,
      );
      assert.equal(snapshot.revisions[`sessions:${frame.scopeId}`], undefined);
      assert.equal(snapshot.eventSeq, "0");
      assert.ok(Object.values(snapshot.commands).some((record) => (
        record.commandId === frame.commandId && record.state === "in_doubt"
      )));
    } finally {
      h.cleanup();
    }
  });

  await t.test("executor-supplied opaque Session identity is rejected before H2 commit", async () => {
    const h = harness();
    try {
      const fake = fakeExecutor({
        executeTwRpc: async (plan) => {
          const outcome = successFor(plan);
          outcome.backendOutcome.evidence.session.sessionId = "ses_forged_by_executor";
          return outcome;
        },
      });
      const configured = await setup(h, fake.executor);
      const frame = commandFrame(
        "command-execute-create-terminal",
        configured.snapshot.hostEpoch,
        configured.window.windowId,
      );
      const response = await configured.plane.execute(auth(), frame);
      assert.equal(response.payload.state, "in_doubt");
      assert.equal(configured.resource.calls.commit.length, 0);
      assert.equal(fake.calls.twRpc.length, 1);
    } finally {
      h.cleanup();
    }
  });
});

test("startup recovery converts a crash-left RUNNING row to in_doubt without replaying it", async () => {
  const h = harness();
  try {
    let executionStarted;
    let rejectExecution;
    const started = new Promise((resolve) => { executionStarted = resolve; });
    const pendingExecution = new Promise((_, reject) => { rejectExecution = reject; });
    const fake = fakeExecutor({
      executeTerminalControl: async () => {
        executionStarted();
        return pendingExecution;
      },
    });
    const configured = await setup(h, fake.executor);
    const frame = commandFrame(
      "command-execute-send-agent-message",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const interrupted = configured.plane.execute(auth(), frame);
    await started;
    assert.ok(Object.values((await configured.store.read()).commands).some(({ state }) => state === "running"));

    await commandPlane.RelayV2HostCommandPlane.open({
      store: configured.store,
      hostId: HOST_ID,
      executor: fake.executor,
      now: h.now,
    });
    const recovered = await configured.store.read();
    assert.ok(Object.values(recovered.commands).some(({ state }) => state === "in_doubt"));
    assert.equal(fake.calls.terminalControl.length, 1);

    rejectExecution(new Error("injected process loss"));
    const response = await interrupted;
    assert.equal(response.payload.state, "in_doubt");
    assert.equal(fake.calls.terminalControl.length, 1);
  } finally {
    h.cleanup();
  }
});

test("query distinguishes retry, reissue, expired result, and unknown evidence", async () => {
  const h = harness();
  try {
    const fake = fakeExecutor();
    const configured = await setup(h, fake.executor);
    const missing = { commandId: "cmd-never-accepted", dedupeWindowId: configured.window.windowId };
    let response = await configured.plane.query(
      auth(),
      queryFrame(configured.snapshot.hostEpoch, [missing]),
    );
    assert.deepEqual(
      response.payload.items.map(({ state, retryable, reissueRequired, error }) => ({
        state,
        retryable,
        reissueRequired,
        code: error.code,
      })),
      [{
        state: "not_accepted",
        retryable: true,
        reissueRequired: false,
        code: "COMMAND_NOT_ACCEPTED",
      }],
    );

    h.setNow(configured.window.acceptUntilMs + 1);
    response = await configured.plane.query(
      auth(),
      queryFrame(configured.snapshot.hostEpoch, [missing]),
    );
    assert.equal(response.payload.items[0].state, "not_accepted");
    assert.equal(response.payload.items[0].retryable, false);
    assert.equal(response.payload.items[0].reissueRequired, true);
    assert.equal(response.payload.items[0].error.code, "COMMAND_WINDOW_EXPIRED");

    const expiredExecute = commandFrame(
      "command-execute-kill-session",
      configured.snapshot.hostEpoch,
      configured.window.windowId,
    );
    const expiredExecuteResponse = await configured.plane.execute(auth(), expiredExecute);
    assert.equal(expiredExecuteResponse.error.code, "COMMAND_WINDOW_EXPIRED");
    assert.equal(fake.calls.resolve.length, 0);

    const replacementWindow = await configured.plane.issueDedupeWindow({
      acceptUntilMs: h.now() + 60_000,
      queryUntilMs: h.now() + 60_000 + commandPlane.RELAY_V2_COMMAND_DEDUPE_RETENTION_MS,
    });
    const replacement = commandFrame(
      "command-execute-kill-session",
      configured.snapshot.hostEpoch,
      replacementWindow.windowId,
    );
    replacement.commandId = "cmd-reissued-kill";
    replacement.requestId = "reissued-attempt";
    const replacementResponse = await configured.plane.execute(auth(), replacement);
    assert.equal(replacementResponse.payload.state, "succeeded");

    h.setNow(replacementResponse.payload.updatedAtMs
      + commandPlane.RELAY_V2_COMMAND_RESULT_RETENTION_MS
      + 1);
    await configured.plane.compact();
    response = await configured.plane.query(auth(), queryFrame(configured.snapshot.hostEpoch, [{
      commandId: replacement.commandId,
      dedupeWindowId: replacementWindow.windowId,
    }]));
    assert.equal(response.payload.items[0].state, "expired");
    assert.equal(response.payload.items[0].error.code, "COMMAND_RESULT_EXPIRED");
    assert.equal(response.payload.items[0].error.details.finalState, "succeeded");

    h.setNow(replacementWindow.queryUntilMs + 1);
    await configured.plane.compact();
    response = await configured.plane.query(auth(), queryFrame(configured.snapshot.hostEpoch, [{
      commandId: replacement.commandId,
      dedupeWindowId: replacementWindow.windowId,
    }]));
    assert.equal(response.payload.items[0].state, "unknown");
    assert.equal(response.payload.items[0].error.code, "COMMAND_STATUS_UNKNOWN");
    assert.equal(response.payload.items[0].error.commandDisposition, "in_doubt");
    assertCodecFrame(response);
  } finally {
    h.cleanup();
  }
});
