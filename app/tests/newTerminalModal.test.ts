import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "../src/latestRequestGate.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

test("new terminal modal supports host selection and ai command", () => {
  const modal = readFileSync(new URL("../src/NewTerminalModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /hosts:\s*HostConfig\[\]/);
  assert.match(modal, /selectedHost/);
  assert.match(modal, /ai command/i);
  assert.match(modal, /loadLastAiCmd/);
  assert.match(modal, /saveLastAiCmd/);
  assert.match(modal, /hostId/);
});

test("new terminal rejects a delayed home default after a source change or user edit", async () => {
  for (const replacement of [
    { path: "/remote/repo", label: "remote", source: "host-a" },
    { path: "/Users/me/custom", label: "custom", source: "local-edit" },
  ]) {
    const gate = createLatestRequestGate();
    const home = deferred<string>();
    const token = gate.issue(
      requestSourceKey("new-terminal-home-directory", "__local__"),
    );
    let path = "";
    let label = "";
    const publication = home.promise.then((directory) => {
      if (!gate.isCurrent(token)) return;
      path = `${directory}/Desktop`;
      label = "Desktop";
    });

    gate.invalidate();
    path = replacement.path;
    label = replacement.label;
    home.resolve("/Users/me");
    await publication;

    assert.deepEqual(
      { path, label },
      { path: replacement.path, label: replacement.label },
      replacement.source,
    );
  }
});

test("new terminal invalidates home-default publication from every editable source", () => {
  const modal = readFileSync(new URL("../src/NewTerminalModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /homeDefaultPublishGateRef = useRef\(createLatestRequestGate\(\)\)/);
  assert.match(modal, /const changeHost = \(hostId: string\) => \{\s*invalidatePendingHomeDefault\(\)/s);
  assert.match(modal, /onChange=\{\(e\) => \{\s*invalidatePendingHomeDefault\(\);\s*setPath/s);
  assert.match(modal, /onChange=\{\(e\) => \{\s*invalidatePendingHomeDefault\(\);\s*setLabel/s);
  assert.match(modal, /const browse = async \(\) => \{\s*invalidatePendingHomeDefault\(\)/s);
});

test("app creates persisted terminals through the host-aware command", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const deck = readFileSync(new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url), "utf8");
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
  assert.match(
    app,
    /restored\.map\(\(terminal\) =>\s*dashboardBackend\.terminals\.ensure\(\{\s*name: terminal\.tmuxName,/s,
  );
  assert.match(app, /aiCmd:\s*terminal\.aiCmd/);
  assert.match(deck, /function terminalSessionKey/);
  assert.match(app, /persistedKeys/);
});
