import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const {
  acquireManagedStateLock,
  emptyManagedState,
  loadManagedState,
  recordManagedSession,
  releaseManagedStateLock,
  removeManagedSession,
  removeManagedSessionIfCurrent,
  upsertManagedSession,
} = await import("../dist/state.js");
const {
  buildRpcCapabilitiesResponse,
  buildRpcKillSessionResponse,
  buildRpcListResponse,
  parseRpcCreateTerminalArgs,
  parseRpcCreateWorktreeArgs,
  parseRpcRestoreWorktreeArgs,
  parseRpcKillSessionArgs,
} = await import("../dist/rpc.js");
const {
  createManagedTerminalSession,
  createManagedWorktreeSession,
  restoreManagedWorktreeSession,
} = await import("../dist/session.js");
const { normalizeConfig, resolveWorktreeBase } = await import("../dist/config.js");
const tmuxTestRoot = mkdtempSync(join(tmpdir(), "tw-tmux-hard-timeout-module-"));
const tmuxTestModule = join(tmuxTestRoot, "tmux.mjs");
buildSync({
  entryPoints: [fileURLToPath(new URL("../src/tmux.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: tmuxTestModule,
  logLevel: "silent",
});
const {
  exec: hardBoundExec,
  query: hardBoundQuery,
  run: hardBoundRun,
} = await import(pathToFileURL(tmuxTestModule).href);
process.once("exit", () => rmSync(tmuxTestRoot, { recursive: true, force: true }));

function writeHardBoundFixture(root) {
  const fixture = join(root, "hard-bound-fixture.cjs");
  writeFileSync(fixture, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const mode = process.argv[2];
const pidFile = process.argv[3];
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
], { stdio: "inherit" });
descendant.unref();
writeFileSync(pidFile, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
process.on("SIGTERM", () => {});
if (mode === "exit") process.exit(0);
setInterval(() => {}, 1_000);
`);
  return fixture;
}

function readFixturePids(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Number.isSafeInteger(parsed.parent) && parsed.parent > 1);
  assert.ok(Number.isSafeInteger(parsed.descendant) && parsed.descendant > 1);
  return parsed;
}

function assertProcessGone(pid, label) {
  assert.throws(
    () => process.kill(pid, 0),
    { code: "ESRCH" },
    `${label} process ${pid} survived the synchronous command wrapper`,
  );
}

async function waitForProcessToDisappear(pid, timeout = 1_500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} did not disappear within ${timeout}ms`);
}

test("managed state records TW-owned worktree sessions", () => {
  const state = upsertManagedSession(emptyManagedState(), {
    name: "coco-fix",
    kind: "worktree",
    profile: "cli",
    project: "coco",
    repoPath: "/repo/coco",
    worktreePath: "/home/dev/.tmux-worktree/worktrees/coco/coco-fix-a1b2c",
    branch: "coco-fix-a1b2c",
    baseBranch: "main",
    createdAt: "2026-07-02T00:00:00.000Z",
  });

  assert.equal(state.version, 1);
  assert.deepEqual(state.sessions, [
    {
      name: "coco-fix",
      kind: "worktree",
      profile: "cli",
      project: "coco",
      repoPath: "/repo/coco",
      worktreePath: "/home/dev/.tmux-worktree/worktrees/coco/coco-fix-a1b2c",
      branch: "coco-fix-a1b2c",
      baseBranch: "main",
      createdAt: "2026-07-02T00:00:00.000Z",
    },
  ]);
});

test("managed state mutations preserve invalid JSON instead of replacing it", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-invalid-managed-state-"));
  const statePath = join(root, ".tmux-worktree", "state.json");
  mkdirSync(join(root, ".tmux-worktree"), { recursive: true });
  const invalid = '{"version":1,"sessions":[\n';
  writeFileSync(statePath, invalid);

  // Read-only consumers retain the historical tolerant behavior.
  assert.deepEqual(loadManagedState(statePath), emptyManagedState());
  assert.throws(
    () => recordManagedSession({
      name: "tw-term-abc12",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/repo/app",
      createdAt: "2026-07-12T00:00:00.000Z",
    }, statePath),
    /refusing to mutate invalid managed state.*original file preserved/,
  );
  assert.equal(readFileSync(statePath, "utf8"), invalid);
  assert.equal(existsSync(`${statePath}.lock`), false);

  assert.throws(
    () => removeManagedSession("tw-term-abc12", statePath),
    /refusing to mutate invalid managed state.*original file preserved/,
  );
  assert.equal(readFileSync(statePath, "utf8"), invalid);
  assert.equal(existsSync(`${statePath}.lock`), false);
});

test("stale managed-state lock owner cannot remove the replacement lock", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-state-lock-takeover-"));
  const lockPath = join(root, "state.json.lock");
  const first = acquireManagedStateLock(lockPath);
  const ownerPath = join(lockPath, "owner.json");
  const stale = JSON.parse(readFileSync(ownerPath, "utf8"));
  writeFileSync(ownerPath, `${JSON.stringify({ ...stale, createdAt: 0 })}\n`, { mode: 0o600 });

  const second = acquireManagedStateLock(lockPath);
  assert.notEqual(first.owner, second.owner);
  releaseManagedStateLock(first);
  assert.equal(existsSync(lockPath), true, "old owner must not remove the replacement state lock");
  assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).owner, second.owner);

  releaseManagedStateLock(second);
  assert.equal(existsSync(lockPath), false, "current owner releases its own state lock");
});

test("rpc list returns only managed sessions that still exist in tmux", () => {
  const state = [
    {
      name: "managed-live",
      kind: "worktree",
      profile: "dashboard",
      project: "web",
      repoPath: "/repo/web",
      worktreePath: "/home/dev/.tmux-worktree/worktrees/web/managed-live-bbbbb",
      branch: "managed-live-bbbbb",
      baseBranch: "main",
      createdAt: "2026-07-02T00:00:00.000Z",
    },
    {
      name: "managed-dead",
      kind: "worktree",
      profile: "cli",
      project: "api",
      repoPath: "/repo/api",
      worktreePath: "/home/dev/.tmux-worktree/worktrees/api/managed-dead-ccccc",
      branch: "managed-dead-ccccc",
      baseBranch: "main",
      createdAt: "2026-07-02T00:00:00.000Z",
    },
  ];
  const response = buildRpcListResponse(
    { version: 1, sessions: state },
    [
      {
        name: "managed-live",
        attached: false,
        windows: 1,
        created: 1760000000,
        activity: 1760000100,
        cwd: "/home/dev/.tmux-worktree/worktrees/web/managed-live-bbbbb",
      },
      {
        name: "ordinary-tmux",
        attached: false,
        windows: 1,
        created: 1760000200,
        activity: 1760000300,
        cwd: "/repo/other",
      },
    ],
  );

  assert.equal(response.protocolVersion, 1);
  assert.deepEqual(response.sessions.map((session) => session.name), ["managed-live"]);
  assert.equal(response.sessions[0].profile, "dashboard");
  assert.equal(response.sessions[0].worktreePath, "/home/dev/.tmux-worktree/worktrees/web/managed-live-bbbbb");
});

test("rpc capabilities advertise hard-bounded remote mutations", () => {
  assert.deepEqual(buildRpcCapabilitiesResponse().capabilities, [
    "list",
    "managed-state",
    "hard-timeout",
    "create-worktree",
    "create-terminal",
    "restore-worktree",
    "kill-session",
  ]);
});

test("query, exec, and run hard-kill TERM-ignoring command groups at timeout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tw-hard-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writeHardBoundFixture(root);
  const invocations = [
    {
      name: "query",
      invoke: (pidFile) => assert.equal(
        hardBoundQuery(process.execPath, [fixture, "hang", pidFile], 80),
        "",
      ),
    },
    {
      name: "exec",
      invoke: (pidFile) => assert.throws(
        () => hardBoundExec(process.execPath, [fixture, "hang", pidFile], 80),
        /command timed out after 80ms/,
      ),
    },
    {
      name: "run",
      invoke: (pidFile) => assert.throws(
        () => hardBoundRun(process.execPath, [fixture, "hang", pidFile], 80),
        /command timed out after 80ms/,
      ),
    },
  ];

  for (const invocation of invocations) {
    const pidFile = join(root, `${invocation.name}.json`);
    const startedAt = Date.now();
    invocation.invoke(pidFile);
    assert.ok(
      Date.now() - startedAt < 1_500,
      `${invocation.name} exceeded its timeout plus termination grace`,
    );
    const pids = readFixturePids(pidFile);
    assertProcessGone(pids.parent, `${invocation.name} parent`);
    assertProcessGone(pids.descendant, `${invocation.name} descendant`);
  }
});

test("a normally exiting command cannot leave descendants behind", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tw-descendant-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writeHardBoundFixture(root);
  const pidFile = join(root, "pids.json");
  const startedAt = Date.now();
  assert.throws(
    () => hardBoundRun(process.execPath, [fixture, "exit", pidFile], 1_000),
    /command left descendant processes after exit/,
  );
  assert.ok(Date.now() - startedAt < 1_500, "descendant cleanup waited for the outer timeout");
  const pids = readFixturePids(pidFile);
  assertProcessGone(pids.parent, "normally exited parent");
  assertProcessGone(pids.descendant, "orphaned descendant");
});

test("an outer process-group shutdown is forwarded to the supervised command group", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tw-supervisor-signal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writeHardBoundFixture(root);
  const pidFile = join(root, "pids.json");
  const moduleUrl = pathToFileURL(tmuxTestModule).href;
  const source = `import(${JSON.stringify(moduleUrl)}).then(({ run }) => {
    run(process.execPath, ${JSON.stringify([fixture, "hang", pidFile])}, 10_000);
  });`;
  const wrapper = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    try { process.kill(-wrapper.pid, "SIGKILL"); } catch {}
  });

  const enteredDeadline = Date.now() + 1_500;
  while (!existsSync(pidFile) && Date.now() < enteredDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(pidFile), true, "supervised command did not start");
  const pids = readFixturePids(pidFile);
  process.kill(-wrapper.pid, "SIGTERM");

  await Promise.all([
    waitForProcessToDisappear(pids.parent),
    waitForProcessToDisappear(pids.descendant),
    waitForProcessToDisappear(-wrapper.pid),
  ]);
});

test("hard-bound wrappers preserve normal stdout and stdio behavior", () => {
  const command = [
    "-e",
    "process.stdout.write('  hard-bound ok  ');process.stderr.write('hidden stderr')",
  ];
  assert.equal(hardBoundQuery(process.execPath, command, 1_000), "hard-bound ok");
  assert.equal(hardBoundRun(process.execPath, command, 1_000), "hard-bound ok");
  assert.equal(hardBoundExec(process.execPath, ["-e", "process.exit(0)"], 1_000), undefined);
});

test("rpc worktree creation accepts configured project targets", () => {
  assert.deepEqual(
    parseRpcCreateWorktreeArgs(["--project", "demo", "--ai-command", "codex"]),
    {
      project: "demo",
      aiCommand: "codex",
    },
  );
});

test("rpc terminal and restore parsers keep the headless lifecycle surface narrow", () => {
  assert.deepEqual(
    parseRpcCreateTerminalArgs(["--cwd", " ~/src ", "--ai-command", " codex "]),
    { cwd: "~/src", aiCommand: "codex" },
  );
  assert.deepEqual(
    parseRpcRestoreWorktreeArgs([
      "--path", " ~/worktrees/app/fix-abc12 ",
      "--name", " app-fix ",
      "--ai-command", " codex ",
    ]),
    {
      path: "~/worktrees/app/fix-abc12",
      name: "app-fix",
      aiCommand: "codex",
    },
  );
  assert.throws(() => parseRpcCreateTerminalArgs(["--cwd", "/tmp", "--name", "unsafe"]), /unknown create-terminal option/);
});

test("rpc kill-session only mutates TW-managed sessions and removes stale records idempotently", () => {
  assert.deepEqual(parseRpcKillSessionArgs(["--name", "tw-term-abc12"]), { name: "tw-term-abc12" });
  const killed = [];
  const removed = [];
  const response = buildRpcKillSessionResponse(
    { name: "tw-term-abc12" },
    {
      loadState: () => ({
        version: 1,
        sessions: [{
          name: "tw-term-abc12",
          kind: "terminal",
          profile: "dashboard",
          cwd: "/repo/app",
          createdAt: "2026-07-12T00:00:00.000Z",
        }],
      }),
      exists: () => true,
      kill: (name) => killed.push(name),
      removeRecord: (name, expected) => removed.push({ name, expected }),
    },
  );
  assert.deepEqual(response, {
    protocolVersion: 1,
    kind: "session-killed",
    session: "tw-term-abc12",
    sessionKind: "terminal",
    killed: true,
  });
  assert.deepEqual(killed, ["tw-term-abc12"]);
  assert.deepEqual(removed, [{
    name: "tw-term-abc12",
    expected: {
      name: "tw-term-abc12",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/repo/app",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
  }]);
  assert.throws(
    () => buildRpcKillSessionResponse(
      { name: "ordinary" },
      { loadState: () => ({ version: 1, sessions: [] }) },
    ),
    /not TW-managed/,
  );
});

test("rpc kill does not delete a same-named session recreated during cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-rpc-kill-recreate-race-"));
  const statePath = join(root, ".tmux-worktree", "state.json");
  const oldRecord = {
    name: "app-fix",
    kind: "worktree",
    profile: "dashboard",
    project: "app",
    repoPath: "/repo/app",
    worktreePath: "/worktrees/app/app-fix-old12",
    branch: "app-fix-old12",
    baseBranch: "main",
    createdAt: "2026-07-12T00:00:00.000Z",
  };
  const replacement = {
    ...oldRecord,
    worktreePath: "/worktrees/app/app-fix-new34",
    branch: "app-fix-new34",
    createdAt: "2026-07-12T00:00:01.000Z",
  };
  recordManagedSession(oldRecord, statePath);

  const response = buildRpcKillSessionResponse(
    { name: oldRecord.name },
    {
      loadState: () => loadManagedState(statePath),
      exists: () => true,
      // Model the exact interleaving: the old tmux session is gone, then a
      // creator records a replacement with the same deterministic name before
      // the killer reaches state cleanup.
      kill: () => recordManagedSession(replacement, statePath),
      removeRecord: (_name, expected) => {
        removeManagedSessionIfCurrent(expected, statePath);
      },
    },
  );

  assert.equal(response.killed, true);
  assert.deepEqual(loadManagedState(statePath).sessions, [replacement]);
});

test("tw rpc kill-session fails closed when managed state is corrupt", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-rpc-kill-corrupt-state-"));
  const home = join(root, "home");
  const stateDir = join(home, ".tmux-worktree");
  const statePath = join(stateDir, "state.json");
  const fakeTmux = join(root, "tmux");
  const tmuxLog = join(root, "tmux.log");
  mkdirSync(stateDir, { recursive: true });
  const invalid = '{"version":1,"sessions":[\n';
  writeFileSync(statePath, invalid);
  writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_TMUX_LOG"
case "$1" in
  list-sessions)
    printf 'tw-term-abc12\\0370\\0371\\0371760000000\\0371760000100\\037/repo/app\\n'
    ;;
  has-session)
    exit 0
    ;;
esac
exit 0
`);
  chmodSync(fakeTmux, 0o755);

  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "rpc", "kill-session", "--name", "tw-term-abc12"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TW_TMUX: fakeTmux,
      TW_TEST_TMUX_LOG: tmuxLog,
    },
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to mutate invalid managed state.*original file preserved/);
  assert.equal(readFileSync(statePath, "utf8"), invalid);
  assert.equal(existsSync(tmuxLog), false, "corrupt state must not authorize a direct tmux kill");

  const humanResult = spawnSync(process.execPath, [cli, "rm", "tw-term-abc12"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TW_TMUX: fakeTmux,
      TW_TEST_TMUX_LOG: tmuxLog,
    },
    timeout: 5_000,
  });
  assert.equal(humanResult.status, 1);
  assert.match(humanResult.stderr, /refusing to mutate invalid managed state.*original file preserved/);
  assert.doesNotMatch(readFileSync(tmuxLog, "utf8"), /kill-session/);
});

test("tw rm closes managed sessions through the state-aware lifecycle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tw-rm-managed-state-"));
  const home = join(root, "home");
  const stateDir = join(home, ".tmux-worktree");
  const statePath = join(stateDir, "state.json");
  const fakeTmux = join(root, "tmux");
  const tmuxLog = join(root, "tmux.log");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    sessions: [{
      name: "tw-term-abc12",
      kind: "terminal",
      profile: "dashboard",
      cwd: "/repo/app",
      createdAt: "2026-07-12T00:00:00.000Z",
    }],
  })}\n`);
  writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_TMUX_LOG"
case "$1" in
  list-sessions)
    case "$3" in
      *session_id*) printf 'tw-term-abc12\\037$0\\n' ;;
      *) printf 'tw-term-abc12\\0370\\0371\\0371760000000\\0371760000100\\037/repo/app\\n' ;;
    esac
    ;;
  has-session)
    exit 0
    ;;
  list-panes)
    printf '0\\037%%1\\n'
    ;;
  show-options)
    if [ "$5" = '@tw_terminal_control_output_generation_v1' ]; then
      [ -f "$TW_TEST_TMUX_LOG.output-generation" ] || exit 1
      cat "$TW_TEST_TMUX_LOG.output-generation"
    else
      printf 'tmux-instance-managed-rm\n'
    fi
    ;;
  set-option)
    if [ "$4" = '@tw_terminal_control_output_generation_v1' ]; then
      printf '%s\n' "$5" > "$TW_TEST_TMUX_LOG.output-generation"
    fi
    ;;
  display-message)
    if [ "$5" = '#{session_id}' ]; then
      printf '$0\n'
    elif [ -f "$TW_TEST_TMUX_LOG.output-pipe" ]; then printf '1\n'; else printf '0\n'; fi
    ;;
  pipe-pane)
    if [ "$2" = '-O' ]; then
      : > "$TW_TEST_TMUX_LOG.output-pipe"
    else
      rm -f "$TW_TEST_TMUX_LOG.output-pipe"
    fi
    ;;
esac
exit 0
`);
  chmodSync(fakeTmux, 0o755);

  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
  const controlSocket = join(root, "terminal-control.sock");
  const control = spawn(process.execPath, [cli, "terminal-control", "serve"], {
    env: {
      ...process.env,
      HOME: home,
      TW_TMUX: fakeTmux,
      TW_TEST_TMUX_LOG: tmuxLog,
      TW_TERMINAL_CONTROL_SOCKET: controlSocket,
    },
    stdio: "ignore",
  });
  t.after(() => {
    if (control.exitCode === null && control.signalCode === null) control.kill("SIGTERM");
  });
  const deadline = Date.now() + 2_000;
  while (!existsSync(controlSocket) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(controlSocket), true, "terminal-control test server did not start");
  const result = spawnSync(process.execPath, [cli, "rm", "tw-term-abc12"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TW_TMUX: fakeTmux,
      TW_TEST_TMUX_LOG: tmuxLog,
      TW_TERMINAL_CONTROL_SOCKET: controlSocket,
    },
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).sessions, []);
  assert.match(readFileSync(tmuxLog, "utf8"), /kill-session -t =tw-term-abc12/);
});

test("canonical worktree base expands on the target host and host paths retain remote tilde", () => {
  assert.equal(resolveWorktreeBase(undefined, "/home/dev"), "/home/dev/.tmux-worktree/worktrees");
  assert.equal(resolveWorktreeBase("~/worktrees", "/home/dev"), "/home/dev/worktrees");
  const config = normalizeConfig({
    hosts: {
      dev: {
        host: "devbox",
        identityFile: "~/.ssh/id_ed25519",
        worktreeBase: "~/worktrees",
        twPath: "~/.local/bin/tw",
      },
    },
  });
  assert.equal(config.hosts[0].id, "dev");
  assert.equal(config.hosts[0].label, "dev");
  assert.equal(config.hosts[0].worktreeBase, "~/worktrees");
  assert.equal(config.hosts[0].twPath, "~/.local/bin/tw");
});

test("rpc worktree creation records a dashboard-managed remote session", () => {
  const calls = [];
  const saved = [];
  const result = createManagedWorktreeSession(
    {
      aiCmd: "codex",
      projectDir: "/repo/app",
      sessionName: "app-fix",
      useWorktree: true,
      projectKey: "app",
      branch: "develop",
      worktreeBase: "/home/dev/.tmux-worktree/worktrees",
      profile: "dashboard",
      quiet: true,
    },
    {
      existsSync: (path) => path === "/repo/app",
      isGitRepo: () => true,
      gitQuery: () => "",
      exec: (bin, args) => calls.push([bin, args]),
      query: () => "",
      mkdirSync: (path) => calls.push(["mkdir", [path]]),
      tmuxBin: () => "tmux",
      sessionExists: (name) => name === "app-fix",
      randomId: () => "abc12",
      loadManagedState: () => ({ version: 1, sessions: [] }),
      saveManagedState: (state) => saved.push(state),
      setupClipboardBindings: () => calls.push(["setupClipboardBindings", []]),
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    },
  );

  assert.equal(result.session, "app-fix-1");
  assert.equal(result.workDir, "/home/dev/.tmux-worktree/worktrees/app/app-fix-1-abc12");
  assert.deepEqual(calls, [
    ["git", ["-C", "/repo/app", "fetch", "origin", "develop", "--quiet"]],
    ["mkdir", ["/home/dev/.tmux-worktree/worktrees/app"]],
    ["git", [
      "-C",
      "/repo/app",
      "worktree",
      "add",
      "-b",
      "app-fix-1-abc12",
      "/home/dev/.tmux-worktree/worktrees/app/app-fix-1-abc12",
      "origin/develop",
      "--quiet",
    ]],
    ["tmux", [
      "new-session",
      "-d",
      "-s",
      "app-fix-1",
      "-c",
      "/home/dev/.tmux-worktree/worktrees/app/app-fix-1-abc12",
      "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:$HOME/.kimi-code/bin\"; codex; exec \"${SHELL:-/bin/zsh}\" -l",
    ]],
    ["setupClipboardBindings", []],
  ]);
  assert.deepEqual(saved[0].sessions, [
    {
      name: "app-fix-1",
      kind: "worktree",
      profile: "dashboard",
      project: "app",
      repoPath: "/repo/app",
      worktreePath: "/home/dev/.tmux-worktree/worktrees/app/app-fix-1-abc12",
      branch: "app-fix-1-abc12",
      baseBranch: "develop",
      createdAt: "2026-07-02T00:00:00.000Z",
    },
  ]);
});

test("rpc terminal creation uses the shared single-pane contract and records managed state", () => {
  const calls = [];
  const records = [];
  const result = createManagedTerminalSession(
    {
      cwd: "/home/dev/src/app",
      aiCmd: "codex --quiet",
      profile: "dashboard",
      quiet: true,
    },
    {
      existsSync: (path) => path === "/home/dev/src/app",
      exec: (bin, args) => calls.push([bin, args]),
      tmuxBin: () => "tmux",
      sessionExists: () => false,
      randomId: () => "abc12",
      recordManagedSession: (record) => records.push(record),
      setupClipboardBindings: () => calls.push(["setupClipboardBindings", []]),
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    },
  );

  assert.deepEqual(result, { session: "tw-term-abc12", cwd: "/home/dev/src/app" });
  assert.deepEqual(calls, [
    ["tmux", [
      "new-session",
      "-d",
      "-s",
      "tw-term-abc12",
      "-c",
      "/home/dev/src/app",
      "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:$HOME/.kimi-code/bin\"; codex --quiet; exec \"${SHELL:-/bin/zsh}\" -l",
    ]],
    ["setupClipboardBindings", []],
  ]);
  assert.deepEqual(records, [{
    name: "tw-term-abc12",
    kind: "terminal",
    profile: "dashboard",
    cwd: "/home/dev/src/app",
    createdAt: "2026-07-12T00:00:00.000Z",
  }]);
});

test("managed terminal creation fails closed when state persistence fails", () => {
  const killed = [];
  assert.throws(
    () => createManagedTerminalSession(
      { cwd: "/repo/app", profile: "dashboard", quiet: true },
      {
        existsSync: () => true,
        exec: () => {},
        tmuxBin: () => "tmux",
        sessionExists: () => false,
        randomId: () => "abc12",
        recordManagedSession: () => { throw new Error("disk full"); },
        killSession: (name) => killed.push(name),
        setupClipboardBindings: () => {},
      },
    ),
    /已回滚 terminal session: disk full/,
  );
  assert.deepEqual(killed, ["tw-term-abc12"]);
});

test("managed worktree creation fails closed and rolls back every created resource when state persistence fails", () => {
  const calls = [];
  const removedWorktrees = [];
  const removedBranches = [];
  assert.throws(
    () => createManagedWorktreeSession(
      {
        aiCmd: "codex",
        projectDir: "/repo/app",
        sessionName: "app-fix",
        useWorktree: true,
        worktreeBase: "/worktrees",
        projectKey: "app",
        branch: "main",
        profile: "dashboard",
        quiet: true,
      },
      {
        existsSync: () => true,
        isGitRepo: () => true,
        gitQuery: () => "",
        exec: (bin, args) => calls.push([bin, args]),
        mkdirSync: () => {},
        tmuxBin: () => "tmux",
        sessionExists: () => false,
        randomId: () => "abc12",
        recordManagedSession: () => { throw new Error("disk full"); },
        setupClipboardBindings: () => {},
        removeWorktree: (repo, path, force) => removedWorktrees.push([repo, path, force]),
        deleteBranch: (repo, branch, force) => {
          removedBranches.push([repo, branch, force]);
          return true;
        },
      },
    ),
    /写入 TW state 失败，已回滚 tmux\/worktree\/branch: disk full/,
  );
  assert.deepEqual(calls.at(-1), ["tmux", ["kill-session", "-t", "=app-fix"]]);
  assert.deepEqual(removedWorktrees, [["/repo/app", "/worktrees/app/app-fix-abc12", true]]);
  assert.deepEqual(removedBranches, [["/repo/app", "app-fix-abc12", true]]);
});

test("managed worktree rollback attempts branch cleanup and reports every incomplete step", () => {
  const attempted = [];
  assert.throws(
    () => createManagedWorktreeSession(
      {
        aiCmd: "codex",
        projectDir: "/repo/app",
        sessionName: "app-fix",
        useWorktree: true,
        worktreeBase: "/worktrees",
        projectKey: "app",
        branch: "main",
        profile: "dashboard",
        quiet: true,
      },
      {
        existsSync: () => true,
        isGitRepo: () => true,
        gitQuery: () => "",
        exec: () => {},
        mkdirSync: () => {},
        tmuxBin: () => "tmux",
        sessionExists: () => false,
        randomId: () => "abc12",
        recordManagedSession: () => { throw new Error("state denied"); },
        killSession: (session) => attempted.push(["kill", session]),
        setupClipboardBindings: () => {},
        removeWorktree: (_repo, path) => {
          attempted.push(["worktree", path]);
          throw new Error("worktree busy");
        },
        deleteBranch: (_repo, branch) => {
          attempted.push(["branch", branch]);
          return false;
        },
      },
    ),
    (error) => {
      assert.match(error.message, /写入 TW state 失败: state denied/);
      assert.match(error.message, /回滚不完整/);
      assert.match(error.message, /删除 worktree .*worktree busy/);
      assert.match(error.message, /删除分支 app-fix-abc12 失败/);
      return true;
    },
  );
  assert.deepEqual(attempted, [
    ["kill", "app-fix"],
    ["worktree", "/worktrees/app/app-fix-abc12"],
    ["branch", "app-fix-abc12"],
  ]);
});

test("managed worktree rollback preserves the checkout when tmux could not be stopped", () => {
  const cleanupAttempts = [];
  assert.throws(
    () => createManagedWorktreeSession(
      {
        aiCmd: "codex",
        projectDir: "/repo/app",
        sessionName: "app-fix",
        useWorktree: true,
        worktreeBase: "/worktrees",
        projectKey: "app",
        branch: "main",
        profile: "dashboard",
        quiet: true,
      },
      {
        existsSync: () => true,
        isGitRepo: () => true,
        gitQuery: () => "",
        exec: () => {},
        mkdirSync: () => {},
        tmuxBin: () => "tmux",
        sessionExists: () => false,
        randomId: () => "abc12",
        recordManagedSession: () => { throw new Error("state denied"); },
        killSession: () => { throw new Error("tmux transport failed"); },
        setupClipboardBindings: () => {},
        removeWorktree: () => cleanupAttempts.push("worktree"),
        deleteBranch: () => cleanupAttempts.push("branch"),
      },
    ),
    (error) => {
      assert.match(error.message, /停止 tmux session app-fix 失败: tmux transport failed/);
      assert.match(error.message, /保留 worktree .*避免删除仍可能被 tmux 使用的目录/);
      return true;
    },
  );
  assert.deepEqual(cleanupAttempts, []);
});

test("orphan restore validates the git entry and records the actual collision-free session", () => {
  const calls = [];
  const records = [];
  const result = restoreManagedWorktreeSession(
    {
      worktreePath: "/home/dev/.tmux-worktree/worktrees/app/app-fix-abc12",
      sessionName: "app-fix",
      aiCmd: "codex",
      profile: "dashboard",
      quiet: true,
    },
    {
      existsSync: (path) => path === "/home/dev/.tmux-worktree/worktrees/app/app-fix-abc12"
        || path === "/home/dev/.tmux-worktree/worktrees/app/app-fix-abc12/.git",
      isGitRepo: () => true,
      gitQuery: (_path, args) => {
        if (args[0] === "branch") return "app-fix-abc12";
        if (args.includes("--git-common-dir")) return "/home/dev/src/app/.git";
        return "";
      },
      exec: (bin, args) => calls.push([bin, args]),
      tmuxBin: () => "tmux",
      sessionExists: (name) => name === "app-fix",
      recordManagedSession: (record) => records.push(record),
      setupClipboardBindings: () => {},
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    },
  );

  assert.equal(result.session, "app-fix-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].includes("split-window"), false);
  assert.deepEqual(records, [{
    name: "app-fix-1",
    kind: "worktree",
    profile: "dashboard",
    project: "app",
    repoPath: "/home/dev/src/app",
    worktreePath: "/home/dev/.tmux-worktree/worktrees/app/app-fix-abc12",
    branch: "app-fix-abc12",
    cwd: "/home/dev/.tmux-worktree/worktrees/app/app-fix-abc12",
    createdAt: "2026-07-12T00:00:00.000Z",
  }]);
});

test("CLI git-repository paths create a managed single-pane worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-cli-path-worktree-"));
  const home = join(root, "home");
  const origin = join(root, "origin.git");
  const repo = join(root, "sample-app");
  const worktreeBase = join(root, "worktrees");
  const fakeTmux = join(root, "tmux");
  const tmuxLog = join(root, "tmux.log");
  const tmuxSession = join(root, "tmux.session");
  const tmuxInstance = join(root, "tmux.instance");
  const tmuxOutput = join(root, "tmux.output");
  const tmuxPipe = join(root, "tmux.pipe");
  mkdirSync(home, { recursive: true });

  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "ignore" });
  execFileSync("git", ["clone", origin, repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "tw-test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "TW Test"]);
  writeFileSync(join(repo, "README.md"), "# sample\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });

  writeFileSync(
    join(home, ".tmux-worktree.json"),
    JSON.stringify({ projects: {}, worktreeBase }, null, 2),
  );
  writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_TMUX_LOG"
if [ "$1" = "has-session" ]; then
  for arg in "$@"; do target="$arg"; done
  target="$(printf '%s' "$target" | sed 's/^=//')"
  test -f "$TW_TEST_TMUX_SESSION" && grep -Fqx "$target" "$TW_TEST_TMUX_SESSION"
  exit $?
fi
if [ "$1" = "new-session" ]; then
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "-s" ]; then printf '%s\\n' "$arg" >> "$TW_TEST_TMUX_SESSION"; break; fi
    previous="$arg"
  done
  exit 0
fi
if [ "$1" = "list-sessions" ]; then
  if [ ! -f "$TW_TEST_TMUX_SESSION" ]; then printf '%s\\n' "no server running" >&2; exit 1; fi
  while IFS= read -r name; do printf '%s\\037%s\\n' "$name" '$1'; done < "$TW_TEST_TMUX_SESSION"
  exit 0
fi
if [ "$1" = "show-options" ]; then
  for arg in "$@"; do last="$arg"; done
  case "$last" in
    *@tw_terminal_control_instance_v1)
      if [ -f "$TW_TEST_TMUX_INSTANCE" ]; then cat "$TW_TEST_TMUX_INSTANCE"; exit 0; fi
      ;;
    *@tw_terminal_control_output_generation_v1)
      if [ -f "$TW_TEST_TMUX_OUTPUT" ]; then cat "$TW_TEST_TMUX_OUTPUT"; exit 0; fi
      ;;
  esac
  printf '%s\\n' "unknown option" >&2
  exit 1
fi
if [ "$1" = "set-option" ]; then
  for arg in "$@"; do last="$arg"; done
  case "$*" in
    *@tw_terminal_control_instance_v1*) printf '%s\\n' "$last" > "$TW_TEST_TMUX_INSTANCE" ;;
    *@tw_terminal_control_output_generation_v1*) printf '%s\\n' "$last" > "$TW_TEST_TMUX_OUTPUT" ;;
  esac
  exit 0
fi
if [ "$1" = "list-panes" ]; then
  printf '0\\037%%1\\n'
  exit 0
fi
if [ "$1" = "display-message" ]; then
  if [ -f "$TW_TEST_TMUX_PIPE" ]; then printf '1\\n'; else printf '0\\n'; fi
  exit 0
fi
if [ "$1" = "pipe-pane" ]; then
  if [ "$2" = "-O" ]; then : > "$TW_TEST_TMUX_PIPE"; else rm -f "$TW_TEST_TMUX_PIPE"; fi
  exit 0
fi
exit 0
`);
  chmodSync(fakeTmux, 0o755);

  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cli, "codex", repo, "fix", "--branch", "main"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        TMUX: "",
        TW_TMUX: fakeTmux,
        TW_TEST_TMUX_LOG: tmuxLog,
        TW_TEST_TMUX_SESSION: tmuxSession,
        TW_TEST_TMUX_INSTANCE: tmuxInstance,
        TW_TEST_TMUX_OUTPUT: tmuxOutput,
        TW_TEST_TMUX_PIPE: tmuxPipe,
      },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(readFileSync(join(home, ".tmux-worktree", "state.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].name, "sample-app-fix");
  assert.equal(state.sessions[0].kind, "worktree");
  assert.equal(state.sessions[0].profile, "cli");
  assert.equal(state.sessions[0].project, "sample-app");
  assert.equal(state.sessions[0].repoPath, repo);
  assert.match(state.sessions[0].branch, /^sample-app-fix-[0-9a-f]{5}$/);
  assert.equal(state.sessions[0].worktreePath, join(worktreeBase, "sample-app", state.sessions[0].branch));
  assert.equal(existsSync(join(state.sessions[0].worktreePath, ".git")), true);

  const calls = readFileSync(tmuxLog, "utf8");
  assert.match(calls, /new-session -d -s sample-app-fix -c /);
  assert.match(calls, /attach-session -r -f ignore-size -t =sample-app-fix/);
  assert.doesNotMatch(calls, /split-window| status(?: |$)/);

  const insideTmux = spawnSync(
    process.execPath,
    [cli, "codex", repo, "inside", "--branch", "main"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        TMUX: "/tmp/existing-tmux,1,0",
        TW_TMUX: fakeTmux,
        TW_TEST_TMUX_LOG: tmuxLog,
        TW_TEST_TMUX_SESSION: tmuxSession,
        TW_TEST_TMUX_INSTANCE: tmuxInstance,
        TW_TEST_TMUX_OUTPUT: tmuxOutput,
        TW_TEST_TMUX_PIPE: tmuxPipe,
      },
      timeout: 10_000,
    },
  );
  assert.notEqual(insideTmux.status, 0);
  assert.match(insideTmux.stderr, /sample-app-inside.*已创建并保留.*受控 attach/);
  const afterInside = JSON.parse(readFileSync(join(home, ".tmux-worktree", "state.json"), "utf8"));
  assert.equal(afterInside.sessions.some((session) => session.name === "sample-app-inside"), true);
  assert.doesNotMatch(readFileSync(tmuxLog, "utf8"), /switch-client -t sample-app-inside/);
});

test("tw rpc create-terminal is headless, machine-readable, and discoverable through managed state", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-rpc-terminal-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const fakeTmux = join(root, "tmux");
  const tmuxLog = join(root, "tmux.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_TMUX_LOG"
if [ "$1" = "has-session" ]; then exit 1; fi
exit 0
`);
  chmodSync(fakeTmux, 0o755);
  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    cli,
    "rpc",
    "create-terminal",
    "--cwd",
    cwd,
    "--ai-command",
    "codex --quiet",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TW_TMUX: fakeTmux,
      TW_TEST_TMUX_LOG: tmuxLog,
    },
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.kind, "terminal");
  assert.match(response.session, /^tw-term-[0-9a-f]{5}$/);
  assert.equal(response.cwd, cwd);
  const state = JSON.parse(readFileSync(join(home, ".tmux-worktree", "state.json"), "utf8"));
  assert.deepEqual(state.sessions[0], {
    name: response.session,
    kind: "terminal",
    profile: "dashboard",
    cwd,
    createdAt: state.sessions[0].createdAt,
  });
  const calls = readFileSync(tmuxLog, "utf8");
  assert.match(calls, new RegExp(`new-session -d -s ${response.session} -c `));
  assert.doesNotMatch(calls, /split-window/);
});

test("CLI rejects non-git path targets before creating tmux or managed state", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-cli-non-git-path-"));
  const home = join(root, "home");
  const plainDir = join(root, "plain-directory");
  const fakeTmux = join(root, "tmux");
  const tmuxLog = join(root, "tmux.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_TMUX_LOG"
exit 0
`);
  chmodSync(fakeTmux, 0o755);

  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "codex", plainDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TMUX: "",
      TW_TMUX: fakeTmux,
      TW_TEST_TMUX_LOG: tmuxLog,
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /目录不是 git 仓库/);
  assert.match(result.stderr, /只创建 managed git worktree/);
  assert.doesNotMatch(result.stdout, /开始初始化|添加项目/);
  assert.equal(existsSync(join(home, ".tmux-worktree.json")), false);
  assert.equal(existsSync(join(home, ".tmux-worktree", "state.json")), false);
  assert.equal(existsSync(tmuxLog), false);
});

test("headless tw with no arguments prints help instead of opening the TTY wizard", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-headless-help-"));
  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    env: { ...process.env, HOME: root },
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tw — tmux \+ git worktree/);
  assert.doesNotMatch(result.stdout, /开始初始化|项目名称:/);
  assert.equal(existsSync(join(root, ".tmux-worktree.json")), false);
});

test("CLI and Dashboard provenance use the same single-pane session contract", () => {
  const capture = (profile) => {
    const calls = [];
    createManagedWorktreeSession(
      {
        aiCmd: "codex --quiet",
        projectDir: "/repo/app",
        sessionName: "app-fix",
        useWorktree: false,
        worktreeBase: "/unused",
        profile,
        quiet: true,
      },
      {
        existsSync: () => true,
        exec: (bin, args) => calls.push([bin, args]),
        tmuxBin: () => "tmux",
        sessionExists: () => false,
        setupClipboardBindings: () => calls.push(["setupClipboardBindings", []]),
      },
    );
    return calls;
  };

  const cliCalls = capture("cli");
  const dashboardCalls = capture("dashboard");
  assert.deepEqual(cliCalls, dashboardCalls);
  assert.deepEqual(cliCalls, [
    ["tmux", [
      "new-session",
      "-d",
      "-s",
      "app-fix",
      "-c",
      "/repo/app",
      "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:$HOME/.kimi-code/bin\"; codex --quiet; exec \"${SHELL:-/bin/zsh}\" -l",
    ]],
    ["setupClipboardBindings", []],
  ]);
  assert.equal(cliCalls.some(([, args]) => args.includes("split-window")), false);
  assert.equal(cliCalls.some(([, args]) => args.some((arg) => String(arg).includes(" status"))), false);
});

test("tw status remains a one-shot alias and legacy live sessions stay attachable", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-status-contract-"));
  const fakeTmux = join(root, "tmux");
  const callLog = join(root, "tmux.log");
  writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_TMUX_LOG"
case "$1" in
  list-sessions)
    printf 'legacy-cli\\0370\\0371\\0371760000000\\0371760000100\\037/tmp/legacy-worktree\\n'
    ;;
  has-session)
    exit 0
    ;;
esac
exit 0
`);
  chmodSync(fakeTmux, 0o755);
  const env = {
    ...process.env,
    HOME: root,
    TMUX: "",
    TW_TMUX: fakeTmux,
    TW_TEST_TMUX_LOG: callLog,
  };
  const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));

  const status = spawnSync(process.execPath, [cli, "status", "--once"], {
    encoding: "utf8",
    env,
    timeout: 2_000,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /legacy-cli/);
  assert.doesNotMatch(status.stdout, /\x1b\[\?1049h|q quit/);

  const attach = spawnSync(process.execPath, [cli, "attach", "legacy-cli"], {
    encoding: "utf8",
    env,
    timeout: 2_000,
  });
  assert.equal(attach.status, 0, attach.stderr);
  const calls = readFileSync(callLog, "utf8");
  assert.match(calls, /has-session -t =legacy-cli/);
  assert.match(calls, /attach -t legacy-cli/);
});
