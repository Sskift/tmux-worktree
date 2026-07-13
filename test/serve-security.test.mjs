import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

const root = new URL("../", import.meta.url);
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0);
  return port;
}

async function waitFor(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function httpRequest(port, path, { method = "GET", headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const body = [];
      res.on("data", (chunk) => body.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(body).toString("utf8") }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

function authBodyOfSize(size) {
  const prefix = '{"token":"wrong","padding":"';
  const suffix = '"}';
  assert.ok(size >= Buffer.byteLength(prefix + suffix));
  return prefix + "x".repeat(size - Buffer.byteLength(prefix + suffix)) + suffix;
}

function websocketClose(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    socket.once("error", reject);
  });
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function openedWebSocketClose(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

test("serve keeps tmux and Python identifiers in argv and fences authenticated input", async () => {
  const source = readFileSync(new URL("../src/serve.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bexecSync\b|function\s+sh\s*\(/);
  assert.match(source, /execFileSync\(tmux, args,/);

  const scriptStart = source.indexOf("const PTY_BRIDGE_SCRIPT = String.raw`");
  const scriptEnd = source.indexOf("\n`;", scriptStart);
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart);
  const bridgeScript = source.slice(scriptStart, scriptEnd);
  assert.match(bridgeScript, /tmux, session, mobile, pane_idx, resize_file = sys\.argv\[1:6\]/);
  assert.doesNotMatch(bridgeScript, /\$\{/);

  const spawnStart = source.indexOf('child = cpSpawn("python3"');
  const spawnEnd = source.indexOf("], {", spawnStart);
  const spawnArgs = source.slice(spawnStart, spawnEnd);
  assert.match(
    spawnArgs.replace(/\s+/g, ""),
    /\["-u","-c",PTY_BRIDGE_SCRIPT,tmux,sessionName,mobileId,paneIndex,resizeFile,$/,
  );
  assert.doesNotMatch(spawnArgs, /"--"/);

  const realPythonArgv = JSON.parse(execFileSync("python3", [
    "-c",
    "import json,sys; print(json.dumps(sys.argv))",
    "tmux-value",
    "session-value",
    "mobile-value",
    "2",
    "/tmp/resize-value",
  ], { encoding: "utf8" }));
  assert.deepEqual(realPythonArgv, [
    "-c",
    "tmux-value",
    "session-value",
    "mobile-value",
    "2",
    "/tmp/resize-value",
  ]);

  const testRoot = mkdtempSync(join(tmpdir(), "tw-serve-security-"));
  const home = join(testRoot, "home");
  const runtimeTmp = join(testRoot, "tmp");
  const tmuxLog = join(testRoot, "tmux.log");
  const fakeTmux = join(testRoot, "fake tmux ' executable");
  const token = "serve-security-token";
  const httpSentinel = `/tmp/tw-serve-http-${process.pid}`;
  const paneSentinel = `/tmp/tw-serve-pane-${process.pid}`;
  const sessionSentinel = `/tmp/tw-serve-session-${process.pid}`;
  for (const path of [httpSentinel, paneSentinel, sessionSentinel]) rmSync(path, { force: true });
  writeFileSync(fakeTmux, `#!/bin/sh
{
  printf 'CALL'
  for arg in "$@"; do printf '\\037%s' "$arg"; done
  printf '\\n'
} >> "$TW_TMUX_LOG"
if [ "$1" = "list-panes" ]; then
  if [ "$3" = "=missing" ]; then exit 1; fi
  if [ "$5" = "#{pane_index}" ]; then
    printf '0\\n2\\n'
  else
    printf '0\\03780\\03724\\037zsh\\037shell\\0371\\n'
  fi
elif [ "$1" = "display-message" ]; then
  printf '/safe/cwd\\n'
elif [ "$1" = "attach" ]; then
  sleep 30
fi
`, { mode: 0o700 });
  chmodSync(fakeTmux, 0o700);
  writeFileSync(tmuxLog, "");
  writeFileSync(join(testRoot, ".keep"), "");
  writeFileSync(join(testRoot, ".runtime-placeholder"), "");
  mkdirSync(home, { recursive: true });
  mkdirSync(runtimeTmp, { recursive: true });

  const port = await unusedPort();
  let stderr = "";
  const child = spawn(process.execPath, ["dist/cli.cjs", "serve", "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: runtimeTmp,
      TW_TOKEN: token,
      TW_TMUX: fakeTmux,
      TW_TMUX_LOG: tmuxLog,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const openedSockets = new Set();
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        return response.status === 200;
      } catch {
        if (child.exitCode !== null) assert.fail(`serve exited early: ${stderr}`);
        return false;
      }
    }, "serve did not become ready");

    const exactLimitBody = authBodyOfSize(4096);
    const exactLimit = await httpRequest(port, "/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      chunks: [exactLimitBody.slice(0, 2048), exactLimitBody.slice(2048)],
    });
    assert.equal(exactLimit.status, 401);

    const overLimitBody = authBodyOfSize(4097);
    const overLimit = await httpRequest(port, "/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      chunks: [overLimitBody.slice(0, 2000), overLimitBody.slice(2000)],
    });
    assert.equal(overLimit.status, 413);

    const authHeaders = { Authorization: `Bearer ${token}` };
    const malformedEncoding = await httpRequest(port, "/api/sessions/%ZZ/panes", { headers: authHeaders });
    assert.equal(malformedEncoding.status, 400);
    const malformedUrl = await httpRequest(port, "http://[", { headers: authHeaders });
    assert.equal(malformedUrl.status, 400);
    const controlSession = await httpRequest(port, "/api/sessions/%0A/panes", { headers: authHeaders });
    assert.equal(controlSession.status, 400);

    const hostileHttpSession = `x'; touch ${httpSentinel}; #`;
    const encodedHostileHttpSession = encodeURIComponent(hostileHttpSession);
    for (const [suffix, method] of [
      ["panes", "GET"],
      ["cwd", "GET"],
      ["cancel-copy-mode", "POST"],
    ]) {
      const response = await httpRequest(port, `/api/sessions/${encodedHostileHttpSession}/${suffix}`, {
        method,
        headers: authHeaders,
      });
      assert.equal(response.status, 200);
    }
    assert.equal(existsSync(httpSentinel), false);

    const hostilePane = `';__import__("pathlib").Path("${paneSentinel}").touch();#`;
    const paneRejected = await websocketClose(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=${encodeURIComponent(hostilePane)}&token=${encodeURIComponent(token)}`,
    );
    assert.equal(paneRejected.code, 4000);
    assert.equal(existsSync(paneSentinel), false);

    const missingTarget = await websocketClose(
      `ws://127.0.0.1:${port}/ws?session=missing&pane=0&token=${encodeURIComponent(token)}`,
    );
    assert.equal(missingTarget.code, 4004);
    const missingPane = await websocketClose(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=3&token=${encodeURIComponent(token)}`,
    );
    assert.equal(missingPane.code, 4004);
    assert.deepEqual(
      readdirSync(runtimeTmp).filter((name) => name.startsWith("tw-serve-resize-")),
      [],
    );

    const hostileSession = `\\';__import__("pathlib").Path("${sessionSentinel}").touch();#`;
    assert.ok(hostileSession.length <= 128);
    const ws = await openWebSocket(
      `ws://127.0.0.1:${port}/ws?session=${encodeURIComponent(hostileSession)}&pane=2&token=${encodeURIComponent(token)}`,
    );
    openedSockets.add(ws);
    await waitFor(
      () => readFileSync(tmuxLog, "utf8").includes(`\u001f${hostileSession}\u001f`),
      "real Python bridge did not pass the hostile session as one tmux argv",
    );
    assert.equal(existsSync(sessionSentinel), false);

    const resizeDirectory = await waitFor(() => {
      const entry = readdirSync(runtimeTmp).find((name) => name.startsWith("tw-serve-resize-"));
      return entry ? join(runtimeTmp, entry) : null;
    }, "private resize directory was not created");
    const resizeFile = join(resizeDirectory, "size");
    assert.equal(statSync(resizeDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(resizeFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(resizeFile, "utf8"), "80,24");

    for (const invalid of [
      { type: "resize", cols: "80", rows: 24 },
      { type: "resize", cols: 19, rows: 5 },
      { type: "resize", cols: 301, rows: 200 },
      { type: "resize", cols: 20.5, rows: 24 },
      { type: "resize", cols: 20, rows: 4 },
      { type: "resize", cols: 300, rows: 201 },
    ]) ws.send(JSON.stringify(invalid));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(readFileSync(resizeFile, "utf8"), "80,24");

    ws.send(JSON.stringify({ type: "resize", cols: 20, rows: 5 }));
    await waitFor(() => readFileSync(resizeFile, "utf8") === "20,5", "minimum resize was not applied");
    ws.send(JSON.stringify({ type: "resize", cols: 300, rows: 200 }));
    await waitFor(() => readFileSync(resizeFile, "utf8") === "300,200", "maximum resize was not applied");

    const alive = await httpRequest(port, "/api/sessions", { headers: authHeaders });
    assert.equal(alive.status, 200);

    const closed = new Promise((resolve) => ws.once("close", resolve));
    ws.close();
    await closed;
    openedSockets.delete(ws);
    await waitFor(() => !existsSync(resizeDirectory), "private resize directory was not cleaned");

    const longUrl = await httpRequest(port, `/${"x".repeat(8193)}`, { headers: authHeaders });
    assert.equal(longUrl.status, 400);

    const oversizedInputSocket = await openWebSocket(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=0&token=${encodeURIComponent(token)}`,
    );
    openedSockets.add(oversizedInputSocket);
    const oversizedInputClosed = openedWebSocketClose(oversizedInputSocket);
    oversizedInputSocket.send("x".repeat(256 * 1024 + 1));
    assert.equal((await oversizedInputClosed).code, 4009);
    openedSockets.delete(oversizedInputSocket);

    const backpressureSocket = await openWebSocket(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=0&token=${encodeURIComponent(token)}`,
    );
    openedSockets.add(backpressureSocket);
    const backpressureClosed = openedWebSocketClose(backpressureSocket);
    backpressureSocket.send("a".repeat(200 * 1024));
    backpressureSocket.send("b".repeat(200 * 1024));
    assert.equal((await backpressureClosed).code, 4009);
    openedSockets.delete(backpressureSocket);

    const maxPayloadSocket = await openWebSocket(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=0&token=${encodeURIComponent(token)}`,
    );
    openedSockets.add(maxPayloadSocket);
    const maxPayloadClosed = openedWebSocketClose(maxPayloadSocket);
    maxPayloadSocket.send(Buffer.alloc(1024 * 1024 + 1, 120));
    assert.equal((await maxPayloadClosed).code, 1009);
    openedSockets.delete(maxPayloadSocket);

    await waitFor(
      () => readdirSync(runtimeTmp).filter((name) => name.startsWith("tw-serve-resize-")).length === 0,
      "limited bridge resources were not cleaned",
    );

    const bridgeSockets = [];
    for (let index = 0; index < 8; index += 1) {
      const bridgeSocket = await openWebSocket(
        `ws://127.0.0.1:${port}/ws?session=safe&pane=0&token=${encodeURIComponent(token)}`,
      );
      bridgeSockets.push(bridgeSocket);
      openedSockets.add(bridgeSocket);
    }
    await waitFor(
      () => readdirSync(runtimeTmp).filter((name) => name.startsWith("tw-serve-resize-")).length === 8,
      "eight terminal bridges were not reserved",
    );
    const listPaneCallsBeforeLimit = readFileSync(tmuxLog, "utf8").split("\n")
      .filter((line) => line.startsWith("CALL\u001flist-panes\u001f")).length;
    const limitedSocket = await websocketClose(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=0&token=${encodeURIComponent(token)}`,
    );
    assert.equal(limitedSocket.code, 4008);
    const listPaneCallsAfterLimit = readFileSync(tmuxLog, "utf8").split("\n")
      .filter((line) => line.startsWith("CALL\u001flist-panes\u001f")).length;
    assert.equal(listPaneCallsAfterLimit, listPaneCallsBeforeLimit);

    const releasedSocket = bridgeSockets.shift();
    const releasedClosed = openedWebSocketClose(releasedSocket);
    releasedSocket.close();
    await releasedClosed;
    openedSockets.delete(releasedSocket);
    await waitFor(
      () => readdirSync(runtimeTmp).filter((name) => name.startsWith("tw-serve-resize-")).length === 7,
      "closing a bridge did not release its reservation",
    );
    const replacementSocket = await openWebSocket(
      `ws://127.0.0.1:${port}/ws?session=safe&pane=0&token=${encodeURIComponent(token)}`,
    );
    bridgeSockets.push(replacementSocket);
    openedSockets.add(replacementSocket);
    await waitFor(
      () => readdirSync(runtimeTmp).filter((name) => name.startsWith("tw-serve-resize-")).length === 8,
      "released bridge capacity was not reusable",
    );
    for (const bridgeSocket of bridgeSockets) {
      const bridgeClosed = openedWebSocketClose(bridgeSocket);
      bridgeSocket.close();
      await bridgeClosed;
      openedSockets.delete(bridgeSocket);
    }
    await waitFor(
      () => readdirSync(runtimeTmp).filter((name) => name.startsWith("tw-serve-resize-")).length === 0,
      "bridge reservation cleanup was not exact",
    );

    const aliveAfterLimits = await httpRequest(port, "/api/sessions", { headers: authHeaders });
    assert.equal(aliveAfterLimits.status, 200);

    const log = readFileSync(tmuxLog, "utf8");
    assert.ok(log.split("\n").filter((line) => line.includes(`\u001f=${hostileHttpSession}\u001f`)).length >= 3);
    assert.match(log, new RegExp(`CALL\\u001fnew-session\\u001f-d\\u001f-t\\u001f${hostileSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\u001f-s\\u001ftw-mobile-`));
    assert.equal(existsSync(httpSentinel), false);
    assert.equal(existsSync(paneSentinel), false);
    assert.equal(existsSync(sessionSentinel), false);
  } finally {
    for (const socket of openedSockets) socket.terminate();
    await stopChild(child);
    for (const path of [httpSentinel, paneSentinel, sessionSentinel]) rmSync(path, { force: true });
    rmSync(testRoot, { recursive: true, force: true });
  }
});
