import { basename } from "node:path";
import { expandHomePath, loadConfigFile, resolveWorktreeBase } from "./config";
import {
  createManagedTerminalSession,
  createManagedWorktreeSession,
  killManagedSessionV2,
  ManagedSessionLifecycleV2InDoubtError,
  observeManagedSessionIncarnation,
  SESSION_NAME_MAX_LEN,
  type CreateManagedWorktreeSessionDeps,
} from "./session";
import {
  assertManagedStateLifecycleV2Authority,
  loadManagedStateForMutation,
  normalizeManagedSessionReservationCorrelation,
  type ManagedSession,
  type ManagedSessionReservationCorrelationV1,
  type ManagedState,
} from "./state";
import {
  listTmuxSessionLifecycleEntries,
  type TmuxSessionLifecycleEntry,
} from "./tmux";

export const RPC_V2_PROTOCOL_VERSION = 2;
export const RPC_V2_CAPABILITIES = Object.freeze([
  "incarnation-list.v1",
  "reservation-correlation.v1",
  "correlated-create-worktree.v1",
  "correlated-create-terminal.v1",
  "expected-incarnation-kill-session.v1",
  "hard-timeout.v1",
] as const);

export interface RpcV2CapabilitiesResponse {
  protocolVersion: 2;
  app: "tmux-worktree";
  capabilities: string[];
}

export interface RpcV2Session {
  name: string;
  kind: "worktree" | "terminal";
  profile: "cli" | "dashboard";
  project: string | null;
  label: string | null;
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  cwd: string;
  createdAt: string;
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
  incarnation: string;
  lifecycleMarked: boolean;
  reservationCorrelation: ManagedSessionReservationCorrelationV1 | null;
}

export interface RpcV2ListResponse {
  protocolVersion: 2;
  sessions: RpcV2Session[];
}

export interface RpcV2CreateWorktreeRequest {
  arguments: {
    project?: string;
    path?: string;
    name?: string;
    branch?: string;
    aiCommand: string;
  };
  reservationCorrelation: ManagedSessionReservationCorrelationV1;
}

export interface RpcV2CreateTerminalRequest {
  arguments: {
    cwd: string;
    label?: string;
  };
  reservationCorrelation: ManagedSessionReservationCorrelationV1;
}

export interface RpcV2KillSessionRequest {
  name: string;
  expectedIncarnation: string;
}

export type RpcV2CreateResponse =
  | {
      protocolVersion: 2;
      operation: "create-worktree" | "create-terminal";
      state: "succeeded";
      session: RpcV2Session;
    }
  | {
      protocolVersion: 2;
      operation: "create-worktree" | "create-terminal";
      state: "failed";
      sideEffect: "not_applied";
      error: { code: "CREATE_FAILED"; message: string };
    }
  | {
      protocolVersion: 2;
      operation: "create-worktree" | "create-terminal";
      state: "in_doubt";
      error: { code: "IN_DOUBT"; message: string };
    };

export type RpcV2KillSessionResponse = {
  protocolVersion: 2;
  operation: "kill-session";
} & ReturnType<typeof killManagedSessionV2>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  return boundedString(record[field], field, maxBytes);
}

function parseRequestJsonArg(args: string[]): unknown {
  if (args.length !== 2 || args[0] !== "--request-json") {
    throw new Error("RPC v2 mutation requires exactly --request-json <json>");
  }
  try {
    return JSON.parse(args[1]);
  } catch (error) {
    throw new Error(`invalid RPC v2 request JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCorrelation(value: unknown): ManagedSessionReservationCorrelationV1 {
  return normalizeManagedSessionReservationCorrelation(value);
}

export function parseRpcV2CreateWorktreeRequest(value: unknown): RpcV2CreateWorktreeRequest {
  if (!isRecord(value) || !exactKeys(value, ["arguments", "reservationCorrelation"])) {
    throw new Error("invalid RPC v2 create-worktree request");
  }
  const raw = value.arguments;
  if (!isRecord(raw) || !exactKeys(raw, ["aiCommand"], ["project", "path", "name", "branch"])) {
    throw new Error("invalid RPC v2 create-worktree arguments");
  }
  const project = optionalString(raw, "project", 128);
  const path = optionalString(raw, "path", 4_096);
  if (!project && !path) throw new Error("create-worktree requires project or path");
  const name = optionalString(raw, "name", 80);
  if (name && Array.from(name).length > SESSION_NAME_MAX_LEN) {
    throw new Error(`create-worktree name exceeds ${SESSION_NAME_MAX_LEN} characters`);
  }
  const branch = optionalString(raw, "branch", 255);
  const aiCommand = boundedString(raw.aiCommand, "aiCommand", 4_096);
  return {
    arguments: {
      ...(project ? { project } : {}),
      ...(path ? { path } : {}),
      ...(name ? { name } : {}),
      ...(branch ? { branch } : {}),
      aiCommand,
    },
    reservationCorrelation: parseCorrelation(value.reservationCorrelation),
  };
}

export function parseRpcV2CreateTerminalRequest(value: unknown): RpcV2CreateTerminalRequest {
  if (!isRecord(value) || !exactKeys(value, ["arguments", "reservationCorrelation"])) {
    throw new Error("invalid RPC v2 create-terminal request");
  }
  const raw = value.arguments;
  if (!isRecord(raw) || !exactKeys(raw, ["cwd"], ["label"])) {
    throw new Error("invalid RPC v2 create-terminal arguments");
  }
  const cwd = boundedString(raw.cwd, "cwd", 4_096);
  const label = optionalString(raw, "label", 128);
  return {
    arguments: { cwd, ...(label ? { label } : {}) },
    reservationCorrelation: parseCorrelation(value.reservationCorrelation),
  };
}

export function parseRpcV2KillSessionRequest(value: unknown): RpcV2KillSessionRequest {
  if (!isRecord(value) || !exactKeys(value, ["name", "expectedIncarnation"])) {
    throw new Error("invalid RPC v2 kill-session request");
  }
  const expectedIncarnation = boundedString(
    value.expectedIncarnation,
    "expectedIncarnation",
    128,
  );
  if (!/^twinc2\.[A-Za-z0-9_-]{43}$/.test(expectedIncarnation)) {
    throw new Error("invalid expectedIncarnation");
  }
  return { name: boundedString(value.name, "name", 128), expectedIncarnation };
}

export function buildRpcV2CapabilitiesResponse(): RpcV2CapabilitiesResponse {
  return {
    protocolVersion: RPC_V2_PROTOCOL_VERSION,
    app: "tmux-worktree",
    capabilities: [...RPC_V2_CAPABILITIES],
  };
}

/** A v2 consumer either gets the complete atomic surface or stops; there is no v1 path here. */
export function assertRpcV2Capabilities(value: unknown): RpcV2CapabilitiesResponse {
  if (!isRecord(value)
    || value.protocolVersion !== RPC_V2_PROTOCOL_VERSION
    || value.app !== "tmux-worktree"
    || !Array.isArray(value.capabilities)
    || value.capabilities.some((capability) => typeof capability !== "string")) {
    throw new Error("TW RPC v2 capabilities response is incompatible");
  }
  const advertised = new Set(value.capabilities as string[]);
  const missing = RPC_V2_CAPABILITIES.filter((capability) => !advertised.has(capability));
  if (missing.length > 0) {
    throw new Error(`TW RPC v2 capability unavailable: ${missing.join(", ")}`);
  }
  return {
    protocolVersion: 2,
    app: "tmux-worktree",
    capabilities: [...value.capabilities as string[]],
  };
}

function projectRpcV2Session(
  managed: ManagedSession,
  live: TmuxSessionLifecycleEntry,
): RpcV2Session | undefined {
  const observed = observeManagedSessionIncarnation(managed, live);
  if (!observed) return undefined;
  return {
    name: managed.name,
    kind: managed.kind,
    profile: managed.profile,
    project: managed.project ?? null,
    label: observed.displayLabel,
    repoPath: managed.repoPath ?? null,
    worktreePath: managed.worktreePath ?? null,
    branch: managed.branch ?? null,
    baseBranch: managed.baseBranch ?? null,
    cwd: live.cwd,
    createdAt: managed.createdAt,
    attached: live.attached,
    windows: live.windows,
    created: live.created,
    activity: live.activity,
    incarnation: observed.incarnation,
    lifecycleMarked: observed.lifecycleMarked,
    reservationCorrelation: observed.reservationCorrelation,
  };
}

export function buildRpcV2ListResponse(
  state: ManagedState,
  liveSessions: TmuxSessionLifecycleEntry[],
): RpcV2ListResponse {
  const liveByName = new Map(liveSessions.map((session) => [session.rawName, session]));
  return {
    protocolVersion: RPC_V2_PROTOCOL_VERSION,
    sessions: state.sessions.flatMap((managed) => {
      const live = liveByName.get(managed.name);
      if (!live) return [];
      const projected = projectRpcV2Session(managed, live);
      return projected ? [projected] : [];
    }),
  };
}

function currentRpcV2List(): RpcV2ListResponse {
  // Strict state first: corrupt state must fail before lifecycle discovery can
  // invoke tmux, even though list itself performs no destructive mutation.
  const state = loadManagedStateForMutation();
  assertManagedStateLifecycleV2Authority(state);
  return buildRpcV2ListResponse(state, listTmuxSessionLifecycleEntries());
}

function createFailure(
  operation: "create-worktree" | "create-terminal",
  error: unknown,
): RpcV2CreateResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ManagedSessionLifecycleV2InDoubtError) {
    return {
      protocolVersion: 2,
      operation,
      state: "in_doubt",
      error: { code: "IN_DOUBT", message },
    };
  }
  return {
    protocolVersion: 2,
    operation,
    state: "failed",
    sideEffect: "not_applied",
    error: { code: "CREATE_FAILED", message },
  };
}

interface RpcV2CreateExecutionDeps {
  currentList?: () => RpcV2ListResponse;
  createWorktree?: typeof createManagedWorktreeSession;
  createTerminal?: typeof createManagedTerminalSession;
  loadConfig?: typeof loadConfigFile;
  worktreeSessionDeps?: CreateManagedWorktreeSessionDeps;
  terminalSessionDeps?: CreateManagedWorktreeSessionDeps;
}

function committedCreateObservationFailure(
  operation: "create-worktree" | "create-terminal",
  session: string,
  error: unknown,
): RpcV2CreateResponse {
  const detail = error instanceof Error ? error.message : String(error);
  return createFailure(operation, new ManagedSessionLifecycleV2InDoubtError(
    `created ${operation === "create-worktree" ? "worktree" : "terminal"} ${session} committed but post-commit observation is uncertain: ${detail}`,
  ));
}

export function executeRpcV2CreateWorktree(
  request: RpcV2CreateWorktreeRequest,
  deps: RpcV2CreateExecutionDeps = {},
): RpcV2CreateResponse {
  let created: ReturnType<typeof createManagedWorktreeSession>;
  try {
    const config = (deps.loadConfig ?? loadConfigFile)();
    const configuredProject = request.arguments.project
      ? config?.projects[request.arguments.project]
      : undefined;
    if (request.arguments.project && !configuredProject && !request.arguments.path) {
      throw new Error(`project '${request.arguments.project}' not in ~/.tmux-worktree.json`);
    }
    const projectDir = request.arguments.path
      ? expandHomePath(request.arguments.path)
      : configuredProject?.path;
    if (!projectDir) throw new Error("create-worktree requires project or path");
    const project = request.arguments.project || basename(projectDir) || "project";
    const title = request.arguments.name;
    const sessionName = (title ? `${project}-${title}` : project).slice(0, SESSION_NAME_MAX_LEN);
    created = (deps.createWorktree ?? createManagedWorktreeSession)({
      aiCmd: request.arguments.aiCommand,
      projectDir,
      sessionName,
      useWorktree: true,
      worktreeBase: resolveWorktreeBase(config?.worktreeBase),
      projectKey: project,
      branch: request.arguments.branch ?? configuredProject?.branch,
      profile: "dashboard",
      quiet: true,
      lifecycleV2: {
        reservationCorrelation: request.reservationCorrelation,
        displayLabel: null,
      },
    }, deps.worktreeSessionDeps);
  } catch (error) {
    return createFailure("create-worktree", error);
  }

  try {
    const session = (deps.currentList ?? currentRpcV2List)().sessions.find((item) => (
      item.name === created.session
      && item.incarnation === created.lifecycleV2?.incarnation
    ));
    if (!session) {
      throw new ManagedSessionLifecycleV2InDoubtError(
        `created worktree ${created.session} is not visible at its committed incarnation`,
      );
    }
    return { protocolVersion: 2, operation: "create-worktree", state: "succeeded", session };
  } catch (error) {
    return committedCreateObservationFailure("create-worktree", created.session, error);
  }
}

export function executeRpcV2CreateTerminal(
  request: RpcV2CreateTerminalRequest,
  deps: RpcV2CreateExecutionDeps = {},
): RpcV2CreateResponse {
  let created: ReturnType<typeof createManagedTerminalSession>;
  try {
    const cwd = expandHomePath(request.arguments.cwd);
    const label = request.arguments.label ?? (basename(cwd) || "Terminal");
    created = (deps.createTerminal ?? createManagedTerminalSession)({
      cwd,
      profile: "dashboard",
      quiet: true,
      lifecycleV2: {
        reservationCorrelation: request.reservationCorrelation,
        displayLabel: label,
      },
    }, deps.terminalSessionDeps);
  } catch (error) {
    return createFailure("create-terminal", error);
  }

  try {
    const session = (deps.currentList ?? currentRpcV2List)().sessions.find((item) => (
      item.name === created.session
      && item.incarnation === created.lifecycleV2?.incarnation
    ));
    if (!session) {
      throw new ManagedSessionLifecycleV2InDoubtError(
        `created terminal ${created.session} is not visible at its committed incarnation`,
      );
    }
    return { protocolVersion: 2, operation: "create-terminal", state: "succeeded", session };
  } catch (error) {
    return committedCreateObservationFailure("create-terminal", created.session, error);
  }
}

export function executeRpcV2KillSession(
  request: RpcV2KillSessionRequest,
  deps: Parameters<typeof killManagedSessionV2>[1] = {},
): RpcV2KillSessionResponse {
  return {
    protocolVersion: 2,
    operation: "kill-session",
    ...killManagedSessionV2(request, deps),
  };
}

export async function rpcV2Cmd(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "capabilities":
      if (args.length !== 1) throw new Error("capabilities takes no RPC v2 options");
      console.log(JSON.stringify(buildRpcV2CapabilitiesResponse()));
      return;
    case "list":
      if (args.length !== 1) throw new Error("list takes no RPC v2 options");
      console.log(JSON.stringify(currentRpcV2List()));
      return;
    case "create-worktree":
      console.log(JSON.stringify(executeRpcV2CreateWorktree(
        parseRpcV2CreateWorktreeRequest(parseRequestJsonArg(args.slice(1))),
      )));
      return;
    case "create-terminal":
      console.log(JSON.stringify(executeRpcV2CreateTerminal(
        parseRpcV2CreateTerminalRequest(parseRequestJsonArg(args.slice(1))),
      )));
      return;
    case "kill-session":
      console.log(JSON.stringify(executeRpcV2KillSession(
        parseRpcV2KillSessionRequest(parseRequestJsonArg(args.slice(1))),
      )));
      return;
    default:
      throw new Error(`unknown rpc-v2 command: ${sub}`);
  }
}
