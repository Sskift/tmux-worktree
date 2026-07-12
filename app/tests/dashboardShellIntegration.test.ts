import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  readRendererImplementationTree,
  rendererImplementationSourceContaining,
} from "./helpers/rendererImplementationSource.ts";

const renderer = readRendererImplementationTree();
const shell = readFileSync(
  new URL("../src/dashboard/DashboardShell.tsx", import.meta.url),
  "utf8",
);
const shellCss = readFileSync(
  new URL("../src/dashboard/DashboardShell.css", import.meta.url),
  "utf8",
);

test("the renderer composes the planned shell without legacy arbitrary columns", () => {
  const composition = rendererImplementationSourceContaining(
    "<DashboardShell",
    "<DashboardSidebar",
    "<WorkspaceHeader",
    "<GitPanel",
  ).source;
  assert.match(composition, /return \(\s*<DashboardShell/);
  assert.match(composition, /<DashboardSidebar/);
  assert.match(composition, /<WorkspaceHeader/);
  assert.match(composition, /<GitPanel/);
  assert.doesNotMatch(renderer, /className="sidebar"|column-drag-handle|useSortable/);
  assert.doesNotMatch(renderer, /sidebar__git|remote-popover|>\+ host</);
});

test("responsive shell docks the sidebar from 960px and keeps a 640px workspace", () => {
  const composition = rendererImplementationSourceContaining(
    "if (width >= 1440)",
    "if (width >= 960)",
    "setSidebarOpen(false)",
  ).source;
  assert.match(composition, /if \(width >= 1440\) return "wide"/);
  assert.match(composition, /if \(width >= 960\) return "drawer"/);
  assert.match(composition, /setSidebarOpen\(false\);\s*setInspectorOpen\(false\)/);
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
  const composition = rendererImplementationSourceContaining(
    "const activeDrawer: DashboardDrawer",
    "workspaceInteractionBlocked = anyModalOpen || activeDrawer !== null",
    "<TerminalDeck",
  ).source;
  assert.match(composition, /const activeDrawer: DashboardDrawer/);
  assert.match(composition, /workspaceInteractionBlocked = anyModalOpen \|\| activeDrawer !== null/);
  assert.match(composition, /<TerminalDeck[\s\S]*?blocked=\{workspaceInteractionBlocked\}/);
  assert.match(composition, /active=\{isActive && !scratchCollapsed && !workspaceInteractionBlocked\}/);
  assert.match(composition, /activeDrawer=\{activeDrawer\}/);
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
  const composition = rendererImplementationSourceContaining(
    "hostId={selectedGitHostId}",
    "const openFiles = useCallback",
    "setDiffFile({ path, cwd, hostId: hostId ?? null })",
  ).source;
  assert.match(composition, /hostId=\{selectedGitHostId\}/);
  assert.match(composition, /onFileSelect=\{\(path, hostId\) =>/);
  assert.match(composition, /handleOpenFile\(path, undefined, undefined, hostId\)/);
  assert.match(composition, /activeView=\{sidebarView\}/);
  assert.match(composition, /filesContent=\{renderFiles\(\)\}/);
  assert.match(composition, /lay\.fileBrowserOpen === true \|\|[\s\S]*?lay\.inspectorOpen === true && lay\.inspectorTab === "files"/);
  assert.match(composition, /const openFiles = useCallback[\s\S]*?viewportTier !== "wide"[\s\S]*?setInspectorOpen\(false\)/);
  assert.match(composition, /setDiffFile\(\{ path, cwd, hostId: hostId \?\? null \}\)/);
  assert.match(composition, /diffFile \? \(\s*<div className="dashboard-workspace__editor">/);
  assert.doesNotMatch(renderer, /setInspectorTab\("diff"\)/);
});

test("unfinished integrations stay out of Git while overlays keep terminals mounted", () => {
  const settings = readFileSync(
    new URL("../src/dashboard/Settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(renderer, /Feishu is not configured/);
  assert.match(settings, /label: "Integrations"/);
  const composition = rendererImplementationSourceContaining(
    "<TerminalDeck",
    "blocked={anyModalOpen}",
    "event.key.toLowerCase() !== \"n\"",
  ).source;
  assert.match(composition, /blocked=\{anyModalOpen\}/);
  assert.equal(renderer.match(/<TerminalDeck\b/g)?.length, 1);
  assert.match(composition, /event\.key\.toLowerCase\(\) !== "n"/);
});

test("destructive sidebar and automation actions require confirmation", () => {
  const sessionClose = rendererImplementationSourceContaining(
    'title: "Close worktree session?"',
    "sessions.kill",
  ).source;
  const terminalClose = rendererImplementationSourceContaining(
    'title: "Close terminal?"',
    "terminals.kill",
  ).source;
  const automationDelete = rendererImplementationSourceContaining(
    'title: "Delete automation?"',
    "automations.delete",
  ).source;
  assert.match(sessionClose, /title: "Close worktree session\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?sessions\.kill/);
  assert.match(terminalClose, /title: "Close terminal\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?terminals\.kill/);
  assert.match(automationDelete, /title: "Delete automation\?"[\s\S]*?if \(!confirmed\) return;[\s\S]*?automations\.delete/);
});

test("Git is a focused side panel and Automation keeps a workspace return path", () => {
  const composition = rendererImplementationSourceContaining(
    'selection?.kind === "automation"',
    "Back to workspace",
    "<GitPanel",
  ).source;
  assert.match(composition, /selection\?\.kind === "automation"[\s\S]*?>Back to workspace</);
  assert.match(composition, /returnFromAutomationManager/);
  assert.match(composition, /<GitPanel\s+content=\{renderGit\(\)\}/);
  assert.doesNotMatch(renderer, /inspectorContent|expandedInspectorTab|renderExpandedView/);
});
