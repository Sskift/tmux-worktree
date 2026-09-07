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
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { startInteropTopology } from "./internal/relayV2InteropHarness.mjs";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

let topology;
try {
  topology = await startInteropTopology({
    deviceLabel: "g3-android-client",
    clientIdPrefix: "g3-android-",
    tmpPrefix: "relay-v2-g3-",
  });
} catch (error) {
  console.error("Topology startup failed:", error.message);
  process.exit(1);
}

const {
  tls,
  tmpRoot,
  brokerProc,
  hostProc,
  issuerUrl,
  clientRelayUrl,
  hostId,
  clientCreds,
  clientInstanceId,
} = topology;

const handoffPath = arg("--handoff", join(tmpRoot, "handoff.json"));
const resultPath = arg("--result", join(tmpRoot, "result.json"));

// ---------------------------------------------------------------------------
// Write handoff file for the JVM client
// ---------------------------------------------------------------------------
const handoff = {
  relayUrl: clientRelayUrl,
  issuerUrl,
  hostId,
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
topology.shutdown();
try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 || results.length === 0 ? 1 : 0);
