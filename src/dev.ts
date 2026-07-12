import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
  CONFIG_PATH,
  type Config,
  type ProjectConfig,
  defaultWorktreeBase,
  expandHomePath,
  loadConfigFile,
  normalizeConfig,
  resolveWorktreeBase,
} from "./config";
import { acquireConfigFileLock, releaseConfigFileLock } from "./hosts";
import {
  CliError,
  exec,
  insideTmux,
  isGitRepo,
  tmuxBin,
} from "./tmux";
import {
  createManagedWorktreeSession,
  SESSION_NAME_MAX_LEN,
} from "./session";

// ============================================
// dev.ts — AI + tmux + git worktree 开发环境
//
// 用法: npx tmux-worktree <ai-command> <project> [session-name]
// 示例: npx tmux-worktree claude myproject fix-auth
//       npx tmux-worktree "claude --model opus" myproject
//
// 所有 git / tmux 调用都经 ./tmux 的 execFile 包装，不拼 shell 字符串，
// 因此路径 / 分支名含空格或特殊字符都安全。
// ============================================

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

interface InitialRawConfig {
  projects: Record<string, string>;
  worktreeBase?: string;
}

function configCreatedDuringInitialization(configPath: string): CliError {
  return new CliError(`${configPath} 已由其他进程创建，已取消初始化且未覆盖现有配置`);
}

/**
 * Publish a brand-new config without ever replacing an existing file.
 *
 * The shared lock coordinates with Host/Dashboard read-modify-write paths.
 * The final hard-link is also an atomic create-if-absent operation, so even a
 * non-participating writer cannot be overwritten between the locked recheck
 * and publication.
 */
export function persistInitialConfig(
  rawConfig: InitialRawConfig,
  configPath = CONFIG_PATH,
): Config {
  const lock = acquireConfigFileLock(`${configPath}.lock`);
  try {
    if (existsSync(configPath)) throw configCreatedDuringInitialization(configPath);

    const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(rawConfig, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        linkSync(tempPath, configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw configCreatedDuringInitialization(configPath);
        }
        throw error;
      }
    } finally {
      rmSync(tempPath, { force: true });
    }
    return normalizeConfig(rawConfig);
  } finally {
    releaseConfigFileLock(lock);
  }
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
      projects[name] = expandHomePath(path);
    }

    if (Object.keys(projects).length === 0) {
      console.error("\n错误: 至少需要添加一个项目");
      process.exit(1);
    }

    console.log();
    const defaultWorktree = defaultWorktreeBase();

    const worktreeInput = (await prompt(rl, `worktree 目录 (${defaultWorktree}): `)).trim();

    // 写入磁盘的是原始格式 {projects:{name:"path"}}，由 normalizeConfig 解析为 Config
    const rawConfig: InitialRawConfig = { projects };
    if (worktreeInput) rawConfig.worktreeBase = expandHomePath(worktreeInput);

    const config = persistInitialConfig(rawConfig);
    console.log(`\n✅ 已保存到 ${CONFIG_PATH}\n`);
    return config;
  } finally {
    rl.close();
  }
}

async function loadConfig(): Promise<Config> {
  const config = loadConfigFile();
  if (config) return config;
  return initConfigInteractive();
}

interface RunParams {
  aiCmd: string;
  projectDir: string;
  sessionName: string;
  projectKey?: string; // 项目在配置中的 key，用于 worktree 路径
  branch?: string; // 目标分支，未指定时自动探测默认分支
}

async function interactiveSelect(projects: Record<string, ProjectConfig>): Promise<RunParams> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("🚀 tmux-worktree 交互模式\n");

    // --- AI 命令 ---
    console.log("输入要在 session 中启动的 AI 命令，如 claude, aider, codex 等");
    console.log("也可以带参数，如 \"claude --model opus\"");
    const aiInput = (await prompt(rl, `AI 命令 (默认 claude): `)).trim();
    const aiCmd = aiInput || "claude";

    // --- 项目 ---
    const projectEntries = Object.entries(projects);
    console.log("\n选择项目 (将在 git worktree 中工作):");
    projectEntries.forEach(([name, project], i) => {
      const display = project.path.replace(homedir(), "~");
      const branch = project.branch ? `  [${project.branch}]` : "";
      console.log(`  ${i + 1}) ${name.padEnd(12)} ${display}${branch}`);
    });
    console.log(`  0) Git 仓库路径      输入未配置的本地仓库`);
    console.log(`  也可以直接输入项目名或 Git 仓库路径`);
    const projInput = (await prompt(rl, `\n选择项目 (默认 1): `)).trim();

    let projectDir: string;
    let sessionName: string;
    let projectKey: string | undefined;
    let projectBranch: string | undefined;

    const projIdx = parseInt(projInput, 10);
    if (!projInput) {
      // 默认第一个项目
      const [key, project] = projectEntries[0];
      projectKey = key;
      projectDir = project.path;
      projectBranch = project.branch;
      sessionName = key;
    } else if (projIdx === 0) {
      // 未配置的本地 git 仓库
      console.log("\n输入 Git 仓库的绝对路径，支持 ~ 开头");
      const customPath = expandHomePath((await prompt(rl, `Git 仓库路径: `)).trim());
      if (!customPath || !existsSync(customPath)) {
        console.error(`\n错误: 目录不存在: ${customPath || "(空)"}`);
        process.exit(1);
      }
      projectDir = customPath;
      projectKey = basename(customPath) || "project";
      sessionName = projectKey;
    } else if (projIdx >= 1 && projIdx <= projectEntries.length) {
      const [key, project] = projectEntries[projIdx - 1];
      projectKey = key;
      projectDir = project.path;
      projectBranch = project.branch;
      sessionName = key;
    } else {
      // 非数字输入：先查项目名，再当路径
      const key = projInput;
      if (projects[key]) {
        projectKey = key;
        projectDir = projects[key].path;
        projectBranch = projects[key].branch;
        sessionName = key;
      } else {
        const resolved = expandHomePath(projInput);
        if (existsSync(resolved)) {
          projectDir = resolved;
          projectKey = basename(resolved) || "project";
          sessionName = projectKey;
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

    // --- 目标分支 ---
    const suffix = projectBranch ? `，留空使用配置中的 ${projectBranch}` : "，留空自动探测默认分支 (通常是 master 或 main)";
    console.log(`\n输入 worktree 的目标分支${suffix}`);
    const branchInput = (await prompt(rl, `目标分支: `)).trim();
    const branch = branchInput || projectBranch;

    console.log();
    return { aiCmd, projectDir, sessionName: sessionName.slice(0, SESSION_NAME_MAX_LEN), projectKey, branch };
  } finally {
    rl.close();
  }
}

function parseArgs(projects: Record<string, ProjectConfig>): RunParams {
  // 提取 --branch / -b <name> flag，支持出现在任意位置
  const argv = process.argv.slice(2);
  let branch: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch" || a === "-b") {
      branch = argv[++i];
    } else if (a.startsWith("--branch=")) {
      branch = a.slice("--branch=".length);
    } else {
      positional.push(a);
    }
  }
  const [aiCmd, project, sessionArg] = positional;

  if (!aiCmd || !project) {
    console.log(`用法: tw <ai-command> <project|path> [session-name] [--branch <name>]

参数:
  ai-command       要在 session 中运行的命令 (如 claude, aider, codex)
  project          项目名称 (${Object.keys(projects).join(", ")}) 或 Git 仓库路径
  session-name     可选，tmux session 显示名 (默认同 project)
  --branch, -b     可选，目标分支 (默认自动探测，通常是 master 或 main)

示例:
  tw claude myproject
  tw claude myproject fix-auth-bug
  tw claude myproject fix-auth-bug --branch develop
  tw claude ~/src/some-repo
  tw                           # 交互模式`);
    process.exit(1);
  }

  const mappedProject = projects[project];
  if (mappedProject) {
    // 项目在映射中
    const sessionName = sessionArg ? `${project}-${sessionArg}`.slice(0, SESSION_NAME_MAX_LEN) : project;
    return {
      aiCmd,
      projectDir: mappedProject.path,
      sessionName,
      projectKey: project,
      branch: branch ?? mappedProject.branch,
    };
  }

  // 不在映射中，当作未配置的本地 git 仓库路径。路径入口与
  // Dashboard/RPC 一样始终创建 managed worktree，不再退化为普通 tmux session。
  const resolved = expandHomePath(project);
  if (existsSync(resolved)) {
    const projectKey = basename(resolved) || "project";
    const sessionName = (sessionArg ? `${projectKey}-${sessionArg}` : projectKey)
      .slice(0, SESSION_NAME_MAX_LEN);
    return { aiCmd, projectDir: resolved, sessionName, projectKey, branch };
  }

  console.error(`错误: 未知项目 '${project}'，且路径不存在`);
  console.error(`可用项目: ${Object.keys(projects).join(", ")}`);
  process.exit(1);
}

export async function run() {
  const hasArgs = process.argv.length > 2;
  // An explicit repository path does not require pre-existing project config.
  // Keep the setup wizard for the no-argument interactive flow only.
  const config = hasArgs
    ? loadConfigFile() ?? normalizeConfig({})
    : await loadConfig();
  const PROJECT_DIRS = config.projects;
  const WORKTREE_BASE = resolveWorktreeBase(config.worktreeBase);

  // --- 参数解析 ---
  const params = hasArgs ? parseArgs(PROJECT_DIRS) : await interactiveSelect(PROJECT_DIRS);
  const { aiCmd, projectDir, projectKey, branch } = params;

  if (!existsSync(projectDir)) {
    throw new CliError(`目录不存在: ${projectDir}`);
  }
  if (!isGitRepo(projectDir)) {
    throw new CliError(
      `目录不是 git 仓库: ${projectDir}\n` +
      "`tw <ai-command> <project|path>` 只创建 managed git worktree；请传入 git 仓库路径。",
    );
  }

  const created = createManagedWorktreeSession({
    aiCmd,
    projectDir,
    sessionName: params.sessionName,
    useWorktree: true,
    projectKey,
    branch,
    worktreeBase: WORKTREE_BASE,
    profile: "cli",
  });
  const session = created.session;
  const tmux = tmuxBin();

  // 连接：如果已在 tmux 中则 switch-client，否则 attach
  console.log(`✅ 环境就绪，正在连接 tmux session "${session}"...`);
  if (insideTmux()) {
    exec(tmux, ["switch-client", "-t", session]);
  } else {
    const child = spawn(tmux, ["attach", "-t", session], { stdio: "inherit" });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });
    process.exitCode = exitCode;
  }
}
