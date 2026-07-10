import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const {
  isManagedWorktreeRow,
  isRpcManagedWorktreeSession,
  projectNameFromTwWorktreePath,
  remoteAttachCommand,
  sessionNameFromTwWorktreeDir,
} = await import("../dist/relayHost.js");

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
    assert.equal(sessionNameFromTwWorktreeDir("demo-task"), null);
    assert.equal(isManagedWorktreeRow(scope, row("demo-task", managed)), true);
    assert.equal(isManagedWorktreeRow(scope, row("demo-task", noSuffix)), false);
    assert.equal(isManagedWorktreeRow(scope, row("tw-term-shell", terminalLike)), false);
    assert.equal(isManagedWorktreeRow(scope, row("demo-task", outside)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay host accepts TW-managed CLI and Dashboard worktree profiles from rpc", () => {
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "dashboard", name: "dash" }), true);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "cli", name: "cli" }), true);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", name: "legacy" }), true);
  assert.equal(isRpcManagedWorktreeSession({ kind: "terminal", profile: "dashboard", name: "tw-term-1" }), false);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "unknown", name: "other" }), false);
  assert.equal(isRpcManagedWorktreeSession({ kind: "worktree", profile: "dashboard" }), false);
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
  const appSource = readFileSync(new URL("../app/src/App.tsx", import.meta.url), "utf8");

  assert.match(appSource, /set-option -g mouse on/);
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

test("relay server keeps detailed host state behind authentication", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0);

  const secret = "relay-health-test-secret";
  const child = spawn(process.execPath, [
    "dist/cli.js",
    "relay-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    env: { ...process.env, TW_RELAY_SECRET: secret },
    stdio: "ignore",
  });

  try {
    const deadline = Date.now() + 4000;
    let healthResponse;
    while (Date.now() < deadline) {
      try {
        healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
        if (healthResponse.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await healthResponse?.json(), { ok: true });

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/hosts`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`http://127.0.0.1:${port}/api/hosts`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { ok: true, hosts: [] });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
