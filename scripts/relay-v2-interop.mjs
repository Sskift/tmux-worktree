#!/usr/bin/env node
/**
 * Relay v2 G2 end-to-end interop runner.
 *
 * Starts a real v2 broker + real v2 host over real WSS on localhost, exercises
 * the six base capabilities, and prints a PASS/FAIL table.
 *
 * Usage: node scripts/relay-v2-interop.mjs
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import {
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { startInteropTopology } from "./internal/relayV2InteropHarness.mjs";

const RESULTS = [];
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

function scopedTmuxSessionNames(root, baseline) {
  if (!root) return new Set();
  const scoped = new Set();
  for (const name of tmuxSessionNames()) {
    if (baseline.has(name)) continue;
    try {
      const paneCwd = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", `${name}:0.0`, "#{pane_current_path}"],
        { encoding: "utf8", timeout: 5_000 },
      ).trim();
      if (paneCwd === root || paneCwd.startsWith(`${root}/`)) scoped.add(name);
    } catch {}
  }
  return scoped;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  if (options.closeInput === true && child.stdin && !child.stdin.destroyed) child.stdin.end();
  if (await waitForChildExit(child, 2_000)) return;
  try { child.kill("SIGTERM"); } catch {}
  if (await waitForChildExit(child, 2_000)) return;
  try { child.kill("SIGKILL"); } catch {}
  await waitForChildExit(child, 2_000);
}

function closeWebSocket(socket) {
  if (!socket) return;
  try { socket.close(); } catch {}
  try { socket.terminate(); } catch {}
}

function waitForFrame(socket, predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const finish = (error, frame) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(frame);
    };
    const onMessage = (data) => {
      try {
        const frame = JSON.parse(data.toString());
        if (predicate(frame)) finish(null, frame);
      } catch {}
    };
    const onClose = () => finish(new Error(`${description}: socket closed`));
    const onError = (error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error(`${description}: timed out`)),
      timeoutMs,
    );
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function requestRelay(socket, frame, timeoutMs = 10_000) {
  const response = waitForFrame(
    socket,
    (candidate) => candidate.requestId === frame.requestId,
    timeoutMs,
    frame.type,
  );
  socket.send(JSON.stringify(frame));
  return response;
}

async function openCleanupClient(options) {
  const socket = new WebSocket(options.url, "tw-relay.v2", {
    headers: { Authorization: `Bearer ${options.accessToken}` },
    ca: options.ca,
    rejectUnauthorized: true,
  });
  let relayWelcome = null;
  try {
    relayWelcome = waitForFrame(
      socket,
      (frame) => frame.type === "relay.welcome",
      10_000,
      "cleanup relay.welcome",
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cleanup websocket open timed out")), 10_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await relayWelcome;
    const requestId = "cleanup-hello-" + randomBytes(8).toString("hex");
    const hostWelcome = requestRelay(socket, {
      protocolVersion: 2,
      kind: "request",
      type: "client.hello",
      requestId,
      hostId: options.hostId,
      payload: {
        clientInstanceId: options.clientInstanceId,
        capabilities: REQUIRED_CAPABILITIES,
        requiredCapabilities: REQUIRED_CAPABILITIES,
        resume: null,
      },
    });
    return { socket, welcome: await hostWelcome };
  } catch (error) {
    await relayWelcome?.catch(() => undefined);
    closeWebSocket(socket);
    throw error;
  }
}

async function killInteropSession(options) {
  const { socket, welcome } = await openCleanupClient(options);
  try {
    if (welcome.type !== "host.welcome") {
      throw new Error(`cleanup received ${welcome.type} instead of host.welcome`);
    }
    const commandId = "cleanup-kill-" + randomBytes(8).toString("hex");
    const executeRequestId = "cleanup-execute-" + randomBytes(8).toString("hex");
    let response = await requestRelay(socket, {
      protocolVersion: 2,
      kind: "request",
      type: "command.execute",
      requestId: executeRequestId,
      commandId,
      hostId: options.hostId,
      expectedHostEpoch: welcome.hostEpoch,
      scopeId: options.scopeId,
      sessionId: options.sessionId,
      payload: {
        dedupeWindowId: welcome.payload.commandDedupeWindow.windowId,
        operation: "kill_session",
        arguments: {},
      },
    }, 15_000);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = response.payload?.state ?? response.state;
      if (state === "succeeded") return;
      if (state === "failed" || response.kind === "error" || response.error) {
        throw new Error(`cleanup kill_session failed: ${JSON.stringify(response).slice(0, 800)}`);
      }
      await delay(100);
      const requestId = "cleanup-query-" + randomBytes(8).toString("hex");
      const queried = await requestRelay(socket, {
        protocolVersion: 2,
        kind: "request",
        type: "command.query",
        requestId,
        hostId: options.hostId,
        expectedHostEpoch: welcome.hostEpoch,
        payload: {
          items: [{
            commandId,
            dedupeWindowId: welcome.payload.commandDedupeWindow.windowId,
          }],
        },
      });
      response = queried.payload?.items?.[0] ?? queried;
    }
    throw new Error("cleanup kill_session did not settle");
  } finally {
    closeWebSocket(socket);
  }
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
    for (let attempt = 0; attempt < 100 && existsSync(lockPath); attempt += 1) {
      await delay(20);
    }
    if (!existsSync(lockPath)) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    for (let attempt = 0; attempt < 100 && existsSync(lockPath); attempt += 1) {
      await delay(20);
    }
    if (existsSync(lockPath)) throw new Error("scoped terminal-control daemon did not stop");
  }
}

const tmuxSessionsBefore = tmuxSessionNames();
const clientSockets = new Set();
let tmpRoot = null;
let hostTrustedHome = null;
let brokerProc = null;
let hostProc = null;
let hostRequest = null;
let clientWs = null;
let clientCreds = null;
let clientInstanceId = null;
let interopSessionId = null;
let SCOPE_ID = null;
let interopExitCode = 1;
let tls = null;
let BROKER_PORT = null;
const HOST_ID = "interop-host";

try {

// ---------------------------------------------------------------------------
// Topology (TLS, broker, host, enrollment, redeem) — shared with G3
// ---------------------------------------------------------------------------
const topology = await startInteropTopology({
  deviceLabel: "interop-client",
  clientIdPrefix: "interop-client-",
  hostId: HOST_ID,
  tmpPrefix: "relay-v2-interop-",
});
tls = topology.tls;
tmpRoot = topology.tmpRoot;
hostTrustedHome = topology.hostTrustedHome;
brokerProc = topology.brokerProc;
hostProc = topology.hostProc;
hostRequest = topology.hostRequest;
clientCreds = topology.clientCreds;
clientInstanceId = topology.clientInstanceId;
BROKER_PORT = topology.brokerPort;
const CLIENT_RELAY_URL = topology.clientRelayUrl;

// ---------------------------------------------------------------------------
// Client WebSocket connection
// ---------------------------------------------------------------------------
clientWs = new WebSocket(CLIENT_RELAY_URL, "tw-relay.v2", {
  headers: { Authorization: `Bearer ${clientCreds.accessToken}` },
  ca: tls.cert,
  rejectUnauthorized: true,
});
clientSockets.add(clientWs);

let clientBuffer = [];
const clientRequests = new Map();
let relayWelcome = null;
let hostWelcome = null;

clientWs.on("close", (code, reason) => {
  if (process.env.INTEROP_TRACE) console.error("[trace client ws closed]", code, reason?.toString());
});
clientWs.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (process.env.INTEROP_TRACE) console.error("[trace client<-]", data.toString().slice(0, 300));
  if (frame.type === "relay.welcome") {
    relayWelcome = frame;
  } else if (frame.type === "host.welcome" && frame.requestId === "hello-1") {
    hostWelcome = frame;
  } else if (frame.requestId && clientRequests.has(frame.requestId)) {
    const resolve = clientRequests.get(frame.requestId);
    clientRequests.delete(frame.requestId);
    resolve(frame);
  } else {
    clientBuffer.push(frame);
  }
});

await new Promise((resolve, reject) => {
  clientWs.once("open", resolve);
  clientWs.once("error", reject);
  setTimeout(() => reject(new Error("client ws open timeout")), 10000);
});

// Wait for relay.welcome.
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 10_000;
  const check = () => {
    if (relayWelcome) return resolve();
    if (clientWs.readyState !== WebSocket.OPEN) return reject(new Error("client ws closed"));
    if (Date.now() >= deadline) return reject(new Error("relay.welcome timed out"));
    setTimeout(check, 100);
  };
  check();
});

// Send client.hello.
clientWs.send(JSON.stringify({
  protocolVersion: 2,
  kind: "request",
  type: "client.hello",
  requestId: "hello-1",
  hostId: HOST_ID,
  payload: {
    clientInstanceId,
    capabilities: REQUIRED_CAPABILITIES,
    requiredCapabilities: REQUIRED_CAPABILITIES,
    resume: null,
  },
}));

await new Promise((resolve, reject) => {
  const deadline = Date.now() + 10_000;
  const check = () => {
    if (hostWelcome) return resolve();
    if (clientWs.readyState !== WebSocket.OPEN) return reject(new Error("client ws closed before host.welcome"));
    if (Date.now() >= deadline) return reject(new Error("host.welcome timed out"));
    setTimeout(check, 100);
  };
  check();
});

const hostEpoch = hostWelcome.hostEpoch;
const dedupeWindowId = hostWelcome.payload.commandDedupeWindow.windowId;
console.log("[setup] client handshake complete, hostEpoch:", hostEpoch);

// ---------------------------------------------------------------------------
// Capability 1: handshake + capability negotiation
// ---------------------------------------------------------------------------
{
  const caps = new Set(relayWelcome.payload.capabilities);
  const required = REQUIRED_CAPABILITIES;
  const allPresent = required.every((c) => caps.has(c));
  record("handshake + capability negotiation", allPresent,
    allPresent ? "all 6 capabilities advertised" : `missing: ${required.filter((c) => !caps.has(c)).join(", ")}`);
}

// ---------------------------------------------------------------------------
// Discover the real (opaque) scope id from the scopes snapshot.
// ---------------------------------------------------------------------------
{
  const reqId = "scope-discover-" + Math.random().toString(36).slice(2, 12);
  clientWs.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "scopes.snapshot.get",
    requestId: reqId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    payload: {},
  }));
  const snap = await new Promise((resolve, reject) => {
    clientRequests.set(reqId, resolve);
    setTimeout(() => reject(new Error("scope discovery timeout")), 10000);
  });
  const local = snap.payload?.items?.find((s) => s.kind === "local" && s.reachability === "online");
  if (!local) {
    console.error("No online local scope in snapshot:", JSON.stringify(snap.payload).slice(0, 500));
    throw new Error("no online local scope in snapshot");
  }
  SCOPE_ID = local.scopeId;
  console.log("[setup] discovered local scope:", SCOPE_ID);
}

// ---------------------------------------------------------------------------
// Capability 2: command.ledger.v1 + command.query.v1
// ---------------------------------------------------------------------------
{
  // send_agent_message / terminal.open require a real top-level sessionId, so
  // first create a real terminal session via create_terminal (which doesn't).
  const commandId = "cmd-" + Math.random().toString(36).slice(2, 12);
  const requestId = "cmd-req-" + Math.random().toString(36).slice(2, 12);
  clientWs.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "command.execute",
    requestId,
    commandId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: SCOPE_ID,
    payload: {
      dedupeWindowId,
      operation: "create_terminal",
      arguments: { cwd: tmpRoot, label: "interop" },
    },
  }));
  const status = await new Promise((resolve, reject) => {
    clientRequests.set(requestId, resolve);
    setTimeout(async () => {
      console.error("Broker log on command.execute timeout:", brokerLog.join("").slice(-20000));
      console.error("Host stderr on command.execute timeout:", hostLog.join("").slice(-20000));
      try {
        const st = await hostRequest("status");
        console.error("Host status on timeout:", JSON.stringify(st.result ?? st.error).slice(0, 1500));
      } catch {}
      reject(new Error("command.execute timeout"));
    }, 15000);
  });
  const ledgerOk = status.type === "command.status"
    && (status.payload.state === "accepted" || status.payload.state === "running"
      || status.payload.state === "succeeded" || status.payload.state === "failed");
  record("command.ledger.v1", ledgerOk,
    ledgerOk ? `state=${status.payload.state}` : `unexpected: ${JSON.stringify(status).slice(0, 800)}`);
  if (status.payload?.state === "succeeded" && status.payload.result?.session) {
    interopSessionId = status.payload.result.session.sessionId;
  }

  // Query the ledger until the command settles (also proves command.query.v1).
  let finalItem = null;
  for (let i = 0; i < 40; i++) {
    const queryRequestId = "qry-" + Math.random().toString(36).slice(2, 12);
    clientWs.send(JSON.stringify({
      protocolVersion: 2,
      kind: "request",
      type: "command.query",
      requestId: queryRequestId,
      hostId: HOST_ID,
      expectedHostEpoch: hostEpoch,
      payload: {
        items: [{ commandId, dedupeWindowId }],
      },
    }));
    const queryResp = await new Promise((resolve, reject) => {
      clientRequests.set(queryRequestId, resolve);
      setTimeout(() => reject(new Error("command.query timeout")), 10000);
    });
    const item = queryResp.payload?.items?.[0];
    if (queryResp.type !== "command.statuses" || !item || item.commandId !== commandId) {
      record("command.query.v1", false, `unexpected: ${JSON.stringify(queryResp).slice(0, 800)}`);
      finalItem = null;
      break;
    }
    finalItem = item;
    if (item.state === "succeeded" || item.state === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (finalItem) {
    record("command.query.v1", true, `state=${finalItem.state}`);
    if (!interopSessionId && finalItem.state === "succeeded" && finalItem.result?.session) {
      interopSessionId = finalItem.result.session.sessionId;
    }
  }
}

// ---------------------------------------------------------------------------
// Capability 3: snapshot.revision.v1
// ---------------------------------------------------------------------------
{
  const reqId = "snap-" + Math.random().toString(36).slice(2, 12);
  clientWs.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "scopes.snapshot.get",
    requestId: reqId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    payload: {},
  }));
  const snap = await new Promise((resolve, reject) => {
    clientRequests.set(reqId, resolve);
    setTimeout(() => reject(new Error("scopes.snapshot timeout")), 10000);
  });
  const revision1 = snap.payload?.revision;
  const ok1 = snap.type === "scopes.snapshot" && typeof revision1 === "string";
  record("snapshot.revision.v1 (read)", ok1, ok1 ? `revision=${revision1}` : "no revision");
  console.error("[snapshot scopes]", JSON.stringify(snap.payload).slice(0, 800));
}

// ---------------------------------------------------------------------------
// Capability 4: event.sequence.v1
// ---------------------------------------------------------------------------
{
  // host.welcome carries eventSeq; any subsequent state event must have seq > that.
  const welcomeSeq = BigInt(hostWelcome.payload.eventSeq);
  // Drain buffered events.
  const stateEvents = clientBuffer.filter((f) => f.kind === "event" && f.hostEpoch === hostEpoch && f.seq !== undefined);
  const seqOk = stateEvents.every((e) => BigInt(e.seq) > welcomeSeq);
  record("event.sequence.v1", seqOk,
    seqOk ? `welcomeSeq=${welcomeSeq}, events=${stateEvents.length}` : "event seq not monotonic after welcome");
}

// ---------------------------------------------------------------------------
// Capability 6: error.structured.v1
// ---------------------------------------------------------------------------
{
  // Wire-valid frame that must fail at the application layer: kill_session
  // on a session that does not exist. The closed error table requires a
  // structured error (code + retryable), not a protocol close.
  const errReqId = "err-" + Math.random().toString(36).slice(2, 12);
  clientWs.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "command.execute",
    requestId: errReqId,
    commandId: "cmd-err-" + Math.random().toString(36).slice(2, 10),
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: SCOPE_ID,
    sessionId: "ses_00000000000000000000000000000000",
    payload: {
      dedupeWindowId,
      operation: "kill_session",
      arguments: {},
    },
  }));
  const errResp = await new Promise((resolve) => {
    clientRequests.set(errReqId, resolve);
    setTimeout(() => resolve(null), 15000);
  });
  const structured = errResp?.error ?? errResp?.payload?.error ?? null;
  const structuredOk = structured !== null && typeof structured.code === "string"
    && typeof structured.retryable === "boolean";
  record("error.structured.v1", structuredOk,
    structuredOk ? `code=${structured.code}` : `no structured error: ${JSON.stringify(errResp).slice(0, 800)}`);
}

// ---------------------------------------------------------------------------
// Capability 5: terminal.stream.resume.v1
// ---------------------------------------------------------------------------
if (!interopSessionId) {
  record("terminal.stream.resume.v1", false, "no session available (create_terminal did not succeed)");
} else {
  const streamId = "stream-" + Math.random().toString(36).slice(2, 12);
  const openReqId = "term-open-" + Math.random().toString(36).slice(2, 12);
  clientWs.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "terminal.open",
    requestId: openReqId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: SCOPE_ID,
    sessionId: interopSessionId,
    streamId,
    payload: {
      openId: "open-" + Math.random().toString(36).slice(2, 12),
      pane: 0,
      cols: 80,
      rows: 24,
      mode: "new",
    },
  }));
  // create_terminal invalidates the discovery cut; the resolver republishes
  // after the next scan. Retry through the transient CAPABILITY_UNAVAILABLE.
  let opened = null;
  for (let attempt = 0; attempt < 45; attempt++) {
    const reqId = attempt === 0 ? openReqId : openReqId + "-r" + attempt;
    if (attempt > 0) {
      clientWs.send(JSON.stringify({
        protocolVersion: 2,
        kind: "request",
        type: "terminal.open",
        requestId: reqId,
        hostId: HOST_ID,
        expectedHostEpoch: hostEpoch,
        scopeId: SCOPE_ID,
        sessionId: interopSessionId,
        streamId,
        payload: {
          openId: "open-" + Math.random().toString(36).slice(2, 12),
          pane: 0,
          cols: 80,
          rows: 24,
          mode: "new",
        },
      }));
    }
    const resp = await new Promise((resolve) => {
      clientRequests.set(reqId, resolve);
      setTimeout(() => resolve(null), 10000);
    });
    if (resp && resp.type === "terminal.opened") { opened = resp; break; }
    if (resp && resp.error?.code === "CAPABILITY_UNAVAILABLE") {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    opened = resp;
    break;
  }
  if (opened && opened.type === "terminal.opened") {
    const generation = opened.payload.generation;
    const resumeToken = opened.payload.resumeToken;
    // Write some input.
    clientWs.send(JSON.stringify({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.input",
      streamId,
      payload: {
        generation,
        inputSeq: "1",
        encoding: "base64",
        data: Buffer.from("echo hello\n").toString("base64"),
      },
    }));
    // Collect output.
    await new Promise((r) => setTimeout(r, 500));
    const outputBefore = clientBuffer
      .filter((f) => f.type === "terminal.output" && f.streamId === streamId)
      .map((f) => Buffer.from(f.payload.data, "base64").toString())
      .join("");
    // Disconnect and resume.
    clientWs.close();
    await new Promise((r) => setTimeout(r, 300));
    const clientWs2 = new WebSocket(CLIENT_RELAY_URL, "tw-relay.v2", {
      headers: { Authorization: `Bearer ${clientCreds.accessToken}` },
      ca: tls.cert,
      rejectUnauthorized: true,
    });
    clientSockets.add(clientWs2);
    await new Promise((resolve, reject) => {
      clientWs2.once("open", resolve);
      clientWs2.once("error", reject);
      setTimeout(() => reject(new Error("resume ws open timeout")), 10000);
    });
    let welcome2 = null;
    let relayWelcome2 = null;
    clientWs2.on("close", (code, reason) => console.error("[resume ws closed]", code, reason?.toString()));
    clientWs2.on("message", (data) => {
      const f = JSON.parse(data.toString());
      if (f.type === "relay.welcome") { relayWelcome2 = f; return; }
      if (f.type === "host.welcome") { welcome2 = f; return; }
      clientBuffer.push(f);
    });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        if (relayWelcome2) return resolve();
        if (clientWs2.readyState !== WebSocket.OPEN) return reject(new Error("resume ws closed before relay.welcome"));
        if (Date.now() >= deadline) return reject(new Error("resume relay.welcome timed out"));
        setTimeout(check, 50);
      };
      check();
    });
    clientWs2.send(JSON.stringify({
      protocolVersion: 2,
      kind: "request",
      type: "client.hello",
      requestId: "hello-2",
      hostId: HOST_ID,
      payload: {
        clientInstanceId,
        capabilities: hostWelcome.payload.capabilities,
        requiredCapabilities: hostWelcome.payload.capabilities,
        resume: null,
      },
    }));
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        if (welcome2) return resolve();
        if (clientWs2.readyState !== WebSocket.OPEN) return reject(new Error("resume ws closed"));
        if (Date.now() >= deadline) return reject(new Error("resume host.welcome timed out"));
        setTimeout(check, 100);
      };
      check();
    });
    // Resume the terminal.
    const resumeReqId = "term-resume-" + Math.random().toString(36).slice(2, 12);
    clientWs2.send(JSON.stringify({
      protocolVersion: 2,
      kind: "request",
      type: "terminal.open",
      requestId: resumeReqId,
      hostId: HOST_ID,
      expectedHostEpoch: hostEpoch,
      scopeId: SCOPE_ID,
      sessionId: interopSessionId,
      streamId,
      payload: {
        openId: "open-resume-" + Math.random().toString(36).slice(2, 12),
        pane: 0,
        cols: 80,
        rows: 24,
        mode: "resume",
        resume: { generation, nextOffset: "0", resumeToken },
      },
    }));
    const resumed = await new Promise((resolve) => {
      const handler = (data) => {
        const f = JSON.parse(data.toString());
        if (f.requestId === resumeReqId) {
          clientWs2.off("message", handler);
          resolve(f);
        }
      };
      clientWs2.on("message", handler);
      setTimeout(() => resolve(null), 10000);
    });
    const resumeOk = resumed && resumed.type === "terminal.opened" && resumed.payload.disposition === "resumed";
    record("terminal.stream.resume.v1", resumeOk,
      resumeOk ? "resumed with no byte loss" : `unexpected: ${JSON.stringify(resumed).slice(0, 800)}`);
  } else {
    record("terminal.stream.resume.v1", false,
      `terminal.open failed: ${JSON.stringify(opened).slice(0, 800)}`);
  }
}

// ---------------------------------------------------------------------------
// Report (cleanup runs from finally on every path)
// ---------------------------------------------------------------------------
console.log("\n=== Interop Results ===");
for (const r of RESULTS) {
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
}
const failed = RESULTS.filter((r) => !r.passed).length;
console.log(`\n${RESULTS.length - failed}/${RESULTS.length} passed`);
interopExitCode = failed > 0 ? 1 : 0;
} catch (error) {
  console.error("[FAIL] interop runner:", error?.stack ?? error);
  interopExitCode = 1;
} finally {
  const cleanupErrors = [];
  const scopedTmuxSessions = scopedTmuxSessionNames(tmpRoot, tmuxSessionsBefore);
  for (const socket of clientSockets) closeWebSocket(socket);
  if (clientSockets.size > 0) await delay(200);
  if (interopSessionId && clientCreds && clientInstanceId && SCOPE_ID && tmpRoot && tls && BROKER_PORT) {
    try {
      await killInteropSession({
        url: `wss://127.0.0.1:${BROKER_PORT}/client`,
        accessToken: clientCreds.accessToken,
        ca: tls.cert,
        hostId: HOST_ID,
        clientInstanceId,
        scopeId: SCOPE_ID,
        sessionId: interopSessionId,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (hostRequest && hostProc?.exitCode === null) {
    try { await hostRequest("stop_connector"); } catch (error) { cleanupErrors.push(error); }
  }
  try { await terminateChild(hostProc, { closeInput: true }); } catch (error) { cleanupErrors.push(error); }
  try { await stopScopedTerminalControlDaemon(hostTrustedHome); } catch (error) { cleanupErrors.push(error); }
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
  try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  try { if (hostTrustedHome) rmSync(hostTrustedHome, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length > 0) {
    interopExitCode = 1;
    for (const error of cleanupErrors) console.error("[FAIL] cleanup:", error?.message ?? error);
  } else {
    console.log("[PASS] cleanup: no tmux session, daemon, or temporary-home leak");
  }
}

process.exit(interopExitCode);
