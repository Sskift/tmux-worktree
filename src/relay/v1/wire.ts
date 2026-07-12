export function parseJsonMessage(raw: unknown): unknown {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return JSON.parse(text);
}

export function sendJson(socket: { send(data: string): void }, message: unknown): void {
  socket.send(JSON.stringify(message));
}

export function isValidHostId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

export function isSafeRelayPath(path: string): boolean {
  return path === "/host" || path === "/client";
}
