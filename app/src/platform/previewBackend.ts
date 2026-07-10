import type { AutomationRecord, AutomationRunRecord } from "../automationTypes";
import { createFakeDashboardBackend } from "./fakeBackend";
import type {
  GitCommit,
  GitStatus,
  HostConfig,
  HostStatus,
  PlainTerminal,
  ProjectPreset,
  Session,
} from "./domainTypes";
import type { PtyOpenArgs } from "./types";

const now = new Date().toISOString();

const sessions: Session[] = [
  {
    name: "dashboard-redesign",
    rawName: "dashboard-redesign",
    project: "tmux-worktree",
    attached: true,
    window_count: 1,
    created: 1_720_000_000,
    activity: 1_720_001_200,
    output_signature: "preview-dashboard",
    agent_running: true,
  },
  {
    name: "release-checks",
    rawName: "release-checks",
    project: "tmux-worktree",
    attached: false,
    window_count: 1,
    created: 1_719_990_000,
    activity: 1_720_000_900,
    output_signature: "preview-release",
    agent_running: false,
  },
  {
    name: "builder-1:remote-api",
    rawName: "remote-api",
    project: "relay-service",
    hostId: "builder-1",
    attached: false,
    window_count: 2,
    created: 1_719_980_000,
    activity: 1_720_000_500,
    output_signature: "preview-remote",
    agent_running: null,
  },
];

const hosts: HostConfig[] = [
  {
    id: "builder-1",
    label: "Build Mac",
    host: "builder.internal",
    user: "dev",
    port: 22,
    identityFile: null,
    worktreeBase: "~/worktrees",
    tmuxPath: "tmux",
    twPath: "~/.local/bin/tw",
  },
];

const hostStatuses: HostStatus[] = [
  {
    id: "builder-1",
    label: "Build Mac",
    reachable: true,
    latencyMs: 24,
    error: null,
    twAvailable: true,
    twVersion: "1.0.3",
    twError: null,
  },
];

const projects: ProjectPreset[] = [
  { name: "tmux-worktree", path: "/Users/demo/Code/tmux-worktree", branch: "master" },
  { name: "relay-service", path: "/Users/demo/Code/relay-service", branch: "main" },
  { name: "design-system", path: "/Users/demo/Code/design-system", branch: "main" },
];

const terminals: PlainTerminal[] = [
  {
    id: "term-1",
    label: "release shell",
    cwd: "/Users/demo/Code/tmux-worktree",
    tmuxName: "tw-term-preview",
    rawName: "tw-term-preview",
    aiCmd: "codex",
  },
];

const automations: AutomationRecord[] = [
  {
    id: "auto-review",
    name: "Review current diff",
    enabled: true,
    triggerType: "manual",
    schedule: null,
    timezone: null,
    project: "tmux-worktree",
    path: null,
    aiCmd: "codex",
    instruction: "Review the current branch and summarize risks.",
    overlap: "skip",
    lastRunAt: now,
    lastStatus: "success",
    lastSession: "dashboard-redesign",
    createdAt: now,
    updatedAt: now,
  },
];

const automationRuns: AutomationRunRecord[] = [
  {
    id: "run-preview",
    automationId: "auto-review",
    status: "success",
    startedAt: now,
    finishedAt: now,
    sessionName: "dashboard-redesign",
    error: null,
  },
];

const gitStatus: GitStatus = {
  branch: "tmux-worktree-app-re-ddf7c",
  upstream: "origin/tmux-worktree-app-re-ddf7c",
  ahead: 2,
  behind: 0,
  staged: 0,
  unstaged: 3,
  untracked: 1,
  conflicts: 0,
  files: [
    { code: " M", path: "app/src/App.tsx" },
    { code: " M", path: "app/src/App.css" },
    { code: "??", path: "design-qa.md" },
  ],
};

const gitLog: GitCommit[] = [
  {
    hash: "64bb031f4cb59f4e3c33c28a215f947e8cc15d1a",
    short: "64bb031",
    parents: ["682f016"],
    subject: "refactor(dashboard): add injectable platform backend",
    author: "Dashboard Preview",
    rel_time: "4 minutes ago",
    refs: ["HEAD -> tmux-worktree-app-re-ddf7c"],
  },
  {
    hash: "682f016000000000000000000000000000000000",
    short: "682f016",
    parents: ["a9fceb0"],
    subject: "docs: finalize dashboard v2 redesign plan",
    author: "Dashboard Preview",
    rel_time: "20 minutes ago",
    refs: [],
  },
];

const relayStatus = {
  active: false,
  connected: false,
  connectionState: "stopped",
  relayUrl: "wss://relay.example.com",
  hostId: "mac-admin",
  secret: "",
  token: "",
  connectedAt: null,
  updatedAt: null,
  retryInMs: null,
  error: null,
};

const { backend, transport } = createFakeDashboardBackend();
const openPtys = new Set<string>();

transport.selectedDirectory = "/Users/demo/Code/tmux-worktree";

const value = (result: unknown) => () => result;
const nothing = () => undefined;

transport.handlers.set("home_dir", value("/Users/demo"));
transport.handlers.set("list_sessions", value(sessions));
transport.handlers.set("list_dashboard_catalog", value({
  sessions,
  terminals,
  failedSessionHostIds: [],
  failedTerminalHostIds: [],
}));
transport.handlers.set("list_projects", value(projects));
transport.handlers.set("list_remote_projects", value(projects.slice(1)));
transport.handlers.set("list_orphaned_worktrees", value([]));
transport.handlers.set("list_hosts", value(hosts));
transport.handlers.set("list_ssh_host_candidates", value(hosts));
transport.handlers.set("host_statuses", value(hostStatuses));
transport.handlers.set("install_host_tw", value(hostStatuses[0]));
transport.handlers.set("test_host", value(hostStatuses[0]));
transport.handlers.set("add_host", value(hosts));
transport.handlers.set("remove_host", value([]));
transport.handlers.set("remote_home_dir", value("/Users/dev"));
transport.handlers.set("probe_agents", (payload) => {
  const hostId = (payload as { hostId?: string | null } | undefined)?.hostId ?? null;
  const binRoot = hostId ? "/usr/local/bin" : "/opt/homebrew/bin";
  return [
    { id: "claude", label: "Claude Code", command: "claude", available: false, executablePath: null, error: null },
    { id: "codex", label: "Codex", command: "codex", available: true, executablePath: `${binRoot}/codex`, error: null },
    { id: "gemini", label: "Gemini CLI", command: "gemini", available: hostId !== null, executablePath: hostId ? `${binRoot}/gemini` : null, error: null },
    { id: "opencode", label: "OpenCode", command: "opencode", available: false, executablePath: null, error: null },
    { id: "aider", label: "Aider", command: "aider", available: false, executablePath: null, error: null },
  ];
});
transport.handlers.set("list_tmux_terminals", value(terminals));
transport.handlers.set("load_terminals", value(terminals));
transport.handlers.set("save_terminals", nothing);
transport.handlers.set("ensure_terminal_session", nothing);
transport.handlers.set("kill_plain_terminal", nothing);
transport.handlers.set("kill_session", nothing);
transport.handlers.set("tmux_session_exists", value(true));
transport.handlers.set("session_root", value("/Users/demo/Code/tmux-worktree"));
transport.handlers.set("session_cwd", value("/Users/demo/Code/tmux-worktree"));
transport.handlers.set("capture_pane_history", value([
  "\u001b[1;34m~/Code/tmux-worktree\u001b[0m  \u001b[2m(tmux-worktree-app-re-ddf7c)\u001b[0m",
  "$ codex",
  "\u001b[2mAnalyzing dashboard architecture and preserving the active PTY…\u001b[0m",
  "",
].join("\n")));
transport.handlers.set("cancel_copy_mode", nothing);
transport.handlers.set("copy_mode_cancel_if_active", value(false));
transport.handlers.set("copy_tmux_selection", value(false));
transport.handlers.set("apply_tmux_theme", nothing);
transport.handlers.set("load_layout", value({}));
transport.handlers.set("save_layout", nothing);
transport.handlers.set("list_automations", value(automations));
transport.handlers.set("list_automation_runs", value(automationRuns));
transport.handlers.set("save_automation", (payload) => {
  const { input } = payload as { input: { id?: string } & Record<string, unknown> };
  return {
    ...automations[0],
    ...input,
    id: input.id ?? "auto-preview-new",
    updatedAt: new Date().toISOString(),
  };
});
transport.handlers.set("delete_automation", nothing);
transport.handlers.set("trigger_automation", value(automationRuns[0]));
transport.handlers.set("mobile_relay_status", value(relayStatus));
transport.handlers.set("mobile_relay_start", nothing);
transport.handlers.set("mobile_relay_stop", nothing);
transport.handlers.set("mobile_relay_save_config", value(relayStatus));
transport.handlers.set("mobile_relay_start_broker", value(relayStatus));
transport.handlers.set("git_fetch_project_roots", nothing);
transport.handlers.set("git_status", value(gitStatus));
transport.handlers.set("git_log", value(gitLog));
transport.handlers.set("git_diff", value([
  "diff --git a/app/src/App.tsx b/app/src/App.tsx",
  "--- a/app/src/App.tsx",
  "+++ b/app/src/App.tsx",
  "@@ -1,3 +1,4 @@",
  "+import { SettingsDialog } from \"./dashboard/Settings/SettingsDialog\";",
  " import { Terminal } from \"./Terminal\";",
].join("\n")));
transport.handlers.set("read_dir", value([
  { name: "app", path: "/Users/demo/Code/tmux-worktree/app", is_dir: true, is_symlink: false, is_hidden: false, size: 0 },
  { name: "README.md", path: "/Users/demo/Code/tmux-worktree/README.md", is_dir: false, is_symlink: false, is_hidden: false, size: 4200 },
]));
transport.handlers.set("remote_read_dir", value([]));
transport.handlers.set("search_files", value([]));
transport.handlers.set("read_file", value("# tmux-worktree\n\nDashboard preview content.\n"));
transport.handlers.set("remote_read_file", value("# Remote preview\n"));
transport.handlers.set("remote_read_file_base64", value(""));
transport.handlers.set("write_file", nothing);
transport.handlers.set("remote_write_file", nothing);
transport.handlers.set("file_exists", value(true));
transport.handlers.set("remote_file_exists", value(true));
transport.handlers.set("open_url", nothing);
transport.handlers.set("add_project", value(projects));
transport.handlers.set("create_worktree", value("dashboard-preview"));
transport.handlers.set("restore_worktree", value("dashboard-preview-restored"));
transport.handlers.set("delete_worktree", nothing);
transport.handlers.set("create_terminal", value({
  tmuxName: "tw-term-preview-new",
  hostId: null,
  rawName: "tw-term-preview-new",
}));
transport.handlers.set("pty_open", (payload) => {
  const args = (payload as { args: PtyOpenArgs }).args;
  openPtys.add(args.id);
  queueMicrotask(() => {
    transport.emit(`pty:${args.id}`, {
      id: args.id,
      data: "\r\n\u001b[2m[preview backend connected]\u001b[0m\r\n$ ",
    });
  });
  return args.id;
});
transport.handlers.set("pty_write", (payload) => {
  const { id, data } = payload as { id: string; data: string };
  if (openPtys.has(id) && data === "\r") {
    transport.emit(`pty:${id}`, { id, data: "\r\n$ " });
  }
});
transport.handlers.set("pty_resize", nothing);
transport.handlers.set("pty_kill", (payload) => {
  const { id } = payload as { id: string };
  openPtys.delete(id);
});

export const previewDashboardBackend = backend;
export const previewDashboardTransport = transport;
