import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const authorityModule = await import(
  "../dist/relay/v2/canonicalCreateTargetObservationAuthority.js"
);
const admissionModule = await import(
  "../dist/relay/v2/canonicalCreateTargetAdmissionAdapter.js"
);
const targetAuthorityModule = await import(
  "../dist/relay/v2/canonicalCommandTargetAuthorityAdapter.js"
);
const queryTransportModule = await import(
  "../dist/relay/v2/canonicalTwRpcQueryTransportAdapter.js"
);
const observationModule = await import("../dist/createTargetObservationV1.js");
const rpcV2Module = await import("../dist/rpcV2.js");

const {
  RelayV2CanonicalCreateTargetObservationAuthority,
  RelayV2CanonicalCreateTargetObservationError,
} = authorityModule;
const {
  issueRelayV2CanonicalCreateTargetExecutionPairV1,
  captureRelayV2CanonicalCreateTargetH1FactoryV1,
} = admissionModule;
const {
  buildCreateTargetObservationV1,
  executeCreateTargetAdmissionV1,
  parseCreateTargetObservationV1Request,
  parseCreateTargetObservationV1RequestJson,
  parseCreateTargetObservationV1Response,
} = observationModule;
const { parseRpcV2CreateResolvedWorktreeRequest } = rpcV2Module;

const HOST_EPOCH = "host-epoch-one";
const SCOPE_ID = "scope-one";
const TARGET_ID = "canonical-local-rpc";
const BASE_REF_OID = `0123456789abcdef0123456789abcdef0123456${"7"}`;

function commandRequest(operation, args) {
  return {
    fingerprintSchemaVersion: 1,
    commandId: `cmd-${operation}`,
    requestFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256-rfc8785",
      digest: "a".repeat(64),
    },
    authority: "tw_rpc",
    operation,
    principalId: "principal-one",
    hostId: "host-one",
    hostEpoch: HOST_EPOCH,
    scopeId: SCOPE_ID,
    sessionId: null,
    arguments: args,
  };
}

function createInput(operation, args, targetId = TARGET_ID) {
  return {
    schemaVersion: 1,
    request: commandRequest(operation, args),
    resourceTarget: {
      authorization: "evidence_only",
      hostEpoch: HOST_EPOCH,
      discoveryGeneration: "17",
      scopeId: SCOPE_ID,
      processTarget: { kind: "local", targetId },
      capabilities: [],
    },
  };
}

function correlationFor(input, reservationId = "reservation-one") {
  return {
    schemaVersion: 1,
    reservationId,
    hostEpoch: input.request.hostEpoch,
    principalId: input.request.principalId,
    hostId: input.request.hostId,
    commandId: input.request.commandId,
    requestFingerprint: structuredClone(input.request.requestFingerprint),
  };
}

function streamOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeHandle({ stdout = [], stderr = [], exitCode = 0, hang = false, onKill } = {}) {
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  const handle = {
    stdout: typeof stdout === "function" ? stdout() : streamOf(stdout),
    stderr: streamOf(stderr),
    exited,
    kill(signal) {
      assert.equal(signal, "SIGKILL");
      onKill?.();
      resolveExited({ exitCode: null, signal: "SIGKILL" });
    },
  };
  if (!hang) queueMicrotask(() => resolveExited({ exitCode, signal: null }));
  return handle;
}

function fakeRunner(respond) {
  const calls = { spawns: [], kills: 0 };
  const runner = {
    spawn(request) {
      calls.spawns.push(request);
      const behavior = respond(request);
      return fakeHandle({ ...behavior, onKill: () => { calls.kills += 1; } });
    },
  };
  return { calls, runner };
}

function closureOwner(targetId = TARGET_ID) {
  return new queryTransportModule.RelayV2CanonicalTwRpcQueryTransportAdapter({
    targets: [{ kind: "local", targetId, executable: "/usr/local/bin/tw" }],
    runner: { spawn: () => { throw new Error("no spawn in closure owner"); } },
  });
}

function realClosure(runner, options = {}) {
  return { runner, options };
}

function authorityOf(fakeClosure) {
  return new RelayV2CanonicalCreateTargetObservationAuthority({
    targets: closureOwner(fakeClosure.options.targetId ?? TARGET_ID),
    runner: fakeClosure.runner,
    ...(fakeClosure.options.timeoutMs !== undefined
      ? { timeoutMs: fakeClosure.options.timeoutMs } : {}),
    ...(fakeClosure.options.now !== undefined ? { now: fakeClosure.options.now } : {}),
  });
}

function fixtureGitQuery(repoDir, args) {
  if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true";
  if (args[0] === "rev-parse" && args[1] === "--git-dir") {
    return `${join(repoDir, ".git")}\n${join(repoDir, ".git")}`;
  }
  if (args[0] === "symbolic-ref") return "";
  if (args[0] === "ls-remote") return `${BASE_REF_OID}\trefs/heads/${args[args.length - 1]}`;
  return "";
}

function fixtureDeps(overrides = {}) {
  return {
    loadConfig: () => ({
      projects: { demo: { name: "demo", path: "/repo/demo", branch: "main" } },
      worktreeBase: "/worktrees",
      hosts: [],
    }),
    existsSync: (path) => path === "/repo/demo" || path === "/repo" || path === "/repo/demo-alias",
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: (path) => path,
    gitQuery: fixtureGitQuery,
    ...overrides,
  };
}

function observationLine(input, deps = fixtureDeps()) {
  const response = buildCreateTargetObservationV1(
    {
      schemaVersion: 1,
      operation: input.request.operation,
      arguments: input.request.arguments,
    },
    deps,
  );
  return `${JSON.stringify(response)}\n`;
}

function probeCorrelation() {
  return {
    schemaVersion: 1,
    reservationId: "probe",
    hostEpoch: HOST_EPOCH,
    principalId: "principal-one",
    hostId: "host-one",
    commandId: "cmd-probe",
    requestFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256-rfc8785",
      digest: "b".repeat(64),
    },
  };
}

function assertObservationCode(code) {
  return (error) => error instanceof RelayV2CanonicalCreateTargetObservationError
    && error.code === code;
}

test("create_worktree resolve binds evidence and the synchronous fence consumes exactly once", async () => {
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_worktree", JSON.parse(request.argv[2]).arguments),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner, {
    timeoutMs: 5_000,
    now: () => 1_785_000_000_000,
  }));
  const input = createInput("create_worktree", {
    project: "demo", name: "fix", branch: "main", aiCommand: "codex",
  });
  const evidence = await authority.resolveCreateTarget(input);
  assert.equal(ports.calls.spawns.length, 1);
  assert.deepEqual([...ports.calls.spawns[0].argv].slice(0, 2), [
    "create-target-observation-v1", "--request-json",
  ]);
  assert.equal(ports.calls.spawns[0].shell, false);
  assert.equal(ports.calls.spawns[0].stdin, "ignore");

  assert.equal(evidence.schemaVersion, 1);
  assert.match(evidence.authorityToken, /^twobs1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(evidence.operation, "create_worktree");
  assert.match(evidence.catalogRevision, /^twcat1\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(evidence.arguments, input.request.arguments);
  // The execution must satisfy the frozen resolved-create-worktree parser.
  const resolved = parseRpcV2CreateResolvedWorktreeRequest({
    arguments: evidence.arguments,
    execution: evidence.execution,
    reservationCorrelation: probeCorrelation(),
  });
  assert.deepEqual(resolved.execution, evidence.execution);
  assert.equal(evidence.publicDisplayName, evidence.execution.publicDisplayName);
  assert.deepEqual(evidence.prospectiveSession, {
    kind: "worktree",
    displayName: evidence.execution.publicDisplayName,
    state: "running",
    project: evidence.execution.effectiveProject,
    label: null,
    cwd: evidence.execution.worktreePath,
    attached: false,
    windowCount: 1,
    createdAtMs: 1_785_000_000_000,
    activityAtMs: 1_785_000_000_000,
  });

  authority.fenceCreateTargetForAdmission(input, evidence);
  assert.throws(
    () => authority.fenceCreateTargetForAdmission(input, evidence),
    assertObservationCode("OBSERVATION_CONSUMED"),
  );
});

test("create_terminal resolve derives canonical cwd evidence", async () => {
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner, { now: () => 7 }));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const evidence = await authority.resolveCreateTarget(input);
  assert.equal(evidence.operation, "create_terminal");
  assert.deepEqual(evidence.execution, { canonicalCwd: "/repo/demo", publicDisplayName: "demo" });
  assert.equal(evidence.prospectiveSession.kind, "terminal");
  assert.equal(evidence.prospectiveSession.project, null);
  assert.equal(evidence.prospectiveSession.label, "demo");
  assert.equal(evidence.prospectiveSession.cwd, "/repo/demo");
  authority.fenceCreateTargetForAdmission(input, evidence);
});

test("malformed response and echo mismatch reject closed with nothing pending", async () => {
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });

  const malformed = fakeRunner(() => ({
    stdout: [new TextEncoder().encode("{\"schemaVersion\":1}\n")],
  }));
  const malformedAuthority = authorityOf(realClosure(malformed.runner));
  await assert.rejects(
    malformedAuthority.resolveCreateTarget(input),
    assertObservationCode("INVALID_REQUEST"),
  );

  const mismatched = fakeRunner(() => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", { cwd: "/repo/demo", label: "other" }),
    ))],
  }));
  const mismatchedAuthority = authorityOf(realClosure(mismatched.runner));
  await assert.rejects(
    mismatchedAuthority.resolveCreateTarget(input),
    assertObservationCode("INVALID_REQUEST"),
  );
  assert.throws(
    () => mismatchedAuthority.fenceCreateTargetForAdmission(input, {
      schemaVersion: 1,
      authorityToken: "twobs1.never-issued",
      operation: "create_terminal",
      arguments: input.request.arguments,
      execution: { canonicalCwd: "/repo/demo", publicDisplayName: "demo" },
      catalogRevision: "twcat1.never-issued",
      publicDisplayName: "demo",
      prospectiveSession: {},
    }),
    assertObservationCode("OBSERVATION_CONSUMED"),
  );
});

test("a fenced observation admits exactly once through the admitted store", async () => {
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const evidence = await authority.resolveCreateTarget(input);
  authority.fenceCreateTargetForAdmission(input, evidence);
  // The admitted row is consumed by the exact canonical evidence identity the
  // executor presents at mutation time (canonical cwd + derived label).
  const binding = {
    operation: "create_terminal",
    arguments: { cwd: "/repo/demo", label: "demo" },
    execution: { canonicalCwd: "/repo/demo", publicDisplayName: "demo" },
    reservationCorrelation: correlationFor(input),
  };
  assert.equal(authority.consumeAdmittedCatalogRevision(binding), evidence.catalogRevision);
  assert.throws(
    () => authority.consumeAdmittedCatalogRevision(binding),
    assertObservationCode("OBSERVATION_CONSUMED"),
  );
});

test("catalog drift after resolve revokes the earlier pending observation", async () => {
  let drifted = false;
  const deps = () => fixtureDeps({
    realpathSync: (path) => (drifted && path === "/repo/demo" ? "/repo/demo-alias" : path),
  });
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
      deps(),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const evidence = await authority.resolveCreateTarget(input);
  // The target catalog drifts after the observation; a later resolve of the
  // same target observes the new revision and revokes the earlier token, so
  // its fence finds nothing left to consume.
  drifted = true;
  const second = await authority.resolveCreateTarget(input);
  assert.notEqual(second.catalogRevision, evidence.catalogRevision);
  assert.throws(
    () => authority.fenceCreateTargetForAdmission(input, evidence),
    assertObservationCode("OBSERVATION_CONSUMED"),
  );
  authority.fenceCreateTargetForAdmission(input, second);
});

test("observe→admit base-ref OID or git identity drift is stale with zero mutation calls", () => {
  const request = {
    schemaVersion: 1,
    operation: "create_worktree",
    arguments: { project: "demo", name: "fix", branch: "main", aiCommand: "codex" },
  };
  const observed = buildCreateTargetObservationV1(request, fixtureDeps());
  assert.equal(observed.observation.catalog.baseRefOid, BASE_REF_OID);
  assert.match(observed.observation.catalog.canonicalGitIdentity, /^[A-Za-z0-9_-]{43}$/);
  const admitRequest = () => ({
    schemaVersion: 1,
    mode: "admit",
    operation: "create_worktree",
    arguments: structuredClone(request.arguments),
    observation: {
      catalogRevision: observed.catalogRevision,
      execution: structuredClone(observed.observation.execution),
    },
    reservationCorrelation: probeCorrelation(),
  });
  const driftRows = [
    ["base-ref OID moved", fixtureDeps({
      gitQuery: (repoDir, args) => (args[0] === "ls-remote"
        ? `${"2".repeat(40)}\trefs/heads/${args[args.length - 1]}`
        : fixtureGitQuery(repoDir, args)),
    })],
    ["git identity moved", fixtureDeps({
      realpathSync: (path) => (path === "/repo/demo/.git" ? "/repo/demo/.git-moved" : path),
    })],
  ];
  for (const [name, deps] of driftRows) {
    const response = executeCreateTargetAdmissionV1(admitRequest(), {
      ...deps,
      runResolvedWorktree: () => {
        throw new Error(`mutation must not run after ${name}`);
      },
    });
    assert.equal(response.state, "stale", name);
    assert.equal(response.sideEffect, "not_applied", name);
    assert.equal(response.error.code, "OBSERVATION_STALE", name);
  }
  // Control: the undrifted catalog admits and executes exactly once.
  const mutations = [];
  const executed = executeCreateTargetAdmissionV1(admitRequest(), {
    ...fixtureDeps(),
    runResolvedWorktree: (mutation) => {
      mutations.push(mutation);
      return { state: "succeeded" };
    },
  });
  assert.equal(executed.state, "executed");
  assert.equal(mutations.length, 1);
});

test("issuance rejects accessor-mixing options before any bundle, lookup, or spawn", () => {
  // Enumerable getters, accessors, Proxies, and extra keys that could swap
  // the owner/runner/inner between reads are rejected synchronously, with
  // zero bundle issue, zero target lookup, zero spawn, zero inner execute.
  const counters = { issue: 0, lookup: 0, spawn: 0, execute: 0 };
  const makeOwner = () => {
    const owner = closureOwner();
    const issue = owner.issueCreateTargetAuthorityBundleV1;
    owner.issueCreateTargetAuthorityBundleV1 = (...args) => {
      counters.issue += 1;
      return Reflect.apply(issue, owner, args);
    };
    const lookup = owner.structuredProcessInvocation;
    owner.structuredProcessInvocation = (...args) => {
      counters.lookup += 1;
      return Reflect.apply(lookup, owner, args);
    };
    return owner;
  };
  const goodRunner = { spawn() { counters.spawn += 1; throw new Error("unexpected spawn"); } };
  const swappedRunner = { spawn() { counters.spawn += 1; throw new Error("swapped runner"); } };
  const goodInner = { async execute() { counters.execute += 1; throw new Error("unexpected"); } };
  const rows = [
    ["getter-swapped runner", () => {
      let reads = 0;
      return {
        owner: makeOwner(),
        get runner() { reads += 1; return reads === 1 ? goodRunner : swappedRunner; },
        inner: goodInner,
      };
    }],
    ["accessor spawn", () => ({
      owner: makeOwner(),
      runner: { get spawn() { return () => { throw new Error("accessor spawn"); }; } },
      inner: goodInner,
    })],
    ["proxy runner", () => ({
      owner: makeOwner(),
      runner: new Proxy(goodRunner, {}),
      inner: goodInner,
    })],
    ["proxy options", () => new Proxy(
      { owner: makeOwner(), runner: goodRunner, inner: goodInner },
      {},
    )],
    ["extra symbol key", () => Object.assign(
      { owner: makeOwner(), runner: goodRunner, inner: goodInner },
      { [Symbol("extra")]: 1 },
    )],
    ["missing inner", () => ({ owner: makeOwner(), runner: goodRunner })],
  ];
  for (const [name, make] of rows) {
    assert.throws(
      () => issueRelayV2CanonicalCreateTargetExecutionPairV1(make()),
      /malformed|invalid/,
      name,
    );
  }
  assert.deepEqual(counters, { issue: 0, lookup: 0, spawn: 0, execute: 0 });
});

test("foreign inputs reject proxies, extra symbol/non-enumerable keys, and thenables before any read", async () => {
  const makeAuthority = () => authorityOf(realClosure(fakeRunner(() => ({})).runner));
  const rows = [
    ["proxy input", () => new Proxy(createInput("create_terminal", { cwd: "/repo/demo" }), {})],
    ["symbol-keyed input", () => Object.assign(
      createInput("create_terminal", { cwd: "/repo/demo" }),
      { [Symbol("extra")]: 1 },
    )],
    ["non-enumerable extra key", () => {
      const value = createInput("create_terminal", { cwd: "/repo/demo" });
      Object.defineProperty(value, "extra", { value: 1 });
      return value;
    }],
    ["thenable input", () => Object.assign(
      createInput("create_terminal", { cwd: "/repo/demo" }),
      { then: () => {} },
    )],
  ];
  for (const [name, make] of rows) {
    await assert.rejects(
      makeAuthority().resolveCreateTarget(make()),
      assertObservationCode("INVALID_REQUEST"),
      name,
    );
  }
  // Thenable detection never reads a foreign `.then` through a Proxy trap.
  let trapReads = 0;
  const trapped = new Proxy(createInput("create_terminal", { cwd: "/repo/demo" }), {
    get(target, key, receiver) {
      if (key === "then") trapReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(
    makeAuthority().resolveCreateTarget(trapped),
    assertObservationCode("INVALID_REQUEST"),
  );
  assert.equal(trapReads, 0);

  // The evidence side of the fence follows the same boundary discipline.
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const evidence = await authority.resolveCreateTarget(input);
  assert.throws(
    () => authority.fenceCreateTargetForAdmission(input, new Proxy(evidence, {})),
    assertObservationCode("INVALID_REQUEST"),
  );
  assert.throws(
    () => authority.fenceCreateTargetForAdmission(
      input,
      Object.assign(structuredClone(evidence), { then: () => {} }),
    ),
    assertObservationCode("INVALID_REQUEST"),
  );
  // The untouched evidence remains fenceable exactly once.
  authority.fenceCreateTargetForAdmission(input, evidence);
});

test("concurrent evidences over the same execution are independent one-shot admitted rows", async () => {
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const first = await authority.resolveCreateTarget(input);
  const second = await authority.resolveCreateTarget(input);
  assert.notEqual(first.authorityToken, second.authorityToken);
  authority.fenceCreateTargetForAdmission(input, first);
  authority.fenceCreateTargetForAdmission(input, second);
  const bindingFor = (source) => ({
    operation: "create_terminal",
    arguments: { cwd: "/repo/demo", label: "demo" },
    execution: { canonicalCwd: "/repo/demo", publicDisplayName: "demo" },
    reservationCorrelation: correlationFor(source),
  });
  // Both fenced evidences admit independently; neither overwrote the other.
  assert.equal(authority.consumeAdmittedCatalogRevision(bindingFor(input)), first.catalogRevision);
  assert.equal(authority.consumeAdmittedCatalogRevision(bindingFor(input)), second.catalogRevision);
  assert.throws(
    () => authority.consumeAdmittedCatalogRevision(bindingFor(input)),
    assertObservationCode("OBSERVATION_CONSUMED"),
  );

  // A different command over the identical execution binds its own row; a
  // foreign command fingerprint never consumes another command's row.
  const otherInput = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  otherInput.request.commandId = "cmd-other";
  const otherEvidence = await authority.resolveCreateTarget(otherInput);
  authority.fenceCreateTargetForAdmission(otherInput, otherEvidence);
  assert.throws(
    () => authority.consumeAdmittedCatalogRevision(bindingFor(input)),
    assertObservationCode("OBSERVATION_CONSUMED"),
  );
  assert.equal(
    authority.consumeAdmittedCatalogRevision(bindingFor(otherInput)),
    otherEvidence.catalogRevision,
  );
});

test("process kill runs with the original handle as receiver", async () => {
  const receivers = [];
  const runner = {
    spawn() {
      let resolveExited;
      const exited = new Promise((resolve) => { resolveExited = resolve; });
      const handle = {
        stdout: streamOf([]),
        stderr: streamOf([]),
        exited,
        kill() {
          receivers.push(this === handle ? "original" : "other");
          resolveExited({ exitCode: null, signal: "SIGKILL" });
        },
      };
      return handle;
    },
  };
  const authority = authorityOf(realClosure(runner, { timeoutMs: 5 }));
  await assert.rejects(
    authority.resolveCreateTarget(createInput("create_terminal", { cwd: "/repo/demo" })),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );
  assert.deepEqual(receivers, ["original"]);
});

test("stream failure still awaits the full kill+drain barrier before rejecting", async () => {
  const events = [];
  const failingStdout = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([0x41]);
      events.push("stdout-failed");
      throw new Error("stdout broke");
    },
  };
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  exited.then(() => events.push("exited-settled"));
  const runner = {
    spawn() {
      return {
        stdout: failingStdout,
        stderr: streamOf([new Uint8Array([0x42])]),
        exited,
        kill() {
          events.push("kill");
          queueMicrotask(() => resolveExited({ exitCode: null, signal: "SIGKILL" }));
        },
      };
    },
  };
  const authority = authorityOf(realClosure(runner, { timeoutMs: 5_000 }));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  await assert.rejects(
    authority.resolveCreateTarget(input),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );
  // kill fired and the exit barrier settled before the rejection propagated.
  assert.ok(events.includes("kill"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(events.includes("exited-settled"));
});

test("request JSON boundary rejects duplicate keys, excess depth, and oversized payloads", () => {
  assert.throws(
    () => parseCreateTargetObservationV1RequestJson(
      "{\"schemaVersion\":1,\"schemaVersion\":1,\"operation\":\"create_terminal\",\"arguments\":{\"cwd\":\"/repo/demo\"}}",
    ),
  );
  let deep = "{\"a\":1}";
  for (let i = 0; i < 40; i += 1) deep = `{"a":${deep}}`;
  assert.throws(() => parseCreateTargetObservationV1RequestJson(deep));
  assert.throws(
    () => parseCreateTargetObservationV1RequestJson(" ".repeat(70_000)),
  );
  const valid = parseCreateTargetObservationV1RequestJson(JSON.stringify({
    schemaVersion: 1,
    operation: "create_terminal",
    arguments: { cwd: "/repo/demo" },
  }));
  assert.equal(valid.operation, "create_terminal");
});

test("non-git directories and unresolvable git evidence fail closed during observation", () => {
  assert.throws(
    () => buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: { project: "demo", name: "fix", aiCommand: "codex" },
    }, fixtureDeps({ gitQuery: () => "" })),
    /not a git repository/,
  );
  assert.throws(
    () => buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: { project: "demo", name: "fix", aiCommand: "codex" },
    }, fixtureDeps({
      gitQuery: (_dir, args) => (args[0] === "rev-parse" ? "true" : ""),
    })),
    /git identity is not resolvable/,
  );
  assert.throws(
    () => buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: { project: "demo", name: "fix", aiCommand: "codex" },
    }, fixtureDeps({
      gitQuery: (repoDir, args) => {
        if (args[0] === "rev-parse") return fixtureGitQuery(repoDir, args);
        return "";
      },
    })),
    /base branch is not resolvable/,
  );
});

test("target unavailable, nonzero exit, and timeout all fail closed", async () => {
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });

  const unknownTarget = authorityOf(realClosure(fakeRunner(() => ({})).runner));
  await assert.rejects(
    unknownTarget.resolveCreateTarget(createInput("create_terminal", { cwd: "/repo/demo" }, "retired")),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );

  const failing = fakeRunner(() => ({ exitCode: 1, stdout: [] }));
  const failingAuthority = authorityOf(realClosure(failing.runner));
  await assert.rejects(
    failingAuthority.resolveCreateTarget(input),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );

  const hanging = fakeRunner(() => ({ hang: true, stdout: [] }));
  const hangingAuthority = authorityOf(realClosure(hanging.runner, { timeoutMs: 5 }));
  await assert.rejects(
    hangingAuthority.resolveCreateTarget(input),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );
  assert.equal(hanging.calls.kills, 1);
});

test("overflowing stdout is killed, drained, and never parsed", async () => {
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const overflowing = fakeRunner(() => ({ stdout: [new Uint8Array(70_000).fill(0x41)] }));
  const authority = authorityOf(realClosure(overflowing.runner));
  await assert.rejects(
    authority.resolveCreateTarget(input),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );
  assert.equal(overflowing.calls.kills, 1);
});

test("contract fixtures conform to the strict parsers in both directions", () => {
  const root = new URL("../contracts/tw-rpc/create-target-observation-v1/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  const cases = JSON.parse(readFileSync(new URL("cases.json", root), "utf8"));
  assert.equal(manifest.contract, "tmux-worktree-tw-rpc-create-target-observation");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entrypoint, "create-target-observation-v1");
  assert.equal(manifest.capabilityAdvertisementAllowed, false);
  assert.equal(manifest.extendsFrozenTwRpcV2, false);
  assert.deepEqual(manifest.modes, ["observe", "admit"]);
  // observe is side-effect free; admit runs the canonical mutation only
  // after an exact target-side revalidation. No retry, no fallback, no
  // direct tmux/git mutation, no direct SSH parsing.
  assert.equal(manifest.authority.observeSideEffectsAllowed, false);
  assert.equal(
    manifest.authority.admitMutation,
    "canonical-rpc-v2-resolved-create-after-exact-revalidation",
  );
  assert.equal(manifest.authority.retryAllowed, false);
  assert.equal(manifest.authority.fallbackAllowed, false);
  assert.equal(manifest.authority.directTmuxOrGitMutationAllowed, false);
  assert.equal(manifest.authority.directSshParsingAllowed, false);
  assert.equal(manifest.fixture, "cases.json");
  assert.deepEqual(Object.keys(cases).sort(), [
    "createTerminal", "createWorktree", "malformedRequest",
  ]);

  for (const name of ["createWorktree", "createTerminal"]) {
    const fixture = cases[name];
    const parsedRequest = parseCreateTargetObservationV1Request(fixture.request);
    const parsedResponse = parseCreateTargetObservationV1Response(fixture.response);
    assert.deepEqual(JSON.parse(JSON.stringify(parsedRequest)), fixture.request, name);
    assert.deepEqual(JSON.parse(JSON.stringify(parsedResponse)), fixture.response, name);
  }
  // The worktree observation carries the closed-set git catalog evidence.
  assert.deepEqual(Object.keys(cases.createWorktree.response.observation).sort(), [
    "arguments", "catalog", "execution", "operation",
  ]);
  assert.throws(
    () => parseCreateTargetObservationV1Request(cases.malformedRequest.request),
    /invalid create-target-observation/,
  );

  // The worktree fixture execution must satisfy the frozen resolved-create parser.
  const resolved = parseRpcV2CreateResolvedWorktreeRequest({
    arguments: cases.createWorktree.response.observation.arguments,
    execution: cases.createWorktree.response.observation.execution,
    reservationCorrelation: probeCorrelation(),
  });
  assert.deepEqual(resolved.execution, cases.createWorktree.response.observation.execution);
});

test("target-side builder observes a closed-set execution with a stable revision", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-obs-v1-"));
  try {
    const repo = join(root, "demo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const base = join(root, "worktrees");
    const deps = {
      loadConfig: () => ({
        projects: { demo: { name: "demo", path: repo, branch: "main" } },
        worktreeBase: base,
        hosts: [],
      }),
      existsSync,
      statSync,
      realpathSync,
      gitQuery: fixtureGitQuery,
    };
    const request = {
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: { project: "demo", name: "fix", aiCommand: "codex" },
    };
    const first = buildCreateTargetObservationV1(request, deps);
    const second = buildCreateTargetObservationV1(request, deps);
    assert.equal(first.catalogRevision, second.catalogRevision);
    assert.match(first.catalogRevision, /^twcat1\.[A-Za-z0-9_-]{43}$/);
    // The revision covers the closed-set git catalog evidence.
    assert.equal(first.observation.catalog.baseRefOid, BASE_REF_OID);
    assert.match(first.observation.catalog.canonicalGitIdentity, /^[A-Za-z0-9_-]{43}$/);
    const moved = buildCreateTargetObservationV1(request, {
      ...deps,
      gitQuery: (repoDir, args) => (args[0] === "ls-remote"
        ? `${"3".repeat(40)}\trefs/heads/${args[args.length - 1]}`
        : fixtureGitQuery(repoDir, args)),
    });
    assert.notEqual(moved.catalogRevision, first.catalogRevision);

    const canonicalRepo = realpathSync(repo);
    const execution = first.observation.execution;
    assert.deepEqual(Object.keys(execution).sort(), [
      "canonicalRepoPath", "effectiveBaseBranch", "effectiveProject", "publicDisplayName",
      "rawSessionName", "worktreeBase", "worktreeBranch", "worktreePath",
    ]);
    assert.equal(execution.canonicalRepoPath, canonicalRepo);
    assert.equal(execution.effectiveProject, "demo");
    assert.equal(execution.effectiveBaseBranch, "main");
    assert.equal(execution.rawSessionName, "demo-fix");
    assert.equal(execution.publicDisplayName, "fix");
    assert.equal(execution.worktreeBase, base);
    assert.equal(execution.worktreePath, join(base, "demo", execution.worktreeBranch));
    const resolved = parseRpcV2CreateResolvedWorktreeRequest({
      arguments: first.observation.arguments,
      execution,
      reservationCorrelation: probeCorrelation(),
    });
    assert.deepEqual(resolved.execution, execution);

    // Missing directories and unknown projects fail closed.
    assert.throws(() => buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: { path: join(root, "missing"), aiCommand: "codex" },
    }, deps));
    assert.throws(() => buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: "create_worktree",
      arguments: { project: "unknown", aiCommand: "codex" },
    }, deps));

    const terminal = buildCreateTargetObservationV1({
      schemaVersion: 1,
      operation: "create_terminal",
      arguments: { cwd: repo },
    }, deps);
    assert.deepEqual(terminal.observation.execution, {
      canonicalCwd: canonicalRepo,
      publicDisplayName: "demo",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A/B execution pairs over identical content expose no components to cross", () => {
  // Two real pairs issued over identical owner/target content are distinct
  // fieldless tickets; neither yields a wrapper, adapter, or record, so a
  // cross-pair hybrid is not expressible at the API layer.
  const runnerA = fakeRunner(() => ({})).runner;
  const runnerB = fakeRunner(() => ({})).runner;
  const options = (runner) => ({
    owner: closureOwner(),
    runner,
    inner: { async execute() { throw new Error("unexpected delegation"); } },
  });
  const pairA = issueRelayV2CanonicalCreateTargetExecutionPairV1(options(runnerA));
  const pairB = issueRelayV2CanonicalCreateTargetExecutionPairV1(options(runnerB));
  assert.notEqual(pairA, pairB);
  for (const pair of [pairA, pairB]) {
    assert.equal(Object.getPrototypeOf(pair), null);
    assert.deepEqual(Reflect.ownKeys(pair), []);
  }
  // Each pair captures exactly once; the other pair's ticket never opens
  // anything twice, and a structurally cloned ticket is foreign.
  const factoryA = captureRelayV2CanonicalCreateTargetH1FactoryV1(pairA);
  captureRelayV2CanonicalCreateTargetH1FactoryV1(pairB);
  assert.throws(() => captureRelayV2CanonicalCreateTargetH1FactoryV1(pairA), /already captured/);
  assert.throws(() => captureRelayV2CanonicalCreateTargetH1FactoryV1(pairB), /already captured/);

  // The captured lexical factory itself fires exactly once: an invalid input
  // is rejected, and the factory is spent afterwards.
  assert.throws(() => factoryA({}), /malformed|invalid/);
  assert.throws(() => factoryA({}), /already consumed/);
});

test("bounded snapshot rejects undefined values, excess depth, and oversized strings", async () => {
  const authority = authorityOf(realClosure(fakeRunner(() => ({})).runner));
  const rows = [
    ["explicit undefined value", () => {
      const value = createInput("create_terminal", { cwd: "/repo/demo" });
      value.request.arguments = { cwd: "/repo/demo", label: undefined };
      return value;
    }],
    ["excess depth", () => {
      let deep = { leaf: "x" };
      for (let index = 0; index < 40; index += 1) deep = { next: deep };
      const value = createInput("create_terminal", { cwd: "/repo/demo" });
      value.request.arguments = { cwd: "/repo/demo", extra: deep };
      return value;
    }],
    ["oversized string bytes", () => {
      const value = createInput("create_terminal", { cwd: "/repo/demo" });
      value.request.arguments = { cwd: "/repo/demo", extra: "x".repeat(1_200_000) };
      return value;
    }],
  ];
  for (const [name, make] of rows) {
    await assert.rejects(
      authority.resolveCreateTarget(make()),
      assertObservationCode("INVALID_REQUEST"),
      name,
    );
  }
});

test("an in-budget large primitive array passes the snapshot and completes resolve+fence", async () => {
  const ports = fakeRunner((request) => ({
    stdout: [new TextEncoder().encode(observationLine(
      createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
    ))],
  }));
  const authority = authorityOf(realClosure(ports.runner));
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  // Every array index counts one key and every element exactly one node: a
  // 900-element primitive array stays inside every budget and must not be
  // rejected by double-counting its elements.
  input.resourceTarget.capabilities = Array.from({ length: 900 }, (_, index) => `cap-${index}`);
  const evidence = await authority.resolveCreateTarget(input);
  assert.equal(evidence.operation, "create_terminal");
  authority.fenceCreateTargetForAdmission(input, evidence);
});

test("process exit records with extra own keys fail closed", async () => {
  const runner = {
    spawn() {
      return {
        stdout: streamOf([]),
        stderr: streamOf([]),
        exited: Promise.resolve({ exitCode: 0, signal: null, extra: 1 }),
        kill() {},
      };
    },
  };
  const authority = authorityOf(realClosure(runner));
  await assert.rejects(
    authority.resolveCreateTarget(createInput("create_terminal", { cwd: "/repo/demo" })),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );
});

test("stream async iterators are captured exactly once against the original receiver", async () => {
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });
  const calls = [];
  const stdout = {
    [Symbol.asyncIterator]() {
      calls.push(this === stdout ? "original" : "other");
      const line = new TextEncoder().encode(observationLine(input));
      return (async function* () { yield line; })();
    },
  };
  const runner = {
    spawn() {
      return {
        stdout,
        stderr: streamOf([]),
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        kill() {},
      };
    },
  };
  const authority = authorityOf(realClosure(runner));
  const evidence = await authority.resolveCreateTarget(input);
  assert.equal(evidence.operation, "create_terminal");
  assert.deepEqual(calls, ["original"]);
});

test("create_terminal without label or with non-canonical cwd binds the canonical admitted row", async () => {
  const rows = [
    ["missing label derives the default label", { cwd: "/repo/demo" }, {}],
    ["non-canonical cwd is canonicalized target-side", { cwd: "/repo/../repo/demo" }, {
      existsSync: (path) => ["/repo/demo", "/repo", "/repo/../repo/demo"].includes(path),
      realpathSync: (path) => (path === "/repo/../repo/demo" ? "/repo/demo" : path),
    }],
  ];
  for (const [name, args, depsPatch] of rows) {
    const ports = fakeRunner((request) => ({
      stdout: [new TextEncoder().encode(observationLine(
        createInput("create_terminal", JSON.parse(request.argv[2]).arguments),
        fixtureDeps(depsPatch),
      ))],
    }));
    const authority = authorityOf(realClosure(ports.runner));
    const input = createInput("create_terminal", args);
    const evidence = await authority.resolveCreateTarget(input);
    authority.fenceCreateTargetForAdmission(input, evidence);
    // The admitted row shares the exact canonical argument form the executor
    // presents at mutation time: canonical cwd + derived default label.
    const canonical = { cwd: "/repo/demo", label: "demo" };
    const consumed = authority.consumeAdmittedCatalogRevision({
      operation: "create_terminal",
      arguments: canonical,
      execution: { canonicalCwd: "/repo/demo", publicDisplayName: "demo" },
      reservationCorrelation: correlationFor(input),
    });
    assert.equal(consumed, evidence.catalogRevision, name);
  }
});


test("boundary rejects Proxy-wrapped promises, Proxy-chain streams, and oversized budgets", async () => {
  const input = createInput("create_terminal", { cwd: "/repo/demo", label: "demo" });

  // A Proxy-wrapped Promise is not a genuine exited promise.
  const proxyPromiseRunner = {
    spawn() {
      return {
        stdout: streamOf([]),
        stderr: streamOf([]),
        exited: new Proxy(Promise.resolve({ exitCode: 0, signal: null }), {}),
        kill() {},
      };
    },
  };
  await assert.rejects(
    authorityOf(realClosure(proxyPromiseRunner)).resolveCreateTarget(input),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );

  // A Proxy anywhere on the stream prototype chain fails before any trap runs.
  let proxyTraps = 0;
  const trapCounting = {
    getOwnPropertyDescriptor(target, key) {
      proxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) {
      proxyTraps += 1;
      return Reflect.getPrototypeOf(target);
    },
  };
  const proxyChainRunner = {
    spawn() {
      const stdout = Object.create(new Proxy({
        [Symbol.asyncIterator]() {
          return (async function* () {
            yield new TextEncoder().encode(observationLine(input));
          })();
        },
      }, trapCounting));
      return {
        stdout,
        stderr: streamOf([]),
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        kill() {},
      };
    },
  };
  await assert.rejects(
    authorityOf(realClosure(proxyChainRunner)).resolveCreateTarget(input),
    assertObservationCode("TARGET_UNAVAILABLE"),
  );
  assert.equal(proxyTraps, 0);

  // Oversized budgets fail before any copy.
  const budgetAuthority = authorityOf(realClosure(fakeRunner(() => ({})).runner));
  const budgetRows = [
    ["oversized primitive array", () => {
      const value = createInput("create_terminal", { cwd: "/repo/demo" });
      value.request.arguments = { cwd: "/repo/demo", extra: new Array(5_000).fill("x") };
      return value;
    }],
    ["oversized property-name bytes", () => {
      const value = createInput("create_terminal", { cwd: "/repo/demo" });
      value.request.arguments = { cwd: "/repo/demo", [`k${"x".repeat(1_100_000)}`]: "v" };
      return value;
    }],
  ];
  for (const [name, make] of budgetRows) {
    await assert.rejects(
      budgetAuthority.resolveCreateTarget(make()),
      assertObservationCode("INVALID_REQUEST"),
      name,
    );
  }
});
