import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { TerminalControlAuthority } from "./authority";
import {
  TERMINAL_CONTROL_MAX_FRAME_BYTES,
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  parseTerminalControlRequest,
  terminalControlErrorResponse,
  type TerminalControlResponse,
} from "./protocol";
import {
  acquireTerminalControlStoreLock,
  releaseTerminalControlStoreLock,
  terminalControlOwnsSocketDirectory,
  terminalControlSocketPath,
} from "./store";

function requestIdFrom(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128
    ? requestId
    : "invalid";
}

function writeResponse(socket: Socket, response: TerminalControlResponse): void {
  if (socket.destroyed) return;
  const frame = `${JSON.stringify(response)}\n`;
  socket.end(frame);
}

function handleSocket(socket: Socket, authority: TerminalControlAuthority): void {
  socket.setEncoding("utf8");
  socket.setTimeout(15_000, () => socket.destroy());
  let buffer = "";
  let handled = false;
  socket.on("data", (chunk: string) => {
    if (handled) {
      socket.destroy();
      return;
    }
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > TERMINAL_CONTROL_MAX_FRAME_BYTES) {
      handled = true;
      writeResponse(
        socket,
        terminalControlErrorResponse(
          "invalid",
          new Error("terminal-control request exceeds the frame limit"),
        ),
      );
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    const frame = buffer.slice(0, newline);
    if (buffer.slice(newline + 1).trim()) {
      socket.destroy();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame);
    } catch (error) {
      writeResponse(socket, terminalControlErrorResponse("invalid", error));
      return;
    }
    const requestId = requestIdFrom(decoded);
    let request;
    try {
      request = parseTerminalControlRequest(decoded);
    } catch (error) {
      writeResponse(socket, terminalControlErrorResponse(requestId, error));
      return;
    }
    void authority.handle(request).then(
      (result) => writeResponse(socket, {
        protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result,
      }),
      (error) => writeResponse(socket, terminalControlErrorResponse(request.requestId, error)),
    );
  });
  socket.on("error", () => {});
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

export async function runTerminalControlServer(options: {
  socketPath?: string;
  authority?: TerminalControlAuthority;
  signal?: AbortSignal;
  /** Explicit private sibling ingress; never advertised on terminal-control v1. */
  relayV2RemoteExactCompoundV1?: boolean;
} = {}): Promise<void> {
  const socketPath = options.socketPath ?? terminalControlSocketPath();
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (terminalControlOwnsSocketDirectory(socketPath)) {
    const directory = lstatSync(dirname(socketPath));
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("terminal-control socket directory is not a real directory");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && directory.uid !== uid) {
      throw new Error("terminal-control socket directory is owned by another user");
    }
    chmodSync(dirname(socketPath), 0o700);
  }
  const serverLock = await acquireTerminalControlStoreLock(`${socketPath}.server.lock`);
  const authority = options.authority ?? new TerminalControlAuthority();
  const server = createServer((socket) => handleSocket(socket, authority));
  let compoundIngress: import(
    "../relay/v2/remoteExactTerminalControlCompoundV1.js"
  ).RelayV2RemoteExactCompoundDaemonIngressV1 | null = null;
  let closed = false;
  let ownsSocket = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch {}
    if (ownsSocket) rmSync(socketPath, { force: true });
    releaseTerminalControlStoreLock(serverLock);
  };
  try {
    if (existsSync(socketPath)) {
      if (await socketIsLive(socketPath)) {
        throw new Error(`terminal-control server is already running at ${socketPath}`);
      }
      rmSync(socketPath, { force: true });
    }
    await authority.initializeContinuity();
    await listen(server, socketPath);
    ownsSocket = true;
    chmodSync(socketPath, 0o600);
    if (options.relayV2RemoteExactCompoundV1 === true) {
      const { openRelayV2RemoteExactCompoundDaemonIngressV1 } = await import(
        "../relay/v2/remoteExactTerminalControlCompoundV1.js"
      );
      compoundIngress = await openRelayV2RemoteExactCompoundDaemonIngressV1({
        daemonSocketPath: socketPath,
        authority,
        primaryServerLock: serverLock,
      });
    }
    await new Promise<void>((resolve) => {
      const stop = () => {
        const primaryClosed = new Promise<void>((closed) => {
          try { server.close(() => closed()); } catch { closed(); }
        });
        const compoundClosed = compoundIngress?.closeAndDrain() ?? Promise.resolve();
        void Promise.allSettled([primaryClosed, compoundClosed]).then(() => resolve());
      };
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      server.once("close", resolve);
    });
  } finally {
    try {
      try {
        await compoundIngress?.closeAndDrain();
      } finally {
        await authority.closeRelayV2ExactTargetAuthority();
      }
    } finally {
      cleanup();
    }
  }
}
