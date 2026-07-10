import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("GitStatusPanel periodically triggers project root fetches", () => {
  const source = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /PROJECT_FETCH_MS\s*=\s*5\s*\*\s*60_000/);
  assert.match(source, /dashboardBackend\.git\.fetchProjectRoots\(\)/);
  assert.match(source, /setInterval\(triggerProjectFetch,\s*PROJECT_FETCH_MS\)/);
});

test("remote git status passes host identity through git commands", () => {
  const panel = readFileSync(new URL("../src/GitStatusPanel.tsx", import.meta.url), "utf8");
  const diff = readFileSync(new URL("../src/DiffViewer.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");

  assert.match(panel, /hostId\?: string \| null/);
  assert.match(panel, /dashboardBackend\.git\.status\(gitCwd, hostId\)/);
  assert.match(panel, /dashboardBackend\.git\.log\(gitCwd, 100, hostId\)/);
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
    /diff: \(cwd, path, hostId\) =>\s*transport\.invoke<string>\("git_diff", \{ cwd, path, hostId: hostId \?\? null \}\)/s,
  );
  assert.match(app, /hostId=\{selectedGitHostId\}/);
  assert.match(app, /setDiffFile\(\{ path: filePath, cwd, hostId: hostId \?\? null \}\)/);
});
