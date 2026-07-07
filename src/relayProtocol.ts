export type RelaySession = {
  name: string;
  rawName?: string;
  scopeId?: string;
  scopeLabel?: string;
  kind?: "session" | "worktree" | "terminal";
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
  | { type: "create_terminal"; hostId?: string; requestId?: string; scopeId?: string; cwd: string; label?: string }
  | { type: "open_terminal"; hostId?: string; streamId: string; session: string; pane?: string | number }
  | { type: "send_agent_message"; hostId?: string; requestId?: string; session: string; pane?: string | number; message: string; submit?: boolean }
  | { type: "kill_session"; hostId?: string; requestId?: string; session: string }
  | { type: "terminal_input"; streamId: string; data: string }
  | { type: "resize"; streamId: string; cols: number; rows: number }
  | { type: "close_terminal"; streamId: string };

export type RelayToHostMessage = RelayClientMessage & {
  clientId: string;
};

export type RelayHostMessage =
  | { type: "host_ready"; hostId: string; displayName?: string; version?: string }
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

export function parseJsonMessage(raw: unknown): unknown {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return JSON.parse(text);
}

export function sendJson(socket: { send(data: string): void }, message: unknown): void {
  socket.send(JSON.stringify(message));
}

export function isValidHostId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

export function isSafeRelayPath(path: string): boolean {
  return path === "/host" || path === "/client";
}
