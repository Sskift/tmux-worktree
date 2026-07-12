import { basename } from "node:path";
import { expandHomePath, loadConfigFile, resolveWorktreeBase } from "./config";
import {
  loadManagedState,
  loadManagedStateForMutation,
  removeManagedSessionIfCurrent,
  type ManagedSession,
  type ManagedState,
} from "./state";
import {
  createManagedTerminalSession,
  createManagedWorktreeSession,
  restoreManagedWorktreeSession,
  SESSION_NAME_MAX_LEN,
} from "./session";
import { listSessions, run, sessionExists, tmuxBin, type SessionEntry } from "./tmux";

export const RPC_PROTOCOL_VERSION = 1;

export interface RpcManagedSession extends ManagedSession {
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
  cwd: string;
}

export interface RpcListResponse {
  protocolVersion: number;
  sessions: RpcManagedSession[];
}

export interface RpcCapabilitiesResponse {
  protocolVersion: number;
  app: "tmux-worktree";
  capabilities: string[];
}

export interface RpcCreateWorktreeArgs {
  path?: string;
  aiCommand: string;
  name?: string;
  branch?: string;
  project?: string;
  worktreeBase?: string;
}

export interface RpcCreateWorktreeResponse {
  protocolVersion: number;
  kind: "worktree";
  session: string;
  worktreePath: string;
  branch?: string;
}

export interface RpcCreateTerminalArgs {
  cwd: string;
  aiCommand?: string;
}

export interface RpcCreateTerminalResponse {
  protocolVersion: number;
  kind: "terminal";
  session: string;
  cwd: string;
}

export interface RpcRestoreWorktreeArgs {
  path: string;
  name: string;
  aiCommand?: string;
  project?: string;
}

export interface RpcKillSessionResponse {
  protocolVersion: number;
  kind: "session-killed";
  session: string;
  sessionKind: "worktree" | "terminal";
  killed: boolean;
}

export function buildRpcCapabilitiesResponse(): RpcCapabilitiesResponse {
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    app: "tmux-worktree",
    capabilities: [
      "list",
      "managed-state",
      "create-worktree",
      "create-terminal",
      "restore-worktree",
      "kill-session",
    ],
  };
}

export function buildRpcListResponse(
  state: ManagedState,
  liveSessions: SessionEntry[],
): RpcListResponse {
  const liveByName = new Map(liveSessions.map((session) => [session.name, session]));
  const sessions = state.sessions.flatMap((managed) => {
    const live = liveByName.get(managed.name);
    if (!live) return [];
    return [{
      ...managed,
      attached: live.attached,
      windows: live.windows,
      created: live.created,
      activity: live.activity,
      cwd: live.cwd,
    }];
  });
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    sessions,
  };
}

export function parseRpcCreateWorktreeArgs(args: string[]): RpcCreateWorktreeArgs {
  const parsed: Partial<RpcCreateWorktreeArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--path") {
      parsed.path = next();
    } else if (arg === "--ai-command" || arg === "--cmd") {
      parsed.aiCommand = next();
    } else if (arg === "--name") {
      parsed.name = next();
    } else if (arg === "--branch") {
      parsed.branch = next();
    } else if (arg === "--project") {
      parsed.project = next();
    } else if (arg === "--worktree-base") {
      parsed.worktreeBase = next();
    } else {
      throw new Error(`unknown create-worktree option: ${arg}`);
    }
  }

  if (!parsed.path?.trim() && !parsed.project?.trim()) {
    throw new Error("create-worktree requires --path or --project");
  }
  if (!parsed.aiCommand?.trim()) throw new Error("create-worktree requires --ai-command");
  const result: RpcCreateWorktreeArgs = {
    aiCommand: parsed.aiCommand.trim(),
  };
  if (parsed.path?.trim()) result.path = parsed.path.trim();
  if (parsed.project?.trim()) result.project = parsed.project.trim();
  if (parsed.name !== undefined) result.name = parsed.name;
  if (parsed.branch !== undefined) result.branch = parsed.branch;
  if (parsed.worktreeBase !== undefined) result.worktreeBase = parsed.worktreeBase;
  return result;
}

export function buildRpcCreateWorktreeResponse(
  args: RpcCreateWorktreeArgs,
): RpcCreateWorktreeResponse {
  const config = loadConfigFile();
  const configuredProject = args.project?.trim()
    ? config?.projects[args.project.trim()]
    : undefined;
  if (args.project?.trim() && !configuredProject && !args.path?.trim()) {
    throw new Error(`project '${args.project.trim()}' not in ~/.tmux-worktree.json`);
  }
  const projectDir = args.path?.trim()
    ? expandHomePath(args.path.trim())
    : configuredProject?.path;
  if (!projectDir) {
    throw new Error("create-worktree requires --path or --project");
  }
  const project = args.project?.trim() || basename(projectDir) || "project";
  const title = args.name?.trim();
  const sessionName = (title ? `${project}-${title}` : project)
    .slice(0, SESSION_NAME_MAX_LEN);
  const worktreeBase = resolveWorktreeBase(args.worktreeBase?.trim() || config?.worktreeBase);
  const branch = args.branch?.trim() || configuredProject?.branch;
  const created = createManagedWorktreeSession({
    aiCmd: args.aiCommand,
    projectDir,
    sessionName,
    useWorktree: true,
    projectKey: project,
    branch,
    worktreeBase,
    profile: "dashboard",
    quiet: true,
  });

  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "worktree",
    session: created.session,
    worktreePath: created.worktree?.path ?? created.workDir,
    branch: created.worktree?.branch,
  };
}

export function parseRpcCreateTerminalArgs(args: string[]): RpcCreateTerminalArgs {
  const parsed: Partial<RpcCreateTerminalArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--cwd" || arg === "--path") parsed.cwd = next();
    else if (arg === "--ai-command" || arg === "--cmd") parsed.aiCommand = next();
    else throw new Error(`unknown create-terminal option: ${arg}`);
  }
  if (!parsed.cwd?.trim()) throw new Error("create-terminal requires --cwd");
  const result: RpcCreateTerminalArgs = { cwd: parsed.cwd.trim() };
  if (parsed.aiCommand !== undefined) result.aiCommand = parsed.aiCommand.trim();
  return result;
}

export function buildRpcCreateTerminalResponse(
  args: RpcCreateTerminalArgs,
): RpcCreateTerminalResponse {
  const created = createManagedTerminalSession({
    cwd: expandHomePath(args.cwd),
    aiCmd: args.aiCommand,
    profile: "dashboard",
    quiet: true,
  });
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "terminal",
    session: created.session,
    cwd: created.cwd,
  };
}

export function parseRpcRestoreWorktreeArgs(args: string[]): RpcRestoreWorktreeArgs {
  const parsed: Partial<RpcRestoreWorktreeArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--path") parsed.path = next();
    else if (arg === "--name") parsed.name = next();
    else if (arg === "--ai-command" || arg === "--cmd") parsed.aiCommand = next();
    else if (arg === "--project") parsed.project = next();
    else throw new Error(`unknown restore-worktree option: ${arg}`);
  }
  if (!parsed.path?.trim()) throw new Error("restore-worktree requires --path");
  if (!parsed.name?.trim()) throw new Error("restore-worktree requires --name");
  const result: RpcRestoreWorktreeArgs = {
    path: parsed.path.trim(),
    name: parsed.name.trim().slice(0, SESSION_NAME_MAX_LEN),
  };
  if (parsed.aiCommand !== undefined) result.aiCommand = parsed.aiCommand.trim();
  if (parsed.project?.trim()) result.project = parsed.project.trim();
  return result;
}

export function buildRpcRestoreWorktreeResponse(
  args: RpcRestoreWorktreeArgs,
): RpcCreateWorktreeResponse {
  const restored = restoreManagedWorktreeSession({
    worktreePath: expandHomePath(args.path),
    sessionName: args.name,
    aiCmd: args.aiCommand,
    projectKey: args.project,
    profile: "dashboard",
    quiet: true,
  });
  const state = loadManagedState();
  const record = state.sessions.find((session) => session.name === restored.session);
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "worktree",
    session: restored.session,
    worktreePath: restored.workDir,
    branch: record?.branch,
  };
}

export function parseRpcKillSessionArgs(args: string[]): { name: string } {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" || arg === "--session") {
      const value = args[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      name = value;
    } else {
      throw new Error(`unknown kill-session option: ${arg}`);
    }
  }
  if (!name?.trim()) throw new Error("kill-session requires --name");
  return { name: name.trim() };
}

export function buildRpcKillSessionResponse(
  args: { name: string },
  deps: {
    loadState?: () => ManagedState;
    exists?: (name: string) => boolean;
    kill?: (name: string) => void;
    removeRecord?: (name: string, expected: ManagedSession) => void;
  } = {},
): RpcKillSessionResponse {
  const state = (deps.loadState ?? loadManagedStateForMutation)();
  const managed = state.sessions.find((session) => session.name === args.name);
  if (!managed) throw new Error(`session is not TW-managed: ${args.name}`);
  const live = (deps.exists ?? sessionExists)(args.name);
  if (live) {
    (deps.kill ?? ((name) => {
      run(tmuxBin(), ["kill-session", "-t", `=${name}`]);
    }))(args.name);
  }
  (deps.removeRecord ?? ((_name, expected) => {
    removeManagedSessionIfCurrent(expected);
  }))(args.name, managed);
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    kind: "session-killed",
    session: args.name,
    sessionKind: managed.kind,
    killed: live,
  };
}

export async function rpcCmd(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "capabilities":
      console.log(JSON.stringify(buildRpcCapabilitiesResponse()));
      return;
    case "create-worktree":
      console.log(JSON.stringify(buildRpcCreateWorktreeResponse(parseRpcCreateWorktreeArgs(args.slice(1)))));
      return;
    case "create-terminal":
      console.log(JSON.stringify(buildRpcCreateTerminalResponse(parseRpcCreateTerminalArgs(args.slice(1)))));
      return;
    case "restore-worktree":
      console.log(JSON.stringify(buildRpcRestoreWorktreeResponse(parseRpcRestoreWorktreeArgs(args.slice(1)))));
      return;
    case "kill-session":
      console.log(JSON.stringify(buildRpcKillSessionResponse(parseRpcKillSessionArgs(args.slice(1)))));
      return;
    case "list":
      console.log(JSON.stringify(buildRpcListResponse(loadManagedState(), listSessions(true))));
      return;
    default:
      throw new Error(`unknown rpc command: ${sub}`);
  }
}
