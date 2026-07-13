import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  type RelayHostMessage,
  type RelayHostInfo,
  type RelayToClientMessage,
  type RelayToHostMessage,
} from "../v1/messages.js";
import {
  isSafeRelayPath,
  isValidHostId,
  parseJsonMessage,
} from "../v1/wire.js";
import type { RelayServerOptions } from "./options.js";

type HostConnection = {
  hostId: string;
  connectorId: string;
  active: boolean;
  displayName?: string;
  socket: WebSocket;
  connectedAt: number;
};

type StreamBinding = {
  hostId: string;
  connectorId: string;
  routeId: string;
};

type ClientConnection = {
  clientId: string;
  defaultHostId?: string;
  socket: WebSocket;
  connectedAt: number;
  streams: Map<string, StreamBinding>;
  retiredStreams: Set<string>;
};

type RelaySocket = WebSocket & {
  isAlive?: boolean;
};

const MAX_ACTIVE_STREAMS_PER_CLIENT = 128;
const MAX_ACCEPTED_STREAM_IDS_PER_CLIENT = 1_024;
const MAX_RELAY_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url || "/", "http://localhost");
  } catch {
    return undefined;
  }
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

function sendJson(socket: WebSocket, message: unknown): boolean {
  if (!isOpen(socket)) return false;
  try {
    const payload = JSON.stringify(message);
    const payloadBytes = Buffer.byteLength(payload);
    if (
      payloadBytes > MAX_RELAY_FRAME_BYTES
      || socket.bufferedAmount + payloadBytes > MAX_SOCKET_BUFFERED_BYTES
    ) {
      socket.terminate();
      return false;
    }
    socket.send(payload);
    return true;
  } catch {
    try { socket.terminate(); } catch {}
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCurrentHost(hosts: Map<string, HostConnection>, host: HostConnection): boolean {
  return host.active && hosts.get(host.hostId) === host && isOpen(host.socket);
}

function hostInfos(hosts: Map<string, HostConnection>, clients: Map<string, ClientConnection>): RelayHostInfo[] {
  return [...hosts.values()].map((host) => ({
    hostId: host.hostId,
    displayName: host.displayName,
    connectedAt: host.connectedAt,
    clients: [...clients.values()].filter((client) =>
      client.defaultHostId === host.hostId
      || [...client.streams.values()].some((binding) => binding.hostId === host.hostId)
    ).length,
  }));
}

function getMessageHostId(message: RelayToHostMessage, client: ClientConnection): string | undefined {
  if ("hostId" in message && typeof message.hostId === "string" && message.hostId) {
    return message.hostId;
  }
  if ("streamId" in message && typeof message.streamId === "string") {
    return client.streams.get(message.streamId)?.hostId || client.defaultHostId;
  }
  return client.defaultHostId;
}

function messageRequestId(message: RelayToHostMessage): string | undefined {
  return "requestId" in message ? message.requestId : undefined;
}

function messageStreamId(message: RelayToHostMessage): string | undefined {
  return "streamId" in message ? message.streamId : undefined;
}

export async function startRelayBroker(opts: RelayServerOptions): Promise<void> {
  const hosts = new Map<string, HostConnection>();
  const clients = new Map<string, ClientConnection>();

  function retireClientStream(client: ClientConnection, streamId: string): StreamBinding | undefined {
    const binding = client.streams.get(streamId);
    if (!binding) return undefined;
    client.streams.delete(streamId);
    client.retiredStreams.add(streamId);
    return binding;
  }

  function dropHostStreams(host: HostConnection, reason: string): void {
    for (const client of clients.values()) {
      for (const [streamId, binding] of [...client.streams]) {
        if (binding.hostId !== host.hostId || binding.connectorId !== host.connectorId) continue;
        retireClientStream(client, streamId);
        if (isOpen(client.socket)) {
          sendJson(client.socket, { type: "error", streamId, message: reason });
          sendJson(client.socket, { type: "terminal_exit", streamId, code: 0 });
        }
      }
    }
  }

  const server = createServer((req, res) => {
    const url = requestUrl(req);
    if (!url) {
      writeJson(res, { ok: false, error: "invalid request target" }, 400);
      return;
    }
    if (url.pathname === "/health") {
      writeJson(res, { ok: true });
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

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RELAY_FRAME_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    const url = requestUrl(req);
    if (!url) {
      socket.destroy();
      return;
    }
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
    liveSocket.on("error", () => {
      try { liveSocket.terminate(); } catch {}
    });

    const url = requestUrl(req);
    if (!url) {
      liveSocket.terminate();
      return;
    }
    if (url.pathname === "/host") {
      const hostId = url.searchParams.get("hostId") || "";
      if (!isValidHostId(hostId)) {
        sendJson(socket, { type: "error", message: "invalid hostId" });
        socket.close(4000, "invalid hostId");
        return;
      }
      const previous = hosts.get(hostId);
      if (previous) previous.active = false;
      const host: HostConnection = {
        hostId,
        connectorId: randomUUID(),
        active: true,
        socket,
        connectedAt: Date.now(),
      };
      hosts.set(hostId, host);
      if (previous) {
        dropHostStreams(previous, "host reconnected; terminal stream closed");
        if (isOpen(previous.socket)) previous.socket.close(4002, "host replaced");
      }
      console.log(`[relay] host connected: ${hostId}`);
      sendJson(socket, { type: "host_registered", hostId });

      socket.on("message", (raw) => {
        if (!isCurrentHost(hosts, host)) return;
        let message: RelayHostMessage;
        try {
          const parsed = parseJsonMessage(raw);
          if (!isRecord(parsed) || typeof parsed.type !== "string") return;
          message = parsed as RelayHostMessage;
        } catch {
          return;
        }
        if (message.type === "host_ready") {
          if (
            message.hostId !== hostId
            || (message.displayName !== undefined && typeof message.displayName !== "string")
          ) {
            host.active = false;
            if (hosts.get(hostId) === host) hosts.delete(hostId);
            dropHostStreams(host, "host identity changed; terminal stream closed");
            socket.close(4000, "hostId mismatch");
            return;
          }
          host.displayName = message.displayName;
          return;
        }
        const clientId = "clientId" in message && typeof message.clientId === "string"
          ? message.clientId
          : undefined;
        if (!clientId || !isCurrentHost(hosts, host)) return;
        const client = clients.get(clientId);
        if (!client || !isOpen(client.socket)) return;
        const streamId = "streamId" in message && typeof message.streamId === "string"
          ? message.streamId
          : undefined;
        if (
          (message.type === "terminal_data" || message.type === "terminal_exit")
          && !streamId
        ) {
          return;
        }
        if (streamId) {
          const binding = client.streams.get(streamId);
          if (
            !binding
            || binding.hostId !== hostId
            || binding.connectorId !== host.connectorId
          ) {
            return;
          }
        }
        const { clientId: _clientId, ...outbound } = message;
        sendJson(client.socket, outbound satisfies RelayToClientMessage);
        if (message.type === "terminal_exit") retireClientStream(client, message.streamId);
      });

      socket.on("close", () => {
        if (hosts.get(hostId) === host) {
          host.active = false;
          hosts.delete(hostId);
          dropHostStreams(host, "host disconnected");
          console.log(`[relay] host disconnected: ${hostId}`);
        }
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
        retiredStreams: new Set(),
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
          const parsed = parseJsonMessage(raw);
          if (!isRecord(parsed) || typeof parsed.type !== "string") {
            sendJson(socket, { type: "error", message: "invalid message" });
            return;
          }
          message = { ...parsed, clientId } as RelayToHostMessage;
        } catch {
          sendJson(socket, { type: "error", message: "invalid json" });
          return;
        }
        if (message.type === "list_hosts") {
          sendJson(socket, { type: "hosts", requestId: message.requestId, hosts: hostInfos(hosts, clients) });
          return;
        }

        const streamIdValue: unknown = "streamId" in message ? message.streamId : undefined;
        const requiresStreamId = message.type === "open_terminal"
          || message.type === "terminal_input"
          || message.type === "resize"
          || message.type === "close_terminal";
        if (
          (requiresStreamId || streamIdValue !== undefined)
          && (
            typeof streamIdValue !== "string"
            || !streamIdValue
            || streamIdValue.length > 256
            || /[\0\r\n]/.test(streamIdValue)
          )
        ) {
          sendJson(socket, {
            type: "error",
            requestId: messageRequestId(message),
            streamId: typeof streamIdValue === "string" ? streamIdValue : undefined,
            message: "invalid streamId",
          });
          return;
        }

        if (
          message.type === "terminal_input"
          || message.type === "resize"
          || message.type === "close_terminal"
        ) {
          const binding = client.streams.get(message.streamId);
          if (!binding) {
            sendJson(socket, {
              type: "error",
              streamId: message.streamId,
              message: "terminal stream is not open",
            });
            return;
          }
          const currentHost = hosts.get(binding.hostId);
          if (
            !currentHost
            || !isCurrentHost(hosts, currentHost)
            || currentHost.connectorId !== binding.connectorId
          ) {
            retireClientStream(client, message.streamId);
            sendJson(socket, { type: "error", streamId: message.streamId, message: "host is not connected" });
            sendJson(socket, { type: "terminal_exit", streamId: message.streamId, code: 0 });
            return;
          }
          sendJson(currentHost.socket, message);
          if (message.type === "close_terminal") retireClientStream(client, message.streamId);
          return;
        }

        const targetHostId = getMessageHostId(message, client);
        if (!targetHostId || !isValidHostId(targetHostId)) {
          sendJson(socket, { type: "error", requestId: "requestId" in message ? message.requestId : undefined, message: "missing or invalid hostId" });
          return;
        }
        const currentHost = hosts.get(targetHostId);
        if (!currentHost || !isCurrentHost(hosts, currentHost)) {
          sendJson(socket, {
            type: "error",
            requestId: messageRequestId(message),
            streamId: messageStreamId(message),
            message: "host is not connected",
          });
          return;
        }
        if (message.type === "open_terminal") {
          if (client.streams.has(message.streamId) || client.retiredStreams.has(message.streamId)) {
            sendJson(socket, {
              type: "error",
              streamId: message.streamId,
              message: "streamId has already been used",
            });
            return;
          }
          if (client.streams.size >= MAX_ACTIVE_STREAMS_PER_CLIENT) {
            sendJson(socket, {
              type: "error",
              streamId: message.streamId,
              message: "too many active terminal streams",
            });
            return;
          }
          if (
            client.streams.size + client.retiredStreams.size
            >= MAX_ACCEPTED_STREAM_IDS_PER_CLIENT
          ) {
            sendJson(socket, {
              type: "error",
              streamId: message.streamId,
              message: "terminal stream id budget exhausted; reconnect client",
            });
            return;
          }
          client.streams.set(message.streamId, {
            hostId: targetHostId,
            connectorId: currentHost.connectorId,
            routeId: randomUUID(),
          });
        }
        sendJson(currentHost.socket, message);
      });

      socket.on("close", () => {
        clients.delete(clientId);
        const notifiedConnectors = new Set<string>();
        for (const binding of client.streams.values()) {
          if (notifiedConnectors.has(binding.connectorId)) continue;
          const currentHost = hosts.get(binding.hostId);
          if (
            currentHost
            && currentHost.connectorId === binding.connectorId
            && isCurrentHost(hosts, currentHost)
          ) {
            sendJson(currentHost.socket, { type: "client_closed", clientId });
            notifiedConnectors.add(binding.connectorId);
          }
        }
        if (client.defaultHostId && !client.streams.size) {
          const currentHost = hosts.get(client.defaultHostId);
          if (currentHost && isCurrentHost(hosts, currentHost)) {
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
