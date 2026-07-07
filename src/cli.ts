#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./tmux";

// ============================================
// cli.ts — tw 命令路由
//
// 子命令分发到各模块。未知子命令给出友好提示而非静默进入 dev 模式。
// 顶层统一捕获 CliError，只打印 message，不吐 stack trace。
// ============================================

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  console.log(`tw — tmux + git worktree + AI 开发环境管理器  (v${readVersion()})

用法:
  tw <ai-command> <project|path> [session] [--branch <name>]
                              创建 worktree + tmux session 并进入
  tw                          交互模式创建

会话 (session):
  tw ls                       列出所有 session（项目、分支、worktree、是否在用）
  tw attach <session>         接入 / 切换到已有 session（别名: tw a）
  tw rm <session> [--worktree]  杀掉 session，加 --worktree 连带删除其 worktree
  tw status                   左栏 session 列表 TUI（含 --once 单次输出）

Worktree:
  tw worktree ls              列出所有 worktree（跨项目，标记孤儿）
  tw worktree rm <name|path> [--force]   删除某个 worktree 及其分支
  tw worktree prune [--dry-run] [--force]  清理无对应 session 的孤儿 worktree

RPC:
  tw rpc list                 输出 TW 管理的 session/worktree JSON
  tw rpc create-worktree (--path <path> | --project <name>) --ai-command <cmd> [--name <name>] [--branch <name>]
                              创建 Dashboard-managed worktree session 并登记到 TW state
  tw rpc capabilities         输出 Dashboard 可消费的协议能力 JSON

Automation:
  tw automation ls            列出 Dashboard 可见的 automation（别名: tw auto ls）
  tw automation create --instruction <text> [--name <name>] [--cmd <ai-cmd>]
                              [--project <name> | --path <path>] [--schedule <cron>]
                              [--timezone <tz>] [--overlap skip|queue] [--disabled]
  tw automation rm <id|name>  删除 automation（别名: delete；create 别名: add/new）

其它:
  tw serve [--port N]         启动网页终端（手机可访问）
  tw setup                    安装 / 配置向导
  tw doctor                   检查 tmux/git/node/cloudflared 与配置是否就绪
  tw update                   更新 tw CLI 和 tw-dashboard
  tw version | -v             显示版本
  tw help | -h                显示本帮助

示例:
  tw claude myproject fix-auth-bug
  tw claude myproject fix-auth-bug --branch develop
  tw ls
  tw worktree prune --dry-run
  tw automation create --name nightly --instruction "review open changes" --project myproject
  tw rm myproject-fix-auth --worktree`);
}

async function main() {
  const sub = process.argv[2];

  switch (sub) {
    case "-v":
    case "--version":
    case "version":
      console.log(readVersion());
      return;

    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;

    case "status": {
      const { run } = await import("./status.js");
      await run();
      return;
    }
    case "serve": {
      const { run } = await import("./serve.js");
      await run();
      return;
    }
    case "setup": {
      const { run } = await import("./setup.js");
      await run();
      return;
    }
    case "ls": {
      const { listCmd } = await import("./commands.js");
      await listCmd();
      return;
    }
    case "attach":
    case "a": {
      const { attachCmd } = await import("./commands.js");
      await attachCmd(process.argv.slice(3));
      return;
    }
    case "rm": {
      const { rmSessionCmd } = await import("./commands.js");
      await rmSessionCmd(process.argv.slice(3));
      return;
    }
    case "worktree":
    case "wt": {
      const { worktreeCmd } = await import("./commands.js");
      await worktreeCmd(process.argv.slice(3));
      return;
    }
    case "rpc": {
      const { rpcCmd } = await import("./rpc.js");
      await rpcCmd(process.argv.slice(3));
      return;
    }
    case "automation":
    case "auto": {
      const { automationCmd } = await import("./automation.js");
      await automationCmd(process.argv.slice(3));
      return;
    }
    case "doctor": {
      const { doctorCmd } = await import("./commands.js");
      await doctorCmd();
      return;
    }
    case "update": {
      const { run } = await import("./update.js");
      await run();
      return;
    }
    default: {
      // 未知的、以 - 开头或看起来像内部子命令拼错的，给提示
      if (sub && sub.startsWith("-")) {
        console.error(`未知选项: ${sub}\n`);
        printHelp();
        process.exit(1);
      }
      // 否则视为 dev 模式：tw <ai-command> <project> ...
      const { run } = await import("./dev.js");
      await run();
      return;
    }
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(`错误: ${err.message}`);
  } else {
    console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
