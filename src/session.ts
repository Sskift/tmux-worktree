import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  realpathSync as fsRealpathSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  assertCanonicalWorktreePlacementFilesystem,
  parseCanonicalWorktreePlacement,
} from "./canonicalWorktreePlacement";
import {
  CliError,
  deleteBranch,
  exec as defaultExec,
  gitQuery as defaultGitQuery,
  isGitRepo as defaultIsGitRepo,
  killTmuxSessionByLifecycleIdentity as defaultKillTmuxSessionByLifecycleIdentity,
  listTmuxSessionLifecycleEntries as defaultListTmuxSessionLifecycleEntries,
  query as defaultQuery,
  removeWorktree,
  sessionExists as defaultSessionExists,
  tmuxBin as defaultTmuxBin,
  TMUX_RPC_V2_BIRTH_MARKER_OPTION,
  TMUX_RPC_V2_RESERVATION_CORRELATION_OPTION,
  type TmuxExactKillResult,
  type TmuxSessionLifecycleEntry,
} from "./tmux";
import {
  acquireManagedStateLock,
  assertManagedStateLifecycleV2Authority,
  buildManagedSessionLifecycleExtension,
  issueManagedSessionIncarnation,
  loadManagedState as defaultLoadManagedState,
  loadManagedStateForMutation as defaultLoadManagedStateForMutation,
  managedSessionLifecycleExtension,
  normalizeManagedSessionReservationCorrelation,
  recordManagedSession as defaultRecordManagedSession,
  releaseManagedStateLock,
  saveManagedState,
  saveManagedState as defaultSaveManagedState,
  upsertManagedSession,
  type ManagedSession,
  type ManagedSessionLifecycleExtensionV1,
  type ManagedSessionProfile,
  type ManagedSessionReservationCorrelationV1,
  type ManagedState,
  withManagedSessionLifecycleExtension,
  managedStatePath,
} from "./state";

export const SESSION_NAME_MAX_LEN = 20;

export interface CreateManagedWorktreeSessionParams {
  aiCmd: string;
  projectDir: string;
  sessionName: string;
  useWorktree: boolean;
  worktreeBase: string;
  projectKey?: string;
  branch?: string;
  /** Records which surface requested the session; it does not affect tmux layout. */
  profile: ManagedSessionProfile;
  quiet?: boolean;
  lifecycleV2?: ManagedSessionLifecycleV2Create;
  /** Fully materialized RPC v2 placement; bypasses all branch/name/path defaults. */
  resolvedV2?: {
    baseBranch: string;
    worktreeBranch: string;
    worktreePath: string;
  };
}

export interface CreatedManagedWorktree {
  repoDir: string;
  path: string;
  branch: string;
  project?: string;
  baseBranch?: string;
}

export interface CreatedManagedWorktreeSession {
  session: string;
  workDir: string;
  worktree: CreatedManagedWorktree | null;
  lifecycleV2?: ManagedSessionLifecycleExtensionV1;
}

export interface CreateManagedTerminalSessionParams {
  aiCmd?: string;
  cwd: string;
  /** Records which surface requested the session; it does not affect tmux layout. */
  profile: ManagedSessionProfile;
  quiet?: boolean;
  lifecycleV2?: ManagedSessionLifecycleV2Create;
}

export interface CreatedManagedTerminalSession {
  session: string;
  cwd: string;
  lifecycleV2?: ManagedSessionLifecycleExtensionV1;
}

export interface ManagedSessionLifecycleV2Create {
  reservationCorrelation: ManagedSessionReservationCorrelationV1;
  displayLabel: string | null;
}

export class ManagedSessionLifecycleV2InDoubtError extends CliError {}

export interface ManagedSessionIncarnationObservation {
  incarnation: string;
  lifecycleMarked: boolean;
  reservationCorrelation: ManagedSessionReservationCorrelationV1 | null;
  displayLabel: string | null;
}

export type KillManagedSessionV2Result =
  | {
      state: "succeeded";
      name: string;
      kind: "worktree" | "terminal";
      incarnation: string;
      terminated: true;
      sessionId: string;
    }
  | {
      state: "failed";
      sideEffect: "not_applied";
      code: "SESSION_NOT_FOUND" | "INCARNATION_MISMATCH";
      message: string;
    }
  | {
      state: "in_doubt";
      code: "IN_DOUBT";
      message: string;
    };

export interface RestoreManagedWorktreeSessionParams {
  aiCmd?: string;
  worktreePath: string;
  sessionName: string;
  projectKey?: string;
  /** Records which surface requested the session; it does not affect tmux layout. */
  profile: ManagedSessionProfile;
  quiet?: boolean;
}

export interface CreateManagedWorktreeSessionDeps {
  existsSync?: (path: string) => boolean;
  mkdirSync?: (path: string, options: { recursive: true }) => unknown;
  realpathSync?: (path: string) => string;
  isGitRepo?: (path: string) => boolean;
  gitQuery?: (repoDir: string, args: string[], timeout?: number) => string;
  exec?: (bin: string, args: string[], timeout?: number) => void;
  tmuxBin?: () => string;
  sessionExists?: (name: string) => boolean;
  randomId?: () => string;
  now?: () => Date;
  loadManagedState?: () => ManagedState;
  loadManagedStateForMutation?: () => ManagedState;
  saveManagedState?: (state: ManagedState) => void;
  recordManagedSession?: (session: ManagedSession) => void;
  setupClipboardBindings?: () => void;
  removeWorktree?: (repoDir: string, worktreePath: string, force?: boolean) => void;
  deleteBranch?: (repoDir: string, branch: string, force?: boolean) => boolean | void;
  killSession?: (name: string) => void;
  randomBirthMarker?: () => string;
  listTmuxSessionLifecycleEntries?: () => TmuxSessionLifecycleEntry[];
  killTmuxSessionByLifecycleIdentity?: (
    identity: TmuxSessionLifecycleEntry,
  ) => TmuxExactKillResult;
}

export function setupClipboardBindings(): void {
  if (process.platform !== "darwin") return;
  const tmux = defaultTmuxBin();
  for (const table of ["copy-mode-vi", "copy-mode"]) {
    defaultQuery(tmux, ["bind-key", "-T", table, "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-no-clear", "pbcopy"]);
    defaultQuery(tmux, ["bind-key", "-T", table, "MouseDown1Pane", "select-pane", "\\;", "send-keys", "-X", "cancel"]);
  }
}

export function aiCommandPathPrefix(): string {
  return 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
}

export function commandThenLoginShell(command: string): string {
  const path = aiCommandPathPrefix();
  const shell = "exec \"${SHELL:-/bin/zsh}\" -l";
  if (!command.trim()) return `${path}; ${shell}`;
  return `${path}; ${command}; ${shell}`;
}

function randomHexId(): string {
  return Math.floor(Math.random() * 0x100000)
    .toString(16)
    .padStart(5, "0");
}

function resolveSessionName(base: string, exists: (name: string) => boolean): string {
  let name = base;
  let i = 1;
  while (exists(name)) {
    name = `${base}-${i}`;
    i++;
  }
  return name;
}

function detectTargetBranch(
  repoDir: string,
  branch: string | undefined,
  gitQuery: (repoDir: string, args: string[], timeout?: number) => string,
): string {
  const explicitBranch = branch?.trim();
  if (explicitBranch) return explicitBranch;
  const originHead = gitQuery(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    .replace("refs/remotes/origin/", "")
    .trim();
  if (originHead) return originHead;
  const hasMaster = gitQuery(repoDir, ["ls-remote", "--heads", "origin", "master"]);
  return hasMaster ? "master" : "main";
}

function persistManagedSession(
  session: ManagedSession,
  deps: CreateManagedWorktreeSessionDeps,
): void {
  if (deps.recordManagedSession) {
    deps.recordManagedSession(session);
    return;
  }
  // Existing dependency injection tests provide load/save separately. Keep
  // that seam while production uses the locked atomic state mutation.
  if (deps.loadManagedState || deps.saveManagedState) {
    const load = deps.loadManagedState ?? defaultLoadManagedState;
    const save = deps.saveManagedState ?? defaultSaveManagedState;
    save(upsertManagedSession(load(), session));
    return;
  }
  defaultRecordManagedSession(session);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function managedSessionCreatedAt(now: () => Date): string {
  const createdAt = now().toISOString();
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createdAt) {
    throw new CliError("invalid managed session creation timestamp");
  }
  return createdAt;
}

function appendRollbackFailures(error: unknown, failures: string[]): CliError {
  const detail = errorDetail(error);
  if (failures.length === 0) {
    return error instanceof CliError ? error : new CliError(detail);
  }
  return new CliError(`${detail}\n回滚不完整:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
}

function rollbackManagedSession(
  session: string,
  tmux: string,
  exec: (bin: string, args: string[], timeout?: number) => void,
  injectedKill?: (name: string) => void,
): void {
  if (injectedKill) {
    injectedKill(session);
    return;
  }
  // Runtime mutation rollback must surface failure. `tmux.killSession()` is a
  // best-effort query helper and intentionally swallows errors, so it is not
  // suitable for transactional create/restore paths.
  exec(tmux, ["kill-session", "-t", `=${session}`]);
}

function rollbackCreatedWorktree(
  created: CreatedManagedWorktree,
  cleanupWorktree: (repoDir: string, worktreePath: string, force?: boolean) => void,
  cleanupBranch: (repoDir: string, branch: string, force?: boolean) => boolean | void,
): string[] {
  const failures: string[] = [];
  try {
    cleanupWorktree(created.repoDir, created.path, true);
  } catch (error) {
    failures.push(`删除 worktree ${created.path} 失败: ${errorDetail(error)}`);
  }
  try {
    const deleted = cleanupBranch(created.repoDir, created.branch, true);
    if (deleted === false) {
      failures.push(`删除分支 ${created.branch} 失败`);
    }
  } catch (error) {
    failures.push(`删除分支 ${created.branch} 失败: ${errorDetail(error)}`);
  }
  return failures;
}

interface PreparedLifecycleV2Create {
  birthMarker: string;
  reservationCorrelationEncoded: string;
  metadata: ManagedSessionLifecycleV2Create;
}

function prepareLifecycleV2Create(
  lifecycle: ManagedSessionLifecycleV2Create | undefined,
  randomBirthMarker: () => string,
): PreparedLifecycleV2Create | undefined {
  if (!lifecycle) return undefined;
  const reservationCorrelation = normalizeManagedSessionReservationCorrelation(
    lifecycle.reservationCorrelation,
  );
  if (lifecycle.displayLabel !== null && (
    lifecycle.displayLabel.length === 0
    || lifecycle.displayLabel.trim() !== lifecycle.displayLabel
    || lifecycle.displayLabel.includes("\0")
    || Buffer.byteLength(lifecycle.displayLabel, "utf8") > 128
  )) {
    throw new CliError("invalid RPC v2 session display label");
  }
  const birthMarker = randomBirthMarker();
  if (!/^twbirth2\.[A-Za-z0-9_-]{22}$/.test(birthMarker)) {
    throw new CliError("invalid RPC v2 session birth marker");
  }
  const reservationCorrelationEncoded = Buffer.from(
    JSON.stringify(reservationCorrelation),
    "utf8",
  ).toString("base64url");
  if (reservationCorrelationEncoded.length === 0 || reservationCorrelationEncoded.length > 4_096) {
    throw new CliError("RPC v2 reservation correlation exceeds the tmux marker limit");
  }
  return {
    birthMarker,
    reservationCorrelationEncoded,
    metadata: { ...lifecycle, reservationCorrelation },
  };
}

function captureLifecycleV2(
  session: string,
  prepared: PreparedLifecycleV2Create,
  list: () => TmuxSessionLifecycleEntry[],
): { identity: TmuxSessionLifecycleEntry; extension: ManagedSessionLifecycleExtensionV1 } {
  const identity = list().find((entry) => entry.rawName === session);
  if (!identity
    || !identity.lifecycleMarkersValid
    || identity.birthMarker !== prepared.birthMarker
    || identity.reservationCorrelation !== prepared.reservationCorrelationEncoded) {
    throw new ManagedSessionLifecycleV2InDoubtError(
      `cannot confirm RPC v2 tmux birth marker for ${session}`,
    );
  }
  const extension = buildManagedSessionLifecycleExtension(
    {
      serverSocketPath: identity.serverSocketPath,
      serverPid: identity.serverPid,
      serverStarted: identity.serverStarted,
      sessionId: identity.sessionId,
      rawName: identity.rawName,
      sessionCreated: identity.sessionCreated,
      birthMarker: identity.birthMarker,
    },
    prepared.metadata.reservationCorrelation,
    prepared.metadata.displayLabel,
  );
  return { identity, extension };
}

function lifecycleRecordWasCommitted(
  session: string,
  expected: ManagedSessionLifecycleExtensionV1,
  load: () => ManagedState,
): boolean {
  const state = load();
  assertManagedStateLifecycleV2Authority(state);
  const record = state.sessions.find((candidate) => candidate.name === session);
  const extension = record ? managedSessionLifecycleExtension(record) : undefined;
  return extension?.incarnation === expected.incarnation;
}

function lifecycleV2InDoubtAfterTmuxMutation(
  operation: "create-worktree" | "create-terminal",
  session: string,
  phase: string,
  error: unknown,
): ManagedSessionLifecycleV2InDoubtError {
  if (error instanceof ManagedSessionLifecycleV2InDoubtError) return error;
  return new ManagedSessionLifecycleV2InDoubtError(
    `RPC v2 ${operation} ${phase} is uncertain for ${session}: ${errorDetail(error)}`,
  );
}

function captureLifecycleV2AfterTmuxMutation(
  operation: "create-worktree" | "create-terminal",
  phase: string,
  session: string,
  prepared: PreparedLifecycleV2Create,
  list: () => TmuxSessionLifecycleEntry[],
): ReturnType<typeof captureLifecycleV2> {
  try {
    return captureLifecycleV2(session, prepared, list);
  } catch (error) {
    throw lifecycleV2InDoubtAfterTmuxMutation(operation, session, phase, error);
  }
}

function lifecycleRecordWasCommittedAfterTmuxMutation(
  operation: "create-worktree" | "create-terminal",
  phase: string,
  session: string,
  expected: ManagedSessionLifecycleExtensionV1,
  load: () => ManagedState,
): boolean {
  try {
    return lifecycleRecordWasCommitted(session, expected, load);
  } catch (error) {
    throw lifecycleV2InDoubtAfterTmuxMutation(operation, session, phase, error);
  }
}

/**
 * Every new TW-managed worktree uses the same single-pane tmux contract.
 * `profile` remains managed-state provenance for compatibility with existing
 * CLI and Dashboard records; it must never select a different pane layout.
 */
function startManagedSession(
  tmux: string,
  session: string,
  workDir: string,
  aiCmd: string,
  exec: (bin: string, args: string[], timeout?: number) => void,
  setupBindings: () => void,
  lifecycleV2?: PreparedLifecycleV2Create,
): void {
  const args = [
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    workDir,
    commandThenLoginShell(aiCmd),
  ];
  if (lifecycleV2) {
    args.push(
      ";",
      "set-option",
      "-t",
      `=${session}:`,
      TMUX_RPC_V2_BIRTH_MARKER_OPTION,
      lifecycleV2.birthMarker,
      ";",
      "set-option",
      "-t",
      `=${session}:`,
      TMUX_RPC_V2_RESERVATION_CORRELATION_OPTION,
      lifecycleV2.reservationCorrelationEncoded,
    );
  }
  exec(tmux, args);
  setupBindings();
}

export function createManagedWorktreeSession(
  params: CreateManagedWorktreeSessionParams,
  deps: CreateManagedWorktreeSessionDeps = {},
): CreatedManagedWorktreeSession {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const mkdirSync = deps.mkdirSync ?? fsMkdirSync;
  const realpathSync = deps.realpathSync ?? fsRealpathSync;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const gitQuery = deps.gitQuery ?? defaultGitQuery;
  const exec = deps.exec ?? defaultExec;
  const tmuxBin = deps.tmuxBin ?? defaultTmuxBin;
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const randomId = deps.randomId ?? randomHexId;
  const now = deps.now ?? (() => new Date());
  const profile = params.profile;
  const setupBindings = deps.setupClipboardBindings ?? setupClipboardBindings;
  const cleanupWorktree = deps.removeWorktree ?? removeWorktree;
  const cleanupBranch = deps.deleteBranch ?? deleteBranch;
  const log = params.quiet ? () => undefined : console.log;
  const loadMutationState = deps.loadManagedStateForMutation ?? defaultLoadManagedStateForMutation;
  const listLifecycle = deps.listTmuxSessionLifecycleEntries
    ?? defaultListTmuxSessionLifecycleEntries;
  const preparedLifecycle = prepareLifecycleV2Create(
    params.lifecycleV2,
    deps.randomBirthMarker
      ?? (() => `twbirth2.${randomBytes(16).toString("base64url")}`),
  );

  // V2 must fail closed before git or tmux can mutate anything. The later
  // locked record write repeats this strict read through recordManagedSession.
  if (preparedLifecycle) {
    assertManagedStateLifecycleV2Authority(loadMutationState());
  }

  if (!existsSync(params.projectDir)) {
    throw new CliError(`目录不存在: ${params.projectDir}`);
  }

  const resolvedPlacement = params.resolvedV2
    ? parseCanonicalWorktreePlacement({
        worktreeBase: params.worktreeBase,
        worktreePath: params.resolvedV2.worktreePath,
        worktreeBranch: params.resolvedV2.worktreeBranch,
      })
    : null;
  if (resolvedPlacement) {
    assertCanonicalWorktreePlacementFilesystem(resolvedPlacement, { existsSync, realpathSync });
    if (existsSync(resolvedPlacement.worktreePath)) {
      throw new CliError(
        `resolved RPC v2 worktree target already exists: ${resolvedPlacement.worktreePath}`,
      );
    }
  }

  const session = params.resolvedV2
    ? params.sessionName
    : resolveSessionName(params.sessionName, sessionExists);
  if (params.resolvedV2 && sessionExists(session)) {
    throw new CliError(`resolved RPC v2 tmux session target already exists: ${session}`);
  }
  const tmux = tmuxBin();
  let workDir = params.projectDir;
  let createdWorktree: CreatedManagedWorktree | null = null;
  let createdAt: string;

  if (params.useWorktree) {
    if (!isGitRepo(params.projectDir)) {
      throw new CliError(`${params.projectDir} 不是 git 仓库`);
    }

    const label = params.projectKey ?? session;
    log(`📦 项目: ${label} (${params.projectDir})`);
    const targetBranch = params.resolvedV2?.baseBranch
      ?? detectTargetBranch(params.projectDir, params.branch, gitQuery);
    createdAt = managedSessionCreatedAt(now);

    log(`🔄 正在从远程拉取最新代码 (${targetBranch})...`);
    exec("git", ["-C", params.projectDir, "fetch", "origin", targetBranch, "--quiet"]);

    const branchName = resolvedPlacement?.worktreeBranch ?? `${session}-${randomId()}`;
    const worktreeDir = resolvedPlacement?.worktreePath
      ?? join(params.worktreeBase, label, branchName);
    const worktreeParent = resolvedPlacement ? dirname(worktreeDir) : join(params.worktreeBase, label);
    if (resolvedPlacement) {
      try {
        mkdirSync(worktreeParent, { recursive: true });
        assertCanonicalWorktreePlacementFilesystem(
          resolvedPlacement,
          { existsSync, realpathSync },
        );
        if (existsSync(worktreeDir)) {
          throw new CliError(`resolved RPC v2 worktree target already exists: ${worktreeDir}`);
        }
      } catch (error) {
        if (preparedLifecycle) {
          throw new ManagedSessionLifecycleV2InDoubtError(
            `RPC v2 worktree placement preparation is uncertain for ${worktreeDir}: ${errorDetail(error)}`,
          );
        }
        throw error;
      }
    } else {
      mkdirSync(worktreeParent, { recursive: true });
    }

    log(`🌿 创建 worktree 分支: ${branchName}`);
    log(`   路径: ${worktreeDir}`);
    try {
      if (resolvedPlacement && existsSync(worktreeDir)) {
        throw new CliError(`resolved RPC v2 worktree target already exists: ${worktreeDir}`);
      }
      exec("git", [
        "-C",
        params.projectDir,
        "worktree",
        "add",
        "-b",
        branchName,
        worktreeDir,
        `origin/${targetBranch}`,
        "--quiet",
      ]);
    } catch (error) {
      if (preparedLifecycle) {
        throw new ManagedSessionLifecycleV2InDoubtError(
          `RPC v2 worktree creation result is uncertain for ${worktreeDir}: ${errorDetail(error)}`,
        );
      }
      throw error;
    }

    createdWorktree = {
      repoDir: params.projectDir,
      path: worktreeDir,
      branch: branchName,
      project: label,
      baseBranch: targetBranch,
    };
    workDir = worktreeDir;
  } else {
    createdAt = managedSessionCreatedAt(now);
    log(`📂 使用自定义目录 (跳过 git worktree):`);
    log(`   路径: ${params.projectDir}`);
  }

  log(`\n🖥️  正在创建 tmux session...`);
  log(`   Session:  ${session}`);
  log(`   AI 命令:  ${params.aiCmd}`);
  log();

  let capturedLifecycle: ReturnType<typeof captureLifecycleV2> | undefined;
  try {
    startManagedSession(
      tmux,
      session,
      workDir,
      params.aiCmd,
      exec,
      setupBindings,
      preparedLifecycle,
    );
  } catch (err) {
    if (preparedLifecycle) {
      try {
        capturedLifecycle = captureLifecycleV2AfterTmuxMutation(
          "create-worktree",
          "tmux start confirmation",
          session,
          preparedLifecycle,
          listLifecycle,
        );
      } catch {
        throw new ManagedSessionLifecycleV2InDoubtError(
          `RPC v2 create-worktree could not confirm whether tmux session ${session} was created: ${errorDetail(err)}`,
        );
      }
    } else {
      const rollbackFailures: string[] = [];
      if (createdWorktree) {
        // A failed `new-session` does not prove ownership of any same-named live
        // session: another creator may have won the race. Never kill by name on
        // this path. Only the worktree/branch created by this invocation is ours.
        rollbackFailures.push(...rollbackCreatedWorktree(
          createdWorktree,
          cleanupWorktree,
          cleanupBranch,
        ));
      }
      throw appendRollbackFailures(err, rollbackFailures);
    }
  }

  if (preparedLifecycle && !capturedLifecycle) {
    capturedLifecycle = captureLifecycleV2AfterTmuxMutation(
      "create-worktree",
      "initial tmux identity capture",
      session,
      preparedLifecycle,
      listLifecycle,
    );
  }

  if (createdWorktree) {
    const baseRecord: ManagedSession = {
      name: session,
      kind: "worktree",
      profile,
      project: createdWorktree.project,
      repoPath: createdWorktree.repoDir,
      worktreePath: createdWorktree.path,
      branch: createdWorktree.branch,
      baseBranch: createdWorktree.baseBranch,
      createdAt,
    };
    const record = capturedLifecycle
      ? withManagedSessionLifecycleExtension(baseRecord, capturedLifecycle.extension)
      : baseRecord;
    try {
      persistManagedSession(record, deps);
    } catch (err) {
      if (capturedLifecycle) {
        if (!lifecycleRecordWasCommittedAfterTmuxMutation(
          "create-worktree",
          "state commit re-read",
          session,
          capturedLifecycle.extension,
          loadMutationState,
        )) {
          throw new ManagedSessionLifecycleV2InDoubtError(
            `RPC v2 create-worktree state commit is uncertain for ${session}: ${errorDetail(err)}`,
          );
        }
      } else {
        const rollbackFailures: string[] = [];
        let sessionStopped = false;
        try {
          rollbackManagedSession(session, tmux, exec, deps.killSession);
          sessionStopped = true;
        } catch (rollbackError) {
          rollbackFailures.push(`停止 tmux session ${session} 失败: ${errorDetail(rollbackError)}`);
        }
        if (sessionStopped) {
          rollbackFailures.push(...rollbackCreatedWorktree(
            createdWorktree,
            cleanupWorktree,
            cleanupBranch,
          ));
        } else {
          rollbackFailures.push(
            `保留 worktree ${createdWorktree.path} 和分支 ${createdWorktree.branch}，避免删除仍可能被 tmux 使用的目录`,
          );
        }
        const detail = errorDetail(err);
        if (rollbackFailures.length === 0) {
          throw new CliError(`写入 TW state 失败，已回滚 tmux/worktree/branch: ${detail}`);
        }
        throw appendRollbackFailures(new CliError(`写入 TW state 失败: ${detail}`), rollbackFailures);
      }
    }
  }

  if (capturedLifecycle) {
    const confirmed = captureLifecycleV2AfterTmuxMutation(
      "create-worktree",
      "final tmux identity confirmation",
      session,
      preparedLifecycle!,
      listLifecycle,
    );
    if (confirmed.extension.incarnation !== capturedLifecycle.extension.incarnation
      || !lifecycleRecordWasCommittedAfterTmuxMutation(
        "create-worktree",
        "final state commit confirmation",
        session,
        capturedLifecycle.extension,
        loadMutationState,
      )) {
      throw new ManagedSessionLifecycleV2InDoubtError(
        `RPC v2 create-worktree commit could not be confirmed for ${session}`,
      );
    }
  }

  return {
    session,
    workDir,
    worktree: createdWorktree,
    ...(capturedLifecycle ? { lifecycleV2: capturedLifecycle.extension } : {}),
  };
}


/** Create a standalone TW-managed terminal without any Dashboard UI metadata. */
export function createManagedTerminalSession(
  params: CreateManagedTerminalSessionParams,
  deps: CreateManagedWorktreeSessionDeps = {},
): CreatedManagedTerminalSession {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const exec = deps.exec ?? defaultExec;
  const tmux = (deps.tmuxBin ?? defaultTmuxBin)();
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const randomId = deps.randomId ?? randomHexId;
  const now = deps.now ?? (() => new Date());
  const profile = params.profile;
  const setupBindings = deps.setupClipboardBindings ?? setupClipboardBindings;
  const loadMutationState = deps.loadManagedStateForMutation ?? defaultLoadManagedStateForMutation;
  const listLifecycle = deps.listTmuxSessionLifecycleEntries
    ?? defaultListTmuxSessionLifecycleEntries;
  const preparedLifecycle = prepareLifecycleV2Create(
    params.lifecycleV2,
    deps.randomBirthMarker
      ?? (() => `twbirth2.${randomBytes(16).toString("base64url")}`),
  );
  if (preparedLifecycle) {
    assertManagedStateLifecycleV2Authority(loadMutationState());
  }
  const cwd = params.cwd.trim();
  if (!cwd) throw new CliError("terminal cwd required");
  if (!existsSync(cwd)) throw new CliError(`目录不存在: ${cwd}`);

  let session = "";
  do {
    session = `tw-term-${randomId()}`;
  } while (sessionExists(session));
  const createdAt = managedSessionCreatedAt(now);

  let capturedLifecycle: ReturnType<typeof captureLifecycleV2> | undefined;
  try {
    startManagedSession(
      tmux,
      session,
      cwd,
      params.aiCmd ?? "",
      exec,
      setupBindings,
      preparedLifecycle,
    );
  } catch (error) {
    if (!preparedLifecycle) throw error;
    try {
      capturedLifecycle = captureLifecycleV2AfterTmuxMutation(
        "create-terminal",
        "tmux start confirmation",
        session,
        preparedLifecycle,
        listLifecycle,
      );
    } catch {
      throw new ManagedSessionLifecycleV2InDoubtError(
        `RPC v2 create-terminal could not confirm whether tmux session ${session} was created: ${errorDetail(error)}`,
      );
    }
  }
  if (preparedLifecycle && !capturedLifecycle) {
    capturedLifecycle = captureLifecycleV2AfterTmuxMutation(
      "create-terminal",
      "initial tmux identity capture",
      session,
      preparedLifecycle,
      listLifecycle,
    );
  }
  const baseRecord: ManagedSession = {
    name: session,
    kind: "terminal",
    profile,
    cwd,
    createdAt,
  };
  const record = capturedLifecycle
    ? withManagedSessionLifecycleExtension(baseRecord, capturedLifecycle.extension)
    : baseRecord;
  try {
    persistManagedSession(record, deps);
  } catch (error) {
    if (capturedLifecycle) {
      if (!lifecycleRecordWasCommittedAfterTmuxMutation(
        "create-terminal",
        "state commit re-read",
        session,
        capturedLifecycle.extension,
        loadMutationState,
      )) {
        throw new ManagedSessionLifecycleV2InDoubtError(
          `RPC v2 create-terminal state commit is uncertain for ${session}: ${errorDetail(error)}`,
        );
      }
    } else {
      try {
        rollbackManagedSession(session, tmux, exec, deps.killSession);
      } catch (rollbackError) {
        throw appendRollbackFailures(
          new CliError(`写入 TW state 失败: ${errorDetail(error)}`),
          [`停止 tmux session ${session} 失败: ${errorDetail(rollbackError)}`],
        );
      }
      throw new CliError(`写入 TW state 失败，已回滚 terminal session: ${errorDetail(error)}`);
    }
  }
  if (capturedLifecycle) {
    const confirmed = captureLifecycleV2AfterTmuxMutation(
      "create-terminal",
      "final tmux identity confirmation",
      session,
      preparedLifecycle!,
      listLifecycle,
    );
    if (confirmed.extension.incarnation !== capturedLifecycle.extension.incarnation
      || !lifecycleRecordWasCommittedAfterTmuxMutation(
        "create-terminal",
        "final state commit confirmation",
        session,
        capturedLifecycle.extension,
        loadMutationState,
      )) {
      throw new ManagedSessionLifecycleV2InDoubtError(
        `RPC v2 create-terminal commit could not be confirmed for ${session}`,
      );
    }
  }
  return {
    session,
    cwd,
    ...(capturedLifecycle ? { lifecycleV2: capturedLifecycle.extension } : {}),
  };
}

function incarnationIdentity(entry: TmuxSessionLifecycleEntry) {
  return {
    serverSocketPath: entry.serverSocketPath,
    serverPid: entry.serverPid,
    serverStarted: entry.serverStarted,
    sessionId: entry.sessionId,
    rawName: entry.rawName,
    sessionCreated: entry.sessionCreated,
    birthMarker: entry.birthMarker,
  };
}

function encodedReservationCorrelation(
  correlation: ManagedSessionReservationCorrelationV1,
): string {
  return Buffer.from(JSON.stringify(correlation), "utf8").toString("base64url");
}

/**
 * Bind one managed record to one live tmux incarnation. Legacy records remain
 * observable without inventing a birth marker; a present v2 extension must
 * match every persisted marker/identity field or the record is not authoritative.
 */
export function observeManagedSessionIncarnation(
  managed: ManagedSession,
  live: TmuxSessionLifecycleEntry,
): ManagedSessionIncarnationObservation | undefined {
  if (managed.name !== live.rawName || !live.lifecycleMarkersValid) return undefined;
  const extension = managedSessionLifecycleExtension(managed);
  if (!extension) {
    if (live.birthMarker !== null || live.reservationCorrelation !== null) return undefined;
    return {
      incarnation: issueManagedSessionIncarnation(incarnationIdentity(live)),
      lifecycleMarked: false,
      reservationCorrelation: null,
      displayLabel: null,
    };
  }
  const identity = incarnationIdentity(live);
  const stored = extension.tmux;
  if (stored.serverSocketPath !== identity.serverSocketPath
    || stored.serverPid !== identity.serverPid
    || stored.serverStarted !== identity.serverStarted
    || stored.sessionId !== identity.sessionId
    || stored.rawName !== identity.rawName
    || stored.sessionCreated !== identity.sessionCreated
    || stored.birthMarker !== identity.birthMarker
    || extension.incarnation !== issueManagedSessionIncarnation(identity)
    || live.reservationCorrelation !== encodedReservationCorrelation(
      extension.reservationCorrelation,
    )) {
    return undefined;
  }
  return {
    incarnation: extension.incarnation,
    lifecycleMarked: true,
    reservationCorrelation: extension.reservationCorrelation,
    displayLabel: extension.displayLabel,
  };
}

export function killManagedSessionV2(
  request: { name: string; expectedIncarnation: string },
  deps: {
    statePath?: string;
    listTmuxSessionLifecycleEntries?: () => TmuxSessionLifecycleEntry[];
    killTmuxSessionByLifecycleIdentity?: (
      identity: TmuxSessionLifecycleEntry,
    ) => TmuxExactKillResult;
    saveManagedState?: (state: ManagedState, path: string) => void;
  } = {},
): KillManagedSessionV2Result {
  const path = deps.statePath ?? managedStatePath();
  const list = deps.listTmuxSessionLifecycleEntries
    ?? defaultListTmuxSessionLifecycleEntries;
  const killExact = deps.killTmuxSessionByLifecycleIdentity
    ?? defaultKillTmuxSessionByLifecycleIdentity;
  const lock = acquireManagedStateLock(`${path}.lock`);
  try {
    // Strict state is read while the canonical writer lock is held and before
    // any tmux query/mutation. Corruption therefore cannot authorize a kill.
    const state = defaultLoadManagedStateForMutation(path);
    assertManagedStateLifecycleV2Authority(state);
    const managed = state.sessions.find((candidate) => candidate.name === request.name);
    if (!managed) {
      return {
        state: "failed",
        sideEffect: "not_applied",
        code: "SESSION_NOT_FOUND",
        message: `session is not TW-managed: ${request.name}`,
      };
    }

    let live: TmuxSessionLifecycleEntry | undefined;
    try {
      live = list().find((candidate) => candidate.rawName === request.name);
    } catch (error) {
      return {
        state: "in_doubt",
        code: "IN_DOUBT",
        message: `could not read exact tmux identity for ${request.name}: ${errorDetail(error)}`,
      };
    }
    if (!live) {
      return {
        state: "failed",
        sideEffect: "not_applied",
        code: "SESSION_NOT_FOUND",
        message: `managed session is not live: ${request.name}`,
      };
    }
    const observed = observeManagedSessionIncarnation(managed, live);
    if (!observed || observed.incarnation !== request.expectedIncarnation) {
      return {
        state: "failed",
        sideEffect: "not_applied",
        code: "INCARNATION_MISMATCH",
        message: `managed session incarnation changed: ${request.name}`,
      };
    }

    let killed: TmuxExactKillResult;
    try {
      killed = killExact(live);
    } catch (error) {
      return {
        state: "in_doubt",
        code: "IN_DOUBT",
        message: `exact tmux kill result is uncertain for ${request.name}: ${errorDetail(error)}`,
      };
    }
    if (killed === "not_found") {
      return {
        state: "failed",
        sideEffect: "not_applied",
        code: "SESSION_NOT_FOUND",
        message: `managed session disappeared before kill: ${request.name}`,
      };
    }
    if (killed === "mismatch") {
      return {
        state: "failed",
        sideEffect: "not_applied",
        code: "INCARNATION_MISMATCH",
        message: `managed session incarnation changed before kill: ${request.name}`,
      };
    }
    if (killed === "in_doubt") {
      return {
        state: "in_doubt",
        code: "IN_DOUBT",
        message: `exact tmux kill result is uncertain: ${request.name}`,
      };
    }

    const next: ManagedState = {
      version: state.version,
      sessions: state.sessions.filter((candidate) => candidate !== managed),
    };
    try {
      (deps.saveManagedState ?? saveManagedState)(next, path);
    } catch (error) {
      return {
        state: "in_doubt",
        code: "IN_DOUBT",
        message: `tmux kill succeeded but managed state commit is uncertain for ${request.name}: ${errorDetail(error)}`,
      };
    }
    return {
      state: "succeeded",
      name: managed.name,
      kind: managed.kind,
      incarnation: observed.incarnation,
      terminated: true,
      sessionId: live.sessionId,
    };
  } finally {
    releaseManagedStateLock(lock);
  }
}

/** Re-attach a real, already-existing git worktree to the managed contract. */
export function restoreManagedWorktreeSession(
  params: RestoreManagedWorktreeSessionParams,
  deps: CreateManagedWorktreeSessionDeps = {},
): CreatedManagedWorktreeSession {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const gitQuery = deps.gitQuery ?? defaultGitQuery;
  const exec = deps.exec ?? defaultExec;
  const tmux = (deps.tmuxBin ?? defaultTmuxBin)();
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const now = deps.now ?? (() => new Date());
  const setupBindings = deps.setupClipboardBindings ?? setupClipboardBindings;
  const worktreePath = params.worktreePath.trim();
  if (!worktreePath) throw new CliError("worktree path required");
  if (!existsSync(worktreePath)) throw new CliError(`目录不存在: ${worktreePath}`);
  if (!existsSync(join(worktreePath, ".git")) || !isGitRepo(worktreePath)) {
    throw new CliError(`${worktreePath} 不是可恢复的 git worktree`);
  }

  const session = resolveSessionName(params.sessionName.trim(), sessionExists);
  if (!session) throw new CliError("session name required");
  startManagedSession(tmux, session, worktreePath, params.aiCmd ?? "", exec, setupBindings);

  const branch = gitQuery(worktreePath, ["branch", "--show-current"]).trim() || undefined;
  const commonDir = gitQuery(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  const repoPath = commonDir.endsWith("/.git") ? dirname(commonDir) : undefined;
  const project = params.projectKey?.trim() || basename(dirname(worktreePath)) || undefined;
  try {
    persistManagedSession({
      name: session,
      kind: "worktree",
      profile: params.profile,
      project,
      repoPath,
      worktreePath,
      branch,
      cwd: worktreePath,
      createdAt: now().toISOString(),
    }, deps);
  } catch (error) {
    try {
      rollbackManagedSession(session, tmux, exec, deps.killSession);
    } catch (rollbackError) {
      throw appendRollbackFailures(
        new CliError(`写入 TW state 失败: ${errorDetail(error)}`),
        [`停止 restored tmux session ${session} 失败: ${errorDetail(rollbackError)}`],
      );
    }
    throw new CliError(`写入 TW state 失败，已回滚 restored session: ${errorDetail(error)}`);
  }
  return { session, workDir: worktreePath, worktree: null };
}
