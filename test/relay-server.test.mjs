import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

test("relay server keeps detailed host state behind authentication", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0);

  const secret = "relay-health-test-secret";
  const child = spawn(process.execPath, [
    "dist/cli.js",
    "relay-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    env: { ...process.env, TW_RELAY_SECRET: secret },
    stdio: "ignore",
  });

  try {
    const deadline = Date.now() + 4000;
    let healthResponse;
    while (Date.now() < deadline) {
      try {
        healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
        if (healthResponse.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await healthResponse?.json(), { ok: true });

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/hosts`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`http://127.0.0.1:${port}/api/hosts`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { ok: true, hosts: [] });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
