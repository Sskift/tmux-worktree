import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dashboard = await import("../dist/twDashboardCli.js");
const bootstrap = await import("../dist/twDashboardBootstrap.js");
const session = await import("../dist/session.js");
const terminalControl = await import("../dist/terminalControl/index.js");

function managedSession(name, overrides = {}) {
  return {
    name,
    kind: "worktree",
    profile: "dashboard",
    project: "demo",
    label: name,
    repoPath: "/repo/demo",
    worktreePath: `/worktrees/${name}`,
    branch: `${name}-branch`,
    baseBranch: "main",
    cwd: `/worktrees/${name}`,
    createdAt: "2026-08-11T00:00:00.000Z",
    attached: false,
    windows: 1,
    created: 1_786_400_000,
    activity: 1_786_400_100,
    incarnation: `twinc2.${"A".repeat(43)}`,
    lifecycleMarked: true,
    reservationCorrelation: null,
    ...overrides,
  };
}

test("tw agents projects tmux activity and exposes only bounded output on show", () => {
  const list = () => ({
    protocolVersion: 2,
    sessions: [managedSession("running"), managedSession("idle")],
  });
  const inspectPane = (name) => ({
    title: name === "running" ? "⠋ Working" : "Codex",
    startCommand: "codex",
    currentCommand: name === "running" ? "codex" : "zsh",
    cwd: `/worktrees/${name}`,
  });
  const agents = dashboard.buildTwAgentsList({ list, inspectPane });
  assert.deepEqual(
    agents.sessions.map(({ session: name, state, provider }) => ({ name, state, provider })),
    [
      { name: "running", state: "running", provider: "codex" },
      { name: "idle", state: "idle", provider: "codex" },
    ],
  );

  const shown = dashboard.buildTwAgentShow("running", 40, {
    list,
    inspectPane,
    capturePane: (_name, lines) => ({ text: `last ${lines} lines`, truncated: true }),
  });
  assert.equal(shown.kind, "tw-dashboard-agent");
  assert.equal(shown.agent.session, "running");
  assert.deepEqual(shown.output, {
    source: "tmux-capture-pane",
    lines: 40,
    text: "last 40 lines",
    truncated: true,
  });
  assert.throws(
    () => dashboard.buildTwAgentShow("missing", 40, { list, inspectPane }),
    /managed Agent session not found/,
  );
});

test("tw context identifies the injected session and publishes mobile output limits", () => {
  const supportPath = "/support/tw-dashboard/SKILL.md";
  const context = dashboard.buildTwDashboardContext({
    env: {
      TW_DASHBOARD: "1",
      TW_DASHBOARD_SESSION: "running",
      TW_DASHBOARD_HOST: "devbox",
      TW_DASHBOARD_SKILL: supportPath,
    },
    list: () => ({ protocolVersion: 2, sessions: [managedSession("running")] }),
    inspectPane: () => ({
      title: "⠋ Working",
      startCommand: "codex",
      currentCommand: "codex",
      cwd: "/worktrees/running",
    }),
    skillExists: (path) => path === supportPath,
  });
  assert.equal(context.insideTwDashboard, true);
  assert.equal(context.host, "devbox");
  assert.equal(context.session.session, "running");
  assert.equal(context.skill.available, true);
  assert.equal(context.output.localImages.maxBytesEach, 4 * 1024 * 1024);
  assert.equal(context.output.localImages.maxCount, 6);
});

test("the bundled Skill installs idempotently and provider bootstrap preserves resume identity", () => {
  const root = mkdtempSync(join(tmpdir(), "tw-dashboard-skill-"));
  try {
    const options = {
      home: root,
      codexHome: join(root, "codex"),
      claudeHome: join(root, "claude"),
      executable: "/usr/bin/node",
      cliEntrypoint: "/opt/tw-dashboard/cli.cjs",
    };
    const installed = bootstrap.ensureTwDashboardSkillInstalled(options);
    assert.equal(installed.codex, "installed");
    assert.equal(installed.claude, "installed");
    assert.equal(existsSync(installed.path), true);
    assert.equal(existsSync(installed.commandPath), true);
    assert.match(readFileSync(installed.commandPath, "utf8"), /\/opt\/tw-dashboard\/cli\.cjs/);
    assert.match(readFileSync(installed.path, "utf8"), /^---\nname: tw-dashboard/m);
    const current = bootstrap.ensureTwDashboardSkillInstalled(options);
    assert.equal(current.codex, "current");
    assert.equal(current.claude, "current");

    const id = "12345678-1234-1234-1234-123456789abc";
    const codex = session.commandThenLoginShell(
      `codex -c check_for_update_on_startup=false resume '${id}'`,
      "demo-session",
    );
    const claude = session.commandThenLoginShell(`claude --resume '${id}'`, "demo-session");
    assert.match(codex, /TW_DASHBOARD_SESSION='demo-session'/);
    assert.match(codex, /TW_DASHBOARD_CLI=/);
    assert.match(codex, /developer_instructions=/);
    assert.match(claude, /--append-system-prompt/);
    assert.equal(terminalControl.resumedAgentSessionIdFromStartCommand(codex, "codex"), id);
    assert.equal(terminalControl.resumedAgentSessionIdFromStartCommand(claude, "claude"), id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
