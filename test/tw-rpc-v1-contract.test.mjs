import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const contractRoot = new URL("../contracts/tw-rpc/v1/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", contractRoot), "utf8"));
const cases = JSON.parse(readFileSync(new URL("cases.json", contractRoot), "utf8"));
const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const rpc = await import("../dist/rpc.js");

function runCli(argv) {
  return spawnSync(process.execPath, [cli, ...argv], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 5_000,
  });
}

function successCase(id) {
  const fixture = cases.success.find((candidate) => candidate.id === id);
  assert.ok(fixture, `missing TW RPC fixture ${id}`);
  return fixture;
}

test("TW RPC v1 manifest freezes the headless command surface", () => {
  assert.deepEqual(manifest, {
    contract: "tmux-worktree-tw-rpc-v1",
    version: 1,
    status: "frozen",
    transport: "utf-8-json-line-on-stdout",
    commands: [
      "capabilities",
      "list",
      "create-worktree",
      "create-terminal",
      "restore-worktree",
      "kill-session",
    ],
    fixture: "cases.json",
  });
  assert.equal(rpc.RPC_PROTOCOL_VERSION, manifest.version);
  assert.deepEqual(cases.success.map((fixture) => fixture.command), manifest.commands);
  assert.equal(new Set(cases.success.map((fixture) => fixture.id)).size, cases.success.length);
});

test("TW RPC v1 success fixtures are exact single-line JSON stdout contracts", () => {
  for (const fixture of cases.success) {
    assert.equal(fixture.exitCode, 0, fixture.id);
    assert.equal(fixture.stderr, "", fixture.id);
    assert.equal(fixture.stdout, `${JSON.stringify(fixture.normalized)}\n`, fixture.id);
    assert.equal(fixture.stdout.trim().split("\n").length, 1, fixture.id);
    assert.deepEqual(JSON.parse(fixture.stdout), fixture.normalized, fixture.id);
  }
});

test("TW RPC v1 capabilities and list builders conform to the frozen wire", () => {
  const capabilities = successCase("capabilities");
  assert.deepEqual(rpc.buildRpcCapabilitiesResponse(), capabilities.normalized);
  const result = runCli(capabilities.argv);
  assert.equal(result.status, capabilities.exitCode);
  assert.equal(result.stdout, capabilities.stdout);
  assert.equal(result.stderr, capabilities.stderr);

  const list = successCase("list-live-managed-only");
  assert.deepEqual(
    rpc.buildRpcListResponse(list.input.state, list.input.liveSessions),
    list.normalized,
  );
});

test("TW RPC v1 argv parsers preserve requests and optional omission", () => {
  const parserByCommand = {
    "create-worktree": rpc.parseRpcCreateWorktreeArgs,
    "create-terminal": rpc.parseRpcCreateTerminalArgs,
    "restore-worktree": rpc.parseRpcRestoreWorktreeArgs,
    "kill-session": rpc.parseRpcKillSessionArgs,
  };
  for (const fixture of cases.success.filter((candidate) => candidate.request)) {
    assert.deepEqual(
      parserByCommand[fixture.command](fixture.argv.slice(2)),
      fixture.request,
      fixture.id,
    );
  }

  const terminal = successCase("create-terminal-without-ai-command");
  assert.equal(Object.hasOwn(terminal.request, "aiCommand"), false);
  const restored = successCase("restore-worktree-optional-branch-omitted");
  assert.equal(Object.hasOwn(restored.normalized, "branch"), false);
});

test("TW RPC v1 managed kill builder conforms without bypassing record identity", () => {
  const fixture = successCase("kill-live-managed-session");
  const calls = [];
  const response = rpc.buildRpcKillSessionResponse(fixture.request, {
    loadState: () => fixture.input.state,
    exists: () => fixture.input.live,
    kill: (name) => calls.push(["kill", name]),
    removeRecord: (name, expected) => calls.push(["remove", name, expected]),
  });
  assert.deepEqual(response, fixture.normalized);
  assert.deepEqual(calls, [
    ["kill", fixture.request.name],
    ["remove", fixture.request.name, fixture.input.state.sessions[0]],
  ]);
});

test("TW RPC v1 errors keep stdout clean and stderr exact", () => {
  for (const fixture of cases.errors) {
    const result = runCli(fixture.argv);
    assert.equal(result.status, fixture.exitCode, fixture.id);
    assert.equal(result.stdout, fixture.stdout, fixture.id);
    assert.equal(result.stderr, fixture.stderr, fixture.id);
  }
});
