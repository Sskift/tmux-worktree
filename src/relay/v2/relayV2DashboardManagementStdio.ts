import { stdin, stdout } from "node:process";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_MAX_FRAME_PAYLOAD_BYTES,
  RelayV2DashboardManagementProtocolError,
  createRelayV2DashboardManagementDefaultOffHandler,
  decodeRelayV2DashboardManagementRequest,
  encodeRelayV2DashboardManagementReadyFrame,
  encodeRelayV2DashboardManagementResponseFrame,
} from "./relayV2DashboardManagementProtocol.js";

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

/**
 * Owns only the bounded stdin/stdout channel. All malformed input closes the
 * channel silently with 64; no raw input reaches logs, errors, or responses.
 */
export async function runRelayV2DashboardManagementStdio(
  runtimeVersion: string,
): Promise<number> {
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let readyFrame: string;
  let handler: ReturnType<typeof createRelayV2DashboardManagementDefaultOffHandler>;

  try {
    handler = createRelayV2DashboardManagementDefaultOffHandler();
    readyFrame = encodeRelayV2DashboardManagementReadyFrame(runtimeVersion);
  } catch {
    return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
  }

  const ignoreStdoutError = (): void => {};
  stdout.on("error", ignoreStdoutError);

  try {
    await writeFrame(readyFrame);

    for await (const chunk of stdin) {
      if (!(chunk instanceof Uint8Array)) {
        return RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
      }
      let start = 0;
      while (start < chunk.byteLength) {
        const lineFeed = chunk.indexOf(0x0a, start);
        const end = lineFeed === -1 ? chunk.byteLength : lineFeed;
        const segmentBytes = end - start;
        if (pendingBytes + segmentBytes
          > RELAY_V2_DASHBOARD_MANAGEMENT_MAX_FRAME_PAYLOAD_BYTES) {
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
        let request;
        try {
          request = decodeRelayV2DashboardManagementRequest(framePayload);
        } catch (error) {
          if (error instanceof RelayV2DashboardManagementProtocolError) {
            return RELAY_V2_DASHBOARD_MANAGEMENT_BAD_REQUEST_EXIT_CODE;
          }
          throw error;
        }
        const response = handler.handle(request);
        await writeFrame(encodeRelayV2DashboardManagementResponseFrame(response));
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
