import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });
const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const hostsModuleUrl = new URL("../dist/hosts.js", import.meta.url);
const { acquireConfigFileLock, releaseConfigFileLock } = await import(hostsModuleUrl.href);

function runCli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...extraEnv },
    timeout: 10_000,
  });
}

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("tw host CRUD preserves unrelated config, remote tilde paths, and private file mode", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-crud-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const configPath = join(home, ".tmux-worktree.json");
  writeFileSync(configPath, JSON.stringify({
    projects: { app: "/repo/app" },
    mobileRelay: { relayUrl: "wss://relay.example", secret: "keep-me" },
    futureField: { enabled: true },
    hosts: [{ id: "legacy-alias", host: "legacy-alias", futureHostField: "keep-me-too" }],
  }, null, 2));

  const added = runCli(home, [
    "host", "add",
    "--id", "dev",
    "--host", "devbox.example",
    "--user", "alice",
    "--worktree-base", "~/worktrees",
    "--tw-path", "~/.local/bin/tw",
    "--json",
  ]);
  assert.equal(added.status, 0, added.stderr);
  const addedPayload = JSON.parse(added.stdout);
  assert.deepEqual(addedPayload.hosts.map((host) => host.id), ["legacy-alias", "dev"]);
  assert.equal(addedPayload.hosts[1].worktreeBase, "~/worktrees");
  assert.equal(addedPayload.hosts[1].twPath, "~/.local/bin/tw");

  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(raw.projects.app, "/repo/app");
  assert.equal(raw.mobileRelay.secret, "keep-me");
  assert.deepEqual(raw.futureField, { enabled: true });
  assert.equal(raw.hosts[0].futureHostField, "keep-me-too");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const updated = runCli(home, [
    "host", "update", "dev",
    "--port", "2222",
    "--clear", "user",
    "--json",
  ]);
  assert.equal(updated.status, 0, updated.stderr);
  const dev = JSON.parse(updated.stdout).hosts.find((host) => host.id === "dev");
  assert.equal(dev.port, 2222);
  assert.equal(dev.user, undefined);

  const removed = runCli(home, ["host", "rm", "dev", "--json"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout).hosts.map((host) => host.id), ["legacy-alias"]);
});

test("tw host rejects the reserved local ID from commands and config", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-reserved-local-"));
  const home = join(root, "home");
  const sshLog = join(root, "ssh.log");
  mkdirSync(home, { recursive: true });

  const added = runCli(home, ["host", "add", "--id", "LoCaL", "--host", "devbox", "--json"]);
  assert.notEqual(added.status, 0);
  assert.match(added.stderr, /host id 'local'.*保留字/);

  writeFileSync(join(home, ".tmux-worktree.json"), JSON.stringify({
    hosts: [{ id: "LOCAL", label: "Unsafe collision", host: "devbox" }],
  }));
  const listed = runCli(home, ["host", "ls", "--json"]);
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /host id 'local'.*保留字/);

  const rpc = runCli(home, ["host", "rpc", "LOCAL", "list"], {
    TW_TEST_SSH_LOG: sshLog,
  });
  assert.notEqual(rpc.status, 0);
  assert.match(rpc.stderr, /host id 'local'.*保留字/);
  assert.equal(existsSync(sshLog), false, "reserved IDs must fail before starting SSH");

});

test("tw host shares Dashboard SSH target and identity validation", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-shared-validation-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  const userAtHost = runCli(home, [
    "host", "add", "--id", "user-at-host", "--host", "alice@devbox", "--json",
  ]);
  assert.notEqual(userAtHost.status, 0);
  assert.match(userAtHost.stderr, /user@/);

  const leadingDashIdentity = runCli(home, [
    "host", "add", "--id", "dash-identity", "--host", "devbox",
    "--identity-file", "-unsafe", "--json",
  ]);
  assert.notEqual(leadingDashIdentity.status, 0);
  assert.match(leadingDashIdentity.stderr, /identity file.*不能以 '-' 开头/);
});

test("stale config lock owner cannot remove the replacement lock", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-lock-takeover-"));
  const lockPath = join(root, "config.lock");
  const first = acquireConfigFileLock(lockPath);
  const ownerPath = join(lockPath, "owner.json");
  const stale = JSON.parse(readFileSync(ownerPath, "utf8"));
  writeFileSync(ownerPath, `${JSON.stringify({ ...stale, createdAt: 0 })}\n`, { mode: 0o600 });

  const second = acquireConfigFileLock(lockPath);
  assert.notEqual(first.owner, second.owner);
  releaseConfigFileLock(first);
  assert.equal(existsSync(lockPath), true, "old owner must not remove the replacement lock");
  assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).owner, second.owner);

  releaseConfigFileLock(second);
  assert.equal(existsSync(lockPath), false, "current owner releases its own lock");
});

test("tw host mutation waits for a concurrent config lock owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-lock-concurrent-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const configPath = join(home, ".tmux-worktree.json");
  const lockPath = `${configPath}.lock`;
  const readyPath = join(root, "ready");
  writeFileSync(configPath, `${JSON.stringify({ hosts: [] })}\n`);

  const holderScript = `
    import { writeFileSync } from "node:fs";
    import { acquireConfigFileLock, releaseConfigFileLock } from ${JSON.stringify(hostsModuleUrl.href)};
    const [lockPath, readyPath] = process.argv.slice(-2);
    const lock = acquireConfigFileLock(lockPath);
    writeFileSync(readyPath, lock.owner);
    setTimeout(() => { releaseConfigFileLock(lock); }, 500);
  `;
  const holder = spawn(
    process.execPath,
    ["--input-type=module", "-e", holderScript, lockPath, readyPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const holderDone = new Promise((resolve) => holder.once("exit", resolve));
  await waitForFile(readyPath);

  const started = Date.now();
  const added = runCli(home, ["host", "add", "--id", "dev", "--host", "devbox", "--json"]);
  const elapsed = Date.now() - started;
  const holderExit = await holderDone;
  assert.equal(holderExit, 0);
  assert.equal(added.status, 0, added.stderr);
  assert.ok(elapsed >= 300, `mutation should wait for the holder, elapsed=${elapsed}ms`);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).hosts.map((host) => host.id), ["dev"]);
});

test("tw host probe separates SSH, tmux, and TW capability status and host rpc stays structured", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-probe-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "ssh.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".tmux-worktree.json"), JSON.stringify({
    hosts: [{
      id: "dev",
      label: "Dev",
      host: "devbox",
      user: "alice",
      tmuxPath: "~/.local/bin/tmux",
      twPath: "~/.local/bin/tw",
    }],
  }));
  const fakeSsh = join(bin, "ssh");
  writeFileSync(fakeSsh, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_SSH_LOG"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  true)
    exit 0
    ;;
  *tmux*"'-V'"*)
    if test "$TW_TEST_TMUX_UNAVAILABLE" = 1; then
      printf '%s\\n' 'tmux not found' >&2
      exit 127
    fi
    printf '%s\\n' 'tmux 3.5a'
    exit 0
    ;;
  *tw*"'version'"*)
    printf '%s\\n' '1.0.3'
    exit 0
    ;;
  *tw*"'rpc' 'capabilities'"*)
    if test "$TW_TEST_NO_KILL_SESSION" = 1; then
      printf '%s\\n' '{"protocolVersion":1,"app":"tmux-worktree","capabilities":["list","create-worktree","create-terminal"]}'
    else
      printf '%s\\n' '{"protocolVersion":1,"app":"tmux-worktree","capabilities":["list","create-worktree","create-terminal","kill-session","hard-timeout"]}'
    fi
    exit 0
    ;;
  *tw*"'rpc' 'list'"*)
    printf '%s\\n' '{"protocolVersion":1,"sessions":[]}'
    exit 0
    ;;
esac
printf 'unexpected ssh command: %s\\n' "$last" >&2
exit 12
`);
  chmodSync(fakeSsh, 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TW_TEST_SSH_LOG: log,
  };

  const probe = runCli(home, ["host", "probe", "dev", "--json"], env);
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout).results[0];
  assert.equal(result.ssh.reachable, true);
  assert.equal(result.tmux.available, true);
  assert.equal(result.tmux.version, "tmux 3.5a");
  assert.equal(result.tw.available, true);
  assert.equal(result.tw.compatible, true);
  assert.deepEqual(result.tw.capabilities, ["list", "create-worktree", "create-terminal", "kill-session", "hard-timeout"]);

  const missingKill = runCli(home, ["host", "probe", "dev", "--json"], {
    ...env,
    TW_TEST_NO_KILL_SESSION: "1",
  });
  assert.equal(missingKill.status, 1, missingKill.stderr);
  const missingKillResult = JSON.parse(missingKill.stdout).results[0];
  assert.equal(missingKillResult.tmux.available, true);
  assert.equal(missingKillResult.tw.compatible, false);
  assert.match(missingKillResult.tw.error, /missing a required RPC capability/);

  const missingTmux = runCli(home, ["host", "probe", "dev", "--json"], {
    ...env,
    TW_TEST_TMUX_UNAVAILABLE: "1",
  });
  assert.equal(missingTmux.status, 1, missingTmux.stderr);
  const missingTmuxResult = JSON.parse(missingTmux.stdout).results[0];
  assert.equal(missingTmuxResult.tmux.available, false);
  assert.equal(missingTmuxResult.tw.compatible, true);

  const remoteList = runCli(home, ["host", "rpc", "dev", "list"], env);
  assert.equal(remoteList.status, 0, remoteList.stderr);
  assert.deepEqual(JSON.parse(remoteList.stdout), { protocolVersion: 1, sessions: [] });

  const sshLog = readFileSync(log, "utf8");
  assert.match(sshLog, /ControlMaster=auto/);
  assert.match(sshLog, /ControlPath=.*%C/);
  assert.match(sshLog, /\$HOME\/\.local\/bin\/tw/);
});

test("tw host attach uses the remote terminal-control authority and never silently falls back", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-controlled-attach-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "ssh.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".tmux-worktree.json"), JSON.stringify({
    hosts: [{ id: "dev", label: "Dev", host: "devbox" }],
  }));
  const fakeSsh = join(bin, "ssh");
  writeFileSync(fakeSsh, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_SSH_LOG"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  true)
    exit 0
    ;;
  *tmux*"'-V'"*)
    printf '%s\\n' 'tmux 3.5a'
    exit 0
    ;;
  *tw*"'version'"*)
    printf '%s\\n' '1.0.5'
    exit 0
    ;;
  *tw*"'rpc' 'capabilities'"*)
    printf '%s\\n' '{"protocolVersion":1,"app":"tmux-worktree","capabilities":["list","create-worktree","create-terminal","kill-session","hard-timeout"]}'
    exit 0
    ;;
  *tw*"'terminal-control' 'resolve' 'managed-one'"*)
    if test "$TW_TEST_NO_TERMINAL_CONTROL" = 1; then
      printf '%s\\n' 'unknown command: terminal-control' >&2
      exit 2
    fi
    printf '%s\\n' 'target:test'
    exit 0
    ;;
  *tw*"'attach' 'managed-one'"*)
    exit 0
    ;;
  *tmux*"'attach-session' '-t' '=managed-one'"*)
    exit 0
    ;;
esac
printf 'unexpected ssh command: %s\\n' "$last" >&2
exit 12
`);
  chmodSync(fakeSsh, 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TW_TEST_SSH_LOG: log,
  };

  const controlled = runCli(home, ["host", "attach", "dev", "managed-one", "--take-over"], env);
  assert.equal(controlled.status, 0, controlled.stderr);
  let calls = readFileSync(log, "utf8");
  assert.match(calls, /'terminal-control' 'resolve' 'managed-one'/);
  assert.match(calls, /'attach' 'managed-one' '--take-over'/);
  assert.doesNotMatch(calls, /'attach-session' '-t' '=managed-one'/);

  writeFileSync(log, "");
  const unavailable = runCli(home, ["host", "attach", "dev", "managed-one"], {
    ...env,
    TW_TEST_NO_TERMINAL_CONTROL: "1",
  });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /terminal-control authority.*direct tmux/);
  calls = readFileSync(log, "utf8");
  assert.match(calls, /'terminal-control' 'resolve' 'managed-one'/);
  assert.doesNotMatch(calls, /'attach-session'|'attach' 'managed-one'/);

  writeFileSync(log, "");
  const bypass = runCli(home, ["host", "attach", "dev", "managed-one", "--privileged-bypass"], env);
  assert.equal(bypass.status, 0, bypass.stderr);
  assert.match(bypass.stderr, /--privileged-bypass.*input ownership lease/);
  calls = readFileSync(log, "utf8");
  assert.match(calls, /'attach-session' '-t' '=managed-one'/);
  assert.doesNotMatch(calls, /'terminal-control'|'rpc' 'capabilities'/);
});

test("tw host owns an isolated SSH ControlMaster lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-host-control-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "ssh.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".tmux-worktree.json"), JSON.stringify({
    hosts: [{ id: "dev", label: "Dev", host: "devbox" }],
  }));
  const fakeSsh = join(bin, "ssh");
  writeFileSync(fakeSsh, `#!/bin/sh
printf '%s\\n' "$*" >> "$TW_TEST_SSH_LOG"
case " $* " in
  *" -O check "*)
    if test -f "$TW_TEST_SSH_STATE"; then exit 0; else exit 1; fi
    ;;
  *" -M -N -f "*)
    : > "$TW_TEST_SSH_STATE"
    exit 0
    ;;
  *" -O exit "*)
    rm -f "$TW_TEST_SSH_STATE"
    exit 0
    ;;
esac
exit 12
`);
  chmodSync(fakeSsh, 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TW_TEST_SSH_LOG: log,
    TW_TEST_SSH_STATE: join(root, "connected"),
  };
  for (const [command, state] of [
    ["connect", "connected"],
    ["connection-status", "connected"],
    ["disconnect", "disconnected"],
  ]) {
    const run = runCli(home, ["host", command, "dev", "--json"], env);
    assert.equal(run.status, 0, `${command}: ${run.stderr}\n${run.stdout}`);
    assert.equal(JSON.parse(run.stdout).state, state);
  }
  const sshLog = readFileSync(log, "utf8");
  assert.match(sshLog, /ControlMaster=yes.* -M -N -f /);
  assert.match(sshLog, / -O check /);
  assert.match(sshLog, / -O exit /);
});
