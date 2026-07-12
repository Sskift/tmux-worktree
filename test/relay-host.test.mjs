import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const {
  isManagedWorktreeRow,
  isRpcManagedTerminalSession,
  isRpcManagedWorktreeSession,
  isUnsupportedRpcListFailure,
  isLegacyKillRpcFailure,
  dashboardTerminalRecord,
  liveDashboardTerminalName,
  mutateTerminalRegistry,
  parseDashboardTerminalPayload,
  parseRpcCreateWorktreeResponse,
  parseRpcCreateTerminalResponse,
  persistCreatedTerminalMetadata,
  projectNameFromTwWorktreePath,
  remoteAttachCommand,
  relaySshConnectionArgs,
  sessionNameFromTwWorktreeDir,
  writeTerminalRegistryAtomic,
} = await import("../dist/relayHost.js");

test("relay SSH argv reuses the host ControlMaster and keepalive contract", () => {
  const args = relaySshConnectionArgs({
    id: "build-box",
    host: "build.example.com",
    user: "builder",
    port: 2222,
    identityFile: "/keys/build key",
  });

  for (const option of [
    "BatchMode=yes",
    "StrictHostKeyChecking=accept-new",
    "ConnectTimeout=5",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
    "ControlMaster=auto",
    "ControlPersist=600",
  ]) {
    assert.ok(args.includes(option), `missing SSH option ${option}`);
  }
  const controlPath = args.find((arg) => arg.startsWith("ControlPath="));
  assert.match(controlPath, /\.tmux-worktree\/ssh\/%C$/);
  const controlDirectory = controlPath.slice("ControlPath=".length).replace(/\/%C$/, "");
  assert.equal(statSync(controlDirectory).mode & 0o777, 0o700);
  assert.deepEqual(args.slice(-8), [
    "-p", "2222",
    "-l", "builder",
    "-i", "/keys/build key",
    "--", "build.example.com",
  ]);
});

test("relay create-terminal accepts only the v1 managed response and keeps canonical cwd", () => {
  const canonicalCwd = "/srv/canonical workspace";
  assert.deepEqual(parseRpcCreateTerminalResponse(JSON.stringify({
    protocolVersion: 1,
    kind: "terminal",
    session: "tw-term-a1b2c",
    cwd: canonicalCwd,
  })), {
    protocolVersion: 1,
    kind: "terminal",
    session: "tw-term-a1b2c",
    cwd: canonicalCwd,
  });

  const invalid = [
    "not-json",
    JSON.stringify([]),
    JSON.stringify({ kind: "terminal", session: "tw-term-a1b2c", cwd: canonicalCwd }),
    JSON.stringify({ protocolVersion: 2, kind: "terminal", session: "tw-term-a1b2c", cwd: canonicalCwd }),
    JSON.stringify({ protocolVersion: 1, kind: "worktree", session: "tw-term-a1b2c", cwd: canonicalCwd }),
    JSON.stringify({ protocolVersion: 1, kind: "terminal", session: "legacy-terminal", cwd: canonicalCwd }),
    JSON.stringify({ protocolVersion: 1, kind: "terminal", session: "tw-term-a:b", cwd: canonicalCwd }),
    JSON.stringify({ protocolVersion: 1, kind: "terminal", session: "tw-term-a1b2c", cwd: "" }),
    JSON.stringify({ protocolVersion: 1, kind: "terminal", session: "tw-term-a1b2c", cwd: "/tmp/\0bad" }),
  ];
  for (const response of invalid) {
    assert.throws(() => parseRpcCreateTerminalResponse(response));
  }
});

test("relay create-worktree accepts only a complete v1 managed response", () => {
  const response = {
    protocolVersion: 1,
    kind: "worktree",
    session: "demo-fix",
    worktreePath: "/srv/worktrees/demo-fix-a1b2c",
    branch: "demo-fix-a1b2c",
  };
  assert.deepEqual(parseRpcCreateWorktreeResponse(JSON.stringify(response)), response);
  assert.equal(parseRpcCreateWorktreeResponse(JSON.stringify({
    ...response,
    session: "修复 登录 flow",
  })).session, "修复 登录 flow");

  for (const invalid of [
    "not-json",
    JSON.stringify([]),
    JSON.stringify({ ...response, protocolVersion: 2 }),
    JSON.stringify({ ...response, kind: "terminal" }),
    JSON.stringify({ ...response, session: "remote:demo" }),
    JSON.stringify({ ...response, session: "bad\nsession" }),
    JSON.stringify({ ...response, worktreePath: "" }),
    JSON.stringify({ ...response, branch: 42 }),
  ]) {
    assert.throws(() => parseRpcCreateWorktreeResponse(invalid));
  }
});

test("relay treats Dashboard terminal metadata as scoped best-effort decoration", () => {
  const remote = dashboardTerminalRecord(
    { id: "build-box", kind: "ssh" },
    "tw-term-a1b2c",
    "/srv/project",
    "build shell",
  );
  assert.equal(remote.hostId, "build-box");
  assert.equal(remote.rawName, "tw-term-a1b2c");
  assert.equal(remote.tmuxName, "build-box:tw-term-a1b2c");

  const parsed = parseDashboardTerminalPayload([
    remote,
    null,
    7,
    { tmuxName: 9 },
    { rawName: "tw-term-b2c3d", hostId: { invalid: true } },
    { rawName: "tw-term-c3d4e", cwd: "/valid" },
  ]);
  assert.deepEqual(parsed.map((terminal) => terminal.rawName), ["tw-term-a1b2c", "tw-term-c3d4e"]);
  assert.deepEqual(parseDashboardTerminalPayload({ not: "an array" }), []);

  const live = new Set(["tw-term-a1b2c"]);
  assert.equal(liveDashboardTerminalName(remote, "build-box", new Set(), live), "tw-term-a1b2c");
  assert.equal(liveDashboardTerminalName(remote, "local", new Set(), live), null);
  assert.equal(liveDashboardTerminalName(remote, "build-box", new Set(), new Set()), null);
  assert.equal(liveDashboardTerminalName(remote, "build-box", new Set(["tw-term-a1b2c"]), live), null);
});

test("relay terminal registry writes atomically and preserves the previous file on rename failure", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-registry-"));
  const registry = join(root, "terminals.json");
  try {
    writeTerminalRegistryAtomic([{ id: "one", cwd: "/one", managed: true }], registry);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), [{ id: "one", cwd: "/one", managed: true }]);
    assert.equal(statSync(registry).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root), ["terminals.json"]);

    const before = readFileSync(registry, "utf8");
    assert.throws(() => writeTerminalRegistryAtomic(
      [{ id: "two", cwd: "/two", managed: true }],
      registry,
      { rename: () => { throw new Error("simulated rename failure"); } },
    ), /simulated rename failure/);
    assert.equal(readFileSync(registry, "utf8"), before);
    assert.deepEqual(readdirSync(root), ["terminals.json"]);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay serializes terminal registry mutations with the shared lock", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-registry-lock-"));
  const registry = join(root, "terminals.json");
  try {
    writeTerminalRegistryAtomic([{ rawName: "tw-term-first" }], registry);
    mutateTerminalRegistry(
      (current) => [...current, { rawName: "tw-term-second" }],
      registry,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(registry, "utf8")).map((terminal) => terminal.rawName),
      ["tw-term-first", "tw-term-second"],
    );
    assert.equal(existsSync(`${registry}.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay compensates a terminal registry failure through the managed-session rollback", async () => {
  let rollbackCalls = 0;
  await assert.rejects(persistCreatedTerminalMetadata(
    () => { throw new Error("registry unavailable"); },
    async () => { rollbackCalls += 1; },
  ), /TW-managed session was rolled back.*registry unavailable/);
  assert.equal(rollbackCalls, 1);

  await assert.rejects(persistCreatedTerminalMetadata(
    () => { throw new Error("registry unavailable"); },
    async () => { throw new Error("rpc kill failed"); },
  ), /failed to roll back TW-managed session: rpc kill failed/);
});

test("relay uses RPC lifecycle for managed kills while retaining legacy tmux fallback", () => {
  const source = readFileSync(new URL("../src/relayHost.ts", import.meta.url), "utf8");

  assert.match(source, /const canonicalCwd = parsed\.cwd/);
  assert.match(source, /registerDashboardTerminal\(scope, name, canonicalCwd, label\)/);
  assert.match(source, /\["rpc", "kill-session", "--name", rawName\]/);
  assert.match(source, /if \(managedHint === true\) \{\s*await killManagedSession\(scope, rawName\)/s);
  assert.match(source, /if \(!isLegacyKillRpcFailure\(commandExitStatus\(error\), output\)\) throw error/);
  assert.match(source, /await killManagedSession\(scope, rawName\)/);
  assert.match(source, /await killLegacyTmuxSession\(scope, rawName\)/);
  assert.match(source, /bestEffortUnregisterDashboardTerminal\(scope, rawName\)/);
  assert.match(source, /killSession\(message\.session, message\.managed\)/);
  assert.match(source, /flag: "wx"/);
});

test("relay only treats explicit old-host RPC incompatibility as a legacy catalog", () => {
  assert.equal(isUnsupportedRpcListFailure(1, "unknown command: rpc"), true);
  assert.equal(isUnsupportedRpcListFailure(2, "unrecognized subcommand 'rpc'"), true);
  assert.equal(isUnsupportedRpcListFailure(1, "rpc is unsupported by this version"), true);
  assert.equal(isUnsupportedRpcListFailure(1, "未知命令 rpc"), true);

  assert.equal(isUnsupportedRpcListFailure(255, "ssh: connection reset"), false);
  assert.equal(isUnsupportedRpcListFailure(1, "managed state JSON is corrupt"), false);
  assert.equal(isUnsupportedRpcListFailure(1, "rpc list failed: managed state version is unsupported"), false);
  assert.equal(isUnsupportedRpcListFailure(undefined, "spawn tw ENOENT"), false);
  assert.equal(isUnsupportedRpcListFailure(0, "unknown command: rpc"), false);

  assert.equal(isLegacyKillRpcFailure(1, "session is not TW-managed: old-shell"), true);
  assert.equal(isLegacyKillRpcFailure(2, "unknown rpc command: kill-session"), true);
  assert.equal(isLegacyKillRpcFailure(127, "tw: command not found"), true);
  assert.equal(isLegacyKillRpcFailure(1, "managed state JSON is corrupt"), false);
  assert.equal(isLegacyKillRpcFailure(255, "ssh: connection reset"), false);
});

test("relay host fallback only accepts TW-shaped managed worktree sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-host-"));
  try {
    const base = join(root, "worktrees");
    const project = join(base, "demo");
    const managed = join(project, "demo-task-abc12");
    const noSuffix = join(project, "demo-task");
    const terminalLike = join(project, "tw-term-shell-abc12");
    const outside = join(root, "other", "demo-task-abc12");
    for (const dir of [managed, noSuffix, terminalLike, outside]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".git"), "gitdir: /repo/.git/worktrees/test\n");
    }

    const scope = { id: "local", label: "local", kind: "local", worktreeBase: base };
    const row = (name, cwd) => ({
      name,
      cwd,
      attached: false,
      windows: 1,
      created: 1,
      activity: 1,
    });

    assert.equal(sessionNameFromTwWorktreeDir("demo-task-abc12"), "demo-task");
    assert.equal(projectNameFromTwWorktreePath(managed, base), "demo");
    assert.equal(projectNameFromTwWorktreePath("/home/dev/.tmux-worktree/worktrees/api/api-fix-abc12", "~/.tmux-worktree/worktrees"), "api");
    assert.equal(projectNameFromTwWorktreePath("/private/tmp/tmux-worktree/projects/legacy/legacy-task-abc12", "~/.tmux-worktree/worktrees"), "legacy");
    assert.equal(sessionNameFromTwWorktreeDir("demo-task"), null);
    assert.equal(isManagedWorktreeRow(scope, row("demo-task", managed)), true);
    assert.equal(isManagedWorktreeRow(scope, row("demo-task", noSuffix)), false);
    assert.equal(isManagedWorktreeRow(scope, row("tw-term-shell", terminalLike)), false);
    assert.equal(isManagedWorktreeRow(scope, row("demo-task", outside)), false);
    assert.equal(isManagedWorktreeRow(
      { id: "legacy", label: "legacy", kind: "ssh", worktreeBase: "~/.tmux-worktree/worktrees" },
      row("legacy-task", "/private/tmp/tmux-worktree/projects/legacy/legacy-task-abc12"),
    ), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay host merges managed RPC sessions with unseen legacy tmux rows", () => {
  const source = readFileSync(new URL("../src/relayHost.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /const rows = rpc \? \[\] :/);
  assert.match(source, /rows = scope\.kind === "local" \? await localTmuxRows\(scope\) : await remoteTmuxRows\(scope\)/);
  assert.match(source, /if \(seen\.has\(row\.name\)\) continue;/);
});

test("relay host accepts TW-managed CLI and Dashboard worktree profiles from rpc", () => {
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "dashboard", name: "dash" }), true);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "cli", name: "cli" }), true);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", name: "legacy" }), true);
  assert.equal(isRpcManagedWorktreeSession({ kind: "terminal", profile: "dashboard", name: "tw-term-1" }), false);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "unknown", name: "other" }), false);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "dashboard" }), false);

  assert.equal(isRpcManagedTerminalSession({ kind: "terminal", profile: "dashboard", name: "tw-term-a1b2c" }), true);
  assert.equal(isRpcManagedTerminalSession({ kind: "terminal", profile: "cli", name: "tw-term-b2c3d" }), true);
  assert.equal(isRpcManagedTerminalSession({ kind: "terminal", name: "tw-term-c3d4e" }), true);
  assert.equal(isRpcManagedTerminalSession({ kind: "terminal", profile: "unknown", name: "tw-term-d4e5f" }), false);
  assert.equal(isRpcManagedTerminalSession({ kind: "worktree", profile: "dashboard", name: "tw-term-e5f6a" }), false);
});

test("remote attach connects directly without creating a grouped mirror session", () => {
  const scope = { id: "mew-dev", label: "mew-dev", kind: "ssh", tmuxPath: "~/.local/bin/tmux" };
  const command = remoteAttachCommand(scope, "x-cloud", "0");
  assert.match(command, /export TERM=xterm-256color/);
  assert.match(command, /has-session -t '=x-cloud'/);
  assert.match(command, /set-option -g mouse on/);
  assert.match(command, /attach-session -t '=x-cloud'/);
  assert.doesNotMatch(command, /new-session/);
  assert.doesNotMatch(command, /kill-session/);
  assert.doesNotMatch(command, /tw-mobile-/);
});

test("dashboard remote terminal forwards wheel events as tmux mouse input", () => {
  const terminalSource = readFileSync(new URL("../app/src/Terminal.tsx", import.meta.url), "utf8");
  const terminalDeckSource = readFileSync(new URL("../app/src/dashboard/TerminalDeck.tsx", import.meta.url), "utf8");

  assert.match(terminalDeckSource, /set-option -g mouse on/);
  assert.match(terminalSource, /function sgrMouseWheel/);
  assert.match(terminalSource, /attachCustomWheelEventHandler\(handleRemoteWheel\)/);
  assert.match(terminalSource, /addEventListener\("wheel", onRemoteWheel/);
  assert.match(terminalSource, /WheelEvent\.DOM_DELTA_PIXEL/);
});

test("remote stream resize does not reference removed mobile mirror state", () => {
  const source = readFileSync(new URL("../src/relayHost.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /resize-pane[^`]+\\$\\{mobile\\}/s);
});

test("remote pty wrapper survives resize signal interruptions", () => {
  const source = readFileSync(new URL("../src/relayHost.ts", import.meta.url), "utf8");

  assert.match(source, /except InterruptedError:\n\s+continue/);
  assert.match(source, /if \(safeCols === lastResizeCols && safeRows === lastResizeRows\) return/);
});

test("relay host can reopen routed terminal streams after transient remote close", () => {
  const source = readFileSync(new URL("../src/relayHost.ts", import.meta.url), "utf8");

  assert.match(source, /type StreamRoute/);
  assert.match(source, /const streamRoutes = new Map<string, StreamRoute>\(\)/);
  assert.match(source, /streamRoutes\.set\(key, \{ clientId, streamId: message\.streamId, scope, rawName, pane: message\.pane \}\)/);
  assert.match(source, /reopenRoutedStream\(relaySocket, streams, opts, route, message\.data\)/);
  assert.match(source, /reopenRoutedStream\(relaySocket, streams, opts, route, undefined, \{ cols: message\.cols, rows: message\.rows \}\)/);
  assert.match(source, /child\.stdin\.on\("error", \(\) => \{\}\)/);
  assert.match(source, /const isCurrent = streams\.get\(key\) === stream/);
  assert.match(source, /if \(isCurrent\) sendJson\(relaySocket, \{ type: "terminal_exit"/);
  assert.match(source, /try \{\n\s+stream\.process\.stdin\.write\(payload\);/);
});

test("relay host publishes connection failures without exposing credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-status-"));
  const statusFile = join(root, "relay-status.json");
  const secret = "test-secret-must-not-leak";
  const child = spawn(process.execPath, [
    "dist/cli.js",
    "relay-host",
    "--relay",
    "ws://127.0.0.1:9",
    "--host-id",
    "test-host",
    "--status-file",
    statusFile,
  ], {
    env: { ...process.env, TW_RELAY_SECRET: secret, TW_TOKEN: "serve-token" },
    stdio: "ignore",
  });

  try {
    const deadline = Date.now() + 4000;
    let status;
    while (Date.now() < deadline) {
      if (existsSync(statusFile)) {
        status = JSON.parse(readFileSync(statusFile, "utf8"));
        if (status.state === "retrying") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status?.state, "retrying");
    assert.equal(status?.relayUrl, "ws://127.0.0.1:9");
    assert.equal(status?.hostId, "test-host");
    assert.equal(typeof status?.updatedAt, "number");
    assert.equal(typeof status?.retryInMs, "number");
    assert.equal(JSON.stringify(status).includes(secret), false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
