import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  CliError,
  exec,
  execInteractive,
  query,
  tmuxBin,
  insideTmux,
  sessionExists,
  killSession,
  listSessions,
  listWorktrees,
  worktreeIsDirty,
  worktreeExists,
  removeWorktree,
  deleteBranch,
  isGitRepo,
  labelFromWorktreePath,
  type WorktreeEntry,
} from "./tmux";
import { loadConfigFile, type Config } from "./config";

// ============================================
// commands.ts — tw 的会话 / worktree / 诊断 命令族
// ============================================

// ─── 颜色 ───
const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function homeShort(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

/** 收集配置里所有仓库目录（去重，且确认是 git 仓库）。 */
function repoDirs(config: Config | null): string[] {
  if (!config) return [];
  const seen = new Set<string>();
  for (const proj of Object.values(config.projects)) {
    if (existsSync(proj.path) && isGitRepo(proj.path) && !seen.has(proj.path)) {
      seen.add(proj.path);
    }
  }
  return [...seen];
}

interface WorktreeRow extends WorktreeEntry {
  repoDir: string;
  label: string;
  isMain: boolean; // 主仓库本身（不是衍生 worktree）
  hasSession: boolean;
}

/** 规范化路径用于比较：解析真实路径（含大小写/软链），失败则原样返回。 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 列出所有项目的所有 worktree，并标注是否有对应 session（孤儿判定）。 */
function collectWorktrees(config: Config | null): WorktreeRow[] {
  const repos = repoDirs(config);
  const sessions = listSessions();
  // session 的 pane cwd（规范化）。注意 pane 可能 cd 进 worktree 的子目录，
  // 故下面用「前缀」匹配而非精确相等，避免把在用的 worktree 误判为孤儿。
  const sessionDirs = sessions.map((s) => canonical(s.cwd)).filter(Boolean);
  const rows: WorktreeRow[] = [];
  for (const repoDir of repos) {
    const wts = listWorktrees(repoDir);
    const repoCanon = canonical(repoDir);
    wts.forEach((wt, idx) => {
      // 主 worktree：porcelain 输出第一条，或路径规范化后等于仓库根
      const isMain = idx === 0 || canonical(wt.path) === repoCanon;
      const wtCanon = canonical(wt.path);
      rows.push({
        ...wt,
        repoDir,
        label: labelFromWorktreePath(wt.path),
        isMain,
        // 有 session 的工作目录正好在这个 worktree 内（含其子目录）
        hasSession: sessionDirs.some((d) => d === wtCanon || d.startsWith(wtCanon + "/")),
      });
    });
  }
  return rows;
}

// ─── flag 解析小工具 ───
function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}
function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

// ============================================
// tw ls — 列出 session
// ============================================
export async function listCmd(): Promise<void> {
  const config = loadConfigFile();
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(C.dim("没有正在运行的 tmux session。用 `tw <ai> <project>` 创建一个。"));
    return;
  }

  // worktree 路径 → 分支，便于显示 session 对应分支（按规范化路径索引）
  const wtByPath = new Map<string, WorktreeRow>();
  for (const wt of collectWorktrees(config)) wtByPath.set(canonical(wt.path), wt);

  const nameW = Math.max(...sessions.map((s) => s.name.length), 7);
  console.log(
    C.bold(
      ` ${"SESSION".padEnd(nameW)}  ${"分支".padEnd(18)}  目录`
    )
  );
  for (const s of sessions) {
    const marker = s.attached ? C.green("●") : C.dim("○");
    const wt = wtByPath.get(canonical(s.cwd));
    // 先按纯文本对齐，再上色，避免 ANSI 转义码被计入 padEnd 宽度导致错位
    const branchText = wt ? wt.branch : "-";
    const branchCol = branchText.padEnd(18);
    const branch = wt ? branchCol : C.dim(branchCol);
    const dir = homeShort(s.cwd || "");
    console.log(` ${marker} ${s.name.padEnd(nameW)}  ${branch}  ${C.dim(dir)}`);
  }
}

// ============================================
// tw attach <session> — 接入 / 切换
// ============================================
export async function attachCmd(args: string[]): Promise<void> {
  const [name] = positional(args);
  if (!name) {
    throw new CliError("用法: tw attach <session>\n可用: " + sessionNamesHint());
  }
  if (!sessionExists(name)) {
    throw new CliError(`session 不存在: ${name}\n可用: ${sessionNamesHint()}`);
  }
  const tmux = tmuxBin();
  if (insideTmux()) {
    exec(tmux, ["switch-client", "-t", name]);
  } else {
    // attach 是交互式、可能持续很久：用无超时的 spawnSync，把 TTY 交给 tmux
    const code = execInteractive(tmux, ["attach", "-t", name]);
    process.exitCode = code;
  }
}

function sessionNamesHint(): string {
  const names = listSessions().map((s) => s.name);
  return names.length ? names.join(", ") : "(无)";
}

// ============================================
// tw rm <session> [--worktree] — 杀 session，可连带删 worktree
// ============================================
export async function rmSessionCmd(args: string[]): Promise<void> {
  const [name] = positional(args);
  const alsoWorktree = hasFlag(args, "--worktree", "-w");
  const force = hasFlag(args, "--force", "-f");
  if (!name) {
    throw new CliError("用法: tw rm <session> [--worktree] [--force]\n可用: " + sessionNamesHint());
  }
  if (!sessionExists(name)) {
    throw new CliError(`session 不存在: ${name}\n可用: ${sessionNamesHint()}`);
  }

  // 记下工作目录（kill 后就查不到了）
  const session = listSessions(true).find((s) => s.name === name);
  const cwd = session?.cwd ?? "";

  // 若要连带删 worktree：先定位 + 做脏检查，再杀 session，保证「要么都成功、
  // 要么 session 不被白杀」。否则先 kill 再删失败会留下被孤立的 session 丢失。
  let wtToRemove: WorktreeRow | null = null;
  if (alsoWorktree) {
    const config = loadConfigFile();
    const cwdCanon = canonical(cwd);
    const wt = collectWorktrees(config).find(
      (w) => !w.isMain && (canonical(w.path) === cwdCanon || cwdCanon.startsWith(canonical(w.path) + "/"))
    );
    if (!wt) {
      console.log(C.dim(`未找到对应 worktree（目录 ${homeShort(cwd)} 不是衍生 worktree），将只杀 session。`));
    } else if (worktreeIsDirty(wt.path) && !force) {
      throw new CliError(
        `worktree ${wt.branch} 有未提交改动，拒绝删除（session 未被杀）。\n  路径: ${homeShort(wt.path)}\n  确认丢弃请加 --force`
      );
    } else {
      wtToRemove = wt;
    }
  }

  killSession(name);
  console.log(C.green(`✓ 已杀掉 session ${name}`));

  if (wtToRemove) {
    removeWorktreeRow(wtToRemove, force);
  }
}

// ============================================
// tw worktree <子命令>
// ============================================
export async function worktreeCmd(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "ls":
    case undefined:
      return worktreeLs();
    case "rm":
      return worktreeRm(rest);
    case "prune":
      return worktreePrune(rest);
    default:
      throw new CliError(`未知 worktree 子命令: ${sub}\n可用: ls | rm <name> | prune`);
  }
}

function worktreeLs(): void {
  const config = loadConfigFile();
  const rows = collectWorktrees(config).filter((w) => !w.isMain);
  if (rows.length === 0) {
    console.log(C.dim("没有衍生 worktree。"));
    return;
  }
  const nameW = Math.max(...rows.map((w) => w.branch.length), 6);
  console.log(C.bold(` ${"分支".padEnd(nameW)}  状态        路径`));
  for (const w of rows) {
    const missing = !worktreeExists(w.path);
    let status: string;
    if (missing) status = C.red("已删除");
    else if (!w.hasSession) status = C.yellow("孤儿");
    else status = C.green("使用中");
    const dirty = worktreeIsDirty(w.path) ? C.red(" *脏") : "";
    console.log(
      ` ${w.branch.padEnd(nameW)}  ${status}${dirty}   ${C.dim(homeShort(w.path))}`
    );
  }
  const orphanCount = rows.filter((w) => !w.hasSession).length;
  if (orphanCount > 0) {
    console.log(C.dim(`\n${orphanCount} 个孤儿 worktree。用 \`tw worktree prune\` 清理。`));
  }
}

function worktreeRm(args: string[]): void {
  const [target] = positional(args);
  const force = hasFlag(args, "--force", "-f");
  if (!target) {
    throw new CliError("用法: tw worktree rm <name|path> [--force]");
  }
  const config = loadConfigFile();
  const rows = collectWorktrees(config).filter((w) => !w.isMain);
  // 精确匹配（完整路径或分支名）优先；否则按路径尾段匹配。
  const exact = rows.filter((w) => w.branch === target || w.path === target);
  const matches = exact.length > 0 ? exact : rows.filter((w) => w.path.endsWith("/" + target));
  if (matches.length === 0) {
    throw new CliError(`未找到 worktree: ${target}\n可用: ${rows.map((w) => w.branch).join(", ") || "(无)"}`);
  }
  if (matches.length > 1) {
    // 跨项目重名：拒绝，列出候选让用户用完整路径指定
    const cands = matches.map((w) => `  ${w.branch}  ${homeShort(w.path)}`).join("\n");
    throw new CliError(`'${target}' 匹配到多个 worktree，请用完整路径指定其一:\n${cands}`);
  }
  removeWorktreeRow(matches[0], force);
}

function worktreePrune(args: string[]): void {
  const dryRun = hasFlag(args, "--dry-run", "-n");
  const force = hasFlag(args, "--force", "-f");
  const config = loadConfigFile();
  const orphans = collectWorktrees(config).filter((w) => !w.isMain && !w.hasSession);
  if (orphans.length === 0) {
    console.log(C.green("✓ 没有孤儿 worktree。"));
    return;
  }
  console.log(`发现 ${orphans.length} 个孤儿 worktree（无对应 session）:`);
  for (const w of orphans) {
    const dirty = worktreeIsDirty(w.path) ? C.red(" *有未提交改动") : "";
    console.log(`  ${w.branch}  ${C.dim(homeShort(w.path))}${dirty}`);
  }
  if (dryRun) {
    console.log(C.dim("\n(--dry-run，未实际删除)"));
    return;
  }
  let removed = 0;
  let keptBranches = 0;
  const prunedRepos = new Set<string>();
  for (const w of orphans) {
    // 目录已不在磁盘：清理 git 元数据（每个 repo 只需跑一次 worktree prune）+ 分支
    if (!worktreeExists(w.path)) {
      if (!prunedRepos.has(w.repoDir)) {
        query("git", ["-C", w.repoDir, "worktree", "prune"]);
        prunedRepos.add(w.repoDir);
      }
      // 安全删分支：未合并分支用 -d 会被 git 拒绝（除非 --force），避免误丢提交
      if (deleteBranch(w.repoDir, w.branch, force)) {
        console.log(C.green(`  ✓ 已清理失效记录 ${w.branch}`));
      } else {
        keptBranches++;
        console.log(C.yellow(`  ! 已清理记录但保留分支 ${w.branch}（有未合并提交，--force 强删）`));
      }
      removed++;
      continue;
    }
    // 脏 worktree 默认跳过，除非 --force
    if (worktreeIsDirty(w.path) && !force) {
      console.log(C.yellow(`  跳过 ${w.branch}（有未提交改动，--force 强制删除）`));
      continue;
    }
    try {
      removeWorktree(w.repoDir, w.path, force);
      if (deleteBranch(w.repoDir, w.branch, force)) {
        console.log(C.green(`  ✓ 已删除 ${w.branch}`));
      } else {
        keptBranches++;
        console.log(C.yellow(`  ! 已删 worktree 但保留分支 ${w.branch}（有未合并提交，--force 强删）`));
      }
      removed++;
    } catch (err) {
      console.log(C.red(`  ✗ 删除 ${w.branch} 失败: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  let summary = `\n清理完成：处理 ${removed}/${orphans.length} 个`;
  if (keptBranches > 0) summary += `，保留 ${keptBranches} 个未合并分支（加 --force 删除）`;
  console.log(C.green(summary));
}

function removeWorktreeRow(wt: WorktreeRow, force: boolean): void {
  if (worktreeIsDirty(wt.path) && !force) {
    throw new CliError(
      `worktree ${wt.branch} 有未提交改动，拒绝删除。\n  路径: ${homeShort(wt.path)}\n  确认丢弃请加 --force`
    );
  }
  removeWorktree(wt.repoDir, wt.path, force);
  if (deleteBranch(wt.repoDir, wt.branch, force)) {
    console.log(C.green(`✓ 已删除 worktree ${wt.branch} 及其分支`));
  } else {
    console.log(C.yellow(`✓ 已删除 worktree ${wt.branch}，但保留分支（有未合并提交，--force 强删）`));
  }
}

// ============================================
// tw doctor — 环境诊断
// ============================================
export async function doctorCmd(): Promise<void> {
  console.log(C.bold("tw doctor — 环境检查\n"));
  let problems = 0;

  // tmux
  const tmux = tmuxBin();
  const tmuxVer = query(tmux, ["-V"]);
  if (tmuxVer) {
    ok(`tmux: ${tmuxVer}  (${tmux})`);
  } else {
    problems++;
    bad("tmux: 未找到 — 安装: brew install tmux");
  }

  // git
  const gitVer = query("git", ["--version"]);
  if (gitVer) ok(`git: ${gitVer}`);
  else { problems++; bad("git: 未找到 — 安装: brew install git"); }

  // node
  ok(`node: ${process.version}`);

  // 配置文件
  const config = loadConfigFile();
  if (!config) {
    problems++;
    bad("配置: ~/.tmux-worktree.json 不存在 — 运行 tw setup 或首次 tw 创建");
  } else {
    const projectCount = Object.keys(config.projects).length;
    if (projectCount === 0) {
      problems++;
      bad("配置: 已加载但没有任何项目");
    } else {
      ok(`配置: ${projectCount} 个项目`);
      // 逐个检查项目路径与 git
      for (const [name, proj] of Object.entries(config.projects)) {
        if (!existsSync(proj.path)) {
          problems++;
          bad(`  项目 ${name}: 路径不存在 ${homeShort(proj.path)}`);
        } else if (!isGitRepo(proj.path)) {
          problems++;
          bad(`  项目 ${name}: 不是 git 仓库 ${homeShort(proj.path)}`);
        } else {
          ok(`  项目 ${name}: ${homeShort(proj.path)}`);
        }
      }
    }
    const wtBase = config.worktreeBase ?? "/private/tmp/tmux-worktree/projects";
    ok(`worktree 根目录: ${homeShort(wtBase)}`);
  }

  // session / 孤儿统计
  const sessions = listSessions();
  const orphans = collectWorktrees(config).filter((w) => !w.isMain && !w.hasSession);
  console.log();
  ok(`tmux session: ${sessions.length} 个`);
  if (orphans.length > 0) {
    warn(`孤儿 worktree: ${orphans.length} 个 — 用 tw worktree prune 清理`);
  } else {
    ok("孤儿 worktree: 0");
  }

  console.log();
  if (problems === 0) {
    console.log(C.green("✓ 一切就绪。"));
  } else {
    console.log(C.red(`发现 ${problems} 个问题（见上 ✗）。`));
    process.exitCode = 1;
  }
}

function ok(msg: string): void {
  console.log(`  ${C.green("✓")} ${msg}`);
}
function warn(msg: string): void {
  console.log(`  ${C.yellow("!")} ${msg}`);
}
function bad(msg: string): void {
  console.log(`  ${C.red("✗")} ${msg}`);
}

function which(cmd: string): string {
  try {
    return execFileSync("which", [cmd], { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    return "";
  }
}
