import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 5_000,
  });
}

test("CLI help and version keep the public command surface stable", () => {
  const help = runCli(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, new RegExp(`tw — tmux \\+ git worktree \\+ AI 开发环境管理器  \\(v${version.replaceAll(".", "\\.")}\\)`));

  for (const line of [
    "tw <ai-command> <project|path> [session] [--branch <name>]",
    "tw ls",
    "tw attach <session>",
    "tw rm <session> [--worktree]",
    "tw worktree ls",
    "tw worktree rm <name|path> [--force]",
    "tw worktree prune [--dry-run] [--force]",
    "tw rpc list",
    "tw rpc create-worktree",
    "tw rpc create-terminal",
    "tw rpc restore-worktree",
    "tw rpc kill-session",
    "tw rpc capabilities",
    "tw host ls [--json]",
    "tw host add --id <id> --host <target>",
    "tw host update <id>",
    "tw host rm <id> [--json]",
    "tw host probe [id] [--json]",
    "tw host connect|connection-status|disconnect <id> [--json]",
    "tw host rpc <id> <rpc-command> [args...]",
    "tw host attach <id> <session>",
    "tw automation ls",
    "tw automation create",
    "tw automation rm <id|name>",
    "tw serve [--port N]",
    "tw relay-server",
    "tw relay-host",
    "tw setup",
    "tw doctor",
    "tw update",
    "tw version | -v",
    "tw help | -h",
  ]) {
    assert.ok(help.stdout.includes(line), `help is missing ${line}`);
  }

  for (const flag of ["-h", "--help"]) {
    const result = runCli([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, help.stdout);
  }

  for (const flag of ["version", "-v", "--version"]) {
    const result = runCli([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${version}\n`);
  }
});

test("unknown options preserve the concise error boundary and print help", () => {
  const result = runCli(["--definitely-unknown"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "未知选项: --definitely-unknown\n\n");
  assert.match(result.stdout, /tw — tmux \+ git worktree/);
  assert.doesNotMatch(result.stderr, /\bat\b.*cli\.cjs|Error:/);
});

test("rpc capabilities is one machine-readable JSON line with no stderr", () => {
  const result = runCli(["rpc", "capabilities"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocolVersion: 1,
    app: "tmux-worktree",
    capabilities: [
      "list",
      "managed-state",
      "hard-timeout",
      "create-worktree",
      "create-terminal",
      "restore-worktree",
      "kill-session",
    ],
  });
});
