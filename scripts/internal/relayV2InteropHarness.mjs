/**
 * Shared broker/host bootstrap for the Relay v2 interop runners (G2 and G3).
 *
 * Starts a real v2 broker + real v2 host over real WSS on localhost, enrolls a
 * client, and redeems the enrollment for client credentials. Each runner keeps
 * its own client section (Node WebSocket for G2, JVM handoff for G3).
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfSignedCertificate } from "./relayV2InteropTls.mjs";

const BROKER_READY_DEADLINE_MS = 15_000;
const HOST_READY_DEADLINE_MS = 15_000;

/**
 * Spawn an interop host process against an existing broker and wire its
 * dashboard-management stdio. Shared by startInteropTopology and the fault
 * injection runner (host restart / dual-host scenarios).
 *
 * `config` carries the spawn env inputs: tlsCertPath, profilePath,
 * bootstrapSecretPath (all optional beyond the trusted home + CA), and an
 * optional explicit trustedHome (a fresh mkdtemp under /private/tmp is created
 * when omitted). Returns { hostProc, hostLog, hostExitCode(), hostRequest,
 * hostTrustedHome }.
 */
export function spawnInteropHost(config = {}) {
  const hostTrustedHome = config.hostTrustedHome
    ?? realpathSync.native(mkdtempSync("/private/tmp/relay-v2-host-"));
  chmodSync(hostTrustedHome, 0o700);

  const env = {
    ...process.env,
    HOME: hostTrustedHome,
    TW_HOST_TRUSTED_HOME: hostTrustedHome,
    TW_HOST_HTTPS_CA: config.tlsCertPath,
    TW_HOST_WSS_CA: config.tlsCertPath,
  };
  if (config.profilePath) env.TW_HOST_PROFILE_INPUT = config.profilePath;
  if (config.bootstrapSecretPath) env.TW_HOST_BOOTSTRAP_SECRET_INPUT = config.bootstrapSecretPath;

  const hostProc = spawn(process.execPath, [
    "scripts/internal/relayV2InteropHost.mjs",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
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

  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + HOST_READY_DEADLINE_MS;
    const check = () => {
      if (hostReadyFrame) return resolve();
      if (hostProc.exitCode !== null) {
        return reject(new Error(
          `host exited early (code=${hostExitCode}); stderr: ${hostLog.join("").slice(-2000)}`,
        ));
      }
      if (Date.now() >= deadline) return reject(new Error("host startup timed out"));
      setTimeout(check, 100);
    };
    check();
  });

  return {
    hostProc,
    hostLog,
    hostExitCode: () => hostExitCode,
    hostRequest,
    hostTrustedHome,
    ready,
  };
}

/**
 * Start the full interop topology (TLS, broker, host, enrollment, redeem).
 *
 * Options:
 * - deviceLabel: label for the enrolled client (default "interop-client")
 * - clientIdPrefix: prefix for the redeemed client instance id
 * - hostId: host id (default "interop-host")
 * - tmpPrefix: prefix for the mkdtemp root (default "relay-v2-interop-")
 *
 * Returns the topology state; call `shutdown()` to stop broker + host.
 */
export async function startInteropTopology(options = {}) {
  const {
    deviceLabel = "interop-client",
    clientIdPrefix = "interop-client-",
    hostId = "interop-host",
    tmpPrefix = "relay-v2-interop-",
  } = options;

  // -------------------------------------------------------------------------
  // TLS material
  // -------------------------------------------------------------------------
  const tls = createSelfSignedCertificate({ commonName: "localhost" });
  const tmpRoot = mkdtempSync(join(tmpdir(), tmpPrefix));
  const tlsKeyPath = join(tmpRoot, "tls-key.pem");
  const tlsCertPath = join(tmpRoot, "tls-cert.pem");
  writeFileSync(tlsKeyPath, tls.key);
  writeFileSync(tlsCertPath, tls.cert);
  chmodSync(tlsKeyPath, 0o600);
  chmodSync(tlsCertPath, 0o600);

  // -------------------------------------------------------------------------
  // Broker
  // -------------------------------------------------------------------------
  const brokerPort = 18000 + Math.floor(Math.random() * 1000);
  const brokerProc = spawn(process.execPath, [
    "dist/cli.cjs",
    "relay-server",
    "--v2-local-dev",
    "--port", String(brokerPort),
    "--v2-dev-tls-key", tlsKeyPath,
    "--v2-dev-tls-cert", tlsCertPath,
    "--host-bootstrap-output", join(tmpRoot, "host-bootstrap.txt"),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const brokerLog = [];
  brokerProc.stdout.on("data", (d) => brokerLog.push(d.toString()));
  brokerProc.stderr.on("data", (d) => brokerLog.push(d.toString()));

  const bootstrapOutputPath = join(tmpRoot, "host-bootstrap.txt");
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + BROKER_READY_DEADLINE_MS;
    const check = () => {
      if (existsSync(bootstrapOutputPath)) return resolve();
      if (brokerProc.exitCode !== null) {
        console.error("Broker stderr:", brokerLog.join(""));
        return reject(new Error("broker exited early"));
      }
      if (Date.now() >= deadline) return reject(new Error("broker startup timed out"));
      setTimeout(check, 100);
    };
    check();
  });
  console.log("[setup] broker started on port", brokerPort);

  const bootstrapSecret = readFileSync(bootstrapOutputPath, "utf8").trim();
  console.log("[setup] host bootstrap secret obtained");

  // -------------------------------------------------------------------------
  // Host profile
  // -------------------------------------------------------------------------
  const issuerUrl = `https://127.0.0.1:${brokerPort}/`;
  const relayUrl = `wss://127.0.0.1:${brokerPort}/`;
  const clientRelayUrl = `wss://127.0.0.1:${brokerPort}/client`;
  const hostTrustedHome = realpathSync.native(mkdtempSync("/private/tmp/relay-v2-host-"));
  chmodSync(hostTrustedHome, 0o700);

  const profile = {
    contract: "tmux-worktree-relay-v2-host-production-profile",
    schemaVersion: 1,
    hostId,
    relayUrl,
    credentialIssuerUrl: issuerUrl,
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

  // -------------------------------------------------------------------------
  // Host (with dashboard management stdio)
  // -------------------------------------------------------------------------
  const spawned = spawnInteropHost({
    tlsCertPath,
    profilePath,
    bootstrapSecretPath,
    hostTrustedHome,
  });
  const hostProc = spawned.hostProc;
  const hostLog = spawned.hostLog;
  const hostExitCode = spawned.hostExitCode;
  const hostRequest = spawned.hostRequest;
  await spawned.ready;
  console.log("[setup] host dashboard management ready");

  // Bootstrap host credentials.
  const bootstrapResp = await hostRequest("bootstrap_host");
  if (!bootstrapResp.ok) {
    console.error("Host bootstrap failed:", JSON.stringify(bootstrapResp.error));
    throw new Error("host bootstrap failed");
  }
  console.log("[setup] host bootstrapped");

  // Start the host connector.
  const startResp = await hostRequest("start_connector");
  if (!startResp.ok) {
    console.error("Host connector start failed:", JSON.stringify(startResp.error));
    throw new Error("host connector start failed");
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
    throw new Error("host connector did not reach registered state");
  }
  console.log("[setup] host connector registered");

  // Create a client enrollment.
  const enrollResp = await hostRequest("create_enrollment", { deviceLabel });
  if (!enrollResp.ok || enrollResp.result.enrollment.status !== "active") {
    console.error("Enrollment creation failed:", JSON.stringify(enrollResp.error || enrollResp.result.enrollment));
    throw new Error("enrollment creation failed");
  }
  const enrollment = enrollResp.result.enrollment.review.enrollment;
  console.log("[setup] client enrollment created:", enrollment.enrollmentId);

  // -------------------------------------------------------------------------
  // Redeem enrollment for client credentials
  // -------------------------------------------------------------------------
  const clientInstanceId = clientIdPrefix + Math.random().toString(36).slice(2, 12);
  const redeemResp = await fetch(`${issuerUrl}v2/enrollments/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      exchangeAttemptId: "exchange-" + Math.random().toString(36).slice(2, 12),
      enrollmentId: enrollment.enrollmentId,
      enrollmentCode: enrollment.enrollmentCode,
      clientInstanceId,
      deviceLabel,
    }),
    ca: tls.cert,
  });
  if (!redeemResp.ok) {
    const body = await redeemResp.text();
    console.error("Enrollment redeem failed:", redeemResp.status, body);
    throw new Error("enrollment redeem failed");
  }
  const clientCreds = await redeemResp.json();
  console.log("[setup] client credentials obtained, principalId:", clientCreds.principalId);

  return {
    tls,
    tmpRoot,
    tlsKeyPath,
    tlsCertPath,
    brokerProc,
    brokerLog,
    brokerPort,
    hostProc,
    hostLog,
    hostExitCode,
    hostRequest,
    issuerUrl,
    relayUrl,
    clientRelayUrl,
    hostId,
    hostTrustedHome,
    profilePath,
    bootstrapSecretPath,
    clientCreds,
    clientInstanceId,
    enrollment,
    bootstrapSecret,
    shutdown() {
      try { hostProc.kill("SIGTERM"); } catch {}
      try { brokerProc.kill("SIGTERM"); } catch {}
    },
  };
}
