import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("legacy dashboard-only source modules stay removed", () => {
  for (const file of ["AddHostModal.tsx", "sidebarLayout.ts", "useSortable.ts"]) {
    assert.equal(
      existsSync(new URL(`../src/${file}`, import.meta.url)),
      false,
      `${file} should not return to the production tree`,
    );
  }

  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.doesNotMatch(app, /useSortable|data-sort-index|column-drag-handle/);
  assert.doesNotMatch(css, /\.column-drag-handle|\.remote-popover|\.file-tree-panel|\.editor-panel/);
});

test("dashboard shell removes legacy height-coupled sidebar persistence", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const shellCss = readFileSync(
    new URL("../src/dashboard/DashboardShell.css", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(app, /isStableSidebarLayoutHeight|normalizeSidebarSplits/);
  assert.match(shellCss, /height:\s*calc\(100vh - 44px\)/);
  assert.match(shellCss, /overflow:\s*hidden/);
});

test("worktree sidebar groups sessions by project with collapsible headers", () => {
  const sidebar = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );
  const model = readFileSync(
    new URL("../src/dashboard/DashboardSidebarModel.ts", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.css", import.meta.url),
    "utf8",
  );

  assert.match(model, /export function groupSessionsByHostProject/);
  assert.match(sidebar, /const collapsed = useMemo\(\(\) => new Set\(collapsedProjects\)/);
  assert.match(sidebar, /groups\.map\(\(group\) =>/);
  assert.match(sidebar, /className="tw-sidebar-group__toggle"/);
  assert.match(css, /\.tw-sidebar-group__toggle\s*\{/);
  assert.match(css, /\.tw-sidebar-group__items\s*\{/);
});

test("remote scratch terminals start on the selected host cwd", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const deck = readFileSync(new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url), "utf8");

  assert.match(app, /function buildSshShellArgs\(host: HostConfig, cwd: string\): string\[\]/);
  assert.match(deck, /function shellQuoteArg\(value: string\): string/);
  assert.match(app, /buildSshShellArgs\(scratchContext\.host, scratchContext\.cwd\)/);
  assert.match(app, /hostId=\{scratchContext\.host\?\.id \?\? null\}/);
  assert.match(app, /`cd \$\{shellQuoteArg\(cwd\)\} && exec "\\\$\{SHELL:-\/bin\/sh\}"`/);
  assert.doesNotMatch(app, /"sh",\s*"-c"/);
  assert.doesNotMatch(app, /"sh",\s*"-lc"/);
  assert.doesNotMatch(app, /exec "\$\{SHELL:-\/bin\/sh\}" -l/);
  assert.doesNotMatch(app, /if \(session\?\.hostId\) return homeDir \?\? "\/";/);
});

test("worktree project groups persist collapse keys without legacy arbitrary sorting", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(
    new URL("../src/dashboard/DashboardSidebar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /collapsedProjects/);
  assert.match(app, /saveLayoutPreferences\(\{[\s\S]*collapsedProjects/);
  assert.match(sidebar, /onToggleProjectCollapsed\(group\.key\)/);
  assert.doesNotMatch(app, /useSortable|data-sort-index|column-drag-handle/);
});
