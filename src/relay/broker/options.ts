import { CliError } from "../../tmux.js";

export type RelayServerOptions = {
  host: string;
  port: number;
  secret: string;
};

export function parseRelayServerOptions(argv: string[]): RelayServerOptions {
  let host = "0.0.0.0";
  let port = 8787;
  let secret = process.env.TW_RELAY_SECRET || "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
      host = argv[++i] || host;
    } else if (arg === "--port") {
      port = Number(argv[++i] || port);
    } else if (arg === "--secret") {
      secret = argv[++i] || "";
    } else if (arg === "-h" || arg === "--help") {
      printRelayServerHelp();
      process.exit(0);
    } else {
      throw new CliError(`未知 relay-server 参数: ${arg}`);
    }
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

说明:
  relay-server 跑在一台稳定可达的 broker 机器上，只负责转发已鉴权 host 和 client 的 WebSocket 消息。
  Dashboard 所在机器运行 tw relay-host 主动连接 relay，不需要把本机端口暴露到公网。`);
}
