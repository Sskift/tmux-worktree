import { once } from "node:events";
import { stdin, stdout } from "node:process";
import type { Writable } from "node:stream";
import {
  requestTerminalControl,
  type TerminalControlRequestInput,
} from "./client";
import {
  TERMINAL_CONTROL_MAX_FRAME_BYTES,
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  TerminalControlProtocolError,
  parseTerminalControlRequest,
  terminalControlErrorResponse,
  type TerminalControlRequest,
  type TerminalControlResponse,
} from "./protocol";

type ProxyRequest = (input: TerminalControlRequestInput) => Promise<unknown>;

async function writeFrame(output: Writable, response: TerminalControlResponse): Promise<void> {
  const frame = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(frame, "utf8") > TERMINAL_CONTROL_MAX_FRAME_BYTES) {
    throw new Error("terminal-control proxy response exceeds the frame limit");
  }
  if (!output.write(frame)) await once(output, "drain");
}

async function forwardFrame(frame: Buffer, requestFn: ProxyRequest): Promise<TerminalControlResponse> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(frame.toString("utf8"));
  } catch (error) {
    throw new Error(`terminal-control proxy received invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const request = parseTerminalControlRequest(decoded);
  const {
    protocolVersion: _protocolVersion,
    requestId: _requestId,
    ...input
  } = request as TerminalControlRequest;
  try {
    const result = await requestFn(input as TerminalControlRequestInput);
    return {
      protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result,
    };
  } catch (error) {
    // A v1 authority rejection is a correlated response and the proxy remains
    // usable. UDS errors and timeouts are transport failures: let them tear
    // down the proxy so Rust cannot mistake an uncertain raw input for a safe
    // domain error or reuse the channel.
    if (!(error instanceof TerminalControlProtocolError)) throw error;
    return terminalControlErrorResponse(request.requestId, error);
  }
}

export async function runTerminalControlProxy(options: {
  input?: AsyncIterable<Buffer | string>;
  output?: Writable;
  request?: ProxyRequest;
} = {}): Promise<void> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const requestFn = options.request
    ?? ((request) => requestTerminalControl(request, { autoStart: true }));
  let pending = Buffer.alloc(0);

  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline + 1 > TERMINAL_CONTROL_MAX_FRAME_BYTES) {
        throw new Error("terminal-control proxy request exceeds the frame limit");
      }
      let frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length === 0) {
        throw new Error("terminal-control proxy does not accept empty frames");
      }
      await writeFrame(output, await forwardFrame(frame, requestFn));
    }
    if (pending.length > TERMINAL_CONTROL_MAX_FRAME_BYTES) {
      throw new Error("terminal-control proxy request exceeds the frame limit");
    }
  }

  if (pending.length !== 0) {
    throw new Error("terminal-control proxy stdin closed with an incomplete frame");
  }
}
