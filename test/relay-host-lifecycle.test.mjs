import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const CLIENT_ID = "lifecycle-client";
const STREAM_ID = "lifecycle-stream";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(10);
  }
  if (lastError) throw lastError;
  assert.fail(message);
}

async function openWebSocketServer(onConnection) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    httpUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeWebSocketServer(server) {
  for (const socket of server.clients) socket.terminate();
  if (server._server === null) return;
  await new Promise((resolve) => server.close(resolve));
}

function safeGateName(session) {
  return session.replace(/[^A-Za-z0-9._-]/g, "_");
}

function writeFakeTmux(root) {
  const path = join(root, "fake-tmux.cjs");
  writeFileSync(path, `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);
const targetIndex = args.indexOf("-t");
const target = targetIndex >= 0 ? String(args[targetIndex + 1] || "") : "";
const session = target.replace(/^=/, "");
const key = session.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
const gateDir = process.env.TW_TEST_TMUX_GATE_DIR;
appendFileSync(join(gateDir, "calls.ndjson"), JSON.stringify({ pid: process.pid, args, session }) + "\\n");

const finish = () => {
  process.stdout.write("0\\x1f1\\n");
  process.exit(0);
};

if (!existsSync(join(gateDir, key + ".block"))) {
  finish();
} else {
  writeFileSync(join(gateDir, key + "." + process.pid + ".entered"), "");
  const timer = setInterval(() => {
    if (!existsSync(join(gateDir, key + ".release"))) return;
    clearInterval(timer);
    finish();
  }, 5);
}
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFakeTw(root) {
  const path = join(root, "fake-tw.cjs");
  writeFileSync(path, `
const { appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);
const nameIndex = args.indexOf("--name");
const session = nameIndex >= 0 ? String(args[nameIndex + 1] || "") : "";
const key = session.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
const gateDir = process.env.TW_TEST_TMUX_GATE_DIR;
appendFileSync(join(gateDir, "tw-calls.ndjson"), JSON.stringify({ args, session }) + "\\n");

if (args[0] !== "rpc" || args[1] !== "kill-session") {
  process.stderr.write("unsupported fake tw command\\n");
  process.exit(2);
}
if (existsSync(join(gateDir, key + ".rpc-kill-fail"))) {
  process.stderr.write("simulated managed RPC failure\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  protocolVersion: 1,
  kind: "session-killed",
  session,
  sessionKind: "terminal",
  killed: true,
}) + "\\n");
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFakeSshOnlyPath(root) {
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!${process.execPath}
process.stdout.write("0\\x1f1\\n");
`, { mode: 0o700 });
  chmodSync(ssh, 0o700);
  return bin;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function startHarness(t, {
  waitUntilReady = true,
  remoteChildSpawnFailure = false,
  environmentToken = "serve-token",
  tokenFileContents,
  localBaseSuffix = "",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-host-lifecycle-"));
  const gateDir = join(root, "gates");
  mkdirSync(gateDir);
  const fakeTmux = writeFakeTmux(root);
  const fakeTw = writeFakeTw(root);
  const isolatedPath = remoteChildSpawnFailure ? writeFakeSshOnlyPath(root) : process.env.PATH;
  if (tokenFileContents !== undefined) {
    writeFileSync(join(root, ".tw-serve-token"), `${tokenFileContents}\n`, { mode: 0o600 });
  }
  writeFileSync(join(root, ".tmux-worktree.json"), JSON.stringify({
    projects: {},
    tmuxPath: fakeTmux,
    hosts: remoteChildSpawnFailure
      ? [{ id: "remote", label: "remote", host: "remote.invalid" }]
      : [],
  }));
  const brokerConnections = [];
  const brokerMessages = [];
  const broker = await openWebSocketServer((socket, request) => {
    const connection = { socket, request, messages: [] };
    brokerConnections.push(connection);
    socket.on("message", (raw) => {
      const message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
      connection.messages.push(message);
      brokerMessages.push({ connection, message });
    });
  });

  const localConnections = [];
  const local = await openWebSocketServer((socket, request) => {
    const url = new URL(request.url || "/", local.httpUrl);
    localConnections.push({
      socket,
      requestUrl: request.url || "",
      authorization: request.headers.authorization,
      session: url.searchParams.get("session"),
      pane: url.searchParams.get("pane"),
      received: [],
    });
    const connection = localConnections.at(-1);
    socket.on("message", (raw) => {
      connection.received.push(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    });
  });

  const child = spawn(process.execPath, [
    "dist/cli.cjs",
    "relay-host",
    "--relay", broker.wsUrl,
    "--host-id", "lifecycle-host",
    "--secret", "lifecycle-secret",
    "--local", `${local.httpUrl}${localBaseSuffix}`,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      TW_TOKEN: environmentToken,
      TW_TMUX: fakeTmux,
      TW_DASHBOARD_CLI: fakeTw,
      TW_TEST_TMUX_GATE_DIR: gateDir,
      PATH: isolatedPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });

  const harness = {
    root,
    gateDir,
    broker,
    local,
    child,
    brokerConnections,
    brokerMessages,
    localConnections,
    output: () => output,
  };

  t.after(async () => {
    await stopChild(child);
    await closeWebSocketServer(local.server);
    await closeWebSocketServer(broker.server);
    rmSync(root, { recursive: true, force: true });
  });

  if (waitUntilReady) {
    await waitFor(
      () => brokerMessages.some(({ message }) => message.type === "host_ready"),
      `relay-host did not become ready; output:\n${output}`,
    );
  }
  return harness;
}

function currentBrokerSocket(harness) {
  const connection = harness.brokerConnections.at(-1);
  assert.ok(connection, `relay-host did not connect; output:\n${harness.output()}`);
  assert.equal(connection.socket.readyState, WebSocket.OPEN);
  return connection.socket;
}

function sendToHost(harness, message) {
  sendToHostAs(harness, CLIENT_ID, message);
}

function sendToHostAs(harness, clientId, message) {
  currentBrokerSocket(harness).send(JSON.stringify({ clientId, ...message }));
}

function openTerminal(harness, session, streamId = STREAM_ID) {
  openTerminalAs(harness, CLIENT_ID, session, streamId);
}

function openTerminalAs(harness, clientId, session, streamId) {
  openScopedTerminalAs(harness, clientId, `local:${session}`, streamId);
}

function openScopedTerminalAs(harness, clientId, session, streamId) {
  sendToHostAs(harness, clientId, {
    type: "open_terminal",
    streamId,
    session,
    pane: 0,
  });
}

function setGate(harness, session, suffix) {
  writeFileSync(join(harness.gateDir, `${safeGateName(session)}.${suffix}`), "");
}

function blockPaneResolution(harness, session) {
  writeFileSync(join(harness.gateDir, `${safeGateName(session)}.block`), "");
}

async function waitForBlockedResolution(harness, session) {
  const prefix = `${safeGateName(session)}.`;
  await waitFor(
    () => readdirSync(harness.gateDir).some((name) => name.startsWith(prefix) && name.endsWith(".entered")),
    `pane resolution for ${session} did not enter its gate`,
  );
}

function releasePaneResolution(harness, session) {
  writeFileSync(join(harness.gateDir, `${safeGateName(session)}.release`), "");
}

async function assertNoAdditionalLocalConnection(harness, count, durationMs = 300) {
  await delay(durationMs);
  assert.equal(
    harness.localConnections.length,
    count,
    `unexpected local terminal connections: ${harness.localConnections.map(({ session }) => session).join(", ")}`,
  );
}

function assertLocalBridgeRequest(connection, expectedToken) {
  const url = new URL(connection.requestUrl, "ws://local.invalid");
  assert.equal(url.pathname, "/ws");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["pane", "session"]);
  assert.equal(url.searchParams.get("session"), connection.session);
  assert.equal(url.searchParams.get("pane"), connection.pane);
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(connection.authorization, `Bearer ${expectedToken}`);
}

test("local tw serve bridge keeps credentials in the Authorization header", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "bridge-header");
  const connection = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "bridge-header"),
    "local bridge did not open",
  );

  assertLocalBridgeRequest(connection, "serve-token");
});

test("explicit TW_TOKEN overrides a stale token file for the local bridge", async (t) => {
  const harness = await startHarness(t, {
    environmentToken: "env-token",
    tokenFileContents: "stale-file-token",
  });
  openTerminal(harness, "bridge-explicit");
  const connection = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "bridge-explicit"),
    "local bridge did not open with an explicit environment token",
  );

  assertLocalBridgeRequest(connection, "env-token");
  assert.equal(connection.requestUrl.includes("stale-file-token"), false);
  assert.notEqual(connection.authorization, "Bearer stale-file-token");
});

test("local bridge discards inherited query and fragment credentials", async (t) => {
  const harness = await startHarness(t, {
    environmentToken: "env-token",
    localBaseSuffix: "?token=stale-url-token&other=stale-other#stale-fragment",
  });
  openTerminal(harness, "bridge-sanitized-base");
  const connection = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "bridge-sanitized-base"),
    "local bridge did not open from a base URL containing stale parameters",
  );

  assertLocalBridgeRequest(connection, "env-token");
  assert.equal(connection.requestUrl.includes("stale-url-token"), false);
  assert.equal(connection.requestUrl.includes("stale-other"), false);
  assert.equal(connection.requestUrl.includes("stale-fragment"), false);
});

test("close invalidates an open attempt waiting on pane resolution", async (t) => {
  const harness = await startHarness(t);
  blockPaneResolution(harness, "delayed-close");
  openTerminal(harness, "delayed-close");
  await waitForBlockedResolution(harness, "delayed-close");

  sendToHost(harness, { type: "close_terminal", streamId: STREAM_ID });
  releasePaneResolution(harness, "delayed-close");

  await assertNoAdditionalLocalConnection(harness, 0);
});

test("reverse completion for the same stream only publishes the latest open", async (t) => {
  const harness = await startHarness(t);
  blockPaneResolution(harness, "generation-a");
  openTerminal(harness, "generation-a");
  await waitForBlockedResolution(harness, "generation-a");

  openTerminal(harness, "generation-b");
  await waitFor(
    () => harness.localConnections.some(({ session }) => session === "generation-b"),
    "the latest terminal generation did not open",
  );
  releasePaneResolution(harness, "generation-a");
  await delay(300);

  assert.deepEqual(harness.localConnections.map(({ session }) => session), ["generation-b"]);
});

test("late data and finalization from an old transport cannot affect its replacement", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "transport-a");
  const oldTransport = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "transport-a"),
    "the first transport did not open",
  );

  // Hold the old transport in CLOSING so it can deterministically deliver a
  // late frame after the replacement has become current.
  oldTransport.socket._socket.pause();
  openTerminal(harness, "transport-b");
  const replacement = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "transport-b"),
    "the replacement transport did not open",
  );
  const beforeLateData = harness.brokerMessages.length;
  oldTransport.socket.send("late-from-generation-a");
  await delay(100);

  assert.equal(
    harness.brokerMessages.slice(beforeLateData).some(({ message }) => (
      message.type === "terminal_data" && message.data === "late-from-generation-a"
    )),
    false,
    "an old transport published terminal data after replacement",
  );

  oldTransport.socket._socket.resume();
  oldTransport.socket.terminate();
  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: "input-for-b" });
  await waitFor(
    () => replacement.received.includes("input-for-b"),
    "old transport finalization removed or replaced the current stream",
  );
});

test("route-only close prevents later input and resize from reopening a terminal", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "closed-route");
  const first = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "closed-route"),
    "terminal transport did not open",
  );

  first.socket.close();
  await waitFor(
    () => harness.brokerMessages.some(({ message }) => message.type === "terminal_exit"),
    "relay-host did not observe the terminal transport close",
  );
  sendToHost(harness, { type: "close_terminal", streamId: STREAM_ID });
  await delay(25);
  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: "must-not-reopen" });
  sendToHost(harness, { type: "resize", streamId: STREAM_ID, cols: 120, rows: 40 });

  await assertNoAdditionalLocalConnection(harness, 1);
});

test("a failed managed kill preserves the live route and transport", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "kill-failure");
  const transport = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "kill-failure"),
    "terminal transport did not open before the failed kill",
  );
  setGate(harness, "kill-failure", "rpc-kill-fail");
  const beforeKill = harness.brokerMessages.length;

  sendToHost(harness, {
    type: "kill_session",
    requestId: "kill-failure-request",
    session: "local:kill-failure",
    managed: true,
  });
  await waitFor(
    () => harness.brokerMessages.slice(beforeKill).some(({ message }) => (
      message.type === "error" && message.requestId === "kill-failure-request"
    )),
    "failed kill did not return its request error",
  );
  assert.equal(
    harness.brokerMessages.slice(beforeKill).some(({ message }) => message.type === "terminal_exit"),
    false,
    "failed kill finalized a live stream",
  );

  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: "after-failed-kill" });
  await waitFor(
    () => transport.received.includes("after-failed-kill"),
    "failed kill removed the route or transport",
  );
});

test("a successful kill finalizes every client stream exactly once and retires all routes", async (t) => {
  const harness = await startHarness(t);
  openTerminalAs(harness, "kill-client-a", "kill-success", "kill-stream-a");
  openTerminalAs(harness, "kill-client-b", "kill-success", "kill-stream-b");
  await waitFor(
    () => harness.localConnections.filter(({ session }) => session === "kill-success").length === 2,
    "both client transports did not open",
  );
  const beforeKill = harness.brokerMessages.length;

  sendToHostAs(harness, "kill-client-a", {
    type: "kill_session",
    requestId: "kill-success-request",
    session: "local:kill-success",
    managed: true,
  });
  await waitFor(
    () => harness.brokerMessages.slice(beforeKill).some(({ message }) => (
      message.type === "session_killed" && message.requestId === "kill-success-request"
    )),
    "successful kill did not settle",
  );
  await delay(100);
  const exits = harness.brokerMessages
    .slice(beforeKill)
    .map(({ message }) => message)
    .filter(({ type }) => type === "terminal_exit");
  assert.deepEqual(
    exits.map(({ clientId, streamId }) => `${clientId}:${streamId}`).sort(),
    ["kill-client-a:kill-stream-a", "kill-client-b:kill-stream-b"],
  );

  sendToHostAs(harness, "kill-client-a", {
    type: "terminal_input",
    streamId: "kill-stream-a",
    data: "must-not-reopen-a",
  });
  sendToHostAs(harness, "kill-client-b", {
    type: "resize",
    streamId: "kill-stream-b",
    cols: 100,
    rows: 30,
  });
  await assertNoAdditionalLocalConnection(harness, 2);
});

test("local transport error followed by close emits one error and one terminal exit", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "local-error-close");
  const transport = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "local-error-close"),
    "local terminal transport did not open",
  );
  const beforeFailure = harness.brokerMessages.length;

  // A server-to-client WebSocket frame must not be masked. Sending a masked
  // frame forces ws to emit error and then close for the same transport.
  transport.socket._socket.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0]));
  await waitFor(
    () => {
      const messages = harness.brokerMessages.slice(beforeFailure).map(({ message }) => message);
      return messages.some(({ type }) => type === "error")
        && messages.some(({ type }) => type === "terminal_exit");
    },
    "local transport did not report both error and terminal exit",
  );
  await delay(100);
  const lifecycle = harness.brokerMessages
    .slice(beforeFailure)
    .map(({ message }) => message)
    .filter(({ type, streamId }) => streamId === STREAM_ID && (type === "error" || type === "terminal_exit"));
  assert.deepEqual(lifecycle.map(({ type }) => type), ["error", "terminal_exit"]);
  assert.ok(lifecycle[0].message);
});

test("remote child spawn error followed by close emits one error and one terminal exit", async (t) => {
  const harness = await startHarness(t, { remoteChildSpawnFailure: true });
  const clientId = "remote-error-client";
  const streamId = "remote-error-stream";
  const beforeFailure = harness.brokerMessages.length;

  // The isolated PATH contains the fake ssh used for pane resolution but no
  // python3, so ChildProcess deterministically emits error and then close.
  openScopedTerminalAs(harness, clientId, "remote:remote-error-close", streamId);
  await waitFor(
    () => {
      const messages = harness.brokerMessages.slice(beforeFailure).map(({ message }) => message);
      return messages.some(({ type }) => type === "error")
        && messages.some(({ type }) => type === "terminal_exit");
    },
    "remote child did not report both spawn error and terminal exit",
  );
  await delay(100);
  const lifecycle = harness.brokerMessages
    .slice(beforeFailure)
    .map(({ message }) => message)
    .filter((message) => (
      message.clientId === clientId
      && message.streamId === streamId
      && (message.type === "error" || message.type === "terminal_exit")
    ));
  assert.deepEqual(lifecycle.map(({ type }) => type), ["error", "terminal_exit"]);
  assert.match(lifecycle[0].message, /python3|ENOENT|spawn/i);
});

test("closing the relay connection invalidates pending stream attempts", async (t) => {
  const harness = await startHarness(t);
  blockPaneResolution(harness, "connection-close");
  openTerminal(harness, "connection-close");
  await waitForBlockedResolution(harness, "connection-close");

  currentBrokerSocket(harness).close(1000, "test disconnect");
  await waitFor(
    () => currentBrokerSocketOrClosed(harness),
    "relay connection did not close",
  );
  releasePaneResolution(harness, "connection-close");

  await assertNoAdditionalLocalConnection(harness, 0, 400);
});

function currentBrokerSocketOrClosed(harness) {
  const socket = harness.brokerConnections.at(-1)?.socket;
  return socket && socket.readyState === WebSocket.CLOSED;
}

test("broker replacement close is terminal while abnormal network close retries", async (t) => {
  await t.test("4002 does not reconnect", async (t) => {
    const harness = await startHarness(t);
    currentBrokerSocket(harness).close(4002, "host replaced");
    await delay(1_600);
    assert.equal(harness.brokerConnections.length, 1, `unexpected reconnect; output:\n${harness.output()}`);
  });

  await t.test("1006 retries", async (t) => {
    const harness = await startHarness(t);
    currentBrokerSocket(harness).terminate();
    await waitFor(
      () => harness.brokerConnections.length >= 2,
      `relay-host did not retry after an abnormal close; output:\n${harness.output()}`,
      3_500,
    );
    assert.ok(harness.brokerConnections.length >= 2);
  });
});
