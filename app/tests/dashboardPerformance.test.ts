import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { readRendererImplementationTree } from "./helpers/rendererImplementationSource.ts";
import { readRustSourceTree } from "./rustSource.ts";

const renderer = readRendererImplementationTree();

const capturePaneHistorySignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?fn capture_pane_history\s*\(\s*name:\s*String,\s*lines:\s*Option<u16>,?\s*\)\s*->\s*Result<String,\s*String>\s*\{/m;
const listDashboardCatalogSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn list_dashboard_catalog\s*\(\s*\)\s*->\s*Result<DashboardCatalogSnapshot,\s*String>\s*\{/m;
const listLocalDashboardCatalogSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn list_local_dashboard_catalog\s*\(\s*\)\s*->\s*Result<DashboardCatalogSnapshot,\s*String>\s*\{/m;
const listSessionsSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn list_sessions\s*\(\s*\)\s*->\s*Result<Vec<Session>,\s*String>\s*\{/m;
const listTmuxTerminalsSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn list_tmux_terminals\s*\(\s*\)\s*->\s*Result<Vec<TmuxTerminal>,\s*String>\s*\{/m;
const hostStatusesSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn host_statuses\s*\(\s*state:\s*State<'_,\s*Arc<HostState>>,?\s*\)\s*->\s*Result<Vec<HostStatus>,\s*String>\s*\{/m;
const gitGraphRefsSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn git_graph_refs\s*\(\s*cwd:\s*String,\s*host_id:\s*Option<String>,?\s*\)\s*->\s*Result<GitGraphRefs,\s*String>\s*\{/m;
const gitFetchProjectRootsSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn git_fetch_project_roots\s*\(\s*state:\s*State<'_,\s*Arc<GitFetchState>>,?\s*\)\s*->\s*Result<\(\),\s*String>\s*\{/m;
const gitStatusSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn git_status\s*\(\s*cwd:\s*String,\s*host_id:\s*Option<String>,?\s*\)\s*->\s*Result<Option<GitStatus>,\s*String>\s*\{/m;
const gitDiffSignature = /^[ \t]*(?:pub\(crate\)[ \t]+)?async fn git_diff\s*\(\s*cwd:\s*String,\s*path:\s*String,\s*host_id:\s*Option<String>,?\s*\)\s*->\s*Result<String,\s*String>\s*\{/m;

test("dashboard refresh preserves state identity when polled data is unchanged", () => {
  const workspaceCatalog = readFileSync(
    new URL("../src/dashboard/hooks/useWorkspaceCatalog.ts", import.meta.url),
    "utf8",
  );
  assert.match(renderer, /function sameSessions\(/);
  assert.match(renderer, /function samePlainTerminals\(/);
  assert.match(renderer, /function sameSessionActivity\(/);
  assert.match(renderer, /function sameStringRecord\(/);
  assert.match(
    workspaceCatalog,
    /setSessionActivity\(\(previous\) =>\s*sameSessionActivity\(previous, publication\.sessionActivity\)\s*\? previous\s*: publication\.sessionActivity/s,
  );
  assert.match(
    workspaceCatalog,
    /setSessions\(\(previous\) =>\s*sameSessions\(previous, publication\.sessions\) \? previous : publication\.sessions/s,
  );
  assert.match(
    workspaceCatalog,
    /setDiscoveredTerminals\(\(previous\) =>\s*samePlainTerminals\(previous, publication\.discoveredTerminals\)\s*\? previous\s*: publication\.discoveredTerminals/s,
  );
  assert.match(renderer, /return sameStringArray\(previous, next\) \? previous : next;/);
  assert.match(renderer, /return sameStringRecord\(previous, next\) \? previous : next;/);
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
  assert.match(rust, capturePaneHistorySignature);
});

test("tauri polling commands run blocking tmux and ssh work off the main thread", () => {
  const rust = readRustSourceTree();

  assert.match(rust, listSessionsSignature);
  assert.match(rust, /spawn_blocking\(list_sessions_blocking\)/);
  assert.match(rust, listDashboardCatalogSignature);
  assert.match(rust, /spawn_blocking\(list_dashboard_catalog_blocking\)/);
  assert.match(rust, listLocalDashboardCatalogSignature);
  assert.match(rust, /spawn_blocking\(list_local_dashboard_catalog_blocking\)/);
  assert.match(rust, listTmuxTerminalsSignature);
  assert.match(rust, /spawn_blocking\(list_tmux_terminals_blocking\)/);
  assert.match(rust, hostStatusesSignature);
  assert.match(rust, /spawn_blocking\(move \|\| host_statuses_blocking\(state\)\)/);
  assert.match(rust, gitGraphRefsSignature);
  assert.match(rust, /spawn_blocking\(move \|\| git_graph_refs_for\(&cwd, host_id\.as_deref\(\)\)\)/);
  assert.match(rust, /async fn git_graph\([\s\S]*?\) -> Result<GitGraphResult, String> \{/);
  assert.match(rust, /spawn_blocking\(move \|\| git_graph_for\(&cwd, host_id\.as_deref\(\), query\)\)/);
  assert.match(rust, gitFetchProjectRootsSignature);
  assert.match(rust, /spawn_blocking\(move \|\| git_fetch_project_roots_blocking\(state\)\)/);
  assert.match(rust, gitStatusSignature);
  assert.match(rust, /spawn_blocking\(move \|\| git_status_for\(&cwd, host_id\.as_deref\(\)\)\)/);
  assert.match(rust, gitDiffSignature);
  assert.match(rust, /spawn_blocking\(move \|\| git_diff_for\(&cwd, &path, host_id\.as_deref\(\)\)\)/);
});

test("polling command characterization rejects broader Rust visibility", () => {
  const signatures = [
    [
      capturePaneHistorySignature,
      "fn capture_pane_history(name: String, lines: Option<u16>) -> Result<String, String> {",
    ],
    [
      listDashboardCatalogSignature,
      "async fn list_dashboard_catalog() -> Result<DashboardCatalogSnapshot, String> {",
    ],
    [
      listLocalDashboardCatalogSignature,
      "async fn list_local_dashboard_catalog() -> Result<DashboardCatalogSnapshot, String> {",
    ],
    [
      listSessionsSignature,
      "async fn list_sessions() -> Result<Vec<Session>, String> {",
    ],
    [
      listTmuxTerminalsSignature,
      "async fn list_tmux_terminals() -> Result<Vec<TmuxTerminal>, String> {",
    ],
    [
      hostStatusesSignature,
      "async fn host_statuses(state: State<'_, Arc<HostState>>) -> Result<Vec<HostStatus>, String> {",
    ],
    [
      gitGraphRefsSignature,
      "async fn git_graph_refs(cwd: String, host_id: Option<String>) -> Result<GitGraphRefs, String> {",
    ],
    [
      gitFetchProjectRootsSignature,
      "async fn git_fetch_project_roots(state: State<'_, Arc<GitFetchState>>) -> Result<(), String> {",
    ],
    [
      gitStatusSignature,
      "async fn git_status(cwd: String, host_id: Option<String>) -> Result<Option<GitStatus>, String> {",
    ],
    [
      gitDiffSignature,
      "async fn git_diff(cwd: String, path: String, host_id: Option<String>) -> Result<String, String> {",
    ],
  ] as const;

  for (const [pattern, privateSignature] of signatures) {
    assert.match(privateSignature, pattern);
    assert.match(`\tpub(crate) ${privateSignature}`, pattern);
    assert.doesNotMatch(`pub ${privateSignature}`, pattern);
    assert.doesNotMatch(`pub(super) ${privateSignature}`, pattern);
  }
});
