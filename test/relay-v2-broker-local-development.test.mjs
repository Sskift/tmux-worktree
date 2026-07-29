import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TEST_LOOPBACK_CERT_PEM,
  TEST_LOOPBACK_KEY_PEM,
} from "./support/relayV2LoopbackTls.mjs";

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, child, output, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (child.exitCode !== null) {
      throw new Error(`local development Broker exited early: ${output.text}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`local development Broker did not become ready: ${output.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function postJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = httpsRequest({
      host: "127.0.0.1",
      servername: "localhost",
      port,
      path: requestPath,
      method: "POST",
      ca: TEST_LOOPBACK_CERT_PEM,
      rejectUnauthorized: true,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Length": String(payload.byteLength),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          json: text === "" ? null : JSON.parse(text),
        });
      });
    });
    request.once("error", reject);
    request.write(payload);
    request.end();
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

test("local development activation fixes loopback bind and one localhost authority", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tw-v2-local-development-"));
  const keyPath = path.join(tempDir, "loopback.key.pem");
  const certificatePath = path.join(tempDir, "loopback.cert.pem");
  writeFileSync(keyPath, TEST_LOOPBACK_KEY_PEM, { mode: 0o600 });
  writeFileSync(certificatePath, TEST_LOOPBACK_CERT_PEM, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  chmodSync(certificatePath, 0o600);
  const port = await reserveFreePort();
  const relayServer = await import("../dist/relayServer.js");
  const handle = await relayServer.startRelayV2BrokerLocalDevelopment({
    port,
    tlsKeyPath: keyPath,
    tlsCertificatePath: certificatePath,
  });

  try {
    assert.equal(handle.host, "127.0.0.1");
    assert.equal(handle.port, port);
    assert.equal(handle.issuerUrl, `https://localhost:${port}/`);
    assert.equal(handle.relayUrl, `wss://localhost:${port}/client`);
    assert.equal(new URL(handle.issuerUrl).host, new URL(handle.relayUrl).host);
    assert.equal(handle.issuerUrl.includes(":0/"), false);
    assert.equal(handle.relayUrl.includes(":0/"), false);
  } finally {
    await handle.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local development activation rejects TLS material that is not exact 0600", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tw-v2-local-development-"));
  const keyPath = path.join(tempDir, "loopback.key.pem");
  const certificatePath = path.join(tempDir, "loopback.cert.pem");
  writeFileSync(keyPath, TEST_LOOPBACK_KEY_PEM, { mode: 0o600 });
  writeFileSync(certificatePath, TEST_LOOPBACK_CERT_PEM, { mode: 0o600 });
  chmodSync(keyPath, 0o640);
  const port = await reserveFreePort();
  const relayServer = await import("../dist/relayServer.js");

  try {
    await assert.rejects(
      relayServer.startRelayV2BrokerLocalDevelopment({
        port,
        tlsKeyPath: keyPath,
        tlsCertificatePath: certificatePath,
      }),
      /^Error: Relay v2 local development Broker activation failed$/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit local development CLI opens only loopback and writes a redeemable 0600 bootstrap", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tw-v2-local-development-"));
  const keyPath = path.join(tempDir, "loopback.key.pem");
  const certificatePath = path.join(tempDir, "loopback.cert.pem");
  const bootstrapPath = path.join(tempDir, "host.bootstrap");
  writeFileSync(keyPath, TEST_LOOPBACK_KEY_PEM, { mode: 0o600 });
  writeFileSync(certificatePath, TEST_LOOPBACK_CERT_PEM, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  chmodSync(certificatePath, 0o600);
  const port = await reserveFreePort();
  const output = { text: "" };
  const child = spawn(process.execPath, [
    path.resolve("dist/cli.cjs"),
    "relay-server",
    "--v2-local-dev",
    "--port",
    String(port),
    "--v2-dev-tls-key",
    keyPath,
    "--v2-dev-tls-cert",
    certificatePath,
    "--host-bootstrap-output",
    bootstrapPath,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TW_RELAY_SECRET: "v1-secret-that-must-not-be-used",
    },
  });
  child.stdout.on("data", (chunk) => { output.text += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output.text += chunk.toString("utf8"); });

  try {
    await waitFor(() => {
      try {
        return lstatSync(bootstrapPath).isFile();
      } catch {
        return false;
      }
    }, child, output);
    const bootstrapToken = readFileSync(bootstrapPath, "utf8").trim();
    assert.match(bootstrapToken, /^twhostboot2\./);
    assert.equal(lstatSync(bootstrapPath).mode & 0o777, 0o600);
    assert.equal(output.text.includes(bootstrapToken), false);

    const redeemed = await postJson(port, "/v2/hosts/bootstrap", {
      bootstrapAttemptId: "local-development-attempt",
      bootstrapToken,
      hostId: "local-development-host",
      hostEpoch: "local-development-epoch",
      hostInstanceId: "local-development-instance",
    });
    assert.equal(redeemed.status, 200);
    assert.match(redeemed.json?.accessToken ?? "", /^twcap2\./);
    assert.match(redeemed.json?.refreshToken ?? "", /^twref2\./);
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local development CLI refuses a non-loopback host before reading TLS", () => {
  const result = spawnSync(process.execPath, [
    path.resolve("dist/cli.cjs"),
    "relay-server",
    "--v2-local-dev",
    "--host",
    "0.0.0.0",
    "--v2-dev-tls-key",
    "/not/read.key",
    "--v2-dev-tls-cert",
    "/not/read.cert",
    "--host-bootstrap-output",
    "/not/written.bootstrap",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TW_RELAY_SECRET: "v1-secret-that-must-not-be-used",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /固定监听 127\.0\.0\.1/);
  assert.equal(result.stderr.includes("v1-secret-that-must-not-be-used"), false);

  const missingPort = spawnSync(process.execPath, [
    path.resolve("dist/cli.cjs"),
    "relay-server",
    "--v2-local-dev",
    "--v2-dev-tls-key",
    "/not/read.key",
    "--v2-dev-tls-cert",
    "/not/read.cert",
    "--host-bootstrap-output",
    "/not/written.bootstrap",
  ], {
    encoding: "utf8",
  });
  assert.equal(missingPort.status, 1);
  assert.equal(missingPort.stdout, "");
  assert.match(missingPort.stderr, /需要显式 --port/);
});
