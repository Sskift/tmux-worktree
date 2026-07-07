import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { CliError } from "./tmux.js";
import {
  isSafeRelayPath,
  isValidHostId,
  parseJsonMessage,
  sendJson,
  type RelayHostMessage,
  type RelayHostInfo,
  type RelayToClientMessage,
  type RelayToHostMessage,
} from "./relayProtocol.js";

type RelayServerOptions = {
  host: string;
  port: number;
  secret: string;
};

type HostConnection = {
  hostId: string;
  displayName?: string;
  socket: WebSocket;
  connectedAt: number;
};

type ClientConnection = {
  clientId: string;
  defaultHostId?: string;
  socket: WebSocket;
  connectedAt: number;
  streams: Map<string, string>;
};

type RelaySocket = WebSocket & {
  isAlive?: boolean;
};

function parseArgs(argv: string[]): RelayServerOptions {
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
      printHelp();
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

function printHelp(): void {
  console.log(`tw relay-server — experimental remote relay

用法:
  TW_RELAY_SECRET=<secret> tw relay-server [--host 0.0.0.0] [--port 8787]

说明:
  relay-server 跑在一台稳定可达的 broker 机器上，只负责转发已鉴权 host 和 client 的 WebSocket 消息。
  Dashboard 所在机器运行 tw relay-host 主动连接 relay，不需要把本机端口暴露到公网。`);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function requestSecret(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return url.searchParams.get("secret") || "";
}

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function hostInfos(hosts: Map<string, HostConnection>, clients: Map<string, ClientConnection>): RelayHostInfo[] {
  return [...hosts.values()].map((host) => ({
    hostId: host.hostId,
    displayName: host.displayName,
    connectedAt: host.connectedAt,
    clients: [...clients.values()].filter((client) =>
      client.defaultHostId === host.hostId || [...client.streams.values()].includes(host.hostId)
    ).length,
  }));
}

function getMessageHostId(message: RelayToHostMessage, client: ClientConnection): string | undefined {
  if ("hostId" in message && typeof message.hostId === "string" && message.hostId) {
    return message.hostId;
  }
  if ("streamId" in message && typeof message.streamId === "string") {
    return client.streams.get(message.streamId) || client.defaultHostId;
  }
  return client.defaultHostId;
}

function messageRequestId(message: RelayToHostMessage): string | undefined {
  return "requestId" in message ? message.requestId : undefined;
}

function messageStreamId(message: RelayToHostMessage): string | undefined {
  return "streamId" in message ? message.streamId : undefined;
}

export async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(3));
  const hosts = new Map<string, HostConnection>();
  const clients = new Map<string, ClientConnection>();

  function dropHostStreams(hostId: string, reason: string): void {
    for (const client of clients.values()) {
      for (const [streamId, streamHostId] of [...client.streams]) {
        if (streamHostId !== hostId) continue;
        client.streams.delete(streamId);
        if (isOpen(client.socket)) {
          sendJson(client.socket, { type: "error", streamId, message: reason });
          sendJson(client.socket, { type: "terminal_exit", streamId, code: 0 });
        }
      }
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      writeJson(res, {
        ok: true,
        hosts: hostInfos(hosts, clients),
      });
      return;
    }

    if (url.pathname === "/api/hosts") {
      const provided = requestSecret(req, url);
      if (!constantTimeEqual(provided, opts.secret)) {
        writeJson(res, { ok: false, error: "unauthorized" }, 401);
        return;
      }
      writeJson(res, {
        ok: true,
        hosts: hostInfos(hosts, clients),
      });
      return;
    }

    writeJson(res, { ok: false, error: "not found" }, 404);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!isSafeRelayPath(url.pathname)) {
      socket.destroy();
      return;
    }
    const provided = requestSecret(req, url);
    if (!constantTimeEqual(provided, opts.secret)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const liveSocket = socket as RelaySocket;
    liveSocket.isAlive = true;
    liveSocket.on("pong", () => {
      liveSocket.isAlive = true;
    });

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/host") {
      const hostId = url.searchParams.get("hostId") || "";
      if (!isValidHostId(hostId)) {
        sendJson(socket, { type: "error", message: "invalid hostId" });
        socket.close(4000, "invalid hostId");
        return;
      }
      const previous = hosts.get(hostId);
      if (previous && isOpen(previous.socket)) {
        dropHostStreams(hostId, "host reconnected; terminal stream closed");
        previous.socket.close(4002, "host replaced");
      }
      const host: HostConnection = { hostId, socket, connectedAt: Date.now() };
      hosts.set(hostId, host);
      console.log(`[relay] host connected: ${hostId}`);
      sendJson(socket, { type: "host_registered", hostId });

      socket.on("message", (raw) => {
        let message: RelayHostMessage;
        try {
          message = parseJsonMessage(raw) as RelayHostMessage;
        } catch {
          return;
        }
        if (message.type === "host_ready") {
          const current = hosts.get(hostId);
          if (current) current.displayName = message.displayName;
          return;
        }
        const clientId = "clientId" in message ? message.clientId : undefined;
        if (!clientId) return;
        const client = clients.get(clientId);
        if (!client || !isOpen(client.socket)) return;
        const outbound = { ...message };
        delete (outbound as Partial<RelayHostMessage>).clientId;
        sendJson(client.socket, outbound satisfies RelayToClientMessage);
      });

      socket.on("close", () => {
        if (hosts.get(hostId)?.socket === socket) {
          hosts.delete(hostId);
          dropHostStreams(hostId, "host disconnected");
        }
        console.log(`[relay] host disconnected: ${hostId}`);
      });
      return;
    }

    if (url.pathname === "/client") {
      const queryHostId = url.searchParams.get("hostId") || "";
      if (queryHostId && !isValidHostId(queryHostId)) {
        sendJson(socket, { type: "error", message: "invalid hostId" });
        socket.close(4000, "invalid hostId");
        return;
      }
      const clientId = randomUUID();
      const client: ClientConnection = {
        clientId,
        defaultHostId: queryHostId || undefined,
        socket,
        connectedAt: Date.now(),
        streams: new Map(),
      };
      clients.set(clientId, client);
      sendJson(socket, { type: "ready", clientId, hostId: client.defaultHostId });
      console.log(`[relay] client connected: ${clientId}${client.defaultHostId ? ` -> ${client.defaultHostId}` : ""}`);
      if (client.defaultHostId && !hosts.has(client.defaultHostId)) {
        sendJson(socket, { type: "error", message: "host is not connected" });
      }

      socket.on("message", (raw) => {
        let message: RelayToHostMessage;
        try {
          message = { ...(parseJsonMessage(raw) as object), clientId } as RelayToHostMessage;
        } catch {
          sendJson(socket, { type: "error", message: "invalid json" });
          return;
        }
        if (message.type === "list_hosts") {
          sendJson(socket, { type: "hosts", requestId: message.requestId, hosts: hostInfos(hosts, clients) });
          return;
        }
        const targetHostId = getMessageHostId(message, client);
        if (!targetHostId || !isValidHostId(targetHostId)) {
          sendJson(socket, { type: "error", requestId: "requestId" in message ? message.requestId : undefined, message: "missing or invalid hostId" });
          return;
        }
        if (message.type === "open_terminal") {
          client.streams.set(message.streamId, targetHostId);
        }
        const currentHost = hosts.get(targetHostId);
        if (!currentHost || !isOpen(currentHost.socket)) {
          if (message.type === "open_terminal") {
            client.streams.delete(message.streamId);
          }
          sendJson(socket, {
            type: "error",
            requestId: messageRequestId(message),
            streamId: messageStreamId(message),
            message: "host is not connected",
          });
          return;
        }
        sendJson(currentHost.socket, message);
        if (message.type === "close_terminal") {
          client.streams.delete(message.streamId);
        }
      });

      socket.on("close", () => {
        clients.delete(clientId);
        for (const hostId of new Set(client.streams.values())) {
          const currentHost = hosts.get(hostId);
          if (currentHost && isOpen(currentHost.socket)) {
            sendJson(currentHost.socket, { type: "client_closed", clientId });
          }
        }
        if (client.defaultHostId && !client.streams.size) {
          const currentHost = hosts.get(client.defaultHostId);
          if (currentHost && isOpen(currentHost.socket)) {
            sendJson(currentHost.socket, { type: "client_closed", clientId });
          }
        }
        console.log(`[relay] client disconnected: ${clientId}`);
      });
    }
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      const liveWs = ws as RelaySocket;
      if (liveWs.isAlive === false) {
        liveWs.terminate();
        continue;
      }
      if (liveWs.readyState === WebSocket.OPEN) {
        liveWs.isAlive = false;
        liveWs.ping();
      }
    }
  }, 30_000);
  server.on("close", () => clearInterval(ping));

  await new Promise<void>((resolve) => {
    server.listen(opts.port, opts.host, resolve);
  });
  console.log(`[relay] listening on http://${opts.host}:${opts.port}`);
  console.log(`[relay] health: http://${opts.host}:${opts.port}/health`);
}
