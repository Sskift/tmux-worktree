import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { readRendererImplementationTree } from "./helpers/rendererImplementationSource.ts";
import { readRustSourceTree } from "./rustSource.ts";

const renderer = readRendererImplementationTree();

test("dashboard refresh preserves state identity when polled data is unchanged", () => {
  assert.match(renderer, /function sameSessions\(/);
  assert.match(renderer, /function samePlainTerminals\(/);
  assert.match(renderer, /function sameSessionActivity\(/);
  assert.match(renderer, /function sameStringRecord\(/);
  assert.match(renderer, /setSessionActivity\(\(prev\) => sameSessionActivity\(prev, nextActivityInfo\) \? prev : nextActivityInfo\)/);
  assert.match(renderer, /setSessions\(\(prev\) => sameSessions\(prev, list\) \? prev : list\)/);
  assert.match(renderer, /setDiscoveredTerminals\(\(prev\) => samePlainTerminals\(prev, nextDiscoveredTerminals\) \? prev : nextDiscoveredTerminals\)/);
  assert.match(renderer, /return sameStringArray\(prev, next\) \? prev : next;/);
  assert.match(renderer, /return sameStringRecord\(prev, next\) \? prev : next;/);
});

test("dashboard preloads tmux snapshots without live-mounting every terminal", () => {
  const deck = readFileSync(new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url), "utf8");
  const terminal = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");
  const rust = readRustSourceTree();

  assert.match(renderer, /const PRELOAD_HISTORY_LINES = 300;/);
  assert.match(renderer, /const \[tmuxPreviews, setTmuxPreviews\]/);
  assert.match(renderer, /dashboardBackend\.sessions\s*\.captureHistory\(name, PRELOAD_HISTORY_LINES\)/s);
  assert.match(
    backend,
    /captureHistory: \(name, lines\) =>\s*transport\.invoke<string>\("capture_pane_history", \{ name, lines \}\)/s,
  );
  assert.match(deck, /initialHistory=\{tmuxPreviews\[name\]\}/);
  assert.match(deck, /initialHistory=\{tmuxPreviews\[sessionKey\]\}/);
  assert.match(renderer, /if \(selection\?\.kind !== "session"\) return;/);
  assert.match(renderer, /if \(selection\?\.kind !== "terminal"\) return;/);
  assert.doesNotMatch(renderer, /mergeOpenedItems/);
  assert.match(terminal, /initialHistory\?: string;/);
  assert.match(terminal, /const cachedHistory = initialHistoryRef\.current;/);
  assert.match(rust, /fn capture_pane_history\(name: String, lines: Option<u16>\) -> Result<String, String>/);
});

test("tauri polling commands run blocking tmux and ssh work off the main thread", () => {
  const rust = readRustSourceTree();

  assert.match(rust, /async fn list_sessions\(\) -> Result<Vec<Session>, String> \{/);
  assert.match(rust, /spawn_blocking\(list_sessions_blocking\)/);
  assert.match(rust, /async fn list_local_dashboard_catalog\(\) -> Result<DashboardCatalogSnapshot, String> \{/);
  assert.match(rust, /spawn_blocking\(list_local_dashboard_catalog_blocking\)/);
  assert.match(rust, /async fn list_tmux_terminals\(\) -> Result<Vec<TmuxTerminal>, String> \{/);
  assert.match(rust, /spawn_blocking\(list_tmux_terminals_blocking\)/);
  assert.match(rust, /async fn host_statuses\(state: State<'_, Arc<HostState>>\) -> Result<Vec<HostStatus>, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| host_statuses_blocking\(state\)\)/);
  assert.match(rust, /async fn git_graph_refs\(cwd: String, host_id: Option<String>\) -> Result<GitGraphRefs, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| git_graph_refs_for\(&cwd, host_id\.as_deref\(\)\)\)/);
  assert.match(rust, /async fn git_graph\([\s\S]*?\) -> Result<GitGraphResult, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| git_graph_for\(&cwd, host_id\.as_deref\(\), query\)\)/);
  assert.match(rust, /async fn git_fetch_project_roots\(state: State<'_, Arc<GitFetchState>>\) -> Result<\(\), String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| git_fetch_project_roots_blocking\(state\)\)/);
  assert.match(rust, /async fn git_status\(cwd: String, host_id: Option<String>\) -> Result<Option<GitStatus>, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| git_status_for\(&cwd, host_id\.as_deref\(\)\)\)/);
  assert.match(rust, /async fn git_diff\(cwd: String, path: String, host_id: Option<String>\) -> Result<String, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| git_diff_for\(&cwd, &path, host_id\.as_deref\(\)\)\)/);
});
