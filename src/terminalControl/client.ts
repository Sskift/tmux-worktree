import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clientError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

function startServer(): void {
  const cli = process.env.TW_TERMINAL_CONTROL_CLI?.trim()
    || process.env.TW_DASHBOARD_CLI?.trim()
    || process.argv[1];
  if (!cli) throw new Error("cannot locate tw CLI to start terminal-control server");
  const child = spawn(process.execPath, [cli, "terminal-control", "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function sendRequest(
  socketPath: string,
  request: TerminalControlRequest,
  timeoutMs: number,
): Promise<TerminalControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let settled = false;
    let buffer = "";
    const finish = (error?: Error, response?: TerminalControlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => {
      finish(new Error("terminal-control request timed out"));
    }, timeoutMs);
    timer.unref();
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
    response = await sendRequest(socketPath, request, timeoutMs);
  } catch (error) {
    if (options.autoStart === false || !(error instanceof Error) || !clientError(error as NodeJS.ErrnoException)) {
      throw error;
    }
    startServer();
    const deadline = Date.now() + Math.min(timeoutMs, 5_000);
    while (true) {
      try {
        response = await sendRequest(socketPath, request, timeoutMs);
        break;
      } catch (retryError) {
        if (!(retryError instanceof Error) || !clientError(retryError as NodeJS.ErrnoException) || Date.now() >= deadline) {
          throw retryError;
        }
        await delay(25);
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
