import { spawnSync } from "node:child_process";
import { CliError } from "./tmux";

const PACKAGE_NAME = "tmux-worktree";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

type UpdateOptions = {
  dryRun: boolean;
  registry: string;
  cliOnly: boolean;
  dashboardOnly: boolean;
};

function printHelp(): void {
  console.log(`tw update — 更新 tw CLI 和 tw-dashboard

用法:
  tw update [--dry-run] [--registry <url>] [--cli-only | --dashboard-only]

默认执行:
  npm i -g ${PACKAGE_NAME}@latest --registry=${DEFAULT_REGISTRY}
  tw-dashboard-install`);
}

function parseArgs(args: string[]): UpdateOptions {
  const opts: UpdateOptions = {
    dryRun: false,
    registry: process.env.TW_UPDATE_REGISTRY || DEFAULT_REGISTRY,
    cliOnly: false,
    dashboardOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "-n" || arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--cli-only") {
      opts.cliOnly = true;
      continue;
    }
    if (arg === "--dashboard-only") {
      opts.dashboardOnly = true;
      continue;
    }
    if (arg === "--registry") {
      const value = args[++i];
      if (!value) throw new CliError("缺少 --registry 参数值");
      opts.registry = value;
      continue;
    }
    if (arg.startsWith("--registry=")) {
      opts.registry = arg.slice("--registry=".length);
      if (!opts.registry) throw new CliError("缺少 --registry 参数值");
      continue;
    }
    throw new CliError(`未知 update 选项: ${arg}`);
  }

  if (opts.cliOnly && opts.dashboardOnly) {
    throw new CliError("--cli-only 和 --dashboard-only 不能同时使用");
  }
  return opts;
}

function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

function runCommand(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) {
    throw new CliError(`命令启动失败: ${cmd}\n  ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CliError(`命令失败: ${commandLine(cmd, args)}`);
  }
}

export async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(3));
  const npmArgs = ["i", "-g", `${PACKAGE_NAME}@latest`, `--registry=${opts.registry}`];
  const installerCmd = "tw-dashboard-install";

  if (opts.dryRun) {
    if (!opts.dashboardOnly) console.log(commandLine("npm", npmArgs));
    if (!opts.cliOnly) console.log(installerCmd);
    return;
  }

  if (!opts.dashboardOnly) {
    console.log(C.dim(`更新 CLI: ${commandLine("npm", npmArgs)}`));
    runCommand("npm", npmArgs);
  }

  if (!opts.cliOnly) {
    if (process.platform !== "darwin") {
      if (opts.dashboardOnly) {
        throw new CliError(`tw-dashboard 只支持 macOS，当前平台: ${process.platform}`);
      }
      console.log(C.yellow(`跳过 Dashboard：tw-dashboard 只支持 macOS，当前平台 ${process.platform}`));
    } else {
      console.log(C.dim(`安装 Dashboard: ${installerCmd}`));
      runCommand(installerCmd, []);
    }
  }

  console.log(C.green("✓ update 完成"));
}
