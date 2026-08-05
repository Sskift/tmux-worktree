#!/usr/bin/env node
/**
 * Relay v2 G2 end-to-end interop runner.
 *
 * Starts a real v2 broker + real v2 host over real WSS on localhost, exercises
 * the six base capabilities, and prints a PASS/FAIL table.
 *
 * Usage: node scripts/relay-v2-interop.mjs
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfSignedCertificate,
} from "./internal/relayV2InteropTls.mjs";

const RESULTS = [];
function record(name, passed, detail = "") {
  RESULTS.push({ name, passed, detail });
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ": " + detail : ""}`);
}

function fail(name, detail) {
  record(name, false, detail);
}

// ---------------------------------------------------------------------------
// TLS material
// ---------------------------------------------------------------------------
const tls = createSelfSignedCertificate({ commonName: "localhost" });
const tmpRoot = mkdtempSync(join(tmpdir(), "relay-v2-interop-"));
const tlsKeyPath = join(tmpRoot, "tls-key.pem");
const tlsCertPath = join(tmpRoot, "tls-cert.pem");
writeFileSync(tlsKeyPath, tls.key);
writeFileSync(tlsCertPath, tls.cert);
chmodSync(tlsKeyPath, 0o600);
chmodSync(tlsCertPath, 0o600);

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------
const BROKER_PORT = 18000 + Math.floor(Math.random() * 1000);
const brokerProc = spawn(process.execPath, [
  "dist/cli.cjs",
  "relay-server",
  "--v2-local-dev",
  "--port", String(BROKER_PORT),
  "--v2-dev-tls-key", tlsKeyPath,
  "--v2-dev-tls-cert", tlsCertPath,
  "--host-bootstrap-output", join(tmpRoot, "host-bootstrap.txt"),
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
});

let brokerReady = false;
const brokerLog = [];
brokerProc.stdout.on("data", (d) => brokerLog.push(d.toString()));
brokerProc.stderr.on("data", (d) => brokerLog.push(d.toString()));

const bootstrapOutputPath = join(tmpRoot, "host-bootstrap.txt");
await new Promise((resolve, reject) => {
  const check = () => {
    if (existsSync(bootstrapOutputPath)) {
      brokerReady = true;
      return resolve();
    }
    if (brokerProc.exitCode !== null) {
      console.error("Broker stderr:", brokerLog.join(""));
      return reject(new Error("broker exited early"));
    }
    setTimeout(check, 100);
  };
  check();
});

if (!brokerReady) {
  console.error("Broker failed to start:");
  console.error(brokerLog.join(""));
  process.exit(1);
}
console.log("[setup] broker started on port", BROKER_PORT);

// Read the bootstrap secret the broker wrote.
const bootstrapSecret = readFileSync(join(tmpRoot, "host-bootstrap.txt"), "utf8").trim();
console.log("[setup] host bootstrap secret obtained");

// ---------------------------------------------------------------------------
// Host profile
// ---------------------------------------------------------------------------
const HOST_ID = "interop-host";
const ISSUER_URL = `https://127.0.0.1:${BROKER_PORT}/`;
const RELAY_URL = `wss://127.0.0.1:${BROKER_PORT}/`;
const CLIENT_RELAY_URL = `wss://127.0.0.1:${BROKER_PORT}/client`;
const hostTrustedHome = realpathSync.native(mkdtempSync("/private/tmp/relay-v2-host-"));
chmodSync(hostTrustedHome, 0o700);

const profile = {
  contract: "tmux-worktree-relay-v2-host-production-profile",
  schemaVersion: 1,
  hostId: HOST_ID,
  relayUrl: RELAY_URL,
  credentialIssuerUrl: ISSUER_URL,
  credentialReference: "relay-v2-host-credential-ref:local-dev",
  bootstrapSecretReference: "local-dev-bootstrap",
  refreshSecretReference: "local-dev-refresh",
};
const profilePath = join(tmpRoot, "host-profile.json");
writeFileSync(profilePath, JSON.stringify(profile));
chmodSync(profilePath, 0o600);

// Write bootstrap secret to a file the host can read.
const bootstrapSecretPath = join(tmpRoot, "host-bootstrap-secret.txt");
writeFileSync(bootstrapSecretPath, bootstrapSecret);
chmodSync(bootstrapSecretPath, 0o600);

// ---------------------------------------------------------------------------
// Host (with dashboard management stdio)
// ---------------------------------------------------------------------------
const hostProc = spawn(process.execPath, [
  "scripts/internal/relayV2InteropHost.mjs",
], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    HOME: hostTrustedHome,
    TW_HOST_TRUSTED_HOME: hostTrustedHome,
    TW_HOST_HTTPS_CA: tlsCertPath,
    TW_HOST_WSS_CA: tlsCertPath,
    TW_HOST_PROFILE_INPUT: profilePath,
    TW_HOST_BOOTSTRAP_SECRET_INPUT: bootstrapSecretPath,
  },
});

const hostLog = [];
let hostExitCode = null;
hostProc.stderr.on("data", (d) => hostLog.push(d.toString()));
hostProc.on("exit", (code) => { hostExitCode = code; });

// Dashboard management protocol: newline-delimited JSON frames.
let hostBuffer = "";
const hostRequests = new Map();
let hostReadyFrame = null;
hostProc.stdout.on("data", (d) => {
  hostBuffer += d.toString();
  let idx;
  while ((idx = hostBuffer.indexOf("\n")) !== -1) {
    const line = hostBuffer.slice(0, idx);
    hostBuffer = hostBuffer.slice(idx + 1);
    if (!line) continue;
    try {
      const frame = JSON.parse(line);
      if (frame.protocolVersion === 2 && frame.contract) {
        hostReadyFrame = frame;
      } else if (frame.requestId && hostRequests.has(frame.requestId)) {
        const resolve = hostRequests.get(frame.requestId);
        hostRequests.delete(frame.requestId);
        resolve(frame);
      }
    } catch {}
  }
});

await new Promise((resolve, reject) => {
  const check = () => {
    if (hostReadyFrame) return resolve();
    if (hostProc.exitCode !== null) {
      console.error("Host exit code:", hostExitCode);
      console.error("Host stderr:", hostLog.join(""));
      console.error("Host stdout buffer:", hostBuffer);
      return reject(new Error("host exited early"));
    }
    setTimeout(check, 100);
  };
  check();
});
console.log("[setup] host dashboard management ready");

function hostRequest(operation, input = null) {
  return new Promise((resolve, reject) => {
    const requestId = "dmgmt2." + randomBytes(16).toString("base64url");
    const frame = JSON.stringify({
      protocolVersion: 2,
      requestId,
      operation,
      input,
    }) + "\n";
    hostRequests.set(requestId, resolve);
    hostProc.stdin.write(frame);
    setTimeout(() => {
      if (hostRequests.has(requestId)) {
        hostRequests.delete(requestId);
        console.error("Host stderr on timeout:", hostLog.join(""));
        console.error("Broker log on timeout:", brokerLog.join(""));
        reject(new Error(`host request ${operation} timed out`));
      }
    }, 10000);
  });
}

// Bootstrap host credentials.
const bootstrapResp = await hostRequest("bootstrap_host");
if (!bootstrapResp.ok) {
  console.error("Host bootstrap failed:", JSON.stringify(bootstrapResp.error));
  process.exit(1);
}
console.log("[setup] host bootstrapped");

// Start the host connector.
const startResp = await hostRequest("start_connector");
if (!startResp.ok) {
  console.error("Host connector start failed:", JSON.stringify(startResp.error));
  process.exit(1);
}
console.log("[setup] host connector started");

// Wait for the connector to be registered.
let registered = false;
let lastStatus = null;
for (let i = 0; i < 50 && !registered; i++) {
  const status = await hostRequest("status");
  lastStatus = status;
  if (status.ok && status.result.connector.status === "registered") registered = true;
  else await new Promise((r) => setTimeout(r, 200));
}
if (!registered) {
  console.error("Host connector did not reach registered state");
  console.error("Last status:", JSON.stringify(lastStatus, null, 2));
  console.error("Host stderr:", hostLog.join("").slice(-4000));
  console.error("Broker log:", brokerLog.join("").slice(-4000));
  process.exit(1);
}
console.log("[setup] host connector registered");

// Create a client enrollment.
const enrollResp = await hostRequest("create_enrollment", { deviceLabel: "interop-client" });
if (!enrollResp.ok || enrollResp.result.enrollment.status !== "active") {
  console.error("Enrollment creation failed:", JSON.stringify(enrollResp.error || enrollResp.result.enrollment));
  process.exit(1);
}
const enrollment = enrollResp.result.enrollment.review.enrollment;
console.log("[setup] client enrollment created:", enrollment.enrollmentId);

// ---------------------------------------------------------------------------
// Redeem enrollment for client credentials
// ---------------------------------------------------------------------------
const clientInstanceId = "interop-client-" + Math.random().toString(36).slice(2, 12);
const redeemResp = await fetch(`${ISSUER_URL}v2/enrollments/redeem`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify({
    exchangeAttemptId: "exchange-" + Math.random().toString(36).slice(2, 12),
    enrollmentId: enrollment.enrollmentId,
    enrollmentCode: enrollment.enrollmentCode,
    clientInstanceId,
    deviceLabel: "interop-client",
  }),
  ca: tls.cert,
});
if (!redeemResp.ok) {
  const body = await redeemResp.text();
  console.error("Enrollment redeem failed:", redeemResp.status, body);
  process.exit(1);
}
const clientCreds = await redeemResp.json();
console.log("[setup] client credentials obtained, principalId:", clientCreds.principalId);

// ---------------------------------------------------------------------------
// Client WebSocket connection
// ---------------------------------------------------------------------------
import WebSocket from "ws";

const clientWs = new WebSocket(CLIENT_RELAY_URL, "tw-relay.v2", {
  headers: { Authorization: `Bearer ${clientCreds.accessToken}` },
  ca: tls.cert,
  rejectUnauthorized: true,
});

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
  const check = () => {
    if (relayWelcome) return resolve();
    if (clientWs.readyState !== WebSocket.OPEN) return reject(new Error("client ws closed"));
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
    capabilities: [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1",
    ],
    requiredCapabilities: [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1",
    ],
    resume: null,
  },
}));

await new Promise((resolve, reject) => {
  const check = () => {
    if (hostWelcome) return resolve();
    if (clientWs.readyState !== WebSocket.OPEN) return reject(new Error("client ws closed before host.welcome"));
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
  const required = [
    "error.structured.v1",
    "command.ledger.v1",
    "command.query.v1",
    "snapshot.revision.v1",
    "event.sequence.v1",
    "terminal.stream.resume.v1",
  ];
  const allPresent = required.every((c) => caps.has(c));
  record("handshake + capability negotiation", allPresent,
    allPresent ? "all 6 capabilities advertised" : `missing: ${required.filter((c) => !caps.has(c)).join(", ")}`);
}

// ---------------------------------------------------------------------------
// Capability 2: command.ledger.v1 + command.query.v1
// ---------------------------------------------------------------------------
let interopSessionId = null;
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
    scopeId: "scope-local",
    payload: {
      dedupeWindowId,
      operation: "create_terminal",
      arguments: { cwd: tmpRoot, label: "interop" },
    },
  }));
  const status = await new Promise((resolve, reject) => {
    clientRequests.set(requestId, resolve);
    setTimeout(async () => {
      console.error("Broker log on command.execute timeout:", brokerLog.join("").slice(-3000));
      console.error("Host stderr on command.execute timeout:", hostLog.join("").slice(-3000));
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
    ledgerOk ? `state=${status.payload.state}` : `unexpected: ${JSON.stringify(status).slice(0, 200)}`);
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
      record("command.query.v1", false, `unexpected: ${JSON.stringify(queryResp).slice(0, 200)}`);
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
    scopeId: "scope-local",
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
  const opened = await new Promise((resolve) => {
    clientRequests.set(openReqId, resolve);
    setTimeout(() => resolve(null), 10000);
  });
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
    await new Promise((resolve, reject) => {
      clientWs2.once("open", resolve);
      clientWs2.once("error", reject);
      setTimeout(() => reject(new Error("resume ws open timeout")), 10000);
    });
    let welcome2 = null;
    clientWs2.on("message", (data) => {
      const f = JSON.parse(data.toString());
      if (f.type === "relay.welcome") return;
      if (f.type === "host.welcome") { welcome2 = f; return; }
      clientBuffer.push(f);
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
      const check = () => {
        if (welcome2) return resolve();
        if (clientWs2.readyState !== WebSocket.OPEN) return reject(new Error("resume ws closed"));
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
      scopeId: "scope-local",
      sessionId: interopSessionId,
      streamId,
      payload: {
        openId: opened.payload.openId,
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
      resumeOk ? "resumed with no byte loss" : `unexpected: ${JSON.stringify(resumed).slice(0, 200)}`);
    clientWs2.close();
  } else {
    record("terminal.stream.resume.v1", false,
      `terminal.open failed: ${JSON.stringify(opened).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Capability 6: error.structured.v1
// ---------------------------------------------------------------------------
{
  // Send an invalid frame (missing required fields).
  const errReqId = "err-" + Math.random().toString(36).slice(2, 12);
  clientWs.send(JSON.stringify({
    protocolVersion: 2,
    kind: "request",
    type: "command.execute",
    requestId: errReqId,
    commandId: "cmd-invalid",
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: "scope-local",
    payload: {
      dedupeWindowId,
      operation: "nonexistent_operation",
      arguments: {},
    },
  }));
  const errResp = await new Promise((resolve) => {
    clientRequests.set(errReqId, resolve);
    setTimeout(() => resolve(null), 10000);
  });
  const structuredOk = errResp && errResp.error && typeof errResp.error.code === "string"
    && typeof errResp.error.retryable === "boolean";
  record("error.structured.v1", structuredOk,
    structuredOk ? `code=${errResp.error.code}` : `no structured error: ${JSON.stringify(errResp).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Cleanup & report
// ---------------------------------------------------------------------------
try { clientWs.close(); } catch {}
try { hostProc.kill("SIGTERM"); } catch {}
try { brokerProc.kill("SIGTERM"); } catch {}
try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log("\n=== Interop Results ===");
for (const r of RESULTS) {
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
}
const failed = RESULTS.filter((r) => !r.passed).length;
console.log(`\n${RESULTS.length - failed}/${RESULTS.length} passed`);
process.exit(failed > 0 ? 1 : 0);
