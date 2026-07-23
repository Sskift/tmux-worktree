import {
  Server as NodeHttpsServer,
} from "node:https";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { RelayV2BrokerServerRuntimeV2 } from "./brokerServerRuntime.js";

export interface RelayV2BrokerPublicHttpsListenOptions {
  readonly host: string;
  readonly port: number;
}

export interface RelayV2BrokerPublicHttpsServerHandle {
  readonly host: string;
  readonly port: number;
  /**
   * Synchronously fence new HTTP/Upgrade admission (and the runtime's upgrade
   * authorization). It neither drains nor closes anything; `shutdown()` still
   * performs the full drain and close exactly once.
   */
  beginShutdown(): void;
  shutdown(): Promise<void>;
}

type RuntimeActivator = () => Promise<RelayV2BrokerServerRuntimeV2>;

const claimedServers = new WeakSet<NodeHttpsServer>();

function captureListenOptions(
  options: RelayV2BrokerPublicHttpsListenOptions,
): Readonly<{ host: string; port: number }> {
  const host = options?.host;
  const port = options?.port;
  if (
    typeof host !== "string"
    || host.length === 0
    || !Number.isInteger(port)
    || port < 0
    || port > 65_535
  ) {
    throw new TypeError("Relay v2 Broker public HTTPS listen options are invalid");
  }
  return Object.freeze({ host, port });
}

function assertAvailableHttpsServer(server: unknown): asserts server is NodeHttpsServer {
  if (!(server instanceof NodeHttpsServer)) {
    throw new TypeError("Relay v2 Broker public listener requires a node:https Server");
  }
  if (
    server.listening
    || server.listenerCount("request") !== 0
    || server.listenerCount("upgrade") !== 0
  ) {
    throw new Error(
      "Relay v2 Broker public HTTPS Server already has a listener owner",
    );
  }
}

function rawUpgradeTarget(
  request: IncomingMessage,
): Readonly<{ pathname: string; search: string }> | undefined {
  const target = request.url;
  if (!target || !target.startsWith("/") || target.includes("#")) return undefined;
  const query = target.indexOf("?");
  return Object.freeze(query < 0
    ? { pathname: target, search: "" }
    : { pathname: target.slice(0, query), search: target.slice(query) });
}

function rejectUpgrade(socket: Socket, status: 400 | 404 | 503): void {
  const reason = status === 400
    ? "Bad Request"
    : status === 404
      ? "Not Found"
      : "Service Unavailable";
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n`
      + "Cache-Control: no-store\r\n"
      + "Connection: close\r\n"
      + "Content-Length: 0\r\n\r\n",
    );
  } catch {
    try { socket.destroy(); } catch {}
  }
}

function rejectHttpDuringShutdown(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.shouldKeepAlive = false;
  try { request.resume(); } catch {}
  try {
    response.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(JSON.stringify({ ok: false, error: "server shutting down" }));
  } catch {
    try { response.destroy(); } catch {}
    try { request.destroy(); } catch {}
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

/**
 * Process-local lifecycle root used by the public relayServer facade. The
 * supplied HTTPS Server is consumed for one listener lifetime. Runtime
 * activation is injected so the canonical Broker runtime remains the only
 * Core, credential-authority, and WSS composition owner.
 */
export async function startRelayV2BrokerPublicHttpsServerLifecycle(
  serverInput: NodeHttpsServer,
  listenOptions: RelayV2BrokerPublicHttpsListenOptions,
  activateRuntime: RuntimeActivator,
): Promise<RelayV2BrokerPublicHttpsServerHandle> {
  const options = captureListenOptions(listenOptions);
  assertAvailableHttpsServer(serverInput);
  if (claimedServers.has(serverInput)) {
    throw new Error("Relay v2 Broker public HTTPS Server is already claimed");
  }
  claimedServers.add(serverInput);

  let runtime: RelayV2BrokerServerRuntimeV2;
  try {
    runtime = await activateRuntime();
  } catch (error) {
    claimedServers.delete(serverInput);
    throw error;
  }

  try {
    assertAvailableHttpsServer(serverInput);
  } catch (error) {
    try { await runtime.shutdown(); } catch {}
    claimedServers.delete(serverInput);
    throw error;
  }

  const server = serverInput;
  const activeRequests = new Set<Promise<void>>();
  let shuttingDown = false;
  let didListen = false;
  let closeObserved = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveCloseObserved!: () => void;
  const closeObservedPromise = new Promise<void>((resolve) => {
    resolveCloseObserved = resolve;
  });

  const beginShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.beginShutdown();
  };

  const onRequest = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    if (shuttingDown) {
      rejectHttpDuringShutdown(request, response);
      return;
    }
    const requestSettled = waitForRequestSettlement(request);
    const responseSettled = waitForResponseSettlement(response);
    let tracked!: Promise<void>;
    tracked = (async () => {
      try {
        await runtime.handleHttpRequest(request, response);
      } catch {
        if (!response.destroyed) {
          try { response.destroy(); } catch {}
        }
        if (!request.destroyed) {
          try { request.destroy(); } catch {}
        }
      }
      await Promise.all([requestSettled, responseSettled]);
    })().finally(() => {
      activeRequests.delete(tracked);
    });
    activeRequests.add(tracked);
  };

  const onUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    if (shuttingDown) {
      rejectUpgrade(socket, 503);
      return;
    }
    const target = rawUpgradeTarget(request);
    if (!target) {
      rejectUpgrade(socket, 400);
      return;
    }
    if (target.pathname !== "/client" && target.pathname !== "/host") {
      rejectUpgrade(socket, 404);
      return;
    }
    try {
      if (!runtime.admitUpgrade(request, socket, head, target, null)) {
        rejectUpgrade(socket, 503);
      }
    } catch {
      try { socket.destroy(); } catch {}
    }
  };

  const removeOwnedListeners = (): void => {
    server.off("request", onRequest);
    server.off("upgrade", onUpgrade);
    server.off("error", onServerError);
    server.off("close", onServerClose);
  };

  const closeServer = async (): Promise<void> => {
    if (closeObserved || (!didListen && !server.listening)) return;
    if (!server.listening) {
      await closeObservedPromise;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.once("close", finish);
      try {
        server.close(() => finish());
      } catch {
        server.off("close", finish);
        finish();
      }
    });
  };

  const startShutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    beginShutdown();
    shutdownPromise = Promise.resolve().then(async () => {
      const serverClosed = closeServer();
      while (activeRequests.size > 0) {
        await Promise.all([...activeRequests]);
      }
      const outcomes = await Promise.allSettled([
        runtime.shutdown(),
        serverClosed,
      ]);
      removeOwnedListeners();
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failure) throw failure.reason;
    });
    void shutdownPromise.catch(() => undefined);
    return shutdownPromise;
  };

  function onServerClose(): void {
    closeObserved = true;
    resolveCloseObserved();
    beginShutdown();
    void startShutdown();
  }

  function onServerError(): void {
    beginShutdown();
    void startShutdown();
  }

  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);
  server.on("close", onServerClose);
  server.on("error", onServerError);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        didListen = true;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(options.port, options.host);
      } catch (error) {
        server.off("error", onError);
        server.off("listening", onListening);
        reject(error);
      }
    });
  } catch (error) {
    try { await startShutdown(); } catch {}
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    try { await startShutdown(); } catch {}
    throw new Error("Relay v2 Broker public HTTPS listener address is unavailable");
  }

  return Object.freeze({
    host: options.host,
    port: address.port,
    beginShutdown,
    shutdown: startShutdown,
  });
}
