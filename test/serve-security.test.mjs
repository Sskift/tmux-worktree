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
import { networkInterfaces, tmpdir } from "node:os";
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

function httpRequest(port, path, {
  host = "127.0.0.1",
  method = "GET",
  headers = {},
  chunks = [],
} = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method, headers }, (res) => {
      const body = [];
      res.on("data", (chunk) => body.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(body).toString("utf8"),
      }));
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

function websocketClose(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    socket.once("error", reject);
  });
}

function openWebSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
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

function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("serve process did not exit"));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

function serveTokenTemporaryFiles(home) {
  return readdirSync(home).filter(
    (name) => name.startsWith(".tw-serve-token.") && name.endsWith(".tmp"),
  );
}

function spawnServe(port, home, token, extraEnv = {}, extraArgs = []) {
  const env = {
    ...process.env,
    TW_TERMINAL_CONTROL_AUTOSTART: "0",
    ...extraEnv,
    HOME: home,
    NODE_PATH: "",
  };
  if (token === undefined) delete env.TW_TOKEN;
  else env.TW_TOKEN = token;
  return spawn(
    process.execPath,
    ["dist/cli.cjs", "serve", "--port", String(port), ...extraArgs],
    {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

function sessionCookie(response) {
  const setCookie = response.headers["set-cookie"];
  assert.ok(Array.isArray(setCookie) && setCookie.length === 1);
  return { header: setCookie[0], cookie: setCookie[0].split(";", 1)[0] };
}

function lanIpv4Address() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

test("serve can bind only to loopback for the Dashboard Relay backend", async () => {
  const testRoot = mkdtempSync(join(tmpdir(), "tw-serve-loopback-"));
  const home = join(testRoot, "home");
  mkdirSync(home);
  const port = await unusedPort();
  const token = "loopback-dashboard-token";
  const child = spawnServe(port, home, token, {}, ["--host", "127.0.0.1"]);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    await waitFor(
      () => existsSync(join(home, ".tw-serve-token")),
      `loopback serve did not start: ${stderr}`,
    );
    assert.equal((await httpRequest(port, "/api/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    })).status, 200);

    const lanAddress = lanIpv4Address();
    assert.ok(lanAddress, "loopback bind test requires a non-loopback IPv4 address");
    await assert.rejects(
      httpRequest(port, "/api/sessions", {
        host: lanAddress,
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  } finally {
    await stopChild(child);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("serve publishes a high-entropy token atomically only after listen succeeds", async () => {
  const source = readFileSync(new URL("../src/serve.ts", import.meta.url), "utf8");
  assert.match(source, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(source, /\[\\0\\r\\n\]\/\.test\(configured\)/);
  assert.match(source, /openSync\(temporaryFile, "wx", 0o600\)/);
  assert.match(source, /fsyncSync\(fd\)[\s\S]*renameSync\(temporaryFile, tokenFile\)[\s\S]*chmodSync\(tokenFile, 0o600\)/);
  const runSource = source.slice(source.indexOf("export async function run()"));
  assert.ok(runSource.indexOf("await new Promise<void>") < runSource.indexOf("publishServeToken(tokenFile, token)"));

  const testRoot = mkdtempSync(join(tmpdir(), "tw-serve-token-"));
  try {
    const generatedHome = join(testRoot, "generated-home");
    mkdirSync(generatedHome);
    const generatedPort = await unusedPort();
    const generatedChild = spawnServe(generatedPort, generatedHome);
    let generatedStderr = "";
    generatedChild.stderr.on("data", (chunk) => { generatedStderr += chunk.toString("utf8"); });
    try {
      const tokenFile = join(generatedHome, ".tw-serve-token");
      const generatedToken = await waitFor(
        () => existsSync(tokenFile) && readFileSync(tokenFile, "utf8"),
        `default token was not published: ${generatedStderr}`,
      );
      assert.match(generatedToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(generatedToken, "base64url").length, 32);
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      assert.deepEqual(serveTokenTemporaryFiles(generatedHome), []);
      const authenticated = await httpRequest(generatedPort, "/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        chunks: [JSON.stringify({ token: generatedToken })],
      });
      assert.equal(authenticated.status, 200);
    } finally {
      await stopChild(generatedChild);
    }

    const compatibilityHome = join(testRoot, "compatibility-home");
    mkdirSync(compatibilityHome);
    const compatibilityTokenFile = join(compatibilityHome, ".tw-serve-token");
    writeFileSync(compatibilityTokenFile, "old-token", { mode: 0o644 });
    chmodSync(compatibilityTokenFile, 0o644);
    const compatibilityPort = await unusedPort();
    const compatibilityChild = spawnServe(compatibilityPort, compatibilityHome, "short");
    let compatibilityStderr = "";
    compatibilityChild.stderr.on("data", (chunk) => { compatibilityStderr += chunk.toString("utf8"); });
    try {
      await waitFor(
        () => existsSync(compatibilityTokenFile) && readFileSync(compatibilityTokenFile, "utf8") === "short",
        `configured token was not published: ${compatibilityStderr}`,
      );
      await waitFor(
        () => compatibilityStderr.includes("TW_TOKEN is shorter than 16 bytes"),
        "short configured token warning was not emitted",
      );
      assert.equal(statSync(compatibilityTokenFile).mode & 0o777, 0o600);
      assert.deepEqual(serveTokenTemporaryFiles(compatibilityHome), []);
    } finally {
      await stopChild(compatibilityChild);
    }

    const invalidHome = join(testRoot, "invalid-home");
    mkdirSync(invalidHome);
    const invalidChild = spawnServe(await unusedPort(), invalidHome, "bad\nvalue");
    let invalidStderr = "";
    invalidChild.stderr.on("data", (chunk) => { invalidStderr += chunk.toString("utf8"); });
    const invalidExit = await waitForChildExit(invalidChild);
    assert.notEqual(invalidExit.code, 0);
    assert.match(invalidStderr, /TW_TOKEN must not contain NUL, carriage return, or line feed/);
    assert.equal(existsSync(join(invalidHome, ".tw-serve-token")), false);

    const conflictHome = join(testRoot, "conflict-home");
    mkdirSync(conflictHome);
    const conflictTokenFile = join(conflictHome, ".tw-serve-token");
    writeFileSync(conflictTokenFile, "preserve-this-token", { mode: 0o644 });
    chmodSync(conflictTokenFile, 0o644);
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(0, "0.0.0.0", resolve));
    const blockerAddress = blocker.address();
    assert.ok(typeof blockerAddress === "object" && blockerAddress);
    const conflictChild = spawnServe(blockerAddress.port, conflictHome, "replacement-token");
    try {
      const conflictExit = await waitForChildExit(conflictChild);
      assert.notEqual(conflictExit.code, 0);
      assert.equal(readFileSync(conflictTokenFile, "utf8"), "preserve-this-token");
      assert.equal(statSync(conflictTokenFile).mode & 0o777, 0o644);
      assert.deepEqual(serveTokenTemporaryFiles(conflictHome), []);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
      await stopChild(conflictChild);
    }

    const cleanupHome = join(testRoot, "cleanup-home");
    mkdirSync(cleanupHome);
    mkdirSync(join(cleanupHome, ".tw-serve-token"));
    const cleanupChild = spawnServe(await unusedPort(), cleanupHome, "cleanup-token-value");
    const cleanupExit = await waitForChildExit(cleanupChild);
    assert.notEqual(cleanupExit.code, 0);
    assert.equal(statSync(join(cleanupHome, ".tw-serve-token")).isDirectory(), true);
    assert.deepEqual(serveTokenTemporaryFiles(cleanupHome), []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("serve browser sessions expire and retain only the 64 most recently used entries", async () => {
  const source = readFileSync(new URL("../src/serve.ts", import.meta.url), "utf8");
  const htmlStart = source.indexOf("const HTML =");
  const htmlEnd = source.indexOf("const PTY_BRIDGE_SCRIPT", htmlStart);
  assert.ok(htmlStart >= 0 && htmlEnd > htmlStart);
  const html = source.slice(htmlStart, htmlEnd);
  assert.doesNotMatch(html, /localStorage|authToken|[?&]token=/);
  assert.match(html, /opts\.credentials = "same-origin"/);
  assert.match(
    html.replace(/\s+/g, ""),
    /newWebSocket\(proto\+"\/\/"\+location\.host\+"\/ws\?session="\+encodeURIComponent\(name\)\+"&pane="\+paneIndex\)/,
  );
  assert.match(source, /const MAX_BROWSER_SESSIONS = 64/);
  assert.match(source, /const SESSION_COOKIE_MAX_AGE_SECONDS = 28_800/);
  assert.match(source, /timingSafeEqual\(secretDigest\(domain, candidate\), expectedDigest\)/);

  const testRoot = mkdtempSync(join(tmpdir(), "tw-serve-sessions-"));
  const home = join(testRoot, "home");
  const clockFile = join(testRoot, "clock");
  const clockPreload = join(testRoot, "clock.cjs");
  const token = "session-test-token";
  const initialNow = 1_800_000_000_000;
  mkdirSync(home);
  writeFileSync(clockFile, String(initialNow));
  writeFileSync(clockPreload, `const fs = require("node:fs");
Date.now = () => Number(fs.readFileSync(process.env.TW_TEST_CLOCK_FILE, "utf8"));
`);
  const port = await unusedPort();
  const child = spawnServe(port, home, token, {
    NODE_OPTIONS: `--require=${clockPreload}`,
    TW_TEST_CLOCK_FILE: clockFile,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    await waitFor(
      () => existsSync(join(home, ".tw-serve-token")),
      `session test serve did not become ready: ${stderr}`,
    );

    const issueSession = async () => {
      const response = await httpRequest(port, "/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        chunks: [JSON.stringify({ token })],
      });
      assert.equal(response.status, 200);
      return sessionCookie(response);
    };

    const sessions = [];
    for (let index = 0; index < 64; index += 1) sessions.push(await issueSession());
    assert.match(sessions[0].cookie, /^tw_session=[A-Za-z0-9_-]{43}$/);
    assert.match(
      sessions[0].header,
      /^tw_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/,
    );

    const touched = await httpRequest(port, "/api/terminals", {
      headers: { Cookie: sessions[0].cookie },
    });
    assert.equal(touched.status, 200);

    const newest = await issueSession();
    assert.equal((await httpRequest(port, "/api/terminals", {
      headers: { Cookie: sessions[0].cookie },
    })).status, 200);
    assert.equal((await httpRequest(port, "/api/terminals", {
      headers: { Cookie: sessions[1].cookie },
    })).status, 401);
    assert.equal((await httpRequest(port, "/api/terminals", {
      headers: { Cookie: newest.cookie },
    })).status, 200);

    writeFileSync(clockFile, String(initialNow + 28_800_000 + 1));
    assert.equal((await httpRequest(port, "/api/terminals", {
      headers: { Cookie: newest.cookie },
    })).status, 401);
  } finally {
    await stopChild(child);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

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
  if [ "$5" = "#{session_id}" ]; then printf '$0\\n'; else printf '/safe/cwd\\n'; fi
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
      TW_TERMINAL_CONTROL_AUTOSTART: "0",
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

    const cookieAuthResponse = await httpRequest(port, "/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      chunks: [JSON.stringify({ token })],
    });
    assert.equal(cookieAuthResponse.status, 200);
    const browserSession = sessionCookie(cookieAuthResponse);
    assert.match(
      browserSession.header,
      /^tw_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/,
    );
    assert.equal((await httpRequest(port, "/api/sessions", {
      headers: { Cookie: browserSession.cookie },
    })).status, 200);

    const websocketUrl = `ws://127.0.0.1:${port}/ws?session=safe&pane=0`;
    const missingOriginCookie = await websocketClose(websocketUrl, {
      headers: { Cookie: browserSession.cookie },
    });
    assert.equal(missingOriginCookie.code, 4001);
    const wrongOriginCookie = await websocketClose(websocketUrl, {
      headers: { Cookie: browserSession.cookie, Origin: "https://attacker.invalid" },
    });
    assert.equal(wrongOriginCookie.code, 4001);
    const cookieSocket = await openWebSocket(websocketUrl, {
      headers: {
        Cookie: browserSession.cookie,
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    openedSockets.add(cookieSocket);
    const cookieSocketClosed = openedWebSocketClose(cookieSocket);
    cookieSocket.close();
    await cookieSocketClosed;
    openedSockets.delete(cookieSocket);

    const bearerSocket = await openWebSocket(websocketUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    openedSockets.add(bearerSocket);
    const bearerSocketClosed = openedWebSocketClose(bearerSocket);
    bearerSocket.close();
    await bearerSocketClosed;
    openedSockets.delete(bearerSocket);

    const loopbackQuery = await httpRequest(
      port,
      `/api/sessions?token=${encodeURIComponent(token)}`,
    );
    assert.equal(loopbackQuery.status, 200);
    const browserOriginQuery = await httpRequest(
      port,
      `/api/sessions?token=${encodeURIComponent(token)}`,
      { headers: { Origin: `http://127.0.0.1:${port}` } },
    );
    assert.equal(browserOriginQuery.status, 401);
    const lanAddress = lanIpv4Address();
    assert.ok(lanAddress, "serve security test requires a non-loopback IPv4 address");
    const lanQuery = await httpRequest(
      port,
      `/api/sessions?token=${encodeURIComponent(token)}`,
      { host: lanAddress },
    );
    assert.equal(lanQuery.status, 401);

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
    assert.equal(
      stderr.split("loopback query-token authentication is deprecated").length - 1,
      1,
    );
  } finally {
    for (const socket of openedSockets) socket.terminate();
    await stopChild(child);
    for (const path of [httpSentinel, paneSentinel, sessionSentinel]) rmSync(path, { force: true });
    rmSync(testRoot, { recursive: true, force: true });
  }
});
