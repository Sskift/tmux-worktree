import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const terminalControlApi = await import("../dist/terminalControl/index.js");

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
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const targetIndex = args.indexOf("-t");
const target = targetIndex >= 0 ? String(args[targetIndex + 1] || "") : "";
const session = target.replace(/^=/, "").split(":.")[0];
const key = session.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
const gateDir = process.env.TW_TEST_TMUX_GATE_DIR;
appendFileSync(join(gateDir, "calls.ndjson"), JSON.stringify({ pid: process.pid, args, session }) + "\\n");
if (args[0] === "list-sessions" && args.at(-1).includes("#{session_id}")) {
  let managed = [];
  try {
    managed = JSON.parse(readFileSync(join(process.env.HOME, ".tmux-worktree", "state.json"), "utf8")).sessions || [];
  } catch {}
  managed.forEach((entry, index) => {
    process.stdout.write(String(entry.name) + "\\u001f$" + String(index) + "\\n");
  });
  process.exit(0);
}
if (args[0] === "show-options" && args.at(-1) === "@tw_terminal_control_output_generation_v1") {
  const option = join(gateDir, key + ".output-generation");
  if (!existsSync(option)) process.exit(1);
  process.stdout.write(readFileSync(option, "utf8"));
  process.exit(0);
}
if (args[0] === "set-option" && args.includes("@tw_terminal_control_output_generation_v1")) {
  writeFileSync(join(gateDir, key + ".output-generation"), String(args.at(-1)) + "\\n");
  process.exit(0);
}
if (args[0] === "display-message" && args.at(-1) === "#{session_id}") {
  process.stdout.write("$0\\n");
  process.exit(0);
}
if (args[0] === "display-message" && args.at(-1) === "#{pane_pipe}") {
  process.stdout.write(existsSync(join(gateDir, key + ".output-pipe")) ? "1\\n" : "0\\n");
  process.exit(0);
}
if (args[0] === "pipe-pane") {
  const active = join(gateDir, key + ".output-pipe");
  if (args.includes("-O")) writeFileSync(active, "1\\n");
  else rmSync(active, { force: true });
  process.exit(0);
}
if (args[0] === "show-options") {
  process.stdout.write("tmux-instance-" + key + "\\n");
  process.exit(0);
}
if (args[0] === "list-panes" && args.at(-1) === "#{pane_index}") {
  process.stdout.write("0\\n");
  process.exit(0);
}
if (args[0] === "load-buffer" && existsSync(join(gateDir, "close-load-buffer-stdin"))) {
  process.exit(0);
}
if (existsSync(join(gateDir, key + ".ignore-term"))) {
  process.on("SIGTERM", () => {});
}
if (existsSync(join(gateDir, key + ".spawn-grandchild"))) {
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], { stdio: "ignore" });
  writeFileSync(join(gateDir, key + ".descendant-pid"), String(descendant.pid));
}

const finish = () => {
  process.stdout.write("0\\x1f1\\n");
  process.exit(0);
};

const run = () => {
  if (args[0] !== "load-buffer") {
    finish();
    return;
  }
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  process.stdin.on("end", () => {
    appendFileSync(
      join(gateDir, "tmux-inputs.ndjson"),
      JSON.stringify({ args, input }) + "\\n",
    );
    finish();
  });
  process.stdin.resume();
};

if (!existsSync(join(gateDir, key + ".block"))) {
  run();
} else {
  writeFileSync(join(gateDir, key + "." + process.pid + ".entered"), "");
  const timer = setInterval(() => {
    if (!existsSync(join(gateDir, key + ".release"))) return;
    clearInterval(timer);
    run();
  }, 5);
}
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFakeTw(root) {
  const path = join(root, "fake-tw.cjs");
  writeFileSync(path, `
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);
const nameIndex = args.indexOf("--name");
const session = nameIndex >= 0 ? String(args[nameIndex + 1] || "") : "";
const key = session.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
const gateDir = process.env.TW_TEST_TMUX_GATE_DIR;
appendFileSync(join(gateDir, "tw-calls.ndjson"), JSON.stringify({ args, session }) + "\\n");

if (args[0] === "rpc" && args[1] === "kill-session" && existsSync(join(gateDir, key + ".rpc-kill-fail"))) {
  process.stderr.write("simulated managed RPC failure\\n");
  process.exit(1);
}
const finish = () => {
  if (args[0] === "rpc" && args[1] === "kill-session") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      kind: "session-killed",
      session,
      sessionKind: "terminal",
      killed: true,
    }) + "\\n");
    process.exit(0);
  }
  if (args[0] === "rpc" && args[1] === "create-terminal") {
    const cwdIndex = args.indexOf("--cwd");
    const cwd = cwdIndex >= 0 ? String(args[cwdIndex + 1] || "") : "";
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      kind: "terminal",
      session: "tw-term-drained",
      cwd,
    }) + "\\n");
    process.exit(0);
  }
  process.stderr.write("unsupported fake tw command\\n");
  process.exit(2);
};
const commandGate = "tw-" + key;
if (!existsSync(join(gateDir, commandGate + ".block"))) {
  finish();
} else {
  writeFileSync(join(gateDir, commandGate + "." + process.pid + ".entered"), "");
  const timer = setInterval(() => {
    if (!existsSync(join(gateDir, commandGate + ".release"))) return;
    clearInterval(timer);
    finish();
  }, 5);
}
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeFakeSshOnlyPath(root) {
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!${process.execPath}
const command = process.argv.slice(2).join(" ");
if (command.includes("terminal-control") && command.includes("request")) {
  const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const gateDir = process.env.TW_TEST_TMUX_GATE_DIR;
  const statePath = join(gateDir, "remote-terminal-control.json");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  process.stdin.on("end", () => {
    const request = JSON.parse(input.trim());
    let state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { epoch: "remote-epoch", leases: {} };
    let result;
    if (request.type === "target.resolve") {
      result = { controlTargetId: "remote-target-" + request.sessionName, controlEpoch: state.epoch };
    } else if (request.type === "lease.acquire") {
      const lease = state.leases[request.controlTargetId] || {
        controlTargetId: request.controlTargetId,
        controlEpoch: state.epoch,
        leaseId: "remote-lease-" + request.controlTargetId,
        fence: "1",
        owner: request.owner,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      state.leases[request.controlTargetId] = lease;
      writeFileSync(statePath, JSON.stringify(state));
      result = { lease };
    } else if (request.type === "lease.renew") {
      const lease = state.leases[request.lease.controlTargetId];
      if (!lease) throw new Error("remote lease missing");
      result = { lease };
    } else if (request.type === "lease.release") {
      delete state.leases[request.lease.controlTargetId];
      writeFileSync(statePath, JSON.stringify(state));
      result = { state: "FREE" };
    } else if (request.type.startsWith("input.")) {
      appendFileSync(join(gateDir, "remote-control-inputs.ndjson"), JSON.stringify(request) + "\\n");
      result = { operationId: request.operationId, accepted: true, deduplicated: false };
    } else {
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "unsupported fake request", retryable: false },
      }) + "\\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result }) + "\\n");
  });
  process.stdin.resume();
  return;
}
if (command.includes("list-panes")) {
  process.stdout.write("0\\x1f1\\n");
  process.exit(0);
}
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.env.TW_TEST_TMUX_GATE_DIR, "remote-ssh-pid"), String(process.pid));
process.on("SIGWINCH", () => {});
process.on("SIGTERM", () => {});
process.stdout.write("REMOTE_READY");
process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stdin.resume();
setInterval(() => {}, 1_000);
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
  remotePtySuccess = false,
  environmentToken = "serve-token",
  tokenFileContents,
  localBaseSuffix = "",
  withStatusFile = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "tw-relay-host-lifecycle-"));
  const gateDir = join(root, "gates");
  mkdirSync(gateDir);
  const fakeTmux = writeFakeTmux(root);
  const fakeTw = writeFakeTw(root);
  const hasRemoteScope = remoteChildSpawnFailure || remotePtySuccess;
  const fakeRemoteBin = hasRemoteScope
    ? writeFakeSshOnlyPath(root)
    : undefined;
  const isolatedPath = fakeRemoteBin
    ? (remotePtySuccess ? `${fakeRemoteBin}:${process.env.PATH}` : fakeRemoteBin)
    : process.env.PATH;
  if (tokenFileContents !== undefined) {
    writeFileSync(join(root, ".tw-serve-token"), `${tokenFileContents}\n`, { mode: 0o600 });
  }
  writeFileSync(join(root, ".tmux-worktree.json"), JSON.stringify({
    projects: {},
    tmuxPath: fakeTmux,
    hosts: hasRemoteScope
      ? [{ id: "remote", label: "remote", host: "remote.invalid" }]
      : [],
  }));
  const twHome = join(root, ".tmux-worktree");
  mkdirSync(twHome);
  const managedSessions = new Map();
  const writeManagedState = () => {
    writeFileSync(join(twHome, "state.json"), `${JSON.stringify({
      version: 1,
      sessions: [...managedSessions.values()],
    }, null, 2)}\n`, { mode: 0o600 });
  };
  writeManagedState();
  const registerManagedSession = (name) => {
    if (!name || managedSessions.has(name)) return;
    managedSessions.set(name, {
      name,
      kind: "terminal",
      profile: "dashboard",
      cwd: root,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    writeManagedState();
  };
  const terminalControlSocket = join(tmpdir(), `tw-control-${root.split("/").at(-1)}.sock`);
  const terminalControl = spawn(process.execPath, [
    "dist/cli.cjs",
    "terminal-control",
    "serve",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      TW_TMUX: fakeTmux,
      TW_DASHBOARD_CLI: fakeTw,
      TW_TEST_TMUX_GATE_DIR: gateDir,
      TW_TERMINAL_CONTROL_SOCKET: terminalControlSocket,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let terminalControlOutput = "";
  terminalControl.stdout.on("data", (chunk) => { terminalControlOutput += chunk.toString("utf8"); });
  terminalControl.stderr.on("data", (chunk) => { terminalControlOutput += chunk.toString("utf8"); });
  await waitFor(
    () => existsSync(terminalControlSocket),
    `terminal-control did not become ready; output:\n${terminalControlOutput}`,
  );
  const statusFile = withStatusFile ? join(root, "relay-status.json") : undefined;
  const brokerConnections = [];
  const brokerMessages = [];
  const broker = await openWebSocketServer((socket, request) => {
    const connection = { socket, request, messages: [], closeCode: undefined, closeReason: undefined };
    brokerConnections.push(connection);
    socket.on("message", (raw) => {
      const message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
      connection.messages.push(message);
      brokerMessages.push({ connection, message });
    });
    socket.on("close", (code, reason) => {
      connection.closeCode = code;
      connection.closeReason = reason.toString("utf8");
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
    ...(statusFile ? ["--status-file", statusFile] : []),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      TW_TOKEN: environmentToken,
      TW_TMUX: fakeTmux,
      TW_DASHBOARD_CLI: fakeTw,
      TW_TEST_TMUX_GATE_DIR: gateDir,
      TW_TERMINAL_CONTROL_SOCKET: terminalControlSocket,
      TW_TERMINAL_CONTROL_CLI: join(process.cwd(), "dist/cli.cjs"),
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
    statusFile,
    registerManagedSession,
    terminalControl,
    terminalControlSocket,
    brokerConnections,
    brokerMessages,
    localConnections,
    output: () => output,
  };

  t.after(async () => {
    await stopChild(child);
    await stopChild(terminalControl);
    rmSync(terminalControlSocket, { force: true });
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
  if (typeof message.session === "string" && message.session.startsWith("local:")) {
    harness.registerManagedSession(message.session.slice("local:".length));
  }
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

function blockTwCommand(harness, key = "default") {
  writeFileSync(join(harness.gateDir, `tw-${safeGateName(key)}.block`), "");
}

async function waitForBlockedTwCommand(harness, key = "default") {
  const prefix = `tw-${safeGateName(key)}.`;
  return waitFor(
    () => readdirSync(harness.gateDir).find((name) => (
      name.startsWith(prefix) && name.endsWith(".entered")
    )),
    `tw command ${key} did not enter its gate`,
  );
}

function releaseTwCommand(harness, key = "default") {
  writeFileSync(join(harness.gateDir, `tw-${safeGateName(key)}.release`), "");
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

test("local agent submit preserves raw text and handles empty messages without a buffer", async (t) => {
  const harness = await startHarness(t);
  sendToHost(harness, {
    type: "send_agent_message",
    requestId: "agent-submit",
    session: "local:agent-submit",
    pane: 0,
    message: "a;\r\nb",
    submit: true,
  });
  await waitFor(
    () => harness.brokerMessages.some(({ message }) => (
      message.type === "agent_message_sent" && message.requestId === "agent-submit"
    )),
    `relay-host did not acknowledge the agent message; output:\n${harness.output()}`,
  );
  sendToHost(harness, {
    type: "send_agent_message",
    requestId: "agent-empty-submit",
    session: "local:agent-submit",
    pane: 0,
    message: "",
    submit: true,
  });
  await waitFor(
    () => harness.brokerMessages.some(({ message }) => (
      message.type === "agent_message_sent" && message.requestId === "agent-empty-submit"
    )),
    "relay-host did not acknowledge the empty submit",
  );
  sendToHost(harness, {
    type: "send_agent_message",
    requestId: "agent-empty-no-submit",
    session: "local:agent-submit",
    pane: 0,
    message: "",
    submit: false,
  });
  await waitFor(
    () => harness.brokerMessages.some(({ message }) => (
      message.type === "agent_message_sent" && message.requestId === "agent-empty-no-submit"
    )),
    "relay-host did not acknowledge the empty no-op",
  );
  const calls = readFileSync(join(harness.gateDir, "calls.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sendCalls = calls.filter(({ args }) => args[0] === "load-buffer");
  assert.equal(sendCalls.length, 1);
  const buffer = sendCalls[0].args[2];
  assert.match(buffer, /^tw-control-\d+-[0-9a-f-]+$/);
  assert.deepEqual(sendCalls[0].args, [
    "load-buffer", "-b", buffer, "-",
    ";", "paste-buffer", "-b", buffer, "-d", "-r", "-t", "$0:.0",
    ";", "send-keys", "-t", "$0:.0", "C-m",
  ]);
  const emptySubmitCalls = calls.filter(({ args }) => args[0] === "send-keys");
  assert.deepEqual(emptySubmitCalls.map(({ args }) => args), [[
    "send-keys", "-t", "$0:.0", "C-m",
  ]]);
  const inputs = readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(inputs, [{ args: sendCalls[0].args, input: "a;\nb" }]);

  writeFileSync(join(harness.gateDir, "close-load-buffer-stdin"), "");
  sendToHost(harness, {
    type: "send_agent_message",
    requestId: "agent-stdin-epipe",
    session: "local:agent-epipe",
    pane: 0,
    message: "x".repeat(512 * 1024),
    submit: true,
  });
  await waitFor(
    () => harness.brokerMessages.some(({ message }) => (
      message.type === "error" && message.requestId === "agent-stdin-epipe"
    )),
    "relay-host acknowledged a message whose tmux stdin closed early",
  );
  assert.equal(harness.brokerMessages.some(({ message }) => (
    message.type === "agent_message_sent" && message.requestId === "agent-stdin-epipe"
  )), false);
});

test("Relay v1 stays read-only while Feishu owns input and never replays rejected writes", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "feishu-owned");
  const observer = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "feishu-owned"),
    "observer stream did not open",
  );
  const requestControl = (input) => terminalControlApi.requestTerminalControl(input, {
    socketPath: harness.terminalControlSocket,
    autoStart: false,
  });
  const target = await requestControl({ type: "target.resolve", sessionName: "feishu-owned" });
  const held = await requestControl({
    type: "lease.acquire",
    controlTargetId: target.controlTargetId,
    owner: { kind: "feishu", instanceId: "feishu-binding:test-binding:test-daemon" },
  });
  const before = harness.brokerMessages.length;
  sendToHost(harness, {
    type: "send_agent_message",
    requestId: "owned-agent-message",
    session: "local:feishu-owned",
    pane: 0,
    message: "must-not-write",
    submit: true,
  });
  sendToHost(harness, {
    type: "terminal_input",
    streamId: STREAM_ID,
    data: "must-not-write-raw",
  });
  sendToHost(harness, {
    type: "resize",
    streamId: STREAM_ID,
    cols: 120,
    rows: 40,
  });
  await waitFor(
    () => {
      const errors = harness.brokerMessages.slice(before)
        .map(({ message }) => message)
        .filter(({ type }) => type === "error");
      return errors.some(({ requestId }) => requestId === "owned-agent-message")
        && errors.filter(({ streamId }) => streamId === STREAM_ID).length >= 2;
    },
    `ownership errors were not correlated on the frozen v1 wire; output:\n${harness.output()}`,
  );
  assert.equal(
    harness.brokerMessages.slice(before).some(({ message }) => (
      message.type === "agent_message_sent" && message.requestId === "owned-agent-message"
    )),
    false,
  );
  const callsBeforeRelease = readFileSync(join(harness.gateDir, "calls.ndjson"), "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(callsBeforeRelease.some(({ args }) => args[0] === "load-buffer"), false);
  assert.equal(callsBeforeRelease.some(({ args }) => args[0] === "resize-window"), false);

  observer.socket.send("output-still-readable");
  await waitFor(
    () => harness.brokerMessages.slice(before).some(({ message }) => (
      message.type === "terminal_data"
      && message.streamId === STREAM_ID
      && message.data.includes("output-still-readable")
    )),
    "ownership denial incorrectly closed the observer stream",
  );

  await requestControl({ type: "lease.release", lease: held.lease });
  await delay(100);
  assert.equal(existsSync(join(harness.gateDir, "tmux-inputs.ndjson")), false);
  sendToHost(harness, {
    type: "terminal_input",
    streamId: STREAM_ID,
    data: "new-explicit-input",
  });
  await waitFor(
    () => existsSync(join(harness.gateDir, "tmux-inputs.ndjson"))
      && readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8").includes("new-explicit-input"),
    "new explicit v1 input did not acquire ownership after Feishu released it",
  );
  const written = readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8");
  assert.equal(written.includes("must-not-write"), false);
});

test("pending input overflow finalizes a blocked opening without resurrection", async (t) => {
  const harness = await startHarness(t);
  const session = "pending-overflow";
  blockPaneResolution(harness, session);
  openTerminal(harness, session);
  await waitForBlockedResolution(harness, session);
  const beforeOverflow = harness.brokerMessages.length;
  const chunk = "p".repeat(64 * 1024);

  for (let index = 0; index < 5; index += 1) {
    sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: chunk });
  }
  await waitFor(
    () => {
      const messages = harness.brokerMessages.slice(beforeOverflow).map(({ message }) => message);
      return messages.some(({ type, streamId }) => type === "error" && streamId === STREAM_ID)
        && messages.some(({ type, streamId }) => type === "terminal_exit" && streamId === STREAM_ID);
    },
    "pending input overflow did not fail and finalize the opening stream",
  );

  releasePaneResolution(harness, session);
  await assertNoAdditionalLocalConnection(harness, 0);
  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: "must-not-reopen" });
  await assertNoAdditionalLocalConnection(harness, 0);
  const exits = harness.brokerMessages
    .slice(beforeOverflow)
    .map(({ message }) => message)
    .filter(({ type, streamId }) => type === "terminal_exit" && streamId === STREAM_ID);
  assert.equal(exits.length, 1);
});

test("local stream admission reserves eight slots and releases a closed slot", async (t) => {
  const harness = await startHarness(t);
  for (let index = 0; index < 8; index += 1) {
    openTerminal(harness, `local-cap-${index}`, `local-cap-stream-${index}`);
  }
  await waitFor(
    () => harness.localConnections.length === 8,
    "the first eight local streams did not open",
  );
  const beforeNinth = harness.brokerMessages.length;
  openTerminal(harness, "local-cap-rejected", "local-cap-stream-rejected");
  await waitFor(
    () => {
      const messages = harness.brokerMessages.slice(beforeNinth).map(({ message }) => message);
      return messages.some(({ type, streamId }) => type === "error" && streamId === "local-cap-stream-rejected")
        && messages.some(({ type, streamId }) => type === "terminal_exit" && streamId === "local-cap-stream-rejected");
    },
    "the ninth local stream was not rejected with a terminal lifecycle",
  );
  await assertNoAdditionalLocalConnection(harness, 8, 100);
  const rejectedExits = harness.brokerMessages
    .slice(beforeNinth)
    .map(({ message }) => message)
    .filter(({ type, streamId }) => type === "terminal_exit" && streamId === "local-cap-stream-rejected");
  assert.equal(rejectedExits.length, 1);

  const first = harness.localConnections.find(({ session }) => session === "local-cap-0");
  assert.ok(first);
  sendToHost(harness, { type: "close_terminal", streamId: "local-cap-stream-0" });
  await waitFor(
    () => first.socket.readyState === WebSocket.CLOSED,
    "closing a local stream did not release its backend connection",
  );
  openTerminal(harness, "local-cap-after-close", "local-cap-stream-after-close");
  await waitFor(
    () => harness.localConnections.some(({ session }) => session === "local-cap-after-close"),
    "a new local stream could not use the released slot",
  );
  assert.equal(harness.localConnections.length, 9);
});

test("blocked stream reservations remain bounded across carrier reconnects", async (t) => {
  const harness = await startHarness(t);
  const heldSessions = Array.from({ length: 8 }, (_, index) => `held-acquisition-${index}`);
  for (const [index, session] of heldSessions.entries()) {
    blockPaneResolution(harness, session);
    openTerminalAs(harness, CLIENT_ID, session, `held-stream-${index}`);
  }
  await Promise.all(heldSessions.map((session) => waitForBlockedResolution(harness, session)));

  const firstCarrier = harness.brokerConnections[0];
  assert.ok(firstCarrier);
  firstCarrier.socket.terminate();
  const replacement = await waitFor(
    () => harness.brokerConnections.find((connection, index) => (
      index > 0 && connection.messages.some(({ type }) => type === "host_ready")
    )),
    `relay-host did not reconnect with blocked acquisitions; output:\n${harness.output()}`,
  );

  const beforeRejected = replacement.messages.length;
  openTerminalAs(harness, "replacement-client", "blocked-by-old-acquisitions", "replacement-rejected");
  await waitFor(
    () => {
      const messages = replacement.messages.slice(beforeRejected);
      return messages.some(({ type, streamId }) => type === "error" && streamId === "replacement-rejected")
        && messages.some(({ type, streamId }) => type === "terminal_exit" && streamId === "replacement-rejected");
    },
    "a replacement carrier bypassed reservations held by old open tasks",
  );
  await assertNoAdditionalLocalConnection(harness, 0, 100);

  releasePaneResolution(harness, heldSessions[0]);
  await delay(100);
  openTerminalAs(harness, "replacement-client", "released-acquisition", "replacement-accepted");
  await waitFor(
    () => harness.localConnections.some(({ session }) => session === "released-acquisition"),
    "a physically released acquisition did not return its admission slot",
  );
  for (const session of heldSessions.slice(1)) releasePaneResolution(harness, session);
});

test("command admission remains bounded across clients and carrier reconnects", async (t) => {
  const harness = await startHarness(t);
  blockPaneResolution(harness, "default");
  for (let index = 0; index < 4; index += 1) {
    sendToHostAs(harness, "command-client-a", {
      type: "list_sessions",
      requestId: `command-a-${index}`,
    });
  }
  await waitFor(
    () => readdirSync(harness.gateDir).filter((name) => (
      name.startsWith("default.") && name.endsWith(".entered")
    )).length >= 4,
    "four commands from the first client did not enter the blocked backend",
  );
  const firstCarrier = harness.brokerConnections[0];
  assert.ok(firstCarrier);
  const beforePerClientReject = firstCarrier.messages.length;
  sendToHostAs(harness, "command-client-a", {
    type: "list_sessions",
    requestId: "command-a-rejected",
  });
  await waitFor(
    () => firstCarrier.messages.slice(beforePerClientReject).some((message) => (
      message.type === "error"
      && message.requestId === "command-a-rejected"
      && message.message === "too many in-flight relay commands for client"
    )),
    "the per-client command limit did not reject the fifth command",
  );

  for (let index = 0; index < 4; index += 1) {
    sendToHostAs(harness, "command-client-b", {
      type: "list_sessions",
      requestId: `command-b-${index}`,
    });
  }
  await waitFor(
    () => readdirSync(harness.gateDir).filter((name) => (
      name.startsWith("default.") && name.endsWith(".entered")
    )).length >= 8,
    "eight globally admitted commands did not enter the blocked backend",
  );

  firstCarrier.socket.terminate();
  const replacement = await waitFor(
    () => harness.brokerConnections.find((connection, index) => (
      index > 0 && connection.messages.some(({ type }) => type === "host_ready")
    )),
    `relay-host did not reconnect with blocked commands; output:\n${harness.output()}`,
  );
  const beforeGlobalReject = replacement.messages.length;
  sendToHostAs(harness, "command-client-c", {
    type: "create_terminal",
    requestId: "command-global-rejected",
    scopeId: "local",
    cwd: "/tmp/rejected-command",
  });
  await waitFor(
    () => replacement.messages.slice(beforeGlobalReject).some((message) => (
      message.type === "error"
      && message.requestId === "command-global-rejected"
      && message.message === "too many in-flight relay commands on host"
    )),
    "the replacement carrier bypassed the global command limit",
  );
  const twCallsBeforeRelease = readFileSync(join(harness.gateDir, "tw-calls.ndjson"), "utf8");
  assert.equal(twCallsBeforeRelease.includes("create-terminal"), false);

  releasePaneResolution(harness, "default");
  await delay(200);
  const beforeRecovery = replacement.messages.length;
  sendToHostAs(harness, "command-client-c", {
    type: "list_sessions",
    requestId: "command-after-release",
  });
  await waitFor(
    () => replacement.messages.slice(beforeRecovery).some((message) => (
      message.type === "sessions" && message.requestId === "command-after-release"
    )),
    "settled commands did not release their admission slots",
  );
});

test("SIGTERM aborts blocked admin commands before relay-host exits", async (t) => {
  const harness = await startHarness(t);
  blockPaneResolution(harness, "default");
  writeFileSync(join(harness.gateDir, "default.ignore-term"), "");
  writeFileSync(join(harness.gateDir, "default.spawn-grandchild"), "");
  sendToHost(harness, {
    type: "list_sessions",
    requestId: "shutdown-blocked-command",
  });
  await waitForBlockedResolution(harness, "default");
  const entered = readdirSync(harness.gateDir).find((name) => (
    name.startsWith("default.") && name.endsWith(".entered")
  ));
  assert.ok(entered);
  const backendPid = Number.parseInt(entered.split(".")[1], 10);
  assert.ok(Number.isSafeInteger(backendPid) && backendPid > 1);
  const descendantPid = Number.parseInt(
    await waitFor(
      () => existsSync(join(harness.gateDir, "default.descendant-pid"))
        && readFileSync(join(harness.gateDir, "default.descendant-pid"), "utf8"),
      "the blocked command did not publish its descendant pid",
    ),
    10,
  );
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);

  const exited = once(harness.child, "exit");
  harness.child.kill("SIGTERM");
  const [code, signal] = await Promise.race([
    exited,
    delay(2_500).then(() => assert.fail(
      `relay-host did not abort a blocked command during shutdown; output:\n${harness.output()}`,
    )),
  ]);
  assert.equal(code, 0);
  assert.equal(signal, null);
  await waitFor(
    () => {
      try {
        process.kill(backendPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    "the blocked command child survived relay-host shutdown",
  );
  await waitFor(
    () => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    "the blocked command descendant survived relay-host shutdown",
  );
});

test("terminal shutdown drains accepted mutations instead of aborting their RPC parent", async (t) => {
  for (const trigger of ["SIGTERM", "4002"]) {
    await t.test(trigger, async (t) => {
      const harness = await startHarness(t, { withStatusFile: trigger === "4002" });
      blockTwCommand(harness);
      sendToHost(harness, {
        type: "create_terminal",
        requestId: `drain-mutation-${trigger}`,
        scopeId: "local",
        cwd: `/tmp/drain-${trigger.toLowerCase()}`,
      });
      const entered = await waitForBlockedTwCommand(harness);
      const mutationPid = Number.parseInt(entered.split(".")[1], 10);
      assert.ok(Number.isSafeInteger(mutationPid) && mutationPid > 1);

      const exited = once(harness.child, "exit");
      if (trigger === "SIGTERM") {
        harness.child.kill("SIGTERM");
      } else {
        currentBrokerSocket(harness).close(4002, "host replaced");
      }
      await delay(150);
      assert.equal(
        harness.child.exitCode,
        null,
        `${trigger} exited relay-host before its accepted mutation settled`,
      );
      assert.doesNotThrow(() => process.kill(mutationPid, 0));
      const replacementStatus = trigger === "4002"
        ? { state: "connected", owner: "replacement", updatedAt: Date.now() }
        : undefined;
      if (replacementStatus) {
        writeFileSync(harness.statusFile, `${JSON.stringify(replacementStatus)}\n`);
      }

      releaseTwCommand(harness);
      if (trigger === "SIGTERM") {
        await waitFor(
          () => harness.brokerMessages.some(({ message }) => (
            message.type === "terminal_created"
            && message.requestId === `drain-mutation-${trigger}`
          )),
          `broker did not receive the accepted mutation ACK before SIGTERM exit; output:\n${harness.output()}`,
          1_800,
        );
      }
      const [code, signal] = await Promise.race([
        exited,
        delay(2_000).then(() => assert.fail(
          `relay-host did not exit after its ${trigger} mutation drained; output:\n${harness.output()}`,
        )),
      ]);
      assert.equal(code, 0);
      assert.equal(signal, null);
      await waitFor(
        () => {
          try {
            process.kill(mutationPid, 0);
            return false;
          } catch {
            return true;
          }
        },
        `${trigger} left the settled mutation parent alive`,
      );
      const calls = readFileSync(join(harness.gateDir, "tw-calls.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(calls.filter(({ args }) => args[1] === "create-terminal").length, 1);
      if (replacementStatus) {
        assert.deepEqual(
          JSON.parse(readFileSync(harness.statusFile, "utf8")),
          replacementStatus,
          "the superseded relay-host overwrote its replacement status",
        );
      }
    });
  }
});

test("rejecting a same-key replacement retires its previous generation once", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "same-key-live");
  const previous = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "same-key-live"),
    "the original same-key transport did not open",
  );
  const beforeRejected = harness.brokerMessages.length;
  openScopedTerminalAs(harness, CLIENT_ID, "missing-scope:invalid", STREAM_ID);
  await waitFor(
    () => {
      const messages = harness.brokerMessages.slice(beforeRejected).map(({ message }) => message);
      return messages.some(({ type, streamId }) => type === "error" && streamId === STREAM_ID)
        && messages.some(({ type, streamId }) => type === "terminal_exit" && streamId === STREAM_ID);
    },
    "the invalid replacement did not retire its previous generation",
  );
  await waitFor(
    () => previous.socket.readyState === WebSocket.CLOSED,
    "the rejected replacement left its previous transport alive",
  );
  const exits = harness.brokerMessages
    .slice(beforeRejected)
    .map(({ message }) => message)
    .filter(({ type, streamId }) => type === "terminal_exit" && streamId === STREAM_ID);
  assert.equal(exits.length, 1);

  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: "must-not-reopen" });
  await assertNoAdditionalLocalConnection(harness, 1);
});

test("local input bypasses the observer socket and remains on the controlled backend path", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "slow-local-input");
  const transport = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "slow-local-input"),
    "slow local backend did not open",
  );
  const beforeBurst = harness.brokerMessages.length;
  const chunk = "controlled-input";
  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: chunk });
  await waitFor(
    () => existsSync(join(harness.gateDir, "tmux-inputs.ndjson"))
      && readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8").includes(chunk),
    "controller did not write input to the tmux backend",
  );
  assert.equal(transport.received.includes(chunk), false);
  const lifecycleFailures = harness.brokerMessages
    .slice(beforeBurst)
    .map(({ message }) => message)
    .filter(({ type, streamId }) => streamId === STREAM_ID && (type === "error" || type === "terminal_exit"));
  assert.deepEqual(lifecycleFailures, []);
});

test("closing one observer route does not release another route's shared client ownership", async (t) => {
  const harness = await startHarness(t);
  openTerminalAs(harness, CLIENT_ID, "shared-target", "shared-stream-a");
  openTerminalAs(harness, CLIENT_ID, "shared-target", "shared-stream-b");
  await waitFor(
    () => harness.localConnections.filter(({ session }) => session === "shared-target").length === 2,
    "both observer routes did not open",
  );
  sendToHost(harness, { type: "terminal_input", streamId: "shared-stream-a", data: "first-route" });
  await waitFor(
    () => existsSync(join(harness.gateDir, "tmux-inputs.ndjson"))
      && readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8").includes("first-route"),
    "the first route did not acquire controlled input",
  );
  sendToHost(harness, { type: "close_terminal", streamId: "shared-stream-a" });
  sendToHost(harness, { type: "terminal_input", streamId: "shared-stream-b", data: "second-route" });
  await waitFor(
    () => readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8").includes("second-route"),
    "closing the first observer fenced the still-live route",
  );
});

test("remote resize signals do not make the following terminal input look closed", async (t) => {
  const harness = await startHarness(t, { remotePtySuccess: true });
  openScopedTerminalAs(harness, CLIENT_ID, "remote:resize-input", STREAM_ID);
  await waitFor(
    () => harness.brokerMessages.some(({ message }) => (
      message.type === "terminal_data"
      && message.streamId === STREAM_ID
      && message.data.includes("REMOTE_READY")
    )),
    "the real remote PTY wrapper did not start its fake ssh child",
  );
  const beforeInput = harness.brokerMessages.length;
  sendToHost(harness, { type: "resize", streamId: STREAM_ID, cols: 120, rows: 40 });
  sendToHost(harness, { type: "terminal_input", streamId: STREAM_ID, data: "after-resize" });
  await waitFor(
    () => existsSync(join(harness.gateDir, "remote-control-inputs.ndjson"))
      && readFileSync(join(harness.gateDir, "remote-control-inputs.ndjson"), "utf8")
        .trim().split("\n").filter(Boolean).length >= 2,
    "remote input and resize did not pass through terminal-control",
  );
  const controlled = readFileSync(join(harness.gateDir, "remote-control-inputs.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(controlled.some(({ type, cols, rows }) => type === "input.resize" && cols === 120 && rows === 40));
  assert.ok(controlled.some(({ type, dataBase64 }) => (
    type === "input.raw" && Buffer.from(dataBase64, "base64").toString("utf8") === "after-resize"
  )));
  const lifecycleFailures = harness.brokerMessages
    .slice(beforeInput)
    .map(({ message }) => message)
    .filter(({ type, streamId }) => (
      streamId === STREAM_ID && (type === "error" || type === "terminal_exit")
    ));
  assert.deepEqual(lifecycleFailures, []);

  const sshPid = Number.parseInt(
    readFileSync(join(harness.gateDir, "remote-ssh-pid"), "utf8"),
    10,
  );
  assert.ok(Number.isSafeInteger(sshPid) && sshPid > 1);
  const controlDir = await waitFor(
    () => readdirSync(tmpdir())
      .filter((name) => name.startsWith("tw-relay-stream-"))
      .map((name) => join(tmpdir(), name))
      .find((path) => (
        existsSync(join(path, "process-group"))
        && readFileSync(join(path, "process-group"), "utf8").trim() === String(sshPid)
      )),
    "the remote PTY wrapper did not publish its private process-group directory",
  );
  sendToHost(harness, { type: "close_terminal", streamId: STREAM_ID });
  await waitFor(
    () => {
      try {
        process.kill(sshPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    "the remote process-group escalation left an ssh descendant alive",
    4_000,
  );
  await waitFor(
    () => !existsSync(controlDir),
    "the remote process-group control directory survived stream teardown",
    4_000,
  );
});

test("oversized carrier frame closes the connection and relay-host reconnects", async (t) => {
  const harness = await startHarness(t);
  const first = harness.brokerConnections[0];
  assert.ok(first);
  first.socket.send(JSON.stringify({
    type: "terminal_input",
    clientId: CLIENT_ID,
    streamId: "oversized-carrier-stream",
    data: "c".repeat(1024 * 1024),
  }));

  const replacement = await waitFor(
    () => harness.brokerConnections.find((connection, index) => (
      index > 0 && connection.messages.some(({ type }) => type === "host_ready")
    )),
    `relay-host did not reconnect after an oversized carrier frame; output:\n${harness.output()}`,
  );
  assert.notEqual(first.closeCode, 1000);
  assert.equal(first.socket.readyState, WebSocket.CLOSED);
  assert.equal(replacement.socket.readyState, WebSocket.OPEN);
});

test("slow broker output closes the overloaded carrier and relay-host reconnects", async (t) => {
  const harness = await startHarness(t);
  openTerminal(harness, "slow-broker-output");
  const terminal = await waitFor(
    () => harness.localConnections.find(({ session }) => session === "slow-broker-output"),
    "local output source did not open",
  );
  const first = harness.brokerConnections[0];
  assert.ok(first);
  first.socket._socket.pause();
  const output = "o".repeat(256 * 1024);

  for (let index = 0; index < 40; index += 1) {
    terminal.socket.send(output);
    if (index % 4 === 3) {
      await delay(0);
      if (harness.brokerConnections.length > 1) break;
    }
  }
  const replacement = await waitFor(
    () => harness.brokerConnections.find((connection, index) => (
      index > 0 && connection.messages.some(({ type }) => type === "host_ready")
    )),
    `relay-host did not replace a slow output carrier; output:\n${harness.output()}`,
    5_000,
  );
  first.socket._socket.resume();
  await waitFor(
    () => first.socket.readyState === WebSocket.CLOSED,
    "the overloaded carrier did not close",
  );
  assert.equal(replacement.socket.readyState, WebSocket.OPEN);
  await waitFor(
    () => terminal.socket.readyState === WebSocket.CLOSED,
    "the old carrier left its local stream alive",
  );

  const replacementMessageStart = replacement.messages.length;
  sendToHost(harness, {
    type: "terminal_input",
    streamId: STREAM_ID,
    data: "must-not-survive-carrier",
  });
  await waitFor(
    () => replacement.messages.slice(replacementMessageStart).some((message) => (
      message.type === "error" && message.streamId === STREAM_ID
    )),
    "the replacement carrier retained the old stream route",
  );
  await assertNoAdditionalLocalConnection(harness, 1);
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
    () => existsSync(join(harness.gateDir, "tmux-inputs.ndjson"))
      && readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8").includes("input-for-b"),
    "old transport finalization removed or replaced the current stream",
  );
  assert.equal(replacement.received.includes("input-for-b"), false);
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
    () => existsSync(join(harness.gateDir, "tmux-inputs.ndjson"))
      && readFileSync(join(harness.gateDir, "tmux-inputs.ndjson"), "utf8").includes("after-failed-kill"),
    "failed kill removed the route or transport",
  );
  assert.equal(transport.received.includes("after-failed-kill"), false);
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
