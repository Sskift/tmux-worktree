import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("GitStatusPanel periodically triggers project root fetches", () => {
  const source = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /PROJECT_FETCH_MS\s*=\s*5\s*\*\s*60_000/);
  assert.match(source, /dashboardBackend\.git\.fetchProjectRoots\(\)/);
  assert.match(source, /useVisibilityAwarePolling\(triggerProjectFetch, \{/);
  assert.match(source, /enabled: active/);
  assert.match(source, /visibleIntervalMs: PROJECT_FETCH_MS/);
  assert.match(source, /hiddenIntervalMs: HIDDEN_PROJECT_FETCH_MS/);
  assert.doesNotMatch(source, /setInterval\(/);
});

test("remote git status passes host identity through git commands", () => {
  const panel = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");
  const diff = readFileSync(new URL("../src/DiffViewer.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");

  assert.match(panel, /hostId\?: string \| null/);
  assert.match(panel, /dashboardBackend\.git\.status\(gitCwd, hostId\)/);
  assert.match(
    panel,
    /dashboardBackend\.git\.graph\([\s\S]*?gitCwd,[\s\S]*?selectedRefs: selectedGraphRefs,[\s\S]*?hostId,/,
  );
  assert.match(panel, /GRAPH_REFRESH_MS\s*=\s*30_000/);
  assert.match(panel, /<GitGraphView/);
  assert.match(diff, /dashboardBackend\.git\.diff\(cwd, filePath, hostId\)/);
  assert.match(
    backend,
    /status: \(cwd, hostId\) =>\s*transport\.invoke<GitStatus \| null>\("git_status", \{ cwd, hostId: hostId \?\? null \}\)/s,
  );
  assert.match(
    backend,
    /log: \(cwd, limit, hostId\) =>\s*transport\.invoke<GitCommit\[]>\("git_log", \{ cwd, limit, hostId: hostId \?\? null \}\)/s,
  );
  assert.match(
    backend,
    /graphRefs: \(cwd, hostId\) =>\s*transport\.invoke<GitGraphRefs>\("git_graph_refs", \{ cwd, hostId: hostId \?\? null \}\)/s,
  );
  assert.match(
    backend,
    /graph: \(cwd, query, hostId\) =>\s*transport\.invoke<GitGraphResponse>\("git_graph", \{[\s\S]*?cwd,[\s\S]*?query,[\s\S]*?hostId: hostId \?\? null/s,
  );
  assert.match(
    backend,
    /diff: \(cwd, path, hostId\) =>\s*transport\.invoke<string>\("git_diff", \{ cwd, path, hostId: hostId \?\? null \}\)/s,
  );
  assert.match(app, /hostId=\{selectedGitHostId\}/);
  assert.match(app, /active=\{inspectorOpen && \(/);
  assert.match(app, /const openGitDiff = useCallback/);
  assert.match(app, /setDiffFile\(\{ path, cwd, hostId: hostId \?\? null \}\)/);
  assert.match(app, /diffFile \? \(\s*<div className="dashboard-workspace__editor">/);
  assert.doesNotMatch(app, /setInspectorTab\("diff"\)/);
});

test("changed files use native buttons so keyboard activation opens the diff", () => {
  const source = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");
  const rowsStart = source.indexOf("status.files.map");
  const rowsEnd = source.indexOf("</button>", rowsStart);
  const rowSource = source.slice(rowsStart, rowsEnd);

  assert.ok(rowsStart >= 0 && rowsEnd > rowsStart);
  assert.match(rowSource, /<button/);
  assert.match(rowSource, /type="button"/);
  assert.match(rowSource, /aria-label=\{`Open diff for \$\{f\.path\}`\}/);
  assert.match(rowSource, /onFileClick\?\.\(f\.path, statusCwd, hostId \?\? null\)/);
  assert.doesNotMatch(rowSource, /role="button"|tabIndex=|onKeyDown=/);
});

test("Git view controls expose their selected state", () => {
  const source = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /className="git__tabs" role="group" aria-label="Git view"/);
  assert.match(source, /aria-pressed=\{tab === "files"\}/);
  assert.match(source, /aria-pressed=\{tab === "log"\}/);
});
