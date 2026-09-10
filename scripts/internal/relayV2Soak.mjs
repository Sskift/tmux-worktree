#!/usr/bin/env node
/**
 * Relay v2 long-duration soak runner (Phase 2-B).
 *
 * Runs ONE real topology (broker + host + real WSS clients) for ~75 minutes
 * and exercises the detached-lease / resume / stale-cursor paths that all
 * prior real-topology tests only touched with millisecond detach windows:
 *
 *   (b) 30 rounds: open `while true; do date; sleep 1; done`, collect frames,
 *       drop the ws (terminal stays open), wait 90s (inside the 120s detached
 *       lease), reconnect with resumeToken -> disposition must be "resumed",
 *       byte stream continuous (no gap / no overlap), and fresh `date` output
 *       must flow within seconds of un-parking.
 *   (a) 6 rounds (every 5th): same but wait 130s (past the 120s lease +
 *       sweep) -> resume must get a clean reset/closed disposition (never
 *       backend_error), and the host must still serve a brand new terminal.
 *   (c) 2 rounds: 30 MB of output while detached (>8MB daemon retention) ->
 *       resume must surface terminal.reset_required (slow consumer), never a
 *       backend_error close; a mode=reset reopen must then succeed.
 *   (d) 1 round: kill_session from a second client while the holder has the
 *       stream open -> holder must observe terminal.closed(reason=
 *       backend_exit, exitCode != null).
 *
 * Host RSS + connector status are sampled to /tmp/soak-<ts>.csv.
 *
 * Usage:
 *   node scripts/internal/relayV2Soak.mjs            # full ~75 minute soak
 *   SOAK_QUICK=1 node scripts/internal/relayV2Soak.mjs  # 1 short smoke round
 *
 * Test/tooling infrastructure only.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startInteropTopology } from "./relayV2InteropHarness.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QUICK = process.env.SOAK_QUICK === "1";
const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v >= 0 ? v : fallback;
};
const B_ROUNDS = QUICK ? envInt("SOAK_B_ROUNDS", 1) : envInt("SOAK_B_ROUNDS", 30);
const A_EVERY = QUICK ? envInt("SOAK_A_EVERY", 0) : envInt("SOAK_A_EVERY", 5);
const C_ROUNDS = QUICK ? envInt("SOAK_C_ROUNDS", 0) : envInt("SOAK_C_ROUNDS", 2);
const D_ROUNDS = QUICK ? envInt("SOAK_D_ROUNDS", 0) : envInt("SOAK_D_ROUNDS", 1);
const DETACH_MS_RESUME = QUICK ? envInt("SOAK_DETACH_RESUME", 8_000) : 90_000;
const DETACH_MS_EXPIRED = QUICK ? envInt("SOAK_DETACH_EXPIRED", 8_000) : 130_000;
const DETACH_MS_FLOOD = QUICK ? envInt("SOAK_DETACH_FLOOD", 8_000) : 30_000;
// Diagnostic (a)-variant: keep a SECOND terminal on a live connection while
// the probe terminal is detached. Its producer-lease maintenance timer is
// the manager's only time-based sweep driver (sweeps fire at each live
// stream's lease half-life, ~15s). With no live neighbor the manager never
// sweeps on an idle host and the 120s detached lease is not enforced.
const A_BEACON = process.env.SOAK_A_BEACON === "1";
const HOST_ID = "soak-host";

const REQUIRED_CAPABILITIES = [
  "error.structured.v1",
  "command.ledger.v1",
  "command.query.v1",
  "snapshot.revision.v1",
  "event.sequence.v1",
  "terminal.stream.resume.v1",
];

const RESULTS = [];
function record(name, passed, detail = "") {
  RESULTS.push({ name, passed, detail });
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ": " + detail : ""}`);
}

function ts() {
  return new Date().toISOString();
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function logLine(msg) {
  console.log(`${ts()} ${msg}`);
}

// ---------------------------------------------------------------------------
// Process / tmux / filesystem cleanup helpers (mirrors the fault-injection
// runner's proven cleanup)
// ---------------------------------------------------------------------------
function tmuxSessionNames() {
  try {
    return new Set(execFileSync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8", timeout: 5_000 },
    ).split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function realpathForms(path) {
  const forms = new Set([path]);
  try { forms.add(realpathSync.native(path)); } catch {}
  try {
    const tmpLogical = tmpdir();
    let tmpReal;
    try { tmpReal = realpathSync.native(tmpLogical); } catch {}
    if (tmpReal && tmpReal !== tmpLogical) {
      if (path.startsWith(tmpReal + "/")) forms.add(tmpLogical + path.slice(tmpReal.length));
      if (path.startsWith(tmpLogical + "/")) forms.add(tmpReal + path.slice(tmpLogical.length));
    }
  } catch {}
  return forms;
}

function scopedTmuxSessionNames(root, baseline) {
  if (!root) return new Set();
  const rootPrefixes = [...realpathForms(root)];
  const scoped = new Set();
  for (const name of tmuxSessionNames()) {
    if (baseline.has(name)) continue;
    let paneCwd;
    try {
      paneCwd = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", `${name}:0.0`, "#{pane_current_path}"],
        { encoding: "utf8", timeout: 5_000 },
      ).trim();
    } catch { continue; }
    if (!paneCwd) continue;
    let hit = false;
    for (const cwdForm of realpathForms(paneCwd)) {
      for (const rootForm of rootPrefixes) {
        if (cwdForm === rootForm || cwdForm.startsWith(`${rootForm}/`)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) scoped.add(name);
  }
  return scoped;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (options.closeInput === true && child.stdin && !child.stdin.destroyed) {
    try { child.stdin.end(); } catch {}
  }
  if (await waitForChildExit(child, 2_000)) return;
  try { child.kill("SIGTERM"); } catch {}
  if (await waitForChildExit(child, 5_000)) return;
  try { child.kill("SIGKILL"); } catch {}
  await waitForChildExit(child, 2_000);
}

function closeWebSocket(socket) {
  if (!socket) return;
  try { socket.close(); } catch {}
  try { socket.terminate(); } catch {}
}

async function stopScopedTerminalControlDaemon(trustedHome) {
  if (!trustedHome) return;
  const ownerPaths = [
    join(trustedHome, ".tmux-worktree", "terminal-control-v1.sock.server.lock", "owner.json"),
    join(trustedHome, ".relay-v2-tc-v1.sock.server.lock", "owner.json"),
  ];
  for (const ownerPath of ownerPaths) {
    if (!existsSync(ownerPath)) continue;
    let pid;
    try { pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid; } catch { continue; }
    if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) continue;
    try { process.kill(pid, "SIGTERM"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const lockPath = join(ownerPath, "..");
    for (let attempt = 0; attempt < 100 && existsSync(lockPath); attempt += 1) await delay(20);
    if (!existsSync(lockPath)) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    for (let attempt = 0; attempt < 100 && existsSync(lockPath); attempt += 1) await delay(20);
    if (existsSync(lockPath)) throw new Error("scoped terminal-control daemon did not stop");
  }
}

async function killProcessesReferencingHome(home) {
  if (!home) return;
  let out = "";
  try {
    // -E includes each process's environment in the listing: tmux-spawned
    // shells run with HOME=<host home> but no home path in argv, so argv-only
    // matching misses them — a lingering zsh exiting after home removal
    // recreates the directory with a .zsh_history file.
    out = execFileSync("ps", ["-axEww", "-o", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
  } catch { return; }
  const targets = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const sp = trimmed.indexOf(" ");
    if (sp <= 0) continue;
    const pid = Number(trimmed.slice(0, sp));
    const rest = trimmed.slice(sp + 1);
    if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) continue;
    if (rest.includes(home)) targets.push(pid);
  }
  for (const pid of targets) {
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") { /* best effort */ }
    }
  }
  if (targets.length > 0) await delay(200);
}

// ---------------------------------------------------------------------------
// Client helper
// ---------------------------------------------------------------------------
async function openClient(topology) {
  const url = topology.clientRelayUrl;
  const accessToken = topology.clientCreds.accessToken;
  let socket = null;
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      socket = new WebSocket(url, "tw-relay.v2", {
        headers: { Authorization: `Bearer ${accessToken}` },
        ca: topology.tls.cert,
        rejectUnauthorized: true,
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("client ws open timeout")), 10_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      lastError = null;
      break;
    } catch (error) {
      closeWebSocket(socket);
      socket = null;
      lastError = error;
      await delay(2_500);
    }
  }
  if (!socket) throw new Error(`client ws failed: ${lastError?.message ?? lastError}`);

  const waiters = new Map();
  const events = [];
  let relayWelcome = null;
  let hostWelcome = null;
  let closeInfo = null;

  socket.on("close", (code, reason) => {
    closeInfo = { code, reason: reason?.toString() ?? "" };
  });
  socket.on("message", (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.type === "relay.welcome") { relayWelcome = frame; return; }
    if (frame.type === "host.welcome" && frame.requestId === "hello-1") {
      hostWelcome = frame;
      return;
    }
    if (frame.requestId && waiters.has(frame.requestId)) {
      const resolve = waiters.get(frame.requestId);
      waiters.delete(frame.requestId);
      resolve(frame);
      return;
    }
    events.push(frame);
    // Real clients acknowledge received output; without output_ack the route
    // unacked window (512 KiB) stalls the byte plane after one frame.
    if (frame.type === "terminal.output" && socket.readyState === WebSocket.OPEN) {
      try {
        const end = BigInt(frame.payload.offset)
          + BigInt(Buffer.from(frame.payload.data, "base64").length);
        socket.send(JSON.stringify({
          protocolVersion: 2,
          kind: "event",
          type: "terminal.output_ack",
          streamId: frame.streamId,
          payload: { generation: frame.payload.generation, nextOffset: end.toString() },
        }));
      } catch { /* socket closing */ }
    }
  });

  await new Promise((resolve, reject) => {
    const check = () => {
      if (relayWelcome) return resolve();
      if (socket.readyState !== WebSocket.OPEN) {
        return reject(new Error(`ws closed before relay.welcome (close=${JSON.stringify(closeInfo)})`));
      }
      setTimeout(check, 50);
    };
    check();
    setTimeout(() => reject(new Error("relay.welcome timed out")), 10_000);
  });

  socket.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "client.hello",
    requestId: "hello-1",
    hostId: topology.hostId,
    payload: {
      clientInstanceId: topology.clientInstanceId,
      capabilities: REQUIRED_CAPABILITIES,
      requiredCapabilities: REQUIRED_CAPABILITIES,
      resume: null,
    },
  }));

  await new Promise((resolve, reject) => {
    const check = () => {
      if (hostWelcome) return resolve();
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("ws closed before host.welcome"));
      setTimeout(check, 50);
    };
    check();
    setTimeout(() => reject(new Error("host.welcome timed out")), 10_000);
  });

  const ctx = {
    socket,
    hostEpoch: hostWelcome.hostEpoch,
    hostId: topology.hostId,
    dedupeWindowId: hostWelcome.payload.commandDedupeWindow.windowId,
    capabilities: hostWelcome.payload.capabilities ?? REQUIRED_CAPABILITIES,
    scopeId: null,
    events,
    getCloseInfo: () => closeInfo,
    close() { closeWebSocket(socket); },
    send(frame) { socket.send(JSON.stringify(frame)); },
    request(frame, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        waiters.set(frame.requestId, resolve);
        socket.send(JSON.stringify(frame));
        setTimeout(() => {
          if (waiters.has(frame.requestId)) {
            waiters.delete(frame.requestId);
            reject(new Error(`${frame.type} ${frame.requestId} timed out`));
          }
        }, timeoutMs);
      });
    },
    drainEvents(predicate) {
      return events.filter(predicate);
    },
    waitForEvent(predicate, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        const existing = events.find(predicate);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          socket.off("message", onMessage);
          reject(new Error(`${label}: event timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const onMessage = (data) => {
          let frame;
          try { frame = JSON.parse(data.toString()); } catch { return; }
          if (frame.requestId && waiters.has(frame.requestId)) return;
          if (predicate(frame)) {
            clearTimeout(timer);
            socket.off("message", onMessage);
            resolve(frame);
          }
        };
        socket.on("message", onMessage);
      });
    },
  };
  return ctx;
}

async function discoverScope(client) {
  const reqId = "scope-" + randomBytes(8).toString("hex");
  const snap = await client.request({
    protocolVersion: 2,
    kind: "request",
    type: "scopes.snapshot.get",
    requestId: reqId,
    hostId: client.hostId,
    expectedHostEpoch: client.hostEpoch,
    payload: {},
  });
  const local = snap.payload?.items?.find((s) => s.kind === "local" && s.reachability === "online");
  if (!local) throw new Error("no online local scope: " + JSON.stringify(snap.payload ?? snap).slice(0, 400));
  client.scopeId = local.scopeId;
  return local.scopeId;
}

async function createTerminal(client, cwd, label) {
  const maxIssuances = 8;
  let commandId = "cmd-" + randomBytes(8).toString("hex");
  for (let issuance = 0; issuance < maxIssuances; issuance++) {
    const requestId = "req-" + randomBytes(8).toString("hex");
    const accepted = await client.request({
      protocolVersion: 2,
      kind: "request",
      type: "command.execute",
      requestId,
      commandId,
      hostId: client.hostId,
      expectedHostEpoch: client.hostEpoch,
      scopeId: client.scopeId,
      payload: {
        dedupeWindowId: client.dedupeWindowId,
        operation: "create_terminal",
        arguments: { cwd, label },
      },
    }, 20_000);
    let item = accepted.payload ?? accepted;
    for (let i = 0; i < 40; i++) {
      if (item.state === "succeeded") {
        const sessionId = item.result?.session?.sessionId;
        if (sessionId) return sessionId;
        throw new Error("create_terminal succeeded without session: " + JSON.stringify(item).slice(0, 300));
      }
      if (item.state === "failed") {
        throw new Error("create_terminal failed: " + JSON.stringify(item.error ?? item).slice(0, 300));
      }
      const retryableNotAccepted = item.state === "not_accepted"
        && (item.retryable === true || item.error?.retryable === true);
      if (retryableNotAccepted) break;
      await delay(500);
      const qid = "qry-" + randomBytes(8).toString("hex");
      const queried = await client.request({
        protocolVersion: 2,
        kind: "request",
        type: "command.query",
        requestId: qid,
        hostId: client.hostId,
        expectedHostEpoch: client.hostEpoch,
        payload: { items: [{ commandId, dedupeWindowId: client.dedupeWindowId }] },
      });
      item = queried.payload?.items?.[0] ?? queried.payload ?? queried;
      const qRetryable = item.state === "not_accepted"
        && (item.retryable === true || item.error?.retryable === true);
      if (qRetryable) break;
    }
    if (issuance + 1 < maxIssuances) {
      commandId = "cmd-" + randomBytes(8).toString("hex");
      await delay(800);
    }
  }
  throw new Error("create_terminal did not settle after " + maxIssuances + " issuances");
}

function terminalOpenFrame(client, { sessionId, streamId, mode = "new", resume = null }) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "terminal.open",
    requestId: "open-" + randomBytes(8).toString("hex"),
    hostId: client.hostId,
    expectedHostEpoch: client.hostEpoch,
    scopeId: client.scopeId,
    sessionId,
    streamId,
    payload: {
      openId: "openid-" + randomBytes(8).toString("hex"),
      pane: 0,
      cols: 80,
      rows: 24,
      mode,
      ...(resume ? { resume } : {}),
    },
  };
}

/**
 * terminal.open with the discovery-refresh CAPABILITY_UNAVAILABLE retry and a
 * bounded retry on host-marked retryable route errors. Returns { response,
 * streamId }. Also collects any terminal.closed / terminal.reset_required
 * EVENT that arrives for this stream while the open request is in flight.
 */
async function openTerminalStream(client, target, options = {}) {
  const maxAttempts = options.maxAttempts ?? 45;
  let last = null;
  const streamId = target.streamId ?? ("stream-" + randomBytes(8).toString("hex"));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const frame = terminalOpenFrame(client, {
      sessionId: target.sessionId,
      streamId,
      mode: options.mode ?? "new",
      resume: options.resume ?? null,
    });
    let resp;
    try {
      resp = await client.request(frame, options.timeoutMs ?? 12_000);
    } catch (error) {
      last = { error: { code: "TIMEOUT", message: error.message } };
      await delay(500);
      continue;
    }
    last = resp;
    if (resp.type === "terminal.opened" || resp.type === "terminal.reset_required") {
      return { response: resp, streamId };
    }
    const code = resp.error?.code ?? resp.payload?.error?.code ?? null;
    const retryable = resp.error?.retryable ?? resp.payload?.error?.retryable ?? false;
    if (code === "CAPABILITY_UNAVAILABLE" || retryable === true) {
      await delay(1_000);
      continue;
    }
    // Route-scoped conflict while a prior bind is still being unbound server
    // side (settles within moments) — retry with a fresh openId.
    if (/TERMINAL_STREAM_CONFLICT|BUSY/.test(String(code)) && attempt < 8) {
      await delay(400);
      continue;
    }
    return { response: resp, streamId };
  }
  return { response: last, streamId };
}

function makeInputSender(client) {
  const counters = new Map();
  return function sendInput(streamId, generation, text) {
    const next = (counters.get(streamId) ?? 0) + 1;
    counters.set(streamId, next);
    client.send({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.input",
      streamId,
      payload: {
        generation,
        inputSeq: String(next),
        encoding: "base64",
        data: Buffer.from(text).toString("base64"),
      },
    });
  };
}

/**
 * Wait up to timeoutMs for either a terminal.closed or terminal.reset_required
 * EVENT on the given stream (whichever arrives first).
 */
function waitForStreamTerminalEvent(client, streamId, timeoutMs) {
  return new Promise((resolve) => {
    const found = () => client.events.find((f) =>
      (f.type === "terminal.closed" || f.type === "terminal.reset_required")
      && f.streamId === streamId);
    const existing = found();
    if (existing) return resolve(existing);
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const frame = found();
      if (frame) {
        clearInterval(timer);
        resolve(frame);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(null);
      }
    }, 200);
  });
}

async function killSession(topology, scopeId, sessionId) {
  const client = await openClient(topology);
  try {
    await discoverScope(client);
    const doIssue = async () => {
      const commandId = "kill-" + randomBytes(8).toString("hex");
      const requestId = "kreq-" + randomBytes(8).toString("hex");
      const accepted = await client.request({
        protocolVersion: 2,
        kind: "request",
        type: "command.execute",
        requestId,
        commandId,
        hostId: client.hostId,
        expectedHostEpoch: client.hostEpoch,
        scopeId,
        sessionId,
        payload: {
          dedupeWindowId: client.dedupeWindowId,
          operation: "kill_session",
          arguments: {},
        },
      }, 20_000);
      let item = accepted.payload ?? accepted;
      for (let i = 0; i < 60; i++) {
        if (item.state === "succeeded" || item.state === "failed") return item;
        await delay(250);
        const qid = "kqry-" + randomBytes(8).toString("hex");
        const queried = await client.request({
          protocolVersion: 2,
          kind: "request",
          type: "command.query",
          requestId: qid,
          hostId: client.hostId,
          expectedHostEpoch: client.hostEpoch,
          payload: { items: [{ commandId, dedupeWindowId: client.dedupeWindowId }] },
        });
        item = queried.payload?.items?.[0] ?? queried.payload ?? queried;
      }
      return item;
    };
    let item = await doIssue();
    // A transient not_accepted (host lane briefly pinned) settles nowhere;
    // re-issue with a fresh commandId a couple of times before giving up.
    for (let attempt = 0; attempt < 3 && item?.state === "not_accepted"; attempt++) {
      await delay(1_000);
      item = await doIssue();
    }
    return item;
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Output continuity tracking
// ---------------------------------------------------------------------------
function outputFrames(client, streamId) {
  return client.events
    .filter((f) => f.type === "terminal.output" && f.streamId === streamId)
    .map((f) => {
      const buf = Buffer.from(f.payload.data, "base64");
      return {
        offset: BigInt(f.payload.offset),
        end: BigInt(f.payload.offset) + BigInt(buf.length),
        text: buf.toString("utf8"),
      };
    });
}

/** Verify frames are gap/overlap-free starting at expectedStart. */
function checkContinuity(frames, expectedStart) {
  let cursor = expectedStart;
  let overlaps = 0;
  let gaps = 0;
  let firstOffset = null;
  for (const frame of frames) {
    if (firstOffset === null) firstOffset = frame.offset;
    if (frame.offset < cursor) overlaps += 1;
    else if (frame.offset > cursor) gaps += 1;
    cursor = frame.end > cursor ? frame.end : cursor;
  }
  return {
    firstOffset,
    lastEnd: cursor,
    overlaps,
    gaps,
    count: frames.length,
    ok: firstOffset !== null && firstOffset === expectedStart && overlaps === 0 && gaps === 0,
  };
}

// ---------------------------------------------------------------------------
// Token refresh (access tokens cap at 3600s; the soak runs ~75 minutes)
// ---------------------------------------------------------------------------
async function maybeRefreshCredentials(topology) {
  const creds = topology.clientCreds;
  const issuedAt = creds._issuedAt ?? Date.now();
  if (creds._issuedAt === undefined) creds._issuedAt = Date.now();
  if (Date.now() - issuedAt < 50 * 60 * 1_000) return;
  const resp = await fetch(`${topology.issuerUrl}v2/tokens/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    // Wire shape is token.refresh.client.request (codecSchema.ts): exactly
    // refreshAttemptId + grantId + clientInstanceId + refreshToken.
    body: JSON.stringify({
      refreshAttemptId: "refresh-" + Math.random().toString(36).slice(2, 12),
      grantId: creds.grantId,
      clientInstanceId: topology.clientInstanceId,
      refreshToken: creds.refreshToken,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`token refresh failed: ${resp.status} ${body.slice(0, 200)}`);
  }
  const next = await resp.json();
  topology.clientCreds = { ...next, _issuedAt: Date.now() };
  logLine("[creds] access token refreshed; new accessExpiresAtMs=" + next.accessExpiresAtMs);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
const soakTs = new Date().toISOString().replace(/[:.]/g, "-");
const csvPath = `/tmp/soak-${soakTs}.csv`;
writeFileSync(csvPath, "ts_iso,elapsed_s,round,kind,phase,host_rss_kb,daemon_rss_kb,connector,note\n");
const startedAt = Date.now();

function daemonPid(home) {
  for (const ownerPath of [
    join(home, ".tmux-worktree", "terminal-control-v1.sock.server.lock", "owner.json"),
    join(home, ".relay-v2-tc-v1.sock.server.lock", "owner.json"),
  ]) {
    try {
      const pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid;
      if (Number.isSafeInteger(pid)) return pid;
    } catch {}
  }
  return null;
}

function rssKb(pid) {
  if (!pid) return "";
  try {
    return execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 3_000 }).trim();
  } catch { return ""; }
}

async function sample(topology, round, kind, phase, note = "") {
  let connector = "?";
  try {
    const st = await topology.hostRequest("status");
    connector = st?.result?.connector?.status ?? (st?.ok ? "ok" : "err");
  } catch { connector = "unreachable"; }
  const hostRss = rssKb(topology.hostProc.pid);
  const dPid = daemonPid(topology.hostTrustedHome);
  const daemonRss = rssKb(dPid);
  const row = [
    ts(),
    Math.round((Date.now() - startedAt) / 1000),
    round,
    kind,
    phase,
    hostRss,
    daemonRss,
    connector,
    `"${String(note).replaceAll('"', "'")}"`,
  ].join(",");
  appendFileSync(csvPath, row + "\n");
}

// ---------------------------------------------------------------------------
// Scenario rounds
// ---------------------------------------------------------------------------

/**
 * A second terminal on a persistently connected client, kept live while
 * another terminal is detached. The manager's producer-lease maintenance
 * timer sweeps at each live stream's lease half-life; without any live
 * stream an idle host has no time-based sweep at all.
 */
async function startBeacon(topology, tag) {
  const beacon = await openClient(topology);
  await discoverScope(beacon);
  const sessionId = await createTerminal(beacon, topology.tmpRoot, `soak-${tag}-beacon`);
  const opened = await openTerminalStream(beacon, { sessionId }, { maxAttempts: 20 });
  if (opened.response?.type !== "terminal.opened") {
    beacon.close();
    throw new Error(`beacon open failed: ${JSON.stringify(opened.response?.error ?? opened.response?.type).slice(0, 200)}`);
  }
  const sendInput = makeInputSender(beacon);
  sendInput(opened.streamId, opened.response.payload.generation, "while true; do date; sleep 1; done\n");
  logLine(`[${tag}] beacon live session=${sessionId.slice(0, 16)}… stream=${opened.streamId}`);
  return { client: beacon, sessionId };
}

async function stopBeacon(topology, beacon) {
  if (!beacon) return;
  try {
    await killSession(topology, beacon.client.scopeId, beacon.sessionId);
  } catch (error) {
    logLine(`[beacon] kill error: ${error.message.slice(0, 120)}`);
  }
  beacon.client.close();
}

/**
 * (b)/(a): date-loop terminal, detach for detachMs, then resume.
 * kind: "b" (in-lease, 90s) or "a" (lease-expired, 130s).
 */
async function detachResumeRound(topology, round, kind, detachMs, options = {}) {
  const tag = options.tag ?? `${kind}-${round}`;
  const useBeacon = options.beacon === true;
  const clientA = await openClient(topology);
  let sessionId = null;
  let beacon = null;
  try {
    await discoverScope(clientA);
    sessionId = await createTerminal(clientA, topology.tmpRoot, `soak-${tag}`);
    const opened = await openTerminalStream(clientA, { sessionId }, { maxAttempts: 20 });
    if (opened.response?.type !== "terminal.opened") {
      record(`${tag} initial terminal.open`, false,
        `resp=${JSON.stringify(opened.response?.error ?? opened.response?.type).slice(0, 200)}`);
      return;
    }
    const streamId = opened.streamId;
    const generation = opened.response.payload.generation;
    const resumeToken = opened.response.payload.resumeToken;

    const sendInput = makeInputSender(clientA);
    sendInput(streamId, generation, "while true; do date; sleep 1; done\n");

    // Let the date loop produce output.
    await delay(4_000);
    const beforeFrames = outputFrames(clientA, streamId);
    if (beforeFrames.length < 2) {
      record(`${tag} pre-detach output flowing`, false,
        `only ${beforeFrames.length} output frames in 4s`);
    }
    const lastEnd = beforeFrames.length ? beforeFrames[beforeFrames.length - 1].end : 0n;
    logLine(`[${tag}] detaching; lastEnd=${lastEnd} frames=${beforeFrames.length} detachMs=${detachMs}`);

    // (a) diagnostic: a live neighbor stream drives the manager's only
    // time-based sweep (producer-lease half-life timer, live streams only).
    if (kind === "a" && useBeacon) {
      beacon = await startBeacon(topology, tag);
    }

    // Drop the ws — terminal stays open on the host.
    clientA.socket.close();
    await delay(300);
    try { clientA.socket.terminate(); } catch {}

    await sample(topology, round, kind, "detached", `lastEnd=${lastEnd}`);

    // Wait detached (mid-point sample).
    await delay(Math.floor(detachMs / 2));
    await sample(topology, round, kind, "detached-mid", "");
    await delay(detachMs - Math.floor(detachMs / 2));

    // Reconnect with resumeToken.
    await maybeRefreshCredentials(topology);
    const clientB = await openClient(topology);
    let resumeOutcome;
    try {
      await discoverScope(clientB);
      const eventPromise = waitForStreamTerminalEvent(clientB, streamId, 20_000);
      const resumed = await openTerminalStream(clientB, { sessionId, streamId }, {
        mode: "resume",
        resume: { generation, nextOffset: lastEnd.toString(), resumeToken },
        maxAttempts: 1,
        timeoutMs: 20_000,
      });
      const streamEvent = await eventPromise;
      resumeOutcome = { response: resumed.response, streamEvent };

      const respType = resumed.response?.type;
      const disposition = resumed.response?.payload?.disposition ?? null;
      const resetReason = resumed.response?.payload?.resetReason
        ?? resumed.response?.payload?.reason
        ?? streamEvent?.payload?.reason
        ?? null;
      const replayFrom = resumed.response?.payload?.replayFromOffset ?? null;
      const tailOffset = resumed.response?.payload?.tailOffset ?? null;
      logLine(`[${tag}] resume response: type=${respType} disposition=${disposition} `
        + `resetReason=${resetReason} replayFrom=${replayFrom} tail=${tailOffset} `
        + `streamEvent=${streamEvent ? streamEvent.type + "(" + (streamEvent.payload?.reason ?? "?") + ")" : "none"}`);

      if (kind === "b") {
        // Expect a clean resume with byte continuity.
        const resumedOk = respType === "terminal.opened" && disposition === "resumed";
        record(`${tag} resume disposition=resumed`, resumedOk,
          `type=${respType} disposition=${disposition} resetReason=${resetReason} `
          + `streamEvent=${streamEvent ? `${streamEvent.type}(${streamEvent.payload?.reason ?? "?"})` : "none"}`);

        if (resumedOk) {
          // Collect post-resume output.
          await delay(5_000);
          const afterFrames = outputFrames(clientB, streamId);
          const cont = checkContinuity(afterFrames, lastEnd);
          const freshFrames = afterFrames.filter((f) => f.end > BigInt(tailOffset ?? lastEnd.toString()));
          const textTail = afterFrames.map((f) => f.text).join("").slice(-120).replaceAll("\n", " | ");
          record(`${tag} byte continuity (no gap/overlap)`, cont.ok,
            `frames=${cont.count} firstOffset=${cont.firstOffset} expectedStart=${lastEnd} `
            + `gaps=${cont.gaps} overlaps=${cont.overlaps} lastEnd=${cont.lastEnd}`);
          record(`${tag} fresh output after un-park within 5s`, freshFrames.length >= 3,
            `freshFrames=${freshFrames.length} textTail="${textTail}"`);
        }
      } else {
        // (a) past the lease: expect a CLEAN reset/closed disposition, never
        // backend_error, and the host must still serve a new terminal.
        const cleanReset = respType === "terminal.reset_required"
          || (respType === "terminal.opened" && disposition === "reset")
          || (streamEvent?.type === "terminal.reset_required");
        const closedBackendError = streamEvent?.type === "terminal.closed"
          && streamEvent.payload?.reason === "backend_error";
        const closedOther = streamEvent?.type === "terminal.closed"
          ? `${streamEvent.payload?.reason}/exitCode=${streamEvent.payload?.exitCode ?? "?"}`
          : null;
        record(`${tag} clean disposition after lease expiry`,
          cleanReset && !closedBackendError,
          `type=${respType} disposition=${disposition} resetReason=${resetReason} `
          + `streamEvent=${streamEvent ? `${streamEvent.type}(${streamEvent.payload?.reason ?? "?"}/exit=${streamEvent.payload?.exitCode ?? "?"})` : "none"}`
          + `${closedOther ? ` closed=${closedOther}` : ""}`
          + `${(!cleanReset && !useBeacon) ? " [no live neighbor stream: manager has no time-based sweep driver — see a-beacon diagnostic]" : ""}`);

        // Host health: brand new terminal on the same host.
        let healthOk = false;
        let healthDetail = "";
        try {
          const sid2 = await createTerminal(clientB, topology.tmpRoot, `soak-${tag}-health`);
          const opened2 = await openTerminalStream(clientB, { sessionId: sid2 }, { maxAttempts: 20 });
          healthOk = opened2.response?.type === "terminal.opened";
          healthDetail = `newSession=${sid2.slice(0, 16)}… open=${opened2.response?.type ?? opened2.response?.error?.code}`;
          if (healthOk) {
            // Reap the health terminal too.
            const kill = await killSession(topology, clientB.scopeId, sid2);
            healthDetail += ` kill=${kill?.state ?? kill?.payload?.state ?? "?"}`;
          }
        } catch (error) {
          healthDetail = "health probe threw: " + error.message.slice(0, 150);
        }
        record(`${tag} host still serves new terminals after lease expiry`, healthOk, healthDetail);
      }
    } finally {
      clientB.close();
    }
  } finally {
    try { clientA.close(); } catch {}
    await stopBeacon(topology, beacon);
    beacon = null;
    // Reap the tmux session regardless of how the round ended.
    if (sessionId) {
      try {
        const kill = await killSession(topology, clientA.scopeId ?? null, sessionId);
        logLine(`[${tag}] cleanup kill_session state=${kill?.state ?? kill?.payload?.state ?? "?"}`);
      } catch (error) {
        logLine(`[${tag}] cleanup kill_session error: ${error.message.slice(0, 120)}`);
      }
    }
    await sample(topology, round, kind, "end", "");
  }
}

/**
 * (c): 30 MB flood while detached -> daemon cursor rotates out -> resume must
 * surface reset_required (slow consumer), then mode=reset reopen succeeds.
 */
async function staleCursorRound(topology, round) {
  const tag = `c-${round}`;
  const clientA = await openClient(topology);
  let sessionId = null;
  try {
    await discoverScope(clientA);
    sessionId = await createTerminal(clientA, topology.tmpRoot, `soak-${tag}`);
    const opened = await openTerminalStream(clientA, { sessionId }, { maxAttempts: 20 });
    if (opened.response?.type !== "terminal.opened") {
      record(`${tag} initial terminal.open`, false,
        `resp=${JSON.stringify(opened.response?.error ?? opened.response?.type).slice(0, 200)}`);
      return;
    }
    const streamId = opened.streamId;
    const generation = opened.response.payload.generation;
    const resumeToken = opened.response.payload.resumeToken;

    const sendInput = makeInputSender(clientA);
    sendInput(streamId, generation, "yes | head -c 30000000\n");
    await delay(2_000);
    const beforeFrames = outputFrames(clientA, streamId);
    const lastEnd = beforeFrames.length ? beforeFrames[beforeFrames.length - 1].end : 0n;
    logLine(`[${tag}] detaching during flood; lastEnd=${lastEnd} frames=${beforeFrames.length}`);

    clientA.socket.close();
    await delay(300);
    try { clientA.socket.terminate(); } catch {}

    await sample(topology, round, "c", "flood-detached", `lastEnd=${lastEnd}`);
    await delay(DETACH_MS_FLOOD);

    await maybeRefreshCredentials(topology);
    const clientB = await openClient(topology);
    try {
      await discoverScope(clientB);
      const eventPromise = waitForStreamTerminalEvent(clientB, streamId, 25_000);
      const resumed = await openTerminalStream(clientB, { sessionId, streamId }, {
        mode: "resume",
        resume: { generation, nextOffset: lastEnd.toString(), resumeToken },
        maxAttempts: 1,
        timeoutMs: 25_000,
      });
      const streamEvent = await eventPromise;
      const respType = resumed.response?.type;
      const disposition = resumed.response?.payload?.disposition ?? null;
      const resetReason = resumed.response?.payload?.resetReason
        ?? resumed.response?.payload?.reason
        ?? streamEvent?.payload?.reason
        ?? null;
      const closedBackendError = streamEvent?.type === "terminal.closed"
        && streamEvent.payload?.reason === "backend_error";
      logLine(`[${tag}] resume after flood: type=${respType} disposition=${disposition} `
        + `resetReason=${resetReason} streamEvent=${streamEvent ? `${streamEvent.type}(${streamEvent.payload?.reason ?? "?"})` : "none"}`);

      const resetSignaled = respType === "terminal.reset_required"
        || (respType === "terminal.opened" && disposition === "reset")
        || streamEvent?.type === "terminal.reset_required";
      record(`${tag} stale cursor -> reset_required (not backend_error)`,
        resetSignaled && !closedBackendError,
        `type=${respType} disposition=${disposition} resetReason=${resetReason} `
        + `streamEvent=${streamEvent ? `${streamEvent.type}(${streamEvent.payload?.reason ?? "?"}/exit=${streamEvent.payload?.exitCode ?? "?"})` : "none"}`);

      // mode=reset reopen on a FRESH route with resume:{generation,resumeToken}
      // pointing at the lost generation: the reset retired the attachment to a
      // durable "lost" authority keyed by that generation's token, and the
      // durable lineage only admits a reset as the exact successor of that
      // lost authority (terminalDurableLineage.openAdmission exactLost); a
      // bare mode=reset is rejected stream_conflict for the 10-minute control
      // retention window. The resuming connection still owns the live route,
      // so the reset goes over a new connection.
      const lostGeneration = streamEvent?.payload?.generation ?? generation;
      clientB.close();
      await delay(500);
      const clientC = await openClient(topology);
      try {
        await discoverScope(clientC);
        const resetOpened = await openTerminalStream(clientC, { sessionId, streamId }, {
          mode: "reset",
          resume: { generation: lostGeneration, resumeToken },
          maxAttempts: 12,
          timeoutMs: 10_000,
        });
        const resetOk = resetOpened.response?.type === "terminal.opened"
          && resetOpened.response.payload?.disposition === "reset";
        record(`${tag} mode=reset reopen succeeds`, resetOk,
          `type=${resetOpened.response?.type} disposition=${resetOpened.response?.payload?.disposition ?? "?"} `
          + `err=${resetOpened.response?.error?.code ?? "none"} lostGeneration=${lostGeneration}`);
      } finally {
        clientC.close();
      }
    } finally {
      clientB.close();
    }
  } finally {
    try { clientA.close(); } catch {}
    if (sessionId) {
      try {
        const kill = await killSession(topology, clientA.scopeId ?? null, sessionId);
        logLine(`[${tag}] cleanup kill_session state=${kill?.state ?? kill?.payload?.state ?? "?"}`);
      } catch (error) {
        logLine(`[${tag}] cleanup kill_session error: ${error.message.slice(0, 120)}`);
      }
    }
    await sample(topology, round, "c", "end", "");
  }
}

/**
 * (d): kill_session from a second client while the holder has the stream open
 * -> holder must observe terminal.closed(reason=backend_exit, exitCode!=null).
 */
async function killSessionRound(topology, round) {
  const tag = `d-${round}`;
  const holder = await openClient(topology);
  let sessionId = null;
  try {
    await discoverScope(holder);
    sessionId = await createTerminal(holder, topology.tmpRoot, `soak-${tag}`);
    const opened = await openTerminalStream(holder, { sessionId }, { maxAttempts: 20 });
    if (opened.response?.type !== "terminal.opened") {
      record(`${tag} initial terminal.open`, false,
        `resp=${JSON.stringify(opened.response?.error ?? opened.response?.type).slice(0, 200)}`);
      return;
    }
    const streamId = opened.streamId;
    const sendInput = makeInputSender(holder);
    sendInput(streamId, opened.response.payload.generation, "sleep 600\n");
    await delay(1_000);

    logLine(`[${tag}] kill_session from second client`);
    const killResult = await killSession(topology, holder.scopeId, sessionId);
    const killState = killResult?.state ?? killResult?.payload?.state;

    const closeFrame = await holder.waitForEvent(
      (f) => (f.type === "terminal.closed" || f.type === "terminal.reset_required")
        && f.streamId === streamId,
      20_000,
      "holder terminal.closed",
    ).catch(() => null);

    const reason = closeFrame?.payload?.reason ?? null;
    const exitCode = closeFrame?.payload?.exitCode ?? null;
    const ok = killState === "succeeded"
      && closeFrame?.type === "terminal.closed"
      && reason === "backend_exit"
      && exitCode !== null && exitCode !== undefined;
    record(`${tag} kill_session -> holder terminal.closed(backend_exit, exitCode!=null)`, ok,
      `killState=${killState} frame=${closeFrame?.type ?? "NONE"} reason=${reason ?? "?"} exitCode=${exitCode ?? "null"}`);
    // Session already killed; do not re-kill.
    sessionId = null;
  } finally {
    try { holder.close(); } catch {}
    if (sessionId) {
      try { await killSession(topology, null, sessionId); } catch {}
    }
    await sample(topology, round, "d", "end", "");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const tmuxSessionsBefore = tmuxSessionNames();
const clientSockets = new Set();
let topology = null;
let exitCode = 1;

try {
  logLine(`[setup] soak starting (quick=${QUICK}); b=${B_ROUNDS} aEvery=${A_EVERY} c=${C_ROUNDS} d=${D_ROUNDS}`);
  topology = await startInteropTopology({
    deviceLabel: "soak-client",
    clientIdPrefix: "soak-client-",
    hostId: HOST_ID,
    tmpPrefix: "relay-v2-soak-",
  });
  topology.clientCreds._issuedAt = Date.now();
  logLine(`[setup] topology up: brokerPort=${topology.brokerPort} hostPid=${topology.hostProc.pid} tmpRoot=${topology.tmpRoot}`);
  logLine(`[setup] CSV: ${csvPath}`);
  await sample(topology, 0, "setup", "start", "topology up");

  let bCount = 0;
  let aCount = 0;
  if (QUICK) {
    // Compact/env-driven smoke: B_ROUNDS loop rounds; every A_EVERY-th is (a).
    for (let round = 1; round <= B_ROUNDS; round++) {
      if (A_EVERY > 0 && round % A_EVERY === 0) {
        aCount += 1;
        logLine(`===== (a) lease-expiry round ${aCount} (loop ${round}) =====`);
        await detachResumeRound(topology, aCount, "a", DETACH_MS_EXPIRED, { beacon: A_BEACON });
      } else {
        bCount += 1;
        logLine(`===== (b) in-lease resume round ${bCount} (loop ${round}) =====`);
        await detachResumeRound(topology, bCount, "b", DETACH_MS_RESUME);
      }
    }
  } else {
    // Spec layout: 30 (b) rounds; an (a) lease-expiry round is inserted after
    // every 5th (b) round (6 total). (a) runs with NO beacon: a single phone
    // backgrounded has no other live stream on the host.
    for (let b = 1; b <= B_ROUNDS; b++) {
      bCount += 1;
      logLine(`===== (b) in-lease resume round ${bCount} =====`);
      await detachResumeRound(topology, bCount, "b", DETACH_MS_RESUME);
      if (b % A_EVERY === 0) {
        aCount += 1;
        logLine(`===== (a) lease-expiry round ${aCount} (after b-${bCount}) =====`);
        await detachResumeRound(topology, aCount, "a", DETACH_MS_EXPIRED);
      }
    }
    // Diagnostic control: same (a) but with a live neighbor stream kept on a
    // separate connection. The neighbor's producer-lease half-life timer is
    // the terminal manager's only time-based sweep driver; with it present the
    // 120s detached lease IS enforced (reset_required(stream_lost)), proving
    // the lease logic works and the missing piece is the sweep owner.
    logLine("===== (a-beacon) lease-expiry with live neighbor stream (diagnostic) =====");
    await detachResumeRound(topology, 1, "a", DETACH_MS_EXPIRED, { tag: "a-beacon-1", beacon: true });
  }
  for (let c = 1; c <= C_ROUNDS; c++) {
    logLine(`===== (c) stale-cursor round ${c} =====`);
    await staleCursorRound(topology, c);
  }
  for (let d = 1; d <= D_ROUNDS; d++) {
    logLine(`===== (d) kill_session round ${d} =====`);
    await killSessionRound(topology, d);
  }

  await sample(topology, 999, "wrap", "end", "soak complete");

  const failed = RESULTS.filter((r) => !r.passed);
  console.log("\n=== Soak Results ===");
  for (const r of RESULTS) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  }
  console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} passed`);
  exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error("[FAIL] soak runner fatal:", error?.stack ?? error);
  exitCode = 1;
} finally {
  // ---- Cleanup (mirrors fault-injection runner) ----
  const cleanupErrors = [];
  const scopedTmux = topology
    ? scopedTmuxSessionNames(topology.tmpRoot, tmuxSessionsBefore)
    : new Set();
  // Kill scoped tmux sessions FIRST so pane shells (zsh with HOME=<host home>)
  // are gone before the home is removed.
  for (const name of scopedTmux) {
    if (!tmuxSessionNames().has(name)) continue;
    try {
      execFileSync("tmux", ["kill-session", "-t", name], { timeout: 5_000 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (topology && topology.hostProc?.exitCode === null) {
    try { await topology.hostRequest("stop_connector"); } catch {}
  }
  try { await terminateChild(topology?.hostProc, { closeInput: true }); } catch (error) { cleanupErrors.push(error); }
  try { await stopScopedTerminalControlDaemon(topology?.hostTrustedHome); } catch (error) { cleanupErrors.push(error); }
  await killProcessesReferencingHome(topology?.hostTrustedHome);
  try { await terminateChild(topology?.brokerProc); } catch (error) { cleanupErrors.push(error); }
  // Reap any pane shells that survived kill-session (env-based, above) and
  // give them a moment to exit.
  await delay(800);
  await killProcessesReferencingHome(topology?.hostTrustedHome);

  const home = topology?.hostTrustedHome;
  if (home) {
    try { chmodSync(home, 0o700); } catch {}
    for (const stateRoot of [
      join(home, ".tmux-worktree", "relay-v2-host-state"),
      join(home, ".tmux-worktree", "relay-v2-state-snapshot-spool-v1"),
    ]) {
      try { chmodSync(stateRoot, 0o700); } catch {}
      try {
        for (const entry of readdirSync(stateRoot)) {
          try { chmodSync(join(stateRoot, entry), 0o700); } catch {}
        }
      } catch {}
    }
  }
  const removeHomeAndTmp = () => {
    try { if (topology?.tmpRoot) rmSync(topology.tmpRoot, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
    try { if (home) rmSync(home, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
  };
  removeHomeAndTmp();
  // A lingering pane zsh can rewrite ~/.zsh_history into the just-removed
  // home; reap once more and remove a second time.
  await delay(500);
  await killProcessesReferencingHome(home);
  removeHomeAndTmp();

  // ---- Leak counts (exact spec commands) ----
  await delay(500);
  let tmuxLeakCount = 0;
  try {
    const names = tmuxSessionNames();
    for (const name of names) {
      let paneCwd = "";
      try {
        paneCwd = execFileSync(
          "tmux",
          ["display-message", "-p", "-t", `${name}:0.0`, "#{pane_current_path}"],
          { encoding: "utf8", timeout: 5_000 },
        ).trim();
      } catch { continue; }
      if (paneCwd.includes("relay-v2-")) tmuxLeakCount += 1;
    }
  } catch {}

  let pgrepLeakCount = 0;
  try {
    const out = execFileSync("sh", [
      "-c",
      "pgrep -fl 'relayV2InteropHost|relay-server|terminal-control serve' | grep -c relay-v2- || true",
    ], { encoding: "utf8", timeout: 10_000 }).trim();
    pgrepLeakCount = Number(out) || 0;
  } catch {}

  let tmpdirLeakCount = 0;
  try {
    const out = execFileSync("sh", [
      "-c",
      "ls -d /private/tmp/relay-v2-* 2>/dev/null; ls -d \"${TMPDIR:-/tmp}\"relay-v2-* 2>/dev/null || true",
    ], { encoding: "utf8", timeout: 5_000 });
    tmpdirLeakCount = out.split("\n").filter(Boolean).length;
  } catch {}

  console.log(`LEAK tmux_sessions_relay_v2=${tmuxLeakCount}`);
  console.log(`LEAK pgrep_relay_v2=${pgrepLeakCount}`);
  console.log(`LEAK tmpdirs_relay_v2=${tmpdirLeakCount}`);
  console.log(`CSV ${csvPath}`);

  if (cleanupErrors.length > 0) {
    exitCode = 1;
    for (const error of cleanupErrors) console.error("[FAIL] cleanup:", error?.message ?? error);
  }
}

process.exit(exitCode);
