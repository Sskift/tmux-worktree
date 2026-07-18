import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleRelayV2BrokerCredentialHttpIngress,
  RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
  RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH,
  RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
  RELAY_V2_BROKER_SELF_REVOKE_PATH,
  type RelayV2BrokerCredentialHttpIngressAuthorityPort,
} from "./brokerCredentialHttpIngress.js";
import type {
  RelayV2BrokerCredentialHttpBody,
  RelayV2BrokerCredentialHttpHeader,
  RelayV2BrokerCredentialHttpResponse,
} from "./brokerCredentialHttpBoundary.js";
import {
  handleRelayV2BrokerHostBootstrapHttpIngress,
  RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH,
  type RelayV2BrokerHostBootstrapAuthorityPort,
} from "./brokerHostBootstrapHttpIngress.js";

export interface RelayV2BrokerCredentialNodeHttpAdapterAuthorityPort
extends RelayV2BrokerCredentialHttpIngressAuthorityPort,
  RelayV2BrokerHostBootstrapAuthorityPort {}

class IncomingMessageBody implements RelayV2BrokerCredentialHttpBody {
  private iterationStarted = false;
  private completed = false;
  private cancelled = false;
  private drainStarted = false;
  private drainSettled = false;
  private drainListenersAttached = false;
  private readonly absorbRequestError = (): void => {
    if (this.cancelled) this.finishDrain();
  };
  private readonly finishDrain = (): void => {
    this.drainSettled = true;
    this.detachDrainListeners();
  };

  constructor(private readonly request: IncomingMessage) {
    request.on("error", this.absorbRequestError);
  }

  private detachRequestError(): void {
    this.request.off("error", this.absorbRequestError);
  }

  private detachDrainListeners(): void {
    this.request.off("end", this.finishDrain);
    this.request.off("close", this.finishDrain);
    this.drainListenersAttached = false;
    this.detachRequestError();
  }

  private attachDrainListeners(): void {
    if (this.drainListenersAttached) return;
    this.drainListenersAttached = true;
    this.request.once("end", this.finishDrain);
    this.request.once("close", this.finishDrain);
  }

  get requiresConnectionClose(): boolean {
    return this.cancelled;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.iterationStarted) {
      throw new Error("Relay v2 credential HTTP request body was already consumed");
    }
    this.iterationStarted = true;
    const upstream = this.request[Symbol.asyncIterator]();
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (this.cancelled) return { done: true, value: undefined };
        try {
          const item = await upstream.next();
          if (item.done) {
            if (this.request.complete !== true || this.request.aborted) {
              throw new Error("Relay v2 credential HTTP request body read failed");
            }
            this.completed = true;
            this.detachDrainListeners();
            return { done: true, value: undefined };
          }
          return { done: false, value: item.value as Uint8Array };
        } catch {
          throw new Error("Relay v2 credential HTTP request body read failed");
        }
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        this.cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    if (this.completed || this.request.destroyed || this.request.readableEnded) {
      this.drainSettled = true;
      this.detachDrainListeners();
      return;
    }
    this.attachDrainListeners();
    try {
      this.request.pause();
    } catch {
      // The response path still disables keep-alive before attempting a write.
    }
  }

  startPostResponseDrain(): void {
    if (
      !this.cancelled
      || this.completed
      || this.drainStarted
      || this.drainSettled
    ) return;
    if (this.request.destroyed || this.request.readableEnded || this.request.aborted) {
      this.drainSettled = true;
      this.detachDrainListeners();
      return;
    }
    this.drainStarted = true;
    this.attachDrainListeners();
    try {
      // Flowing mode discards unread bytes without aggregating them. The
      // response has already committed Connection: close before this runs.
      this.request.resume();
    } catch {
      this.finishDrain();
    }
  }

  abortAfterResponseFailure(): void {
    this.drainSettled = true;
    this.detachDrainListeners();
    if (!this.request.destroyed) {
      try { this.request.destroy(); } catch {}
    }
  }
}

function rawRequestHeaders(
  request: IncomingMessage,
): readonly RelayV2BrokerCredentialHttpHeader[] {
  const rawHeaders = request.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return [];
  const headers: RelayV2BrokerCredentialHttpHeader[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") return [];
    headers.push({ name, value });
  }
  return headers;
}

function writeResponseOnce(
  response: ServerResponse,
  result: RelayV2BrokerCredentialHttpResponse,
  body: IncomingMessageBody,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const closeConnection = body.requiresConnectionClose;
    const cleanup = (): void => {
      response.off("finish", onFinish);
      response.off("error", onFailure);
      response.off("close", onFailure);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onFinish = (): void => { settle(); };
    const onFailure = (): void => {
      body.abortAfterResponseFailure();
      settle(new Error("Relay v2 credential HTTP response write failed"));
    };

    if (
      response.headersSent
      || response.writableEnded
      || response.destroyed
    ) {
      onFailure();
      return;
    }

    response.once("finish", onFinish);
    response.once("error", onFailure);
    response.once("close", onFailure);
    try {
      const headers: Record<string, string> = {
        "Content-Type": result.headers["content-type"],
        "Cache-Control": result.headers["cache-control"],
      };
      if (closeConnection) {
        response.shouldKeepAlive = false;
        headers.Connection = "close";
      }
      response.writeHead(result.status, headers);
      if (settled) return;
      response.end(Buffer.from(
        result.body.buffer,
        result.body.byteOffset,
        result.body.byteLength,
      ));
      if (closeConnection) body.startPostResponseDrain();
    } catch {
      onFailure();
    }
  });
}

/**
 * Strict, unwired Node HTTP adapter for the five frozen credential endpoints.
 *
 * The raw request-target and raw header pairs are passed through without URL
 * normalization or header coalescing. `sourceKey` is supplied only by trusted
 * composition and is never inferred from request or socket state.
 */
export async function handleRelayV2BrokerCredentialNodeHttpRequest(
  authority: RelayV2BrokerCredentialNodeHttpAdapterAuthorityPort,
  sourceKey: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = request.url ?? "";
  const body = new IncomingMessageBody(request);
  const adaptedRequest = {
    method: request.method ?? "",
    path,
    headers: rawRequestHeaders(request),
    body,
  };
  let result: RelayV2BrokerCredentialHttpResponse;
  switch (path) {
    case RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH:
      result = await handleRelayV2BrokerHostBootstrapHttpIngress(
        authority,
        sourceKey,
        adaptedRequest,
      );
      break;
    case RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH:
    case RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH:
    case RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH:
    case RELAY_V2_BROKER_SELF_REVOKE_PATH:
    default:
      // Unknown raw targets use the existing closed 404 mapping and never
      // reach an authority method.
      result = await handleRelayV2BrokerCredentialHttpIngress(
        authority,
        sourceKey,
        adaptedRequest,
      );
  }
  await writeResponseOnce(response, result, body);
}
