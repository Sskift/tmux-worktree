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

test("new terminal modal supports host selection and an optional ai command", () => {
  const modal = readFileSync(new URL("../src/NewTerminalModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /hosts:\s*HostConfig\[\]/);
  assert.match(modal, /selectedHost/);
  assert.match(modal, /ai command/i);
  assert.match(modal, /loadLastAiCmd/);
  assert.match(modal, /saveLastAiCmd/);
  assert.match(modal, /hostId/);
  assert.match(modal, /ai command \(optional\)/i);
  assert.doesNotMatch(modal, /ai command required/i);
  assert.match(modal, /disabled=\{busy \|\| !path\.trim\(\)\}/);
  assert.match(modal, /if \(ai\) saveLastAiCmd\(ai\)/);
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

test("persisted terminal restoration keeps host-aware runtime identity", () => {
  const restoration = readFileSync(
    new URL("../src/terminalPersistence.ts", import.meta.url),
    "utf8",
  );
  const identity = readFileSync(new URL("../src/dashboard/model/terminalIdentity.ts", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");

  assert.match(
    backend,
    /create: \(args\) => transport\.invoke<CreatedTerminal>\("create_terminal", \{ args \}\)/,
  );
  assert.match(
    restoration,
    /if \(terminal\.managed\) \{\s*try \{\s*return await backend\.sessions\.exists\(terminal\.tmuxName\) \? terminal : null/s,
  );
  assert.match(restoration, /backend\.terminals\.ensure\(\{\s*name: terminal\.tmuxName,/s);
  assert.match(restoration, /aiCmd:\s*terminal\.aiCmd \?\? ""/);
  assert.match(identity, /export function terminalSessionKey/);
  assert.match(
    restoration,
    /const restoredKeys = new Set\(restored\.map\(terminalSessionKey\)\)/,
  );
  assert.match(
    restoration,
    /\.\.\.current\.filter\(\(terminal\) => !restoredKeys\.has\(terminalSessionKey\(terminal\)\)\)/,
  );
});
