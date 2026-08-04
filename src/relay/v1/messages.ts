export type RelaySession = {
  name: string;
  rawName?: string;
  scopeId?: string;
  scopeLabel?: string;
  /** True when lifecycle mutations must go through the TW RPC/state contract. */
  managed?: boolean;
  kind?: "session" | "worktree" | "terminal";
  project?: string;
  label?: string;
  cwd?: string;
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
};

export type RelayHostInfo = {
  hostId: string;
  displayName?: string;
  connectedAt: number;
  clients: number;
};

export type RelayScopeStatus = {
  scopeId: string;
  scopeLabel?: string;
  kind: "local" | "ssh";
  reachable: boolean;
  sessionCount?: number;
  error?: string;
};

export type RelayClientMessage =
  | { type: "list_hosts"; requestId?: string }
  | { type: "list_sessions"; hostId?: string; requestId?: string }
  | { type: "list_scope_statuses"; hostId?: string; requestId?: string }
  | { type: "create_worktree"; hostId?: string; requestId?: string; scopeId?: string; project?: string; path?: string; name?: string; branch?: string; aiCommand?: string; aiCmd?: string }
  | { type: "create_terminal"; hostId?: string; requestId?: string; scopeId?: string; cwd: string; label?: string; aiCommand?: string; aiCmd?: string }
  | { type: "open_terminal"; hostId?: string; streamId: string; session: string; pane?: string | number }
  | { type: "send_agent_message"; hostId?: string; requestId?: string; session: string; pane?: string | number; message: string; submit?: boolean }
  | { type: "kill_session"; hostId?: string; requestId?: string; session: string; managed?: boolean }
  | { type: "terminal_input"; streamId: string; data: string }
  | { type: "resize"; streamId: string; cols: number; rows: number }
  | { type: "close_terminal"; streamId: string };

export type RelayToHostMessage = RelayClientMessage & {
  clientId: string;
};

export const RELAY_HOST_RETIRE_CAPABILITY = "retire-drain-v1";

/** Broker-originated Relay v1 control messages, kept separate from routed client messages. */
export type RelayBrokerControlMessage =
  | { type: "host_registered"; hostId: string }
  | { type: "host_retire" }
  | { type: "client_closed"; clientId: string }
  | { type: "error"; message: string };

/** Every Relay v1 message that the broker may deliver on a host connection. */
export type RelayBrokerToHostMessage = RelayToHostMessage | RelayBrokerControlMessage;

export type RelayHostMessage =
  | { type: "host_ready"; hostId: string; displayName?: string; version?: string; capabilities?: string[] }
  | { type: "host_drained" }
  | { type: "sessions"; clientId: string; requestId?: string; sessions: RelaySession[] }
  | { type: "scope_statuses"; clientId: string; requestId?: string; scopes: RelayScopeStatus[] }
  | { type: "worktree_created"; clientId: string; requestId?: string; session: RelaySession }
  | { type: "terminal_created"; clientId: string; requestId?: string; session: RelaySession }
  | { type: "agent_message_sent"; clientId: string; requestId?: string; session: string; pane?: string | number }
  | { type: "session_killed"; clientId: string; requestId?: string; session: string }
  | { type: "terminal_data"; clientId: string; streamId: string; data: string }
  | { type: "terminal_exit"; clientId: string; streamId: string; code?: number }
  | { type: "error"; clientId?: string; requestId?: string; streamId?: string; message: string };

export type RelayToClientMessage =
  | { type: "ready"; clientId: string; hostId?: string }
  | { type: "hosts"; requestId?: string; hosts: RelayHostInfo[] }
  | { type: "sessions"; requestId?: string; sessions: RelaySession[] }
  | { type: "scope_statuses"; requestId?: string; scopes: RelayScopeStatus[] }
  | { type: "worktree_created"; requestId?: string; session: RelaySession }
  | { type: "terminal_created"; requestId?: string; session: RelaySession }
  | { type: "agent_message_sent"; requestId?: string; session: string; pane?: string | number }
  | { type: "session_killed"; requestId?: string; session: string }
  | { type: "terminal_data"; streamId: string; data: string }
  | { type: "terminal_exit"; streamId: string; code?: number }
  | { type: "error"; requestId?: string; streamId?: string; message: string };
