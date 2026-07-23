import { CliError } from "../../tmux.js";

export type RelayServerOptions = {
  host: string;
  port: number;
  secret: string;
  v2ProfilePath?: string;
};

export function parseRelayServerOptions(argv: string[]): RelayServerOptions {
  let host = "0.0.0.0";
  let port = 8787;
  let secret = process.env.TW_RELAY_SECRET || "";
  let secretFlag = false;
  let listenFlag = false;
  let v2ProfilePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
      host = argv[++i] || host;
      listenFlag = true;
    } else if (arg === "--port") {
      port = Number(argv[++i] || port);
      listenFlag = true;
    } else if (arg === "--secret") {
      secret = argv[++i] || "";
      secretFlag = true;
    } else if (arg === "--v2-profile") {
      v2ProfilePath = argv[++i] || "";
    } else if (arg === "-h" || arg === "--help") {
      printRelayServerHelp();
      process.exit(0);
    } else {
      throw new CliError(`未知 relay-server 参数: ${arg}`);
    }
  }

  if (v2ProfilePath !== undefined) {
    if (v2ProfilePath === "") {
      throw new CliError("relay-server --v2-profile 需要非空 profile 路径");
    }
    if (secretFlag) {
      throw new CliError("relay-server --v2-profile 不能与 --secret 同时使用");
    }
    if (listenFlag) {
      throw new CliError("relay-server --v2-profile 的监听地址只来自 profile，不能与 --host/--port 同时使用");
    }
    // 显式 v2 profile 模式：监听/凭证/continuity 只来自 profile 与 deployment
    // 注入；v1 shared secret 在该模式下不被读取或使用，也绝不回退 v1。
    return { host, port, secret: "", v2ProfilePath };
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new CliError(`无效端口: ${port}`);
  }
  if (!secret) {
    throw new CliError("relay-server 需要 --secret 或 TW_RELAY_SECRET，避免暴露未鉴权的终端转发服务");
  }

  return { host, port, secret };
}

function printRelayServerHelp(): void {
  console.log(`tw relay-server — experimental remote relay

用法:
  TW_RELAY_SECRET=<secret> tw relay-server [--host 0.0.0.0] [--port 8787]
  tw relay-server --v2-profile <path>

说明:
  relay-server 跑在一台稳定可达的 broker 机器上，只负责转发已鉴权 host 和 client 的 WebSocket 消息。
  Dashboard 所在机器运行 tw relay-host 主动连接 relay，不需要把本机端口暴露到公网。
  --v2-profile 选择显式 default-off Relay v2 shipping：profile 只保存非敏感
  reference/path；缺少 deployment 注入的 privileged resolver / external
  continuity attempt provider 时在监听前 fail closed，绝不回退 v1。`);
}
