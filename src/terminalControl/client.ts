import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import type { TerminalControlRequest, TerminalControlResponse } from "./protocol";
import {
  TERMINAL_CONTROL_MAX_FRAME_BYTES,
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  parseTerminalControlResponse,
  TerminalControlProtocolError,
} from "./protocol";
import { terminalControlSocketPath } from "./store";

type DistributiveRequestInput<T> = T extends TerminalControlRequest
  ? Omit<T, "protocolVersion" | "requestId">
  : never;

export type TerminalControlRequestInput = DistributiveRequestInput<TerminalControlRequest>;

export interface TerminalControlAutoStartCliTarget {
  readonly executable: string;
  readonly entrypoint: string;
  /** Exact local-development home; production callers must omit it. */
  readonly home?: string;
}

interface TerminalControlAutoStartPaths {
  readonly socketPath: string;
  readonly statePath: string;
}

function aborted(): Error {
  const error = new Error("terminal-control request aborted");
  error.name = "AbortError";
  return error;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function clientError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

function localDevelopmentHome(
  target?: Readonly<TerminalControlAutoStartCliTarget>,
): string | undefined {
  if (target === undefined || !Object.hasOwn(target, "home")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, "home");
  const value = descriptor?.value;
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
    || typeof value !== "string"
    || !isAbsolute(value)
    || value.includes("\0")) {
    throw new TypeError("terminal-control local-development home is unsafe");
  }
  try {
    const before = lstatSync(value, { bigint: true });
    if (!before.isDirectory()
      || before.isSymbolicLink()
      || before.uid !== BigInt(process.geteuid())
      || (before.mode & 0o7777n) !== 0o700n) {
      throw new TypeError("terminal-control local-development home is unsafe");
    }
    const canonical = realpathSync.native(value);
    const after = lstatSync(value, { bigint: true });
    if (canonical !== value
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.uid !== before.uid
      || after.mode !== before.mode
      || !after.isDirectory()
      || after.isSymbolicLink()) {
      throw new TypeError("terminal-control local-development home is unsafe");
    }
    return canonical;
  } catch {
    throw new TypeError("terminal-control local-development home is unsafe");
  }
}

function startServer(
  target?: Readonly<TerminalControlAutoStartCliTarget>,
  paths?: Readonly<TerminalControlAutoStartPaths>,
): void {
  const home = localDevelopmentHome(target);
  const cli = target?.entrypoint
    || process.env.TW_TERMINAL_CONTROL_CLI?.trim()
    || process.env.TW_DASHBOARD_CLI?.trim()
    || process.argv[1];
  if (!cli) throw new Error("cannot locate tw CLI to start terminal-control server");
  const child = spawn(target?.executable || process.execPath, [
    cli,
    "terminal-control",
    "serve",
    ...(paths === undefined
      ? []
      : [
          "--socket-path",
          paths.socketPath,
          "--state-path",
          paths.statePath,
        ]),
  ], {
    detached: true,
    stdio: "ignore",
    env: home === undefined ? process.env : { ...process.env, HOME: home },
  });
  child.unref();
}

function sendRequest(
  socketPath: string,
  request: TerminalControlRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TerminalControlResponse> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let settled = false;
    let buffer = "";
    const finish = (error?: Error, response?: TerminalControlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => {
      finish(new Error("terminal-control request timed out"));
    }, timeoutMs);
    const onAbort = () => finish(aborted());
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > TERMINAL_CONTROL_MAX_FRAME_BYTES) {
        finish(new Error("terminal-control response exceeds the frame limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = parseTerminalControlResponse(
          JSON.parse(buffer.slice(0, newline)),
          request.requestId,
        );
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("terminal-control server closed without a response"));
    });
  });
}

export async function requestTerminalControl<T = unknown>(
  input: TerminalControlRequestInput,
  options: {
    socketPath?: string;
    timeoutMs?: number;
    autoStart?: boolean;
    autoStartCliTarget?: Readonly<TerminalControlAutoStartCliTarget>;
    autoStartStatePath?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const socketPath = options.socketPath ?? terminalControlSocketPath();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const request = {
    ...input,
    protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
    requestId: randomUUID(),
  } as TerminalControlRequest;
  let response: TerminalControlResponse;
  try {
    response = await sendRequest(socketPath, request, timeoutMs, options.signal);
  } catch (error) {
    if (options.autoStart === false || !(error instanceof Error) || !clientError(error as NodeJS.ErrnoException)) {
      throw error;
    }
    if (options.signal?.aborted) throw aborted();
    const autoStartPaths = options.autoStartStatePath === undefined
      ? undefined
      : (() => {
          if (options.socketPath === undefined
            || !isAbsolute(socketPath)
            || socketPath.includes("\0")
            || !isAbsolute(options.autoStartStatePath)
            || options.autoStartStatePath.includes("\0")) {
            throw new TypeError(
              "terminal-control exact auto-start requires absolute socket and state paths",
            );
          }
          return Object.freeze({
            socketPath,
            statePath: options.autoStartStatePath,
          });
        })();
    startServer(
      options.autoStartCliTarget,
      autoStartPaths,
    );
    const deadline = Date.now() + Math.min(timeoutMs, 5_000);
    while (true) {
      try {
        response = await sendRequest(socketPath, request, timeoutMs, options.signal);
        break;
      } catch (retryError) {
        if (!(retryError instanceof Error) || !clientError(retryError as NodeJS.ErrnoException) || Date.now() >= deadline) {
          throw retryError;
        }
        await delay(25, options.signal);
      }
    }
  }
  if (!response.ok) {
    throw new TerminalControlProtocolError(
      response.error.code,
      response.error.message,
      response.error.retryable,
    );
  }
  return response.result as T;
}
