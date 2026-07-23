import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  RELAY_HOST_RETIRE_CAPABILITY,
  type RelayClientMessage,
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
import type {
  RelayV2BrokerAuthControlAuthority,
  RelayV2LiveAuthorizationFencePort,
} from "../v2/brokerCore.js";
import type { RelayV2BrokerCredentialNodeHttpAdapterAuthorityPort } from "../v2/brokerCredentialNodeHttpAdapter.js";
import type { RelayV2BrokerTransportCloseDeadlineScheduler } from "../v2/brokerTransportCloseCoordinator.js";
import type { RelayServerOptions } from "./options.js";
import type { RelayV2BrokerServerRuntimeV2 } from "../v2/brokerServerRuntime.js";

export interface RelayV2BrokerServerCredentialAuthority
  extends RelayV2BrokerCredentialNodeHttpAdapterAuthorityPort,
  RelayV2BrokerAuthControlAuthority {
  readonly authorityContinuityReadiness: Readonly<{ status: string }>;
  close(): Promise<void>;
}

/**
 * Trusted, process-local receipt from the optional Agent extension readiness
 * owner. The loss subscription is one-way: this server composition may only
 * withdraw the extension from the already-constructed BrokerCore.
 */
export interface RelayV2BrokerServerAgentCapabilityReadinessReceipt {
  readonly status: "ready";
  subscribeLoss(onLoss: () => void): () => void;
}

/**
 * Explicit opt-in seam for the isolated Relay v2 broker composition.
 * The CLI never supplies this object. A future production owner must create
 * the credential authority with the exact BrokerCore fence passed here; this
 * module never constructs a native store, continuity backend, secret, issuer,
 * enrollment, or capability readiness fact.
 */
export interface RelayV2BrokerServerComposition {
  openCredentialAuthority(input: {
    liveAuthorizationFence: RelayV2LiveAuthorizationFencePort;
  }): Promise<RelayV2BrokerServerCredentialAuthority>;
  /** Trusted listener/socket identity only; request headers are inaccessible. */
  resolveHttpSourceKey(socket: Socket): string;
  /** Optional deterministic scheduler for isolated lifecycle verification. */
  closeDeadlineScheduler?: RelayV2BrokerTransportCloseDeadlineScheduler;
  /** Omission keeps agent.transcript-lifecycle.v1 disabled. */
  agentTranscriptLifecycleReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
}

export interface RelayBrokerServerHandle {
  readonly host: string;
  readonly port: number;
  shutdown(): Promise<void>;
}

type HostConnection = {
  hostId: string;
  connectorId: string;
  active: boolean;
  retiring: boolean;
  supportsRetireDrain: boolean;
  displayName?: string;
  socket: WebSocket;
  connectedAt: number;
  pendingMutations: PendingMutation[];
  retireTimer?: ReturnType<typeof setTimeout>;
  forceCloseTimer?: ReturnType<typeof setTimeout>;
};

type MutationResponseType =
  | "worktree_created"
  | "terminal_created"
  | "agent_message_sent"
  | "session_killed";

type PendingMutation = {
  clientId: string;
  requestId?: string;
  responseType: MutationResponseType;
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
const MAX_PENDING_MUTATIONS_PER_HOST = 128;
const MAX_RELAY_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const HOST_RETIRE_TIMEOUT_MS = 5 * 60_000;
const HOST_CLOSE_GRACE_MS = 1_000;
const RELAY_CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "list_hosts",
  "list_sessions",
  "list_scope_statuses",
  "create_worktree",
  "create_terminal",
  "open_terminal",
  "send_agent_message",
  "kill_session",
  "terminal_input",
  "resize",
  "close_terminal",
] satisfies RelayClientMessage["type"][]);

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

function isRelayClientMessageType(type: string): type is RelayClientMessage["type"] {
  return RELAY_CLIENT_MESSAGE_TYPES.has(type);
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

function mutationResponseType(message: RelayToHostMessage): MutationResponseType | undefined {
  if (message.type === "create_worktree") return "worktree_created";
  if (message.type === "create_terminal") return "terminal_created";
  if (message.type === "send_agent_message") return "agent_message_sent";
  if (message.type === "kill_session") return "session_killed";
  return undefined;
}

function rawHeaderValues(request: IncomingMessage, expectedName: string): string[] {
  const values: string[] = [];
  const rawHeaders = request.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return values;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (
      typeof name === "string"
      && typeof value === "string"
      && name.toLowerCase() === expectedName
    ) values.push(value);
  }
  return values;
}

function offeredWebSocketProtocols(request: IncomingMessage): string[] {
  return rawHeaderValues(request, "sec-websocket-protocol")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function rawUpgradeTarget(request: IncomingMessage): {
  pathname: string;
  search: string;
} | undefined {
  const target = request.url;
  if (!target || !target.startsWith("/") || target.includes("#")) return undefined;
  const query = target.indexOf("?");
  return query < 0
    ? { pathname: target, search: "" }
    : { pathname: target.slice(0, query), search: target.slice(query) };
}

function isRelayV2Credential(value: string): boolean {
  return value.startsWith("twcap2.");
}

function hasRelayV2UpgradeCredential(request: IncomingMessage, url: URL | undefined): boolean {
  const authorizationValues = rawHeaderValues(request, "authorization");
  if (authorizationValues.some((value) => /^Bearer\s+twcap2\./.test(value))) return true;
  return url?.searchParams.getAll("secret").some(isRelayV2Credential) === true;
}

function relayV2QueryCredential(url: URL): string | undefined {
  return url.searchParams.getAll("secret").find(isRelayV2Credential);
}

function isRelayV2HttpNamespace(target: string | undefined): boolean {
  return target === "/v2" || target?.startsWith("/v2/") === true;
}

function isIsolatedLoopbackListener(opts: RelayServerOptions): boolean {
  return opts.port === 0 && (opts.host === "127.0.0.1" || opts.host === "::1");
}

function rejectUpgrade(socket: Socket, status: number): void {
  const reason = status === 400
    ? "Bad Request"
    : status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : status === 426
            ? "Upgrade Required"
            : "Service Unavailable";
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    try { socket.destroy(); } catch {}
  }
}

function waitForRequestSettlement(request: IncomingMessage): Promise<void> {
  if (request.complete || request.readableEnded || request.destroyed || request.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const settle = (): void => {
      request.off("end", settle);
      request.off("aborted", settle);
      request.off("close", settle);
      resolve();
    };
    request.once("end", settle);
    request.once("aborted", settle);
    request.once("close", settle);
  });
}

function waitForResponseSettlement(response: ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      response.off("finish", settle);
      response.off("close", settle);
      resolve();
    };
    response.once("finish", settle);
    response.once("close", settle);
  });
}

export async function startRelayBroker(
  opts: RelayServerOptions,
  relayV2?: RelayV2BrokerServerRuntimeV2,
): Promise<RelayBrokerServerHandle> {
  if (relayV2 !== undefined && !isIsolatedLoopbackListener(opts)) {
    await relayV2.shutdown();
    throw new Error(
      "Relay v2 broker composition is restricted to an isolated random-port loopback listener",
    );
  }
  const hosts = new Map<string, HostConnection>();
  const candidates = new Map<string, HostConnection>();
  const hostConnections = new Set<HostConnection>();
  const clients = new Map<string, ClientConnection>();
  const relayV2HttpRequests = new Set<Promise<void>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

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

  function clearHostTimers(host: HostConnection): void {
    if (host.retireTimer) clearTimeout(host.retireTimer);
    if (host.forceCloseTimer) clearTimeout(host.forceCloseTimer);
    host.retireTimer = undefined;
    host.forceCloseTimer = undefined;
  }

  function failPendingMutations(host: HostConnection, reason: string): void {
    const pending = host.pendingMutations.splice(0);
    for (const mutation of pending) {
      const client = clients.get(mutation.clientId);
      if (!client || !isOpen(client.socket)) continue;
      sendJson(client.socket, {
        type: "error",
        requestId: mutation.requestId,
        message: reason,
      });
    }
  }

  function finishHostRetirement(host: HostConnection): void {
    if (!host.retiring) return;
    host.retiring = false;
    if (host.retireTimer) clearTimeout(host.retireTimer);
    host.retireTimer = undefined;
    failPendingMutations(host, "host replaced before mutation completed");
    if (isOpen(host.socket)) host.socket.close(4002, "host replaced");
    if (host.socket.readyState === WebSocket.CLOSED) return;
    host.forceCloseTimer = setTimeout(() => {
      host.forceCloseTimer = undefined;
      if (host.socket.readyState !== WebSocket.CLOSED) {
        try { host.socket.terminate(); } catch {}
      }
    }, HOST_CLOSE_GRACE_MS);
    host.forceCloseTimer.unref();
  }

  function finishLegacyRetirementIfDrained(host: HostConnection): void {
    if (
      host.retiring
      && !host.supportsRetireDrain
      && host.pendingMutations.length === 0
    ) {
      finishHostRetirement(host);
    }
  }

  function beginHostRetirement(host: HostConnection): void {
    if (host.retiring || !isOpen(host.socket)) return;
    host.active = false;
    host.retiring = true;
    dropHostStreams(host, "host reconnected; terminal stream closed");
    if (!sendJson(host.socket, { type: "host_retire" })) {
      finishHostRetirement(host);
      return;
    }
    host.retireTimer = setTimeout(
      () => finishHostRetirement(host),
      HOST_RETIRE_TIMEOUT_MS,
    );
    host.retireTimer.unref();
    finishLegacyRetirementIfDrained(host);
  }

  function activateHost(host: HostConnection): void {
    if (!isOpen(host.socket)) return;
    const previous = hosts.get(host.hostId);
    if (candidates.get(host.hostId) === host) candidates.delete(host.hostId);
    host.active = true;
    hosts.set(host.hostId, host);
    if (previous && previous !== host) beginHostRetirement(previous);
  }

  function registerPendingMutation(
    host: HostConnection,
    message: RelayToHostMessage,
  ): PendingMutation | undefined {
    const responseType = mutationResponseType(message);
    if (!responseType) return undefined;
    const pending = {
      clientId: message.clientId,
      requestId: messageRequestId(message),
      responseType,
    };
    host.pendingMutations.push(pending);
    return pending;
  }

  function consumePendingMutation(
    host: HostConnection,
    message: RelayHostMessage & { clientId: string },
  ): boolean {
    const requestId = "requestId" in message ? message.requestId : undefined;
    const index = host.pendingMutations.findIndex((pending) => (
      pending.clientId === message.clientId
      && pending.requestId === requestId
      && (message.type === "error" || message.type === pending.responseType)
    ));
    if (index < 0) return false;
    host.pendingMutations.splice(index, 1);
    return true;
  }

  const server = createServer((req, res) => {
    if (shuttingDown) {
      res.shouldKeepAlive = false;
      writeJson(res, { ok: false, error: "server shutting down" }, 503);
      return;
    }
    if (relayV2 && isRelayV2HttpNamespace(req.url)) {
      const requestSettled = waitForRequestSettlement(req);
      const responseSettled = waitForResponseSettlement(res);
      let tracked: Promise<void>;
      tracked = (async () => {
        try {
          await relayV2.handleHttpRequest(req, res);
        } catch {
          if (!res.destroyed) {
            try { res.destroy(); } catch {}
          }
          if (!req.destroyed) {
            try { req.destroy(); } catch {}
          }
        }
        await Promise.all([requestSettled, responseSettled]);
      })().finally(() => {
        relayV2HttpRequests.delete(tracked);
      });
      relayV2HttpRequests.add(tracked);
      return;
    }
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
      if (isRelayV2Credential(provided) || !constantTimeEqual(provided, opts.secret)) {
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
    const target = rawUpgradeTarget(req);
    if (!url) {
      socket.destroy();
      return;
    }
    const protocols = offeredWebSocketProtocols(req);
    const isV2Attempt = hasRelayV2UpgradeCredential(req, url)
      || protocols.includes("tw-relay.v2")
      || protocols.includes("tw-relay.host.v2");
    if (isV2Attempt) {
      if (shuttingDown) {
        rejectUpgrade(socket, 503);
        return;
      }
      if (!relayV2 || !target) {
        rejectUpgrade(socket, 401);
        return;
      }
      const admitted = relayV2.admitUpgrade(
        req,
        socket,
        head,
        target,
        relayV2QueryCredential(url) ?? url.searchParams.get("secret"),
      );
      if (!admitted) rejectUpgrade(socket, 503);
      return;
    }
    if (shuttingDown) {
      rejectUpgrade(socket, 503);
      return;
    }
    if (!isSafeRelayPath(url.pathname)) {
      socket.destroy();
      return;
    }
    const provided = requestSecret(req, url);
    if (isRelayV2Credential(provided) || !constantTimeEqual(provided, opts.secret)) {
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
      const host: HostConnection = {
        hostId,
        connectorId: randomUUID(),
        active: false,
        retiring: false,
        supportsRetireDrain: false,
        socket,
        connectedAt: Date.now(),
        pendingMutations: [],
      };
      hostConnections.add(host);
      const previousCandidate = candidates.get(hostId);
      if (previousCandidate && previousCandidate !== host) {
        previousCandidate.socket.close(4002, "host candidate replaced");
      }
      candidates.set(hostId, host);
      console.log(`[relay] host connected: ${hostId}`);
      sendJson(socket, { type: "host_registered", hostId });

      socket.on("message", (raw) => {
        let message: RelayHostMessage;
        try {
          const parsed = parseJsonMessage(raw);
          if (!isRecord(parsed) || typeof parsed.type !== "string") return;
          message = parsed as RelayHostMessage;
        } catch {
          return;
        }
        const currentHost = isCurrentHost(hosts, host);
        const candidateHost = candidates.get(hostId) === host && isOpen(host.socket);
        const retiringHost = host.retiring && isOpen(host.socket);
        if (!currentHost && !candidateHost && !retiringHost) return;
        if (message.type === "host_ready") {
          if (retiringHost) return;
          if (
            message.hostId !== hostId
            || (message.displayName !== undefined && typeof message.displayName !== "string")
            || (message.capabilities !== undefined && (
              !Array.isArray(message.capabilities)
              || message.capabilities.some((capability) => typeof capability !== "string")
            ))
          ) {
            host.active = false;
            if (hosts.get(hostId) === host) hosts.delete(hostId);
            if (candidates.get(hostId) === host) candidates.delete(hostId);
            dropHostStreams(host, "host identity changed; terminal stream closed");
            socket.close(4000, "hostId mismatch");
            return;
          }
          host.displayName = message.displayName;
          host.supportsRetireDrain = message.capabilities?.includes(
            RELAY_HOST_RETIRE_CAPABILITY,
          ) ?? false;
          if (candidateHost) activateHost(host);
          return;
        }
        if (message.type === "host_drained") {
          if (retiringHost) finishHostRetirement(host);
          return;
        }
        if (!currentHost && !retiringHost) return;
        const clientId = "clientId" in message && typeof message.clientId === "string"
          ? message.clientId
          : undefined;
        if (!clientId) return;
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
        const pendingMutation = streamId
          ? false
          : consumePendingMutation(host, message as RelayHostMessage & { clientId: string });
        if (retiringHost && !pendingMutation) return;
        const { clientId: _clientId, ...outbound } = message;
        sendJson(client.socket, outbound satisfies RelayToClientMessage);
        if (retiringHost && pendingMutation) finishLegacyRetirementIfDrained(host);
        if (message.type === "terminal_exit") retireClientStream(client, message.streamId);
      });

      socket.on("close", () => {
        clearHostTimers(host);
        hostConnections.delete(host);
        if (candidates.get(hostId) === host) candidates.delete(hostId);
        failPendingMutations(host, host.retiring
          ? "host replaced before mutation completed"
          : "host disconnected before mutation completed");
        host.retiring = false;
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
          if (
            !isRecord(parsed)
            || typeof parsed.type !== "string"
            || !isRelayClientMessageType(parsed.type)
          ) {
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
        if (
          mutationResponseType(message)
          && currentHost.pendingMutations.length >= MAX_PENDING_MUTATIONS_PER_HOST
        ) {
          sendJson(socket, {
            type: "error",
            requestId: messageRequestId(message),
            message: "too many pending relay mutations on host",
          });
          return;
        }
        registerPendingMutation(currentHost, message);
        sendJson(currentHost.socket, message);
      });

      socket.on("close", () => {
        clients.delete(clientId);
        for (const host of hostConnections) {
          host.pendingMutations = host.pendingMutations.filter((pending) => (
            pending.clientId !== clientId
          ));
          finishLegacyRetirementIfDrained(host);
        }
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

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(opts.port, opts.host);
    });
  } catch (error) {
    await relayV2?.shutdown();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await relayV2?.shutdown();
    throw new Error("Relay broker listener address is unavailable");
  }
  const listeningPort = address.port;
  console.log(`[relay] listening on http://${opts.host}:${listeningPort}`);
  console.log(`[relay] health: http://${opts.host}:${listeningPort}/health`);

  const closeServer = (): Promise<void> => new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
  const closeLegacyWebSocketServer = (): Promise<void> => new Promise((resolve) => {
    for (const socket of wss.clients) {
      try { socket.terminate(); } catch {}
    }
    try {
      wss.close(() => resolve());
    } catch {
      resolve();
    }
  });

  return Object.freeze({
    host: opts.host,
    port: listeningPort,
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      relayV2?.beginShutdown();
      shutdownPromise = (async () => {
        const serverClosed = closeServer();
        const legacyClosed = closeLegacyWebSocketServer();
        while (relayV2HttpRequests.size > 0) {
          await Promise.all([...relayV2HttpRequests]);
        }
        try {
          await relayV2?.shutdown();
        } finally {
          await Promise.all([legacyClosed, serverClosed]);
        }
      })();
      return shutdownPromise;
    },
  });
}
