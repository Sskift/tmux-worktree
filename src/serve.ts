import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn as cpSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { networkInterfaces, homedir, tmpdir } from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>tw-dashboard</title>
<style>
:root {
  --bg: #0d0e10; --bg1: #14161a; --bg2: #1a1d23; --bg3: #22262e;
  --text: #e6e6e8; --dim: #9598a3; --faint: #5a5d68;
  --accent: #b794f6; --accent2: #f687b3;
  --line: rgba(255,255,255,0.06);
  --radius: 10px;
  color-scheme: dark;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; font-family: -apple-system, "SF Pro", system-ui, sans-serif; background: var(--bg); color: var(--text); overflow: hidden; -webkit-font-smoothing: antialiased; }
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); position: relative; }

.view { position: absolute; inset: 0; display: flex; flex-direction: column; height: 100%; opacity: 0; pointer-events: none; transition: opacity 0.18s ease; will-change: opacity; }
.view.active { opacity: 1; pointer-events: auto; }

.header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 12px; flex-shrink: 0; }
.header h1 { font-size: 20px; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.btn-icon { width: 36px; height: 36px; border: none; background: var(--bg2); color: var(--dim); border-radius: 50%; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.btn-icon:active { background: var(--bg3); }

.scroll-area { flex: 1; overflow-y: auto; padding: 0 16px 16px; -webkit-overflow-scrolling: touch; }
.card { background: var(--bg1); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: background 0.15s; }
.card:active { background: var(--bg2); }
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; font-family: "SF Mono", Menlo, monospace; }
.card-meta { font-size: 12px; color: var(--dim); }
.session-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.empty { text-align: center; color: var(--faint); padding: 60px 20px; font-size: 14px; }
.loading { text-align: center; color: var(--dim); padding: 60px 20px; font-size: 14px; }
.section-label { font-size: 11px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 0 6px; }

.toolbar { display: flex; align-items: center; padding: 10px 16px; gap: 12px; flex-shrink: 0; background: var(--bg1); border-bottom: 1px solid var(--line); }
.btn-back { width: 32px; height: 32px; border: none; background: var(--bg2); color: var(--dim); border-radius: 8px; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.btn-back:active { background: var(--bg3); }
.toolbar-title { font-size: 14px; font-weight: 600; font-family: "SF Mono", Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.term-wrapper { flex: 1; min-height: 0; position: relative; }
#terminal-container { position: absolute; inset: 0; background: var(--bg); }
#terminal-container .xterm { height: 100%; padding: 4px; }

.action-bar { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; padding: 6px 10px; background: rgba(20,22,26,0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid var(--line); border-radius: 12px; z-index: 10; overflow-x: auto; max-width: 90vw; -webkit-overflow-scrolling: touch; }
.action-btn { min-width: 40px; height: 34px; border: none; background: var(--bg2); color: var(--dim); border-radius: 8px; font-size: 12px; font-family: "SF Mono", Menlo, monospace; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0 10px; white-space: nowrap; }
.action-btn:active { background: var(--bg3); color: var(--text); }

.pane-icon { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; vertical-align: middle; background: var(--accent); opacity: 0.5; }
.pane-icon.active { opacity: 1; }
</style>
</head>
<body>

<div id="auth-view" class="view active">
  <div class="header">
    <h1>tw-dashboard</h1>
  </div>
  <div class="scroll-area" style="display:flex;align-items:center;justify-content:center;">
    <div style="text-align:center;width:260px;">
      <p style="color:var(--dim);margin-bottom:16px;font-size:14px;">Enter token to connect</p>
      <input id="auth-input" type="text" autocomplete="off" autocorrect="off" spellcheck="false" style="width:100%;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--line);background:var(--bg1);color:var(--text);font-size:16px;font-family:'SF Mono',Menlo,monospace;text-align:center;outline:none;" placeholder="token">
      <button id="auth-btn" style="width:100%;margin-top:12px;padding:12px;border:none;border-radius:var(--radius);background:var(--accent);color:#000;font-size:15px;font-weight:600;cursor:pointer;">Connect</button>
      <p id="auth-error" style="color:var(--accent2);margin-top:12px;font-size:13px;display:none;"></p>
    </div>
  </div>
</div>

<div id="list-view" class="view">
  <div class="header">
    <h1>tw-dashboard</h1>
    <button class="btn-icon" onclick="loadSessions()" aria-label="refresh">R</button>
  </div>
  <div class="scroll-area">
    <div class="section-label">Worktrees</div>
    <div id="sessions"><div class="loading">Loading...</div></div>
    <div class="section-label" id="terminals-label" style="display:none;">Terminals</div>
    <div id="terminals"></div>
  </div>
</div>

<div id="pane-view" class="view">
  <div class="toolbar">
    <button class="btn-back" onclick="showView('list')" aria-label="back">&lt;</button>
    <span id="pane-title" class="toolbar-title"></span>
  </div>
  <div id="panes" class="scroll-area"></div>
</div>

<div id="term-view" class="view">
  <div class="toolbar">
    <button class="btn-back" onclick="disconnect()" aria-label="back">&lt;</button>
    <span id="toolbar-title" class="toolbar-title"></span>
  </div>
  <div class="term-wrapper">
    <div id="terminal-container"></div>
    <div class="action-bar" id="action-bar">
      <button class="action-btn" id="btn-tab">Tab</button>
      <button class="action-btn" id="btn-ctrl-c">C-c</button>
      <button class="action-btn" id="btn-ctrl-d">C-d</button>
      <button class="action-btn" id="btn-ctrl-z">C-z</button>
    </div>
  </div>
</div>

<script>
(function() {
  var views = { auth: document.getElementById("auth-view"), list: document.getElementById("list-view"), pane: document.getElementById("pane-view"), term: document.getElementById("term-view") };
  var sessionsEl = document.getElementById("sessions");
  var terminalsEl = document.getElementById("terminals");
  var terminalsLabel = document.getElementById("terminals-label");
  var panesEl = document.getElementById("panes");
  var paneTitleEl = document.getElementById("pane-title");
  var titleEl = document.getElementById("toolbar-title");
  var termContainer = document.getElementById("terminal-container");
  var actionBar = document.getElementById("action-bar");

  var term = null, fitAddon = null, ws = null, ro = null, xtermLoaded = null;
  var currentSession = null;

  function showView(name) {
    for (var k in views) views[k].classList.toggle("active", k === name);
  }
  window.showView = showView;

  function authFetch(url, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    return fetch(url, opts);
  }

  // --- Auth ---
  function tryAuth(token) {
    return fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token }) })
      .then(function(r) { return r.json(); })
      .then(function(d) { return d.ok === true; });
  }

  document.getElementById("auth-btn").addEventListener("click", function() {
    var input = document.getElementById("auth-input");
    var err = document.getElementById("auth-error");
    var val = input.value.trim();
    if (!val) { err.textContent = "Please enter token"; err.style.display = "block"; return; }
    tryAuth(val).then(function(ok) {
      if (ok) {
        input.value = "";
        err.style.display = "none";
        showView("list");
        loadSessions();
      } else {
        err.textContent = "Invalid token"; err.style.display = "block";
      }
    }).catch(function() {
      err.textContent = "Connection failed"; err.style.display = "block";
    });
  });

  document.getElementById("auth-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter") document.getElementById("auth-btn").click();
  });

  // Reuse an unexpired same-origin HttpOnly session without exposing the token to JavaScript.
  authFetch("/api/sessions").then(function(response) {
    if (response.ok) { showView("list"); loadSessions(); }
  }).catch(function() {});

  function ago(ts) {
    var s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  var COLORS = ["#f687b3","#9ae6b4","#f6ad55","#90cdf4","#d6bcfa","#81e6d9","#fbd38d","#feb2b2"];
  var colorMap = {};
  var ci = 0;
  function colorFor(name) {
    var k = name.indexOf("-") > 0 ? name.slice(0, name.indexOf("-")) : name;
    if (!colorMap[k]) colorMap[k] = COLORS[ci++ % COLORS.length];
    return colorMap[k];
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // --- Session list ---
  window.loadSessions = function() {
    sessionsEl.innerHTML = '<div class="loading">Loading...</div>';
    authFetch("/api/sessions").then(function(r) { return r.json(); }).then(function(sessions) {
      if (!sessions.length) {
        sessionsEl.innerHTML = '<div class="empty">No tmux sessions</div>';
        return;
      }
      var html = "";
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        var c = colorFor(s.name);
        html += '<div class="card" data-name="' + esc(s.name) + '">'
          + '<div class="card-title"><span class="session-dot" style="background:' + c + '"></span>' + esc(s.name) + '</div>'
          + '<div class="card-meta">' + s.windows + ' window' + (s.windows !== 1 ? 's' : '') + ' \\u00b7 ' + ago(s.activity) + (s.attached ? ' \\u00b7 attached' : '') + '</div>'
          + '</div>';
      }
      sessionsEl.innerHTML = html;
    }).catch(function() {
      sessionsEl.innerHTML = '<div class="empty">Failed to load sessions</div>';
    });
    // Load terminals
    authFetch("/api/terminals").then(function(r) { return r.json(); }).then(function(terminals) {
      if (!terminals.length) {
        terminalsLabel.style.display = "none";
        terminalsEl.innerHTML = "";
        return;
      }
      terminalsLabel.style.display = "";
      var html = "";
      for (var i = 0; i < terminals.length; i++) {
        var t = terminals[i];
        html += '<div class="card" data-tmux="' + esc(t.tmuxName) + '">'
          + '<div class="card-title"><span class="session-dot" style="background:#81e6d9"></span>' + esc(t.label) + '</div>'
          + '<div class="card-meta">' + esc(t.cwd) + '</div>'
          + '</div>';
      }
      terminalsEl.innerHTML = html;
    }).catch(function() {
      terminalsEl.innerHTML = "";
      terminalsLabel.style.display = "none";
    });
  };

  sessionsEl.addEventListener("click", function(e) {
    var card = e.target.closest(".card");
    if (card) selectSession(card.getAttribute("data-name"));
  });

  terminalsEl.addEventListener("click", function(e) {
    var card = e.target.closest(".card");
    if (card) connectPane(card.getAttribute("data-tmux"), 0);
  });

  // --- Pane picker ---
  function selectSession(name) {
    currentSession = name;
    paneTitleEl.textContent = name;
    panesEl.innerHTML = '<div class="loading">Loading panes...</div>';
    showView("pane");
    authFetch("/api/sessions/" + encodeURIComponent(name) + "/panes").then(function(r) { return r.json(); }).then(function(panes) {
      if (panes.length === 1) {
        connectPane(name, panes[0].index);
        return;
      }
      var html = "";
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i];
        html += '<div class="card" data-pane="' + p.index + '">'
          + '<div class="card-title"><span class="pane-icon' + (p.active ? " active" : "") + '"></span>' + esc(p.command || "pane " + p.index) + '</div>'
          + '<div class="card-meta">pane ' + p.index + ' \\u00b7 ' + p.width + 'x' + p.height + (p.title && p.title !== p.command ? ' \\u00b7 ' + esc(p.title) : '') + '</div>'
          + '</div>';
      }
      panesEl.innerHTML = html;
    }).catch(function() {
      panesEl.innerHTML = '<div class="empty">Failed to load panes</div>';
    });
  }

  panesEl.addEventListener("click", function(e) {
    var card = e.target.closest(".card");
    if (card && currentSession) connectPane(currentSession, parseInt(card.getAttribute("data-pane")));
  });

  // --- xterm lazy load ---
  function loadXterm() {
    if (xtermLoaded) return xtermLoaded;
    xtermLoaded = new Promise(function(resolve, reject) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css";
      document.head.appendChild(link);
      var s1 = document.createElement("script");
      s1.src = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js";
      s1.onload = function() {
        var s2 = document.createElement("script");
        s2.src = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js";
        s2.onload = function() { resolve(); };
        s2.onerror = function() { reject(new Error("Failed to load addon-fit")); };
        document.head.appendChild(s2);
      };
      s1.onerror = function() { reject(new Error("Failed to load xterm.js")); };
      document.head.appendChild(s1);
    });
    return xtermLoaded;
  }

  // --- Terminal connection ---
  function connectPane(name, paneIndex) {
    showView("term");
    titleEl.textContent = name + ":" + paneIndex;
    termContainer.innerHTML = '<div class="loading">Loading terminal...</div>';

    loadXterm().then(function() {
      termContainer.innerHTML = "";

      term = new window.Terminal({
        fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
        fontSize: 14,
        lineHeight: 1.2,
        cursorBlink: true,
        theme: {
          background: "#0d0e10", foreground: "#e6e6e8",
          cursor: "#b794f6", cursorAccent: "#0d0e10",
          selectionBackground: "rgba(183,148,246,0.3)",
          black: "#1a1d23", red: "#ff8272", green: "#9ae6b4", yellow: "#f6ad55",
          blue: "#90cdf4", magenta: "#d6bcfa", cyan: "#81e6d9", white: "#e6e6e8",
          brightBlack: "#5a5d68", brightRed: "#feb2b2", brightGreen: "#9ae6b4",
          brightYellow: "#fbd38d", brightBlue: "#90cdf4", brightMagenta: "#b794f6",
          brightCyan: "#81e6d9", brightWhite: "#ffffff",
        },
        scrollback: 5000,
        allowTransparency: false,
      });
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(termContainer);
      try { fitAddon.fit(); } catch(e) {}
      term.focus();

      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/ws?session=" + encodeURIComponent(name) + "&pane=" + paneIndex);

      ws.onopen = function() {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = function(ev) {
        var data = ev.data;
        try {
          var msg = JSON.parse(data);
          if (msg.type === "exit") {
            term.write("\\r\\n\\x1b[2m[session exited: " + msg.code + "]\\x1b[0m\\r\\n");
            return;
          }
        } catch(e) {}
        term.write(data);
      };
      ws.onclose = function() {
        if (term) term.write("\\r\\n\\x1b[2m[disconnected]\\x1b[0m\\r\\n");
      };

      // --- Input micro-buffer (16ms ~1 frame) + IME composition ---
      var inputBuffer = "";
      var inputFlushTimer = null;
      var composing = false;

      function flushInput() {
        inputFlushTimer = null;
        if (composing) return;
        if (inputBuffer && ws && ws.readyState === 1) {
          ws.send(inputBuffer);
          inputBuffer = "";
        }
      }

      term.onData(function(data) {
        if (!ws || ws.readyState !== 1) return;
        inputBuffer += data;
        if (!inputFlushTimer) {
          inputFlushTimer = setTimeout(flushInput, 16);
        }
      });

      termContainer.addEventListener("compositionstart", function() { composing = true; });
      termContainer.addEventListener("compositionend", function() { composing = false; flushInput(); });

      term.onResize(function(size) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
      });

      ro = new ResizeObserver(function() { try { fitAddon.fit(); } catch(e) {} });
      ro.observe(termContainer);

      // Make xterm's hidden textarea focusable on mobile to trigger virtual keyboard
      var xtermTextarea = termContainer.querySelector(".xterm-helper-textarea");
      if (xtermTextarea) {
        xtermTextarea.setAttribute("readonly", "false");
        xtermTextarea.removeAttribute("readonly");
        // Mobile browsers need a minimum visible size to allow keyboard popup
        xtermTextarea.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0.01;z-index:-1;font-size:16px;";
      }

      // Tap on terminal area to focus and bring up keyboard
      termContainer.addEventListener("touchend", function(e) {
        if (e.target.closest(".action-bar")) return;
        focusTerminal();
      });

      setupTouchScroll();
    }).catch(function(err) {
      termContainer.innerHTML = '<div class="empty">Failed to load terminal: ' + esc(err.message) + '</div>';
    });
  }

  // --- Touch scroll → tmux mouse wheel (natural scroll: finger up = see history) ---
  // Note: tmux scrolls in whole lines, so we batch and throttle to avoid choppiness.
  // We send scroll events at a controlled rate for smoother visual updates.
  function setupTouchScroll() {
    var accum = 0;
    var THRESHOLD = 20;
    var lastY = 0;
    var lastMoveTime = 0;
    var velocity = 0;
    var momentumRAF = null;
    var FRICTION = 0.88;
    var MIN_VELOCITY = 0.08;
    var scrollInterval = null;

    function sendScroll(dir) {
      if (!ws || ws.readyState !== 1) return;
      var seq = dir > 0 ? "\\x1b[<64;1;1M" : "\\x1b[<65;1;1M";
      ws.send(seq);
    }

    function startScrollInterval() {
      if (scrollInterval) return;
      scrollInterval = setInterval(function() {
        if (accum >= THRESHOLD) {
          sendScroll(1);
          accum -= THRESHOLD;
        } else if (accum <= -THRESHOLD) {
          sendScroll(-1);
          accum += THRESHOLD;
        } else {
          stopScrollInterval();
        }
      }, 30);
    }

    function stopScrollInterval() {
      if (scrollInterval) { clearInterval(scrollInterval); scrollInterval = null; }
    }

    function stopMomentum() {
      if (momentumRAF) { cancelAnimationFrame(momentumRAF); momentumRAF = null; }
      velocity = 0;
      stopScrollInterval();
    }

    function momentumTick() {
      velocity *= FRICTION;
      if (Math.abs(velocity) < MIN_VELOCITY) { stopMomentum(); return; }
      accum += velocity * 6;
      startScrollInterval();
      momentumRAF = requestAnimationFrame(momentumTick);
    }

    termContainer.addEventListener("touchstart", function(e) {
      if (e.touches.length === 1) {
        stopMomentum();
        lastY = e.touches[0].clientY;
        lastMoveTime = Date.now();
        accum = 0;
      }
    }, { passive: true });

    termContainer.addEventListener("touchmove", function(e) {
      if (e.touches.length !== 1 || !ws || ws.readyState !== 1) return;
      var now = Date.now();
      var currentY = e.touches[0].clientY;
      var dy = currentY - lastY;
      var dt = now - lastMoveTime;
      if (dt > 0) velocity = dy / dt;
      lastY = currentY;
      lastMoveTime = now;

      accum += dy;
      startScrollInterval();
      e.preventDefault();
    }, { passive: false });

    termContainer.addEventListener("touchend", function() {
      if (Math.abs(velocity) > MIN_VELOCITY) {
        momentumRAF = requestAnimationFrame(momentumTick);
      } else {
        stopScrollInterval();
      }
    }, { passive: true });
  }

  // --- Shortcut buttons ---
  var shortcuts = {
    "btn-tab": "\\t",
    "btn-ctrl-c": "\\x03",
    "btn-ctrl-d": "\\x04",
    "btn-ctrl-z": "\\x1a"
  };
  // Helper: focus xterm textarea in a mobile-friendly way (triggers keyboard)
  function focusTerminal() {
    var ta = termContainer.querySelector(".xterm-helper-textarea");
    if (ta) {
      // Temporarily make textarea "visible enough" for mobile browsers to open keyboard
      var prev = ta.style.cssText;
      ta.style.cssText = "position:fixed;left:0;bottom:0;width:4px;height:4px;opacity:0.01;font-size:16px;z-index:9999;";
      ta.focus();
      setTimeout(function() { ta.style.cssText = prev; }, 50);
    } else if (term) {
      term.focus();
    }
  }

  document.getElementById("action-bar").addEventListener("touchend", function(e) {
    var btn = e.target.closest(".action-btn");
    if (!btn) return;
    e.preventDefault();
    var seq = shortcuts[btn.id];
    if (seq && ws && ws.readyState === 1) ws.send(seq);
    focusTerminal();
  });

  // --- Disconnect ---
  window.disconnect = function() {
    if (ws) { ws.close(); ws = null; }
    if (term) { term.dispose(); term = null; fitAddon = null; }
    if (ro) { ro.disconnect(); ro = null; }
    termContainer.innerHTML = "";
    currentSession = null;
    showView("list");
    loadSessions();
  };

  // Preload xterm.js in background so terminal opens instantly
  setTimeout(function() { loadXterm(); }, 500);
})();
</script>
</body>
</html>`;

const PTY_BRIDGE_SCRIPT = String.raw`
import pty, os, sys, select, struct, fcntl, termios, signal, subprocess

tmux, session, mobile, pane_idx, resize_file = sys.argv[1:6]

subprocess.run([tmux, 'new-session', '-d', '-t', session, '-s', mobile], check=True)
subprocess.run([tmux, 'set', '-t', mobile, 'status', 'off'])
if pane_idx != '0':
    subprocess.run([tmux, 'select-pane', '-t', mobile + ':.' + pane_idx], check=True)

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.environ['TERM'] = 'xterm-256color'
    os.execv(tmux, [tmux, 'attach', '-f', 'ignore-size', '-t', mobile])
os.close(slave)
fl = fcntl.fcntl(master, fcntl.F_GETFL)
fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
fl_in = fcntl.fcntl(0, fcntl.F_GETFL)
fcntl.fcntl(0, fcntl.F_SETFL, fl_in | os.O_NONBLOCK)
sys.stdout = os.fdopen(1, 'wb', 0)

def on_winch(signum, frame):
    try:
        with open(resize_file, 'r') as f:
            parts = f.read().strip().split(',')
        cols, rows = int(parts[0]), int(parts[1])
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
signal.signal(signal.SIGWINCH, on_winch)

try:
    while True:
        r, _, _ = select.select([master, 0], [], [], 1)
        if 0 in r:
            try:
                data = os.read(0, 65536)
                if not data:
                    break
                os.write(master, data)
            except OSError:
                break
        if master in r:
            try:
                data = os.read(master, 65536)
                if not data:
                    break
                sys.stdout.write(data)
            except OSError:
                break
        rr = os.waitpid(pid, os.WNOHANG)
        if rr[0] != 0:
            break
except Exception:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    os.close(master)
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    try:
        os.unlink(resize_file)
    except Exception:
        pass
    subprocess.run([tmux, 'kill-session', '-t', mobile], capture_output=True)
    sys.exit(0)
`;

export async function run() {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const portIdx = process.argv.indexOf("--port");
  const port = portArg
    ? parseInt(portArg.split("=")[1])
    : portIdx >= 0
      ? parseInt(process.argv[portIdx + 1])
      : DEFAULT_PORT;

  const token = serveToken();
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
    res.end(HTML);
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
        PTY_BRIDGE_SCRIPT,
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
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { child.kill(); } catch {}
      runTmux(["kill-session", "-t", `=${mobileId}`]);
      try { closeSync(resizeFd); } catch {}
      try { rmSync(resizeDirectory, { recursive: true, force: true }); } catch {}
      releaseBridgeReservation();
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

    let stdinBackpressured = false;
    child.stdin!.on("drain", () => {
      if (!cleaned) stdinBackpressured = false;
    });
    socket.on("message", (raw: Buffer | string) => {
      const msg = raw.toString();
      const messageBytes = Buffer.byteLength(msg, "utf8");
      if (messageBytes > MAX_TERMINAL_INPUT_BYTES) {
        closeForResourceLimit("terminal input message limit reached");
        return;
      }
      try {
        const parsed = JSON.parse(msg) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { type?: unknown }).type === "resize") {
          const size = parsedResizeMessage(parsed);
          if (size && !cleaned) {
            try {
              writeTerminalSize(resizeFd, size);
              child.kill("SIGWINCH");
            } catch {
              cleanup();
              if (socket.readyState === socket.OPEN) socket.close(1011, "terminal resize failed");
            }
          }
          return;
        }
      } catch {}
      if (cleaned || !child.stdin!.writable) return;
      if (
        stdinBackpressured
        || child.stdin!.writableLength > MAX_PENDING_STDIN_BYTES - messageBytes
      ) {
        closeForResourceLimit("terminal input buffer limit reached");
        return;
      }
      try {
        stdinBackpressured = !child.stdin!.write(msg);
      } catch {
        cleanup();
      }
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
      server.listen(port, "0.0.0.0");
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });

  {
    const ip = getLanIp();
    console.log(`\ntw-dashboard web server running at:\n`);
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  Network: http://${ip}:${port}`);
    console.log(`  Token:   ${token}\n`);

    console.log(`Open the Network URL on your phone and enter the token to connect.\n`);
  }
}
