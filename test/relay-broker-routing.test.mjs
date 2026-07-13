import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const MESSAGE_TIMEOUT_MS = 2_000;
let barrierSequence = 0;

function runRelayServerCli(args, { secret } = {}) {
  const { TW_RELAY_SECRET: _discardedSecret, ...cleanEnv } = process.env;
  return spawnSync(process.execPath, ["dist/cli.cjs", "relay-server", ...args], {
    encoding: "utf8",
    env: secret === undefined
      ? cleanEnv
      : { ...cleanEnv, TW_RELAY_SECRET: secret },
  });
}

async function unusedLoopbackPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  assert.ok(port > 0);
  return port;
}

async function startRelayServer(secret) {
  const port = await unusedLoopbackPort();
  const output = [];
  const child = spawn(process.execPath, [
    "dist/cli.cjs",
    "relay-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    env: { ...process.env, TW_RELAY_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`relay-server exited before becoming ready (${child.exitCode}):\n${output.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, port, output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stopRelayServer(child);
  throw new Error(`relay-server did not become ready:\n${output.join("")}`);
}

async function stopRelayServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function expectWebSocketRejected(url, options) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(reject, new Error(`WebSocket rejection timed out for ${url}`));
    }, MESSAGE_TIMEOUT_MS);
    socket.on("error", () => finish(resolve));
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      finish(resolve);
    });
    socket.on("close", () => finish(resolve));
    socket.on("open", () => {
      socket.terminate();
      finish(reject, new Error(`unexpectedly opened WebSocket ${url}`));
    });
  });
}

class SocketInbox {
  constructor(url, options) {
    this.socket = new WebSocket(url, options);
    this.messages = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      this.socket.once("close", (code, reason) => resolve({
        code,
        reason: reason.toString("utf8"),
      }));
    });
    this.socket.on("message", (raw) => {
      const text = raw.toString("utf8");
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(text);
      else this.messages.push(text);
    });
    this.socket.on("error", () => {});
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return this;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        this.socket.once("error", () => {});
        this.socket.terminate();
        cleanup();
        reject(new Error(`timed out opening WebSocket after ${MESSAGE_TIMEOUT_MS}ms`));
      }, MESSAGE_TIMEOUT_MS);
      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
    });
    return this;
  }

  sendJson(message) {
    this.socket.send(JSON.stringify(message));
  }

  async barrier(timeoutMs = MESSAGE_TIMEOUT_MS) {
    const marker = `relay-test-barrier-${++barrierSequence}`;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("pong", onPong);
        this.socket.off("close", onClose);
        this.socket.off("error", onError);
      };
      const onPong = (payload) => {
        if (payload.toString("utf8") !== marker) return;
        cleanup();
        resolve();
      };
      const onClose = (code, reason) => {
        cleanup();
        reject(new Error(`WebSocket closed before barrier pong (${code}: ${reason.toString("utf8")})`));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for WebSocket barrier after ${timeoutMs}ms`));
      }, timeoutMs);
      this.socket.on("pong", onPong);
      this.socket.once("close", onClose);
      this.socket.once("error", onError);
      try {
        this.socket.ping(marker);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  pauseIncoming() {
    this.socket.pause();
  }

  resumeIncoming() {
    this.socket.resume();
  }

  nextRaw(timeoutMs = MESSAGE_TIMEOUT_MS) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  async nextJson(timeoutMs = MESSAGE_TIMEOUT_MS) {
    return JSON.parse(await this.nextRaw(timeoutMs));
  }

  async expectNoMessage(timeoutMs = 150) {
    assert.equal(this.messages.length, 0, `unexpected queued message: ${this.messages[0]}`);
    await new Promise((resolve, reject) => {
      const waiter = {
        resolve: (message) => reject(new Error(`unexpected WebSocket message: ${message}`)),
      };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, timeoutMs);
      waiter.resolve = (message) => {
        clearTimeout(timer);
        reject(new Error(`unexpected WebSocket message: ${message}`));
      };
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const timer = setTimeout(() => this.socket.terminate(), 1_000);
    this.socket.close();
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }

  waitClosed() {
    return this.closed;
  }

  expectClosed(timeoutMs = MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for WebSocket close after ${timeoutMs}ms`));
      }, timeoutMs);
      this.closed.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  terminate() {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

test("relay-server CLI keeps its v1 option and error contract", () => {
  const help = runRelayServerCli(["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.signal, null);
  assert.equal(help.stderr, "");
  assert.equal(help.stdout, `tw relay-server — experimental remote relay

用法:
  TW_RELAY_SECRET=<secret> tw relay-server [--host 0.0.0.0] [--port 8787]

说明:
  relay-server 跑在一台稳定可达的 broker 机器上，只负责转发已鉴权 host 和 client 的 WebSocket 消息。
  Dashboard 所在机器运行 tw relay-host 主动连接 relay，不需要把本机端口暴露到公网。
`);

  for (const scenario of [
    {
      name: "missing secret",
      args: [],
      stderr: "错误: relay-server 需要 --secret 或 TW_RELAY_SECRET，避免暴露未鉴权的终端转发服务\n",
    },
    {
      name: "invalid port",
      args: ["--port", "0"],
      secret: "option-test-secret",
      stderr: "错误: 无效端口: 0\n",
    },
    {
      name: "unknown argument",
      args: ["--wat"],
      secret: "option-test-secret",
      stderr: "错误: 未知 relay-server 参数: --wat\n",
    },
  ]) {
    const result = runRelayServerCli(scenario.args, { secret: scenario.secret });
    assert.equal(result.status, 1, `${scenario.name} status`);
    assert.equal(result.signal, null, `${scenario.name} signal`);
    assert.equal(result.stdout, "", `${scenario.name} stdout`);
    assert.equal(result.stderr, scenario.stderr, `${scenario.name} stderr`);
  }
});

test("relay v1 broker preserves authentication, routing, and stream teardown semantics", async () => {
  const secret = "relay-routing-test-secret";
  const hostId = "routing-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseHttp = `http://127.0.0.1:${port}`;
    const baseWs = `ws://127.0.0.1:${port}`;

    await expectWebSocketRejected(
      `${baseWs}/not-a-relay-path?secret=${encodeURIComponent(secret)}`,
    );
    await expectWebSocketRejected(
      `${baseWs}/client?secret=${encodeURIComponent(secret)}`,
      { headers: { Authorization: "Bearer wrong-bearer-secret" } },
    );

    const queryAuth = await fetch(`${baseHttp}/api/hosts?secret=${encodeURIComponent(secret)}`);
    assert.equal(queryAuth.status, 200);
    assert.deepEqual(await queryAuth.json(), { ok: true, hosts: [] });

    const bearerAuth = await fetch(`${baseHttp}/api/hosts?secret=wrong-query-secret`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(bearerAuth.status, 200);

    const bearerWins = await fetch(`${baseHttp}/api/hosts?secret=${encodeURIComponent(secret)}`, {
      headers: { Authorization: "Bearer wrong-bearer-secret" },
    });
    assert.equal(bearerWins.status, 401);
    assert.deepEqual(await bearerWins.json(), { ok: false, error: "unauthorized" });

    const host = new SocketInbox(
      `${baseWs}/host?hostId=${hostId}&secret=wrong-query-secret`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    sockets.push(host);
    await host.open();
    assert.deepEqual(await host.nextJson(), { type: "host_registered", hostId });
    host.sendJson({ type: "host_ready", hostId, displayName: "Routing Host" });

    const client = new SocketInbox(
      `${baseWs}/client?hostId=${hostId}&secret=${encodeURIComponent(secret)}`,
    );
    sockets.push(client);
    await client.open();
    const ready = await client.nextJson();
    assert.equal(ready.type, "ready");
    assert.equal(ready.hostId, hostId);
    assert.match(ready.clientId, /^[0-9a-f-]{36}$/);

    client.sendJson({ type: "list_hosts", requestId: "hosts-1", ignoredByBroker: true });
    const hosts = await client.nextJson();
    assert.equal(hosts.type, "hosts");
    assert.equal(hosts.requestId, "hosts-1");
    assert.equal(hosts.hosts.length, 1);
    assert.deepEqual({
      hostId: hosts.hosts[0].hostId,
      displayName: hosts.hosts[0].displayName,
      clients: hosts.hosts[0].clients,
    }, {
      hostId,
      displayName: "Routing Host",
      clients: 1,
    });
    assert.equal(typeof hosts.hosts[0].connectedAt, "number");
    await host.expectNoMessage();

    const clientPayload = {
      type: "list_sessions",
      hostId,
      requestId: "sessions-1",
      futureClientField: { nested: ["kept", 7] },
    };
    client.sendJson(clientPayload);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...clientPayload, clientId: ready.clientId }),
      "broker must preserve client fields and append clientId last",
    );

    const hostPayload = {
      type: "sessions",
      clientId: ready.clientId,
      requestId: "sessions-1",
      sessions: [],
      futureHostField: { nested: true },
    };
    host.sendJson(hostPayload);
    const { clientId: _clientId, ...clientVisiblePayload } = hostPayload;
    assert.equal(
      await client.nextRaw(),
      JSON.stringify(clientVisiblePayload),
      "broker must remove only clientId from host replies",
    );

    await client.close();
    assert.deepEqual(await host.nextJson(), { type: "client_closed", clientId: ready.clientId });

    const streamClient = new SocketInbox(
      `${baseWs}/client?hostId=${hostId}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    sockets.push(streamClient);
    await streamClient.open();
    const streamReady = await streamClient.nextJson();
    assert.equal(streamReady.type, "ready");

    const openTerminal = {
      type: "open_terminal",
      streamId: "stream-tail",
      session: "tw-term-routing",
      pane: 2,
      futureOpenField: "preserved",
    };
    streamClient.sendJson(openTerminal);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...openTerminal, clientId: streamReady.clientId }),
    );

    await host.close();
    assert.deepEqual(await streamClient.nextJson(), {
      type: "error",
      streamId: "stream-tail",
      message: "host disconnected",
    });
    assert.deepEqual(await streamClient.nextJson(), {
      type: "terminal_exit",
      streamId: "stream-tail",
      code: 0,
    });
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 host replacement fences every old-host frame and retires its routes", async () => {
  const secret = "relay-replacement-test-secret";
  const hostId = "replacement-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseHttp = `http://127.0.0.1:${port}`;
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };

    const oldHost = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(oldHost);
    await oldHost.open();
    assert.deepEqual(await oldHost.nextJson(), { type: "host_registered", hostId });

    const client = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(client);
    await client.open();
    const ready = await client.nextJson();
    assert.equal(ready.type, "ready");

    const openTerminal = {
      type: "open_terminal",
      streamId: "stream-before-replacement",
      session: "tw-term-before-replacement",
    };
    client.sendJson(openTerminal);
    assert.equal(
      await oldHost.nextRaw(),
      JSON.stringify({ ...openTerminal, clientId: ready.clientId }),
    );

    // Keep H1's client side OPEN after the broker starts its replacement close.
    // This lets the test deterministically put stale application frames ahead of
    // H1's close reply instead of depending on scheduling between two sockets.
    oldHost.pauseIncoming();
    const newHost = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(newHost);
    await newHost.open();
    assert.deepEqual(await newHost.nextJson(), { type: "host_registered", hostId });
    newHost.sendJson({ type: "host_ready", hostId, displayName: "Winning H2" });
    await newHost.barrier();

    assert.deepEqual(await client.nextJson(), {
      type: "error",
      streamId: "stream-before-replacement",
      message: "host reconnected; terminal stream closed",
    });
    assert.deepEqual(await client.nextJson(), {
      type: "terminal_exit",
      streamId: "stream-before-replacement",
      code: 0,
    });

    oldHost.sendJson({ type: "host_ready", hostId, displayName: "Stale H1" });
    oldHost.sendJson({
      type: "sessions",
      clientId: ready.clientId,
      requestId: "stale-h1-sessions",
      sessions: [],
    });
    oldHost.sendJson({
      type: "terminal_data",
      clientId: ready.clientId,
      streamId: "stream-before-replacement",
      data: "stale H1 tail",
    });
    oldHost.sendJson({
      type: "terminal_exit",
      clientId: ready.clientId,
      streamId: "stream-before-replacement",
      code: 91,
    });
    oldHost.resumeIncoming();
    assert.deepEqual(await oldHost.waitClosed(), { code: 4002, reason: "host replaced" });
    await client.expectNoMessage();

    client.sendJson({
      type: "close_terminal",
      streamId: "stream-before-replacement",
    });
    const retiredClose = await client.nextJson();
    assert.equal(retiredClose.type, "error");
    assert.equal(retiredClose.streamId, "stream-before-replacement");
    await newHost.expectNoMessage();

    const authenticatedHosts = await fetch(`${baseHttp}/api/hosts`, auth);
    assert.equal(authenticatedHosts.status, 200);
    const hostCatalog = await authenticatedHosts.json();
    assert.equal(hostCatalog.hosts.length, 1);
    assert.equal(hostCatalog.hosts[0].hostId, hostId);
    assert.equal(hostCatalog.hosts[0].displayName, "Winning H2");

    const afterReplacement = {
      type: "list_sessions",
      requestId: "after-replacement",
    };
    client.sendJson(afterReplacement);
    assert.equal(
      await newHost.nextRaw(),
      JSON.stringify({ ...afterReplacement, clientId: ready.clientId }),
      "the old host close callback must not remove the replacement host",
    );
    newHost.sendJson({
      type: "sessions",
      clientId: ready.clientId,
      requestId: "after-replacement",
      sessions: [],
    });
    assert.deepEqual(await client.nextJson(), {
      type: "sessions",
      requestId: "after-replacement",
      sessions: [],
    });
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 stream ids are one-shot after a client closes them", async () => {
  const secret = "relay-client-close-tombstone-secret";
  const hostId = "client-close-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };
    const host = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(host);
    await host.open();
    assert.deepEqual(await host.nextJson(), { type: "host_registered", hostId });

    const client = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(client);
    await client.open();
    const ready = await client.nextJson();
    assert.equal(ready.type, "ready");

    const firstOpen = {
      type: "open_terminal",
      streamId: "client-closed-stream",
      session: "tw-term-first-generation",
    };
    client.sendJson(firstOpen);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...firstOpen, clientId: ready.clientId }),
    );

    client.sendJson({ type: "close_terminal", streamId: firstOpen.streamId });
    assert.deepEqual(await host.nextJson(), {
      type: "close_terminal",
      streamId: firstOpen.streamId,
      clientId: ready.clientId,
    });

    client.sendJson({
      type: "open_terminal",
      streamId: firstOpen.streamId,
      session: "tw-term-forbidden-reuse",
    });
    const reuseError = await client.nextJson();
    assert.equal(reuseError.type, "error");
    assert.equal(reuseError.streamId, firstOpen.streamId);
    await host.expectNoMessage();

    const freshOpen = {
      type: "open_terminal",
      streamId: "fresh-stream-after-close",
      session: "tw-term-fresh-generation",
    };
    client.sendJson(freshOpen);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...freshOpen, clientId: ready.clientId }),
      "rejecting streamId reuse must not disable fresh routes for the client",
    );
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 active routes deliver one data tail and one terminal exit before retirement", async () => {
  const secret = "relay-host-exit-tombstone-secret";
  const hostId = "host-exit-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };
    const host = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(host);
    await host.open();
    assert.deepEqual(await host.nextJson(), { type: "host_registered", hostId });

    const client = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(client);
    await client.open();
    const ready = await client.nextJson();
    assert.equal(ready.type, "ready");

    const openTerminal = {
      type: "open_terminal",
      streamId: "host-exited-stream",
      session: "tw-term-host-exit",
    };
    client.sendJson(openTerminal);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...openTerminal, clientId: ready.clientId }),
    );

    host.sendJson({
      type: "terminal_data",
      clientId: ready.clientId,
      streamId: openTerminal.streamId,
      data: "active route data",
    });
    host.sendJson({
      type: "terminal_exit",
      clientId: ready.clientId,
      streamId: openTerminal.streamId,
      code: 23,
    });
    host.sendJson({
      type: "terminal_data",
      clientId: ready.clientId,
      streamId: openTerminal.streamId,
      data: "late data after exit",
    });
    host.sendJson({
      type: "terminal_exit",
      clientId: ready.clientId,
      streamId: openTerminal.streamId,
      code: 24,
    });
    await host.barrier();

    assert.deepEqual(await client.nextJson(), {
      type: "terminal_data",
      streamId: openTerminal.streamId,
      data: "active route data",
    });
    assert.deepEqual(await client.nextJson(), {
      type: "terminal_exit",
      streamId: openTerminal.streamId,
      code: 23,
    });
    await client.expectNoMessage();

    client.sendJson({
      type: "open_terminal",
      streamId: openTerminal.streamId,
      session: "tw-term-forbidden-after-exit",
    });
    const reuseError = await client.nextJson();
    assert.equal(reuseError.type, "error");
    assert.equal(reuseError.streamId, openTerminal.streamId);
    await host.expectNoMessage();
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 rejects primitive and null frames without crashing or poisoning later routing", async () => {
  const secret = "relay-malformed-frame-secret";
  const hostId = "malformed-frame-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseHttp = `http://127.0.0.1:${port}`;
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };
    const host = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(host);
    await host.open();
    assert.deepEqual(await host.nextJson(), { type: "host_registered", hostId });

    const client = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(client);
    await client.open();
    const ready = await client.nextJson();
    assert.equal(ready.type, "ready");

    const malformedValues = [null, 0, false, "primitive", []];
    for (const value of malformedValues) host.sendJson(value);
    await host.barrier();

    for (const value of malformedValues) client.sendJson(value);
    await client.barrier();
    for (const _value of malformedValues) {
      const error = await client.nextJson();
      assert.equal(error.type, "error");
      assert.equal(typeof error.message, "string");
    }
    await host.expectNoMessage();

    const health = await fetch(`${baseHttp}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const validRequest = { type: "list_sessions", requestId: "after-malformed" };
    client.sendJson(validRequest);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...validRequest, clientId: ready.clientId }),
    );
    host.sendJson({
      type: "sessions",
      clientId: ready.clientId,
      requestId: validRequest.requestId,
      sessions: [],
    });
    assert.deepEqual(await client.nextJson(), {
      type: "sessions",
      requestId: validRequest.requestId,
      sessions: [],
    });
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 enforces a lifetime budget of 1024 accepted stream ids per client", async () => {
  const secret = "relay-stream-budget-secret";
  const hostId = "stream-budget-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };
    const host = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(host);
    await host.open();
    assert.deepEqual(await host.nextJson(), { type: "host_registered", hostId });

    const client = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(client);
    await client.open();
    const ready = await client.nextJson();
    assert.equal(ready.type, "ready");

    const streamIds = Array.from(
      { length: 1_024 },
      (_unused, index) => `lifetime-stream-${index}`,
    );
    for (const streamId of streamIds) {
      client.sendJson({
        type: "open_terminal",
        streamId,
        session: `tw-term-${streamId}`,
      });
      client.sendJson({ type: "close_terminal", streamId });
    }
    await client.barrier(10_000);
    await host.barrier(10_000);

    for (const streamId of streamIds) {
      assert.deepEqual(await host.nextJson(), {
        type: "open_terminal",
        streamId,
        session: `tw-term-${streamId}`,
        clientId: ready.clientId,
      });
      assert.deepEqual(await host.nextJson(), {
        type: "close_terminal",
        streamId,
        clientId: ready.clientId,
      });
    }

    client.sendJson({
      type: "open_terminal",
      streamId: streamIds[0],
      session: "tw-term-oldest-reuse",
    });
    await client.barrier();
    const oldestReuse = await client.nextJson();
    assert.equal(oldestReuse.type, "error");
    assert.equal(oldestReuse.streamId, streamIds[0]);
    await host.expectNoMessage();

    client.sendJson({
      type: "open_terminal",
      streamId: "lifetime-stream-over-budget",
      session: "tw-term-over-lifetime-budget",
    });
    await client.barrier();
    const budgetError = await client.nextJson(500);
    assert.equal(budgetError.type, "error");
    assert.equal(budgetError.streamId, "lifetime-stream-over-budget");
    await host.expectNoMessage();
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 closes oversized host and client frames while keeping the broker usable", async () => {
  const secret = "relay-oversized-frame-secret";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseHttp = `http://127.0.0.1:${port}`;
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };
    const oversizedHost = new SocketInbox(`${baseWs}/host?hostId=oversized-frame-host`, auth);
    sockets.push(oversizedHost);
    await oversizedHost.open();
    assert.deepEqual(await oversizedHost.nextJson(), {
      type: "host_registered",
      hostId: "oversized-frame-host",
    });

    const oversizedClient = new SocketInbox(`${baseWs}/client?hostId=oversized-frame-host`, auth);
    sockets.push(oversizedClient);
    await oversizedClient.open();
    assert.equal((await oversizedClient.nextJson()).type, "ready");

    const oversizedValue = "x".repeat(1024 * 1024);
    oversizedHost.sendJson(oversizedValue);
    oversizedClient.sendJson(oversizedValue);
    await Promise.all([
      oversizedHost.expectClosed(5_000),
      oversizedClient.expectClosed(5_000),
    ]);

    const health = await fetch(`${baseHttp}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const recoveryHostId = "oversized-frame-recovery-host";
    const recoveryHost = new SocketInbox(`${baseWs}/host?hostId=${recoveryHostId}`, auth);
    sockets.push(recoveryHost);
    await recoveryHost.open();
    assert.deepEqual(await recoveryHost.nextJson(), {
      type: "host_registered",
      hostId: recoveryHostId,
    });
    const recoveryClient = new SocketInbox(`${baseWs}/client?hostId=${recoveryHostId}`, auth);
    sockets.push(recoveryClient);
    await recoveryClient.open();
    const ready = await recoveryClient.nextJson();
    assert.equal(ready.type, "ready");

    const validRequest = { type: "list_sessions", requestId: "after-oversized-frames" };
    recoveryClient.sendJson(validRequest);
    assert.equal(
      await recoveryHost.nextRaw(),
      JSON.stringify({ ...validRequest, clientId: ready.clientId }),
    );
    recoveryHost.sendJson({
      type: "sessions",
      clientId: ready.clientId,
      requestId: validRequest.requestId,
      sessions: [],
    });
    assert.deepEqual(await recoveryClient.nextJson(), {
      type: "sessions",
      requestId: validRequest.requestId,
      sessions: [],
    });
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});

test("relay v1 disconnects a paused slow client without poisoning its host or replacements", async () => {
  const secret = "relay-slow-client-secret";
  const hostId = "slow-client-host";
  const { child, port, output } = await startRelayServer(secret);
  const sockets = [];

  try {
    const baseHttp = `http://127.0.0.1:${port}`;
    const baseWs = `ws://127.0.0.1:${port}`;
    const auth = { headers: { Authorization: `Bearer ${secret}` } };
    const host = new SocketInbox(`${baseWs}/host?hostId=${hostId}`, auth);
    sockets.push(host);
    await host.open();
    assert.deepEqual(await host.nextJson(), { type: "host_registered", hostId });

    const slowClient = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(slowClient);
    await slowClient.open();
    const slowReady = await slowClient.nextJson();
    assert.equal(slowReady.type, "ready");
    const openTerminal = {
      type: "open_terminal",
      streamId: "slow-client-stream",
      session: "tw-term-slow-client",
    };
    slowClient.sendJson(openTerminal);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...openTerminal, clientId: slowReady.clientId }),
    );

    slowClient.pauseIncoming();
    const chunk = "z".repeat(256 * 1024);
    for (let index = 0; index < 96; index += 1) {
      host.sendJson({
        type: "terminal_data",
        clientId: slowReady.clientId,
        streamId: openTerminal.streamId,
        data: chunk,
      });
    }
    await host.barrier(15_000);
    slowClient.resumeIncoming();
    await slowClient.expectClosed(5_000);

    assert.deepEqual(await host.nextJson(), {
      type: "client_closed",
      clientId: slowReady.clientId,
    });
    const health = await fetch(`${baseHttp}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const replacement = new SocketInbox(`${baseWs}/client?hostId=${hostId}`, auth);
    sockets.push(replacement);
    await replacement.open();
    const replacementReady = await replacement.nextJson();
    assert.equal(replacementReady.type, "ready");
    const validRequest = { type: "list_sessions", requestId: "after-slow-client" };
    replacement.sendJson(validRequest);
    assert.equal(
      await host.nextRaw(),
      JSON.stringify({ ...validRequest, clientId: replacementReady.clientId }),
    );
    host.sendJson({
      type: "sessions",
      clientId: replacementReady.clientId,
      requestId: validRequest.requestId,
      sessions: [],
    });
    assert.deepEqual(await replacement.nextJson(), {
      type: "sessions",
      requestId: validRequest.requestId,
      sessions: [],
    });
  } catch (error) {
    error.message += `\nrelay-server output:\n${output.join("")}`;
    throw error;
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopRelayServer(child);
  }
});
