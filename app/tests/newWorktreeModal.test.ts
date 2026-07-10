import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("new worktree project picker uses the shared menu select", () => {
  const modal = readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /import \{ MenuSelect, type MenuOption \} from "\.\/MenuSelect";/);
  assert.match(modal, /const projectMenuOptions\s*:\s*MenuOption\[\]/);
  assert.match(modal, /<MenuSelect\s+ariaLabel="Project"/);
  assert.doesNotMatch(modal, /<select[^>]*value=\{project\}/);
});

test("new worktree remote hosts can use remote project presets", () => {
  const modal = readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");

  assert.match(modal, /dashboardBackend\.projects\.listRemote\(selectedHost\)/);
  assert.match(
    backend,
    /listRemote: \(hostId\) =>\s*transport\.invoke<ProjectPreset\[\]>\("list_remote_projects", \{ hostId \}\)/s,
  );
  assert.match(modal, /createArgs\.project = project;/);
  assert.doesNotMatch(modal, /const isCustom = project === CUSTOM \|\| isRemote;/);
});

test("automation panel reuses the shared menu select component", () => {
  const panel = readFileSync(new URL("../src/AutomationPanel.tsx", import.meta.url), "utf8");

  assert.match(panel, /import \{ MenuSelect, type MenuOption \} from "\.\/MenuSelect";/);
  assert.doesNotMatch(panel, /function AutomationMenuSelect/);
});
