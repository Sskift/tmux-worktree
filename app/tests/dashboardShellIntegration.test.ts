import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const shell = readFileSync(
  new URL("../src/dashboard/DashboardShell.tsx", import.meta.url),
  "utf8",
);
const shellCss = readFileSync(
  new URL("../src/dashboard/DashboardShell.css", import.meta.url),
  "utf8",
);

test("App renders the planned shell without legacy arbitrary columns", () => {
  assert.match(app, /return \(\s*<DashboardShell/);
  assert.match(app, /<DashboardSidebar/);
  assert.match(app, /<WorkspaceHeader/);
  assert.match(app, /<Inspector/);
  assert.doesNotMatch(app, /className="sidebar"|column-drag-handle|useSortable/);
  assert.doesNotMatch(app, /sidebar__git|remote-popover|>\+ host</);
});

test("responsive shell docks the sidebar from 960px and keeps a 640px workspace", () => {
  assert.match(app, /if \(width >= 1440\) return "wide"/);
  assert.match(app, /if \(width >= 960\) return "drawer"/);
  assert.match(app, /setSidebarOpen\(false\);\s*setInspectorOpen\(false\)/);
  assert.match(shellCss, /minmax\(640px, 1fr\)/);
  assert.match(shellCss, /@media \(max-width: 1439px\)/);
  assert.match(shellCss, /@media \(min-width: 960px\) and \(max-width: 1439px\)/);
  assert.match(shellCss, /calc\(100vw - 640px\)/);
  assert.match(shellCss, /@media \(max-width: 959px\)/);
  assert.match(shell, /onDismissDrawers/);
  assert.match(shell, /aria-valuemax=\{sidebarMaximumWidth\}/);
  assert.match(shell, /clampDashboardPanelWidthForViewport\(/);
});

test("responsive drawers isolate terminal input and manage keyboard focus", () => {
  assert.match(app, /const activeDrawer: DashboardDrawer/);
  assert.match(app, /workspaceInteractionBlocked = anyModalOpen \|\| activeDrawer !== null/);
  assert.match(app, /<TerminalDeck[\s\S]*?blocked=\{workspaceInteractionBlocked\}/);
  assert.match(app, /active=\{isActive && !scratchCollapsed && !workspaceInteractionBlocked\}/);
  assert.match(app, /activeDrawer=\{activeDrawer\}/);
  assert.match(shell, /inert=\{activeDrawer !== null\}/);
  assert.match(shell, /aria-modal=\{activeDrawer === "sidebar"/);
  assert.match(shell, /aria-modal=\{activeDrawer === "inspector"/);
  assert.match(shell, /event\.key === "Escape"/);
  assert.match(shell, /drawerReturnFocusRef/);
  assert.match(shell, /document\.addEventListener\("focusin", keepFocusInDrawer\)/);
});

test("panel resize feedback stays smooth without escaping modal drawer layering", () => {
  assert.match(shell, /document\.body\.dataset\.dashboardResizing = panel/);
  assert.match(shell, /delete document\.body\.dataset\.dashboardResizing/);
  assert.match(
    shellCss,
    /body\[data-dashboard-resizing\] \.tw-shell__body\s*\{\s*transition: none;/,
  );
  assert.match(
    shellCss,
    /\.tw-shell\[data-modal-drawer\] \.tw-shell__resize-handle\s*\{\s*z-index: 15;\s*pointer-events: none;/,
  );
});

test("Files stay beside the editor while Git routes diffs into the workspace", () => {
  assert.match(app, /hostId=\{selectedGitHostId\}/);
  assert.match(app, /onFileSelect=\{\(path, hostId\) =>/);
  assert.match(app, /handleOpenFile\(path, undefined, undefined, hostId\)/);
  assert.match(app, /activeView=\{sidebarView\}/);
  assert.match(app, /filesContent=\{renderFiles\(\)\}/);
  assert.match(app, /lay\.fileBrowserOpen === true \|\|[\s\S]*?lay\.inspectorOpen === true && lay\.inspectorTab === "files"/);
  assert.match(app, /const openFiles = useCallback[\s\S]*?viewportTier !== "wide"[\s\S]*?setInspectorOpen\(false\)/);
  assert.match(app, /setDiffFile\(\{ path, cwd, hostId: hostId \?\? null \}\)/);
  assert.match(app, /diffFile \? \(\s*<div className="dashboard-workspace__editor">/);
  assert.doesNotMatch(app, /setInspectorTab\("diff"\)/);
});

test("unfinished integrations stay out of Git while overlays keep terminals mounted", () => {
  const settings = readFileSync(
    new URL("../src/dashboard/Settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(app, /Feishu is not configured/);
  assert.match(settings, /label: "Integrations"/);
  assert.match(app, /blocked=\{anyModalOpen\}/);
  assert.equal(app.match(/<TerminalDeck\b/g)?.length, 1);
  assert.match(app, /event\.key\.toLowerCase\(\) !== "n"/);
});

test("destructive sidebar and automation actions require confirmation", () => {
  assert.match(app, /title: "Close worktree session\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?sessions\.kill/);
  assert.match(app, /title: "Close terminal\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?terminals\.kill/);
  assert.match(app, /title: "Delete automation\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?automations\.delete/);
});

test("Git is a focused side panel and Automation keeps a workspace return path", () => {
  assert.match(app, /selection\?\.kind === "automation"[\s\S]*?>Back to workspace</);
  assert.match(app, /returnFromAutomationManager/);
  assert.match(app, /<Inspector\s+content=\{renderGit\(\)\}/);
  assert.doesNotMatch(app, /inspectorContent|expandedInspectorTab|renderExpandedView/);
});
