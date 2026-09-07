import type { WebSocket } from "ws";

/**
 * Shared Node HTTP-upgrade plumbing for the broker WSS client ingress and
 * host upgrade adapters. Pure protocol-text helpers plus the socket heartbeat
 * attachment; no module-level state, safe to inline per bundle entry.
 */

/**
 * Splits a raw HTTP request target into pathname and search, rejecting
 * control characters, non-ASCII bytes, and the fragment separator. Returns
 * null when the target is not a safe origin-form path.
 */
export function splitRawRequestTarget(value: unknown): Readonly<{
  pathname: string;
  search: string;
}> | null {
  if (typeof value !== "string" || value.length === 0 || value[0] !== "/") return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f || code === 0x23) return null;
  }
  const query = value.indexOf("?");
  return Object.freeze({
    pathname: query === -1 ? value : value.slice(0, query),
    search: query === -1 ? "" : value.slice(query),
  });
}

/**
 * Trims optional whitespace (SP and HTAB) from both ends of a header value.
 */
export function trimHttpOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) === 0x20 || value.charCodeAt(start) === 0x09)) {
    start += 1;
  }
  while (end > start && (
    value.charCodeAt(end - 1) === 0x20
    || value.charCodeAt(end - 1) === 0x09
  )) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * Returns a Buffer view over `head`, reusing the Buffer when it already is
 * one instead of copying.
 */
export function equivalentBufferView(head: Uint8Array): Buffer {
  return Buffer.isBuffer(head)
    ? head
    : Buffer.from(head.buffer, head.byteOffset, head.byteLength);
}

/**
 * Resolves a heartbeat tuning value with a fallback, throwing the error
 * produced by `onInvalid` when the selected value is not a positive safe
 * integer.
 */
export function positiveHeartbeatValue(
  value: unknown,
  fallback: number,
  onInvalid: () => Error,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected)
    || (selected as number) <= 0
  ) throw onInvalid();
  return selected as number;
}

/**
 * Attaches a ping/pong heartbeat to a WebSocket. Each tick increments the
 * missed-pong counter; when it exceeds `missedPongLimit` the socket is
 * terminated. A pong resets the counter, and socket close cleans up.
 */
export function attachSocketHeartbeat(
  socket: WebSocket,
  intervalMs: number,
  missedPongLimit: number,
): void {
  let missedPongs = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    if (stopped) return;
    missedPongs += 1;
    if (missedPongs > missedPongLimit) {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      try { socket.terminate(); } catch {}
      return;
    }
    try { socket.ping(); } catch {}
  };
  const onPong = (): void => {
    missedPongs = 0;
  };
  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    try { socket.removeListener("pong", onPong); } catch {}
    try { socket.removeListener("close", cleanup); } catch {}
  };
  socket.on("pong", onPong);
  socket.once("close", cleanup);
  tick();
  timer = setInterval(tick, intervalMs);
}
