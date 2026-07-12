import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type { DashboardCloseHandler } from "../src/platform/types.ts";

type CapturedEffect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
};

type CloseObservation = {
  active: boolean;
  cut: unknown;
};

function loadCapturePhase() {
  const effects: CapturedEffect[] = [];
  const closeObservations: CloseObservation[] = [];
  const coordinators: Array<{ starts: number; stops: number }> = [];
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
  });
  const modules = new Map<string, unknown>([
    [
      "react",
      {
        useEffect: (callback: CapturedEffect["callback"], dependencies: unknown[]) => {
          effects.push({ callback, dependencies });
        },
        useRef: () => assert.fail("state hook is not executed"),
        useState: () => assert.fail("state hook is not executed"),
      },
    ],
    [
      "../layout/panelGeometry",
      {
        DEFAULT_INSPECTOR_WIDTH: 420,
        DEFAULT_SIDEBAR_WIDTH: 280,
        normalizeDashboardPanelWidths: () => ({ sidebarWidth: 280, inspectorWidth: 420 }),
        viewportTierForWidth: () => "wide",
      },
    ],
    ["../layout/scratchGeometry", {
      DEFAULT_SCRATCH_PANEL_WIDTH: 360,
      clampScratchPanelWidth: (value: number) => value,
    }],
    ["../layoutClosePersistence", {
      flushDashboardLayoutOnClose: async (options: {
        getLatestSnapshotCut(): unknown;
        isActive(): boolean;
      }) => {
        closeObservations.push({
          active: options.isActive(),
          cut: options.getLatestSnapshotCut(),
        });
      },
    }],
    ["../layoutPersistence", { classifyDashboardLayoutPersistenceFailure: () => "block" }],
    ["../layoutSaveCoordinator", {
      createLayoutSaveCoordinator: () => assert.fail("state hook is not executed"),
    }],
    ["../layoutSnapshot", {
      buildDashboardLayoutSnapshot: () => assert.fail("persistence phase is not executed"),
    }],
    ["../model/selection", { pendingRestoredCatalogSelection: () => null }],
    ["../windowCaptureCoordinator", {
      createWindowCaptureCoordinator: () => {
        const state = { starts: 0, stops: 0 };
        coordinators.push(state);
        return {
          start: () => { state.starts += 1; },
          stop: () => { state.stops += 1; },
        };
      },
      windowLayoutFromCapture: () => assert.fail("live capture does not publish"),
    }],
    ["./useLayoutPreferences", { useLayoutPreferences: () => assert.fail("not used") }],
  ]);
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("require", "exports", "module", output.outputText);
  evaluate((specifier: string) => {
    assert.equal(modules.has(specifier), true, `unexpected module ${specifier}`);
    return modules.get(specifier);
  }, module.exports, module);
  return {
    closeObservations,
    coordinators,
    effects,
    useDashboardWindowCapturePhase: module.exports.useDashboardWindowCapturePhase as (
      layout: Record<string, unknown>,
      backend: DashboardBackend,
    ) => void,
  };
}

function backendHarness() {
  const handlers: DashboardCloseHandler[] = [];
  let unbinds = 0;
  const target = {};
  const backend = {
    window: {
      current: () => target,
      closeLifecycle: {
        bind(handler: DashboardCloseHandler) {
          handlers.push(handler);
          return () => { unbinds += 1; };
        },
      },
    },
  } as unknown as DashboardBackend;
  return { backend, handlers, target, unbinds: () => unbinds };
}

function layoutHarness() {
  const backendRef = { current: null as DashboardBackend | null };
  const cut = { attempt: 3, snapshot: { columnOrder: [] } };
  return {
    activeCloseBackendRef: backendRef,
    latestSnapshotCutRef: { current: cut },
    layoutPersistenceGateRef: { current: { attempt: 3, backend: null, writable: true } },
    layoutSaveCoordinator: {},
    setWindowLayout: () => {},
    windowRestoreReady: true,
  };
}

test("StrictMode cleanup and setup without a render keeps the current backend fence", async () => {
  const loaded = loadCapturePhase();
  const native = backendHarness();
  const layout = layoutHarness();
  loaded.useDashboardWindowCapturePhase(layout, native.backend);
  assert.strictEqual(layout.activeCloseBackendRef.current, native.backend);
  assert.equal(loaded.effects.length, 1);

  const firstCleanup = loaded.effects[0].callback();
  assert.equal(typeof firstCleanup, "function");
  (firstCleanup as () => void)();
  assert.strictEqual(layout.activeCloseBackendRef.current, native.backend);
  const secondCleanup = loaded.effects[0].callback();
  assert.equal(native.handlers.length, 2);

  await native.handlers[0](new AbortController().signal);
  await native.handlers[1](new AbortController().signal);
  assert.deepEqual(loaded.closeObservations, [
    { active: false, cut: layout.latestSnapshotCutRef.current },
    { active: true, cut: layout.latestSnapshotCutRef.current },
  ]);
  assert.deepEqual(loaded.coordinators, [
    { starts: 1, stops: 1 },
    { starts: 1, stops: 0 },
  ]);
  assert.equal(native.unbinds(), 1);
  (secondCleanup as () => void)();
  assert.equal(native.unbinds(), 2);
});

test("a backend render switch immediately hides the old handler cut", async () => {
  const loaded = loadCapturePhase();
  const oldNative = backendHarness();
  const nextNative = backendHarness();
  const layout = layoutHarness();
  loaded.useDashboardWindowCapturePhase(layout, oldNative.backend);
  const oldCleanup = loaded.effects[0].callback();

  loaded.useDashboardWindowCapturePhase(layout, nextNative.backend);
  assert.strictEqual(layout.activeCloseBackendRef.current, nextNative.backend);
  await oldNative.handlers[0](new AbortController().signal);
  assert.deepEqual(loaded.closeObservations, [{ active: true, cut: null }]);
  (oldCleanup as () => void)();
  assert.strictEqual(layout.activeCloseBackendRef.current, nextNative.backend);
});

test("a backend without close capability keeps live capture behavior", () => {
  const loaded = loadCapturePhase();
  const layout = layoutHarness();
  const backend = {
    window: { current: () => ({}) },
  } as unknown as DashboardBackend;
  loaded.useDashboardWindowCapturePhase(layout, backend);
  const cleanup = loaded.effects[0].callback();
  assert.deepEqual(loaded.coordinators, [{ starts: 1, stops: 0 }]);
  assert.deepEqual(loaded.closeObservations, []);
  (cleanup as () => void)();
  assert.deepEqual(loaded.coordinators, [{ starts: 1, stops: 1 }]);
});
