import { CliError } from "../../tmux.js";
import { isRelayV2AuthIdentifier } from "../v2/token.js";

export type RelayServerOptions = {
  host: string;
  port: number;
  secret: string;
  v2ProfilePath?: string;
  v2LocalDevelopment?: true;
  v2SingleNodeSelfHosted?: true;
  v2LocalDevelopmentTlsKeyPath?: string;
  v2LocalDevelopmentTlsCertificatePath?: string;
  v2LocalDevelopmentAdvertisedOrigin?: string;
  v2SingleNodeSelfHostedStateDirectory?: string;
  v2HostBootstrapOutputPath?: string;
  v2SingleNodeSelfHostedBootstrapCorrelation?: string;
};

export function parseRelayServerOptions(argv: string[]): RelayServerOptions {
  let host = "0.0.0.0";
  let port = 8787;
  let secret = "";
  let secretFlag = false;
  let hostFlag = false;
  let portFlag = false;
  let v2ProfilePath: string | undefined;
  let v2LocalDevelopment = false;
  let v2SingleNodeSelfHosted = false;
  let v2LocalDevelopmentTlsKeyPath: string | undefined;
  let v2LocalDevelopmentTlsCertificatePath: string | undefined;
  let v2LocalDevelopmentAdvertisedOrigin: string | undefined;
  let v2SingleNodeSelfHostedStateDirectory: string | undefined;
  let v2HostBootstrapOutputPath: string | undefined;
  let v2SingleNodeSelfHostedBootstrapCorrelation: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
      host = argv[++i] || host;
      hostFlag = true;
    } else if (arg === "--port") {
      port = Number(argv[++i] || port);
      portFlag = true;
    } else if (arg === "--secret") {
      secret = argv[++i] || "";
      secretFlag = true;
    } else if (arg === "--v2-profile") {
      v2ProfilePath = argv[++i] || "";
    } else if (arg === "--v2-local-dev") {
      if (v2LocalDevelopment) {
        throw new CliError("relay-server --v2-local-dev 只能指定一次");
      }
      v2LocalDevelopment = true;
    } else if (arg === "--v2-single-node-self-hosted") {
      if (v2SingleNodeSelfHosted) {
        throw new CliError(
          "relay-server --v2-single-node-self-hosted 只能指定一次",
        );
      }
      v2SingleNodeSelfHosted = true;
    } else if (arg === "--v2-dev-tls-key") {
      if (v2LocalDevelopmentTlsKeyPath !== undefined) {
        throw new CliError("relay-server --v2-dev-tls-key 只能指定一次");
      }
      v2LocalDevelopmentTlsKeyPath = argv[++i] || "";
    } else if (arg === "--v2-dev-tls-cert") {
      if (v2LocalDevelopmentTlsCertificatePath !== undefined) {
        throw new CliError("relay-server --v2-dev-tls-cert 只能指定一次");
      }
      v2LocalDevelopmentTlsCertificatePath = argv[++i] || "";
    } else if (arg === "--v2-dev-advertised-origin") {
      if (v2LocalDevelopmentAdvertisedOrigin !== undefined) {
        throw new CliError("relay-server --v2-dev-advertised-origin 只能指定一次");
      }
      v2LocalDevelopmentAdvertisedOrigin = argv[++i] || "";
    } else if (arg === "--v2-self-hosted-state-dir") {
      if (v2SingleNodeSelfHostedStateDirectory !== undefined) {
        throw new CliError(
          "relay-server --v2-self-hosted-state-dir 只能指定一次",
        );
      }
      v2SingleNodeSelfHostedStateDirectory = argv[++i] || "";
    } else if (arg === "--host-bootstrap-output") {
      if (v2HostBootstrapOutputPath !== undefined) {
        throw new CliError("relay-server --host-bootstrap-output 只能指定一次");
      }
      v2HostBootstrapOutputPath = argv[++i] || "";
    } else if (arg === "--v2-self-hosted-bootstrap-correlation") {
      if (v2SingleNodeSelfHostedBootstrapCorrelation !== undefined) {
        throw new CliError(
          "relay-server --v2-self-hosted-bootstrap-correlation 只能指定一次",
        );
      }
      v2SingleNodeSelfHostedBootstrapCorrelation = argv[++i] || "";
    } else if (arg === "-h" || arg === "--help") {
      printRelayServerHelp();
      process.exit(0);
    } else {
      throw new CliError(`未知 relay-server 参数: ${arg}`);
    }
  }

  const explicitV2LaneCount = Number(v2ProfilePath !== undefined)
    + Number(v2LocalDevelopment)
    + Number(v2SingleNodeSelfHosted);
  if (explicitV2LaneCount > 1) {
    throw new CliError(
      "relay-server --v2-profile、--v2-local-dev 与 "
        + "--v2-single-node-self-hosted 不能同时使用",
    );
  }

  if (v2ProfilePath !== undefined) {
    if (v2ProfilePath === "") {
      throw new CliError("relay-server --v2-profile 需要非空 profile 路径");
    }
    if (secretFlag) {
      throw new CliError("relay-server --v2-profile 不能与 --secret 同时使用");
    }
    if (hostFlag || portFlag) {
      throw new CliError("relay-server --v2-profile 的监听地址只来自 profile，不能与 --host/--port 同时使用");
    }
    if (v2LocalDevelopmentTlsKeyPath !== undefined
      || v2LocalDevelopmentTlsCertificatePath !== undefined) {
      throw new CliError(
        "relay-server --v2-dev-tls-key/--v2-dev-tls-cert "
          + "只适用于显式 v2 开发 lane",
      );
    }
    if (v2LocalDevelopmentAdvertisedOrigin !== undefined) {
      throw new CliError(
        "relay-server --v2-dev-advertised-origin 只适用于显式 v2 开发 lane",
      );
    }
    if (v2SingleNodeSelfHostedStateDirectory !== undefined) {
      throw new CliError(
        "relay-server --v2-self-hosted-state-dir "
          + "只适用于 --v2-single-node-self-hosted",
      );
    }
    if (v2SingleNodeSelfHostedBootstrapCorrelation !== undefined) {
      throw new CliError(
        "relay-server --v2-self-hosted-bootstrap-correlation "
          + "只适用于 --v2-single-node-self-hosted",
      );
    }
    if (v2HostBootstrapOutputPath === "") {
      throw new CliError("relay-server --host-bootstrap-output 需要非空输出路径");
    }
    // 显式 v2 profile 模式：监听/凭证/continuity 只来自 profile 与 trusted
    // deployment source；v1 shared secret 在该模式下不被读取或使用（env
    // TW_RELAY_SECRET 也不读取），也绝不回退 v1。
    return { host, port, secret: "", v2ProfilePath, v2HostBootstrapOutputPath };
  }

  if (v2LocalDevelopment) {
    if (secretFlag) {
      throw new CliError("relay-server --v2-local-dev 不能与 --secret 同时使用");
    }
    if (hostFlag) {
      throw new CliError("relay-server --v2-local-dev 固定监听 127.0.0.1，不能指定 --host");
    }
    if (!portFlag) {
      throw new CliError("relay-server --v2-local-dev 需要显式 --port");
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new CliError(`无效端口: ${port}`);
    }
    if (!v2LocalDevelopmentTlsKeyPath) {
      throw new CliError("relay-server --v2-local-dev 需要 --v2-dev-tls-key");
    }
    if (!v2LocalDevelopmentTlsCertificatePath) {
      throw new CliError("relay-server --v2-local-dev 需要 --v2-dev-tls-cert");
    }
    if (v2LocalDevelopmentAdvertisedOrigin === "") {
      throw new CliError("relay-server --v2-dev-advertised-origin 需要非空 HTTPS origin");
    }
    if (!v2HostBootstrapOutputPath) {
      throw new CliError("relay-server --v2-local-dev 需要 --host-bootstrap-output");
    }
    if (v2SingleNodeSelfHostedBootstrapCorrelation !== undefined) {
      throw new CliError(
        "relay-server --v2-self-hosted-bootstrap-correlation "
          + "只适用于 --v2-single-node-self-hosted",
      );
    }
    return {
      host: "127.0.0.1",
      port,
      secret: "",
      v2LocalDevelopment: true,
      v2LocalDevelopmentTlsKeyPath,
      v2LocalDevelopmentTlsCertificatePath,
      v2LocalDevelopmentAdvertisedOrigin,
      v2HostBootstrapOutputPath,
    };
  }

  if (v2SingleNodeSelfHosted) {
    if (secretFlag) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted 不能与 --secret 同时使用",
      );
    }
    if (!hostFlag || !host) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted 需要显式 --host",
      );
    }
    if (!portFlag) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted 需要显式 --port",
      );
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new CliError(`无效端口: ${port}`);
    }
    if (!v2LocalDevelopmentTlsKeyPath) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted 需要 --v2-dev-tls-key",
      );
    }
    if (!v2LocalDevelopmentTlsCertificatePath) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted 需要 --v2-dev-tls-cert",
      );
    }
    if (!v2LocalDevelopmentAdvertisedOrigin) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted "
          + "需要 --v2-dev-advertised-origin",
      );
    }
    if (!v2SingleNodeSelfHostedStateDirectory) {
      throw new CliError(
        "relay-server --v2-single-node-self-hosted "
          + "需要 --v2-self-hosted-state-dir",
      );
    }
    if (v2HostBootstrapOutputPath === "") {
      throw new CliError(
        "relay-server --host-bootstrap-output 需要非空输出路径",
      );
    }
    if (
      v2SingleNodeSelfHostedBootstrapCorrelation !== undefined
      && !isRelayV2AuthIdentifier(v2SingleNodeSelfHostedBootstrapCorrelation)
    ) {
      throw new CliError(
        "relay-server --v2-self-hosted-bootstrap-correlation "
          + "需要有效的非敏感 attempt identifier",
      );
    }
    if (
      v2SingleNodeSelfHostedBootstrapCorrelation !== undefined
      && v2HostBootstrapOutputPath === undefined
    ) {
      throw new CliError(
        "relay-server --v2-self-hosted-bootstrap-correlation "
          + "必须与 --host-bootstrap-output 同时使用",
      );
    }
    return {
      host,
      port,
      secret: "",
      v2SingleNodeSelfHosted: true,
      v2LocalDevelopmentTlsKeyPath,
      v2LocalDevelopmentTlsCertificatePath,
      v2LocalDevelopmentAdvertisedOrigin,
      v2SingleNodeSelfHostedStateDirectory,
      v2HostBootstrapOutputPath,
      v2SingleNodeSelfHostedBootstrapCorrelation,
    };
  }

  if (v2LocalDevelopmentTlsKeyPath !== undefined
    || v2LocalDevelopmentTlsCertificatePath !== undefined) {
    throw new CliError(
      "relay-server --v2-dev-tls-key/--v2-dev-tls-cert "
        + "只适用于显式 v2 开发 lane",
    );
  }
  if (v2LocalDevelopmentAdvertisedOrigin !== undefined) {
    throw new CliError(
      "relay-server --v2-dev-advertised-origin 只适用于显式 v2 开发 lane",
    );
  }
  if (v2SingleNodeSelfHostedStateDirectory !== undefined) {
    throw new CliError(
      "relay-server --v2-self-hosted-state-dir "
        + "只适用于 --v2-single-node-self-hosted",
    );
  }
  if (v2HostBootstrapOutputPath !== undefined) {
    throw new CliError(
      "relay-server --host-bootstrap-output 只适用于显式 v2 lane",
    );
  }
  if (v2SingleNodeSelfHostedBootstrapCorrelation !== undefined) {
    throw new CliError(
      "relay-server --v2-self-hosted-bootstrap-correlation "
        + "只适用于 --v2-single-node-self-hosted",
    );
  }

  // 仅 v1 分支读取 env：--secret 优先，缺省回落 TW_RELAY_SECRET。
  if (!secretFlag) {
    secret = process.env.TW_RELAY_SECRET || "";
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
  tw relay-server --v2-profile <path> [--host-bootstrap-output <path>]
  tw relay-server --v2-local-dev --port <1-65535> --v2-dev-tls-key <path>
    --v2-dev-tls-cert <path> [--v2-dev-advertised-origin <https-origin>]
    --host-bootstrap-output <path>
  tw relay-server --v2-single-node-self-hosted --host <listen-host>
    --port <1-65535> --v2-dev-advertised-origin <https-origin>
    --v2-dev-tls-key <path> --v2-dev-tls-cert <path>
    --v2-self-hosted-state-dir <path> [--host-bootstrap-output <path>]

说明:
  relay-server 跑在一台稳定可达的 broker 机器上，只负责转发已鉴权 host 和 client 的 WebSocket 消息。
  Dashboard 所在机器运行 tw relay-host 主动连接 relay，不需要把本机端口暴露到公网。
  --v2-profile 选择显式 default-off Relay v2 shipping：profile 只保存非敏感
  reference/path；TLS/issuer keyring/E0 material 只来自 trustedHome 下固定
  namespace 的 0600 私有 deployment 文件，缺失或 unsafe 时在监听前 fail
  closed，绝不回退 v1。
  --v2-local-dev 是严格 loopback-only、进程内且不持久的本机开发 lane；
  要求显式非零端口并固定监听 127.0.0.1，复用 canonical v2
  shipping/composition，绝不构成 production qualification/readiness，也不
  改变 --v2-profile 的 fail-closed。
  --v2-single-node-self-hosted 是明确非 production、仅 Linux x64 Node
  >=22.16 的单进程持久自托管 lane。它要求显式 listen host/port 与独立
  advertised HTTPS origin；唯一 0600 SQLite owner 持久化 credential、
  co-located continuity 与稳定 issuer keyring。该 continuity 不是 E0，
  不产生 production qualification/readiness，且绝不回退 v1。
  self-hosted state dir 必须是现存 canonical、当前用户拥有的 exact 0700
  dedicated 目录；绑定 machine-id 与目录 identity，禁止复制目录、恢复旧
  快照、并行启动或修改 DB，且不提供 override/import/recovery。
  --v2-dev-advertised-origin 改变显式开发 lane 下发的 HTTPS/WSS endpoint
  identity；local-dev 省略时保持 localhost，self-hosted 必须显式提供。
  外部 TLS/TCP proxy 不由 relay-server 管理。
  TLS key/cert 必须是当前用户拥有、single-link、exact 0600 的本机文件。
  --host-bootstrap-output 仅适用于显式 v2 lane；shipping root 启动后通过本进程
  privileged admin authority 创建一次 Host bootstrap，并只原子写入指定的 0600
  文件。token 不写入 argv、URL、日志或 stdout。`);
}
