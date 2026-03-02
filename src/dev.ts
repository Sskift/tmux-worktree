import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

// ============================================
// dev.ts — AI + tmux + git worktree 开发环境
//
// 用法: npx tmux-worktree <ai-command> <project> [session-name]
// 示例: npx tmux-worktree claude coco fix-auth
//       npx tmux-worktree "claude --model opus" coco
// ============================================

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return "";
  }
}

function shExec(cmd: string): void {
  execSync(cmd, { stdio: "inherit", timeout: 30000 });
}

// --- 项目目录映射 ---
const PROJECT_DIRS: Record<string, string> = {
  coco: `${process.env.HOME}/go/src/code.byted.org/nextcode/coco`,
  vecode: `${process.env.HOME}/go/src/code.byted.org/vecode/vecode`,
};

const WORKTREE_BASE = "/private/tmp/jyn/projects";
const NOTES_BASE = "/private/tmp/jyn/notes";
const SESSION_NAME_MAX_LEN = 20;

export async function run() {
  // --- 参数解析 ---
  const [aiCmd, project, sessionArg] = process.argv.slice(2);

  if (!aiCmd || !project) {
    console.log(`用法: npx tmux-worktree <ai-command> <project> [session-name]

参数:
  ai-command    要在左栏运行的命令 (如 claude, aider, codex)
  project       项目名称 (${Object.keys(PROJECT_DIRS).join(", ")})
  session-name  可选，tmux session 显示名 (默认同 project)

示例:
  npx tmux-worktree claude coco
  npx tmux-worktree claude coco fix-auth-bug
  npx tmux-worktree "claude --model opus" coco refactor`);
    process.exit(1);
  }

  const sessionName = (sessionArg ?? project).slice(0, SESSION_NAME_MAX_LEN);

  // --- 校验项目 ---
  const projectDir = PROJECT_DIRS[project];
  if (!projectDir) {
    console.error(`错误: 未知项目 '${project}'`);
    console.error(`可用项目: ${Object.keys(PROJECT_DIRS).join(", ")}`);
    process.exit(1);
  }

  if (!existsSync(projectDir)) {
    console.error(`错误: 项目目录不存在: ${projectDir}`);
    process.exit(1);
  }

  // --- 确保是 git 仓库 ---
  const gitOk = sh(`git -C ${projectDir} rev-parse --is-inside-work-tree`);
  if (gitOk !== "true") {
    console.error(`错误: ${projectDir} 不是 git 仓库`);
    process.exit(1);
  }

  // --- 生成唯一 session 名称 ---
  function resolveSessionName(base: string): string {
    let name = base;
    let i = 1;
    while (true) {
      const rc = sh(`tmux has-session -t '=${name}' 2>/dev/null && echo ok`);
      if (rc !== "ok") break;
      name = `${base}-${i}`;
      i++;
    }
    return name;
  }

  const session = resolveSessionName(sessionName);

  // --- 生成短随机分支名 ---
  const branchId = Math.random().toString(36).slice(2, 7);
  const branchName = `${sessionName}-${branchId}`;

  // --- 拉取最新 origin/master ---
  console.log(`📦 项目: ${project} (${projectDir})`);
  console.log(`🔄 拉取 origin/master...`);
  shExec(`git -C ${projectDir} fetch origin master --quiet`);

  // --- 创建 worktree ---
  const worktreeDir = `${WORKTREE_BASE}/${project}/${branchName}`;
  mkdirSync(`${WORKTREE_BASE}/${project}`, { recursive: true });

  console.log(`🌿 创建分支: ${branchName}`);
  console.log(`📂 Worktree: ${worktreeDir}`);
  shExec(
    `git -C ${projectDir} worktree add -b ${branchName} ${worktreeDir} origin/master --quiet`
  );

  // --- 创建 tmux session ---
  console.log(`🖥️  Session: ${session}`);
  console.log(`🤖 AI 命令: ${aiCmd}`);
  console.log(`📝 笔记: ${NOTES_BASE}/${session}.md`);
  console.log();

  // 创建 session，初始窗口进入 worktree 目录
  shExec(`tmux new-session -d -s ${session} -c ${worktreeDir}`);

  // 左右分屏，右栏占 40%
  shExec(`tmux split-window -h -t ${session} -c ${worktreeDir} -l 40%`);

  // 左栏运行 AI 命令
  shExec(`tmux send-keys -t '${session}.1' '${aiCmd}' C-m`);

  // 右栏下方再分一个 pane 用于记笔记
  const notesFile = `${NOTES_BASE}/${session}.md`;
  mkdirSync(NOTES_BASE, { recursive: true });
  if (!existsSync(notesFile)) {
    writeFileSync(notesFile, `# ${session}\n`);
  }
  shExec(`tmux split-window -v -t '${session}.2' -l 40%`);
  shExec(
    `tmux send-keys -t '${session}.3' 'vi +2 -c startinsert ${notesFile}' C-m`
  );

  // 笔记 pane 下方再分一个 pane 用于监视 tmux session
  shExec(`tmux split-window -v -t '${session}.3' -l 40%`);
  shExec(
    `tmux send-keys -t '${session}.4' 'npx tmux-worktree status' C-m`
  );

  // 聚焦到左栏
  shExec(`tmux select-pane -t '${session}.1'`);

  // 连接
  console.log(`✅ 就绪，正在连接...`);
  const child = spawn("tmux", ["attach", "-t", session], {
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
  process.exitCode = exitCode;
}
