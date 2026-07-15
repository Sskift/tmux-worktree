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

export type RemoveMissingProjectInput = Pick<ProjectPreset, "name" | "path">;

export type RemoveMissingProjectResult = {
  removed: boolean;
  projects: ProjectPreset[];
};

export type OrphanedWorktree = {
  project: string;
  path: string;
  name: string;
  hostId?: string | null;
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
  hostId?: string;
};

export type DeleteWorktreeInput = {
  path: string;
  force?: boolean;
  hostId?: string;
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
  brokerHostId: string;
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
  brokerHostId: string;
  hostId: string;
  secret: string;
};

export type MobileRelayBrokerInput = {
  hostId: string;
  port?: number;
  quickTunnel?: boolean;
};

export const MOBILE_RELAY_V2_REQUIRED_CAPABILITIES = [
  "error.structured.v1",
  "command.ledger.v1",
  "command.query.v1",
  "snapshot.revision.v1",
  "event.sequence.v1",
  "terminal.stream.resume.v1",
] as const;

export type MobileRelayV2RequiredCapability =
  (typeof MOBILE_RELAY_V2_REQUIRED_CAPABILITIES)[number];

export type MobileRelayV2AdapterAuthority =
  | { kind: "unavailable"; reason: string }
  | { kind: "fake_preview"; reason: null }
  | { kind: "node"; reason: null };

export type MobileRelayV1SharedSecretProfile = {
  protocolVersion: 1;
  credentialKind: "legacy_shared_secret";
  sharedSecretConfigured: boolean;
};

export type MobileRelayV2HostCredential = {
  protocolVersion: 2;
  credentialKind: "twcap2_grant";
  status: "missing" | "bootstrapping" | "ready" | "refreshing" | "failed";
  credentialReference: string | null;
  expiresAtMs: number | null;
  error: string | null;
  retryable: boolean | null;
};

type MobileRelayV2StoppedConnector = {
  status: "stopped";
  acknowledgement: null;
  hostId: null;
  connectorId: null;
  negotiatedCapabilityIntersection: readonly [];
  exitCode: null;
  error: null;
  retryable: null;
};

type MobileRelayV2StartingConnector = {
  status: "starting";
  acknowledgement: null;
  hostId: string | null;
  connectorId: null;
  negotiatedCapabilityIntersection: readonly [];
  exitCode: null;
  error: null;
  retryable: null;
};

type MobileRelayV2RegisteredConnector = {
  status: "registered" | "registered_incomplete";
  acknowledgement: "host.registered";
  hostId: string;
  connectorId: string;
  /** Capabilities accepted by both the broker and authenticated host connector. */
  negotiatedCapabilityIntersection: readonly string[];
  exitCode: null;
  error: null;
  retryable: null;
};

type MobileRelayV2FailedConnector = {
  status: "failed";
  acknowledgement: null;
  hostId: null;
  connectorId: null;
  negotiatedCapabilityIntersection: readonly [];
  exitCode: null;
  error: string;
  retryable: boolean;
};

type MobileRelayV2SupersededConnector = {
  status: "superseded";
  acknowledgement: null;
  hostId: null;
  connectorId: null;
  negotiatedCapabilityIntersection: readonly [];
  exitCode: 78;
  error: string;
  retryable: false;
};

export type MobileRelayV2Connector =
  | MobileRelayV2StoppedConnector
  | MobileRelayV2StartingConnector
  | MobileRelayV2RegisteredConnector
  | MobileRelayV2FailedConnector
  | MobileRelayV2SupersededConnector;

export type MobileRelayV2EnrollmentReview = {
  enrollment: {
    enrollmentId: string;
    enrollmentCode: string;
    expiresAtMs: number;
  };
  display: {
    issuerUrl: string;
    relayUrl: string;
    hostId: string;
    deviceLabel: string | null;
  };
};

export type MobileRelayV2Enrollment =
  | { status: "idle" }
  | { status: "creating"; intent: "create" | "retry" | "rebuild" }
  | { status: "active"; review: MobileRelayV2EnrollmentReview }
  | { status: "expired"; enrollmentId: string; expiredAtMs: number }
  | {
      status: "failed";
      intent: "create" | "retry" | "rebuild";
      error: string;
      retryable: boolean;
    };

export type MobileRelayV2KnownClientGrant =
  | { status: "unknown" }
  | { status: "active"; grantId: string }
  | { status: "revoking"; grantId: string }
  | {
      status: "revoked";
      grantId: string;
      revokedAtMs: number;
      alreadyRevoked: boolean;
    }
  | { status: "failed"; grantId: string; error: string; retryable: boolean };

export type MobileRelayV2DashboardState = {
  authority: MobileRelayV2AdapterAuthority;
  v1Profile: MobileRelayV1SharedSecretProfile;
  hostCredential: MobileRelayV2HostCredential;
  connector: MobileRelayV2Connector;
  enrollment: MobileRelayV2Enrollment;
  knownClientGrant: MobileRelayV2KnownClientGrant;
};

export type MobileRelayV2CreateEnrollmentInput = {
  intent: "create" | "retry" | "rebuild";
  deviceLabel?: string | null;
};

export type MobileRelayV2OperationFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type MobileRelayV2RevokeClientGrantInput = {
  grantId: string;
  reason: "user_revoked";
};

export type FeishuBindingStatus = "active" | "pausing" | "paused" | "stale";

export type FeishuBinding = {
  version: 1;
  id: string;
  chatId: string;
  chatName: string;
  controlTargetId: string;
  backendBirthId?: string;
  sessionName: string;
  status: FeishuBindingStatus;
  options: {
    mentionOnly: boolean;
    replyAsCard: boolean;
    includeQuotedContext: boolean;
  };
  allowedSenderIds: string[];
  createdAt: string;
  createdBy: string;
  lastActivityAt?: string;
  staleReason?: string;
};

export type FeishuBridgeSnapshot = {
  instanceId: string;
  bindings: FeishuBinding[];
  activeTurns: Array<{ id: string; bindingId: string; status: string; deadlineAt: string }>;
  uncertainReplies: Array<{ id: string; turnId: string; status: "uncertain"; error?: string }>;
};

export type FeishuChat = {
  chatId: string;
  name: string;
  ownerId?: string;
};

export type FeishuLarkProfile = {
  name: string;
  appId: string;
  brand: string;
  displayName?: string | null;
  active: boolean;
  user?: string | null;
  tokenStatus?: string | null;
};

export type FeishuIntegrationStatus = {
  selectedProfile?: string | null;
  profileSource: "none" | "config" | "environment";
  bridgeRunning: boolean;
  profiles: FeishuLarkProfile[];
  profilesError?: string | null;
};

export type FeishuAddProfileInput = {
  appId: string;
  appSecret: string;
  brand: "feishu" | "lark";
};

export type FeishuAddProfileResult = {
  status: FeishuIntegrationStatus;
  addedProfile: string;
  warning?: string | null;
};

export type FeishuBindingInput = {
  chatId: string;
  chatName: string;
  sessionName: string;
  createdBy: string;
  allowedSenderIds?: string[];
  mentionOnly?: boolean;
  attachmentId?: string;
};

// Layout is intentionally tolerant while Phase 2 migrates the legacy persisted
// shape. Callers validate individual fields before restoring them.
export type DashboardLayout = Record<string, unknown>;

export type DashboardLayoutRevision = string;

export type DashboardLayoutLoadResult = {
  layout: unknown;
  revision: DashboardLayoutRevision;
};

export type DashboardLayoutSaveResult = {
  revision: DashboardLayoutRevision;
  unchanged: boolean;
};

export type DashboardLayoutPersistenceErrorCode =
  | "LAYOUT_REVISION_CONFLICT"
  | "LAYOUT_STATE_BLOCKED"
  | "LAYOUT_INVALID_REQUEST"
  | "LAYOUT_IO_ERROR";

export type DashboardLayoutPersistenceError = {
  code: DashboardLayoutPersistenceErrorCode;
  message: string;
  retryable: boolean;
  currentRevision?: DashboardLayoutRevision;
};
