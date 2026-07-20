import { stdin, stdout } from "node:process";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_MAX_FRAME_PAYLOAD_BYTES,
  RelayV2DashboardManagementProtocolError,
  createRelayV2DashboardManagementDefaultOffHandler,
  decodeRelayV2DashboardManagementRequest,
  encodeRelayV2DashboardManagementReadyFrame,
  encodeRelayV2DashboardManagementResponseFrame,
} from "./relayV2DashboardManagementProtocol.js";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES,
  RelayV2DashboardManagementProtocolV2Error,
  decodeRelayV2DashboardManagementProtocolV2Request,
  encodeRelayV2DashboardManagementProtocolV2ReadyFrame,
  encodeRelayV2DashboardManagementProtocolV2ResponseFrame,
  type RelayV2DashboardManagementProtocolV2Handler,
  type RelayV2DashboardManagementProtocolV2Request,
  type RelayV2DashboardManagementProtocolV2Response,
} from "./relayV2DashboardManagementProtocolV2.js";

export const RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE = 64;
export const RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE = 1;

function writeFrame(frame: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write(frame, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

interface RelayV2DashboardManagementStdioProtocol<Request, Response> {
  readonly maxFramePayloadBytes: number;
  readonly decodeRequest: (framePayload: Uint8Array) => Request;
  readonly encodeReadyFrame: (runtimeVersion: string) => string;
  readonly encodeResponseFrame: (response: Response, request: Request) => string;
  readonly isProtocolError: (error: unknown) => boolean;
}

export interface RelayV2DashboardManagementStdioIo {
  readonly input: AsyncIterable<Uint8Array>;
  readonly writeFrame: (frame: string) => Promise<void>;
}

export interface RelayV2DashboardManagementProtocolV2StdioSession {
  run(): Promise<number>;
}

async function runSingleProtocolSession<Request, Response>(options: {
  runtimeVersion: string;
  protocol: RelayV2DashboardManagementStdioProtocol<Request, Response>;
  handler: { handle(request: Request): Response | Promise<Response> };
  io: RelayV2DashboardManagementStdioIo;
}): Promise<number> {
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let readyFrame: string;

  try {
    readyFrame = options.protocol.encodeReadyFrame(options.runtimeVersion);
  } catch {
    return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  }

  try {
    await options.io.writeFrame(readyFrame);

    for await (const chunk of options.io.input) {
      if (!(chunk instanceof Uint8Array)) {
        return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
      }
      let start = 0;
      while (start < chunk.byteLength) {
        const lineFeed = chunk.indexOf(0x0a, start);
        const end = lineFeed === -1 ? chunk.byteLength : lineFeed;
        const segmentBytes = end - start;
        if (pendingBytes + segmentBytes > options.protocol.maxFramePayloadBytes) {
          return RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE;
        }
        if (segmentBytes > 0) {
          pendingChunks.push(Buffer.from(chunk.subarray(start, end)));
          pendingBytes += segmentBytes;
        }
        if (lineFeed === -1) break;

        const framePayload = Buffer.concat(pendingChunks, pendingBytes);
        pendingChunks = [];
        pendingBytes = 0;
        let request: Request;
        try {
          request = options.protocol.decodeRequest(framePayload);
        } catch (error) {
          if (options.protocol.isProtocolError(error)) {
            return RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE;
          }
          throw error;
        }
        // Awaiting the handler and complete write before reading the next
        // logical frame is the sole serialization point for either protocol.
        const response = await options.handler.handle(request);
        await options.io.writeFrame(options.protocol.encodeResponseFrame(response, request));
        start = lineFeed + 1;
      }
    }

    return pendingBytes === 0
      ? 0
      : RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE;
  } catch {
    return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  }
}

/**
 * Test/composition factory for exactly protocol v2. It has no CLI, argv,
 * environment, config, stdio default, respawn, retry, or fallback callsite.
 */
export function createRelayV2DashboardManagementProtocolV2StdioSession(options: {
  runtimeVersion: string;
  handler: RelayV2DashboardManagementProtocolV2Handler;
  io: RelayV2DashboardManagementStdioIo;
}): RelayV2DashboardManagementProtocolV2StdioSession {
  const protocol: RelayV2DashboardManagementStdioProtocol<
    RelayV2DashboardManagementProtocolV2Request,
    RelayV2DashboardManagementProtocolV2Response
  > = Object.freeze({
    maxFramePayloadBytes:
      RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES,
    decodeRequest: decodeRelayV2DashboardManagementProtocolV2Request,
    encodeReadyFrame: encodeRelayV2DashboardManagementProtocolV2ReadyFrame,
    encodeResponseFrame: (response, request) => (
      encodeRelayV2DashboardManagementProtocolV2ResponseFrame(
        response,
        request,
      )
    ),
    isProtocolError: (error) => (
      error instanceof RelayV2DashboardManagementProtocolV2Error
    ),
  });
  return Object.freeze({
    run: () => runSingleProtocolSession({
      runtimeVersion: options.runtimeVersion,
      protocol,
      handler: options.handler,
      io: options.io,
    }),
  });
}

/**
 * Owns only the bounded stdin/stdout channel. All malformed input closes the
 * channel silently with 64; no raw input reaches logs, errors, or responses.
 */
export async function runRelayV2DashboardManagementStdio(
  runtimeVersion: string,
): Promise<number> {
  const handler = createRelayV2DashboardManagementDefaultOffHandler();

  const ignoreStdoutError = (): void => {};
  stdout.on("error", ignoreStdoutError);
  return runSingleProtocolSession({
    runtimeVersion,
    protocol: Object.freeze({
      maxFramePayloadBytes: RELAY_V2_DASHBOARD_MANAGEMENT_MAX_FRAME_PAYLOAD_BYTES,
      decodeRequest: decodeRelayV2DashboardManagementRequest,
      encodeReadyFrame: encodeRelayV2DashboardManagementReadyFrame,
      encodeResponseFrame: (response) => (
        encodeRelayV2DashboardManagementResponseFrame(response)
      ),
      isProtocolError: (error) => error instanceof RelayV2DashboardManagementProtocolError,
    }),
    handler,
    io: Object.freeze({ input: stdin, writeFrame }),
  });
}
