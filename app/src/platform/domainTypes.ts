export type Session = {
  name: string;
  attached: boolean;
  window_count: number;
  created: number;
  activity: number;
  output_signature?: string | null;
  agent_running?: boolean | null;
  hostId?: string | null;
  rawName?: string;
  project?: string | null;
  managed?: boolean;
};

export type HostConfig = {
  id: string;
  label: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
  worktreeBase?: string | null;
  tmuxPath?: string | null;
  twPath?: string | null;
};

export type HostInput = Pick<HostConfig, "id" | "label" | "host"> &
  Partial<Pick<HostConfig, "user" | "port" | "identityFile">>;

export type AddHostInput = HostInput &
  Partial<Pick<HostConfig, "worktreeBase" | "tmuxPath" | "twPath">>;

export type UpdateHostInput = AddHostInput;

export type HostStatus = {
  id: string;
  label: string;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  tmuxAvailable?: boolean;
  tmuxVersion?: string | null;
  tmuxError?: string | null;
  twAvailable: boolean;
  twVersion: string | null;
  twError: string | null;
  twProtocolVersion?: number | null;
  twCapabilities?: string[];
  twCompatible?: boolean;
};

export type AgentProbeId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "aider";

export type AgentProbeTarget =
  | { kind: "local" }
  | { kind: "host"; hostId: string };

export type AgentProbeResult = {
  id: AgentProbeId;
  label: string;
  command: AgentProbeId;
  available: boolean;
  executablePath: string | null;
  error: string | null;
};

export type PlainTerminal = {
  id: string;
  label: string;
  cwd: string;
  tmuxName: string;
  hostId?: string | null;
  rawName?: string;
  aiCmd?: string;
  discovered?: boolean;
  managed?: boolean;
};

export type DashboardCatalogSnapshot = {
  sessions: Session[];
  terminals: PlainTerminal[];
  failedSessionHostIds: string[];
  failedTerminalHostIds: string[];
};

export type CreatedTerminal = {
  tmuxName: string;
  hostId?: string | null;
  rawName: string;
  cwd: string;
  managed: boolean;
};

export type CreateTerminalInput = {
  cwd: string;
  aiCmd: string;
  hostId?: string | null;
};

export type EnsureTerminalInput = {
  name: string;
  cwd: string;
  aiCmd?: string;
  hostId?: string | null;
  rawName?: string | null;
};

export type ProjectPreset = {
  name: string;
  path: string;
  branch?: string | null;
};

export type AddProjectInput = Pick<ProjectPreset, "name" | "path">;

export type OrphanedWorktree = {
  project: string;
  path: string;
  name: string;
};

export type CreateWorktreeInput = {
  project?: string;
  path?: string;
  aiCmd: string;
  name: string | null;
  branch?: string;
  hostId?: string;
};

export type RestoreWorktreeInput = {
  path: string;
  name: string;
  aiCmd?: string;
};

export type DeleteWorktreeInput = {
  path: string;
  force?: boolean;
};

export type TmuxStatusTheme = {
  statusBg: string;
  statusFg: string;
  activeBg: string;
  activeFg: string;
  inactiveFg: string;
  accent: string;
};

export type GitFile = { code: string; path: string };

export type GitStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  files: GitFile[];
};

export type GitGraphPreset = "head" | "current" | "all";

export type GitGraphRefKind = "head" | "local" | "remote" | "tag";

export type GitGraphRef = {
  /** Canonical ref name, for example refs/heads/main. */
  name: string;
  shortName: string;
  kind: GitGraphRefKind;
  current: boolean;
  upstream: string | null;
};

export type GitGraphRefs = {
  refs: GitGraphRef[];
  current: string | null;
  upstream: string | null;
};

export type GitGraphQuery = {
  preset: GitGraphPreset;
  selectedRefs: string[];
  limit?: number;
};

export type GitGraphCommit = {
  hash: string;
  short: string;
  parents: string[];
  subject: string;
  author: string;
  relTime: string;
  authoredAt?: string | null;
  decorations: GitGraphRef[];
};

export type GitGraphResponse = GitGraphRefs & {
  commits: GitGraphCommit[];
  hasMore: boolean;
};

export type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  is_hidden: boolean;
  size: number;
};

export type FileSearchMode = "content" | "filename";

export type FileSearchResult = {
  path: string;
  file_name: string;
  line_number: number | null;
  line_content: string | null;
};

export type MobileRelayStatus = {
  active: boolean;
  connected: boolean;
  connectionState: string;
  relayUrl: string;
  hostId: string;
  secret: string;
  token: string;
  connectedAt?: number | null;
  updatedAt?: number | null;
  retryInMs?: number | null;
  error?: string | null;
};

export type MobileRelayConfigInput = {
  relayUrl: string;
  hostId: string;
  secret: string;
};

export type MobileRelayBrokerInput = {
  hostId: string;
  port?: number;
};

// Layout is intentionally tolerant while Phase 2 migrates the legacy persisted
// shape. Callers validate individual fields before restoring them.
export type DashboardLayout = Record<string, unknown>;
