import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_LAYOUT_SCHEMA_VERSION,
  DEFAULT_COLUMN_ORDER,
  createDashboardLayoutV2,
  decodeDashboardLayout,
  isDashboardLayoutV2,
  type DashboardLayoutDecodeOutcome,
  type DashboardLayoutV2,
} from "../src/dashboard/layout/schema.ts";
import {
  loadDashboardLayoutPreferences,
  saveDashboardLayoutPreferences,
} from "../src/dashboard/layoutPersistence.ts";
import { rendererImplementationSourceContaining } from "./helpers/rendererImplementationSource.ts";

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

function compatibleOutcome(value: unknown): Extract<
  DashboardLayoutDecodeOutcome,
  { kind: "compatible" }
> {
  const outcome = decodeDashboardLayout(value);
  assert.equal(outcome.kind, "compatible");
  assert.ok(outcome.kind === "compatible");
  return outcome;
}

function compatibleLayout(value: unknown): DashboardLayoutV2 {
  return compatibleOutcome(value).layout;
}

function plainLayout(value: DashboardLayoutV2): Record<string, unknown> {
  return { ...value };
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("legacy flat layout migrates to a validated compatible v2 envelope", () => {
  const migrated = compatibleLayout(legacyLayout);

  assert.equal(migrated.schemaVersion, DASHBOARD_LAYOUT_SCHEMA_VERSION);
  assert.equal(isDashboardLayoutV2(migrated), true);
  assert.deepEqual(jsonValue(migrated), {
    schemaVersion: 2,
    ...legacyLayout,
  });
  assert.deepEqual(jsonValue(migrated.window), legacyLayout.window);
  assert.equal("preferences" in migrated, false, "window must remain top-level for Rust startup restore");
});

test("migration is idempotent and a valid v2 object is a no-op", () => {
  const once = compatibleLayout(legacyLayout);
  const twice = compatibleLayout(once);

  assert.notEqual(twice, once);
  assert.deepEqual(plainLayout(twice), plainLayout(once));

  const v2WithForwardCompatibleMetadata = {
    ...once,
    futureHint: { inspector: "git" },
  };
  const current = compatibleOutcome(v2WithForwardCompatibleMetadata);
  assert.notEqual(current.layout, v2WithForwardCompatibleMetadata);
  assert.deepEqual(plainLayout(current.layout), plainLayout(v2WithForwardCompatibleMetadata));
  assert.deepEqual(current.extensions, { futureHint: { inspector: "git" } });
});

test("shell sidebar and inspector preferences survive versioned normalization", () => {
  const migrated = compatibleLayout({
    sidebarWidth: 296,
    inspectorWidth: 448,
    sidebarOpen: true,
    sidebarView: "files",
    inspectorOpen: false,
    inspectorTab: "diff",
    columnOrder: ["main"],
  });

  assert.equal(isDashboardLayoutV2(migrated), true);
  assert.equal(migrated.sidebarWidth, 296);
  assert.equal(migrated.inspectorWidth, 448);
  assert.equal(migrated.sidebarOpen, true);
  assert.equal(migrated.sidebarView, "files");
  assert.equal(migrated.inspectorOpen, false);
  assert.equal(migrated.inspectorTab, "diff");
});

test("legacy files inspector state remains readable during sidebar migration", () => {
  const migrated = compatibleLayout({
    columnOrder: ["main"],
    inspectorOpen: true,
    inspectorTab: "files",
  });

  assert.equal(migrated.inspectorOpen, true);
  assert.equal(migrated.inspectorTab, "files");
  assert.equal(migrated.sidebarView, undefined);
  assert.equal(isDashboardLayoutV2(migrated), true);
});

test("scratch, pinned, and collapsed automation preferences round-trip safely", () => {
  const migrated = compatibleLayout({
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
  assert.deepEqual(jsonValue(migrated.pinnedItems), [
    { kind: "session", name: "local:repo" },
    { kind: "terminal", id: "terminal-1" },
  ]);
  assert.equal(isDashboardLayoutV2(migrated), true);
});

test("valid pinned items are cloned away from later source mutations", () => {
  const sourceItem: { kind: "session"; name: string } = {
    kind: "session",
    name: "local:before",
  };
  const sourceItems = [sourceItem];
  const outcome = compatibleOutcome({
    schemaVersion: 2,
    columnOrder: [...DEFAULT_COLUMN_ORDER],
    pinnedItems: sourceItems,
  });
  assert.ok(outcome.layout.pinnedItems);
  assert.notEqual(outcome.layout.pinnedItems, sourceItems);
  assert.notEqual(outcome.layout.pinnedItems[0], sourceItem);

  sourceItem.name = "local:after";
  sourceItems.push({ kind: "session", name: "local:added" });
  assert.deepEqual(jsonValue(outcome.layout.pinnedItems), [
    { kind: "session", name: "local:before" },
  ]);
});

test("legacy string editor paths become host-aware editor records", () => {
  const migrated = compatibleLayout({
    editingFile: "/repo/README.md",
    columnOrder: ["main"],
  });

  assert.deepEqual(jsonValue(migrated.editingFile), {
    path: "/repo/README.md",
    hostId: null,
  });
  assert.deepEqual(migrated.columnOrder, ["main", "file", "scratch", "editor"]);
});

test("editor cursor locations round-trip only when they are positive integers", () => {
  const valid = compatibleLayout({
    columnOrder: ["main"],
    editingFile: {
      path: "/repo/src/App.tsx",
      hostId: "builder",
      line: 42,
      column: 7,
    },
  });
  assert.deepEqual(jsonValue(valid.editingFile), {
    path: "/repo/src/App.tsx",
    hostId: "builder",
    line: 42,
    column: 7,
  });

  const invalid = compatibleLayout({
    columnOrder: ["main"],
    editingFile: { path: "/repo/src/App.tsx", line: 0, column: 1.5 },
  });
  assert.equal(invalid.editingFile, undefined);
});

test("bad fields fall back safely without throwing or contaminating valid fields", () => {
  let migrated: DashboardLayoutV2 | undefined;
  assert.doesNotThrow(() => {
    migrated = compatibleLayout({
      left: "wide",
      right: Number.NaN,
      gitHeight: -10,
      sectionSplit: 0,
      automationHeight: Number.POSITIVE_INFINITY,
      sessionOrder: ["valid-session", 42, null],
      collapsedProjects: ["project", "", false],
      columnOrder: ["main", "main", "unknown"],
      scratchCollapsed: "yes",
      sidebarView: "git",
      fileBrowserOpen: false,
      fileTreeWidth: -1,
      editorWidth: {},
      selection: { kind: "terminal", id: 42 },
      editingFile: { path: 12 },
      diffFile: { path: "x", cwd: null },
      window: { width: 0, height: 900, x: 0, y: 0, maximized: false },
    });
  });

  assert.deepEqual(plainLayout(migrated as DashboardLayoutV2), {
    schemaVersion: 2,
    columnOrder: ["main", "file", "scratch", "editor"],
    sessionOrder: ["valid-session"],
    collapsedProjects: ["project"],
    fileBrowserOpen: false,
  });
  assert.equal(isDashboardLayoutV2(migrated), true);
});

test("markerless, v1, and legacy version 2 layouts remain compatible", () => {
  for (const value of [
    {},
    { left: 280 },
    { schemaVersion: 1, sidebarWidth: 281 },
    { version: 1, sidebarWidth: 282 },
    { schemaVersion: 1, version: 1, sidebarWidth: 283 },
    { version: 2, sidebarWidth: 284 },
  ]) {
    const outcome = compatibleOutcome(value);
    assert.equal(outcome.source, "legacy");
    assert.equal(outcome.layout.schemaVersion, 2);
    assert.equal(isDashboardLayoutV2(outcome.layout), true);
  }
});

test("canonical current and future layouts decode without downgrading", () => {
  const currentLayout = createDashboardLayoutV2({
    columnOrder: [...DEFAULT_COLUMN_ORDER],
    sidebarWidth: 292,
  });
  const current = compatibleOutcome(currentLayout);
  assert.equal(current.source, "current");
  assert.notEqual(current.layout, currentLayout);
  assert.deepEqual(plainLayout(current.layout), plainLayout(currentLayout));
  assert.equal(Object.getPrototypeOf(current.layout), null);

  const dualCurrent = compatibleOutcome({ ...currentLayout, version: 2 });
  assert.equal(dualCurrent.source, "current");
  assert.equal("version" in dualCurrent.layout, false);

  for (const [value, marker] of [
    [{ schemaVersion: 3 }, "schemaVersion"],
    [{ version: 3 }, "version"],
    [{ schemaVersion: 3, version: 3 }, "schemaVersion"],
  ] as const) {
    assert.deepEqual(decodeDashboardLayout(value), {
      kind: "future",
      version: 3,
      marker,
    });
  }
});

test("invalid markers, conflicts, objects, and current layouts fail closed", () => {
  for (const value of [
    { schemaVersion: "2" },
    { schemaVersion: 0 },
    { schemaVersion: 1.5 },
    { version: "2" },
    { version: 0 },
    { version: 1.5 },
    { schemaVersion: Number.NaN },
    { version: Number.POSITIVE_INFINITY },
    { schemaVersion: -1 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { schemaVersion: 2, version: "2" },
  ]) {
    assert.deepEqual(decodeDashboardLayout(value), {
      kind: "invalid",
      reason: "invalid_version_marker",
    });
  }
  assert.deepEqual(decodeDashboardLayout({ schemaVersion: 2, version: 99 }), {
    kind: "invalid",
    reason: "conflicting_version_markers",
  });
  for (const value of [null, undefined, "broken", [], new Date(), Object.create({})]) {
    assert.deepEqual(decodeDashboardLayout(value), {
      kind: "invalid",
      reason: "not_object",
    });
  }
  for (const value of [
    { schemaVersion: 2 },
    { schemaVersion: 2, columnOrder: ["main"] },
    { schemaVersion: 2, columnOrder: [...DEFAULT_COLUMN_ORDER], sidebarOpen: "yes" },
  ]) {
    assert.deepEqual(decodeDashboardLayout(value), {
      kind: "invalid",
      reason: "invalid_current_layout",
    });
  }
});

test("decoder snapshots own data without invoking accessors or proxy reads", () => {
  const canonical = {
    ...createDashboardLayoutV2({
      columnOrder: [...DEFAULT_COLUMN_ORDER],
      sidebarWidth: 292,
    }),
  };
  let getterReads = 0;
  Object.defineProperty(canonical, "sidebarWidth", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return getterReads === 1 ? 292 : 900;
    },
  });
  assert.doesNotThrow(() => decodeDashboardLayout(canonical));
  assert.deepEqual(decodeDashboardLayout(canonical), {
    kind: "invalid",
    reason: "invalid_current_layout",
  });
  assert.equal(getterReads, 0);

  const target = {
    ...createDashboardLayoutV2({
      columnOrder: [...DEFAULT_COLUMN_ORDER],
      sidebarWidth: 310,
    }),
  };
  let directReads = 0;
  const proxy = new Proxy(target, {
    get() {
      directReads += 1;
      throw new Error("decoder must not read through the proxy");
    },
  });
  const outcome = compatibleOutcome(proxy);
  target.sidebarWidth = 999;
  assert.equal(directReads, 0);
  assert.equal(outcome.layout.sidebarWidth, 310);
  assert.equal(Object.getPrototypeOf(outcome.layout), null);

  for (const unsafe of [
    new Proxy({}, { ownKeys: () => { throw new Error("ownKeys"); } }),
    new Proxy({}, { getPrototypeOf: () => { throw new Error("getPrototypeOf"); } }),
    new Proxy({ field: true }, { getOwnPropertyDescriptor: () => { throw new Error("descriptor"); } }),
  ]) {
    assert.doesNotThrow(() => decodeDashboardLayout(unsafe));
    assert.deepEqual(decodeDashboardLayout(unsafe), {
      kind: "invalid",
      reason: "invalid_current_layout",
    });
  }
});

test("decoder ignores inherited layout fields even when Object.prototype is polluted", () => {
  const pollutedKeys = ["schemaVersion", "columnOrder", "sidebarWidth"] as const;
  const previous = new Map(
    pollutedKeys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
  );
  try {
    Object.defineProperties(Object.prototype, {
      schemaVersion: { configurable: true, value: 2 },
      columnOrder: { configurable: true, value: [...DEFAULT_COLUMN_ORDER] },
      sidebarWidth: { configurable: true, value: 777 },
    });
    const outcome = compatibleOutcome({});
    assert.equal(outcome.source, "legacy");
    assert.deepEqual(Object.keys(outcome.layout), ["schemaVersion", "columnOrder"]);
    assert.equal(outcome.layout.sidebarWidth, undefined);
    assert.equal(Object.getPrototypeOf(outcome.layout), null);

    const nullPrototype = compatibleOutcome(Object.create(null));
    assert.deepEqual(Object.keys(nullPrototype.layout), ["schemaVersion", "columnOrder"]);
    assert.equal(nullPrototype.layout.sidebarWidth, undefined);
  } finally {
    for (const key of pollutedKeys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  }
});

test("known nested records reject inherited fields and normalize to own data only", () => {
  const pollutedKeys = [
    "kind",
    "name",
    "path",
    "cwd",
    "hostId",
    "line",
    "column",
    "width",
    "height",
    "x",
    "y",
    "maximized",
  ] as const;
  const previous = new Map(
    pollutedKeys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
  );
  try {
    Object.defineProperties(Object.prototype, {
      kind: { configurable: true, value: "session" },
      name: { configurable: true, value: "inherited-session" },
      path: { configurable: true, value: "/inherited" },
      cwd: { configurable: true, value: "/inherited-cwd" },
      hostId: { configurable: true, value: "inherited-host" },
      line: { configurable: true, value: 9 },
      column: { configurable: true, value: 3 },
      width: { configurable: true, value: 1440 },
      height: { configurable: true, value: 900 },
      x: { configurable: true, value: 1 },
      y: { configurable: true, value: 2 },
      maximized: { configurable: true, value: false },
    });

    const currentBase = {
      ...createDashboardLayoutV2({ columnOrder: [...DEFAULT_COLUMN_ORDER] }),
    };
    for (const poisoned of [
      { ...currentBase, selection: {} },
      { ...currentBase, pinnedItems: [{}] },
      { ...currentBase, editingFile: {} },
      { ...currentBase, diffFile: {} },
      { ...currentBase, window: {} },
    ]) {
      assert.deepEqual(decodeDashboardLayout(poisoned), {
        kind: "invalid",
        reason: "invalid_current_layout",
      });
    }

    const outcome = compatibleOutcome({
      ...currentBase,
      selection: { kind: "session", name: "own-session", ignored: true },
      editingFile: { path: "/own" },
      diffFile: { path: "own.ts", cwd: "/own" },
      window: { width: 1200, height: 800, x: 0, y: 0, maximized: false },
    });
    assert.equal(Object.getPrototypeOf(outcome.layout.selection), null);
    assert.equal(Object.getPrototypeOf(outcome.layout.editingFile), null);
    assert.equal(Object.getPrototypeOf(outcome.layout.diffFile), null);
    assert.equal(Object.getPrototypeOf(outcome.layout.window), null);
    assert.deepEqual(jsonValue(outcome.layout.selection), {
      kind: "session",
      name: "own-session",
    });
    assert.equal(outcome.layout.editingFile?.hostId, undefined);
    assert.equal(outcome.layout.editingFile?.line, undefined);
    assert.equal(outcome.layout.editingFile?.column, undefined);
    assert.equal(outcome.layout.diffFile?.hostId, undefined);
  } finally {
    for (const key of pollutedKeys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  }
});

test("known-field normalization never invokes inherited setters", () => {
  const knownKeys = ["hostId", "line", "column", "sidebarWidth"] as const;
  const previous = new Map(
    knownKeys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
  );
  const current = {
    schemaVersion: 2,
    columnOrder: [...DEFAULT_COLUMN_ORDER],
    sidebarWidth: 321,
    editingFile: {
      path: "/repo/App.tsx",
      hostId: "builder",
      line: 12,
      column: 4,
    },
    diffFile: {
      path: "App.tsx",
      cwd: "/repo",
      hostId: "builder",
    },
  };
  let setterCalls = 0;
  let outcome: Extract<DashboardLayoutDecodeOutcome, { kind: "compatible" }> | undefined;
  try {
    Object.defineProperties(Object.prototype, {
      hostId: {
        configurable: true,
        get: () => "inherited-host",
        set: () => { setterCalls += 1; },
      },
      line: {
        configurable: true,
        get: () => 999,
        set: () => { setterCalls += 1; },
      },
      column: {
        configurable: true,
        get: () => 999,
        set: () => { setterCalls += 1; },
      },
      sidebarWidth: {
        configurable: true,
        get: () => 999,
        set: () => { setterCalls += 1; },
      },
    });
    outcome = compatibleOutcome(current);
  } finally {
    for (const key of knownKeys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  }

  assert.equal(setterCalls, 0);
  assert.ok(outcome);
  assert.equal(outcome.layout.sidebarWidth, 321);
  assert.deepEqual(jsonValue(outcome.layout.editingFile), current.editingFile);
  assert.deepEqual(jsonValue(outcome.layout.diffFile), current.diffFile);
  for (const [record, keys] of [
    [outcome.layout.editingFile, ["path", "hostId", "line", "column"]],
    [outcome.layout.diffFile, ["path", "cwd", "hostId"]],
  ] as const) {
    assert.ok(record);
    assert.equal(Object.getPrototypeOf(record), null);
    for (const key of keys) {
      assert.equal(Object.prototype.hasOwnProperty.call(record, key), true);
    }
  }
});

test("stateful getters in known nested records are rejected without being invoked", () => {
  const currentBase = {
    ...createDashboardLayoutV2({ columnOrder: [...DEFAULT_COLUMN_ORDER] }),
  };
  for (const [field, requiredKey] of [
    ["selection", "kind"],
    ["editingFile", "path"],
    ["diffFile", "path"],
    ["window", "width"],
  ] as const) {
    let reads = 0;
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, requiredKey, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads;
      },
    });
    assert.deepEqual(decodeDashboardLayout({ ...currentBase, [field]: nested }), {
      kind: "invalid",
      reason: "invalid_current_layout",
    });
    assert.equal(reads, 0);
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
  assert.deepEqual(jsonValue(created.window), input.window);
});

test("extensions cannot revive known fields or reserved version markers", () => {
  const preferences = {
    columnOrder: ["main", "file", "scratch", "editor"] as const,
    sidebarWidth: 300,
  };
  const extensions = {
    schemaVersion: 99,
    version: 99,
    left: 1,
    right: 1,
    gitHeight: 1,
    sectionSplit: 1,
    automationHeight: 1,
    sessionOrder: ["poison"],
    collapsedProjects: ["poison"],
    pinnedItems: [{ kind: "session", name: "poison" }],
    automationSectionCollapsed: false,
    columnOrder: ["scratch"],
    scratchCollapsed: false,
    scratchWidth: 1,
    fileBrowserOpen: true,
    fileTreeWidth: 1,
    editorWidth: 1,
    sidebarWidth: 1,
    inspectorWidth: 1,
    sidebarOpen: false,
    sidebarView: "files",
    inspectorOpen: true,
    inspectorTab: "git",
    selection: { kind: "session", name: "poison" },
    editingFile: { path: "poison" },
    diffFile: { path: "poison", cwd: "poison" },
    window: { width: 1, height: 1, x: 0, y: 0, maximized: false },
    futureNested: { keep: [1, { two: true }] },
  };
  const preferencesSnapshot = structuredClone(preferences);
  const extensionsSnapshot = structuredClone(extensions);

  const created = createDashboardLayoutV2(
    { ...preferences, columnOrder: [...preferences.columnOrder] },
    extensions,
  );

  assert.deepEqual(preferences, preferencesSnapshot);
  assert.deepEqual(extensions, extensionsSnapshot);
  assert.equal(created.schemaVersion, 2);
  assert.equal("version" in created, false);
  assert.equal(created.sidebarWidth, 300);
  assert.equal(created.inspectorWidth, undefined);
  assert.equal(created.left, undefined);
  assert.deepEqual(created.columnOrder, preferences.columnOrder);
  assert.deepEqual(created.futureNested, extensions.futureNested);
  assert.deepEqual(Object.keys(created), [
    "futureNested",
    "schemaVersion",
    "columnOrder",
    "sidebarWidth",
  ]);
});

test("only own enumerable unknown keys become extensions", () => {
  const extensions = Object.create({ inheritedFuture: true }) as Record<string, unknown>;
  Object.defineProperty(extensions, "hiddenFuture", {
    enumerable: false,
    value: true,
  });
  extensions.visibleFuture = { nested: true };

  const created = createDashboardLayoutV2(
    { columnOrder: [...DEFAULT_COLUMN_ORDER] },
    extensions,
  );
  assert.deepEqual(created.visibleFuture, { nested: true });
  assert.equal("hiddenFuture" in created, false);
  assert.equal("inheritedFuture" in created, false);
});

test("decoder and creator preserve prototype-sensitive extension names as own data", () => {
  const stored = {
    ...createDashboardLayoutV2({ columnOrder: [...DEFAULT_COLUMN_ORDER] }),
  } as Record<string, unknown>;
  Object.defineProperty(stored, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { retained: "proto" },
    writable: true,
  });
  Object.defineProperty(stored, "constructor", {
    configurable: true,
    enumerable: true,
    value: { retained: "constructor" },
    writable: true,
  });
  Object.defineProperty(stored, "hiddenFuture", {
    configurable: true,
    enumerable: false,
    value: "hidden",
  });

  const outcome = compatibleOutcome(stored);
  assert.equal(Object.getPrototypeOf(outcome.extensions), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(outcome.extensions, "__proto__"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(outcome.extensions, "constructor"), true);
  assert.deepEqual(outcome.extensions.__proto__, { retained: "proto" });
  assert.deepEqual(outcome.extensions.constructor, { retained: "constructor" });
  assert.equal("hiddenFuture" in outcome.extensions, false);

  const created = createDashboardLayoutV2(
    { columnOrder: [...DEFAULT_COLUMN_ORDER] },
    outcome.extensions,
  );
  assert.equal(Object.getPrototypeOf(created), null);
  assert.equal(Object.prototype.hasOwnProperty.call(created, "__proto__"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(created, "constructor"), true);
  assert.deepEqual(created.__proto__, { retained: "proto" });
  assert.deepEqual(created.constructor, { retained: "constructor" });
});

test("layout persistence preserves accepted v2 extensions while changing known fields", async () => {
  const stored = {
    ...createDashboardLayoutV2({
      columnOrder: [...DEFAULT_COLUMN_ORDER],
      sidebarWidth: 280,
    }),
    futureNested: { inspector: { mode: "graph" } },
  };
  const { backend, transport } = createFakeDashboardBackend({
    load_layout: () => stored,
    save_layout: () => undefined,
  });

  const loaded = await loadDashboardLayoutPreferences(backend);
  assert.equal(loaded.kind, "compatible");
  assert.ok(loaded.kind === "compatible");
  await saveDashboardLayoutPreferences(
    backend,
    { ...loaded.layout, sidebarWidth: 344 },
    loaded.extensions,
  );

  assert.equal(transport.calls.length, 2);
  assert.deepEqual(transport.calls[0], { command: "load_layout", args: undefined });
  assert.equal(transport.calls[1]?.command, "save_layout");
  assert.deepEqual(
    { ...(transport.calls[1]?.args as { layout: DashboardLayoutV2 }).layout },
    {
      futureNested: stored.futureNested,
      schemaVersion: 2,
      columnOrder: [...DEFAULT_COLUMN_ORDER],
      sidebarWidth: 344,
    },
  );
});

test("the renderer delegates layout IO to the versioned layout boundary", () => {
  const source = rendererImplementationSourceContaining(
    "useLayoutPreferences()",
    "loadLayoutPreferences()",
    "saveLayoutPreferences({",
  ).source;

  assert.match(source, /const \{ loadLayoutPreferences, saveLayoutPreferences \} = useLayoutPreferences\(\);/);
  assert.match(source, /loadLayoutPreferences\(\)/);
  assert.match(source, /saveLayoutPreferences\(\{/);
  assert.doesNotMatch(source, /dashboardBackend\.persistence\.(?:loadLayout|saveLayout)/);
});
