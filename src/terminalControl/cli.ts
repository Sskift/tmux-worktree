import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { requestTerminalControl } from "./client";
import {
  TERMINAL_CONTROL_MAX_FRAME_BYTES,
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  parseTerminalControlRequest,
  terminalControlErrorResponse,
} from "./protocol";
import { runTerminalControlServer } from "./server";

async function readOneFrame(): Promise<string> {
  stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > TERMINAL_CONTROL_MAX_FRAME_BYTES) {
      throw new Error("terminal-control request exceeds the frame limit");
    }
  }
  const lines = input.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) throw new Error("terminal-control request expects exactly one JSON line");
  return lines[0];
}

export async function terminalControlCmd(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "serve") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await runTerminalControlServer({ signal: controller.signal });
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
    return;
  }
  if (command === "request") {
    const decoded = JSON.parse(await readOneFrame()) as unknown;
    const request = parseTerminalControlRequest(decoded);
    const { protocolVersion: _protocolVersion, requestId: _requestId, ...input } = request;
    try {
      const result = await requestTerminalControl(input, { autoStart: true });
      stdout.write(`${JSON.stringify({
        protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result,
      })}\n`);
    } catch (error) {
      stdout.write(`${JSON.stringify(terminalControlErrorResponse(request.requestId, error))}\n`);
    }
    return;
  }
  if (command === "resolve") {
    const sessionName = args[1];
    if (!sessionName) throw new Error("usage: tw terminal-control resolve <managed-session>");
    const result = await requestTerminalControl({ type: "target.resolve", sessionName });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    const controlTargetId = args[1];
    if (!controlTargetId) throw new Error("usage: tw terminal-control status <control-target-id>");
    const result = await requestTerminalControl({ type: "ownership.status", controlTargetId });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "acquire-local") {
    const controlTargetId = args[1];
    if (!controlTargetId) throw new Error("usage: tw terminal-control acquire-local <control-target-id>");
    const result = await requestTerminalControl({
      type: "lease.acquire",
      controlTargetId,
      owner: { kind: "local-cli", instanceId: `local-cli:${process.pid}:${randomUUID()}` },
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(
    "usage: tw terminal-control serve|request|resolve <session>|status <target>|acquire-local <target>",
  );
}
