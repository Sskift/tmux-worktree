import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type {
  CreateTerminalInput,
  CreateWorktreeInput,
  EnsureTerminalInput,
  PlainTerminal,
  TmuxStatusTheme,
} from "../src/platform/domainTypes.ts";
import type { SaveAutomationInput } from "../src/automationTypes.ts";

const { createFakeDashboardBackend } = await import("../src/platform/fakeBackend.ts");

type CommandCase = {
  label: string;
  command: string;
  args: unknown;
  call(backend: DashboardBackend): Promise<unknown>;
};

const theme: TmuxStatusTheme = {
  statusBg: "#111111",
  statusFg: "#eeeeee",
  activeBg: "#4c8dff",
  activeFg: "#111111",
  inactiveFg: "#888888",
  accent: "#4c8dff",
};
const projectArgs = { name: "dashboard", path: "/repo/dashboard" };
const missingProjectArgs = { name: "legacy", path: "/repo/missing" };
const createWorktreeArgs: CreateWorktreeInput = {
  project: "dashboard",
  branch: "feature/platform",
  aiCmd: "codex",
  name: null,
};
const restoreArgs = { path: "/repo/dashboard-feature", name: "dashboard-feature" };
const deleteWorktreeArgs = { path: "/repo/dashboard-feature", force: true };
const plainTerminal: PlainTerminal = {
  id: "term-1",
  label: "scratch",
  cwd: "/repo/dashboard",
  tmuxName: "host-1:tw-term-1",
  aiCmd: "codex",
  hostId: "host-1",
  rawName: "tw-term-1",
};
const ensureTerminalArgs: EnsureTerminalInput = {
  name: "host-1:tw-term-1",
  cwd: "/repo/dashboard",
  aiCmd: "codex",
  hostId: "host-1",
  rawName: "tw-term-1",
};
const createTerminalArgs: CreateTerminalInput = {
  cwd: "/repo/dashboard",
  aiCmd: "codex",
  hostId: "host-1",
};
const automationInput: SaveAutomationInput = {
  id: "automation-1",
  name: "Review",
  enabled: true,
  triggerType: "manual",
  schedule: null,
  timezone: null,
  project: "dashboard",
  path: null,
  aiCmd: "codex",
  instruction: "Review the changes",
  overlap: "skip",
};
const hostArgs = {
  id: "host-1",
  label: "Builder",
  host: "builder.internal",
  port: 22,
};
const addHostArgs = {
  ...hostArgs,
  identityFile: "~/.ssh/builder",
  worktreeBase: "~/worktrees",
  tmuxPath: "~/.local/bin/tmux",
  twPath: "~/.local/bin/tw",
};
const updateHostArgs = {
  ...hostArgs,
  label: "Build host",
  worktreeBase: "~/worktrees",
  tmuxPath: "~/.local/bin/tmux",
  twPath: "~/.local/bin/tw",
};
const relayArgs = {
  relayUrl: "wss://relay.example.test",
  brokerHostId: "host-1",
  hostId: "dashboard-host",
  secret: "test-secret",
};
const layout = { schemaVersion: 2, sidebar: { width: 280 } };
const layoutRevision = "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY";

const commandCases: CommandCase[] = [
  {
    label: "catalog.list",
    command: "list_dashboard_catalog",
    args: undefined,
    call: (backend) => backend.catalog!.list(),
  },
  {
    label: "catalog.listLocal",
    command: "list_local_dashboard_catalog",
    args: undefined,
    call: (backend) => backend.catalog!.listLocal!(),
  },
  {
    label: "sessions.list",
    command: "list_sessions",
    args: undefined,
    call: (backend) => backend.sessions.list(),
  },
  {
    label: "sessions.exists",
    command: "tmux_session_exists",
    args: { name: "dashboard-feature" },
    call: (backend) => backend.sessions.exists("dashboard-feature"),
  },
  {
    label: "sessions.root",
    command: "session_root",
    args: { name: "dashboard-feature" },
    call: (backend) => backend.sessions.root("dashboard-feature"),
  },
  {
    label: "sessions.cwd",
    command: "session_cwd",
    args: { name: "dashboard-feature" },
    call: (backend) => backend.sessions.cwd("dashboard-feature"),
  },
  {
    label: "sessions.captureHistory with a limit",
    command: "capture_pane_history",
    args: { name: "dashboard-feature", lines: 300 },
    call: (backend) => backend.sessions.captureHistory("dashboard-feature", 300),
  },
  {
    label: "sessions.captureHistory without a limit",
    command: "capture_pane_history",
    args: { name: "dashboard-feature", lines: undefined },
    call: (backend) => backend.sessions.captureHistory("dashboard-feature"),
  },
  {
    label: "sessions.kill",
    command: "kill_session",
    args: { name: "dashboard-feature", managed: true },
    call: (backend) => backend.sessions.kill("dashboard-feature", true),
  },
  {
    label: "sessions.cancelCopyMode",
    command: "cancel_copy_mode",
    args: { name: "dashboard-feature" },
    call: (backend) => backend.sessions.cancelCopyMode("dashboard-feature"),
  },
  {
    label: "sessions.cancelCopyModeIfActive",
    command: "copy_mode_cancel_if_active",
    args: { name: "dashboard-feature" },
    call: (backend) => backend.sessions.cancelCopyModeIfActive("dashboard-feature"),
  },
  {
    label: "sessions.copySelection",
    command: "copy_tmux_selection",
    args: { name: "dashboard-feature" },
    call: (backend) => backend.sessions.copySelection("dashboard-feature"),
  },
  {
    label: "sessions.applyTheme",
    command: "apply_tmux_theme",
    args: { name: "dashboard-feature", theme },
    call: (backend) => backend.sessions.applyTheme("dashboard-feature", theme),
  },
  {
    label: "projects.list",
    command: "list_projects",
    args: undefined,
    call: (backend) => backend.projects.list(),
  },
  {
    label: "projects.listRemote",
    command: "list_remote_projects",
    args: { hostId: "host-1" },
    call: (backend) => backend.projects.listRemote("host-1"),
  },
  {
    label: "projects.add",
    command: "add_project",
    args: { args: projectArgs },
    call: (backend) => backend.projects.add(projectArgs),
  },
  {
    label: "projects.removeMissing",
    command: "remove_missing_project",
    args: { args: missingProjectArgs },
    call: (backend) => backend.projects.removeMissing(missingProjectArgs),
  },
  {
    label: "worktrees.listOrphaned",
    command: "list_orphaned_worktrees",
    args: { hostId: null },
    call: (backend) => backend.worktrees.listOrphaned(),
  },
  {
    label: "worktrees.listOrphaned remote",
    command: "list_orphaned_worktrees",
    args: { hostId: "mew-dev" },
    call: (backend) => backend.worktrees.listOrphaned("mew-dev"),
  },
  {
    label: "worktrees.create",
    command: "create_worktree",
    args: { args: createWorktreeArgs },
    call: (backend) => backend.worktrees.create(createWorktreeArgs),
  },
  {
    label: "worktrees.restore",
    command: "restore_worktree",
    args: { args: restoreArgs },
    call: (backend) => backend.worktrees.restore(restoreArgs),
  },
  {
    label: "worktrees.restore remote",
    command: "restore_worktree",
    args: { args: { ...restoreArgs, hostId: "mew-dev" } },
    call: (backend) => backend.worktrees.restore({ ...restoreArgs, hostId: "mew-dev" }),
  },
  {
    label: "worktrees.delete",
    command: "delete_worktree",
    args: { args: deleteWorktreeArgs },
    call: (backend) => backend.worktrees.delete(deleteWorktreeArgs),
  },
  {
    label: "worktrees.delete remote",
    command: "delete_worktree",
    args: { args: { ...deleteWorktreeArgs, hostId: "mew-dev" } },
    call: (backend) => backend.worktrees.delete({ ...deleteWorktreeArgs, hostId: "mew-dev" }),
  },
  {
    label: "terminals.listTmux",
    command: "list_tmux_terminals",
    args: undefined,
    call: (backend) => backend.terminals.listTmux(),
  },
  {
    label: "terminals.load",
    command: "load_terminals",
    args: undefined,
    call: (backend) => backend.terminals.load(),
  },
  {
    label: "terminals.save",
    command: "save_terminals",
    args: { terminals: [plainTerminal] },
    call: (backend) => backend.terminals.save([plainTerminal]),
  },
  {
    label: "terminals.ensure",
    command: "ensure_terminal_session",
    args: { args: ensureTerminalArgs },
    call: (backend) => backend.terminals.ensure(ensureTerminalArgs),
  },
  {
    label: "terminals.create",
    command: "create_terminal",
    args: { args: createTerminalArgs },
    call: (backend) => backend.terminals.create(createTerminalArgs),
  },
  {
    label: "terminals.kill",
    command: "kill_plain_terminal",
    args: { name: "tw-term-1", managed: true },
    call: (backend) => backend.terminals.kill("tw-term-1", true),
  },
  {
    label: "pty.write",
    command: "pty_write",
    args: { id: "pty-1", data: "hello" },
    call: (backend) => backend.pty.write("pty-1", "hello"),
  },
  {
    label: "pty.scroll",
    command: "pty_control_scroll",
    args: { id: "pty-1", direction: "up", lines: 3 },
    call: (backend) => backend.pty.scroll("pty-1", "up", 3),
  },
  {
    label: "pty.resize",
    command: "pty_resize",
    args: { id: "pty-1", cols: 120, rows: 40 },
    call: (backend) => backend.pty.resize("pty-1", 120, 40),
  },
  {
    label: "pty.kill",
    command: "pty_kill",
    args: { id: "pty-1" },
    call: (backend) => backend.pty.kill("pty-1"),
  },
  {
    label: "pty.controlStatus",
    command: "pty_control_status",
    args: { id: "pty-1" },
    call: (backend) => backend.pty.controlStatus("pty-1"),
  },
  {
    label: "pty.releaseControl",
    command: "pty_control_release",
    args: { id: "pty-1" },
    call: (backend) => backend.pty.releaseControl("pty-1"),
  },
  {
    label: "pty.requestTakeover",
    command: "pty_control_takeover",
    args: { id: "pty-1" },
    call: (backend) => backend.pty.requestTakeover("pty-1"),
  },
  {
    label: "pty.requestRecovery",
    command: "pty_control_recover",
    args: { id: "pty-1" },
    call: (backend) => backend.pty.requestRecovery("pty-1"),
  },
  {
    label: "git.status normalizes an absent host to null",
    command: "git_status",
    args: { cwd: "/repo/dashboard", hostId: null },
    call: (backend) => backend.git.status("/repo/dashboard"),
  },
  {
    label: "git.status preserves a remote host",
    command: "git_status",
    args: { cwd: "/repo/dashboard", hostId: "host-1" },
    call: (backend) => backend.git.status("/repo/dashboard", "host-1"),
  },
  {
    label: "git.graphRefs normalizes an absent host",
    command: "git_graph_refs",
    args: { cwd: "/repo/dashboard", hostId: null },
    call: (backend) => backend.git.graphRefs("/repo/dashboard"),
  },
  {
    label: "git.graph forwards the selected canonical refs",
    command: "git_graph",
    args: {
      cwd: "/repo/dashboard",
      query: {
        preset: "current",
        selectedRefs: ["refs/heads/feature/editor"],
        limit: 120,
      },
      hostId: "host-1",
    },
    call: (backend) => backend.git.graph(
      "/repo/dashboard",
      {
        preset: "current",
        selectedRefs: ["refs/heads/feature/editor"],
        limit: 120,
      },
      "host-1",
    ),
  },
  {
    label: "git.diff normalizes an explicit null host",
    command: "git_diff",
    args: { cwd: "/repo/dashboard", path: "src/App.tsx", hostId: null },
    call: (backend) => backend.git.diff("/repo/dashboard", "src/App.tsx", null),
  },
  {
    label: "git.fetchProjectRoots",
    command: "git_fetch_project_roots",
    args: undefined,
    call: (backend) => backend.git.fetchProjectRoots(),
  },
  {
    label: "files.readDirectory",
    command: "read_dir",
    args: { path: "/repo/dashboard" },
    call: (backend) => backend.files.readDirectory("/repo/dashboard"),
  },
  {
    label: "files.readRemoteDirectory",
    command: "remote_read_dir",
    args: { hostId: "host-1", path: "/repo/dashboard" },
    call: (backend) => backend.files.readRemoteDirectory("host-1", "/repo/dashboard"),
  },
  {
    label: "files.search",
    command: "search_files",
    args: { root: "/repo/dashboard", query: "backend", mode: "content" },
    call: (backend) => backend.files.search("/repo/dashboard", "backend", "content"),
  },
  {
    label: "files.read",
    command: "read_file",
    args: { path: "/repo/dashboard/README.md" },
    call: (backend) => backend.files.read("/repo/dashboard/README.md"),
  },
  {
    label: "files.readRemote",
    command: "remote_read_file",
    args: { hostId: "host-1", path: "/repo/dashboard/README.md" },
    call: (backend) => backend.files.readRemote("host-1", "/repo/dashboard/README.md"),
  },
  {
    label: "files.readRemoteBase64",
    command: "remote_read_file_base64",
    args: { hostId: "host-1", path: "/repo/dashboard/icon.png" },
    call: (backend) => backend.files.readRemoteBase64("host-1", "/repo/dashboard/icon.png"),
  },
  {
    label: "files.write",
    command: "write_file",
    args: { path: "/repo/dashboard/README.md", content: "updated" },
    call: (backend) => backend.files.write("/repo/dashboard/README.md", "updated"),
  },
  {
    label: "files.writeRemote",
    command: "remote_write_file",
    args: { hostId: "host-1", path: "/repo/dashboard/README.md", content: "updated" },
    call: (backend) => backend.files.writeRemote("host-1", "/repo/dashboard/README.md", "updated"),
  },
  {
    label: "files.exists",
    command: "file_exists",
    args: { path: "/repo/dashboard/README.md" },
    call: (backend) => backend.files.exists("/repo/dashboard/README.md"),
  },
  {
    label: "files.existsRemote",
    command: "remote_file_exists",
    args: { hostId: "host-1", path: "/repo/dashboard/README.md" },
    call: (backend) => backend.files.existsRemote("host-1", "/repo/dashboard/README.md"),
  },
  {
    label: "files.openUrl",
    command: "open_url",
    args: { url: "https://example.test/dashboard" },
    call: (backend) => backend.files.openUrl("https://example.test/dashboard"),
  },
  {
    label: "automations.list",
    command: "list_automations",
    args: undefined,
    call: (backend) => backend.automations.list(),
  },
  {
    label: "automations.listRuns normalizes an absent id to null",
    command: "list_automation_runs",
    args: { automationId: null },
    call: (backend) => backend.automations.listRuns(),
  },
  {
    label: "automations.listRuns preserves an id",
    command: "list_automation_runs",
    args: { automationId: "automation-1" },
    call: (backend) => backend.automations.listRuns("automation-1"),
  },
  {
    label: "automations.save",
    command: "save_automation",
    args: { input: automationInput },
    call: (backend) => backend.automations.save(automationInput),
  },
  {
    label: "automations.delete",
    command: "delete_automation",
    args: { id: "automation-1" },
    call: (backend) => backend.automations.delete("automation-1"),
  },
  {
    label: "automations.trigger",
    command: "trigger_automation",
    args: { id: "automation-1" },
    call: (backend) => backend.automations.trigger("automation-1"),
  },
  {
    label: "hosts.list",
    command: "list_hosts",
    args: undefined,
    call: (backend) => backend.hosts.list(),
  },
  {
    label: "hosts.candidates",
    command: "list_ssh_host_candidates",
    args: undefined,
    call: (backend) => backend.hosts.candidates(),
  },
  {
    label: "hosts.statuses",
    command: "host_statuses",
    args: undefined,
    call: (backend) => backend.hosts.statuses(),
  },
  {
    label: "hosts.test",
    command: "test_host",
    args: { args: hostArgs },
    call: (backend) => backend.hosts.test(hostArgs),
  },
  {
    label: "hosts.add",
    command: "add_host",
    args: { args: addHostArgs },
    call: (backend) => backend.hosts.add(addHostArgs),
  },
  {
    label: "hosts.remove",
    command: "remove_host",
    args: { id: "host-1" },
    call: (backend) => backend.hosts.remove("host-1"),
  },
  {
    label: "hosts.update",
    command: "update_host",
    args: { args: updateHostArgs },
    call: (backend) => backend.hosts.update(updateHostArgs),
  },
  {
    label: "hosts.installTw",
    command: "install_host_tw",
    args: { hostId: "host-1" },
    call: (backend) => backend.hosts.installTw("host-1"),
  },
  {
    label: "hosts.remoteHome",
    command: "remote_home_dir",
    args: { hostId: "host-1" },
    call: (backend) => backend.hosts.remoteHome("host-1"),
  },
  {
    label: "agents.probe local",
    command: "probe_agents",
    args: { hostId: null },
    call: (backend) => backend.agents.probe({ kind: "local" }),
  },
  {
    label: "agents.probe host",
    command: "probe_agents",
    args: { hostId: "host-1" },
    call: (backend) => backend.agents.probe({ kind: "host", hostId: "host-1" }),
  },
  {
    label: "relay.status",
    command: "mobile_relay_status",
    args: undefined,
    call: (backend) => backend.relay.status(),
  },
  {
    label: "relay.start",
    command: "mobile_relay_start",
    args: undefined,
    call: (backend) => backend.relay.start(),
  },
  {
    label: "relay.saveConfig",
    command: "mobile_relay_save_config",
    args: { args: relayArgs },
    call: (backend) => backend.relay.saveConfig(relayArgs),
  },
  {
    label: "relay.startBroker",
    command: "mobile_relay_start_broker",
    args: { args: { hostId: "host-1", port: 8787, quickTunnel: true } },
    call: (backend) => backend.relay.startBroker({ hostId: "host-1", port: 8787, quickTunnel: true }),
  },
  {
    label: "relay.stop",
    command: "mobile_relay_stop",
    args: undefined,
    call: (backend) => backend.relay.stop(),
  },
  {
    label: "feishu.integrationStatus",
    command: "feishu_integration_status",
    args: undefined,
    call: (backend) => backend.feishu.integrationStatus(),
  },
  {
    label: "feishu.addProfile",
    command: "feishu_integration_add_profile",
    args: {
      appId: "cli_new_bot",
      appSecret: "transient-secret",
      brand: "feishu",
    },
    call: (backend) => backend.feishu.addProfile({
      appId: "cli_new_bot",
      appSecret: "transient-secret",
      brand: "feishu",
    }),
  },
  {
    label: "feishu.selectProfile",
    command: "feishu_integration_save_profile",
    args: { profile: "bot-profile" },
    call: (backend) => backend.feishu.selectProfile("bot-profile"),
  },
  {
    label: "feishu.removeProfile",
    command: "feishu_integration_remove_profile",
    args: { profile: "bot-profile" },
    call: (backend) => backend.feishu.removeProfile("bot-profile"),
  },
  {
    label: "persistence.homeDirectory",
    command: "home_dir",
    args: undefined,
    call: (backend) => backend.persistence.homeDirectory(),
  },
  {
    label: "persistence.loadLayout",
    command: "load_layout",
    args: undefined,
    call: (backend) => backend.persistence.loadLayout(),
  },
  {
    label: "persistence.saveLayout",
    command: "save_layout",
    args: { layout, expectedRevision: layoutRevision },
    call: (backend) => backend.persistence.saveLayout(layout, layoutRevision),
  },
];

for (const commandCase of commandCases) {
  test(`DashboardBackend maps ${commandCase.label} to the exact transport payload`, async () => {
    const { backend, transport } = createFakeDashboardBackend({
      [commandCase.command]: () => null,
    });

    await commandCase.call(backend);

    assert.deepEqual(transport.calls, [
      { command: commandCase.command, args: commandCase.args },
    ]);
  });
}

test("DashboardBackend preserves transport errors", async () => {
  const expected = new Error("backend unavailable");
  const { backend } = createFakeDashboardBackend({
    list_sessions: () => {
      throw expected;
    },
  });

  await assert.rejects(backend.sessions.list(), (error) => error === expected);
});

test("DashboardBackend keeps Relay v2 unavailable without the Node credential adapter", async () => {
  const { backend, transport } = createFakeDashboardBackend();

  const status = await backend.relay.v2.status();
  assert.equal(status.authority.kind, "unavailable");
  assert.deepEqual(status.connector.negotiatedCapabilityIntersection, []);
  assert.equal(status.enrollment.status, "idle");
  assert.equal(transport.calls.length, 0);
  await assert.rejects(backend.relay.v2.bootstrapHost(), (error: unknown) => (
    error instanceof Error
    && error.message.includes("Node issuer/credential control API")
    && "retryable" in error
    && error.retryable === false
  ));
  assert.equal(transport.calls.length, 0);
});
