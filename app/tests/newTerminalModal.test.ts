import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("new terminal modal supports host selection and ai command", () => {
  const modal = readFileSync(new URL("../src/NewTerminalModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /hosts:\s*HostConfig\[\]/);
  assert.match(modal, /selectedHost/);
  assert.match(modal, /ai command/i);
  assert.match(modal, /loadLastAiCmd/);
  assert.match(modal, /saveLastAiCmd/);
  assert.match(modal, /hostId/);
});

test("app creates persisted terminals through the host-aware command", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");

  assert.match(
    app,
    /dashboardBackend\.terminals\.create\(\{\s*cwd: draft\.cwd,\s*aiCmd: draft\.aiCmd,\s*hostId: draft\.hostId \?\? null,\s*\}\)/s,
  );
  assert.match(
    backend,
    /create: \(args\) => transport\.invoke<CreatedTerminal>\("create_terminal", \{ args \}\)/,
  );
  assert.doesNotMatch(backend, /"create_plain_terminal"/);
  assert.match(app, /dashboardBackend\.terminals\.ensure\(\{\s*name: t\.tmuxName,/s);
  assert.match(app, /aiCmd:\s*t\.aiCmd/);
  assert.match(app, /function terminalSessionKey/);
  assert.match(app, /persistedKeys/);
});
