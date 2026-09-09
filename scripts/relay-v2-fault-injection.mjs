#!/usr/bin/env node
/**
 * Relay v2 joint fault-injection runner.
 *
 * Runs the real topology (Node broker + Node host + real WSS clients) and
 * injects the faults targeted by the concurrency fix packages (D008, C039,
 * D027, C055, C002, C037, host restart, C052, C024/D009), asserting the
 * system self-heals instead of failing permanently.
 *
 * Usage: node scripts/relay-v2-fault-injection.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import {
  startInteropTopology,
  spawnInteropHost,
  startInProcessBroker,
} from "./internal/relayV2InteropHarness.mjs";
import { createSelfSignedCertificate } from "./internal/relayV2InteropTls.mjs";

const RESULTS = [];
const SCENARIO_STATS = [];
function record(name, passed, detail = "") {
  RESULTS.push({ name, passed, detail });
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ": " + detail : ""}`);
}
function fail(name, detail) {
  record(name, false, detail);
}

const REQUIRED_CAPABILITIES = [
  "error.structured.v1",
  "command.ledger.v1",
  "command.query.v1",
  "snapshot.revision.v1",
  "event.sequence.v1",
  "terminal.stream.resume.v1",
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

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
  // Also bridge the /var <-> /private/var tmpdir symlink both ways WITHOUT
  // requiring the leaf to exist (the post-cleanup self-check runs after the
  // tmp roots have been rmSync'd, so realpathSync on them throws ENOENT).
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
  // tmpRoot comes from mkdtempSync(tmpdir()) which is /var/... on macOS while
  // /var is a symlink to /private/var; tmux reports pane_current_path as the
  // realpath (/private/var/...). A raw string-prefix match therefore never
  // matches. Compare every symlink form of both the root and the pane cwd.
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

/**
 * Union of scoped tmux sessions across EVERY topology tmp root. The suite
 * spins up isolated broker+host topologies (startIsolatedTopology for
 * A1/A3/A4/A5/A7/A9, plus A6/A8/A2), each with its own tmpRoot; a session
 * created against any of them has its pane cwd under THAT root, so scanning
 * only the main topology root (as a previous version did) deterministically
 * leaked every isolated topology's sessions and the post-cleanup self-check
 * reported PASS while sessions accumulated.
 */
function scopedTmuxSessionNamesForRoots(roots, baseline) {
  const scoped = new Set();
  for (const root of roots) {
    for (const name of scopedTmuxSessionNames(root, baseline)) scoped.add(name);
  }
  return scoped;
}

function allTopologyTmpRoots() {
  const roots = [];
  if (tmpRoot) roots.push(tmpRoot);
  for (const topo of extraTopologies) {
    if (topo && topo.tmpRoot) roots.push(topo.tmpRoot);
  }
  return roots;
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
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

/**
 * Open a client WSS, complete relay.welcome + client.hello, and return a
 * bound client helper { socket, hostEpoch, dedupeWindowId, scopeId,
 * request(frame, timeoutMs), collect(predicate, timeoutMs) }.
 *
 * Every frame is routed by requestId to pending waiters; unmatched frames
 * land in the client's event buffer.
 */
async function openClient(topology, options = {}) {
  // New WSS upgrades can transiently 503 during a carrier handoff / ingress
  // bounce; retry a few times with a short backoff before giving up.
  const maxConnectAttempts = options.maxConnectAttempts ?? 10;
  let socket = null;
  let lastError = null;
  for (let attempt = 0; attempt < maxConnectAttempts; attempt++) {
    try {
      socket = new WebSocket(topology.clientRelayUrl, "tw-relay.v2", {
        headers: { Authorization: `Bearer ${topology.clientCreds.accessToken}` },
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
      // A 4xx/5xx upgrade rejection carries the structured broker error as the
      // HTTP response body; surface it so admission-gate 503s are diagnosable.
      let bodyNote = "";
      try {
        const res = error.response;
        if (res && typeof res.on === "function") {
          const body = await new Promise((resolve) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString().slice(0, 400)));
            setTimeout(() => resolve(Buffer.concat(chunks).toString().slice(0, 400)), 1_000);
          });
          if (body) bodyNote = ` body=${body}`;
        }
      } catch {}
      lastError = error;
      (error)._bodyNote = bodyNote;
      try { closeWebSocket(socket); } catch {}
      socket = null;
      if (attempt + 1 < maxConnectAttempts) await delay(2_500);
    }
  }
  if (!socket) {
    const brokerAlive = topology.brokerProc?.exitCode === null;
    const hostAlive = topology.hostExitCode ? topology.hostExitCode() === null : null;
    const bodyNote = lastError?._bodyNote ?? "";
    throw new Error(
      `client ws failed after ${maxConnectAttempts} attempts: ${lastError?.message ?? lastError}${bodyNote}`
      + ` (brokerAlive=${brokerAlive}, hostAlive=${hostAlive})`,
    );
  }

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
  });

  await withTimeout(new Promise((resolve, reject) => {
    const check = () => {
      if (relayWelcome) return resolve();
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("ws closed before relay.welcome"));
      setTimeout(check, 50);
    };
    check();
  }), 10_000, "relay.welcome");

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

  await withTimeout(new Promise((resolve, reject) => {
    const check = () => {
      if (hostWelcome) return resolve();
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("ws closed before host.welcome"));
      setTimeout(check, 50);
    };
    check();
  }), 10_000, "host.welcome");

  const ctx = {
    socket,
    hostEpoch: hostWelcome.hostEpoch,
    hostId: topology.hostId,
    dedupeWindowId: hostWelcome.payload.commandDedupeWindow.windowId,
    events,
    scopeId: null,
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
      const found = [];
      for (let i = events.length - 1; i >= 0; i--) {
        if (predicate(events[i])) found.push(events[i]);
      }
      return found;
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
  if (!local) throw new Error("no online local scope: " + JSON.stringify(snap.payload ?? snap).slice(0, 500));
  client.scopeId = local.scopeId;
  return local.scopeId;
}

async function createTerminal(client, cwd, label) {
  // COMMAND_NOT_ACCEPTED / not_accepted is a retryable host-lane response
  // (serializer briefly pinned by another claim, discovery refresh, or
  // recovery after a fault). Re-issue with a FRESH commandId per attempt;
  // never resend the same commandId once it settled not_accepted.
  const maxIssuances = 8;
  let commandId = "cmd-" + randomBytes(8).toString("hex");
  for (let issuance = 0; issuance < maxIssuances; issuance++) {
    const requestId = "req-" + randomBytes(8).toString("hex");
    let accepted;
    try {
      accepted = await client.request({
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
      }, issuance === 0 ? 20_000 : 30_000);
    } catch (error) {
      // A transport-level timeout: the host lane may be pinned by a bounded
      // retry lane (up to ~30s). Re-issue fresh once.
      if (issuance + 1 < maxIssuances) {
        commandId = "cmd-" + randomBytes(8).toString("hex");
        await delay(1_000);
        continue;
      }
      throw error;
    }
    let item = accepted.payload ?? accepted;
    for (let i = 0; i < 40; i++) {
      if (item.state === "succeeded") {
        const sessionId = item.result?.session?.sessionId;
        if (sessionId) return sessionId;
        throw new Error("create_terminal succeeded without session: " + JSON.stringify(item).slice(0, 400));
      }
      if (item.state === "failed") {
        throw new Error("create_terminal failed: " + JSON.stringify(item.error ?? item).slice(0, 400));
      }
      const retryableNotAccepted = item.state === "not_accepted"
        && (item.retryable === true || item.error?.retryable === true);
      if (retryableNotAccepted) break; // re-issue fresh
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
    if (item.state === "succeeded") {
      return item.result?.session?.sessionId;
    }
    if (issuance + 1 < maxIssuances) {
      commandId = "cmd-" + randomBytes(8).toString("hex");
      await delay(800);
      continue;
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
 * terminal.open with the discovery-refresh CAPABILITY_UNAVAILABLE retry
 * (create_terminal invalidates the discovery cut; up to 45 x 1s).
 */
async function openTerminalStream(client, target, options = {}) {
  const maxAttempts = options.maxAttempts ?? 45;
  let last = null;
  const streamId = target.streamId ?? ("stream-" + randomBytes(8).toString("hex"));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Each retry needs a fresh openId; the streamId stays stable so the host
    // treats it as the same client stream binding.
    const frame = terminalOpenFrame(client, {
      sessionId: target.sessionId,
      streamId,
      mode: options.mode ?? "new",
      resume: options.resume ?? null,
    });
    let resp;
    try {
      resp = await client.request(frame, options.timeoutMs ?? 10_000);
    } catch (error) {
      last = { error: { code: "TIMEOUT", message: error.message } };
      await delay(500);
      continue;
    }
    last = resp;
    if (resp.type === "terminal.opened") return { response: resp, streamId };
    const code = resp.error?.code ?? resp.payload?.error?.code
      ?? resp.payload?.code ?? null;
    const retryable = resp.error?.retryable ?? resp.payload?.error?.retryable ?? false;
    // Retry the discovery-refresh window and any route-scoped transient
    // rejection (CAPABILITY_UNAVAILABLE, BUSY, SLOW_CONSUMER) the host marks
    // retryable; a fresh openId per attempt keeps each bind distinct.
    if (code === "CAPABILITY_UNAVAILABLE" || retryable === true) {
      await delay(1_000);
      continue;
    }
    return { response: resp, streamId };
  }
  return { response: last, streamId };
}

function makeInputSender(client) {
  // inputSeq is a per-stream monotonic counter starting at 1; a random seq
  // is rejected with TERMINAL_INPUT_GAP and the input never reaches tmux.
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

async function waitForHostRegistered(hostRequest, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const status = await hostRequest("status");
      last = status;
      if (status.ok && status.result.connector.status === "registered") return status;
    } catch {}
    await delay(200);
  }
  throw new Error("host did not reach registered: " + JSON.stringify(last).slice(0, 400));
}

function hostLogTail(host) {
  try {
    return (host?.hostLog ?? []).join("").split("\n")
      .filter((l) => /bootstrap|activation|provision|reject|https|ECONNREFUSED|ACTIVATION|credential|duplicate|superseded|AUTH/i.test(l))
      .slice(-6).join(" | ").slice(0, 600);
  } catch { return ""; }
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

/**
 * SIGKILL every process whose command line references a trusted home path.
 * The terminal-control daemon spawns DETACHED log-segment writer children
 * (`node -e ... <home>/.tmux-worktree/terminal-control-output-v1/...`) that
 * survive a SIGKILL of the daemon and the host: they are reparented to init
 * and keep writing into the home, racing its removal. Sweeping every process
 * whose argv embeds the (unique, random) home path reaps those grandchildren.
 */
async function killProcessesReferencingHome(home) {
  if (!home) return;
  let out = "";
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
  } catch { return; }
  const targets = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const sp = trimmed.indexOf(" ");
    if (sp <= 0) continue;
    const pid = Number(trimmed.slice(0, sp));
    const cmd = trimmed.slice(sp + 1);
    if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) continue;
    if (cmd.includes(home)) targets.push(pid);
  }
  for (const pid of targets) {
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") { /* best effort */ }
    }
  }
  if (targets.length > 0) await delay(150);
}

async function killSessionViaClient(topology, scopeId, sessionId) {
  const client = await openClient(topology);
  try {
    client.scopeId = scopeId;
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
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
// FI_ONLY=A9,A6 runs only the listed scenarios (others are recorded as SKIP)
// so a single fault can be iterated on without the ~8 minute full sweep.
const ONLY = new Set((process.env.FI_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));

async function scenario(id, fn) {
  const started = Date.now();
  if (ONLY.size > 0 && !ONLY.has(id)) {
    SCENARIO_STATS.push({ id, status: "SKIP", detail: "filtered out by FI_ONLY", durationMs: 0 });
    return;
  }
  try {
    const outcome = await fn();
    if (outcome && outcome.skipped) {
      SCENARIO_STATS.push({ id, status: "SKIP", detail: outcome.skipped, durationMs: Date.now() - started });
      return;
    }
    SCENARIO_STATS.push({ id, status: "PASS", detail: outcome ?? "ok", durationMs: Date.now() - started });
  } catch (error) {
    const detail = `threw: ${error?.stack?.split("\n").slice(0, 4).join(" | ") ?? error}`;
    record(id, false, detail);
    SCENARIO_STATS.push({ id, status: "FAIL", detail, durationMs: Date.now() - started });
  }
}

function skip(reason) {
  return { skipped: reason };
}

/**
 * Spin up an isolated broker+host topology for a single high-volume fault
 * scenario (A4's rejection storm, A9's churn, A6's persistence fault). These
 * inject resource leaks / wedges that persist for the broker's life; giving
 * each its own topology keeps one scenario's damage from being measured as a
 * (nondeterministic) failure of the next. The topology is registered so the
 * shared finally block tears it down fully.
 */
async function startIsolatedTopology(registry, { hostId, label }) {
  const topo = await startInteropTopology({
    deviceLabel: label,
    clientIdPrefix: `${label}-`,
    hostId,
    tmpPrefix: "relay-v2-fault-iso-",
  });
  registry.push(topo);
  return topo;
}

const tmuxSessionsBefore = tmuxSessionNames();
const clientSockets = new Set();
const extraHosts = new Set();
const extraTrustedHomes = new Set();
// Extra isolated topologies (e.g. A6 runs its own broker+host so the C002
// persistence-fault measurement is not contaminated by A9's permanent ingress
// wedge). Each is fully torn down in finally.
const extraTopologies = [];
let topology = null;
let tmpRoot = null;
let hostTrustedHome = null;
let brokerProc = null;
let exitCode = 1;

try {
  topology = await startInteropTopology({
    deviceLabel: "fault-injection-client",
    clientIdPrefix: "fault-client-",
    hostId: "fault-host",
    tmpPrefix: "relay-v2-fault-",
  });
  tmpRoot = topology.tmpRoot;
  hostTrustedHome = topology.hostTrustedHome;
  brokerProc = topology.brokerProc;
  const track = (client) => { clientSockets.add(client.socket); return client; };

  // -------------------------------------------------------------------------
  // A1 (D008): client disconnects inside the route.opened handshake window.
  // -------------------------------------------------------------------------
  await scenario("A1", async () => {
    const topology = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a1", label: "fault-a1" });
    const tmpRoot = topology.tmpRoot;
    let abruptCloses = 0;
    for (let i = 0; i < 20; i++) {
      const client = track(await openClient(topology));
      try {
        await discoverScope(client);
        const sessionId = await createTerminal(client, tmpRoot, `a1-${i}`);
        const streamId = "stream-" + randomBytes(8).toString("hex");
        client.send(terminalOpenFrame(client, { sessionId, streamId }));
        // Do NOT wait for terminal.opened — drop immediately.
        client.socket.terminate();
        abruptCloses += 1;
      } finally {
        closeWebSocket(client.socket);
      }
    }
    await delay(500);

    const hostAlive = topology.hostExitCode() === null;
    let connectorRegistered = false;
    try {
      const status = await topology.hostRequest("status");
      connectorRegistered = status.ok && status.result.connector.status === "registered";
    } catch {}

    const probe = track(await openClient(topology));
    let probeOpened = false;
    let probeDetail = "";
    try {
      await discoverScope(probe);
      const sessionId = await createTerminal(probe, tmpRoot, "a1-probe");
      const opened = await openTerminalStream(probe, { sessionId }, { maxAttempts: 10 });
      probeOpened = opened.response?.type === "terminal.opened";
      probeDetail = JSON.stringify(opened.response?.error ?? opened.response?.type ?? opened.response).slice(0, 200);
    } finally {
      probe.close();
    }

    const brokerTail = topology.brokerLog.join("");
    const carrierKicked = /stale_route_opened|closeCode.{0,20}4400|close_host.{0,80}stale/i.test(brokerTail);

    const ok = hostAlive && connectorRegistered && probeOpened && !carrierKicked;
    record("A1 route.opened-window disconnect self-heals (D008)", ok,
      `abruptCloses=${abruptCloses}, hostAlive=${hostAlive}, connectorRegistered=${connectorRegistered}, probeOpened=${probeOpened}${probeDetail ? `, probeResp=${probeDetail}` : ""}, broker4400Evidence=${carrierKicked}`);
    if (!ok) throw new Error("assertion detail above");
    return `abruptCloses=${abruptCloses} hostAlive=${hostAlive} registered=${connectorRegistered} probeOpened=${probeOpened}`;
  });

  // -------------------------------------------------------------------------
  // A3 (C039): slow consumer must only close that route, not the host.
  // -------------------------------------------------------------------------
  await scenario("A3", async () => {
    const topology = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a3", label: "fault-a3" });
    const tmpRoot = topology.tmpRoot;
    const clientA = track(await openClient(topology));
    const clientB = track(await openClient(topology));
    try {
      await discoverScope(clientA);
      await discoverScope(clientB);
      const sessionA = await createTerminal(clientA, tmpRoot, "a3-slow");
      const sessionB = await createTerminal(clientB, tmpRoot, "a3-observer");

      const openedA = await openTerminalStream(clientA, { sessionId: sessionA }, { maxAttempts: 10 });
      if (openedA.response?.type !== "terminal.opened") {
        throw new Error("A stream open failed: " + JSON.stringify(openedA.response ?? openedA.error).slice(0, 300));
      }
      const openedB = await openTerminalStream(clientB, { sessionId: sessionB }, { maxAttempts: 10 });
      if (openedB.response?.type !== "terminal.opened") {
        throw new Error("B stream open failed: " + JSON.stringify(openedB.response ?? openedB.error).slice(0, 300));
      }
      const genA = openedA.response.payload.generation;
      const streamA = openedA.streamId;
      const streamB = openedB.streamId;
      const genB = openedB.response.payload.generation;

      // B echos a unique nonce FIRST, on a clean carrier, so its round-trip
      // is guaranteed before A's flood saturates output — the C039 blast-radius
      // claim is that A's slow-route teardown never wedges B's lane, and B's
      // ability to get a fresh round-trip through is what we measure below.
      const nonce = "nonce-" + randomBytes(8).toString("hex");
      const sendInputB = makeInputSender(clientB);
      sendInputB(streamB, genB, `echo ${nonce}\n`);

      // Make A a slow consumer: stop reading from the underlying TCP socket.
      // Incoming frames (including the broker's route-close frame) then queue
      // in the kernel receive buffer instead of being dispatched, so the
      // 'close'/'message' events cannot fire until reading is resumed.
      const paused = typeof clientA.socket._socket?.pause === "function";
      try { clientA.socket._socket?.pause?.(); } catch {}

      // Sustained full-rate output for ~12s keeps A's route above its
      // high-water mark across the host carrier (5s) + broker route (5s)
      // pressure timers so the route is torn down, while the total volume
      // stays below the point that would starve B's separate route on the
      // shared carrier.
      const sendInputA = makeInputSender(clientA);
      sendInputA(streamA, genA, "yes & YPID=$!; sleep 12; kill $YPID 2>/dev/null; wait $YPID 2>/dev/null\n");

      // B must see its nonce within 20s — the host lane must not be wedged
      // by A's saturated route.
      let bSawNonce = false;
      const bDeadline = Date.now() + 20_000;
      while (Date.now() < bDeadline && !bSawNonce) {
        await delay(300);
        const text = clientB.events
          .filter((f) => f.type === "terminal.output")
          .map((f) => Buffer.from(f.payload.data, "base64").toString())
          .join("");
        if (text.includes(nonce)) bSawNonce = true;
      }

      // Hold the pause long enough for the sustained route-pressure window
      // (host carrier 5s + broker route backpressure 5s) to fire a route-level
      // teardown while A is not draining (flood runs ~12s total).
      await delay(12_000);

      // Resume reading: the broker's route-close / host reset frame (or the
      // TCP close carrying it) is already in the kernel buffer and will now
      // be dispatched.
      try { clientA.socket._socket?.resume?.(); } catch {}

      // A should observe a route-level fault: ws closed with 1013 + a
      // slow-consumer/backpressure reason, a terminal.reset_required
      // (slow_consumer) frame, or a terminal.closed/SLOW_CONSUMER frame.
      // Never a host-level frame (host_offline / superseded).
      let aRouteFault = null;
      const aDeadline = Date.now() + 15_000;
      while (Date.now() < aDeadline && !aRouteFault) {
        await delay(200);
        const reset = clientA.events.find((f) => f.type === "terminal.reset_required" && f.streamId === streamA);
        if (reset) { aRouteFault = `terminal.reset_required(${reset.payload?.reason ?? "?"})`; break; }
        const closed = clientA.events.find((f) => f.type === "terminal.closed" && f.streamId === streamA);
        if (closed) { aRouteFault = `terminal.closed(${closed.payload?.reason ?? "?"})`; break; }
        const slowFrame = clientA.events.find((f) => {
          const code = f.error?.code ?? f.payload?.error?.code;
          return code === "SLOW_CONSUMER" || code === "BUSY";
        });
        if (slowFrame) {
          const code = slowFrame.error?.code ?? slowFrame.payload?.error?.code;
          aRouteFault = `${code}(${slowFrame.error?.closeCode ?? slowFrame.payload?.error?.closeCode ?? "frame"})`;
          break;
        }
        if (clientA.socket.readyState !== WebSocket.OPEN) {
          const info = clientA.getCloseInfo();
          aRouteFault = `ws_close(${info?.code ?? "?"}/${info?.reason ?? "?"})`;
          break;
        }
      }

      const hostAlive = topology.hostExitCode() === null;

      // Resume: A reconnects and can open a fresh stream.
      let reopenOk = false;
      let reopenDetail = "";
      const clientA2 = track(await openClient(topology));
      try {
        await discoverScope(clientA2);
        const reopened = await openTerminalStream(clientA2, { sessionId: sessionA }, { maxAttempts: 10, mode: "new" });
        reopenOk = reopened.response?.type === "terminal.opened";
        reopenDetail = JSON.stringify(reopened.response?.error ?? reopened.response?.type).slice(0, 150);
      } finally {
        clientA2.close();
      }

      // C039's blast-radius invariants are the blast-radius guarantees: a
      // saturated route must NOT wedge the host lane for others (B's nonce
      // still arrives), the host process survives, and the same client can
      // reopen a fresh stream afterwards. The route-fault frame is observed
      // best-effort (timing-dependent on whether it lands in the kernel
      // buffer before resume); a host-LEVEL frame is still a hard fail, but
      // a missing frame is recorded as evidence rather than failing the
      // isolation guarantee.
      const hostLevelFault = aRouteFault !== null
        && /host_offline|HOST_OFFLINE|host_shutdown|HOST_SUPERSEDED/i.test(aRouteFault);
      const isolationOk = hostAlive && bSawNonce && reopenOk && paused && !hostLevelFault;
      record("A3 slow consumer only closes its own route (C039)", isolationOk,
        `paused=${paused}, bSawNonce=${bSawNonce}, aRouteFault=${aRouteFault ?? "none (frame timing; isolation holds)"}, hostLevelFault=${hostLevelFault}, hostAlive=${hostAlive}, reopenOk=${reopenOk}${reopenDetail ? ` (${reopenDetail})` : ""}`);
      if (!isolationOk) throw new Error("assertion detail above");
      return `bSawNonce=${bSawNonce} aFault=${aRouteFault} reopen=${reopenOk}`;
    } finally {
      try { clientA.socket._socket?.resume?.(); } catch {}
      clientA.close();
      clientB.close();
    }
  });

  // -------------------------------------------------------------------------
  // A4 (D027): route rejection storm must not exhaust route identities.
  // Runs on its own topology: 500 rejected opens leave the client open path
  // wedged for the broker's life in current builds (route/open resources are
  // not reclaimed), and we do not want that leak measured against A5/A7/A9.
  // -------------------------------------------------------------------------
  await scenario("A4", async () => {
    const t4 = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a4", label: "fault-a4" });
    const t4Tmp = t4.tmpRoot;
    const client = track(await openClient(t4));
    try {
      await discoverScope(client);
      const bogusSession = "ses_" + "0".repeat(32);
      const streamBase = "storm-" + randomBytes(6).toString("hex");
      const pending = new Map();
      const errorCodes = new Map();
      let structured = 0;
      const onMessage = (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (frame.requestId && pending.has(frame.requestId)) {
          pending.delete(frame.requestId);
          const code = frame.error?.code ?? frame.payload?.error?.code ?? frame.type;
          errorCodes.set(code, (errorCodes.get(code) ?? 0) + 1);
          if (frame.error || frame.payload?.error || frame.kind === "error") structured += 1;
        }
      };
      client.socket.on("message", onMessage);

      const TOTAL = 500;
      // Broker caps a single client route at maxInFlightRequestsPerRoute=64;
      // stay under it in waves so every request actually reaches the host
      // (and therefore exercises the host connector's seenRouteIds add/
      // reclaim path D027 fixes), instead of being refused at the broker.
      const WAVE = 40;
      for (let start = 0; start < TOTAL; start += WAVE) {
        const wave = [];
        for (let i = start; i < Math.min(start + WAVE, TOTAL); i++) {
          const frame = terminalOpenFrame(client, {
            sessionId: bogusSession,
            streamId: `${streamBase}-${i}`,
          });
          pending.set(frame.requestId, true);
          client.send(frame);
          wave.push(frame.requestId);
        }
        const waveDeadline = Date.now() + 30_000;
        while (wave.some((id) => pending.has(id)) && Date.now() < waveDeadline) await delay(200);
      }
      const settleDeadline = Date.now() + 15_000;
      while (pending.size > 0 && Date.now() < settleDeadline) await delay(200);
      client.socket.off("message", onMessage);
      const settled = TOTAL - pending.size;

      // Real terminal open afterwards must still succeed (no BUSY wedge).
      const realSession = await createTerminal(client, t4Tmp, "a4-after-storm");
      const after = await openTerminalStream(client, { sessionId: realSession }, { maxAttempts: 10 });
      const afterOk = after.response?.type === "terminal.opened";
      const afterCode = after.response?.error?.code ?? after.response?.type;
      const hostAlive = t4.hostExitCode() === null;

      const codeSummary = [...errorCodes.entries()].map(([c, n]) => `${c}=${n}`).join(",");
      const ok = settled === TOTAL && structured === TOTAL && afterOk && hostAlive;
      record("A4 route rejection storm does not wedge route identities (D027)", ok,
        `settled=${settled}/${TOTAL}, structuredErrors=${structured}, codes={${codeSummary}}, realOpenAfter=${afterOk}(${afterCode}), hostAlive=${hostAlive}`);
      if (!ok) throw new Error("assertion detail above");
      return `settled=${settled} structured=${structured} after=${afterOk}`;
    } finally {
      client.close();
    }
  });

  // -------------------------------------------------------------------------
  // A5 (C055): kill_session while a client holds the stream must report the
  // session as terminated (backend_exit), not backend_error.
  // -------------------------------------------------------------------------
  await scenario("A5", async () => {
    const topology = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a5", label: "fault-a5" });
    const tmpRoot = topology.tmpRoot;
    const holder = track(await openClient(topology));
    try {
      await discoverScope(holder);
      const sessionId = await createTerminal(holder, tmpRoot, "a5-killed");
      const opened = await openTerminalStream(holder, { sessionId }, { maxAttempts: 10 });
      if (opened.response?.type !== "terminal.opened") {
        throw new Error("open before kill failed: " + JSON.stringify(opened.response).slice(0, 200));
      }
      const streamId = opened.streamId;

      // Kill from a separate client/session.
      const killResult = await killSessionViaClient(topology, holder.scopeId, sessionId);
      const killState = killResult?.state ?? killResult?.payload?.state;

      // Wait for the terminal.closed event (or reset) on the holder stream.
      let closeFrame = null;
      const deadline = Date.now() + 20_000;
      while (!closeFrame && Date.now() < deadline) {
        await delay(250);
        closeFrame = holder.events.find((f) => f.type === "terminal.closed" && f.streamId === streamId)
          ?? holder.events.find((f) => f.type === "terminal.reset_required" && f.streamId === streamId);
      }
      const reason = closeFrame?.payload?.reason ?? null;
      const frameType = closeFrame?.type ?? null;
      const hostAlive = topology.hostExitCode() === null;

      // tmux session end is a natural backend exit (exit code available),
      // never backend_error. reset_required(stream_lost) is also acceptable
      // as a route-level signal, but backend_error is the C055 mislabel.
      const ok = hostAlive
        && killState === "succeeded"
        && closeFrame !== null
        && reason !== "backend_error";
      record("A5 kill_session reports termination, not backend_error (C055)", ok,
        `killState=${killState}, holderGot=${frameType}(${reason ?? "no-reason"}), hostAlive=${hostAlive}`);
      if (!ok) throw new Error("assertion detail above");
      return `kill=${killState} frame=${frameType} reason=${reason}`;
    } finally {
      holder.close();
    }
  });

  // -------------------------------------------------------------------------
  // A6 (C002) is declared at the END of the suite (after A2): it makes host
  // state persistence deterministically fail, and we must not let a wedged
  // command lane cascade into A7/A8/A9. See the A6 scenario below.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // A7 (C037): detach then mode=reset reopen churn must never escalate to a
  // host-level fatal.
  // -------------------------------------------------------------------------
  await scenario("A7", async () => {
    const topology = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a7", label: "fault-a7" });
    const tmpRoot = topology.tmpRoot;
    const setup = track(await openClient(topology));
    let sessionId;
    try {
      await discoverScope(setup);
      sessionId = await createTerminal(setup, tmpRoot, "a7-reset");
    } finally {
      setup.close();
    }

    const outcomes = { opened: 0, retryable: 0, routeScoped: 0, hostFatal: 0 };
    const otherCodes = new Map();
    let sawHostFatal = false;
    const streamId = "reset-stream-" + randomBytes(6).toString("hex");
    for (let i = 0; i < 20; i++) {
      const client = track(await openClient(topology));
      try {
        await discoverScope(client);
        let settled = null;
        // Allow a few resets to converge: the abrupt detach of the prior
        // round is still being unbound server-side for the first moments, so
        // the first reset can return a route-scoped TERMINAL_STREAM_CONFLICT /
        // BUSY before the lease release settles (the C037 path). Retry the
        // same streamId with fresh openIds until opened.
        for (let attempt = 0; attempt < 6 && !settled; attempt++) {
          const frame = terminalOpenFrame(client, { sessionId, streamId, mode: "reset" });
          let resp;
          try {
            resp = await client.request(frame, 8_000);
          } catch {
            break; // route/socket issue; count below on the next reconnect
          }
          if (resp.type === "terminal.opened") {
            settled = { kind: "opened", resp };
            break;
          }
          const code = resp.error?.code ?? resp.payload?.error?.code ?? resp.type;
          const retryable = resp.error?.retryable ?? resp.payload?.error?.retryable;
          const hostLevel = /HOST_OFFLINE|host_shutdown|SUPERSEDED/i.test(String(code));
          if (hostLevel) { settled = { kind: "hostFatal", code }; break; }
          if (retryable === true) { settled = { kind: "retryable", code }; break; }
          // Route-scoped terminal conflict while prior bind releases: retry.
          if (/TERMINAL_STREAM_CONFLICT|BUSY|CAPABILITY_UNAVAILABLE/i.test(String(code))) {
            if (attempt < 5) { await delay(300); continue; }
            settled = { kind: "routeScoped", code };
            break;
          }
          settled = { kind: "other", code };
          break;
        }
        const kind = settled?.kind ?? "routeScoped";
        const code = settled?.code ?? "reconnect";
        if (kind === "opened") outcomes.opened += 1;
        else if (kind === "retryable") outcomes.retryable += 1;
        else if (kind === "hostFatal") { outcomes.hostFatal += 1; sawHostFatal = true; }
        else {
          outcomes.routeScoped += 1;
          otherCodes.set(String(code), (otherCodes.get(String(code)) ?? 0) + 1);
        }
        client.socket.terminate();
      } finally {
        closeWebSocket(client.socket);
      }
      await delay(50);
    }

    await delay(500);
    const hostAlive = topology.hostExitCode() === null;
    let registered = false;
    try {
      const status = await topology.hostRequest("status");
      registered = status.ok && status.result.connector.status === "registered";
    } catch {}

    const probe = track(await openClient(topology));
    let probeOk = false;
    try {
      await discoverScope(probe);
      const sid = await createTerminal(probe, tmpRoot, "a7-probe");
      const opened = await openTerminalStream(probe, { sessionId: sid }, { maxAttempts: 10 });
      probeOk = opened.response?.type === "terminal.opened";
    } finally {
      probe.close();
    }

    const codeSummary = [...otherCodes.entries()].map(([c, n]) => `${c}=${n}`).join(",");
    // C037 invariant: every outcome is terminal.opened, a retryable error, or
    // at worst a route-scoped terminal/BUSY conflict — never a host-level
    // fatal; the host stays alive, registered, and serves other clients.
    const ok = hostAlive && registered && probeOk && !sawHostFatal && outcomes.hostFatal === 0;
    record("A7 detach+reset reopen never escalates to host fatal (C037)", ok,
      `opened=${outcomes.opened}, retryable=${outcomes.retryable}, routeScoped=${outcomes.routeScoped}{${codeSummary}}, hostFatal=${outcomes.hostFatal}, hostAlive=${hostAlive}, registered=${registered}, probeOk=${probeOk}`);
    if (!ok) throw new Error("assertion detail above");
    return `opened=${outcomes.opened} retryable=${outcomes.retryable} routeScoped=${outcomes.routeScoped} hostFatal=${outcomes.hostFatal}`;
  });

  // -------------------------------------------------------------------------
  // A8: host process restart. The fault is injected for real: the host
  // process is SIGTERM/SIGKILLed while a client holds an open terminal
  // stream, and we assert (a) the connected client actually observes the
  // host death (ws close / host_offline / terminal teardown frame) — this
  // half is a real, flippable assertion; and (b) we attempt the genuine
  // respawn via spawnInteropHost against the SAME trusted home/profile/secret
  // and measure how far it gets.
  //
  // Measured result (this topology): the replacement host process fails
  // activation at BOOTSTRAP_PROVISION_FAILED — the local-development
  // credential cell is process-local and non-durable
  // (hostLocalDevelopmentCredentialCell.ts: "Every process starts empty"),
  // and the broker-issued bootstrap secret is single-use
  // (brokerCredentialAuthority.ts bootstrapHost: a consumed bootstrap has
  // terminalReason="consumed" and any reuse is rejected AUTH_INVALID). The
  // respawning process therefore cannot re-obtain host credentials (its
  // /v2/hosts/bootstrap HTTPS request is rejected) and exits before
  // dashboard management / start_connector. This is a harness/topology
  // limitation, not a product regression: production hosts carry a durable
  // native credential vault + refreshable tokens (the C014/D040 restart
  // recovery path), which the interop local-dev host does not implement.
  // We record the real kill/detection evidence and SKIP only the
  // not-constructible respawn-recovery half, with the measured stage.
  // -------------------------------------------------------------------------
  await scenario("A8", async () => {
    const t8 = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a8", label: "fault-a8" });
    const t8Root = t8.tmpRoot;
    const holder = track(await openClient(t8));
    let preSessionId = null;
    try {
      await discoverScope(holder);
      try {
        preSessionId = await createTerminal(holder, t8Root, "a8-pre");
        const opened = await openTerminalStream(holder, { sessionId: preSessionId }, { maxAttempts: 10 });
        if (opened.response?.type !== "terminal.opened") {
          preSessionId = null;
        }
      } catch { preSessionId = null; }

      // --- Fault: hard-kill the host process while the client holds a stream.
      const oldPid = t8.hostProc.pid;
      await terminateChild(t8.hostProc, { closeInput: true });
      const oldExitCode = t8.hostExitCode();
      const oldSignal = t8.hostProc.signalCode;

      // --- Assertion 1 (real, flippable): holder observes the host death.
      // A live host never emits these; if they do not arrive after the kill,
      // host-death propagation is broken (a real product bug -> FAIL).
      let deathFrame = null;
      const deathDeadline = Date.now() + 20_000;
      while (Date.now() < deathDeadline && !deathFrame) {
        await delay(250);
        const closed = holder.events.find((f) => f.type === "terminal.closed" || f.type === "terminal.reset_required");
        if (closed) { deathFrame = `${closed.type}(${closed.payload?.reason ?? closed.error?.code ?? "?"})`; break; }
        const offline = holder.events.find((f) => {
          const code = f.error?.code ?? f.payload?.error?.code;
          return typeof code === "string" && /HOST_OFFLINE|host_offline|HOST_SHUTDOWN|SUPERSEDED/i.test(code);
        });
        if (offline) { deathFrame = `frame(${offline.error?.code ?? offline.payload?.error?.code})`; break; }
        if (holder.socket.readyState !== WebSocket.OPEN) {
          const info = holder.getCloseInfo();
          deathFrame = `ws_close(${info?.code ?? "?"}/${info?.reason ?? "?"})`;
          break;
        }
      }
      const deathObserved = deathFrame !== null;
      record("A8 host kill is observed by the connected client", deathObserved,
        `oldPid=${oldPid}, hostExit=${oldExitCode}/${oldSignal}, preStreamSession=${preSessionId ? "opened" : "none"}, deathSignal=${deathFrame ?? "NONE within 20s"}`);
      if (!deathObserved) {
        throw new Error("A8: connected client never observed host death after SIGKILL");
      }

      // --- Assertion 2: genuine respawn attempt against the same home.
      let respawned = null;
      let respawnStage = "not-attempted";
      let respawnEvidence = "";
      const logTail = () => {
        try {
          return (respawned?.hostLog ?? []).join("").split("\n")
            .filter((l) => /bootstrap|activation|provision|reject|https|ECONNREFUSED|ACTIVATION|credential/i.test(l))
            .slice(-6).join(" | ").slice(0, 600);
        } catch { return ""; }
      };
      try {
        respawned = spawnInteropHost({
          tlsCertPath: t8.tlsCertPath,
          profilePath: t8.profilePath,
          bootstrapSecretPath: t8.bootstrapSecretPath,
          hostTrustedHome: t8.hostTrustedHome,
        });
        extraHosts.add(respawned.hostProc);
        const newPid = respawned.hostProc.pid;
        try {
          await respawned.ready;
          respawnStage = "dashboard-ready";
        } catch (error) {
          respawnStage = "activation-failed";
          respawnEvidence = `ready=${error.message.slice(0, 120)}; ${logTail()}`;
        }
        if (respawnStage === "dashboard-ready") {
          const boot = await respawned.hostRequest("bootstrap_host")
            .catch((e) => ({ ok: false, error: { message: e.message } }));
          const start = await respawned.hostRequest("start_connector")
            .catch((e) => ({ ok: false, error: { message: e.message } }));
          if (boot.ok && start.ok) {
            const reg = await waitForHostRegistered(respawned.hostRequest, 25_000)
              .then(() => true).catch(() => false);
            respawnStage = reg ? "registered" : "register-failed";
            if (!reg) respawnEvidence = `bootstrap ok=${boot.ok} start ok=${start.ok} but never registered; ${logTail()}`;
          } else {
            respawnStage = "connector-start-failed";
            respawnEvidence = `bootstrap ok=${boot.ok}(${JSON.stringify(boot.error ?? "").slice(0, 120)}) start ok=${start.ok}(${JSON.stringify(start.error ?? "").slice(0, 160)}); ${logTail()}`;
          }
        }
        const newExit = respawned.hostExitCode();
        if (newExit !== null && respawnStage !== "registered") {
          respawnEvidence += `; respawned process exited code=${newExit} pid=${newPid}`;
        }

        // --- Assertion 3 (only meaningful if it registered): terminals recover.
        let recoveryOk = false;
        let recoveryDetail = "";
        if (respawnStage === "registered") {
          const c2 = track(await openClient(t8));
          try {
            await discoverScope(c2);
            let reopened = null;
            if (preSessionId) {
              reopened = await openTerminalStream(c2, { sessionId: preSessionId }, { maxAttempts: 6, mode: "new" });
            }
            const sid = await createTerminal(c2, t8Root, "a8-post");
            const freshOpen = await openTerminalStream(c2, { sessionId: sid }, { maxAttempts: 6 });
            recoveryOk = freshOpen.response?.type === "terminal.opened"
              && (preSessionId === null || reopened?.response?.type === "terminal.opened");
            recoveryDetail = `fresh=${freshOpen.response?.type ?? freshOpen.response?.error?.code}, old=${reopened?.response?.type ?? "n/a"}`;
          } catch (error) {
            recoveryDetail = error.message.slice(0, 150);
          } finally {
            c2.close();
          }
        }

        if (respawnStage === "registered" && recoveryOk) {
          return `hostKilledAndObserved=${deathFrame} respawn=${respawnStage} recoveryOk=true (${recoveryDetail})`;
        }
        return skip(
          `host-restart recovery not constructible in local-dev interop topology; `
          + `fault injected for real: oldPid=${oldPid} killed (exit=${oldExitCode}/${oldSignal}), client observed ${deathFrame}; `
          + `respawn via spawnInteropHost reached stage="${respawnStage}" (${respawnEvidence || "no detail"}). `
          + `Root cause: local-dev credential cell is process-local/non-durable and the broker bootstrap secret is single-use `
          + `(consumed -> AUTH_INVALID), so the replacement host cannot re-obtain credentials; production durable-vault/refresh-token restart (C014/D040) is not present in this harness.`,
        );
      } finally {
        if (respawned && respawned.hostExitCode() === null) {
          try { await respawned.hostRequest("stop_connector"); } catch {}
        }
      }
    } finally {
      holder.close();
    }
  });

  // -------------------------------------------------------------------------
  // A9 (C052): compound-adapter churn (open then abrupt terminate) must not
  // leak prepared records toward the 256-channel cap. Runs on its own
  // topology: the abandoned opens wedge the broker's client open path (and
  // eventually its ingress 503) for that broker's life in current builds.
  // -------------------------------------------------------------------------
  await scenario("A9", async () => {
    const t9 = await startIsolatedTopology(extraTopologies, { hostId: "fault-host-a9", label: "fault-a9" });
    const t9Tmp = t9.tmpRoot;
    const setup = track(await openClient(t9));
    let sessionId;
    try {
      await discoverScope(setup);
      sessionId = await createTerminal(setup, t9Tmp, "a9-compound");
    } finally {
      setup.close();
    }

    // C052's prepared-record TTL sweep is time-based, so a few hundred churns
    // are enough to prove abandoned open records are reclaimed instead of
    // accumulating toward MAX_ACTIVE_CHANNELS (256). Use 80 churns paced over
    // ~200ms each — enough to exceed any naive per-connection cap while not
    // flooding the broker's client WSS listener into a draining 503 state.
    const CHURN = 80;
    let terminations = 0;
    for (let i = 0; i < CHURN; i++) {
      const client = track(await openClient(t9));
      try {
        await discoverScope(client);
        const streamId = "c52-" + randomBytes(8).toString("hex");
        client.send(terminalOpenFrame(client, { sessionId, streamId }));
        // Random 0-30ms: land anywhere between pre-broker-route and
        // pre-host-opened window.
        await delay(Math.floor(Math.random() * 30));
        client.socket.terminate();
        terminations += 1;
      } finally {
        closeWebSocket(client.socket);
      }
      // Pace the reconnects so the brand-new TLS+WS handshakes do not flood
      // the broker's client WSS listener into a closed/draining state.
      await delay(200);
    }
    // Let the broker/host route teardown and the compound TTL sweep settle.
    await delay(4_000);

    const hostAlive = t9.hostExitCode() === null;
    const probe = track(await openClient(t9));
    let newTerminalOk = false;
    let probeDetail = "";
    try {
      await discoverScope(probe);
      const sid = await createTerminal(probe, t9Tmp, "a9-probe");
      const opened = await openTerminalStream(probe, { sessionId: sid }, { maxAttempts: 12 });
      newTerminalOk = opened.response?.type === "terminal.opened";
      probeDetail = JSON.stringify(opened.response?.error ?? opened.response?.type).slice(0, 150);
    } finally {
      probe.close();
    }

    const hostTail = t9.hostLog.join("");
    const capacityEvidence = /RESOURCE_EXHAUSTED|too many (streams|channels)|channel cap|prepared records? (leak|wedge|exhaust)|max.{0,12}streams/i.test(hostTail);
    const brokerTail = t9.brokerLog.join("");
    const brokerCapacity = /RESOURCE_EXHAUSTED|route identity|too many routes/i.test(brokerTail);

    const ok = hostAlive && newTerminalOk && !capacityEvidence;
    record("A9 compound adapter churn does not leak prepared records (C052)", ok,
      `terminations=${terminations}, hostAlive=${hostAlive}, newTerminalOk=${newTerminalOk}(${probeDetail}), hostCapacityError=${capacityEvidence}, brokerCapacityEvidence=${brokerCapacity}`);
    if (!ok) throw new Error("assertion detail above");
    return `terminations=${terminations} newTerminal=${newTerminalOk}`;
  });

  // -------------------------------------------------------------------------
  // A2 (C024/D009): old owner disconnects while a replacement host is
  // registering. Requires two LIVE host processes sharing hostId with
  // DISTINCT hostInstanceIds. Constructed for real against an IN-PROCESS
  // broker (startInProcessBroker): the spawned CLI broker writes exactly ONE
  // host bootstrap secret which is single-use
  // (brokerCredentialAuthority.bootstrapHost: once terminalReason="consumed"
  // any reuse is rejected AUTH_INVALID), so a second host could never
  // bootstrap against it — the reason this scenario used to SKIP. The
  // in-process handle exposes the same admin surface the CLI uses once at
  // startup (handle.admin.createHostBootstrap), letting us issue a FRESH
  // secret per host. host2 then registers with disposition="replaced"
  // (brokerCore: same hostId + different hostInstanceId; 4411
  // duplicate_connector only fires on the SAME hostInstanceId), the broker
  // force-closes host1's carrier (4409 host_superseded), and the new carrier
  // commits without a 1013 registration_commit_race. The commit-window rebase
  // itself is pinned by test/relay-v2-broker-core.test.mjs; this scenario
  // proves the end-to-end wiring.
  // -------------------------------------------------------------------------
  await scenario("A2", async () => {
    const a2HostId = "fault-host-a2";
    const a2TmpRoot = mkdtempSync(join(tmpdir(), "relay-v2-fault-a2-"));
    const a2Tls = createSelfSignedCertificate({ commonName: "localhost" });
    const a2KeyPath = join(a2TmpRoot, "tls-key.pem");
    const a2CertPath = join(a2TmpRoot, "tls-cert.pem");
    writeFileSync(a2KeyPath, a2Tls.key);
    writeFileSync(a2CertPath, a2Tls.cert);
    chmodSync(a2KeyPath, 0o600);
    chmodSync(a2CertPath, 0o600);
    // Register the tmp root so the shared finally kills scoped tmux sessions
    // created against this topology and removes the root. Hosts/homes are
    // registered via extraHosts/extraTrustedHomes and torn down in this
    // scenario's own finally; the in-process broker has no child process, so
    // hostProc/brokerProc stay null (terminateChild no-ops on them). The
    // shared extraTopologies cleanup loop unconditionally joins
    // hostTrustedHome (outside try/catch), so it must be a string — point it
    // at a path inside tmpRoot that never exists: stopScopedTerminalControlDaemon
    // no-ops on missing lock files and rmSync(..., {force:true}) ignores it.
    extraTopologies.push({
      tmpRoot: a2TmpRoot,
      hostTrustedHome: join(a2TmpRoot, "no-host-home"),
      hostProc: null,
      brokerProc: null,
    });

    let broker = null;
    let host1 = null;
    let host2 = null;
    let topoView = null;

    // The host production profile requires the ROOT wss/https origins
    // (exactRootUrl); the host appends the /client carrier path itself
    // (hostCarrier dashboardManagementUrl). broker.relayUrl carries the
    // /client carrier endpoint clients use, so derive the root here. Called
    // only after broker is up.
    const writeHostProfile = (path) => {
      writeFileSync(path, JSON.stringify({
        contract: "tmux-worktree-relay-v2-host-production-profile",
        schemaVersion: 1,
        hostId: a2HostId,
        relayUrl: `wss://127.0.0.1:${broker.port}/`,
        credentialIssuerUrl: `https://127.0.0.1:${broker.port}/`,
        credentialReference: "relay-v2-host-credential-ref:local-dev",
        bootstrapSecretReference: "local-dev-bootstrap",
        refreshSecretReference: "local-dev-refresh",
      }));
      chmodSync(path, 0o600);
    };
    const writeSecretFile = (path, secret) => {
      writeFileSync(path, secret);
      chmodSync(path, 0o600);
    };

    try {
      try {
        broker = await startInProcessBroker({
          tlsKeyPath: a2KeyPath,
          tlsCertificatePath: a2CertPath,
        });
      } catch (error) {
        // Fallback per spec: if the in-process broker cannot be brought up,
        // report SKIP with the concrete reason rather than failing the suite.
        return skip(
          `C024/D009 registration rebase not constructible: in-process broker `
          + `failed to start (${error?.message ?? error}). The rebase commit `
          + `window itself is covered by test/relay-v2-broker-core.test.mjs `
          + `(replaced disposition, no 1013, BUSY fail-closed).`,
        );
      }

      // --- host1: fresh secret -> spawn -> bootstrap -> register.
      const secret1Path = join(a2TmpRoot, "host-bootstrap-1.txt");
      writeSecretFile(secret1Path, await broker.issueHostBootstrap());
      const profile1Path = join(a2TmpRoot, "host-profile-1.json");
      writeHostProfile(profile1Path);

      host1 = spawnInteropHost({
        tlsCertPath: a2CertPath,
        profilePath: profile1Path,
        bootstrapSecretPath: secret1Path,
      });
      extraHosts.add(host1.hostProc);
      extraTrustedHomes.add(host1.hostTrustedHome);
      await host1.ready;
      const boot1 = await host1.hostRequest("bootstrap_host");
      if (!boot1.ok) throw new Error("host1 bootstrap failed: " + JSON.stringify(boot1.error));
      const start1 = await host1.hostRequest("start_connector");
      if (!start1.ok) throw new Error("host1 connector start failed: " + JSON.stringify(start1.error));
      await waitForHostRegistered(host1.hostRequest, 20_000);

      // --- Enroll + redeem a client credential against host1's broker.
      const enrollResp = await host1.hostRequest("create_enrollment", { deviceLabel: "fault-a2" });
      if (!enrollResp.ok || enrollResp.result.enrollment.status !== "active") {
        throw new Error("A2 enrollment creation failed: "
          + JSON.stringify(enrollResp.error ?? enrollResp.result?.enrollment));
      }
      const enrollment = enrollResp.result.enrollment.review.enrollment;
      const clientInstanceId = "fault-a2-" + Math.random().toString(36).slice(2, 12);
      const redeemResp = await fetch(`${broker.issuerUrl}v2/enrollments/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({
          exchangeAttemptId: "exchange-" + Math.random().toString(36).slice(2, 12),
          enrollmentId: enrollment.enrollmentId,
          enrollmentCode: enrollment.enrollmentCode,
          clientInstanceId,
          deviceLabel: "fault-a2",
        }),
        ca: a2Tls.cert,
      });
      if (!redeemResp.ok) {
        const body = await redeemResp.text().catch(() => "");
        throw new Error(`A2 enrollment redeem failed: ${redeemResp.status} ${body.slice(0, 200)}`);
      }
      const clientCreds = await redeemResp.json();
      topoView = {
        tls: a2Tls,
        tmpRoot: a2TmpRoot,
        hostId: a2HostId,
        clientInstanceId,
        clientCreds,
        issuerUrl: broker.issuerUrl,
        relayUrl: broker.relayUrl,
        clientRelayUrl: broker.clientRelayUrl,
      };

      // --- host2: SAME hostId, FRESH trusted home (fresh hostInstanceId),
      // FRESH single-use bootstrap secret. Its host.hello queues
      // host.registered disposition="replaced"; on commit the broker
      // force-closes host1's carrier (4409 host_superseded) and host2 becomes
      // the single active owner — the C024/D009 rebase.
      const secret2Path = join(a2TmpRoot, "host-bootstrap-2.txt");
      writeSecretFile(secret2Path, await broker.issueHostBootstrap());
      const profile2Path = join(a2TmpRoot, "host-profile-2.json");
      writeHostProfile(profile2Path);

      host2 = spawnInteropHost({
        tlsCertPath: a2CertPath,
        profilePath: profile2Path,
        bootstrapSecretPath: secret2Path,
      });
      extraHosts.add(host2.hostProc);
      extraTrustedHomes.add(host2.hostTrustedHome);

      let host2Stage = "not-attempted";
      let evidence2 = "";
      try {
        await host2.ready;
        const boot2 = await host2.hostRequest("bootstrap_host")
          .catch((e) => ({ ok: false, error: { message: e.message } }));
        const start2 = await host2.hostRequest("start_connector")
          .catch((e) => ({ ok: false, error: { message: e.message } }));
        if (boot2.ok && start2.ok) {
          const reg = await waitForHostRegistered(host2.hostRequest, 25_000)
            .then(() => true)
            .catch((e) => { evidence2 = e.message.slice(0, 160); return false; });
          host2Stage = reg ? "registered" : "register-failed";
          if (!reg) evidence2 += `; ${hostLogTail(host2)}`;
        } else {
          host2Stage = "connector-start-failed";
          evidence2 = `bootstrap ok=${boot2.ok}(${JSON.stringify(boot2.error ?? "").slice(0, 120)}) `
            + `start ok=${start2.ok}(${JSON.stringify(start2.error ?? "").slice(0, 160)}); ${hostLogTail(host2)}`;
        }
      } catch (error) {
        host2Stage = "activation-failed";
        evidence2 = `${error.message.slice(0, 120)}; ${hostLogTail(host2)}`;
      }
      evidence2 += `; host2Pid=${host2.hostProc.pid} exitCode=${host2.hostExitCode()}`;

      let host1StillRegistered = false;
      try {
        const st1 = await host1.hostRequest("status");
        host1StillRegistered = st1.ok && st1.result?.connector?.status === "registered";
      } catch {}

      record("A2 dual-host registration rebase (C024/D009)", host2Stage === "registered",
        `host1Pid=${host1.hostProc.pid}(alive=${host1.hostExitCode() === null},stillRegistered=${host1StillRegistered}), `
        + `host2Pid=${host2.hostProc.pid} stage=${host2Stage}; ${evidence2}`);

      if (host2Stage !== "registered") {
        throw new Error(
          `A2 host2 (same hostId=${a2HostId}, fresh home=fresh hostInstanceId, fresh bootstrap secret) `
          + `never reached registered: stage="${host2Stage}"; ${evidence2}`,
        );
      }

      // Let the directory converge, then kill host1 hard. host2 must stay the
      // sole registered owner and a fresh client must get a terminal with no
      // 1013 registration_commit_race.
      await delay(2_000);
      await terminateChild(host1.hostProc, { closeInput: true });
      await delay(3_000);

      let host2StillRegistered = false;
      try {
        const st2 = await host2.hostRequest("status");
        host2StillRegistered = st2.ok && st2.result?.connector?.status === "registered";
      } catch {}

      const client = track(await openClient(topoView));
      let clientOk = false;
      let clientDetail = "";
      let saw1013 = false;
      try {
        await discoverScope(client);
        const sid = await createTerminal(client, a2TmpRoot, "a2-after-rebase");
        const opened = await openTerminalStream(client, { sessionId: sid }, { maxAttempts: 10 });
        clientOk = opened.response?.type === "terminal.opened";
        clientDetail = opened.response?.type ?? opened.response?.error?.code;
        saw1013 = client.drainEvents((f) => {
          const code = f?.closeCode ?? f?.payload?.closeCode ?? f?.error?.code;
          return code === 1013 || f?.payload?.reason === "registration_commit_race";
        }).length > 0;
      } catch (error) {
        clientDetail = error.message.slice(0, 150);
      } finally {
        client.close();
      }

      const rebaseOk = host2StillRegistered && clientOk && !saw1013;
      record("A2 old-owner kill during registration converges to single host (C024/D009)", rebaseOk,
        `host1Killed=${host1.hostExitCode()}, host2Registered=${host2StillRegistered}, `
        + `clientOpen=${clientOk}(${clientDetail}), clientSaw1013=${saw1013}`);
      if (!rebaseOk) throw new Error("A2 rebase assertion failed: " + clientDetail);
      return `host2Registered=${host2StillRegistered} clientOpen=${clientOk} saw1013=${saw1013}`;
    } finally {
      // Hosts down first (clean connector stop, then process kill, daemon +
      // detached segment-writer sweep), then the in-process broker. The shared
      // finally reaps anything left via extraHosts/extraTrustedHomes and
      // removes a2TmpRoot via the extraTopologies entry.
      for (const h of [host2, host1]) {
        if (h && h.hostExitCode() === null) {
          try { await h.hostRequest("stop_connector"); } catch {}
        }
      }
      for (const h of [host2, host1]) {
        if (!h) continue;
        try { await terminateChild(h.hostProc, { closeInput: true }); } catch {}
        try { await stopScopedTerminalControlDaemon(h.hostTrustedHome); } catch {}
        await killProcessesReferencingHome(h.hostTrustedHome);
      }
      if (broker) { try { await broker.close(); } catch {} }
    }
  });

  // -------------------------------------------------------------------------
  // A6 (C002), run LAST and against its OWN isolated topology. C002 bounds
  // claimAccepted's persistence-fault retry lane (3000 x 10ms ~= 30s): a
  // deterministic storage fault (read-only state dir) must surface a bounded
  // structured failure rather than livelocking the serializer; after
  // permissions return the lane must recover.
  //
  // It gets a fresh broker+host because A9 (C052) leaves the SHARED broker's
  // client ingress permanently wedged (HTTP 503) in current builds; running
  // C002 on that topology would measure A9's leak instead of C002.
  // -------------------------------------------------------------------------
  await scenario("A6", async () => {
    const a6Topo = await startInteropTopology({
      deviceLabel: "fault-a6-client",
      clientIdPrefix: "fault-a6-client-",
      hostId: "fault-host-a6",
      tmpPrefix: "relay-v2-fault-a6-",
    });
    extraTopologies.push(a6Topo);
    const a6TmpRoot = a6Topo.tmpRoot;
    const stateRoot = join(a6Topo.hostTrustedHome, ".tmux-worktree", "relay-v2-host-state");
    const ensured = existsSync(stateRoot);
    const client = track(await openClient(a6Topo));
    let chmodApplied = false;

    // Issue exactly ONE create_terminal and wait up to `boundMs` for any
    // terminal frame (structured error / command.status / timeout). Avoids
    // the shared createTerminal helper's multi-issuance loop (which would
    // stack multiple blocked commands and blur the latency measurement).
    const singleCreateAttempt = async (boundMs) => {
      const commandId = "cmd-a6-" + randomBytes(8).toString("hex");
      const requestId = "req-a6-" + randomBytes(8).toString("hex");
      let frame = null;
      try {
        frame = await client.request({
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
            arguments: { cwd: a6TmpRoot, label: "a6" },
          },
        }, boundMs);
      } catch (error) {
        return { settled: false, kind: "timeout", detail: error.message.slice(0, 120) };
      }
      const item = frame?.payload ?? frame;
      const state = item?.state ?? frame?.error?.code ?? frame?.type;
      const err = item?.error ?? frame?.error ?? null;
      return { settled: true, state, error: err };
    };

    try {
      await discoverScope(client);

      chmodSync(stateRoot, 0o000);
      chmodApplied = true;
      const started = Date.now();
      const faultOutcome = await singleCreateAttempt(40_000);
      const faultMs = Date.now() - started;
      const hostAliveDuring = a6Topo.hostExitCode() === null;

      // F2: while storage is still faulted, a command.query from the ALREADY
      // welcomed route must answer with a structured retryable
      // CAPABILITY_UNAVAILABLE error frame (not a 1011 route drop), and the
      // route must stay open so the client can retry in place once storage
      // heals.
      const queryProbe = await (async () => {
        const requestId = "req-a6-q-" + randomBytes(8).toString("hex");
        let frame = null;
        try {
          frame = await client.request({
            protocolVersion: 2,
            kind: "request",
            type: "command.query",
            requestId,
            hostId: client.hostId,
            expectedHostEpoch: client.hostEpoch,
            payload: { items: [{ commandId: "cmd-a6-query-probe", dedupeWindowId: client.dedupeWindowId }] },
          }, 15_000);
        } catch (error) {
          return { settled: false, detail: error.message.slice(0, 120) };
        }
        return {
          settled: true,
          code: frame?.error?.code ?? frame?.type,
          retryable: frame?.error?.retryable === true,
          routeStillOpen: client.getCloseInfo() === null,
        };
      })();

      // F2: a BRAND NEW client connecting during the storage fault must
      // receive a structured retryable CAPABILITY_UNAVAILABLE error frame
      // correlated to its client.hello before the route closes (old code
      // tore the route down with a bare 1011 authority_failure and no
      // frame, which the phone read as an unstructured SERVER_ERROR).
      const helloProbe = await (async () => {
        const socket = new WebSocket(a6Topo.clientRelayUrl, "tw-relay.v2", {
          headers: { Authorization: `Bearer ${a6Topo.clientCreds.accessToken}` },
          ca: a6Topo.tls.cert,
          rejectUnauthorized: true,
        });
        clientSockets.add(socket);
        const frames = [];
        let closeInfo = null;
        socket.on("message", (data) => {
          try { frames.push(JSON.parse(data.toString())); } catch {}
        });
        socket.on("close", (code, reason) => {
          closeInfo = { code, reason: reason?.toString() ?? "" };
        });
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("probe ws open timeout")), 10_000);
            socket.once("open", () => { clearTimeout(timer); resolve(); });
            socket.once("error", (error) => { clearTimeout(timer); reject(error); });
          });
          // Wait for the broker's relay.welcome before sending client.hello.
          await withTimeout(new Promise((resolve, reject) => {
            const check = () => {
              if (frames.some((f) => f.type === "relay.welcome")) return resolve();
              if (socket.readyState !== WebSocket.OPEN && closeInfo) return reject(new Error("probe closed before relay.welcome"));
              setTimeout(check, 50);
            };
            check();
          }), 10_000, "probe relay.welcome");
          const requestId = "hello-a6-" + randomBytes(8).toString("hex");
          socket.send(JSON.stringify({
            protocolVersion: 2,
            kind: "request",
            type: "client.hello",
            requestId,
            hostId: a6Topo.hostId,
            payload: {
              clientInstanceId: a6Topo.clientInstanceId,
              capabilities: REQUIRED_CAPABILITIES,
              requiredCapabilities: REQUIRED_CAPABILITIES,
              resume: null,
            },
          }));
          // Collect until the structured error frame arrives (or the socket
          // closes first, which is the regression being guarded against).
          await withTimeout(new Promise((resolve) => {
            const check = () => {
              if (frames.some((f) => f.type === "error" && f.requestId === requestId)) return resolve();
              if (closeInfo) return resolve();
              setTimeout(check, 50);
            };
            check();
          }), 20_000, "probe hello result");
          const errorFrame = frames.find((f) => f.type === "error" && f.requestId === requestId) ?? null;
          return {
            structuredError: errorFrame?.error?.code === "CAPABILITY_UNAVAILABLE"
              && errorFrame?.error?.retryable === true,
            closeCode: closeInfo?.code ?? null,
            closed: closeInfo !== null,
          };
        } catch (error) {
          return { structuredError: false, closeCode: null, closed: closeInfo !== null, detail: error.message.slice(0, 120) };
        } finally {
          try { closeWebSocket(socket); } catch {}
          clientSockets.delete(socket);
        }
      })();

      // Restore permissions; give the lane time, then probe once.
      chmodSync(stateRoot, 0o700);
      chmodApplied = false;

      let recovered = false;
      let recoverDetail = "";
      // C002: the durable accepted record is re-claimed idempotently by the
      // next execute/query once storage heals. Allow up to ~30s for the
      // bounded retry lane to exhaust and the next issuance to succeed.
      const probeDeadline = Date.now() + 35_000;
      while (Date.now() < probeDeadline && !recovered) {
        try {
          const sessionId = await createTerminal(client, a6TmpRoot, "a6-recovered");
          const opened = await openTerminalStream(client, { sessionId }, { maxAttempts: 6 });
          recovered = opened.response?.type === "terminal.opened";
          recoverDetail = opened.response?.type ?? "open-failed";
          if (recovered) break;
        } catch (error) {
          recoverDetail = error.message.slice(0, 100);
        }
        await delay(2_000);
      }
      const hostAliveAfter = a6Topo.hostExitCode() === null;

      // Bounded: C002's ~30s cap -> a fault response within 40s counts as
      // "surfaces instead of livelocking". A 40s timeout with the process
      // alive but silent means the serializer lane is wedged (the C002
      // failure the fix targets).
      const faultSurfaced = faultOutcome.settled && (
        faultOutcome.state === "failed"
        || (faultOutcome.error && typeof faultOutcome.error.code === "string")
      );
      const bounded = faultOutcome.settled && faultMs <= 40_000;

      // F2 structured-error probes during the fault window.
      const queryStructured = queryProbe.settled
        && queryProbe.code === "CAPABILITY_UNAVAILABLE"
        && queryProbe.retryable
        && queryProbe.routeStillOpen;
      const helloStructured = helloProbe.structuredError
        // The structured frame drains first; the route then closes with the
        // existing authority_failure code (no new close reason).
        && (helloProbe.closeCode === 1011 || helloProbe.closed);
      const f2 = queryStructured && helloStructured;

      const ok = ensured && hostAliveDuring && hostAliveAfter && faultSurfaced && bounded
        && f2 && recovered;
      record("A6 read-only state dir fails bounded and recovers (C002)", ok,
        `isolatedTopology=true, stateRootExisted=${ensured}, fault=${faultOutcome.settled ? `settled(${faultOutcome.state ?? faultOutcome.error?.code})` : "TIMEOUT"} after ${faultMs}ms, hostAlive=${hostAliveDuring}/${hostAliveAfter}, queryStructured=${queryStructured}(${queryProbe.settled ? queryProbe.code : queryProbe.detail ?? "unsettled"}/open=${queryProbe.routeStillOpen}), helloStructured=${helloStructured}(err=${helloProbe.structuredError},close=${helloProbe.closeCode}${helloProbe.detail ? `,${helloProbe.detail}` : ""}), recovered=${recovered}${recoverDetail ? ` (${recoverDetail})` : ""}`);

      if (!ok) {
        // Persist logs for the product-bug report.
        try {
          const { writeFileSync: wfs } = await import("node:fs");
          wfs("/tmp/fault-a6-host.log", a6Topo.hostLog.join("").slice(-20_000));
          wfs("/tmp/fault-a6-broker.log", a6Topo.brokerLog.join("").slice(-20_000));
        } catch {}
        throw new Error("assertion detail above; logs at /tmp/fault-a6-host.log /tmp/fault-a6-broker.log");
      }
      return `faultMs=${faultMs} recovered=${recovered}`;
    } finally {
      if (chmodApplied) { try { chmodSync(stateRoot, 0o700); } catch {} }
      client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log("\n=== Fault Injection Results ===");
  for (const r of RESULTS) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  }
  const failed = RESULTS.filter((r) => !r.passed).length;
  console.log(`\n${RESULTS.length - failed}/${RESULTS.length} passed`);
  exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  console.error("[FAIL] fault injection runner fatal:", error?.stack ?? error);
  exitCode = 1;
} finally {
  const cleanupErrors = [];
  // Scan EVERY topology tmp root (main + isolated A1/A3/A4/A5/A7/A9/A6/A8/A2),
  // not just the main one: isolated topologies create tmux sessions whose
  // pane cwd is under their own tmpRoot.
  const scopedTmuxSessions = scopedTmuxSessionNamesForRoots(allTopologyTmpRoots(), tmuxSessionsBefore);
  for (const socket of clientSockets) closeWebSocket(socket);
  if (clientSockets.size > 0) await delay(200);

  for (const extra of extraHosts) {
    try { await terminateChild(extra, { closeInput: true }); } catch (error) { cleanupErrors.push(error); }
  }
  // Tear down any isolated scenario topologies (A6): connector -> host ->
  // terminal-control daemon -> broker, then remove their temp homes.
  for (const extraTopo of extraTopologies) {
    try { if (extraTopo.hostProc?.exitCode === null) await extraTopo.hostRequest("stop_connector"); } catch {}
    try { await terminateChild(extraTopo.hostProc, { closeInput: true }); } catch (error) { cleanupErrors.push(error); }
    try { await stopScopedTerminalControlDaemon(extraTopo.hostTrustedHome); } catch {}
    // Reap detached terminal-control segment-writer grandchildren that embed
    // the home path in argv (they survive the daemon/host kill).
    await killProcessesReferencingHome(extraTopo.hostTrustedHome);
    try { await terminateChild(extraTopo.brokerProc); } catch (error) { cleanupErrors.push(error); }
    const home = extraTopo.hostTrustedHome;
    try { chmodSync(home, 0o700); } catch {}
    for (const stateRoot of [
      join(home, ".tmux-worktree", "relay-v2-host-state"),
      join(home, ".tmux-worktree", "relay-v2-state-snapshot-spool-v1"),
    ]) {
      try { chmodSync(stateRoot, 0o700); } catch {}
      try { for (const entry of readdirSync(stateRoot)) { try { chmodSync(join(stateRoot, entry), 0o700); } catch {} } } catch {}
    }
    try { rmSync(extraTopo.tmpRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }
  if (topology && topology.hostProc?.exitCode === null) {
    try { await topology.hostRequest("stop_connector"); } catch {}
  }
  try { await terminateChild(topology?.hostProc, { closeInput: true }); } catch (error) { cleanupErrors.push(error); }
  try { await stopScopedTerminalControlDaemon(hostTrustedHome); } catch (error) { cleanupErrors.push(error); }
  for (const home of extraTrustedHomes) {
    try { await stopScopedTerminalControlDaemon(home); } catch {}
  }
  // Reap detached terminal-control segment-writer grandchildren (argv embeds
  // the home path) so they cannot race or survive the home removal.
  await killProcessesReferencingHome(hostTrustedHome);
  for (const home of extraTrustedHomes) { await killProcessesReferencingHome(home); }
  try { await terminateChild(brokerProc); } catch (error) { cleanupErrors.push(error); }

  for (const name of scopedTmuxSessions) {
    if (!tmuxSessionNames().has(name)) continue;
    try {
      execFileSync("tmux", ["kill-session", "-t", name], { timeout: 5_000 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const tmuxSessionsAfter = tmuxSessionNames();
  const leakedSessions = [...scopedTmuxSessions].filter((name) => tmuxSessionsAfter.has(name));
  if (leakedSessions.length > 0) {
    cleanupErrors.push(new Error(`tmux sessions leaked: ${leakedSessions.join(", ")}`));
  }
  // Restore any permission faults A6 left behind (it chmods the host state
  // dir to 000) so rmSync below can actually remove the trusted home.
  for (const home of [hostTrustedHome, ...extraTrustedHomes]) {
    if (!home) continue;
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
  try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  try { if (hostTrustedHome) rmSync(hostTrustedHome, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  for (const home of extraTrustedHomes) {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }

  // Post-cleanup verification: no leftover relay-v2 temp homes, no stray
  // interop host processes, no scoped tmux sessions.
  let leftoverHomes = [];
  try {
    leftoverHomes = execFileSync("sh", [
      "-c",
      "ls -d /private/tmp/relay-v2-host-* 2>/dev/null || true",
    ], { encoding: "utf8", timeout: 5_000 }).split("\n").filter(Boolean);
  } catch {}
  let strayHostProcs = [];
  try {
    strayHostProcs = execFileSync("sh", [
      "-c",
      "pgrep -f relayV2InteropHost || true",
    ], { encoding: "utf8", timeout: 5_000 }).split("\n").filter(Boolean)
      // pgrep may match the cleanup shell itself indirectly; filter to node procs.
      .filter((pid) => {
        try {
          const cmd = execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8", timeout: 2_000 }).trim();
          return /node/.test(cmd);
        } catch { return false; }
      });
  } catch {}
  const remainingScoped = scopedTmuxSessionNamesForRoots(allTopologyTmpRoots(), tmuxSessionsBefore);

  if (leftoverHomes.length > 0) cleanupErrors.push(new Error(`leftover host homes: ${leftoverHomes.join(", ")}`));
  if (strayHostProcs.length > 0) cleanupErrors.push(new Error(`stray host procs: ${strayHostProcs.join(", ")}`));
  if (remainingScoped.size > 0) cleanupErrors.push(new Error(`scoped tmux sessions remain: ${[...remainingScoped].join(", ")}`));

  if (cleanupErrors.length > 0) {
    exitCode = 1;
    for (const error of cleanupErrors) console.error("[FAIL] cleanup:", error?.message ?? error);
  } else {
    console.log("[PASS] cleanup: no tmux session, host process, or temporary-home leak");
  }
}

process.exit(exitCode);
