import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES } from "./brokerHostWssAdapter.js";
import type {
  RelayV2BrokerHostNativeUpgradeCallback,
  RelayV2BrokerHostNativeUpgradePort,
  RelayV2BrokerHostPendingUpgradeSocket,
} from "./brokerHostWssUpgradeAuthority.js";

const HOST_SUBPROTOCOL = "tw-relay.host.v2";

export interface RelayV2BrokerHostWssNodeNoServerAdapter {
  readonly trustedSocketPrototype: typeof WebSocket.prototype;
  readonly nativeUpgrade: RelayV2BrokerHostNativeUpgradePort;
  closeAndDrain(): Promise<void>;
}

function failure(): Error {
  return new Error("Relay v2 Broker Host noServer Upgrade failed");
}

function hasExactHostProtocol(request: object): boolean {
  try {
    const headers = (request as IncomingMessage).headers;
    const offered = headers?.["sec-websocket-protocol"];
    if (typeof offered !== "string") return false;
    const protocols = offered.split(",").map((protocol) => protocol.trim());
    return protocols.length === 1 && protocols[0] === HOST_SUBPROTOCOL;
  } catch {
    return false;
  }
}

function equivalentBufferView(head: Uint8Array): Buffer {
  return Buffer.isBuffer(head)
    ? head
    : Buffer.from(head.buffer, head.byteOffset, head.byteLength);
}

/**
 * Default-off Node `ws` noServer adapter for the B7h native Upgrade port.
 * It creates no listener and owns neither raw-socket cleanup nor accepted sockets.
 */
export function createRelayV2BrokerHostWssNodeNoServerAdapter():
RelayV2BrokerHostWssNodeNoServerAdapter {
  const handleProtocols = (protocols: Set<string>): string => {
    if (protocols.size !== 1 || !protocols.has(HOST_SUBPROTOCOL)) throw failure();
    return HOST_SUBPROTOCOL;
  };
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES,
    handleProtocols,
  });

  let lifecycle: "open" | "closing" | "closed" = "open";
  let activeUpgrades = 0;
  let closeStarted = false;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let rejectClose: ((error: Error) => void) | null = null;
  let nativeUpgrade!: RelayV2BrokerHostNativeUpgradePort;
  let adapter!: RelayV2BrokerHostWssNodeNoServerAdapter;

  const finishClose = (): void => {
    if (lifecycle !== "closing" || activeUpgrades !== 0 || closeStarted) return;
    closeStarted = true;
    try {
      webSocketServer.close((error) => {
        lifecycle = "closed";
        if (error) rejectClose?.(failure());
        else resolveClose?.();
        resolveClose = null;
        rejectClose = null;
      });
    } catch {
      lifecycle = "closed";
      rejectClose?.(failure());
      resolveClose = null;
      rejectClose = null;
    }
  };

  const handleUpgrade = function handleUpgrade(
    this: unknown,
    request: object,
    socket: RelayV2BrokerHostPendingUpgradeSocket,
    head: Uint8Array,
    callback: RelayV2BrokerHostNativeUpgradeCallback,
  ): undefined {
    if (this !== nativeUpgrade || lifecycle !== "open") throw failure();

    activeUpgrades += 1;
    try {
      if (
        request === null
        || typeof request !== "object"
        || socket === null
        || typeof socket !== "object"
        || !(head instanceof Uint8Array)
        || typeof callback !== "function"
        || !hasExactHostProtocol(request)
        || lifecycle !== "open"
      ) throw failure();

      try {
        webSocketServer.handleUpgrade(
          request as IncomingMessage,
          socket as Duplex,
          equivalentBufferView(head),
          (webSocket, callbackRequest) => {
            if (callbackRequest !== request) throw failure();
            Reflect.apply(callback, undefined, [webSocket, callbackRequest]);
          },
        );
      } catch {
        throw failure();
      }
      return undefined;
    } finally {
      activeUpgrades -= 1;
      finishClose();
    }
  };

  const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
    if (this !== adapter) {
      const rejected = Promise.reject(failure());
      void rejected.catch(() => undefined);
      return rejected;
    }
    if (closePromise) return closePromise;
    lifecycle = "closing";
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void closePromise.catch(() => undefined);
    finishClose();
    return closePromise;
  };

  nativeUpgrade = Object.freeze(Object.assign(Object.create(null), {
    handleUpgrade,
  })) as RelayV2BrokerHostNativeUpgradePort;
  adapter = Object.freeze(Object.assign(Object.create(null), {
    trustedSocketPrototype: WebSocket.prototype,
    nativeUpgrade,
    closeAndDrain,
  })) as RelayV2BrokerHostWssNodeNoServerAdapter;
  return adapter;
}
