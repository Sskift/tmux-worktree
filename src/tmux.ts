import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

// ============================================
// tmux.ts — 安全执行 git / tmux 的底层模块
//
// 所有外部命令都用 execFileSync(bin, [args]) 直接调用，不经过 shell，
// 因此路径 / 分支名 / session 名即便含空格或 shell 元字符也不会被解析或注入。
// 这里同时集中 session / worktree 的列举与删除原语，供各命令复用。
// ============================================

// 内部 session 前缀：dashboard 的临时终端与移动端，CLI 命令族应忽略
const INTERNAL_SESSION_PREFIXES = ["tw-term-", "tw-mobile-"];

export function isInternalSession(name: string): boolean {
  return INTERNAL_SESSION_PREFIXES.some((p) => name.startsWith(p));
}

let cachedTmux: string | null = null;

/** 解析 tmux 可执行文件路径（缓存）。 */
export function tmuxBin(): string {
  if (cachedTmux) return cachedTmux;
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(p)) {
      cachedTmux = p;
      return p;
    }
  }
  cachedTmux = "tmux";
  return cachedTmux;
}

/** 运行命令，返回 trim 后的 stdout；失败返回空串（用于查询，不抛错，吞掉 stderr）。 */
export function query(bin: string, args: string[], timeout = 5000): string {
  try {
    return execFileSync(bin, args, {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** 运行命令，stdio 继承到终端；失败抛 CliError（用于会改状态的操作）。 */
export function exec(bin: string, args: string[], timeout = 30000): void {
  try {
    execFileSync(bin, args, { stdio: "inherit", timeout });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`命令失败: ${bin} ${args.join(" ")}\n  ${detail}`);
  }
}

/** 运行命令并捕获 stdout；失败抛 CliError。 */
export function run(bin: string, args: string[], timeout = 30000): string {
  try {
    return execFileSync(bin, args, { encoding: "utf-8", timeout }).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`命令失败: ${bin} ${args.join(" ")}\n  ${detail}`);
  }
}

/** 交互式运行（无超时，stdio 继承），用于 tmux attach 等需要把 TTY 交给子进程、
 *  可能持续很久的命令。返回子进程退出码，不抛错。 */
export function execInteractive(bin: string, args: string[]): number {
  const res = spawnSync(bin, args, { stdio: "inherit" });
  return res.status ?? 0;
}

/** 面向用户的错误：cli 顶层捕获后只打印 message，不打印 stack trace。 */
export class CliError extends Error {}

// ─── git 原语 ───

export function git(repoDir: string, args: string[], timeout = 30000): string {
  return run("git", ["-C", repoDir, ...args], timeout);
}

export function gitQuery(repoDir: string, args: string[], timeout = 10000): string {
  return query("git", ["-C", repoDir, ...args], timeout);
}

export function isGitRepo(dir: string): boolean {
  return gitQuery(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export interface WorktreeEntry {
  path: string;
  branch: string; // 去掉 refs/heads/ 前缀；detached 时为 "(detached)"
  head: string;
  bare: boolean;
}

/** 解析 `git worktree list --porcelain`，返回该仓库的所有 worktree。 */
export function listWorktrees(repoDir: string): WorktreeEntry[] {
  const raw = gitQuery(repoDir, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) entries.push(finishWorktree(cur));
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "detached") {
      cur.branch = "(detached)";
    }
  }
  if (cur.path) entries.push(finishWorktree(cur));
  return entries;
}

function finishWorktree(cur: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: cur.path!,
    branch: cur.branch ?? "(detached)",
    head: cur.head ?? "",
    bare: cur.bare ?? false,
  };
}

/** 工作区是否有未提交改动（含未跟踪文件）。目录不存在时返回 false。 */
export function worktreeIsDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  return gitQuery(worktreePath, ["status", "--porcelain"]).length > 0;
}

/** worktree 目录是否仍存在于磁盘。 */
export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}

/** 删除 worktree；force 时丢弃未提交改动。失败抛 CliError。 */
export function removeWorktree(repoDir: string, worktreePath: string, force = false): void {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  git(repoDir, args);
}

/** 删除本地分支。默认用安全的 -d（仅删已合并分支，未合并会被 git 拒绝）；
 *  force=true 用 -D 强删。detached 占位名跳过。
 *  返回是否删除成功（false 表示未合并被拒或不存在）。 */
export function deleteBranch(repoDir: string, branch: string, force = false): boolean {
  if (!branch || branch === "(detached)") return false;
  try {
    execFileSync("git", ["-C", repoDir, "branch", force ? "-D" : "-d", branch], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── tmux 原语 ───

export interface SessionEntry {
  name: string;
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
  cwd: string;
}

/** 列出 tmux session（默认排除内部 tw-term-/tw-mobile-）。 */
export function listSessions(includeInternal = false): SessionEntry[] {
  const tmux = tmuxBin();
  const fmt =
    "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
  const raw = query(tmux, ["list-sessions", "-F", fmt]);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, att, win, cre, act, cwd] = line.split("\x1f");
      return {
        name,
        attached: att === "1",
        windows: parseInt(win) || 0,
        created: parseInt(cre) || 0,
        activity: parseInt(act) || 0,
        cwd: cwd || "",
      };
    })
    .filter((s) => includeInternal || !isInternalSession(s.name));
}

/** session 是否存在（精确名匹配 `=name`，用 exit code 判定）。 */
export function sessionExists(name: string): boolean {
  try {
    execFileSync(tmuxBin(), ["has-session", "-t", `=${name}`], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function killSession(name: string): void {
  query(tmuxBin(), ["kill-session", "-t", `=${name}`]);
}

export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

// ─── config 路径辅助 ───

/** worktree 路径中用作 label 的项目名：取倒数第二段目录名。
 *  约定路径形如 <base>/<label>/<branchName>。 */
export function labelFromWorktreePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : basename(p);
}
