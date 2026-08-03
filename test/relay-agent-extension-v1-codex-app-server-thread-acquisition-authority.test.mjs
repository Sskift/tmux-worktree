import assert from "node:assert/strict";
import test from "node:test";

const acquisitionModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerThreadAcquisitionAuthority.js"
);

const THREAD_ID = "0198a5c4-3d12-7b21-a1d4-8f23cb697e10";
const CWD = "/private/tmp/tw-managed-worktree";
const ROLLOUT_PATH = "/private/tmp/codex/sessions/0198a5c4-3d12-7b21-a1d4-8f23cb697e10.jsonl";

function clone(value) {
  return structuredClone(value);
}

function thread(status = "notLoaded", overrides = {}) {
  return {
    cliVersion: "0.146.0",
    createdAt: 1_775_000_000,
    cwd: CWD,
    ephemeral: false,
    extra: null,
    historyMode: "full",
    canAcceptDirectInput: true,
    id: THREAD_ID,
    modelProvider: "openai",
    path: ROLLOUT_PATH,
    preview: "Implement the Relay extension",
    sessionId: THREAD_ID,
    source: "cli",
    status: { type: status },
    turns: [],
    updatedAt: 1_775_000_100,
    ...overrides,
  };
}

function listResponse(id = 2, data = [thread()], overrides = {}) {
  return {
    id,
    responseExtension: "bounded-list-envelope",
    result: {
      data,
      nextCursor: null,
      backwardsCursor: null,
      resultExtension: "bounded-list-result",
      ...overrides,
    },
  };
}

function resumeResponse(id = 3, overrides = {}) {
  return {
    id,
    responseExtension: "bounded-resume-envelope",
    result: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: CWD,
      model: "gpt-5.4",
      modelProvider: "openai",
      sandbox: { type: "dangerFullAccess" },
      thread: thread("idle"),
      resultExtension: "bounded-resume-result",
      ...overrides,
    },
  };
}

class FakeChannel {
  constructor(responses) {
    this.responses = responses;
  }

  calls = [];

  async exchange(request, signal) {
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);
    this.calls.push(clone(request));
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return clone(response);
  }
}

class FakeOwnershipHandoff {
  constructor(behavior = null) {
    this.behavior = behavior;
  }

  calls = [];

  async takeExclusiveOwnership(candidate, signal) {
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);
    this.calls.push(candidate);
    if (this.behavior !== null) return this.behavior(candidate);
    return Object.freeze({ ...candidate, disposition: "exclusive" });
  }
}

function schemaDigest(overrides = {}) {
  return Object.freeze({
    providerVersion: "0.146.0",
    ...acquisitionModule.CODEX_APP_SERVER_0_146_0_THREAD_SCHEMA_EVIDENCE,
    ...overrides,
  });
}

function harness(responses, handoff = new FakeOwnershipHandoff()) {
  const executableIdentity = Object.freeze(Object.create(null));
  const schemaEvidence = acquisitionModule
    .captureCodexAppServerThreadProtocolSchemaEvidence(
      executableIdentity,
      schemaDigest(),
    );
  const channel = new FakeChannel(responses);
  const authority = new acquisitionModule.CodexAppServerThreadAcquisitionAuthority(
    Object.freeze({
      executableIdentity,
      schemaEvidence,
      channel,
      ownershipHandoff: handoff,
    }),
  );
  return { authority, channel, handoff };
}

function selection(overrides = {}) {
  return Object.freeze({ threadId: THREAD_ID, cwd: CWD, ...overrides });
}

function acquisitionError(...codes) {
  return (error) => (
    error instanceof acquisitionModule.CodexAppServerThreadAcquisitionError
    && codes.includes(error.code)
  );
}

test("0.146.0 thread acquisition uniquely lists, externally hands off, and resumes on exact ids", async (t) => {
  await t.test("the exact schema-bound exchange resumes only after exclusive CLI handoff", async () => {
    const h = harness([listResponse(), resumeResponse()]);
    assert.equal(h.authority.state, "disabled");

    const acquired = await h.authority.acquire(selection());

    assert.deepEqual(h.channel.calls, [
      {
        id: 2,
        method: "thread/list",
        params: {
          archived: false,
          cursor: null,
          cwd: CWD,
          limit: 2,
          sourceKinds: ["cli"],
        },
      },
      {
        id: 3,
        method: "thread/resume",
        params: { cwd: CWD, threadId: THREAD_ID },
      },
    ]);
    assert.equal(h.handoff.calls.length, 1);
    assert.deepEqual(h.handoff.calls[0], {
      threadId: THREAD_ID,
      cwd: CWD,
      rolloutPath: ROLLOUT_PATH,
      source: "cli",
    });
    assert.equal(Object.isFrozen(h.handoff.calls[0]), true);
    assert.deepEqual(acquired, {
      providerVersion: "0.146.0",
      threadId: THREAD_ID,
      cwd: CWD,
      rolloutPath: ROLLOUT_PATH,
      source: "cli",
      subscription: "resumed",
    });
    assert.equal(Object.isFrozen(acquired), true);
    assert.equal(h.authority.state, "acquired");
    await assert.rejects(h.authority.acquire(selection()), acquisitionError("ALREADY_ACQUIRED"));
  });

  await t.test("schema evidence is exact and bound to the injected executable identity", () => {
    const executableIdentity = Object.freeze(Object.create(null));
    assert.throws(
      () => acquisitionModule.captureCodexAppServerThreadProtocolSchemaEvidence(
        executableIdentity,
        schemaDigest({ sha256: "0".repeat(64) }),
      ),
      acquisitionError("INVALID_SCHEMA_EVIDENCE"),
    );
    const evidence = acquisitionModule.captureCodexAppServerThreadProtocolSchemaEvidence(
      executableIdentity,
      schemaDigest(),
    );
    assert.throws(
      () => new acquisitionModule.CodexAppServerThreadAcquisitionAuthority(Object.freeze({
        executableIdentity: Object.freeze(Object.create(null)),
        schemaEvidence: evidence,
        channel: new FakeChannel([]),
        ownershipHandoff: new FakeOwnershipHandoff(),
      })),
      acquisitionError("INVALID_SCHEMA_EVIDENCE"),
    );
  });

  for (const scenario of [
    {
      name: "zero cwd matches",
      response: listResponse(2, []),
      code: "THREAD_NOT_UNIQUE",
    },
    {
      name: "two cwd matches",
      response: listResponse(2, [thread(), thread("notLoaded", {
        id: "0198a5c4-3d12-7b21-a1d4-8f23cb697e11",
        sessionId: "0198a5c4-3d12-7b21-a1d4-8f23cb697e11",
        path: "/private/tmp/codex/sessions/other.jsonl",
      })]),
      code: "THREAD_NOT_UNIQUE",
    },
    {
      name: "another durable thread id",
      response: listResponse(2, [thread("notLoaded", {
        id: "0198a5c4-3d12-7b21-a1d4-8f23cb697e11",
        sessionId: "0198a5c4-3d12-7b21-a1d4-8f23cb697e11",
      })]),
      code: "THREAD_BINDING_MISMATCH",
    },
    {
      name: "another structured cwd",
      response: listResponse(2, [thread("notLoaded", { cwd: "/private/tmp/other" })]),
      code: "THREAD_BINDING_MISMATCH",
    },
    {
      name: "non-CLI source",
      response: listResponse(2, [thread("notLoaded", { source: "vscode" })]),
      code: "THREAD_BINDING_MISMATCH",
    },
    {
      name: "loaded status is not external ownership evidence",
      response: listResponse(2, [thread("idle")]),
      code: "THREAD_BINDING_MISMATCH",
    },
    {
      name: "wrong JSON-RPC id",
      response: listResponse(20),
      code: "RESPONSE_MISMATCH",
    },
  ]) {
    await t.test(`list rejects ${scenario.name} before handoff or resume`, async () => {
      const h = harness([scenario.response, resumeResponse()]);
      await assert.rejects(h.authority.acquire(selection()), acquisitionError(scenario.code));
      assert.equal(h.authority.state, "sealed");
      assert.equal(h.authority.failure, scenario.code);
      assert.equal(h.channel.calls.length, 1);
      assert.equal(h.handoff.calls.length, 0);
    });
  }

  await t.test("handoff failure prevents resume and permanently seals", async () => {
    const handoff = new FakeOwnershipHandoff(() => {
      throw new Error("private CLI owner still live");
    });
    const h = harness([listResponse(), resumeResponse()], handoff);
    await assert.rejects(
      h.authority.acquire(selection()),
      acquisitionError("OWNERSHIP_HANDOFF_FAILED"),
    );
    assert.equal(h.channel.calls.length, 1);
    assert.equal(h.handoff.calls.length, 1);
    await assert.rejects(h.authority.acquire(selection()), acquisitionError("SEALED"));
  });

  for (const scenario of [
    {
      name: "wrong response id",
      response: resumeResponse(30),
      code: "RESPONSE_MISMATCH",
    },
    {
      name: "wrong resumed cwd",
      response: resumeResponse(3, { cwd: "/private/tmp/other" }),
      code: "THREAD_BINDING_MISMATCH",
    },
    {
      name: "wrong resumed rollout",
      response: resumeResponse(3, { thread: thread("idle", {
        path: "/private/tmp/codex/sessions/other.jsonl",
      }) }),
      code: "THREAD_BINDING_MISMATCH",
    },
    {
      name: "non-idle resumed status",
      response: resumeResponse(3, { thread: thread("active", {
        status: { type: "active", activeFlags: [] },
      }) }),
      code: "THREAD_BINDING_MISMATCH",
    },
  ]) {
    await t.test(`resume rejects ${scenario.name} after the explicit handoff`, async () => {
      const h = harness([listResponse(), scenario.response]);
      await assert.rejects(h.authority.acquire(selection()), acquisitionError(scenario.code));
      assert.equal(h.handoff.calls.length, 1);
      assert.equal(h.channel.calls.length, 2);
      assert.equal(h.authority.state, "sealed");
    });
  }
});
