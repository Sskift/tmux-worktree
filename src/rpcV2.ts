import { basename, isAbsolute, join, normalize } from "node:path";
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
  "resolved-create-worktree.v1",
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

export interface RpcV2CreateResolvedWorktreeRequest {
  arguments: RpcV2CreateWorktreeRequest["arguments"];
  execution: {
    canonicalRepoPath: string;
    effectiveProject: string;
    effectiveBaseBranch: string;
    rawSessionName: string;
    publicDisplayName: string;
    worktreeBase: string;
    worktreePath: string;
    worktreeBranch: string;
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
      operation: "create-worktree" | "create-worktree-resolved" | "create-terminal";
      state: "succeeded";
      session: RpcV2Session;
    }
  | {
      protocolVersion: 2;
      operation: "create-worktree" | "create-worktree-resolved" | "create-terminal";
      state: "failed";
      sideEffect: "not_applied";
      error: { code: "CREATE_FAILED"; message: string };
    }
  | {
      protocolVersion: 2;
      operation: "create-worktree" | "create-worktree-resolved" | "create-terminal";
      state: "in_doubt";
      error: { code: "IN_DOUBT"; message: string };
    };

export type RpcV2KillSessionResponse = {
  protocolVersion: 2;
  operation: "kill-session";
} & ReturnType<typeof killManagedSessionV2>;

export type RpcV2CreateOperation = "create-worktree" | "create-worktree-resolved" | "create-terminal";

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

function normalizedAbsolutePath(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 4_096);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed) {
    throw new Error(`invalid ${label}`);
  }
  return parsed;
}

function publicDisplayMatches(base: string, actual: string): boolean {
  if (actual === base) return true;
  if (!actual.startsWith(`${base}-`)) return false;
  return /^[1-9][0-9]*$/.test(actual.slice(base.length + 1));
}

export function parseRpcV2CreateResolvedWorktreeRequest(
  value: unknown,
): RpcV2CreateResolvedWorktreeRequest {
  if (!isRecord(value)
    || !exactKeys(value, ["arguments", "execution", "reservationCorrelation"])
    || !isRecord(value.execution)
    || !exactKeys(value.execution, [
      "canonicalRepoPath", "effectiveProject", "effectiveBaseBranch", "rawSessionName",
      "publicDisplayName", "worktreeBase", "worktreePath", "worktreeBranch",
    ])) {
    throw new Error("invalid RPC v2 resolved create-worktree request");
  }
  const reservationCorrelation = parseCorrelation(value.reservationCorrelation);
  const args = parseRpcV2CreateWorktreeRequest({
    arguments: value.arguments,
    reservationCorrelation,
  }).arguments;
  const canonicalRepoPath = normalizedAbsolutePath(
    value.execution.canonicalRepoPath,
    "canonicalRepoPath",
  );
  const effectiveProject = boundedString(value.execution.effectiveProject, "effectiveProject", 128);
  const derivedProject = basename(canonicalRepoPath);
  const effectiveBaseBranch = boundedString(
    value.execution.effectiveBaseBranch,
    "effectiveBaseBranch",
    255,
  );
  const rawSessionName = boundedString(value.execution.rawSessionName, "rawSessionName", 128);
  if (Array.from(rawSessionName).length > SESSION_NAME_MAX_LEN) {
    throw new Error(`rawSessionName exceeds ${SESSION_NAME_MAX_LEN} characters`);
  }
  const publicDisplayName = boundedString(
    value.execution.publicDisplayName,
    "publicDisplayName",
    128,
  );
  const worktreeBase = normalizedAbsolutePath(value.execution.worktreeBase, "worktreeBase");
  const worktreePath = normalizedAbsolutePath(value.execution.worktreePath, "worktreePath");
  const worktreeBranch = boundedString(value.execution.worktreeBranch, "worktreeBranch", 255);
  if (basename(effectiveProject) !== effectiveProject
    || effectiveProject === "."
    || effectiveProject === ".."
    || (args.project !== undefined
      ? args.project !== effectiveProject
      : effectiveProject !== derivedProject)
    || (args.branch !== undefined && args.branch !== effectiveBaseBranch)
    || !publicDisplayMatches(args.name ?? effectiveProject, publicDisplayName)
    || worktreePath !== join(worktreeBase, effectiveProject, worktreeBranch)) {
    throw new Error("resolved create-worktree execution is not bound to accepted arguments");
  }
  return {
    arguments: args,
    execution: {
      canonicalRepoPath,
      effectiveProject,
      effectiveBaseBranch,
      rawSessionName,
      publicDisplayName,
      worktreeBase,
      worktreePath,
      worktreeBranch,
    },
    reservationCorrelation,
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

function nullableBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | null {
  return value === null ? null : boundedString(value, label, maxBytes);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value as number;
}

function parseRpcV2Session(value: unknown): RpcV2Session {
  if (!isRecord(value) || !exactKeys(value, [
    "name",
    "kind",
    "profile",
    "project",
    "label",
    "repoPath",
    "worktreePath",
    "branch",
    "baseBranch",
    "cwd",
    "createdAt",
    "attached",
    "windows",
    "created",
    "activity",
    "incarnation",
    "lifecycleMarked",
    "reservationCorrelation",
  ])) {
    throw new Error("invalid RPC v2 Session response");
  }
  if ((value.kind !== "worktree" && value.kind !== "terminal")
    || (value.profile !== "cli" && value.profile !== "dashboard")
    || typeof value.attached !== "boolean"
    || typeof value.lifecycleMarked !== "boolean") {
    throw new Error("invalid RPC v2 Session response fields");
  }
  const createdAt = boundedString(value.createdAt, "createdAt", 64);
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
    throw new Error("invalid RPC v2 Session createdAt");
  }
  const incarnation = boundedString(value.incarnation, "incarnation", 128);
  if (!/^twinc2\.[A-Za-z0-9_-]{43}$/.test(incarnation)) {
    throw new Error("invalid RPC v2 Session incarnation");
  }
  const reservationCorrelation = value.reservationCorrelation === null
    ? null
    : parseCorrelation(value.reservationCorrelation);
  return {
    name: boundedString(value.name, "name", 128),
    kind: value.kind,
    profile: value.profile,
    project: nullableBoundedString(value.project, "project", 128),
    label: nullableBoundedString(value.label, "label", 128),
    repoPath: nullableBoundedString(value.repoPath, "repoPath", 4_096),
    worktreePath: nullableBoundedString(value.worktreePath, "worktreePath", 4_096),
    branch: nullableBoundedString(value.branch, "branch", 255),
    baseBranch: nullableBoundedString(value.baseBranch, "baseBranch", 255),
    cwd: boundedString(value.cwd, "cwd", 4_096),
    createdAt,
    attached: value.attached,
    windows: nonNegativeSafeInteger(value.windows, "windows"),
    created: nonNegativeSafeInteger(value.created, "created"),
    activity: nonNegativeSafeInteger(value.activity, "activity"),
    incarnation,
    lifecycleMarked: value.lifecycleMarked,
    reservationCorrelation,
  };
}

export function parseRpcV2CreateResponse(
  value: unknown,
  expectedOperation: RpcV2CreateOperation,
): RpcV2CreateResponse {
  if (!isRecord(value)
    || value.protocolVersion !== RPC_V2_PROTOCOL_VERSION
    || value.operation !== expectedOperation
    || (value.state !== "succeeded" && value.state !== "failed" && value.state !== "in_doubt")) {
    throw new Error("invalid RPC v2 create response");
  }
  if (value.state === "succeeded") {
    if (!exactKeys(value, ["protocolVersion", "operation", "state", "session"])) {
      throw new Error("invalid RPC v2 create success response");
    }
    const session = parseRpcV2Session(value.session);
    if (session.kind !== (expectedOperation === "create-terminal" ? "terminal" : "worktree")
      || session.lifecycleMarked !== true
      || session.reservationCorrelation === null) {
      throw new Error("RPC v2 create response lacks lifecycle authority");
    }
    return {
      protocolVersion: 2,
      operation: expectedOperation,
      state: "succeeded",
      session,
    };
  }
  if (!exactKeys(value, ["protocolVersion", "operation", "state", "error"],
    value.state === "failed" ? ["sideEffect"] : [])) {
    throw new Error("invalid RPC v2 create failure response");
  }
  if (!isRecord(value.error)
    || !exactKeys(value.error, ["code", "message"])
    || typeof value.error.message !== "string"
    || value.error.message.length === 0
    || value.error.message.includes("\0")
    || Buffer.byteLength(value.error.message, "utf8") > 4_096) {
    throw new Error("invalid RPC v2 create error");
  }
  if (value.state === "failed") {
    if (value.sideEffect !== "not_applied" || value.error.code !== "CREATE_FAILED") {
      throw new Error("RPC v2 create failure lacks no-side-effect proof");
    }
    return {
      protocolVersion: 2,
      operation: expectedOperation,
      state: "failed",
      sideEffect: "not_applied",
      error: { code: "CREATE_FAILED", message: value.error.message },
    };
  }
  if (value.error.code !== "IN_DOUBT") {
    throw new Error("invalid RPC v2 create in-doubt response");
  }
  return {
    protocolVersion: 2,
    operation: expectedOperation,
    state: "in_doubt",
    error: { code: "IN_DOUBT", message: value.error.message },
  };
}

export function parseRpcV2KillSessionResponse(value: unknown): RpcV2KillSessionResponse {
  if (!isRecord(value)
    || value.protocolVersion !== RPC_V2_PROTOCOL_VERSION
    || value.operation !== "kill-session"
    || (value.state !== "succeeded" && value.state !== "failed" && value.state !== "in_doubt")) {
    throw new Error("invalid RPC v2 kill-session response");
  }
  if (value.state === "succeeded") {
    if (!exactKeys(value, [
      "protocolVersion", "operation", "state", "name", "kind", "incarnation", "terminated", "sessionId",
    ])
      || (value.kind !== "worktree" && value.kind !== "terminal")
      || value.terminated !== true) {
      throw new Error("invalid RPC v2 kill-session success response");
    }
    const incarnation = boundedString(value.incarnation, "incarnation", 128);
    if (!/^twinc2\.[A-Za-z0-9_-]{43}$/.test(incarnation)) {
      throw new Error("invalid RPC v2 kill-session incarnation");
    }
    const sessionId = boundedString(value.sessionId, "sessionId", 128);
    if (!/^\$(?:0|[1-9][0-9]*)$/.test(sessionId)) {
      throw new Error("invalid RPC v2 kill-session backend sessionId");
    }
    return {
      protocolVersion: 2,
      operation: "kill-session",
      state: "succeeded",
      name: boundedString(value.name, "name", 128),
      kind: value.kind,
      incarnation,
      terminated: true,
      sessionId,
    };
  }
  if (!exactKeys(value, ["protocolVersion", "operation", "state", "code", "message"],
    value.state === "failed" ? ["sideEffect"] : [])
    || typeof value.message !== "string"
    || value.message.length === 0
    || value.message.includes("\0")
    || Buffer.byteLength(value.message, "utf8") > 4_096) {
    throw new Error("invalid RPC v2 kill-session failure response");
  }
  if (value.state === "failed") {
    if (value.sideEffect !== "not_applied"
      || (value.code !== "SESSION_NOT_FOUND" && value.code !== "INCARNATION_MISMATCH")) {
      throw new Error("RPC v2 kill-session failure lacks no-side-effect proof");
    }
    return {
      protocolVersion: 2,
      operation: "kill-session",
      state: "failed",
      sideEffect: "not_applied",
      code: value.code,
      message: value.message,
    };
  }
  if (value.code !== "IN_DOUBT") {
    throw new Error("invalid RPC v2 kill-session in-doubt response");
  }
  return {
    protocolVersion: 2,
    operation: "kill-session",
    state: "in_doubt",
    code: "IN_DOUBT",
    message: value.message,
  };
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
  operation: RpcV2CreateOperation,
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
  operation: RpcV2CreateOperation,
  session: string,
  error: unknown,
): RpcV2CreateResponse {
  const detail = error instanceof Error ? error.message : String(error);
  return createFailure(operation, new ManagedSessionLifecycleV2InDoubtError(
    `created ${operation === "create-terminal" ? "terminal" : "worktree"} ${session} committed but post-commit observation is uncertain: ${detail}`,
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

export function executeRpcV2CreateResolvedWorktree(
  request: RpcV2CreateResolvedWorktreeRequest,
  deps: RpcV2CreateExecutionDeps = {},
): RpcV2CreateResponse {
  let created: ReturnType<typeof createManagedWorktreeSession>;
  const execution = request.execution;
  try {
    created = (deps.createWorktree ?? createManagedWorktreeSession)({
      aiCmd: request.arguments.aiCommand,
      projectDir: execution.canonicalRepoPath,
      sessionName: execution.rawSessionName,
      useWorktree: true,
      worktreeBase: execution.worktreeBase,
      projectKey: execution.effectiveProject,
      branch: execution.effectiveBaseBranch,
      profile: "dashboard",
      quiet: true,
      lifecycleV2: {
        reservationCorrelation: request.reservationCorrelation,
        displayLabel: execution.publicDisplayName,
      },
      resolvedV2: {
        baseBranch: execution.effectiveBaseBranch,
        worktreeBranch: execution.worktreeBranch,
        worktreePath: execution.worktreePath,
      },
    }, deps.worktreeSessionDeps);
  } catch (error) {
    return createFailure("create-worktree-resolved", error);
  }

  try {
    const session = (deps.currentList ?? currentRpcV2List)().sessions.find((item) => (
      item.name === created.session
      && item.incarnation === created.lifecycleV2?.incarnation
    ));
    if (!session
      || session.name !== execution.rawSessionName
      || session.project !== execution.effectiveProject
      || session.label !== execution.publicDisplayName
      || session.repoPath !== execution.canonicalRepoPath
      || session.worktreePath !== execution.worktreePath
      || session.branch !== execution.worktreeBranch
      || session.baseBranch !== execution.effectiveBaseBranch
      || session.cwd !== execution.worktreePath) {
      throw new ManagedSessionLifecycleV2InDoubtError(
        `created resolved worktree ${created.session} does not match its frozen execution target`,
      );
    }
    return {
      protocolVersion: 2,
      operation: "create-worktree-resolved",
      state: "succeeded",
      session,
    };
  } catch (error) {
    return committedCreateObservationFailure("create-worktree-resolved", created.session, error);
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
    case "create-worktree-resolved":
      console.log(JSON.stringify(executeRpcV2CreateResolvedWorktree(
        parseRpcV2CreateResolvedWorktreeRequest(parseRequestJsonArg(args.slice(1))),
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
