import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import {
  classifyDashboardLayoutPersistenceFailure,
  type DashboardLayoutPersistenceOutcome,
} from "../src/dashboard/layoutPersistence.ts";
import { buildDashboardLayoutSnapshot } from "../src/dashboard/layoutSnapshot.ts";

const INITIAL_REVISION = "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY";
const NEXT_REVISION = "twlr1_HfyBm0VsDGpTixmc8n6KpBqTiqpSf26rY03Pph07iM8";

type EffectCallback = () => void | (() => void);
type CapturedEffect = { callback: EffectCallback; dependencies: unknown };

type LayoutGate = {
  attempt: number;
  backend: object | null;
  writable: boolean;
  extensions: Readonly<Record<string, unknown>>;
};

type LayoutState =
  | { phase: "hydrating" }
  | { phase: "writable"; source: "legacy" | "current" }
  | { phase: "blocked"; reason: string; version?: number; invalidReason?: string };

type CapturedAuthorization = {
  attempt: number;
  write(snapshot: Record<string, unknown>): Promise<void>;
  classifyFailure(error: unknown): "retry" | "block";
};

type DashboardLayoutHookModule = {
  useDashboardLayoutHydrationPhase: (
    layout: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => void;
  useDashboardLayoutPersistencePhase: (
    layout: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => void;
};

function loadDashboardLayoutHook(): {
  effects: CapturedEffect[];
  hooks: DashboardLayoutHookModule;
} {
  const effects: CapturedEffect[] = [];
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardLayout.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useDashboardLayout.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(output.diagnostics ?? [], []);

  const modules = new Map<string, unknown>([
    [
      "react",
      {
        useEffect: (callback: EffectCallback, dependencies: unknown) => {
          effects.push({ callback, dependencies });
        },
        useRef: () => assert.fail("state hook must not execute in phase tests"),
        useState: () => assert.fail("state hook must not execute in phase tests"),
      },
    ],
    [
      "../layout/panelGeometry",
      {
        DEFAULT_INSPECTOR_WIDTH: 420,
        DEFAULT_SIDEBAR_WIDTH: 280,
        normalizeDashboardPanelWidths: (
          _viewportWidth: number,
          sidebarWidth: number,
          inspectorWidth: number,
        ) => ({ sidebarWidth, inspectorWidth }),
        viewportTierForWidth: (width: number) =>
          width < 960 ? "compact" : width < 1440 ? "drawer" : "wide",
      },
    ],
    ["../layout/schema", { DEFAULT_COLUMN_ORDER: ["file", "main", "scratch", "editor"] }],
    [
      "../layout/scratchGeometry",
      {
        DEFAULT_SCRATCH_PANEL_WIDTH: 360,
        clampScratchPanelWidth: (width: number) => width,
      },
    ],
    [
      "../model/selection",
      {
        pendingRestoredCatalogSelection: (selection: unknown, generation: number) => ({
          generation,
          selection,
        }),
      },
    ],
    [
      "../layoutSaveCoordinator",
      { createLayoutSaveCoordinator: () => assert.fail("state hook must not execute") },
    ],
    [
      "../layoutClosePersistence",
      { flushDashboardLayoutOnClose: () => assert.fail("window phase is not executed") },
    ],
    ["../layoutSnapshot", { buildDashboardLayoutSnapshot }],
    [
      "../windowCaptureCoordinator",
      {
        createWindowCaptureCoordinator: () => assert.fail("window phase is not executed"),
        windowLayoutFromCapture: () => assert.fail("window phase is not executed"),
      },
    ],
    ["../layoutPersistence", { classifyDashboardLayoutPersistenceFailure }],
    ["./useLayoutPreferences", { useLayoutPreferences: () => assert.fail("not used") }],
  ]);
  const module = { exports: {} as Record<string, unknown> };
  const requireModule = (specifier: string): unknown => {
    assert.equal(modules.has(specifier), true, `unexpected runtime module ${specifier}`);
    return modules.get(specifier);
  };
  const evaluate = new Function("require", "exports", "module", output.outputText);
  evaluate(requireModule, module.exports, module);
  return {
    effects,
    hooks: module.exports as DashboardLayoutHookModule,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function withRuntimeGlobals<T>(run: (timers: Map<number, () => void>) => Promise<T>): Promise<T> {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { innerWidth: 1440 },
    writable: true,
  });
  globalThis.setTimeout = ((callback: TimerHandler) => {
    assert.equal(typeof callback, "function");
    const id = nextTimer++;
    timers.set(id, callback as () => void);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;

  return run(timers).finally(() => {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete (globalThis as { window?: unknown }).window;
  });
}

const DOMAIN_SETTERS = [
  "setAutomationSectionCollapsed",
  "setCollapsedProjects",
  "setDiffFile",
  "setEditingFile",
  "setInspectorOpen",
  "setInspectorWidth",
  "setPendingCatalogSelection",
  "setPinnedItems",
  "setScratchCollapsed",
  "setScratchWidth",
  "setSelection",
  "setSessionOrder",
  "setSidebarOpen",
  "setSidebarView",
  "setSidebarWidth",
  "setWindowLayout",
] as const;

function layoutFixture(
  load: () => Promise<DashboardLayoutPersistenceOutcome>,
  save: (...args: unknown[]) => Promise<unknown> = async () => ({
    revision: NEXT_REVISION,
    unchanged: false,
  }),
) {
  const calls: Array<{ gateWritable: boolean; name: string; value: unknown }> = [];
  const authorizations: CapturedAuthorization[] = [];
  const enqueues: Array<{ attempt: number; snapshot: Record<string, unknown> }> = [];
  const gateRef: { current: LayoutGate } = {
    current: { attempt: 0, backend: null, writable: false, extensions: {} },
  };
  let state: LayoutState = { phase: "hydrating" };
  const saves: unknown[][] = [];
  const setter = (name: string) => (value: unknown) => {
    calls.push({ gateWritable: gateRef.current.writable, name, value });
  };
  const layout: Record<string, unknown> = {
    automationSectionCollapsed: true,
    collapsedProjects: ["local:one"],
    inspectorOpen: true,
    inspectorOpenPreferenceRef: { current: false },
    inspectorWidth: 420,
    layoutSaveCoordinator: {
      beginAttempt: (attempt: number) => {
        calls.push({
          gateWritable: gateRef.current.writable,
          name: "coordinator.beginAttempt",
          value: attempt,
        });
      },
      authorize: (authorization: CapturedAuthorization) => {
        authorizations.push(authorization);
        calls.push({
          gateWritable: gateRef.current.writable,
          name: "coordinator.authorize",
          value: authorization,
        });
      },
      enqueue: (attempt: number, snapshot: Record<string, unknown>) => {
        enqueues.push({ attempt, snapshot });
        calls.push({
          gateWritable: gateRef.current.writable,
          name: "coordinator.enqueue",
          value: { attempt, snapshot },
        });
      },
      block: (attempt: number) => {
        calls.push({
          gateWritable: gateRef.current.writable,
          name: "coordinator.block",
          value: attempt,
        });
      },
      stop: () => assert.fail("production phases must not stop the shared coordinator"),
    },
    layoutPersistenceGateRef: gateRef,
    latestSnapshotCutRef: { current: null },
    layoutPersistenceState: state,
    loadLayoutPreferences: load,
    panelWidthsRef: { current: { sidebarWidth: 280, inspectorWidth: 420 } },
    pinnedItems: [{ kind: "session", name: "local:one" }],
    saveLayoutPreferences: (...args: unknown[]) => {
      saves.push(args);
      return save(...args);
    },
    scratchCollapsed: false,
    scratchWidth: 380,
    sessionOrder: ["local:one"],
    sidebarOpen: true,
    sidebarOpenPreferenceRef: { current: true },
    sidebarView: "files",
    sidebarWidth: 300,
    windowLayout: { width: 1400, height: 900, x: 10, y: 20, maximized: false },
    setLayoutPersistenceState: (value: LayoutState) => {
      state = value;
      calls.push({
        gateWritable: gateRef.current.writable,
        name: "setLayoutPersistenceState",
        value,
      });
    },
    setWindowRestoreReady: setter("setWindowRestoreReady"),
    setLayoutSaveError: setter("setLayoutSaveError"),
  };
  for (const name of DOMAIN_SETTERS) {
    if (!(name in layout)) layout[name] = setter(name);
  }
  return {
    authorizations,
    calls,
    enqueues,
    gateRef,
    layout,
    saves,
    state: () => state,
  };
}

function hydrationOptions(
  calls: Array<{ gateWritable: boolean; name: string; value: unknown }>,
  gateRef: { current: LayoutGate },
): Record<string, unknown> {
  const setter = (name: string) => (value: unknown) => {
    calls.push({ gateWritable: gateRef.current.writable, name, value });
  };
  return {
    dashboardBackend: {},
    getLatestSuccessfulRefreshGeneration: () => 17,
    setSelection: setter("setSelection"),
    setPendingCatalogSelection: setter("setPendingCatalogSelection"),
    setEditingFile: setter("setEditingFile"),
    setDiffFile: setter("setDiffFile"),
  };
}

function registerSingleEffect(
  effects: CapturedEffect[],
  register: () => void,
): CapturedEffect {
  effects.length = 0;
  register();
  assert.equal(effects.length, 1);
  return effects[0];
}

function domainCalls(
  calls: Array<{ gateWritable: boolean; name: string; value: unknown }>,
) {
  return calls.filter(({ name }) => (DOMAIN_SETTERS as readonly string[]).includes(name));
}

test("read failures and incompatible layouts never hydrate or schedule a save", async () => {
  await withRuntimeGlobals(async (timers) => {
    const blockedCases: Array<{
      load: () => Promise<DashboardLayoutPersistenceOutcome>;
      expected: LayoutState;
    }> = [
      {
        load: () => Promise.reject(new Error("read failed")),
        expected: { phase: "blocked", reason: "read_failed" },
      },
      {
        load: () => Promise.resolve({
          kind: "future",
          marker: "schemaVersion",
          version: 3,
          revision: INITIAL_REVISION,
        }),
        expected: { phase: "blocked", reason: "future_schema", version: 3 },
      },
      {
        load: () => Promise.resolve({
          kind: "invalid",
          reason: "invalid_current_layout",
          revision: INITIAL_REVISION,
        }),
        expected: {
          phase: "blocked",
          reason: "invalid_layout",
          invalidReason: "invalid_current_layout",
        },
      },
    ];

    for (const blockedCase of blockedCases) {
      timers.clear();
      const { effects, hooks } = loadDashboardLayoutHook();
      const fixture = layoutFixture(blockedCase.load);
      const hydration = registerSingleEffect(effects, () =>
        hooks.useDashboardLayoutHydrationPhase(
          fixture.layout,
          hydrationOptions(fixture.calls, fixture.gateRef),
        )
      );
      hydration.callback();
      await flushPromises();

      assert.deepEqual(fixture.state(), blockedCase.expected);
      assert.equal(fixture.gateRef.current.writable, false);
      assert.deepEqual(domainCalls(fixture.calls), []);
      assert.deepEqual(
        fixture.calls
          .filter(({ name }) => name.startsWith("coordinator."))
          .map(({ name, value }) => [name, value]),
        [
          ["coordinator.beginAttempt", 1],
          ["coordinator.block", 1],
        ],
      );
      assert.equal(fixture.authorizations.length, 0);
      assert.equal(fixture.enqueues.length, 0);
      assert.deepEqual(
        fixture.calls.filter(({ name }) => name === "setWindowRestoreReady"),
        [{ gateWritable: false, name: "setWindowRestoreReady", value: true }],
      );

      Object.assign(fixture.layout, {
        layoutPersistenceState: fixture.state(),
        selection: { kind: "session", name: "changed" },
        sidebarWidth: 555,
        windowLayout: { width: 900, height: 700, x: 1, y: 2, maximized: false },
      });
      registerSingleEffect(effects, () =>
        hooks.useDashboardLayoutPersistencePhase(fixture.layout, {
          diffFile: null,
          editingFile: null,
          selection: { kind: "session", name: "changed" },
        })
      ).callback();
      assert.equal(timers.size, 0);
      assert.equal(fixture.saves.length, 0);
      assert.equal(fixture.enqueues.length, 0);
    }
  });
});

test("only compatible hydration authorizes persistence and retains extensions", async () => {
  await withRuntimeGlobals(async (timers) => {
    const extensions = { futureNested: { mode: "graph" } };
    const outcome: DashboardLayoutPersistenceOutcome = {
      kind: "compatible",
      source: "current",
      extensions,
      revision: INITIAL_REVISION,
      layout: {
        schemaVersion: 2,
        columnOrder: ["file", "main", "scratch", "editor"],
        sidebarWidth: 312,
        inspectorWidth: 432,
      },
    };
    const { effects, hooks } = loadDashboardLayoutHook();
    const fixture = layoutFixture(() => Promise.resolve(outcome));
    const hydration = registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutHydrationPhase(
        fixture.layout,
        hydrationOptions(fixture.calls, fixture.gateRef),
      )
    );
    hydration.callback();
    await flushPromises();

    assert.deepEqual(fixture.state(), { phase: "writable", source: "current" });
    assert.equal(fixture.gateRef.current.writable, true);
    assert.equal(fixture.gateRef.current.extensions, extensions);
    assert.equal(fixture.authorizations.length, 1);
    assert.equal(fixture.authorizations[0].attempt, 1);
    assert.equal(
      fixture.authorizations[0].classifyFailure({
        code: "LAYOUT_IO_ERROR",
        message: "offline",
        retryable: true,
      }),
      "retry",
    );
    assert.equal(fixture.authorizations[0].classifyFailure(new Error("unknown")), "block");
    assert.equal(
      fixture.authorizations[0].classifyFailure({
        code: "LAYOUT_REVISION_CONFLICT",
        message: "conflict",
        retryable: false,
        currentRevision: NEXT_REVISION,
      }),
      "block",
    );
    assert.equal(
      fixture.authorizations[0].classifyFailure({
        code: "LAYOUT_NEW_NON_RETRYABLE_CODE",
        message: "new native failure",
        retryable: false,
      }),
      "block",
    );
    let getterReads = 0;
    const accessorFailure = Object.create(null) as { retryable?: boolean };
    Object.defineProperty(accessorFailure, "retryable", {
      enumerable: true,
      get() {
        getterReads += 1;
        return false;
      },
    });
    assert.equal(fixture.authorizations[0].classifyFailure(accessorFailure), "block");
    assert.equal(getterReads, 0);
    let proxyReads = 0;
    const proxyFailure = new Proxy(
      { retryable: false },
      {
        get(target, property, receiver) {
          proxyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    assert.equal(fixture.authorizations[0].classifyFailure(proxyFailure), "block");
    assert.equal(proxyReads, 0);
    assert.equal(
      fixture.authorizations[0].classifyFailure(
        Object.create({ retryable: false }) as object,
      ),
      "block",
    );
    const writableCalls = fixture.calls.filter(
      ({ name, value }) =>
        name === "setLayoutPersistenceState" &&
        (value as { phase?: string }).phase === "writable",
    );
    const writableCall = writableCalls[writableCalls.length - 1];
    assert.ok(writableCall);
    assert.equal(writableCall.gateWritable, true);
    assert.equal(
      domainCalls(fixture.calls).every(({ gateWritable }) => !gateWritable),
      true,
    );
    const authorizeIndex = fixture.calls.findIndex(
      ({ name }) => name === "coordinator.authorize",
    );
    const domainIndices = fixture.calls.flatMap(({ name }, index) =>
      (DOMAIN_SETTERS as readonly string[]).includes(name) ? [index] : []
    );
    assert.equal(domainIndices.every((index) => index < authorizeIndex), true);
    assert.equal(fixture.calls[authorizeIndex].gateWritable, true);

    Object.assign(fixture.layout, { layoutPersistenceState: fixture.state() });
    const persistence = registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutPersistencePhase(fixture.layout, {
        diffFile: null,
        editingFile: { path: "/repo/App.tsx", hostId: null },
        selection: { kind: "session", name: "local:one" },
      })
    );
    persistence.callback();
    assert.equal(timers.size, 0);
    assert.equal(fixture.enqueues.length, 1);
    assert.equal(fixture.enqueues[0].attempt, 1);
    assert.deepEqual(fixture.enqueues[0].snapshot, {
      left: 300,
      sidebarWidth: 300,
      inspectorWidth: 420,
      sidebarOpen: true,
      inspectorOpen: false,
      sidebarView: "files",
      sessionOrder: ["local:one"],
      collapsedProjects: ["local:one"],
      pinnedItems: [{ kind: "session", name: "local:one" }],
      automationSectionCollapsed: true,
      columnOrder: ["file", "main", "scratch", "editor"],
      scratchCollapsed: false,
      scratchWidth: 380,
      fileBrowserOpen: true,
      selection: { kind: "session", name: "local:one" },
      editingFile: { path: "/repo/App.tsx", hostId: null },
      diffFile: null,
      window: { width: 1400, height: 900, x: 10, y: 20, maximized: false },
    });
    await fixture.authorizations[0].write(fixture.enqueues[0].snapshot);
    assert.equal(fixture.saves.length, 1);
    assert.equal(fixture.saves[0][0], fixture.enqueues[0].snapshot);
    assert.equal(fixture.saves[0][1], INITIAL_REVISION);
    assert.equal(fixture.saves[0][2], extensions);
    await fixture.authorizations[0].write(fixture.enqueues[0].snapshot);
    assert.equal(fixture.saves.length, 2);
    assert.equal(fixture.saves[1][1], NEXT_REVISION);
    assert.equal(fixture.saves[1][2], extensions);

    fixture.gateRef.current = {
      attempt: 2,
      backend: null,
      writable: false,
      extensions: {},
    };
    await fixture.authorizations[0].write({ columnOrder: [] });
    assert.equal(fixture.saves.length, 2, "authorization rechecks the A gate before writing");
  });
});

test("authorization keeps the loaded revision across ambiguous failure until a response advances it", async () => {
  await withRuntimeGlobals(async () => {
    const saveResults = [
      () => Promise.reject({
        code: "LAYOUT_IO_ERROR",
        message: "response lost after commit",
        retryable: true,
      }),
      () => Promise.resolve({ revision: NEXT_REVISION, unchanged: true }),
      () => Promise.resolve({ revision: NEXT_REVISION, unchanged: true }),
    ];
    const outcome: DashboardLayoutPersistenceOutcome = {
      kind: "compatible",
      source: "current",
      extensions: { retained: true },
      revision: INITIAL_REVISION,
      layout: {
        schemaVersion: 2,
        columnOrder: ["file", "main", "scratch", "editor"],
      },
    };
    const { effects, hooks } = loadDashboardLayoutHook();
    const fixture = layoutFixture(
      () => Promise.resolve(outcome),
      async () => {
        const result = saveResults.shift();
        assert.ok(result);
        return await result();
      },
    );
    registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutHydrationPhase(
        fixture.layout,
        hydrationOptions(fixture.calls, fixture.gateRef),
      )
    ).callback();
    await flushPromises();
    assert.equal(fixture.authorizations.length, 1);
    const writer = fixture.authorizations[0];
    const snapshot = { columnOrder: ["file", "main", "scratch", "editor"] };

    await assert.rejects(writer.write(snapshot));
    assert.equal(fixture.saves[0][1], INITIAL_REVISION);
    await writer.write(snapshot);
    assert.equal(fixture.saves[1][1], INITIAL_REVISION);
    await writer.write(snapshot);
    assert.equal(fixture.saves[2][1], NEXT_REVISION);
  });
});

test("disposed and superseded hydration attempts cannot authorize", async () => {
  await withRuntimeGlobals(async () => {
    const compatible = (source: "legacy" | "current"): DashboardLayoutPersistenceOutcome => ({
      kind: "compatible",
      source,
      extensions: { source },
      revision: INITIAL_REVISION,
      layout: {
        schemaVersion: 2,
        columnOrder: ["file", "main", "scratch", "editor"],
      },
    });

    {
      const pending = deferred<DashboardLayoutPersistenceOutcome>();
      const { effects, hooks } = loadDashboardLayoutHook();
      const fixture = layoutFixture(() => pending.promise);
      const cleanup = registerSingleEffect(effects, () =>
        hooks.useDashboardLayoutHydrationPhase(
          fixture.layout,
          hydrationOptions(fixture.calls, fixture.gateRef),
        )
      ).callback();
      assert.equal(typeof cleanup, "function");
      (cleanup as () => void)();
      pending.resolve(compatible("current"));
      await flushPromises();
      assert.equal(fixture.gateRef.current.writable, false);
      assert.equal(fixture.gateRef.current.attempt, 2);
      assert.deepEqual(domainCalls(fixture.calls), []);
      assert.equal(fixture.authorizations.length, 0);
      assert.deepEqual(
        fixture.calls
          .filter(({ name }) => name.startsWith("coordinator."))
          .map(({ name, value }) => [name, value]),
        [
          ["coordinator.beginAttempt", 1],
          ["coordinator.block", 1],
        ],
      );
      assert.equal(
        fixture.calls.some(
          ({ value }) => (value as { phase?: string } | null)?.phase === "writable",
        ),
        false,
      );
    }

    {
      const first = deferred<DashboardLayoutPersistenceOutcome>();
      const second = deferred<DashboardLayoutPersistenceOutcome>();
      const loads = [first.promise, second.promise];
      const { effects, hooks } = loadDashboardLayoutHook();
      const fixture = layoutFixture(() => {
        const next = loads.shift();
        assert.ok(next);
        return next;
      });
      registerSingleEffect(effects, () =>
        hooks.useDashboardLayoutHydrationPhase(
          fixture.layout,
          hydrationOptions(fixture.calls, fixture.gateRef),
        )
      ).callback();
      registerSingleEffect(effects, () =>
        hooks.useDashboardLayoutHydrationPhase(
          fixture.layout,
          hydrationOptions(fixture.calls, fixture.gateRef),
        )
      ).callback();
      first.resolve(compatible("legacy"));
      await flushPromises();
      assert.equal(fixture.gateRef.current.writable, false);
      assert.deepEqual(domainCalls(fixture.calls), []);
      assert.equal(fixture.authorizations.length, 0);

      second.resolve(compatible("current"));
      await flushPromises();
      assert.equal(fixture.gateRef.current.writable, true);
      assert.deepEqual(fixture.state(), { phase: "writable", source: "current" });
      assert.deepEqual(fixture.gateRef.current.extensions, { source: "current" });
      assert.equal(fixture.authorizations.length, 1);
    }
  });
});

test("persistence requires matching state and gate before enqueuing an exact snapshot", async () => {
  await withRuntimeGlobals(async (timers) => {
    const { effects, hooks } = loadDashboardLayoutHook();
    const fixture = layoutFixture(() => Promise.reject(new Error("unused")));
    const options = { diffFile: null, editingFile: null, selection: null };

    fixture.gateRef.current = {
      attempt: 5,
      backend: null,
      writable: false,
      extensions: {},
    };
    Object.assign(fixture.layout, {
      layoutPersistenceState: { phase: "writable", source: "current" },
    });
    registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutPersistencePhase(fixture.layout, options)
    ).callback();
    assert.equal(timers.size, 0);
    assert.equal(fixture.enqueues.length, 0);

    fixture.gateRef.current = {
      attempt: 6,
      backend: null,
      writable: true,
      extensions: {},
    };
    Object.assign(fixture.layout, {
      layoutPersistenceState: { phase: "blocked", reason: "read_failed" },
    });
    registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutPersistencePhase(fixture.layout, options)
    ).callback();
    assert.equal(timers.size, 0);
    assert.equal(fixture.enqueues.length, 0);

    fixture.gateRef.current = {
      attempt: 7,
      backend: null,
      writable: true,
      extensions: {},
    };
    Object.assign(fixture.layout, {
      layoutPersistenceState: { phase: "writable", source: "current" },
    });
    registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutPersistencePhase(fixture.layout, options)
    ).callback();
    assert.equal(timers.size, 0);
    assert.equal(fixture.enqueues.length, 1);
    assert.equal(fixture.enqueues[0].attempt, 7);
    assert.equal(fixture.enqueues[0].snapshot.sidebarWidth, 300);
    assert.deepEqual(fixture.enqueues[0].snapshot.columnOrder, [
      "file",
      "main",
      "scratch",
      "editor",
    ]);
    assert.equal(fixture.saves.length, 0);
  });
});

test("each render publishes the latest snapshot cut before any persistence effect runs", async () => {
  await withRuntimeGlobals(async () => {
    const { effects, hooks } = loadDashboardLayoutHook();
    const fixture = layoutFixture(() => Promise.reject(new Error("unused")));
    fixture.gateRef.current = {
      attempt: 9,
      backend: null,
      writable: true,
      extensions: {},
    };
    Object.assign(fixture.layout, {
      layoutPersistenceState: { phase: "writable", source: "current" },
    });

    const oldEffect = registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutPersistencePhase(fixture.layout, {
        diffFile: null,
        editingFile: null,
        selection: { kind: "session", name: "old" },
      })
    );
    registerSingleEffect(effects, () =>
      hooks.useDashboardLayoutPersistencePhase(fixture.layout, {
        diffFile: null,
        editingFile: { path: "/repo/latest.ts" },
        selection: { kind: "session", name: "latest" },
      })
    );

    oldEffect.callback();
    assert.equal(fixture.enqueues.length, 1);
    assert.equal(fixture.enqueues[0].attempt, 9);
    assert.deepEqual(fixture.enqueues[0].snapshot.selection, {
      kind: "session",
      name: "latest",
    });
    assert.deepEqual(fixture.enqueues[0].snapshot.editingFile, {
      path: "/repo/latest.ts",
    });
  });
});
