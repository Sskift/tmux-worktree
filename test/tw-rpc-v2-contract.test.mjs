import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contractRoot = new URL("../contracts/tw-rpc/v2/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", contractRoot), "utf8"));
const cases = JSON.parse(readFileSync(new URL("cases.json", contractRoot), "utf8"));
const storageCases = JSON.parse(readFileSync(
  new URL("../contracts/storage/managed-incarnation-v1/cases.json", import.meta.url),
  "utf8",
));
const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const rpc = await import("../dist/rpc.js");
const rpcV2 = await import("../dist/rpcV2.js");
const session = await import("../dist/session.js");
const state = await import("../dist/state.js");

function withTempDir(prefix, operation) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function encodedCorrelation(correlation = cases.reservationCorrelation) {
  return Buffer.from(JSON.stringify(correlation), "utf8").toString("base64url");
}

function liveSession(overrides = {}) {
  const identity = cases.incarnation.baseIdentity;
  return {
    name: identity.rawName,
    rawName: identity.rawName,
    attached: false,
    windows: 1,
    created: Number(identity.sessionCreated),
    activity: Number(identity.sessionCreated) + 10,
    cwd: "/repo/demo",
    serverSocketPath: identity.serverSocketPath,
    serverPid: identity.serverPid,
    serverStarted: identity.serverStarted,
    sessionId: identity.sessionId,
    sessionCreated: identity.sessionCreated,
    birthMarker: identity.birthMarker,
    reservationCorrelation: encodedCorrelation(),
    lifecycleMarkersValid: true,
    ...overrides,
  };
}

function writeState(path, sessions) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
}

test("TW RPC v2 manifest and capability golden are explicit and parallel to frozen v1", () => {
  assert.deepEqual(manifest, {
    contract: "tmux-worktree-tw-rpc-v2",
    version: 2,
    status: "frozen",
    transport: "utf-8-json-line-on-stdout",
    entrypoint: "rpc-v2",
    commands: [
      "capabilities",
      "list",
      "create-worktree",
      "create-terminal",
      "kill-session",
    ],
    requestEncoding: "--request-json",
    fixture: "cases.json",
  });
  assert.deepEqual(rpcV2.buildRpcV2CapabilitiesResponse(), cases.capabilities.normalized);
  assert.equal(cases.capabilities.stdout, `${JSON.stringify(cases.capabilities.normalized)}\n`);

  const result = spawnSync(process.execPath, [cli, ...cases.capabilities.argv], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, cases.capabilities.stdout);

  const frozenV1 = spawnSync(process.execPath, [cli, "rpc", "capabilities"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(frozenV1.status, 0, frozenV1.stderr);
  assert.equal(JSON.parse(frozenV1.stdout).protocolVersion, 1);
  assert.throws(
    () => rpcV2.assertRpcV2Capabilities(JSON.parse(frozenV1.stdout)),
    /RPC v2 capabilities response is incompatible/,
  );
  for (const capability of cases.capabilities.normalized.capabilities) {
    const missing = structuredClone(cases.capabilities.normalized);
    missing.capabilities = missing.capabilities.filter((item) => item !== capability);
    assert.throws(
      () => rpcV2.assertRpcV2Capabilities(missing),
      (error) => error.message.includes(`capability unavailable: ${capability}`),
      capability,
    );
  }
});

test("TW RPC v2 fixtures freeze closed requests and response unions", () => {
  assert.deepEqual(
    rpcV2.parseRpcV2CreateWorktreeRequest(cases.wire.createWorktree.request),
    cases.wire.createWorktree.request,
  );
  assert.deepEqual(
    rpcV2.parseRpcV2CreateTerminalRequest(cases.wire.createTerminal.request),
    cases.wire.createTerminal.request,
  );
  assert.deepEqual(
    rpcV2.parseRpcV2KillSessionRequest(cases.wire.killSession.request),
    cases.wire.killSession.request,
  );
  assert.deepEqual(Object.keys(cases.wire.outcomes), [
    "createFailed", "createInDoubt", "killFailed", "killInDoubt",
  ]);
});

test("production execute mappers conform to frozen create and kill outcomes", () => {
  const terminalList = () => rpcV2.buildRpcV2ListResponse(
    { version: 1, sessions: [storageCases.extended] },
    [liveSession()],
  );
  const committedTerminal = () => ({
    session: "tw-term-a1b2c",
    cwd: "/repo/demo",
    lifecycleV2: {
      incarnation: cases.incarnation.base,
      reservationCorrelation: cases.reservationCorrelation,
    },
  });

  const worktreeIdentity = {
    ...cases.incarnation.baseIdentity,
    sessionId: "$9",
    rawName: "demo-fix",
    sessionCreated: "1783700012",
  };
  const worktreeExtension = state.buildManagedSessionLifecycleExtension(
    worktreeIdentity,
    cases.reservationCorrelation,
    null,
  );
  const worktreeManaged = state.withManagedSessionLifecycleExtension({
    name: "demo-fix",
    kind: "worktree",
    profile: "dashboard",
    project: "demo",
    repoPath: "/repo/demo",
    worktreePath: "/worktrees/demo/demo-fix-abc12",
    branch: "demo-fix-abc12",
    baseBranch: "main",
    createdAt: "2026-07-12T00:00:01.000Z",
  }, worktreeExtension);
  const worktreeList = () => rpcV2.buildRpcV2ListResponse(
    { version: 1, sessions: [worktreeManaged] },
    [liveSession({
      name: "demo-fix",
      rawName: "demo-fix",
      sessionId: "$9",
      sessionCreated: "1783700012",
      created: 1783700012,
      activity: 1783700020,
      cwd: "/worktrees/demo/demo-fix-abc12",
    })],
  );
  const committedWorktree = () => ({
    session: "demo-fix",
    workDir: "/worktrees/demo/demo-fix-abc12",
    worktree: null,
    lifecycleV2: worktreeExtension,
  });
  const worktreeDeps = {
    loadConfig: () => ({ projects: { demo: { path: "/repo/demo", branch: "main" } } }),
    createWorktree: committedWorktree,
  };

  let postCreateListCalls = 0;
  const mappings = [
    {
      id: "create-terminal-success",
      expected: cases.wire.createTerminal.normalized,
      execute: () => rpcV2.executeRpcV2CreateTerminal(cases.wire.createTerminal.request, {
        createTerminal: committedTerminal,
        currentList: terminalList,
      }),
    },
    {
      id: "create-worktree-success",
      expected: cases.wire.createWorktree.normalized,
      execute: () => rpcV2.executeRpcV2CreateWorktree(cases.wire.createWorktree.request, {
        ...worktreeDeps,
        currentList: worktreeList,
      }),
    },
    {
      id: "create-failed-before-commit",
      expected: cases.wire.outcomes.createFailed,
      execute: () => rpcV2.executeRpcV2CreateTerminal(cases.wire.createTerminal.request, {
        createTerminal: () => { throw new Error("canonical preflight rejected the request"); },
        currentList: () => {
          postCreateListCalls += 1;
          return terminalList();
        },
      }),
    },
    {
      id: "create-in-doubt-after-commit",
      expected: cases.wire.outcomes.createInDoubt,
      execute: () => rpcV2.executeRpcV2CreateWorktree(cases.wire.createWorktree.request, {
        ...worktreeDeps,
        currentList: () => { throw new Error("canonical create result is uncertain"); },
      }),
    },
    {
      id: "kill-failed",
      expected: cases.wire.outcomes.killFailed,
      execute: () => withTempDir("tw-rpc-v2-mapper-kill-failed-", (root) => {
        const path = join(root, "state.json");
        writeState(path, [storageCases.extended]);
        return rpcV2.executeRpcV2KillSession(cases.wire.killSession.request, {
          statePath: path,
          listTmuxSessionLifecycleEntries: () => [liveSession({ serverPid: "4201" })],
          killTmuxSessionByLifecycleIdentity: () => {
            throw new Error("mismatched incarnation must not reach kill");
          },
        });
      }),
    },
    {
      id: "kill-in-doubt",
      expected: cases.wire.outcomes.killInDoubt,
      execute: () => withTempDir("tw-rpc-v2-mapper-kill-uncertain-", (root) => {
        const path = join(root, "state.json");
        writeState(path, [storageCases.extended]);
        return rpcV2.executeRpcV2KillSession(cases.wire.killSession.request, {
          statePath: path,
          listTmuxSessionLifecycleEntries: () => [liveSession()],
          killTmuxSessionByLifecycleIdentity: () => "in_doubt",
        });
      }),
    },
  ];
  for (const mapping of mappings) {
    assert.deepEqual(mapping.execute(), mapping.expected, mapping.id);
  }
  assert.equal(postCreateListCalls, 0);

  const missingAfterCommit = rpcV2.executeRpcV2CreateTerminal(
    cases.wire.createTerminal.request,
    {
      createTerminal: committedTerminal,
      currentList: () => ({ protocolVersion: 2, sessions: [] }),
    },
  );
  assert.equal(missingAfterCommit.state, "in_doubt");
  assert.equal(Object.hasOwn(missingAfterCommit, "sideEffect"), false);
  assert.match(missingAfterCommit.error.message, /committed.*not visible/);

  let validationCreateCalls = 0;
  let validationListCalls = 0;
  const validationFailed = rpcV2.executeRpcV2CreateWorktree(
    cases.wire.createWorktree.request,
    {
      loadConfig: () => null,
      createWorktree: () => { validationCreateCalls += 1; return committedWorktree(); },
      currentList: () => { validationListCalls += 1; return worktreeList(); },
    },
  );
  assert.equal(validationFailed.state, "failed");
  assert.equal(validationFailed.sideEffect, "not_applied");
  assert.equal(validationCreateCalls, 0);
  assert.equal(validationListCalls, 0);
});

test("opaque incarnation binds server birth, session ID, raw name, creation, and birth marker", () => {
  assert.equal(
    state.issueManagedSessionIncarnation(cases.incarnation.baseIdentity),
    cases.incarnation.base,
  );
  for (const change of cases.incarnation.changes) {
    const changed = { ...cases.incarnation.baseIdentity, [change.field]: change.value };
    const issued = state.issueManagedSessionIncarnation(changed);
    assert.equal(issued, change.incarnation, change.field);
    assert.notEqual(issued, cases.incarnation.base, change.field);
  }
});

test("correlated create metadata is written to tmux and state, then projected consistently", () => {
  let managedState = { version: 1, sessions: [] };
  const calls = [];
  const birthMarker = cases.incarnation.baseIdentity.birthMarker;
  const live = liveSession();
  const created = session.createManagedTerminalSession({
    cwd: "/repo/demo",
    profile: "dashboard",
    quiet: true,
    lifecycleV2: {
      reservationCorrelation: cases.reservationCorrelation,
      displayLabel: "demo",
    },
  }, {
    existsSync: () => true,
    exec: (bin, args) => calls.push([bin, args]),
    tmuxBin: () => "tmux",
    sessionExists: () => false,
    randomId: () => "a1b2c",
    randomBirthMarker: () => birthMarker,
    loadManagedStateForMutation: () => managedState,
    recordManagedSession: (record) => {
      managedState = state.upsertManagedSession(managedState, record);
    },
    listTmuxSessionLifecycleEntries: () => [live],
    setupClipboardBindings: () => {},
    now: () => new Date("2026-07-12T00:00:01.000Z"),
  });

  assert.equal(created.lifecycleV2.incarnation, cases.incarnation.base);
  assert.deepEqual(created.lifecycleV2.reservationCorrelation, cases.reservationCorrelation);
  const tmuxArgs = calls[0][1];
  assert.deepEqual(tmuxArgs.slice(-12), [
    ";",
    "set-option",
    "-t",
    "=tw-term-a1b2c:",
    "@tw_rpc_v2_birth_marker_v1",
    birthMarker,
    ";",
    "set-option",
    "-t",
    "=tw-term-a1b2c:",
    "@tw_rpc_v2_reservation_correlation_v1",
    encodedCorrelation(),
  ]);
  const stored = state.managedSessionLifecycleExtension(managedState.sessions[0]);
  assert.equal(stored.incarnation, created.lifecycleV2.incarnation);
  assert.deepEqual(stored.reservationCorrelation, cases.reservationCorrelation);

  const listed = rpcV2.buildRpcV2ListResponse(managedState, [live]);
  assert.deepEqual(listed, cases.wire.list.normalized);
  assert.equal(listed.sessions[0].incarnation, created.lifecycleV2.incarnation);
  assert.deepEqual(listed.sessions[0].reservationCorrelation, cases.reservationCorrelation);
  assert.equal(listed.sessions[0].label, "demo");
});

test("create-worktree uses the same canonical lifecycle extension without inferring correlation from its name", () => {
  let managedState = { version: 1, sessions: [] };
  const identity = {
    ...liveSession(),
    name: "demo-fix",
    rawName: "demo-fix",
    sessionId: "$9",
  };
  const result = session.createManagedWorktreeSession({
    aiCmd: "codex",
    projectDir: "/repo/demo",
    sessionName: "demo-fix",
    useWorktree: true,
    worktreeBase: "/worktrees",
    projectKey: "demo",
    branch: "main",
    profile: "dashboard",
    quiet: true,
    lifecycleV2: {
      reservationCorrelation: cases.reservationCorrelation,
      displayLabel: null,
    },
  }, {
    existsSync: () => true,
    isGitRepo: () => true,
    gitQuery: () => "",
    exec: () => {},
    mkdirSync: () => {},
    tmuxBin: () => "tmux",
    sessionExists: () => false,
    randomId: () => "abc12",
    randomBirthMarker: () => cases.incarnation.baseIdentity.birthMarker,
    loadManagedStateForMutation: () => managedState,
    recordManagedSession: (record) => {
      managedState = state.upsertManagedSession(managedState, record);
    },
    listTmuxSessionLifecycleEntries: () => [identity],
    setupClipboardBindings: () => {},
    now: () => new Date("2026-07-12T00:00:01.000Z"),
  });
  assert.deepEqual(result.lifecycleV2.reservationCorrelation, cases.reservationCorrelation);
  assert.deepEqual(
    state.managedSessionLifecycleExtension(managedState.sessions[0]).reservationCorrelation,
    cases.reservationCorrelation,
  );
});

test("a v2 worktree mutation error is IN_DOUBT rather than false no-side-effect evidence", () => {
  assert.throws(
    () => session.createManagedWorktreeSession({
      aiCmd: "codex",
      projectDir: "/repo/demo",
      sessionName: "demo-fix",
      useWorktree: true,
      worktreeBase: "/worktrees",
      projectKey: "demo",
      branch: "main",
      profile: "dashboard",
      quiet: true,
      lifecycleV2: {
        reservationCorrelation: cases.reservationCorrelation,
        displayLabel: null,
      },
    }, {
      existsSync: () => true,
      isGitRepo: () => true,
      gitQuery: () => "",
      exec: (bin, args) => {
        if (bin === "git" && args.includes("worktree")) throw new Error("exit status unknown");
      },
      mkdirSync: () => {},
      tmuxBin: () => "tmux",
      sessionExists: () => false,
      randomId: () => "abc12",
      randomBirthMarker: () => cases.incarnation.baseIdentity.birthMarker,
      loadManagedStateForMutation: () => ({ version: 1, sessions: [] }),
    }),
    (error) => error instanceof session.ManagedSessionLifecycleV2InDoubtError,
  );
});

test("canonical create owners fence every post-start observation failure as IN_DOUBT", () => {
  const worktreeIdentity = liveSession({
    name: "demo-fix",
    rawName: "demo-fix",
    sessionId: "$9",
  });
  const worktreeConfig = () => ({
    projects: { demo: { path: "/repo/demo", branch: "main" } },
  });
  const worktreeOwnerDeps = (overrides = {}) => ({
    existsSync: () => true,
    isGitRepo: () => true,
    gitQuery: () => "",
    exec: () => {},
    mkdirSync: () => {},
    tmuxBin: () => "tmux",
    sessionExists: () => false,
    randomId: () => "abc12",
    randomBirthMarker: () => cases.incarnation.baseIdentity.birthMarker,
    loadManagedStateForMutation: () => ({ version: 1, sessions: [] }),
    recordManagedSession: () => {},
    listTmuxSessionLifecycleEntries: () => [worktreeIdentity],
    setupClipboardBindings: () => {},
    now: () => new Date("2026-07-12T00:00:01.000Z"),
    ...overrides,
  });
  const terminalOwnerDeps = (overrides = {}) => ({
    existsSync: () => true,
    exec: () => {},
    tmuxBin: () => "tmux",
    sessionExists: () => false,
    randomId: () => "a1b2c",
    randomBirthMarker: () => cases.incarnation.baseIdentity.birthMarker,
    loadManagedStateForMutation: () => ({ version: 1, sessions: [] }),
    recordManagedSession: () => {},
    listTmuxSessionLifecycleEntries: () => [liveSession()],
    setupClipboardBindings: () => {},
    now: () => new Date("2026-07-12T00:00:01.000Z"),
    ...overrides,
  });
  const assertInDoubtWithoutRetrySignal = (result, detail) => {
    assert.equal(result.state, "in_doubt", detail);
    assert.equal(Object.hasOwn(result, "sideEffect"), false, detail);
    assert.equal(result.error.code, "IN_DOUBT", detail);
    assert.match(result.error.message, detail);
  };

  let ownerTmuxStarted = false;
  let rpcPostCreateListCalls = 0;
  const initialCaptureFailed = rpcV2.executeRpcV2CreateWorktree(
    cases.wire.createWorktree.request,
    {
      loadConfig: worktreeConfig,
      worktreeSessionDeps: worktreeOwnerDeps({
        exec: (bin) => { if (bin === "tmux") ownerTmuxStarted = true; },
        listTmuxSessionLifecycleEntries: () => { throw new Error("tmux list timed out"); },
      }),
      currentList: () => {
        rpcPostCreateListCalls += 1;
        return { protocolVersion: 2, sessions: [] };
      },
    },
  );
  assert.equal(ownerTmuxStarted, true);
  assertInDoubtWithoutRetrySignal(
    initialCaptureFailed,
    /initial tmux identity capture.*tmux list timed out/,
  );

  let terminalStateReads = 0;
  const commitRereadFailed = rpcV2.executeRpcV2CreateTerminal(
    cases.wire.createTerminal.request,
    {
      terminalSessionDeps: terminalOwnerDeps({
        loadManagedStateForMutation: () => {
          terminalStateReads += 1;
          if (terminalStateReads > 1) throw new Error("commit re-read timed out");
          return { version: 1, sessions: [] };
        },
        recordManagedSession: () => { throw new Error("state rename result unknown"); },
      }),
      currentList: () => {
        rpcPostCreateListCalls += 1;
        return { protocolVersion: 2, sessions: [] };
      },
    },
  );
  assertInDoubtWithoutRetrySignal(
    commitRereadFailed,
    /state commit re-read.*commit re-read timed out/,
  );

  let managedState = { version: 1, sessions: [] };
  let worktreeStateReads = 0;
  const finalConfirmationFailed = rpcV2.executeRpcV2CreateWorktree(
    cases.wire.createWorktree.request,
    {
      loadConfig: worktreeConfig,
      worktreeSessionDeps: worktreeOwnerDeps({
        loadManagedStateForMutation: () => {
          worktreeStateReads += 1;
          if (worktreeStateReads > 1) throw new Error("final state read malformed");
          return managedState;
        },
        recordManagedSession: (record) => {
          managedState = state.upsertManagedSession(managedState, record);
        },
      }),
      currentList: () => {
        rpcPostCreateListCalls += 1;
        return { protocolVersion: 2, sessions: [] };
      },
    },
  );
  assertInDoubtWithoutRetrySignal(
    finalConfirmationFailed,
    /final state commit confirmation.*final state read malformed/,
  );
  assert.equal(rpcPostCreateListCalls, 0);

  const failedBeforeMutation = rpcV2.executeRpcV2CreateTerminal(
    cases.wire.createTerminal.request,
    {
      terminalSessionDeps: terminalOwnerDeps({
        tmuxBin: () => { throw new Error("tmux unavailable before mutation"); },
      }),
      currentList: () => {
        rpcPostCreateListCalls += 1;
        return { protocolVersion: 2, sessions: [] };
      },
    },
  );
  assert.equal(failedBeforeMutation.state, "failed");
  assert.equal(failedBeforeMutation.sideEffect, "not_applied");
  assert.equal(failedBeforeMutation.error.code, "CREATE_FAILED");
  assert.equal(rpcPostCreateListCalls, 0);
});

test("legacy records stay readable without a synthesized marker and v1 list white-lists frozen fields", () => {
  const legacyLive = liveSession({
    name: storageCases.legacy.name,
    rawName: storageCases.legacy.name,
    sessionId: "$3",
    birthMarker: null,
    reservationCorrelation: null,
  });
  const response = rpcV2.buildRpcV2ListResponse(
    { version: 1, sessions: [storageCases.legacy] },
    [legacyLive],
  );
  assert.equal(response.sessions.length, 1);
  assert.equal(response.sessions[0].lifecycleMarked, false);
  assert.equal(response.sessions[0].reservationCorrelation, null);

  const v1 = rpc.buildRpcListResponse(
    { version: 1, sessions: [storageCases.extended] },
    [{
      name: storageCases.extended.name,
      attached: false,
      windows: 1,
      created: 1783700010,
      activity: 1783700020,
      cwd: storageCases.extended.cwd,
    }],
  );
  assert.equal(Object.hasOwn(v1.sessions[0], "extensions"), false);
  assert.equal(Object.hasOwn(v1.sessions[0], "incarnation"), false);
  assert.deepEqual(Object.keys(v1.sessions[0]), [
    "name", "kind", "profile", "cwd", "createdAt",
    "attached", "windows", "created", "activity",
  ]);
});

test("expected-incarnation kill targets one session ID and removes only the matching record", () => {
  withTempDir("tw-rpc-v2-kill-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [storageCases.extended]);
    const killed = [];
    const result = session.killManagedSessionV2({
      name: storageCases.extended.name,
      expectedIncarnation: cases.incarnation.base,
    }, {
      statePath: path,
      listTmuxSessionLifecycleEntries: () => [liveSession()],
      killTmuxSessionByLifecycleIdentity: (identity) => {
        assert.equal(existsSync(`${path}.lock`), true);
        assert.equal(JSON.parse(readFileSync(path, "utf8")).sessions.length, 1);
        killed.push(identity.sessionId);
        return "killed";
      },
    });
    assert.equal(result.state, "succeeded");
    assert.deepEqual({
      protocolVersion: 2,
      operation: "kill-session",
      ...result,
    }, cases.wire.killSession.normalized);
    assert.deepEqual(killed, ["$7"]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).sessions, []);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});

test("exact tmux kill fences socket identity, same-name replacement, and server restart", (t) => {
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  withTempDir("tw-rpc-v2-real-tmux-", (root) => {
    const wrapper = join(root, "isolated-tmux");
    const socketName = `tw-rpc-v2-${process.pid}-${Date.now()},hash#}socket`;
    const writeWrapper = (failExactKill = false) => writeFileSync(
      wrapper,
      `#!/bin/sh\n${failExactKill ? 'if [ "$1" = "if-shell" ]; then exit 1; fi\n' : ""}exec tmux -L '${socketName}' -f /dev/null "$@"\n`,
      { mode: 0o700 },
    );
    writeWrapper();
    const previousTmux = process.env.TW_TMUX;
    process.env.TW_TMUX = wrapper;
    const command = (args) => spawnSync(wrapper, args, { encoding: "utf8" });
    const inspect = (name = "same-name") => {
      const format = [
        "#{socket_path}", "#{pid}", "#{start_time}", "#{session_id}",
        "#{session_name}", "#{session_created}",
        "#{@tw_rpc_v2_birth_marker_v1}",
        "#{@tw_rpc_v2_reservation_correlation_v1}",
        "#{session_attached}", "#{session_windows}", "#{session_activity}",
        "#{pane_current_path}",
      ].join("\x1f");
      const result = command(["list-sessions", "-F", format]);
      assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.split("\n")
        .find((candidate) => candidate.split("\x1f")[4] === name);
      assert.ok(line);
      const fields = line.split("\x1f");
      return {
        name: fields[4],
        rawName: fields[4],
        attached: fields[8] !== "0",
        windows: Number(fields[9]),
        created: Number(fields[5]),
        activity: Number(fields[10]),
        cwd: fields[11],
        serverSocketPath: fields[0],
        serverPid: fields[1],
        serverStarted: fields[2],
        sessionId: fields[3],
        sessionCreated: fields[5],
        birthMarker: fields[6],
        reservationCorrelation: fields[7],
        lifecycleMarkersValid: true,
      };
    };
    const create = (marker) => {
      let result = command(["new-session", "-d", "-s", "same-name", "sleep 60"]);
      assert.equal(result.status, 0, result.stderr);
      result = command([
        "set-option", "-t", "=same-name:", "@tw_rpc_v2_birth_marker_v1", marker,
        ";", "set-option", "-t", "=same-name:",
        "@tw_rpc_v2_reservation_correlation_v1", encodedCorrelation(),
      ]);
      assert.equal(result.status, 0, result.stderr);
      return inspect();
    };
    const writeIncarnationState = (path, live) => {
      const extension = state.buildManagedSessionLifecycleExtension(
        {
          serverSocketPath: live.serverSocketPath,
          serverPid: live.serverPid,
          serverStarted: live.serverStarted,
          sessionId: live.sessionId,
          rawName: live.rawName,
          sessionCreated: live.sessionCreated,
          birthMarker: live.birthMarker,
        },
        cases.reservationCorrelation,
        "same-name",
      );
      writeState(path, [state.withManagedSessionLifecycleExtension({
        name: "same-name",
        kind: "terminal",
        profile: "dashboard",
        cwd: root,
        createdAt: "2026-07-12T00:00:01.000Z",
      }, extension)]);
      return extension.incarnation;
    };
    try {
      let createdState = { version: 1, sessions: [] };
      const created = session.createManagedTerminalSession({
        cwd: root,
        profile: "dashboard",
        quiet: true,
        lifecycleV2: {
          reservationCorrelation: cases.reservationCorrelation,
          displayLabel: "real-create",
        },
      }, {
        tmuxBin: () => wrapper,
        sessionExists: () => false,
        randomId: () => "real1",
        randomBirthMarker: () => "twbirth2.ABCDEFGHIJKLMNOPQRSTUV",
        loadManagedStateForMutation: () => createdState,
        recordManagedSession: (record) => {
          createdState = state.upsertManagedSession(createdState, record);
        },
        setupClipboardBindings: () => {},
      });
      const createdLive = inspect(created.session);
      assert.equal(createdLive.birthMarker, "twbirth2.ABCDEFGHIJKLMNOPQRSTUV");
      assert.equal(createdLive.reservationCorrelation, encodedCorrelation());
      assert.equal(
        state.managedSessionLifecycleExtension(createdState.sessions[0]).incarnation,
        created.lifecycleV2.incarnation,
      );
      const cleanupCreated = command(["kill-session", "-t", createdLive.sessionId]);
      assert.equal(cleanupCreated.status, 0, cleanupCreated.stderr);

      const bootstrap = command(["new-session", "-d", "-s", "bootstrap", "sleep 60"]);
      assert.equal(bootstrap.status, 0, bootstrap.stderr);
      const first = create("twbirth2.ABCDEFGHIJKLMNOPQRSTUV");
      assert.equal(first.rawName, "same-name");
      const statePath = join(root, "state.json");
      const firstIncarnation = writeIncarnationState(statePath, first);

      let replacement;
      const replacementResult = session.killManagedSessionV2({
        name: "same-name",
        expectedIncarnation: firstIncarnation,
      }, {
        statePath,
        listTmuxSessionLifecycleEntries: () => {
          const result = command(["kill-session", "-t", "=same-name"]);
          assert.equal(result.status, 0, result.stderr);
          replacement = create("twbirth2.VUTSRQPONMLKJIHGFEDCBA");
          return [first];
        },
      });
      assert.equal(replacementResult.state, "failed");
      assert.equal(replacementResult.code, "INCARNATION_MISMATCH");
      assert.equal(
        inspect().sessionId,
        replacement.sessionId,
      );

      const replacementIncarnation = writeIncarnationState(statePath, replacement);
      let restarted;
      const restartResult = session.killManagedSessionV2({
        name: "same-name",
        expectedIncarnation: replacementIncarnation,
      }, {
        statePath,
        listTmuxSessionLifecycleEntries: () => {
          const result = command(["kill-server"]);
          assert.equal(result.status, 0, result.stderr);
          restarted = create("twbirth2.ABCDEFGHIJKLMNOPQRSTUV");
          return [replacement];
        },
      });
      assert.equal(restartResult.state, "failed");
      assert.equal(restartResult.code, "INCARNATION_MISMATCH");
      assert.equal(
        inspect().serverPid,
        restarted.serverPid,
      );

      const wrongSocketIdentity = {
        ...restarted,
        serverSocketPath: `${restarted.serverSocketPath}-other`,
      };
      const wrongSocketIncarnation = writeIncarnationState(statePath, wrongSocketIdentity);
      const socketMismatch = session.killManagedSessionV2({
        name: "same-name",
        expectedIncarnation: wrongSocketIncarnation,
      }, { statePath, listTmuxSessionLifecycleEntries: () => [wrongSocketIdentity] });
      assert.equal(socketMismatch.state, "failed");
      assert.equal(socketMismatch.code, "INCARNATION_MISMATCH");
      assert.equal(inspect().sessionId, restarted.sessionId);
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).sessions.length, 1);

      const restartedIncarnation = writeIncarnationState(statePath, restarted);
      writeWrapper(true);
      const diagnosticOnly = session.killManagedSessionV2({
        name: "same-name",
        expectedIncarnation: restartedIncarnation,
      }, { statePath, listTmuxSessionLifecycleEntries: () => [restarted] });
      assert.equal(diagnosticOnly.state, "in_doubt");
      assert.equal(inspect().sessionId, restarted.sessionId);
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).sessions.length, 1);

      writeWrapper();
      const killed = session.killManagedSessionV2({
        name: "same-name",
        expectedIncarnation: restartedIncarnation,
      }, { statePath, listTmuxSessionLifecycleEntries: () => [restarted] });
      assert.equal(killed.state, "succeeded");
      const final = command(["has-session", "-t", "=same-name"]);
      assert.notEqual(final.status, 0);
    } finally {
      command(["kill-server"]);
      if (previousTmux === undefined) delete process.env.TW_TMUX;
      else process.env.TW_TMUX = previousTmux;
    }
  });
});

test("server restart, session replacement, creation change, and marker mismatch never kill or delete", () => {
  const changes = [
    { field: "serverPid", value: "4201" },
    { field: "serverStarted", value: "1783700001" },
    { field: "sessionId", value: "$8" },
    { field: "sessionCreated", value: "1783700011", created: 1783700011 },
    { field: "birthMarker", value: "twbirth2.VUTSRQPONMLKJIHGFEDCBA" },
  ];
  for (const change of changes) {
    withTempDir(`tw-rpc-v2-kill-${change.field}-`, (root) => {
      const path = join(root, "state.json");
      writeState(path, [storageCases.extended]);
      let killCalls = 0;
      const result = session.killManagedSessionV2({
        name: storageCases.extended.name,
        expectedIncarnation: cases.incarnation.base,
      }, {
        statePath: path,
        listTmuxSessionLifecycleEntries: () => [liveSession({
          [change.field]: change.value,
          ...(change.created ? { created: change.created } : {}),
        })],
        killTmuxSessionByLifecycleIdentity: () => {
          killCalls += 1;
          return "killed";
        },
      });
      assert.equal(result.state, "failed", change.field);
      assert.equal(result.sideEffect, "not_applied", change.field);
      assert.equal(killCalls, 0, change.field);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).sessions, [storageCases.extended]);
    });
  }
});

test("not-found, exact-kill mismatch, and uncertain result preserve the managed record", () => {
  for (const scenario of ["not_found", "mismatch", "in_doubt", "throws"]) {
    withTempDir(`tw-rpc-v2-kill-${scenario}-`, (root) => {
      const path = join(root, "state.json");
      writeState(path, [storageCases.extended]);
      const result = session.killManagedSessionV2({
        name: storageCases.extended.name,
        expectedIncarnation: cases.incarnation.base,
      }, {
        statePath: path,
        listTmuxSessionLifecycleEntries: () => scenario === "not_found" ? [] : [liveSession()],
        killTmuxSessionByLifecycleIdentity: () => {
          if (scenario === "throws") throw new Error("transport result unavailable");
          return scenario;
        },
      });
      assert.notEqual(result.state, "succeeded", scenario);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).sessions, [storageCases.extended]);
    });
  }
});

test("a confirmed tmux kill with an unconfirmed state commit returns IN_DOUBT and keeps the record", () => {
  withTempDir("tw-rpc-v2-kill-state-uncertain-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [storageCases.extended]);
    const result = session.killManagedSessionV2({
      name: storageCases.extended.name,
      expectedIncarnation: cases.incarnation.base,
    }, {
      statePath: path,
      listTmuxSessionLifecycleEntries: () => [liveSession()],
      killTmuxSessionByLifecycleIdentity: () => "killed",
      saveManagedState: () => { throw new Error("rename uncertain"); },
    });
    assert.equal(result.state, "in_doubt");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).sessions, [storageCases.extended]);
  });
});

test("corrupt managed state fails before any tmux call", () => {
  withTempDir("tw-rpc-v2-kill-corrupt-", (root) => {
    const path = join(root, "state.json");
    const invalid = "{\"version\":1,\"sessions\":[\n";
    writeFileSync(path, invalid);
    let tmuxCalls = 0;
    assert.throws(
      () => session.killManagedSessionV2({
        name: "tw-term-a1b2c",
        expectedIncarnation: cases.incarnation.base,
      }, {
        statePath: path,
        listTmuxSessionLifecycleEntries: () => {
          tmuxCalls += 1;
          return [liveSession()];
        },
        killTmuxSessionByLifecycleIdentity: () => {
          tmuxCalls += 1;
          return "killed";
        },
      }),
      /refusing to mutate invalid managed state/,
    );
    assert.equal(tmuxCalls, 0);
    assert.equal(readFileSync(path, "utf8"), invalid);
  });

  withTempDir("tw-rpc-v2-kill-corrupt-extension-", (root) => {
    const path = join(root, "state.json");
    const malformed = structuredClone(storageCases.extended);
    malformed.extensions["tw.rpc-v2.lifecycle.v1"].tmux.birthMarker = "wrong-marker";
    writeState(path, [malformed]);
    let tmuxCalls = 0;
    assert.throws(
      () => session.killManagedSessionV2({
        name: malformed.name,
        expectedIncarnation: cases.incarnation.base,
      }, {
        statePath: path,
        listTmuxSessionLifecycleEntries: () => {
          tmuxCalls += 1;
          return [liveSession()];
        },
      }),
      /invalid tmux incarnation identity/,
    );
    assert.equal(tmuxCalls, 0);

    assert.throws(
      () => session.createManagedTerminalSession({
        cwd: root,
        profile: "dashboard",
        quiet: true,
        lifecycleV2: {
          reservationCorrelation: cases.reservationCorrelation,
          displayLabel: null,
        },
      }, {
        loadManagedStateForMutation: () => ({ version: 1, sessions: [malformed] }),
        exec: () => { tmuxCalls += 1; },
      }),
      /invalid tmux incarnation identity/,
    );
    assert.equal(tmuxCalls, 0);
  });
});
