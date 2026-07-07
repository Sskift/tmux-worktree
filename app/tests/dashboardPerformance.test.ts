import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("dashboard refresh preserves state identity when polled data is unchanged", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /function sameSessions\(/);
  assert.match(app, /function samePlainTerminals\(/);
  assert.match(app, /function sameSessionActivity\(/);
  assert.match(app, /function sameStringRecord\(/);
  assert.match(app, /setSessionActivity\(\(prev\) => sameSessionActivity\(prev, nextActivityInfo\) \? prev : nextActivityInfo\)/);
  assert.match(app, /setSessions\(\(prev\) => sameSessions\(prev, list\) \? prev : list\)/);
  assert.match(app, /setDiscoveredTerminals\(\(prev\) => samePlainTerminals\(prev, nextDiscoveredTerminals\) \? prev : nextDiscoveredTerminals\)/);
  assert.match(app, /return sameStringArray\(prev, next\) \? prev : next;/);
  assert.match(app, /return sameStringRecord\(prev, next\) \? prev : next;/);
});

test("dashboard preloads tmux snapshots without live-mounting every terminal", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const terminal = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(app, /const PRELOAD_HISTORY_LINES = 300;/);
  assert.match(app, /const \[tmuxPreviews, setTmuxPreviews\]/);
  assert.match(app, /invoke<string>\("capture_pane_history", \{\s*name,\s*lines: PRELOAD_HISTORY_LINES,\s*\}\)/s);
  assert.match(app, /initialHistory=\{tmuxPreviews\[name\]\}/);
  assert.match(app, /initialHistory=\{tmuxPreviews\[sessionKey\]\}/);
  assert.match(app, /if \(selection\?\.kind !== "session"\) return;/);
  assert.match(app, /if \(selection\?\.kind !== "terminal"\) return;/);
  assert.doesNotMatch(app, /mergeOpenedItems/);
  assert.match(terminal, /initialHistory\?: string;/);
  assert.match(terminal, /const cachedHistory = initialHistoryRef\.current;/);
  assert.match(rust, /fn capture_pane_history\(name: String, lines: Option<u16>\) -> Result<String, String>/);
});

test("tauri polling commands run blocking tmux and ssh work off the main thread", () => {
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(rust, /async fn list_sessions\(\) -> Result<Vec<Session>, String> \{/);
  assert.match(rust, /spawn_blocking\(list_sessions_blocking\)/);
  assert.match(rust, /async fn list_tmux_terminals\(\) -> Result<Vec<TmuxTerminal>, String> \{/);
  assert.match(rust, /spawn_blocking\(list_tmux_terminals_blocking\)/);
  assert.match(rust, /async fn host_statuses\(state: State<'_, Arc<HostState>>\) -> Result<Vec<HostStatus>, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| host_statuses_blocking\(state\)\)/);
});
