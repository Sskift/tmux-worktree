import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync, spawn as cpSpawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";

const DEFAULT_PORT = 8311;

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function tmuxBin(): string {
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try { execSync(`test -x ${p}`, { timeout: 1000 }); return p; } catch {}
  }
  return "tmux";
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
  const tmux = tmuxBin();
  const fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}";
  const raw = sh(`${tmux} list-sessions -F '${fmt}'`);
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

function listPanes(sessionName: string): Pane[] {
  const tmux = tmuxBin();
  const fmt = "#{pane_index}\x1f#{pane_width}\x1f#{pane_height}\x1f#{pane_current_command}\x1f#{pane_title}\x1f#{pane_active}";
  const raw = sh(`${tmux} list-panes -t '=${sessionName}' -F '${fmt}'`);
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
  const tmux = tmuxBin();
  return sh(`${tmux} display-message -t '=${name}' -p '#{pane_current_path}'`);
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

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/sessions") {
    json(res, listSessions());
    return true;
  }

  const panesMatch = path.match(/^\/api\/sessions\/([^/]+)\/panes$/);
  if (panesMatch) {
    const name = decodeURIComponent(panesMatch[1]);
    json(res, listPanes(name));
    return true;
  }

  const cwdMatch = path.match(/^\/api\/sessions\/([^/]+)\/cwd$/);
  if (cwdMatch) {
    const name = decodeURIComponent(cwdMatch[1]);
    const cwd = sessionCwd(name);
    json(res, { cwd });
    return true;
  }

  const cancelMatch = path.match(/^\/api\/sessions\/([^/]+)\/cancel-copy-mode$/);
  if (cancelMatch && req.method === "POST") {
    const name = decodeURIComponent(cancelMatch[1]);
    const tmux = tmuxBin();
    sh(`${tmux} send-keys -t '=${name}' -X cancel`);
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
  <div id="sessions" class="scroll-area"><div class="loading">Loading...</div></div>
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
  var panesEl = document.getElementById("panes");
  var paneTitleEl = document.getElementById("pane-title");
  var titleEl = document.getElementById("toolbar-title");
  var termContainer = document.getElementById("terminal-container");
  var actionBar = document.getElementById("action-bar");

  var term = null, fitAddon = null, ws = null, ro = null, xtermLoaded = null;
  var currentSession = null;
  var authToken = localStorage.getItem("tw-token") || "";

  function showView(name) {
    for (var k in views) views[k].classList.toggle("active", k === name);
  }
  window.showView = showView;

  function authHeaders() {
    return { "Authorization": "Bearer " + authToken };
  }

  function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, authHeaders());
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
        authToken = val;
        localStorage.setItem("tw-token", val);
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

  // Auto-login if token in localStorage
  if (authToken) {
    tryAuth(authToken).then(function(ok) {
      if (ok) { showView("list"); loadSessions(); }
      else { localStorage.removeItem("tw-token"); authToken = ""; }
    });
  }

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
  };

  sessionsEl.addEventListener("click", function(e) {
    var card = e.target.closest(".card");
    if (card) selectSession(card.getAttribute("data-name"));
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
      ws = new WebSocket(proto + "//" + location.host + "/ws?session=" + encodeURIComponent(name) + "&pane=" + paneIndex + "&token=" + encodeURIComponent(authToken));

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

  loadSessions();
  // Preload xterm.js in background so terminal opens instantly
  setTimeout(function() { loadXterm(); }, 500);
})();
</script>
</body>
</html>`;

export async function run() {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const portIdx = process.argv.indexOf("--port");
  const port = portArg
    ? parseInt(portArg.split("=")[1])
    : portIdx >= 0
      ? parseInt(process.argv[portIdx + 1])
      : DEFAULT_PORT;

  const token = process.env.TW_TOKEN || randomBytes(4).toString("hex");

  function checkAuth(req: IncomingMessage): boolean {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const qToken = url.searchParams.get("token");
    if (qToken === token) return true;
    const auth = req.headers.authorization;
    if (auth === `Bearer ${token}`) return true;
    return false;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Auth endpoint - no token required
    if (path === "/api/auth" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.token === token) {
            json(res, { ok: true });
          } else {
            json(res, { ok: false, error: "invalid token" }, 401);
          }
        } catch {
          json(res, { ok: false, error: "bad request" }, 400);
        }
      });
      return;
    }

    // All other API routes require auth
    if (path.startsWith("/api/")) {
      if (!checkAuth(req)) {
        json(res, { error: "unauthorized" }, 401);
        return;
      }
      if (handleApi(req, res)) return;
      json(res, { error: "not found" }, 404);
      return;
    }

    // HTML page - always served (contains auth UI)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    // Check token for WebSocket
    if (!checkAuth(req)) {
      socket.close(4001, "unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const sessionName = url.searchParams.get("session");
    if (!sessionName) {
      socket.close(4000, "missing session param");
      return;
    }
    const paneIndex = url.searchParams.get("pane") || "0";

    const tmux = tmuxBin();
    const mobileId = "tw-mobile-" + randomBytes(4).toString("hex");
    const resizeFile = `/tmp/tw-resize-${mobileId}`;

    const pyScript = `
import pty, os, sys, select, struct, fcntl, termios, signal, subprocess

tmux = '${tmux}'
session = '${sessionName.replace(/'/g, "\\'")}'
mobile = '${mobileId}'
pane_idx = '${paneIndex}'
resize_file = '${resizeFile}'

subprocess.run([tmux, 'new-session', '-d', '-t', session, '-s', mobile], check=True)
subprocess.run([tmux, 'set', '-t', mobile, 'status', 'off'])
if pane_idx != '0':
    subprocess.run([tmux, 'select-pane', '-t', mobile + ':.' + pane_idx])

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
    os.execvp(tmux, ['tmux', 'attach', '-t', mobile])
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
    except:
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
except:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except:
        pass
    os.close(master)
    try:
        os.waitpid(pid, 0)
    except:
        pass
    try:
        os.unlink(resize_file)
    except:
        pass
    subprocess.run([tmux, 'kill-session', '-t', mobile], capture_output=True)
    sys.exit(0)
`;

    const child = cpSpawn("python3", ["-u", "-c", pyScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    });

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { child.kill(); } catch {}
      sh(`${tmux} kill-session -t '${mobileId}'`);
      try { unlinkSync(resizeFile); } catch {}
    }

    child.stdout!.on("data", (data: Buffer) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(data.toString("utf-8"));
      }
    });

    child.stderr!.on("data", (_data: Buffer) => {});

    child.on("close", (code: number | null) => {
      cleanup();
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "exit", code: code ?? 0 }));
        socket.close();
      }
    });

    socket.on("message", (raw: Buffer | string) => {
      const msg = raw.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize") {
          // Write size to temp file and signal python to ioctl resize the PTY
          writeFileSync(resizeFile, `${parsed.cols},${parsed.rows}`);
          try { child.kill("SIGWINCH"); } catch {}
          return;
        }
      } catch {}
      child.stdin!.write(msg);
    });

    socket.on("close", () => {
      cleanup();
    });
  });

  server.listen(port, "0.0.0.0", () => {
    const ip = getLanIp();
    console.log(`\ntw-dashboard web server running at:\n`);
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  Network: http://${ip}:${port}`);
    console.log(`  Token:   ${token}\n`);
    console.log(`Open the Network URL on your phone and enter the token to connect.\n`);
  });
}
