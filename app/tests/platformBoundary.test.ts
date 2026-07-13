import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

test("only the Tauri transport imports Tauri packages", () => {
  const sourceRoot = resolve(new URL("../src", import.meta.url).pathname);
  const allowed = "platform/tauriBackend.ts";
  const offenders = sourceFiles(sourceRoot)
    .filter((path) => /["']@tauri-apps\//.test(readFileSync(path, "utf8")))
    .map((path) => relative(sourceRoot, path))
    .filter((path) => path !== allowed)
    .sort();

  assert.deepEqual(offenders, []);
});

test("Feishu Dashboard UI and Tauri bridge stay behind the product adapter and locked PTY seam", () => {
  const terminalDeck = readFileSync(
    new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url),
    "utf8",
  );
  const dashboardBackend = readFileSync(
    new URL("../src/platform/dashboardBackend.ts", import.meta.url),
    "utf8",
  );
  const tauriBridge = readFileSync(
    new URL("../src-tauri/src/features/feishu_bridge.rs", import.meta.url),
    "utf8",
  );
  const canonicalAdapter = readFileSync(
    new URL("../../src/canonicalTerminalControlClient.ts", import.meta.url),
    "utf8",
  );

  assert.match(terminalDeck, /dashboardBackend\.feishu\./);
  assert.doesNotMatch(terminalDeck, /transport\.invoke|["']terminal\.[a-z-]+/);
  assert.match(dashboardBackend, /feishu:\s*FeishuProductAdapter/);
  assert.match(tauriBridge, /with_pty_control/);
  assert.equal([...tauriBridge.matchAll(/with_pty_control\(/g)].length, 3);
  assert.match(tauriBridge, /current_dashboard_lease/);
  assert.match(tauriBridge, /adopt_dashboard_lease/);
  assert.match(tauriBridge, /clear_dashboard_lease_after_transfer_attempt/);
  assert.doesNotMatch(tauriBridge, /ADAPTER_PENDING|["']terminal\.[a-z-]+/);
  assert.match(canonicalAdapter, /from "\.\/terminalControl\/client\.js"/);
  assert.match(canonicalAdapter, /from "\.\/terminalControl\/protocol\.js"/);
  assert.match(canonicalAdapter, /from "\.\/terminalControl\/store\.js"/);
  assert.match(canonicalAdapter, /requestTerminalControl\(input,/);
  assert.match(canonicalAdapter, /return terminalControlSocketPath\(home\);/);
  assert.doesNotMatch(canonicalAdapter, /node:net|createConnection|randomUUID/);
});
