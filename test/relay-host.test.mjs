import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const {
  assertRpcMutationCapabilities,
  isManagedWorktreeRow,
  isRpcManagedTerminalSession,
  isRpcManagedWorktreeSession,
  isUnsupportedRpcListFailure,
  isLegacyKillRpcFailure,
  dashboardTerminalRecord,
  liveDashboardTerminalName,
  mutateTerminalRegistry,
  parseDashboardTerminalPayload,
  parseRelayHostOptions,
  parseRpcCreateWorktreeResponse,
  parseRpcCreateTerminalResponse,
  persistCreatedTerminalMetadata,
  projectNameFromTwWorktreePath,
  remoteAttachCommand,
  relaySshConnectionArgs,
  relayV2HostCarrierUrl,
  run,
  sessionNameFromTwWorktreeDir,
  writeTerminalRegistryAtomic,
} = await import("../dist/relayHost.js");

test("relay-host profiles keep v1 secrets and v2 credential references disjoint", () => {
  const v1 = parseRelayHostOptions([
    "--relay", "wss://legacy.example.test",
    "--host-id", "legacy-host",
    "--secret", "legacy-shared-secret",
  ], {
    TW_RELAY_V2_HOST_CREDENTIAL_REFERENCE: "relay-v2-host-credential-ref:coexisting-v2",
  });
  assert.equal(v1.profile, "v1");
  assert.equal(v1.secret, "legacy-shared-secret");
  assert.equal(Object.hasOwn(v1, "credentialReference"), false);

  // 显式 v2 选路只接受 --profile v2 本身：endpoint/hostId/credential reference
  // 全部来自 canonical 运行时 profile store，返回里没有任何 v1 运行时字段。
  const v2 = parseRelayHostOptions(["--profile", "v2"], {
    TW_RELAY_SECRET: "coexisting-v1-secret",
  });
  assert.deepEqual(v2, { profile: "v2" });
  assert.equal(Object.hasOwn(v2, "secret"), false);
  assert.equal(Object.hasOwn(v2, "credentialReference"), false);
  assert.equal(Object.hasOwn(v2, "relay"), false);

  assert.throws(() => parseRelayHostOptions([
    "--profile", "v2",
    "--secret", "must-not-be-promoted",
  ], {}), /cannot read or promote Relay v1 shared secret|不能读取或提升/);
  assert.throws(() => parseRelayHostOptions([
    "--relay", "wss://legacy.example.test",
    "--secret", "legacy-shared-secret",
    "--credential-reference", "must-not-cross-profile",
  ], {}), /cannot read Relay v2 credential reference|不能读取 Relay v2 credential reference/);
});

test("Relay v2 host argv never carries endpoints or credential references", () => {
  // v2 的 relayUrl/issuer/hostId/credential reference 只来自运行时 profile
  // store；任何 argv 形式的 endpoint、credential reference（含合法 namespace
  // 与敏感前缀）或 v1 运行时参数都在选路时拒绝，不会被静默忽略。
  for (const argv of [
    ["--profile", "v2", "--relay", "wss://relay.example.test"],
    ["--profile", "v2", "--host-id", "v2-host"],
    ["--profile", "v2", "--display-name", "v2 host"],
    ["--profile", "v2", "--credential-reference", "relay-v2-host-credential-ref:primary"],
    ["--profile", "v2", "--credential-reference", "twcap2.payload.mac"],
    ["--profile", "v2", "--credential-reference", "twhostboot2.opaque"],
    ["--profile", "v2", "--local", "http://127.0.0.1:8311"],
    ["--profile", "v2", "--status-file", "/tmp/v2-status.json"],
  ]) {
    assert.throws(() => parseRelayHostOptions(argv, {}), /只来自运行时 profile store/);
  }
});

test("Relay v2 host selection ignores legacy v2 env channels", () => {
  // 旧的 TW_RELAY_V2_* env 不再是 endpoint/credential 来源；显式选路只读
  // --profile，运行时 profile store 才是唯一事实来源。
  const selected = parseRelayHostOptions(["--profile", "v2"], {
    TW_RELAY_V2_URL: "wss://relay.example.test",
    TW_RELAY_V2_HOST_CREDENTIAL_REFERENCE: "relay-v2-host-credential-ref:env",
    TW_RELAY_V2_HOST_ID: "env-host",
  });
  assert.deepEqual(selected, { profile: "v2" });
  const envSelected = parseRelayHostOptions([], {
    TW_RELAY_HOST_PROFILE: "v2",
    TW_RELAY_SECRET: "coexisting-v1-secret",
  });
  assert.deepEqual(envSelected, { profile: "v2" });
});

test("relay-host help documents the explicit Relay v2 shipping selection", async () => {
  const child = spawn(process.execPath, ["dist/cli.cjs", "relay-host", "--help"], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = Buffer.concat(stdout).toString("utf8");
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  assert.match(output, /tw relay-host --profile v2/);
  assert.match(output, /default-off Relay v2 Host shipping root/);
  assert.doesNotMatch(output, /当前未启用 Relay v2/);
});

test("Relay v2 host carrier URL is exact WSS without URL credentials or fallback paths", () => {
  for (const invalid of [
    "ws://relay.example.test",
    "wss://user@relay.example.test",
    "wss://relay.example.test/host",
    "wss://relay.example.test/?hostId=legacy",
    "wss://relay.example.test/#fragment",
  ]) {
    assert.throws(() => relayV2HostCarrierUrl(invalid));
  }
});

test("explicit Relay v2 profile enters the shipping root and fails closed without injection", async () => {
  const previousArgv = process.argv;
  const isolatedKeys = [
    "TW_RELAY_HOST_PROFILE",
    "TW_RELAY_SECRET",
    "TW_RELAY_V2_URL",
    "TW_RELAY_V2_HOST_ID",
    "TW_RELAY_V2_HOST_CREDENTIAL_REFERENCE",
  ];
  const previousEnv = new Map(isolatedKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of isolatedKeys) delete process.env[key];
    process.argv = [
      process.execPath,
      "cli.cjs",
      "relay-host",
      "--profile", "v2",
    ];
    // 显式 v2 选路进入新的 Host shipping root：CLI 没有受信 deployment 注入
    // 渠道，在任何 profile/store/socket 之前 fail closed，且绝不是旧的固定 throw。
    await assert.rejects(
      run(),
      (error) => {
        assert.equal(error?.code, "INPUTS_UNAVAILABLE");
        assert.match(error?.message, /deployment inputs are unavailable/);
        assert.match(error?.message, /never falls back to Relay v1/);
        assert.doesNotMatch(error?.message, /production dependencies are not configured/);
        return true;
      },
    );
  } finally {
    process.argv = previousArgv;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("remote mutation requires an explicit hard-timeout RPC capability", () => {
  const supported = JSON.stringify({
    protocolVersion: 1,
    app: "tmux-worktree",
    capabilities: ["create-worktree", "hard-timeout"],
  });
  assert.doesNotThrow(() => {
    assertRpcMutationCapabilities(supported, "create-worktree", "build-box");
  });
  assert.throws(
    () => assertRpcMutationCapabilities(
      JSON.stringify({
        protocolVersion: 1,
        app: "tmux-worktree",
        capabilities: ["create-worktree"],
      }),
      "create-worktree",
      "legacy-box",
    ),
    /legacy-box.*create-worktree and hard-timeout/,
  );
  assert.throws(
    () => assertRpcMutationCapabilities("not-json", "kill-session", "broken-box"),
    /invalid JSON from broken-box/,
  );
});

test("relay SSH argv keeps every SSH process inside relay admission", () => {
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
    "ControlMaster=no",
    "ControlPersist=no",
  ]) {
    assert.ok(args.includes(option), `missing SSH option ${option}`);
  }
  assert.equal(args.includes("ControlMaster=auto"), false);
  assert.equal(args.includes("ControlPersist=600"), false);
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
  assert.match(command, /attach-session -r -f ignore-size -t '=x-cloud'/);
  assert.doesNotMatch(command, /new-session/);
  assert.doesNotMatch(command, /kill-session/);
  assert.doesNotMatch(command, /tw-mobile-/);
});

test("relay host publishes connection failures without exposing credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-status-"));
  const statusFile = join(root, "relay-status.json");
  const secret = "test-secret-must-not-leak";
  const child = spawn(process.execPath, [
    "dist/cli.cjs",
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
    assert.equal(typeof status?.ownerInstanceId, "string");
    assert.equal(typeof status?.updatedAt, "number");
    assert.equal(typeof status?.retryInMs, "number");
    assert.equal(JSON.stringify(status).includes(secret), false);
  } finally {
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay-host kept its retry timer alive after SIGTERM")),
        750,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
