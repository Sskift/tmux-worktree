import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn as cpSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { networkInterfaces, homedir, tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  requestTerminalControl,
  TERMINAL_CONTROL_RENEW_INTERVAL_MS,
  TerminalControlProtocolError,
  type TerminalControlLease,
} from "./terminalControl/index.js";
import html from "./serveWebClient.html";
import ptyBridgeScript from "./servePtyBridge.py";

const DEFAULT_PORT = 8311;
const AUTH_BODY_LIMIT_BYTES = 4096;
const SESSION_NAME_MAX_LENGTH = 128;
const PANE_INDEX_MAX = 65_535;
const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 300;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 200;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_REQUEST_URL_BYTES = 8192;
const MAX_ACTIVE_TERMINAL_BRIDGES = 8;
const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_STDIN_BYTES = 256 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const MIN_RECOMMENDED_TOKEN_BYTES = 16;
const SESSION_COOKIE_NAME = "tw_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 28_800;
const SESSION_MAX_AGE_MS = SESSION_COOKIE_MAX_AGE_SECONDS * 1000;
const MAX_BROWSER_SESSIONS = 64;

function secretDigest(domain: string, value: string): Buffer {
  return createHash("sha256")
    .update(`tmux-worktree/serve/${domain}/v1\0`, "utf8")
    .update(value, "utf8")
    .digest();
}

function secretMatches(domain: string, candidate: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(secretDigest(domain, candidate), expectedDigest);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

function hasStrictWebSocketOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  if (/[\0-\x20\x7f]/.test(host)) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin === origin
      && parsed.host === host;
  } catch {
    return false;
  }
}

function serveToken(): string {
  const configured = process.env.TW_TOKEN;
  if (configured !== undefined && /[\0\r\n]/.test(configured)) {
    throw new Error("TW_TOKEN must not contain NUL, carriage return, or line feed characters");
  }
  if (configured) {
    if (Buffer.byteLength(configured, "utf8") < MIN_RECOMMENDED_TOKEN_BYTES) {
      console.warn(
        `[tw serve] warning: TW_TOKEN is shorter than ${MIN_RECOMMENDED_TOKEN_BYTES} bytes; accepted for compatibility`,
      );
    }
    return configured;
  }
  return randomBytes(32).toString("base64url");
}

function publishServeToken(tokenFile: string, token: string): void {
  const directory = dirname(tokenFile);
  const temporaryFile = join(
    directory,
    `.${basename(tokenFile)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd = -1;
  try {
    fd = openSync(temporaryFile, "wx", 0o600);
    chmodSync(temporaryFile, 0o600);
    const contents = Buffer.from(token, "utf8");
    writeSync(fd, contents, 0, contents.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(temporaryFile, tokenFile);
    chmodSync(tokenFile, 0o600);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch {}
    }
    try { rmSync(temporaryFile, { force: true }); } catch {}
  }
}

function tmuxOutput(tmux: string, args: string[]): string {
  return execFileSync(tmux, args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function runTmux(args: string[]): string {
  try {
    return tmuxOutput(tmuxBin(), args);
  } catch {
    return "";
  }
}

function tmuxBin(): string {
  const configured = process.env.TW_TMUX?.trim();
  if (configured) return configured;
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch {}
  }
  return "tmux";
}

function requestUrl(req: IncomingMessage): URL | null {
  try {
    const rawUrl = req.url || "/";
    if (Buffer.byteLength(rawUrl, "utf8") > MAX_REQUEST_URL_BYTES) return null;
    return new URL(rawUrl, "http://localhost");
  } catch {
    return null;
  }
}

function validatedSessionName(value: string | null): string | null {
  if (value === null || !value.trim() || value.length > SESSION_NAME_MAX_LENGTH) return null;
  if (/[\0-\x1f\x7f]/.test(value)) return null;
  return value;
}

function decodedSessionName(value: string): string | null {
  try {
    return validatedSessionName(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function validatedPaneIndex(value: string | null): string | null {
  const candidate = value ?? "0";
  if (!/^(?:0|[1-9]\d*)$/.test(candidate)) return null;
  const paneIndex = Number(candidate);
  if (!Number.isSafeInteger(paneIndex) || paneIndex > PANE_INDEX_MAX) return null;
  return String(paneIndex);
}

function attachTargetExists(tmux: string, sessionName: string, paneIndex: string): boolean {
  try {
    const panes = tmuxOutput(tmux, ["list-panes", "-t", `=${sessionName}`, "-F", "#{pane_index}"])
      .split("\n")
      .filter(Boolean);
    if (panes.length === 0) return false;
    return paneIndex === "0" || panes.includes(paneIndex);
  } catch {
    return false;
  }
}

type TerminalSize = { cols: number; rows: number };

function parsedResizeMessage(value: unknown): TerminalSize | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "cols") || !Object.hasOwn(record, "rows")) return null;
  if (!Number.isSafeInteger(record.cols) || !Number.isSafeInteger(record.rows)) return null;
  const cols = record.cols as number;
  const rows = record.rows as number;
  if (cols < MIN_TERMINAL_COLS || cols > MAX_TERMINAL_COLS) return null;
  if (rows < MIN_TERMINAL_ROWS || rows > MAX_TERMINAL_ROWS) return null;
  return { cols, rows };
}

function writeTerminalSize(fd: number, size: TerminalSize): void {
  const contents = Buffer.from(`${size.cols},${size.rows}`, "utf8");
  ftruncateSync(fd, 0);
  writeSync(fd, contents, 0, contents.length, 0);
}

type Session = {
  name: string;
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
};

type Pane = {
  index: number;
  width: number;
  height: number;
  command: string;
  title: string;
  active: boolean;
};

function listSessions(): Session[] {
  const fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}";
  const raw = runTmux(["list-sessions", "-F", fmt]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [name, att, win, cre, act] = line.split("\x1f");
    return {
      name,
      attached: att === "1",
      windows: parseInt(win) || 0,
      created: parseInt(cre) || 0,
      activity: parseInt(act) || 0,
    };
  }).filter(s => !s.name.startsWith("tw-term-") && !s.name.startsWith("tw-mobile-"));
}

type PlainTerminal = { id: string; label: string; cwd: string; tmuxName: string };

function listTerminals(): PlainTerminal[] {
  const file = join(homedir(), ".tw-dashboard-terminals.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function listPanes(sessionName: string): Pane[] {
  const fmt = "#{pane_index}\x1f#{pane_width}\x1f#{pane_height}\x1f#{pane_current_command}\x1f#{pane_title}\x1f#{pane_active}";
  const raw = runTmux(["list-panes", "-t", `=${sessionName}`, "-F", fmt]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [idx, w, h, cmd, title, active] = line.split("\x1f");
    return {
      index: parseInt(idx) || 0,
      width: parseInt(w) || 0,
      height: parseInt(h) || 0,
      command: cmd || "",
      title: title || "",
      active: active === "1",
    };
  });
}

function sessionCwd(name: string): string {
  return runTmux(["display-message", "-t", `=${name}`, "-p", "#{pane_current_path}"]);
}

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "localhost";
}

function json(
  res: ServerResponse,
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const path = url.pathname;

  if (path === "/api/sessions") {
    json(res, listSessions());
    return true;
  }

  if (path === "/api/terminals") {
    json(res, listTerminals());
    return true;
  }

  const panesMatch = path.match(/^\/api\/sessions\/([^/]+)\/panes$/);
  if (panesMatch) {
    const name = decodedSessionName(panesMatch[1]);
    if (!name) {
      json(res, { error: "invalid session" }, 400);
      return true;
    }
    json(res, listPanes(name));
    return true;
  }

  const cwdMatch = path.match(/^\/api\/sessions\/([^/]+)\/cwd$/);
  if (cwdMatch) {
    const name = decodedSessionName(cwdMatch[1]);
    if (!name) {
      json(res, { error: "invalid session" }, 400);
      return true;
    }
    const cwd = sessionCwd(name);
    json(res, { cwd });
    return true;
  }

  const cancelMatch = path.match(/^\/api\/sessions\/([^/]+)\/cancel-copy-mode$/);
  if (cancelMatch && req.method === "POST") {
    const name = decodedSessionName(cancelMatch[1]);
    if (!name) {
      json(res, { error: "invalid session" }, 400);
      return true;
    }
    runTmux(["send-keys", "-t", `=${name}`, "-X", "cancel"]);
    json(res, { ok: true });
    return true;
  }

  return false;
}

export async function run() {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const portIdx = process.argv.indexOf("--port");
  const port = portArg
    ? parseInt(portArg.split("=")[1])
    : portIdx >= 0
      ? parseInt(process.argv[portIdx + 1])
      : DEFAULT_PORT;
  const hostArg = process.argv.find((argument) => argument.startsWith("--host="));
  const hostIdx = process.argv.indexOf("--host");
  const bindHost = (hostArg
    ? hostArg.slice("--host=".length)
    : hostIdx >= 0
      ? process.argv[hostIdx + 1]
      : "0.0.0.0")?.trim();
  if (!bindHost || /[\0\r\n]/.test(bindHost) || bindHost.startsWith("--")) {
    throw new Error("tw serve --host requires a valid host name or IP address");
  }

  const token = serveToken();
  const controlInstanceId = randomUUID();
  const controlAutoStart = process.env.TW_TERMINAL_CONTROL_AUTOSTART !== "0";
  const tokenDigest = secretDigest("token", token);
  const tokenFile = (process.env.HOME || "/tmp") + "/.tw-serve-token";
  if (process.argv.includes("--remote")) {
    throw new Error("tw serve --remote has been removed. Use tw relay-server on a broker and tw relay-host on the Mac admin machine.");
  }

  const browserSessions = new Map<string, { expiresAt: number }>();
  let legacyQueryWarningEmitted = false;

  function purgeExpiredBrowserSessions(now: number): void {
    for (const [digest, session] of browserSessions) {
      if (session.expiresAt <= now) browserSessions.delete(digest);
    }
  }

  function issueBrowserSession(): string {
    const now = Date.now();
    purgeExpiredBrowserSessions(now);
    while (browserSessions.size >= MAX_BROWSER_SESSIONS) {
      const oldest = browserSessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      browserSessions.delete(oldest);
    }
    let sessionId: string;
    let digest: string;
    do {
      sessionId = randomBytes(32).toString("base64url");
      digest = secretDigest("browser-session", sessionId).toString("base64url");
    } while (browserSessions.has(digest));
    browserSessions.set(digest, { expiresAt: now + SESSION_MAX_AGE_MS });
    return sessionId;
  }

  function hasBrowserSession(req: IncomingMessage): boolean {
    const sessionId = cookieValue(req, SESSION_COOKIE_NAME);
    if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return false;
    const now = Date.now();
    purgeExpiredBrowserSessions(now);
    const digest = secretDigest("browser-session", sessionId).toString("base64url");
    const session = browserSessions.get(digest);
    if (!session || session.expiresAt <= now) {
      browserSessions.delete(digest);
      return false;
    }
    browserSessions.delete(digest);
    browserSessions.set(digest, session);
    return true;
  }

  function checkAuth(req: IncomingMessage, url: URL, webSocket = false): boolean {
    const authorization = req.headers.authorization;
    if (
      typeof authorization === "string"
      && authorization.startsWith("Bearer ")
      && secretMatches("token", authorization.slice("Bearer ".length), tokenDigest)
    ) return true;

    if ((!webSocket || hasStrictWebSocketOrigin(req)) && hasBrowserSession(req)) return true;

    const queryToken = url.searchParams.get("token");
    if (
      queryToken !== null
      && secretMatches("token", queryToken, tokenDigest)
      && req.headers.origin === undefined
      && isLoopbackAddress(req.socket.remoteAddress)
    ) {
      if (!legacyQueryWarningEmitted) {
        legacyQueryWarningEmitted = true;
        console.warn("[tw serve] warning: loopback query-token authentication is deprecated");
      }
      return true;
    }
    return false;
  }

  const server = createServer((req, res) => {
    const url = requestUrl(req);
    if (!url) {
      json(res, { error: "bad request" }, 400);
      return;
    }
    const path = url.pathname;

    // Auth endpoint - no token required
    if (path === "/api/auth" && req.method === "POST") {
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let tooLarge = false;
      const contentLength = req.headers["content-length"];
      if (
        typeof contentLength === "string"
        && /^\d+$/.test(contentLength)
        && Number(contentLength) > AUTH_BODY_LIMIT_BYTES
      ) {
        tooLarge = true;
        json(res, { ok: false, error: "request body too large" }, 413);
      }
      req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > AUTH_BODY_LIMIT_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          json(res, { ok: false, error: "request body too large" }, 413);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) return;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            json(res, { ok: false, error: "bad request" }, 400);
            return;
          }
          const submittedToken = (data as Record<string, unknown>).token;
          if (
            typeof submittedToken === "string"
            && secretMatches("token", submittedToken, tokenDigest)
          ) {
            const sessionId = issueBrowserSession();
            json(res, { ok: true }, 200, {
              "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
            });
          } else {
            json(res, { ok: false, error: "invalid token" }, 401);
          }
        } catch {
          json(res, { ok: false, error: "bad request" }, 400);
        }
      });
      req.on("error", () => {
        if (!tooLarge && !res.writableEnded) json(res, { ok: false, error: "bad request" }, 400);
      });
      return;
    }

    // All other API routes require auth
    if (path.startsWith("/api/")) {
      if (!checkAuth(req, url)) {
        json(res, { error: "unauthorized" }, 401);
        return;
      }
      if (handleApi(req, res, url)) return;
      json(res, { error: "not found" }, 404);
      return;
    }

    // HTML page - always served (contains auth UI)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_WS_PAYLOAD_BYTES });
  let activeTerminalBridges = 0;

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const url = requestUrl(req);
    if (!url) {
      socket.close(4000, "bad request");
      return;
    }
    // Check token for WebSocket
    if (!checkAuth(req, url, true)) {
      socket.close(4001, "unauthorized");
      return;
    }

    const sessionName = validatedSessionName(url.searchParams.get("session"));
    if (!sessionName) {
      socket.close(4000, "invalid session param");
      return;
    }
    const paneIndex = validatedPaneIndex(url.searchParams.get("pane"));
    if (paneIndex === null) {
      socket.close(4000, "invalid pane param");
      return;
    }
    const controlSessionName = sessionName;
    const controlPaneIndex = paneIndex;

    if (activeTerminalBridges >= MAX_ACTIVE_TERMINAL_BRIDGES) {
      socket.close(4008, "terminal bridge limit reached");
      return;
    }
    const tmux = tmuxBin();
    if (!attachTargetExists(tmux, sessionName, paneIndex)) {
      socket.close(4004, "terminal target not found");
      return;
    }
    activeTerminalBridges += 1;
    let bridgeReservationActive = true;
    const releaseBridgeReservation = () => {
      if (!bridgeReservationActive) return;
      bridgeReservationActive = false;
      activeTerminalBridges -= 1;
    };
    const mobileId = "tw-mobile-" + randomBytes(4).toString("hex");
    const controlOwner = {
      kind: "tw-serve" as const,
      instanceId: `tw-serve:${controlInstanceId}:${mobileId}`,
    };
    let controlTargetId: string | undefined;
    let inputLease: TerminalControlLease | undefined;
    let nextControlOperation = 0;
    let inputQueue: Promise<void> = Promise.resolve();
    let queuedInputBytes = 0;
    let resizeDirectory = "";
    let resizeFile = "";
    let resizeFd = -1;
    try {
      resizeDirectory = mkdtempSync(join(tmpdir(), "tw-serve-resize-"));
      chmodSync(resizeDirectory, 0o700);
      resizeFile = join(resizeDirectory, "size");
      resizeFd = openSync(resizeFile, "wx+", 0o600);
      writeTerminalSize(resizeFd, { cols: 80, rows: 24 });
    } catch {
      if (resizeFd >= 0) {
        try { closeSync(resizeFd); } catch {}
      }
      if (resizeDirectory) {
        try { rmSync(resizeDirectory, { recursive: true, force: true }); } catch {}
      }
      releaseBridgeReservation();
      socket.close(1011, "failed to initialize terminal bridge");
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = cpSpawn("python3", [
        "-u",
        "-c",
        ptyBridgeScript,
        tmux,
        sessionName,
        mobileId,
        paneIndex,
        resizeFile,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch {
      try { closeSync(resizeFd); } catch {}
      try { rmSync(resizeDirectory, { recursive: true, force: true }); } catch {}
      releaseBridgeReservation();
      socket.close(1011, "failed to start terminal bridge");
      return;
    }

    let cleaned = false;
    let leaseReleaseScheduled = false;
    const leaseRenewalTimer = setInterval(() => {
      const lease = inputLease;
      if (cleaned || !lease) return;
      void requestTerminalControl<{ lease: TerminalControlLease }>(
        { type: "lease.renew", lease },
        { autoStart: controlAutoStart },
      ).then(
        (renewed) => {
          if (inputLease?.leaseId === lease.leaseId && inputLease.fence === lease.fence) {
            inputLease = renewed.lease;
          }
        },
        (error) => {
          if (inputLease?.leaseId === lease.leaseId && inputLease.fence === lease.fence) {
            inputLease = undefined;
            sendControlError(error);
          }
        },
      );
    }, TERMINAL_CONTROL_RENEW_INTERVAL_MS);
    leaseRenewalTimer.unref();
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(leaseRenewalTimer);
      try { child.kill(); } catch {}
      runTmux(["kill-session", "-t", `=${mobileId}`]);
      try { closeSync(resizeFd); } catch {}
      try { rmSync(resizeDirectory, { recursive: true, force: true }); } catch {}
      releaseBridgeReservation();
      scheduleInputLeaseRelease();
    }

    function closeForResourceLimit(reason: string) {
      if (socket.readyState === socket.OPEN) socket.close(4009, reason);
      cleanup();
    }

    function sendTerminalData(data: string): boolean {
      if (cleaned || socket.readyState !== socket.OPEN) return false;
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > MAX_SOCKET_BUFFERED_BYTES - socket.bufferedAmount) {
        closeForResourceLimit("terminal output buffer limit reached");
        return false;
      }
      try {
        socket.send(data, (error) => {
          if (error) cleanup();
        });
        return true;
      } catch {
        cleanup();
        return false;
      }
    }

    function sendControlError(error: unknown): void {
      const code = error instanceof TerminalControlProtocolError ? error.code : "INTERNAL";
      sendTerminalData(JSON.stringify({
        type: "control_error",
        code,
        message: error instanceof Error ? error.message : String(error),
      }));
    }

    async function ensureInputLease(): Promise<TerminalControlLease> {
      if (inputLease) return inputLease;
      if (!controlTargetId) {
        const resolved = await requestTerminalControl<{ controlTargetId: string }>(
          { type: "target.resolve", sessionName: controlSessionName },
          { autoStart: controlAutoStart },
        );
        controlTargetId = resolved.controlTargetId;
      }
      const acquired = await requestTerminalControl<{ lease: TerminalControlLease }>(
        { type: "lease.acquire", controlTargetId, owner: controlOwner },
        { autoStart: controlAutoStart },
      );
      inputLease = acquired.lease;
      return inputLease;
    }

    async function releaseInputLease(): Promise<void> {
      const lease = inputLease;
      inputLease = undefined;
      if (!lease) return;
      await requestTerminalControl(
        { type: "lease.release", lease },
        { autoStart: controlAutoStart },
      ).catch(() => undefined);
    }

    function scheduleInputLeaseRelease(): void {
      if (leaseReleaseScheduled) return;
      leaseReleaseScheduled = true;
      void inputQueue.finally(() => releaseInputLease());
    }

    function controlLeaseMustBeRevalidated(error: unknown): boolean {
      if (!(error instanceof TerminalControlProtocolError)) return true;
      return error.code !== "INVALID_REQUEST" && error.code !== "RESOURCE_EXHAUSTED";
    }

    function operationId(kind: string): string {
      nextControlOperation += 1;
      return `tw-serve:${controlInstanceId}:${mobileId}:${kind}:${nextControlOperation}`;
    }

    function applyAttachmentResize(size: TerminalSize): void {
      writeTerminalSize(resizeFd, size);
      child.kill("SIGWINCH");
    }

    async function handleControlledMessage(msg: string): Promise<void> {
      let parsed: unknown;
      try { parsed = JSON.parse(msg) as unknown; } catch {}
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const type = (parsed as { type?: unknown }).type;
        if (type === "resize" || type === "attachment_resize") {
          const size = parsedResizeMessage(parsed);
          if (!size || cleaned) return;
          try {
            if (type === "resize" && inputLease) {
              await requestTerminalControl({
                type: "input.resize",
                lease: inputLease,
                operationId: operationId("resize"),
                pane: controlPaneIndex,
                cols: size.cols,
                rows: size.rows,
              }, { autoStart: controlAutoStart });
            }
            applyAttachmentResize(size);
          } catch (error) {
            if (controlLeaseMustBeRevalidated(error)) inputLease = undefined;
            sendControlError(error);
          }
          return;
        }
      }
      if (cleaned) return;
      try {
        const lease = await ensureInputLease();
        if (cleaned) return;
        await requestTerminalControl({
          type: "input.raw",
          lease,
          operationId: operationId("input"),
          pane: controlPaneIndex,
          dataBase64: Buffer.from(msg, "utf8").toString("base64"),
        }, { autoStart: controlAutoStart });
      } catch (error) {
        if (controlLeaseMustBeRevalidated(error)) inputLease = undefined;
        sendControlError(error);
      }
    }

    child.stdout!.on("data", (data: Buffer) => {
      sendTerminalData(data.toString("utf-8"));
    });

    child.stderr!.on("data", (_data: Buffer) => {});
    child.stdin!.on("error", cleanup);
    child.on("error", () => {
      cleanup();
      if (socket.readyState === socket.OPEN) socket.close(1011, "terminal bridge failed");
    });

    child.on("close", (code: number | null) => {
      const exitSent = sendTerminalData(JSON.stringify({ type: "exit", code: code ?? 0 }));
      cleanup();
      if (exitSent && socket.readyState === socket.OPEN) socket.close();
    });

    socket.on("message", (raw: Buffer | string) => {
      const msg = raw.toString();
      const messageBytes = Buffer.byteLength(msg, "utf8");
      if (messageBytes > MAX_TERMINAL_INPUT_BYTES) {
        closeForResourceLimit("terminal input message limit reached");
        return;
      }
      if (queuedInputBytes > MAX_PENDING_STDIN_BYTES - messageBytes) {
        closeForResourceLimit("terminal input buffer limit reached");
        return;
      }
      queuedInputBytes += messageBytes;
      inputQueue = inputQueue
        .then(() => handleControlledMessage(msg))
        .catch((error) => sendControlError(error))
        .finally(() => {
          // Keep a short admission window after completion so a burst of
          // independently delivered WebSocket frames cannot evade the bounded
          // queue merely because an immediate rejection resolves between them.
          setTimeout(() => { queuedInputBytes -= messageBytes; }, 25);
        });
    });

    socket.on("close", () => {
      cleanup();
    });
    socket.on("error", cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      try {
        publishServeToken(tokenFile, token);
      } catch (error) {
        server.close(() => reject(error));
        return;
      }

      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, bindHost);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });

  {
    console.log(`\ntw-dashboard web server running at:\n`);
    console.log(`  Listen:  http://${bindHost}:${port}`);
    if (bindHost === "0.0.0.0" || bindHost === "::") {
      console.log(`  Network: http://${getLanIp()}:${port}`);
    }
    console.log(`  Token:   ${token}\n`);

    console.log(`Open the Network URL on your phone and enter the token to connect.\n`);
  }
}
