import type { AutomationRecord, AutomationRunRecord } from "../automationTypes";
import { createFakeDashboardBackend } from "./fakeBackend";
import type {
  GitGraphCommit,
  GitGraphRef,
  GitGraphRefs,
  GitGraphResponse,
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

const graphRefs: GitGraphRef[] = [
  { name: "refs/heads/tmux-worktree-app-re-ddf7c", shortName: "tmux-worktree-app-re-ddf7c", kind: "local", current: true, upstream: "refs/remotes/origin/tmux-worktree-app-re-ddf7c" },
  { name: "refs/heads/main", shortName: "main", kind: "local", current: false, upstream: "refs/remotes/origin/main" },
  { name: "refs/heads/feature/renderer", shortName: "feature/renderer", kind: "local", current: false, upstream: null },
  { name: "refs/remotes/origin/tmux-worktree-app-re-ddf7c", shortName: "origin/tmux-worktree-app-re-ddf7c", kind: "remote", current: false, upstream: null },
  { name: "refs/remotes/origin/main", shortName: "origin/main", kind: "remote", current: false, upstream: null },
  { name: "refs/tags/v1.0.3", shortName: "v1.0.3", kind: "tag", current: false, upstream: null },
];

const refByName = new Map(graphRefs.map((ref) => [ref.name, ref]));
const decoration = (name: string): GitGraphRef => ({ ...refByName.get(name)! });
const graphCommits: GitGraphCommit[] = [
  { hash: "a1b2c3d000000000000000000000000000000001", short: "a1b2c3d", parents: ["b2c3d4e000000000000000000000000000000002"], subject: "feat(editor): refine CodeMirror workspace", author: "Dashboard Preview", relTime: "4 minutes ago", decorations: [{ name: "HEAD", shortName: "HEAD", kind: "head", current: true, upstream: null }, decoration("refs/heads/tmux-worktree-app-re-ddf7c")] },
  { hash: "b2c3d4e000000000000000000000000000000002", short: "b2c3d4e", parents: ["c3d4e5f000000000000000000000000000000003", "f6a7b8c000000000000000000000000000000006"], subject: "merge: renderer graph into dashboard", author: "Dashboard Preview", relTime: "18 minutes ago", decorations: [decoration("refs/remotes/origin/tmux-worktree-app-re-ddf7c")] },
  { hash: "c3d4e5f000000000000000000000000000000003", short: "c3d4e5f", parents: ["d4e5f6a000000000000000000000000000000004"], subject: "fix(editor): preserve cursor and undo history", author: "Maya Patel", relTime: "31 minutes ago", decorations: [] },
  { hash: "d4e5f6a000000000000000000000000000000004", short: "d4e5f6a", parents: ["e5f6a7b000000000000000000000000000000005"], subject: "style(editor): align syntax palette with shell", author: "Maya Patel", relTime: "1 hour ago", decorations: [] },
  { hash: "f6a7b8c000000000000000000000000000000006", short: "f6a7b8c", parents: ["a7b8c9d000000000000000000000000000000007"], subject: "feat(git): add compact commit topology", author: "Alex Chen", relTime: "44 minutes ago", decorations: [decoration("refs/heads/feature/renderer")] },
  { hash: "a7b8c9d000000000000000000000000000000007", short: "a7b8c9d", parents: ["e5f6a7b000000000000000000000000000000005"], subject: "test(git): cover fork and merge lanes", author: "Alex Chen", relTime: "2 hours ago", decorations: [] },
  { hash: "e5f6a7b000000000000000000000000000000005", short: "e5f6a7b", parents: ["c8d9e0f000000000000000000000000000000008"], subject: "refactor: separate files from Git workspace", author: "Dashboard Preview", relTime: "yesterday", decorations: [decoration("refs/heads/main"), decoration("refs/remotes/origin/main")] },
  { hash: "c8d9e0f000000000000000000000000000000008", short: "c8d9e0f", parents: [], subject: "release: dashboard v1.0.3", author: "Release Bot", relTime: "2 days ago", decorations: [decoration("refs/tags/v1.0.3")] },
];

const gitGraphRefs: GitGraphRefs = {
  refs: graphRefs,
  current: "refs/heads/tmux-worktree-app-re-ddf7c",
  upstream: "refs/remotes/origin/tmux-worktree-app-re-ddf7c",
};

const gitGraph: GitGraphResponse = {
  ...gitGraphRefs,
  commits: graphCommits,
  hasMore: false,
};

const previewRoot = "/Users/demo/Code/tmux-worktree";
const previewSource = [
  'import { useMemo, useState } from "react";',
  'import { GitBranch, RefreshCw } from "lucide-react";',
  'import { layoutGitGraph } from "./gitGraphLayout";',
  '',
  'type Commit = {',
  '  hash: string;',
  '  parents: string[];',
  '  subject: string;',
  '};',
  '',
  'type Props = {',
  '  commits: Commit[];',
  '  onRefresh: () => void;',
  '};',
  '',
  'export function GitGraphView({ commits, onRefresh }: Props) {',
  '  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);',
  '  const layout = useMemo(() => layoutGitGraph(',
  '    commits.map((commit) => ({',
  '      id: commit.hash,',
  '      parentIds: commit.parents,',
  '    })),',
  '  ), [commits]);',
  '',
  '  return (',
  '    <section className="git-graph" aria-label="Git commit graph">',
  '      <header className="git-graph__toolbar">',
  '        <GitBranch aria-hidden="true" />',
  '        <strong>Commit history</strong>',
  '        <button type="button" onClick={onRefresh}>',
  '          <RefreshCw aria-hidden="true" />',
  '          Refresh',
  '        </button>',
  '      </header>',
  '      <ol>',
  '        {layout.nodes.map((node) => {',
  '          const commit = commits[node.row];',
  '          const selected = selectedCommit === commit.hash;',
  '          return (',
  '            <li key={commit.hash}>',
  '              <button',
  '                type="button"',
  '                aria-pressed={selected}',
  '                onClick={() => setSelectedCommit(commit.hash)}',
  '              >',
  '                {commit.subject}',
  '              </button>',
  '            </li>',
  '          );',
  '        })}',
  '      </ol>',
  '    </section>',
  '  );',
  '}',
  '',
].join("\n");

const previewDirectories = new Map<string, Array<{
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  is_hidden: boolean;
  size: number;
}>>([
  [previewRoot, [
    { name: "app", path: `${previewRoot}/app`, is_dir: true, is_symlink: false, is_hidden: false, size: 0 },
    { name: "README.md", path: `${previewRoot}/README.md`, is_dir: false, is_symlink: false, is_hidden: false, size: 4200 },
  ]],
  [`${previewRoot}/app`, [
    { name: "src", path: `${previewRoot}/app/src`, is_dir: true, is_symlink: false, is_hidden: false, size: 0 },
    { name: "package.json", path: `${previewRoot}/app/package.json`, is_dir: false, is_symlink: false, is_hidden: false, size: 1900 },
  ]],
  [`${previewRoot}/app/src`, [
    { name: "dashboard", path: `${previewRoot}/app/src/dashboard`, is_dir: true, is_symlink: false, is_hidden: false, size: 0 },
    { name: "FileEditor.tsx", path: `${previewRoot}/app/src/FileEditor.tsx`, is_dir: false, is_symlink: false, is_hidden: false, size: 18400 },
    { name: "GitGraphView.tsx", path: `${previewRoot}/app/src/GitGraphView.tsx`, is_dir: false, is_symlink: false, is_hidden: false, size: 16200 },
    { name: "gitGraphLayout.ts", path: `${previewRoot}/app/src/gitGraphLayout.ts`, is_dir: false, is_symlink: false, is_hidden: false, size: 4800 },
  ]],
  [`${previewRoot}/app/src/dashboard`, [
    { name: "DashboardShell.tsx", path: `${previewRoot}/app/src/dashboard/DashboardShell.tsx`, is_dir: false, is_symlink: false, is_hidden: false, size: 12400 },
    { name: "layoutPreferences.ts", path: `${previewRoot}/app/src/dashboard/layoutPreferences.ts`, is_dir: false, is_symlink: false, is_hidden: false, size: 7200 },
  ]],
]);

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

transport.selectedDirectory = previewRoot;

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
transport.handlers.set("list_local_dashboard_catalog", value({
  sessions: sessions.filter((session) => !session.hostId),
  terminals: terminals.filter((terminal) => !terminal.hostId),
  failedSessionHostIds: hosts.map((host) => host.id),
  failedTerminalHostIds: hosts.map((host) => host.id),
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
transport.handlers.set("load_layout", value({
  layout: {},
  revision: "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY",
}));
transport.handlers.set("save_layout", value({
  revision: "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY",
  unchanged: true,
}));
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
transport.handlers.set("git_graph_refs", value(gitGraphRefs));
transport.handlers.set("git_graph", value(gitGraph));
transport.handlers.set("git_diff", value([
  "diff --git a/app/src/App.tsx b/app/src/App.tsx",
  "--- a/app/src/App.tsx",
  "+++ b/app/src/App.tsx",
  "@@ -1,3 +1,4 @@",
  "+import { SettingsDialog } from \"./dashboard/Settings/SettingsDialog\";",
  " import { Terminal } from \"./Terminal\";",
].join("\n")));
transport.handlers.set("read_dir", (payload) => {
  const { path } = payload as { path: string };
  return previewDirectories.get(path) ?? [];
});
transport.handlers.set("remote_read_dir", value([]));
transport.handlers.set("search_files", value([]));
transport.handlers.set("read_file", (payload) => {
  const { path } = payload as { path: string };
  if (path.endsWith("GitGraphView.tsx")) return previewSource;
  if (path.endsWith("package.json")) return '{\n  "name": "tmux-worktree-dashboard",\n  "private": true\n}\n';
  return "# tmux-worktree\n\nDashboard preview content.\n";
});
transport.handlers.set("remote_read_file", value("# Remote preview\n"));
transport.handlers.set("remote_read_file_base64", value(""));
transport.handlers.set("write_file", nothing);
transport.handlers.set("remote_write_file", nothing);
transport.handlers.set("file_exists", value(true));
transport.handlers.set("remote_file_exists", value(true));
transport.handlers.set("open_url", nothing);
transport.handlers.set("add_project", value(projects));
transport.handlers.set("remove_missing_project", value({ removed: false, projects }));
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
