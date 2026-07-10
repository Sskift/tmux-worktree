import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const {
  emptyManagedState,
  upsertManagedSession,
} = await import("../dist/state.js");
const {
  buildRpcCapabilitiesResponse,
  buildRpcListResponse,
  parseRpcCreateWorktreeArgs,
} = await import("../dist/rpc.js");
const { createManagedWorktreeSession } = await import("../dist/session.js");

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

test("rpc capabilities advertises remote worktree creation", () => {
  assert.deepEqual(buildRpcCapabilitiesResponse().capabilities, [
    "list",
    "managed-state",
    "create-worktree",
  ]);
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
      "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; codex; exec \"${SHELL:-/bin/zsh}\" -l",
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

test("shared worktree creation records managed state for cli and rpc consumers", () => {
  const devSource = readFileSync(new URL("../src/dev.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");

  assert.match(devSource, /createManagedWorktreeSession/);
  assert.match(devSource, /profile:\s*"cli"/);
  assert.match(sessionSource, /upsertManagedSession/);
  assert.match(sessionSource, /saveManagedState/);
  assert.match(sessionSource, /profile:\s*params\.profile/);
  assert.match(sessionSource, /worktreePath:\s*createdWorktree\.path/);
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
      "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; codex --quiet; exec \"${SHELL:-/bin/zsh}\" -l",
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
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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
