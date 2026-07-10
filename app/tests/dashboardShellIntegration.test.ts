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

test("responsive shell keeps a 640px workspace and converts panels to drawers", () => {
  assert.match(app, /if \(width >= 1440\) return "wide"/);
  assert.match(app, /if \(width >= 1100\) return "drawer"/);
  assert.match(app, /setSidebarOpen\(false\);\s*setInspectorOpen\(false\)/);
  assert.match(shellCss, /minmax\(640px, 1fr\)/);
  assert.match(shellCss, /@media \(max-width: 1439px\)/);
  assert.match(shellCss, /@media \(max-width: 1099px\)/);
  assert.match(shell, /onDismissDrawers/);
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

test("real files and Git state route through inspector without losing host identity", () => {
  assert.match(app, /hostId=\{selectedGitHostId\}/);
  assert.match(app, /onFileSelect=\{\(path, hostId\) =>/);
  assert.match(app, /handleOpenFile\(path, undefined, undefined, hostId\)/);
  assert.match(app, /setInspectorTab\("diff"\)/);
  assert.match(app, /Back to terminal/);
});

test("Feishu state is honest and settings overlays block but do not unmount terminals", () => {
  assert.match(app, /Feishu is not configured/);
  assert.match(app, /openSettings\("integrations"\)/);
  assert.match(app, /blocked=\{anyModalOpen\}/);
  assert.equal(app.match(/<TerminalDeck\b/g)?.length, 1);
  assert.match(app, /event\.key\.toLowerCase\(\) !== "n"/);
});

test("destructive sidebar and automation actions require confirmation", () => {
  assert.match(app, /title: "Close worktree session\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?sessions\.kill/);
  assert.match(app, /title: "Close terminal\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?terminals\.kill/);
  assert.match(app, /title: "Delete automation\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?automations\.delete/);
});

test("expanded inspector views, including Automation, have a terminal return path", () => {
  assert.match(app, /renderExpandedView\("Automation", automationPanel\)/);
  assert.match(app, /Back to terminal/);
});
