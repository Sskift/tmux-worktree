import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardLayoutSnapshot } from "../src/dashboard/layoutSnapshot.ts";

test("dashboard layout snapshot builder owns every persisted field and clones inputs", () => {
  const input = {
    automationSectionCollapsed: false,
    collapsedProjects: ["host:project"],
    diffFile: { path: "src/App.tsx", cwd: "/repo", hostId: "builder" },
    editingFile: { path: "/repo/src/App.tsx", hostId: "builder", line: 12, column: 4 },
    inspectorOpen: true,
    inspectorWidth: 430,
    pinnedItems: [{ kind: "session" as const, name: "host:session" }],
    scratchCollapsed: false,
    scratchWidth: 390,
    selection: { kind: "terminal" as const, id: "terminal-1" },
    sessionOrder: ["host:session"],
    sidebarOpen: false,
    sidebarView: "files" as const,
    sidebarWidth: 310,
    windowLayout: { width: 1280, height: 800, x: -20, y: 30, maximized: false },
  };
  const snapshot = buildDashboardLayoutSnapshot(input);

  assert.deepEqual(snapshot, {
    left: 310,
    sidebarWidth: 310,
    inspectorWidth: 430,
    sidebarOpen: false,
    inspectorOpen: true,
    sidebarView: "files",
    sessionOrder: ["host:session"],
    collapsedProjects: ["host:project"],
    pinnedItems: [{ kind: "session", name: "host:session" }],
    automationSectionCollapsed: false,
    columnOrder: ["file", "main", "scratch", "editor"],
    scratchCollapsed: false,
    scratchWidth: 390,
    fileBrowserOpen: true,
    selection: { kind: "terminal", id: "terminal-1" },
    editingFile: {
      path: "/repo/src/App.tsx",
      hostId: "builder",
      line: 12,
      column: 4,
    },
    diffFile: { path: "src/App.tsx", cwd: "/repo", hostId: "builder" },
    window: { width: 1280, height: 800, x: -20, y: 30, maximized: false },
  });

  input.sessionOrder.push("mutated");
  input.collapsedProjects.push("mutated");
  input.pinnedItems[0].name = "mutated";
  input.selection.id = "mutated";
  input.editingFile.path = "mutated";
  input.diffFile.path = "mutated";
  input.windowLayout.width = 1;
  assert.deepEqual(snapshot.sessionOrder, ["host:session"]);
  assert.deepEqual(snapshot.collapsedProjects, ["host:project"]);
  assert.deepEqual(snapshot.pinnedItems, [{ kind: "session", name: "host:session" }]);
  assert.deepEqual(snapshot.selection, { kind: "terminal", id: "terminal-1" });
  assert.equal(snapshot.editingFile?.path, "/repo/src/App.tsx");
  assert.equal(snapshot.diffFile?.path, "src/App.tsx");
  assert.equal(snapshot.window?.width, 1280);
});

test("dashboard layout snapshot omits unknown window state and preserves null selections", () => {
  const snapshot = buildDashboardLayoutSnapshot({
    automationSectionCollapsed: true,
    collapsedProjects: [],
    diffFile: null,
    editingFile: null,
    inspectorOpen: false,
    inspectorWidth: 420,
    pinnedItems: [],
    scratchCollapsed: true,
    scratchWidth: 360,
    selection: null,
    sessionOrder: [],
    sidebarOpen: true,
    sidebarView: "workspaces",
    sidebarWidth: 280,
    windowLayout: null,
  });
  assert.equal("window" in snapshot, false);
  assert.equal(snapshot.fileBrowserOpen, false);
  assert.equal(snapshot.selection, null);
  assert.equal(snapshot.editingFile, null);
  assert.equal(snapshot.diffFile, null);
});
