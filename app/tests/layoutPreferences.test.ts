import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DASHBOARD_LAYOUT_SCHEMA_VERSION,
  DEFAULT_COLUMN_ORDER,
  createDashboardLayoutV2,
  isDashboardLayoutV2,
  migrateDashboardLayout,
} from "../src/dashboard/layoutPreferences.ts";
import {
  loadDashboardLayoutPreferences,
  saveDashboardLayoutPreferences,
} from "../src/dashboard/layoutPersistence.ts";

const { createFakeDashboardBackend } = await import("../src/platform/fakeBackend.ts");

const legacyLayout = {
  left: 264,
  right: 412,
  gitHeight: 230,
  sectionSplit: 215,
  automationHeight: 132,
  sessionOrder: ["dashboard-one", "dashboard-two"],
  collapsedProjects: ["local:dashboard", "ssh:builder:dashboard"],
  columnOrder: ["editor", "main", "scratch", "file"],
  scratchCollapsed: true,
  fileBrowserOpen: true,
  fileTreeWidth: 318,
  editorWidth: 544,
  selection: { kind: "session", name: "builder:dashboard-one" },
  editingFile: { path: "/repo/src/App.tsx", hostId: "builder" },
  diffFile: { path: "src/App.tsx", cwd: "/repo", hostId: "builder" },
  window: { width: 1512, height: 982, x: -120, y: 48, maximized: false },
};

test("legacy flat layout migrates to a validated compatible v2 envelope", () => {
  const migrated = migrateDashboardLayout(legacyLayout);

  assert.equal(migrated.schemaVersion, DASHBOARD_LAYOUT_SCHEMA_VERSION);
  assert.equal(isDashboardLayoutV2(migrated), true);
  assert.deepEqual(migrated, {
    schemaVersion: 2,
    ...legacyLayout,
  });
  assert.deepEqual(migrated.window, legacyLayout.window);
  assert.equal("preferences" in migrated, false, "window must remain top-level for Rust startup restore");
});

test("migration is idempotent and a valid v2 object is a no-op", () => {
  const once = migrateDashboardLayout(legacyLayout);
  const twice = migrateDashboardLayout(once);

  assert.equal(twice, once);
  assert.deepEqual(twice, once);

  const v2WithForwardCompatibleMetadata = {
    ...once,
    futureHint: { inspector: "git" },
  };
  assert.equal(migrateDashboardLayout(v2WithForwardCompatibleMetadata), v2WithForwardCompatibleMetadata);
});

test("shell sidebar and inspector preferences survive versioned normalization", () => {
  const migrated = migrateDashboardLayout({
    sidebarWidth: 296,
    inspectorWidth: 448,
    sidebarOpen: true,
    inspectorOpen: false,
    inspectorTab: "diff",
    columnOrder: ["main"],
  });

  assert.equal(isDashboardLayoutV2(migrated), true);
  assert.equal(migrated.sidebarWidth, 296);
  assert.equal(migrated.inspectorWidth, 448);
  assert.equal(migrated.sidebarOpen, true);
  assert.equal(migrated.inspectorOpen, false);
  assert.equal(migrated.inspectorTab, "diff");
});

test("scratch, pinned, and collapsed automation preferences round-trip safely", () => {
  const migrated = migrateDashboardLayout({
    columnOrder: ["main"],
    scratchWidth: 412,
    automationSectionCollapsed: true,
    pinnedItems: [
      { kind: "session", name: "local:repo" },
      { kind: "terminal", id: "terminal-1" },
      { kind: "session", name: "local:repo" },
      { kind: "automation", id: "not-pinnable" },
    ],
  });

  assert.equal(migrated.scratchWidth, 412);
  assert.equal(migrated.automationSectionCollapsed, true);
  assert.deepEqual(migrated.pinnedItems, [
    { kind: "session", name: "local:repo" },
    { kind: "terminal", id: "terminal-1" },
  ]);
  assert.equal(isDashboardLayoutV2(migrated), true);
});

test("legacy string editor paths become host-aware editor records", () => {
  const migrated = migrateDashboardLayout({
    editingFile: "/repo/README.md",
    columnOrder: ["main"],
  });

  assert.deepEqual(migrated.editingFile, { path: "/repo/README.md", hostId: null });
  assert.deepEqual(migrated.columnOrder, ["main", "file", "scratch", "editor"]);
});

test("bad fields fall back safely without throwing or contaminating valid fields", () => {
  let migrated: ReturnType<typeof migrateDashboardLayout> | undefined;
  assert.doesNotThrow(() => {
    migrated = migrateDashboardLayout({
      schemaVersion: 2,
      left: "wide",
      right: Number.NaN,
      gitHeight: -10,
      sectionSplit: 0,
      automationHeight: Number.POSITIVE_INFINITY,
      sessionOrder: ["valid-session", 42, null],
      collapsedProjects: ["project", "", false],
      columnOrder: ["main", "main", "unknown"],
      scratchCollapsed: "yes",
      fileBrowserOpen: false,
      fileTreeWidth: -1,
      editorWidth: {},
      selection: { kind: "terminal", id: 42 },
      editingFile: { path: 12 },
      diffFile: { path: "x", cwd: null },
      window: { width: 0, height: 900, x: 0, y: 0, maximized: false },
    });
  });

  assert.deepEqual(migrated, {
    schemaVersion: 2,
    columnOrder: ["main", "file", "scratch", "editor"],
    sessionOrder: ["valid-session"],
    collapsedProjects: ["project"],
    fileBrowserOpen: false,
  });
  assert.equal(isDashboardLayoutV2(migrated), true);
});

test("non-object and unknown-version layouts return deterministic defaults", () => {
  const expected = {
    schemaVersion: 2,
    columnOrder: DEFAULT_COLUMN_ORDER,
  };

  for (const value of [null, undefined, "broken", [], { schemaVersion: 99, left: 300 }]) {
    assert.deepEqual(migrateDashboardLayout(value), expected);
  }
});

test("createDashboardLayoutV2 does not mutate its input", () => {
  const input = {
    columnOrder: ["scratch", "main", "file", "editor"] as const,
    sessionOrder: ["one"],
    window: { width: 1440, height: 900, x: 0, y: 0, maximized: true },
  };
  const snapshot = structuredClone(input);

  const created = createDashboardLayoutV2({
    ...input,
    columnOrder: [...input.columnOrder],
  });

  assert.deepEqual(input, snapshot);
  assert.equal(created.schemaVersion, 2);
  assert.deepEqual(created.window, input.window);
});

test("layout persistence loads legacy data and always saves v2", async () => {
  const { backend, transport } = createFakeDashboardBackend({
    load_layout: () => legacyLayout,
    save_layout: () => undefined,
  });

  const loaded = await loadDashboardLayoutPreferences(backend);
  await saveDashboardLayoutPreferences(backend, loaded);

  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(transport.calls, [
    { command: "load_layout", args: undefined },
    {
      command: "save_layout",
      args: { layout: loaded },
    },
  ]);
});

test("App delegates layout IO to the versioned layout boundary", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const \{ loadLayoutPreferences, saveLayoutPreferences \} = useLayoutPreferences\(\);/);
  assert.match(source, /loadLayoutPreferences\(\)/);
  assert.match(source, /saveLayoutPreferences\(\{/);
  assert.doesNotMatch(source, /dashboardBackend\.persistence\.(?:loadLayout|saveLayout)/);
});
