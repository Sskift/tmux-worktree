import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CliError,
  deleteBranch,
  exec as defaultExec,
  gitQuery as defaultGitQuery,
  isGitRepo as defaultIsGitRepo,
  query as defaultQuery,
  removeWorktree,
  sessionExists as defaultSessionExists,
  tmuxBin as defaultTmuxBin,
} from "./tmux";
import {
  loadManagedState as defaultLoadManagedState,
  recordManagedSession as defaultRecordManagedSession,
  saveManagedState as defaultSaveManagedState,
  upsertManagedSession,
  type ManagedSession,
  type ManagedSessionProfile,
  type ManagedState,
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
}

export interface CreateManagedTerminalSessionParams {
  aiCmd?: string;
  cwd: string;
  /** Records which surface requested the session; it does not affect tmux layout. */
  profile: ManagedSessionProfile;
  quiet?: boolean;
}

export interface CreatedManagedTerminalSession {
  session: string;
  cwd: string;
}

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
  isGitRepo?: (path: string) => boolean;
  gitQuery?: (repoDir: string, args: string[], timeout?: number) => string;
  exec?: (bin: string, args: string[], timeout?: number) => void;
  tmuxBin?: () => string;
  sessionExists?: (name: string) => boolean;
  randomId?: () => string;
  now?: () => Date;
  loadManagedState?: () => ManagedState;
  saveManagedState?: (state: ManagedState) => void;
  recordManagedSession?: (session: ManagedSession) => void;
  setupClipboardBindings?: () => void;
  removeWorktree?: (repoDir: string, worktreePath: string, force?: boolean) => void;
  deleteBranch?: (repoDir: string, branch: string, force?: boolean) => boolean | void;
  killSession?: (name: string) => void;
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
): void {
  exec(tmux, [
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    workDir,
    commandThenLoginShell(aiCmd),
  ]);
  setupBindings();
}

export function createManagedWorktreeSession(
  params: CreateManagedWorktreeSessionParams,
  deps: CreateManagedWorktreeSessionDeps = {},
): CreatedManagedWorktreeSession {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const mkdirSync = deps.mkdirSync ?? fsMkdirSync;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const gitQuery = deps.gitQuery ?? defaultGitQuery;
  const exec = deps.exec ?? defaultExec;
  const tmuxBin = deps.tmuxBin ?? defaultTmuxBin;
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const randomId = deps.randomId ?? randomHexId;
  const now = deps.now ?? (() => new Date());
  const setupBindings = deps.setupClipboardBindings ?? setupClipboardBindings;
  const cleanupWorktree = deps.removeWorktree ?? removeWorktree;
  const cleanupBranch = deps.deleteBranch ?? deleteBranch;
  const log = params.quiet ? () => undefined : console.log;

  if (!existsSync(params.projectDir)) {
    throw new CliError(`目录不存在: ${params.projectDir}`);
  }

  const session = resolveSessionName(params.sessionName, sessionExists);
  const tmux = tmuxBin();
  let workDir = params.projectDir;
  let createdWorktree: CreatedManagedWorktree | null = null;

  if (params.useWorktree) {
    if (!isGitRepo(params.projectDir)) {
      throw new CliError(`${params.projectDir} 不是 git 仓库`);
    }

    const label = params.projectKey ?? session;
    log(`📦 项目: ${label} (${params.projectDir})`);
    const targetBranch = detectTargetBranch(params.projectDir, params.branch, gitQuery);

    log(`🔄 正在从远程拉取最新代码 (${targetBranch})...`);
    exec("git", ["-C", params.projectDir, "fetch", "origin", targetBranch, "--quiet"]);

    const branchName = `${session}-${randomId()}`;
    const projectWorktreeRoot = join(params.worktreeBase, label);
    const worktreeDir = join(projectWorktreeRoot, branchName);
    mkdirSync(projectWorktreeRoot, { recursive: true });

    log(`🌿 创建 worktree 分支: ${branchName}`);
    log(`   路径: ${worktreeDir}`);
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

    createdWorktree = {
      repoDir: params.projectDir,
      path: worktreeDir,
      branch: branchName,
      project: label,
      baseBranch: targetBranch,
    };
    workDir = worktreeDir;
  } else {
    log(`📂 使用自定义目录 (跳过 git worktree):`);
    log(`   路径: ${params.projectDir}`);
  }

  log(`\n🖥️  正在创建 tmux session...`);
  log(`   Session:  ${session}`);
  log(`   AI 命令:  ${params.aiCmd}`);
  log();

  try {
    startManagedSession(tmux, session, workDir, params.aiCmd, exec, setupBindings);
  } catch (err) {
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

  if (createdWorktree) {
    try {
      persistManagedSession({
        name: session,
        kind: "worktree",
        profile: params.profile,
        project: createdWorktree.project,
        repoPath: createdWorktree.repoDir,
        worktreePath: createdWorktree.path,
        branch: createdWorktree.branch,
        baseBranch: createdWorktree.baseBranch,
        createdAt: now().toISOString(),
      }, deps);
    } catch (err) {
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

  return {
    session,
    workDir,
    worktree: createdWorktree,
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
  const setupBindings = deps.setupClipboardBindings ?? setupClipboardBindings;
  const cwd = params.cwd.trim();
  if (!cwd) throw new CliError("terminal cwd required");
  if (!existsSync(cwd)) throw new CliError(`目录不存在: ${cwd}`);

  let session = "";
  do {
    session = `tw-term-${randomId()}`;
  } while (sessionExists(session));

  startManagedSession(tmux, session, cwd, params.aiCmd ?? "", exec, setupBindings);
  try {
    persistManagedSession({
      name: session,
      kind: "terminal",
      profile: params.profile,
      cwd,
      createdAt: now().toISOString(),
    }, deps);
  } catch (error) {
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
  return { session, cwd };
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
