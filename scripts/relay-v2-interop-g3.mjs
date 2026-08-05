#!/usr/bin/env node
/**
 * Relay v2 G3 (Android JVM client ↔ Node broker/host) end-to-end interop runner.
 *
 * Starts a real v2 broker + real v2 host over real WSS on localhost, enrolls a
 * client, writes a JSON handoff file with the credentials/URL/TLS cert, then
 * waits for the JVM client to write a result file. Prints a PASS/FAIL table.
 *
 * Usage: node scripts/relay-v2-interop-g3.mjs [--handoff PATH] [--result PATH]
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

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "relay-v2-g3-"));
const handoffPath = arg("--handoff", join(tmpRoot, "handoff.json"));
const resultPath = arg("--result", join(tmpRoot, "result.json"));

// ---------------------------------------------------------------------------
// TLS material
// ---------------------------------------------------------------------------
const tls = createSelfSignedCertificate({ commonName: "localhost" });
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

const bootstrapSecretPath = join(tmpRoot, "host-bootstrap-secret.txt");
writeFileSync(bootstrapSecretPath, bootstrapSecret);
chmodSync(bootstrapSecretPath, 0o600);

// ---------------------------------------------------------------------------
// Host
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
        reject(new Error(`host request ${operation} timed out`));
      }
    }, 10000);
  });
}

const bootstrapResp = await hostRequest("bootstrap_host");
if (!bootstrapResp.ok) {
  console.error("Host bootstrap failed:", JSON.stringify(bootstrapResp.error));
  process.exit(1);
}
console.log("[setup] host bootstrapped");

const startResp = await hostRequest("start_connector");
if (!startResp.ok) {
  console.error("Host connector start failed:", JSON.stringify(startResp.error));
  process.exit(1);
}
console.log("[setup] host connector started");

let registered = false;
for (let i = 0; i < 50 && !registered; i++) {
  const status = await hostRequest("status");
  if (status.ok && status.result.connector.status === "registered") registered = true;
  else await new Promise((r) => setTimeout(r, 200));
}
if (!registered) {
  console.error("Host connector did not reach registered state");
  console.error("Host stderr:", hostLog.join("").slice(-4000));
  process.exit(1);
}
console.log("[setup] host connector registered");

const enrollResp = await hostRequest("create_enrollment", { deviceLabel: "g3-android-client" });
if (!enrollResp.ok || enrollResp.result.enrollment.status !== "active") {
  console.error("Enrollment creation failed:", JSON.stringify(enrollResp.error || enrollResp.result.enrollment));
  process.exit(1);
}
const enrollment = enrollResp.result.enrollment.review.enrollment;
console.log("[setup] client enrollment created:", enrollment.enrollmentId);

// ---------------------------------------------------------------------------
// Redeem enrollment for client credentials
// ---------------------------------------------------------------------------
const clientInstanceId = "g3-android-" + Math.random().toString(36).slice(2, 12);
const redeemResp = await fetch(`${ISSUER_URL}v2/enrollments/redeem`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify({
    exchangeAttemptId: "exchange-" + Math.random().toString(36).slice(2, 12),
    enrollmentId: enrollment.enrollmentId,
    enrollmentCode: enrollment.enrollmentCode,
    clientInstanceId,
    deviceLabel: "g3-android-client",
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
// Write handoff file for the JVM client
// ---------------------------------------------------------------------------
const handoff = {
  relayUrl: CLIENT_RELAY_URL,
  issuerUrl: ISSUER_URL,
  hostId: HOST_ID,
  principalId: clientCreds.principalId,
  grantId: clientCreds.grantId,
  clientInstanceId,
  accessToken: clientCreds.accessToken,
  accessExpiresAtMs: clientCreds.accessExpiresAtMs,
  refreshToken: clientCreds.refreshToken,
  refreshExpiresAtMs: clientCreds.refreshExpiresAtMs,
  tlsCertPem: tls.cert,
};
writeFileSync(handoffPath, JSON.stringify(handoff, null, 2));
chmodSync(handoffPath, 0o600);
console.log("[setup] handoff written to", handoffPath);

// ---------------------------------------------------------------------------
// Launch the JVM client (Android runtime classes under Gradle unit tests),
// unless the caller wants to run it manually (--no-gradle).
// ---------------------------------------------------------------------------
const runGradle = !args.includes("--no-gradle");
let gradleProc = null;
const gradleLog = [];
if (runGradle) {
  console.log("[setup] launching JVM client via Gradle unit test");
  gradleProc = spawn("./gradlew", [
    ":app:testDebugUnitTest",
    "--tests", "com.tmuxworktree.mobile.core.relay.v2.RelayV2G3InteropTest",
    `-Pg3.handoff.path=${handoffPath}`,
    `-Pg3.result.path=${resultPath}`,
    "--console=plain",
  ], {
    cwd: "mobile/android",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  gradleProc.stdout.on("data", (d) => gradleLog.push(d.toString()));
  gradleProc.stderr.on("data", (d) => gradleLog.push(d.toString()));
} else {
  console.log("[setup] --no-gradle: waiting for an external JVM client");
}
console.log("[setup] waiting for JVM client result at", resultPath);

// ---------------------------------------------------------------------------
// Wait for the JVM client to write the result file
// ---------------------------------------------------------------------------
const RESULT_TIMEOUT_MS = 600_000;
const result = await new Promise((resolve, reject) => {
  const start = Date.now();
  const check = () => {
    if (existsSync(resultPath)) {
      try {
        const raw = readFileSync(resultPath, "utf8");
        if (raw.trim()) return resolve(JSON.parse(raw));
      } catch (e) {
        // file may be mid-write; retry
      }
    }
    if (gradleProc && gradleProc.exitCode !== null && !existsSync(resultPath)) {
      console.error("Gradle output (tail):", gradleLog.join("").slice(-8000));
      return reject(new Error(`gradle exited (${gradleProc.exitCode}) without writing a result`));
    }
    if (Date.now() - start > RESULT_TIMEOUT_MS) {
      if (gradleProc) console.error("Gradle output (tail):", gradleLog.join("").slice(-8000));
      return reject(new Error("JVM client result timeout"));
    }
    setTimeout(check, 200);
  };
  check();
});
if (gradleProc) {
  // Let the gradle run settle so the daemon isn't killed mid-write.
  await new Promise((resolve) => {
    if (gradleProc.exitCode !== null) return resolve();
    gradleProc.once("exit", resolve);
    setTimeout(resolve, 30_000);
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log("\n=== G3 Interop Results ===");
const results = result.results || [];
for (const r of results) {
  const tag = r.passed ? "PASS" : (r.deferred ? "DEFERRED" : "FAIL");
  console.log(`${tag}  ${r.name}${r.detail ? ": " + r.detail : ""}`);
}
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed && !r.deferred).length;
const deferred = results.filter((r) => r.deferred).length;
console.log(`\n${passed}/${results.length} passed, ${failed} failed, ${deferred} deferred`);

if (result.error) {
  console.error("\n[client error]", result.error);
}

// Cleanup
try { hostProc.kill("SIGTERM"); } catch {}
try { brokerProc.kill("SIGTERM"); } catch {}
try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 || results.length === 0 ? 1 : 0);
