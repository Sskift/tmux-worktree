import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
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
import WebSocket from "ws";

import {
  TEST_LOOPBACK_CERT_PEM,
  TEST_LOOPBACK_KEY_PEM,
} from "./support/relayV2LoopbackTls.mjs";

const relayServer = await import("../dist/relayServer.js");
const brokerCore = await import("../dist/relay/v2/brokerCore.js");

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
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
    request.end(payload);
  });
}

function openSocket(port, role, accessToken, label = role) {
  const host = role === "host";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `wss://localhost:${port}/${host ? "host" : "client"}`,
      host ? "tw-relay.host.v2" : "tw-relay.v2",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        ca: TEST_LOOPBACK_CERT_PEM,
        rejectUnauthorized: true,
        perMessageDeflate: false,
      },
    );
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      reject(new Error(`${label} Upgrade rejected with ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for Relay v2 frame")),
      3_000,
    );
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString("utf8")));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
}

async function inspectPersistentState(databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const config = database.prepare(
      "SELECT issuer_keyring_json FROM deployment_config",
    ).get();
    const state = database.prepare(`
      SELECT credential_generation, continuity_generation,
        length(credential_state) AS credential_bytes
      FROM owner_state
    `).get();
    return {
      keyring: JSON.parse(config.issuer_keyring_json),
      state,
    };
  } finally {
    database.close();
  }
}

function linuxNode2216OrNewer() {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  const match = /^([0-9]+)\.([0-9]+)\./.exec(process.versions.node);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 16);
}

async function waitForCliListener(port, child, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`self-hosted CLI exited before listen: ${output()}`);
    }
    try {
      await postJson(port, "/v2/enrollments/redeem", {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for self-hosted CLI: ${output()}`);
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for self-hosted CLI drain")),
      5_000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

test("self-hosted CLI is explicit and never consumes a v1 secret", () => {
  const missingHost = spawnSync(process.execPath, [
    path.resolve("dist/cli.cjs"),
    "relay-server",
    "--v2-single-node-self-hosted",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TW_RELAY_SECRET: "v1-secret-that-must-not-be-used",
    },
  });
  assert.equal(missingHost.status, 1);
  assert.equal(missingHost.stdout, "");
  assert.match(missingHost.stderr, /需要显式 --host/);
  assert.equal(
    missingHost.stderr.includes("v1-secret-that-must-not-be-used"),
    false,
  );

  const accidentalStateDirectory = spawnSync(process.execPath, [
    path.resolve("dist/cli.cjs"),
    "relay-server",
    "--secret",
    "v1-secret",
    "--v2-self-hosted-state-dir",
    "/not/read",
  ], { encoding: "utf8" });
  assert.equal(accidentalStateDirectory.status, 1);
  assert.match(
    accidentalStateDirectory.stderr,
    /只适用于 --v2-single-node-self-hosted/,
  );
});

test("single-node SQLite owner preserves Host and Android credentials across restart", {
  skip: linuxNode2216OrNewer()
    ? false
    : "requires the explicit Linux x64 Node >=22.16 deployment target",
}, async () => {
  const tempDirectory = mkdtempSync(
    path.join(os.tmpdir(), "tw-v2-single-node-self-hosted-"),
  );
  const stateDirectory = path.join(tempDirectory, "state");
  const copiedStateDirectory = path.join(tempDirectory, "copied-state");
  const keyPath = path.join(tempDirectory, "loopback.key.pem");
  const certificatePath = path.join(tempDirectory, "loopback.cert.pem");
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  writeFileSync(keyPath, TEST_LOOPBACK_KEY_PEM, { mode: 0o600 });
  writeFileSync(certificatePath, TEST_LOOPBACK_CERT_PEM, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  chmodSync(certificatePath, 0o600);
  const port = await reserveFreePort();
  const options = {
    host: "0.0.0.0",
    port,
    advertisedOrigin: `https://localhost:${port}`,
    tlsKeyPath: keyPath,
    tlsCertificatePath: certificatePath,
    stateDirectory,
  };
  let firstHandle = null;
  let secondHandle = null;
  let cliChild = null;
  const sockets = new Set();

  try {
    firstHandle =
      await relayServer.startRelayV2BrokerSingleNodeSelfHosted(options);
    assert.equal(firstHandle.host, "0.0.0.0");
    assert.equal(lstatSync(stateDirectory).mode & 0o777, 0o700);
    const databasePath = path.join(stateDirectory, "broker-state.sqlite3");
    assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
    await assert.rejects(
      relayServer.startRelayV2BrokerSingleNodeSelfHosted(options),
      /^Error: Relay v2 single-node self-hosted Broker activation failed$/,
      "SQLite exclusive locking must reject a second Broker before listen",
    );

    let bootstrapToken = "";
    await firstHandle.admin.createHostBootstrap({}, (token) => {
      bootstrapToken = token;
    });
    assert.match(bootstrapToken, /^twhostboot2\./);
    const hostId = "restart-host";
    const hostEpoch = randomUUID();
    const hostInstanceId = randomUUID();
    const bootstrapped = await postJson(port, "/v2/hosts/bootstrap", {
      bootstrapAttemptId: "restart-bootstrap",
      bootstrapToken,
      hostId,
      hostEpoch,
      hostInstanceId,
    });
    assert.equal(bootstrapped.status, 200);
    const hostGrant = bootstrapped.json;

    const hostSocket = await openSocket(
      port,
      "host",
      hostGrant.accessToken,
      "first Host access token",
    );
    sockets.add(hostSocket);
    hostSocket.send(JSON.stringify({
      carrierVersion: 1,
      type: "host.hello",
      requestId: randomUUID(),
      payload: {
        hostId,
        hostEpoch,
        hostInstanceId,
        clientDialects: ["tw-relay.v2"],
        capabilities: [...brokerCore.RELAY_V2_REQUIRED_CAPABILITIES],
        limits: {
          maxFrameBytes: 1_048_576,
          terminalMaxFrameBytes: 65_536,
        },
      },
    }));
    const registered = await nextJson(hostSocket);
    assert.equal(registered.type, "host.registered");

    const enrollmentRequestId = randomUUID();
    hostSocket.send(JSON.stringify({
      carrierVersion: 1,
      type: "enrollment.create",
      requestId: enrollmentRequestId,
      connectorId: registered.connectorId,
      payload: {
        expiresInMs: 300_000,
        deviceLabel: "restart-android",
      },
    }));
    const enrollment = await nextJson(hostSocket);
    assert.equal(enrollment.type, "enrollment.created");
    assert.equal(enrollment.requestId, enrollmentRequestId);

    const clientInstanceId = randomUUID();
    const redeemed = await postJson(port, "/v2/enrollments/redeem", {
      exchangeAttemptId: "restart-redeem",
      enrollmentId: enrollment.payload.enrollmentId,
      enrollmentCode: enrollment.payload.enrollmentCode,
      clientInstanceId,
      deviceLabel: "restart-android",
    });
    assert.equal(redeemed.status, 200);
    const clientGrant = redeemed.json;

    await closeSocket(hostSocket);
    sockets.delete(hostSocket);
    await firstHandle.shutdown();
    firstHandle = null;

    const beforeRestart = await inspectPersistentState(databasePath);
    assert.match(
      beforeRestart.keyring.issuerId,
      /^single-node-[0-9a-f]{32}$/,
    );
    assert.match(
      beforeRestart.keyring.activeKey.kid,
      /^single-node-key-[0-9a-f]{32}$/,
    );

    secondHandle =
      await relayServer.startRelayV2BrokerSingleNodeSelfHosted(options);
    const oldHostAccess =
      await openSocket(
        port,
        "host",
        hostGrant.accessToken,
        "restarted Host access token",
      );
    sockets.add(oldHostAccess);
    oldHostAccess.send(JSON.stringify({
      carrierVersion: 1,
      type: "host.hello",
      requestId: randomUUID(),
      payload: {
        hostId,
        hostEpoch,
        hostInstanceId,
        clientDialects: ["tw-relay.v2"],
        capabilities: [...brokerCore.RELAY_V2_REQUIRED_CAPABILITIES],
        limits: {
          maxFrameBytes: 1_048_576,
          terminalMaxFrameBytes: 65_536,
        },
      },
    }));
    assert.equal((await nextJson(oldHostAccess)).type, "host.registered");
    const oldClientAccess =
      await openSocket(
        port,
        "client",
        clientGrant.accessToken,
        "restarted Android access token",
      );
    sockets.add(oldClientAccess);
    await closeSocket(oldClientAccess);
    sockets.delete(oldClientAccess);
    await closeSocket(oldHostAccess);
    sockets.delete(oldHostAccess);

    const hostRefresh = await postJson(port, "/v2/hosts/tokens/refresh", {
      refreshAttemptId: "restart-host-refresh",
      grantId: hostGrant.grantId,
      hostInstanceId,
      refreshToken: hostGrant.refreshToken,
    });
    assert.equal(hostRefresh.status, 200);
    assert.match(hostRefresh.json.accessToken, /^twcap2\./);

    const clientRefresh = await postJson(port, "/v2/tokens/refresh", {
      refreshAttemptId: "restart-client-refresh",
      grantId: clientGrant.grantId,
      clientInstanceId,
      refreshToken: clientGrant.refreshToken,
    });
    assert.equal(clientRefresh.status, 200);
    assert.match(clientRefresh.json.accessToken, /^twcap2\./);

    await secondHandle.shutdown();
    secondHandle = null;
    const afterRestart = await inspectPersistentState(databasePath);
    assert.deepEqual(afterRestart.keyring, beforeRestart.keyring);
    assert.ok(
      BigInt(afterRestart.state.credential_generation)
        > BigInt(beforeRestart.state.credential_generation),
    );
    assert.ok(BigInt(afterRestart.state.continuity_generation) > 0n);

    const cliOutput = [];
    cliChild = spawn(process.execPath, [
      path.resolve("dist/cli.cjs"),
      "relay-server",
      "--v2-single-node-self-hosted",
      "--host",
      "0.0.0.0",
      "--port",
      String(port),
      "--v2-dev-advertised-origin",
      `https://localhost:${port}`,
      "--v2-dev-tls-key",
      keyPath,
      "--v2-dev-tls-cert",
      certificatePath,
      "--v2-self-hosted-state-dir",
      stateDirectory,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cliChild.stdout.on("data", (chunk) => cliOutput.push(chunk));
    cliChild.stderr.on("data", (chunk) => cliOutput.push(chunk));
    const output = () => Buffer.concat(cliOutput).toString("utf8");
    await waitForCliListener(port, cliChild, output);
    assert.equal(cliChild.kill("SIGHUP"), true);
    const [exitCode, signalCode] = await waitForChildExit(cliChild);
    assert.equal(exitCode, 0, output());
    assert.equal(signalCode, null, output());
    cliChild = null;

    secondHandle =
      await relayServer.startRelayV2BrokerSingleNodeSelfHosted(options);
    await secondHandle.shutdown();
    secondHandle = null;

    cpSync(stateDirectory, copiedStateDirectory, {
      recursive: true,
      preserveTimestamps: true,
    });
    chmodSync(copiedStateDirectory, 0o700);
    await assert.rejects(
      relayServer.startRelayV2BrokerSingleNodeSelfHosted({
        ...options,
        stateDirectory: copiedStateDirectory,
      }),
      /^Error: Relay v2 single-node self-hosted Broker activation failed$/,
    );

    const persistedBytes = readFileSync(databasePath);
    assert.equal(persistedBytes.includes(Buffer.from(bootstrapToken)), false);
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch {}
    }
    if (firstHandle !== null) {
      try { await firstHandle.shutdown(); } catch {}
    }
    if (secondHandle !== null) {
      try { await secondHandle.shutdown(); } catch {}
    }
    if (cliChild !== null) {
      try { cliChild.kill("SIGKILL"); } catch {}
    }
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
