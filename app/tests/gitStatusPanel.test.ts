import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("GitStatusPanel periodically triggers project root fetches", () => {
  const source = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /PROJECT_FETCH_MS\s*=\s*5\s*\*\s*60_000/);
  assert.match(source, /invoke<[^>]+>\("git_fetch_project_roots"\)/);
  assert.match(source, /setInterval\(triggerProjectFetch,\s*PROJECT_FETCH_MS\)/);
});

test("remote git status passes host identity through git commands", () => {
  const panel = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");
  const diff = readFileSync(new URL("../src/DiffViewer.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(panel, /hostId\?: string \| null/);
  assert.match(panel, /invoke<GitStatus \| null>\("git_status", \{ cwd: gitCwd, hostId: hostId \?\? null \}\)/);
  assert.match(panel, /invoke<GitCommit\[\]>\("git_log", \{ cwd: gitCwd, limit: 100, hostId: hostId \?\? null \}\)/);
  assert.match(diff, /invoke<string>\("git_diff", \{ cwd, path: filePath, hostId: hostId \?\? null \}\)/);
  assert.match(app, /hostId=\{selectedGitHostId\}/);
  assert.match(app, /setDiffFile\(\{ path: filePath, cwd, hostId: hostId \?\? null \}\)/);
});
