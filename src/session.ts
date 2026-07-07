import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  saveManagedState as defaultSaveManagedState,
  upsertManagedSession,
  type ManagedSessionProfile,
  type ManagedState,
} from "./state";

export const SESSION_NAME_MAX_LEN = 20;

export type WorktreeSessionLayout = "cli" | "dashboard";

export interface CreateManagedWorktreeSessionParams {
  aiCmd: string;
  projectDir: string;
  sessionName: string;
  useWorktree: boolean;
  worktreeBase: string;
  projectKey?: string;
  branch?: string;
  profile: ManagedSessionProfile;
  layout: WorktreeSessionLayout;
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
  setupClipboardBindings?: () => void;
  removeWorktree?: (repoDir: string, worktreePath: string, force?: boolean) => void;
  deleteBranch?: (repoDir: string, branch: string, force?: boolean) => void;
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

function startCliLayout(
  tmux: string,
  session: string,
  workDir: string,
  aiCmd: string,
  exec: (bin: string, args: string[], timeout?: number) => void,
  setupBindings: () => void,
): void {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  exec(tmux, ["new-session", "-d", "-s", session, "-c", workDir]);
  setupBindings();
  exec(tmux, ["send-keys", "-t", `${session}.1`, `node "${cliPath}" status`, "C-m"]);
  exec(tmux, ["split-window", "-h", "-t", `${session}.1`, "-c", workDir]);
  exec(tmux, ["send-keys", "-t", `${session}.2`, aiCmd, "C-m"]);
  exec(tmux, ["split-window", "-h", "-t", `${session}.2`, "-c", workDir, "-l", "40%"]);
  exec(tmux, ["select-pane", "-t", `${session}.2`]);
}

function startDashboardLayout(
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
  const loadManagedState = deps.loadManagedState ?? defaultLoadManagedState;
  const saveManagedState = deps.saveManagedState ?? defaultSaveManagedState;
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
    if (params.layout === "cli") {
      startCliLayout(tmux, session, workDir, params.aiCmd, exec, setupBindings);
    } else {
      startDashboardLayout(tmux, session, workDir, params.aiCmd, exec, setupBindings);
    }
  } catch (err) {
    if (createdWorktree) {
      console.error(`\n⚠️  tmux session 创建失败，正在回滚 worktree ${createdWorktree.path} ...`);
      try {
        cleanupWorktree(createdWorktree.repoDir, createdWorktree.path, true);
        cleanupBranch(createdWorktree.repoDir, createdWorktree.branch, true);
        console.error(`   已清理 worktree 和分支 ${createdWorktree.branch}`);
      } catch (cleanupErr) {
        const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.error(`   ⚠️  回滚失败，请手动清理: ${createdWorktree.path}\n   ${detail}`);
      }
    }
    throw err instanceof CliError ? err : new CliError(String(err));
  }

  if (createdWorktree) {
    try {
      saveManagedState(
        upsertManagedSession(loadManagedState(), {
          name: session,
          kind: "worktree",
          profile: params.profile,
          project: createdWorktree.project,
          repoPath: createdWorktree.repoDir,
          worktreePath: createdWorktree.path,
          branch: createdWorktree.branch,
          baseBranch: createdWorktree.baseBranch,
          createdAt: now().toISOString(),
        }),
      );
    } catch (err) {
      console.error(`⚠️  写入 TW state 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    session,
    workDir,
    worktree: createdWorktree,
  };
}
