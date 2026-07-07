import { basename, join } from "node:path";
import { loadConfigFile } from "./config";
import { loadManagedState, twHomeDir, type ManagedSession, type ManagedState } from "./state";
import {
  createManagedWorktreeSession,
  SESSION_NAME_MAX_LEN,
} from "./session";
import { listSessions, type SessionEntry } from "./tmux";

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

export function buildRpcCapabilitiesResponse(): RpcCapabilitiesResponse {
  return {
    protocolVersion: RPC_PROTOCOL_VERSION,
    app: "tmux-worktree",
    capabilities: [
      "list",
      "managed-state",
      "create-worktree",
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
  const projectDir = args.path?.trim() || configuredProject?.path;
  if (!projectDir) {
    throw new Error("create-worktree requires --path or --project");
  }
  const project = args.project?.trim() || basename(projectDir) || "project";
  const title = args.name?.trim();
  const sessionName = (title ? `${project}-${title}` : project)
    .slice(0, SESSION_NAME_MAX_LEN);
  const worktreeBase = args.worktreeBase?.trim()
    || config?.worktreeBase
    || join(twHomeDir(), "worktrees");
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
    layout: "dashboard",
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

export async function rpcCmd(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "capabilities":
      console.log(JSON.stringify(buildRpcCapabilitiesResponse()));
      return;
    case "create-worktree":
      console.log(JSON.stringify(buildRpcCreateWorktreeResponse(parseRpcCreateWorktreeArgs(args.slice(1)))));
      return;
    case "list":
      console.log(JSON.stringify(buildRpcListResponse(loadManagedState(), listSessions(true))));
      return;
    default:
      throw new Error(`unknown rpc command: ${sub}`);
  }
}
