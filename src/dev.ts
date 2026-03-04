import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

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

// --- 配置 ---
interface Config {
  projects: Record<string, string>;
  worktreeBase?: string;
  notesBase?: string;
}

const CONFIG_PATH = join(homedir(), ".tmux-worktree.json");

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function initConfigInteractive(): Promise<Config> {
  console.log(`${CONFIG_PATH} 不存在，开始初始化...\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const projects: Record<string, string> = {};

    console.log("添加项目 (留空结束):");
    while (true) {
      const name = (await prompt(rl, "  项目名称: ")).trim();
      if (!name) break;
      const path = (await prompt(rl, "  仓库路径: ")).trim();
      if (!path) break;
      projects[name] = path.replace(/^~/, homedir());
    }

    if (Object.keys(projects).length === 0) {
      console.error("\n错误: 至少需要添加一个项目");
      process.exit(1);
    }

    console.log();
    const defaultWorktree = "/private/tmp/tmux-worktree/projects";
    const defaultNotes = "/private/tmp/tmux-worktree/notes";

    const worktreeInput = (await prompt(rl, `worktree 目录 (${defaultWorktree}): `)).trim();
    const notesInput = (await prompt(rl, `notes 目录 (${defaultNotes}): `)).trim();

    const config: Config = { projects };
    if (worktreeInput) config.worktreeBase = worktreeInput.replace(/^~/, homedir());
    if (notesInput) config.notesBase = notesInput.replace(/^~/, homedir());

    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    console.log(`\n✅ 已保存到 ${CONFIG_PATH}\n`);
    return config;
  } finally {
    rl.close();
  }
}

async function loadConfig(): Promise<Config> {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }
  return initConfigInteractive();
}

const SESSION_NAME_MAX_LEN = 20;

interface RunParams {
  aiCmd: string;
  projectDir: string;
  sessionName: string;
  useWorktree: boolean;
  projectKey?: string; // 项目在配置中的 key，用于 worktree 路径
}

async function interactiveSelect(projects: Record<string, string>): Promise<RunParams> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("🚀 tmux-worktree 交互模式\n");

    // --- AI 命令 ---
    console.log("输入要在左栏启动的 AI 命令，如 coco, claude, aider 等");
    console.log("也可以带参数，如 \"claude --model opus\"");
    const aiInput = (await prompt(rl, `AI 命令 (默认 coco): `)).trim();
    const aiCmd = aiInput || "coco";

    // --- 项目 ---
    const projectEntries = Object.entries(projects);
    console.log("\n选择项目 (将在 git worktree 中工作):");
    projectEntries.forEach(([name, path], i) => {
      const display = path.replace(homedir(), "~");
      console.log(`  ${i + 1}) ${name.padEnd(12)} ${display}`);
    });
    console.log(`  0) 自定义目录        输入任意路径，跳过 worktree`);
    console.log(`  也可以直接输入项目名或目录路径`);
    const projInput = (await prompt(rl, `\n选择项目 (默认 1): `)).trim();

    let projectDir: string;
    let sessionName: string;
    let useWorktree: boolean;
    let projectKey: string | undefined;

    const projIdx = parseInt(projInput, 10);
    if (!projInput) {
      // 默认第一个项目
      const [key, dir] = projectEntries[0];
      projectKey = key;
      projectDir = dir;
      sessionName = key;
      useWorktree = true;
    } else if (projIdx === 0) {
      // 自定义目录
      console.log("\n输入目录的绝对路径，支持 ~ 开头");
      const customPath = (await prompt(rl, `目录路径: `)).trim().replace(/^~/, homedir());
      if (!customPath || !existsSync(customPath)) {
        console.error(`\n错误: 目录不存在: ${customPath || "(空)"}`);
        process.exit(1);
      }
      projectDir = customPath;
      sessionName = customPath.split("/").filter(Boolean).pop() || "session";
      useWorktree = false;
    } else if (projIdx >= 1 && projIdx <= projectEntries.length) {
      const [key, dir] = projectEntries[projIdx - 1];
      projectKey = key;
      projectDir = dir;
      sessionName = key;
      useWorktree = true;
    } else {
      // 非数字输入：先查项目名，再当路径
      const key = projInput;
      if (projects[key]) {
        projectKey = key;
        projectDir = projects[key];
        sessionName = key;
        useWorktree = true;
      } else {
        const resolved = projInput.replace(/^~/, homedir());
        if (existsSync(resolved)) {
          projectDir = resolved;
          sessionName = resolved.split("/").filter(Boolean).pop() || "session";
          useWorktree = false;
        } else {
          console.error(`\n错误: 未知项目 '${projInput}'，且该路径不存在`);
          console.error(`可用项目: ${Object.keys(projects).join(", ")}`);
          process.exit(1);
        }
      }
    }

    // --- Session 名称 ---
    console.log(`\n输入 session 标题，最终名称为 <project>-<title>`);
    const sessInput = (await prompt(rl, `Session 标题 (留空只用项目名 '${sessionName}'): `)).trim();
    if (sessInput && projectKey) {
      sessionName = `${projectKey}-${sessInput}`;
    } else if (sessInput) {
      sessionName = sessInput;
    }

    console.log();
    return { aiCmd, projectDir, sessionName: sessionName.slice(0, SESSION_NAME_MAX_LEN), useWorktree, projectKey };
  } finally {
    rl.close();
  }
}

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

function parseArgs(projects: Record<string, string>): RunParams {
  const [aiCmd, project, sessionArg] = process.argv.slice(2);

  if (!aiCmd || !project) {
    console.log(`用法: tw <ai-command> <project|path> [session-name]

参数:
  ai-command    要在左栏运行的命令 (如 claude, aider, codex)
  project       项目名称 (${Object.keys(projects).join(", ")}) 或目录路径
  session-name  可选，tmux session 显示名 (默认同 project)

示例:
  tw claude coco
  tw claude coco fix-auth-bug
  tw claude ~/some/dir
  tw                           # 交互模式`);
    process.exit(1);
  }

  const mappedDir = projects[project];
  if (mappedDir) {
    // 项目在映射中
    const sessionName = sessionArg ? `${project}-${sessionArg}`.slice(0, SESSION_NAME_MAX_LEN) : project;
    return { aiCmd, projectDir: mappedDir, sessionName, useWorktree: true, projectKey: project };
  }

  // 不在映射中，当作目录路径
  const resolved = project.replace(/^~/, homedir());
  if (existsSync(resolved)) {
    const dirName = resolved.split("/").filter(Boolean).pop() || "session";
    const sessionName = (sessionArg ?? dirName).slice(0, SESSION_NAME_MAX_LEN);
    return { aiCmd, projectDir: resolved, sessionName, useWorktree: false };
  }

  console.error(`错误: 未知项目 '${project}'，且路径不存在`);
  console.error(`可用项目: ${Object.keys(projects).join(", ")}`);
  process.exit(1);
}

export async function run() {
  const config = await loadConfig();
  const PROJECT_DIRS = config.projects;
  const WORKTREE_BASE = config.worktreeBase ?? "/private/tmp/tmux-worktree/projects";
  const NOTES_BASE = config.notesBase ?? "/private/tmp/tmux-worktree/notes";

  // --- 参数解析 ---
  const hasArgs = process.argv.length > 2;
  const params = hasArgs ? parseArgs(PROJECT_DIRS) : await interactiveSelect(PROJECT_DIRS);
  const { aiCmd, projectDir, useWorktree, projectKey } = params;

  if (!existsSync(projectDir)) {
    console.error(`错误: 目录不存在: ${projectDir}`);
    process.exit(1);
  }

  // --- 确定工作目录 ---
  let workDir: string;

  if (useWorktree) {
    // 确保是 git 仓库
    const gitOk = sh(`git -C ${projectDir} rev-parse --is-inside-work-tree`);
    if (gitOk !== "true") {
      console.error(`错误: ${projectDir} 不是 git 仓库`);
      process.exit(1);
    }

    const label = projectKey ?? params.sessionName;

    console.log(`📦 项目: ${label} (${projectDir})`);
    console.log(`🔄 正在从远程拉取最新代码...`);
    shExec(`git -C ${projectDir} fetch origin master --quiet`);

    // 创建 worktree
    const branchId = Math.random().toString(36).slice(2, 7);
    const branchName = `${params.sessionName}-${branchId}`;
    const worktreeDir = `${WORKTREE_BASE}/${label}/${branchName}`;
    mkdirSync(`${WORKTREE_BASE}/${label}`, { recursive: true });

    console.log(`🌿 创建 worktree 分支: ${branchName}`);
    console.log(`   路径: ${worktreeDir}`);
    shExec(
      `git -C ${projectDir} worktree add -b ${branchName} ${worktreeDir} origin/master --quiet`
    );
    workDir = worktreeDir;
  } else {
    console.log(`📂 使用自定义目录 (跳过 git worktree):`);
    console.log(`   路径: ${projectDir}`);
    workDir = projectDir;
  }

  // --- 生成唯一 session 名称 ---
  const session = resolveSessionName(params.sessionName);

  // --- 创建 tmux session ---
  const notesFile = `${NOTES_BASE}/${session}.md`;
  console.log(`\n🖥️  正在创建 tmux session...`);
  console.log(`   Session:  ${session}`);
  console.log(`   AI 命令:  ${aiCmd}`);
  console.log(`   笔记文件: ${notesFile}`);
  console.log();

  // 创建 session，初始窗口运行 status (最左栏固定宽度)
  shExec(`tmux new-session -d -s ${session} -c ${workDir}`);
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  shExec(`tmux send-keys -t '${session}.1' 'node "${cliPath}" status' C-m`);

  // 右侧：AI 命令
  shExec(`tmux split-window -h -t '${session}.1' -c ${workDir}`);
  shExec(`tmux send-keys -t '${session}.2' '${aiCmd}' C-m`);

  // AI 命令右侧再分出 40% 给终端 + 笔记
  shExec(`tmux split-window -h -t '${session}.2' -c ${workDir} -l 40%`);

  // 终端下方分出笔记 pane
  mkdirSync(NOTES_BASE, { recursive: true });
  if (!existsSync(notesFile)) {
    writeFileSync(notesFile, `# ${session}\n`);
  }
  shExec(`tmux split-window -v -t '${session}.3' -l 40%`);
  shExec(
    `tmux send-keys -t '${session}.4' 'vi +2 -c startinsert ${notesFile}' C-m`
  );

  // 聚焦到 AI 命令栏
  shExec(`tmux select-pane -t '${session}.2'`);

  // 连接：如果已在 tmux 中则 switch-client，否则 attach
  console.log(`✅ 环境就绪，正在连接 tmux session "${session}"...`);
  const inTmux = !!process.env.TMUX;
  if (inTmux) {
    shExec(`tmux switch-client -t '${session}'`);
  } else {
    const child = spawn("tmux", ["attach", "-t", session], {
      stdio: "inherit",
    });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });
    process.exitCode = exitCode;
  }

  // 调整左侧大小
  shExec(`tmux resize-pane -t '${session}:1.1' -x 30`);
}
