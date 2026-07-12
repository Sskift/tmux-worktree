import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";
import {
  samePlainTerminals,
  sameSessionActivity,
  sameSessions,
} from "../src/dashboard/model/catalogEquality.ts";
import { workspaceCatalogRefresh } from "../src/dashboard/hooks/workspaceCatalogRefresh.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type { DashboardCatalogSnapshot, Session } from "../src/platform/domainTypes.ts";

type Effect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

type CatalogResult = {
  sessions: Session[];
  catalogRefreshGeneration: number;
  error: string | null;
  refresh(): Promise<void>;
  removeSession(name: string): void;
  reportError(error: unknown): void;
  getLatestStartedRefreshGeneration(): number;
  getLatestSuccessfulRefreshGeneration(): number;
  ownerPhase: unknown;
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function loadCatalogHookHarness() {
  const states: unknown[] = [];
  const callbacks: Array<{ dependencies: unknown[]; value: unknown } | undefined> = [];
  const committed = new Map<number, Effect>();
  let pending = new Map<number, Effect>();
  let cursor = 0;
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useWorkspaceCatalog.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useWorkspaceCatalog.ts",
  });
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) {
        states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const setState = (next: unknown) => {
        states[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(states[index])
          : next;
      };
      return [states[index], setState];
    },
    useCallback(value: unknown, dependencies: unknown[]) {
      const index = cursor++;
      const current = callbacks[index];
      if (!current || !sameDependencies(current.dependencies, dependencies)) {
        callbacks[index] = { dependencies, value };
      }
      return callbacks[index]?.value;
    },
    useLayoutEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pending.set(cursor++, { callback, dependencies });
    },
  };
  const modules = new Map<string, unknown>([
    ["react", react],
    ["../model/catalogEquality", { samePlainTerminals, sameSessionActivity, sameSessions }],
    ["../ownerEpochLease", { createOwnerEpochLeaseController }],
    ["./workspaceCatalogRefresh", { workspaceCatalogRefresh }],
  ]);
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("require", "exports", "module", output.outputText);
  evaluate((specifier: string) => {
    assert.equal(modules.has(specifier), true, `unexpected module ${specifier}`);
    return modules.get(specifier);
  }, module.exports, module);
  const useWorkspaceCatalog = module.exports.useWorkspaceCatalog as (
    backend: DashboardBackend,
  ) => CatalogResult;
  const useWorkspaceCatalogOwnerPhase = module.exports.useWorkspaceCatalogOwnerPhase as (
    ownerPhase: unknown,
    options: {
      dashboardBackend: DashboardBackend;
      sessionOrder: string[];
      onFullCatalogPublished(publication: { generation: number; sessionNames: string[] }): void;
    },
  ) => void;

  return {
    render(
      dashboardBackend: DashboardBackend,
      onFullCatalogPublished: (publication: { generation: number; sessionNames: string[] }) => void =
        () => {},
    ) {
      cursor = 0;
      pending = new Map();
      const catalog = useWorkspaceCatalog(dashboardBackend);
      useWorkspaceCatalogOwnerPhase(catalog.ownerPhase, {
        dashboardBackend,
        sessionOrder: [],
        onFullCatalogPublished,
      });
      const renderedEffects = pending;
      return {
        catalog,
        abort() {
          if (pending === renderedEffects) pending = new Map();
        },
        commit() {
          for (const [index, next] of renderedEffects) {
            const previous = committed.get(index);
            if (previous && sameDependencies(previous.dependencies, next.dependencies)) continue;
            previous?.cleanup?.();
            const cleanup = next.callback();
            committed.set(index, {
              ...next,
              ...(typeof cleanup === "function" ? { cleanup } : {}),
            });
          }
          if (pending === renderedEffects) pending = new Map();
        },
      };
    },
    strictModeReplay() {
      const effects = [...committed.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of effects) effect.cleanup?.();
      for (const [index, effect] of effects) {
        const cleanup = effect.callback();
        committed.set(index, {
          ...effect,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
    },
  };
}

function session(name: string): Session {
  return {
    name,
    attached: false,
    window_count: 1,
    created: 1,
    activity: 1,
    output_signature: name,
    agent_running: false,
    hostId: null,
    rawName: name,
  };
}

function backendWithSnapshots(snapshots: DashboardCatalogSnapshot[]): DashboardBackend {
  const { backend } = createFakeDashboardBackend();
  backend.catalog = {
    list: async () => snapshots.shift() ?? {
      sessions: [],
      terminals: [],
      failedSessionHostIds: [],
      failedTerminalHostIds: [],
    },
  };
  return backend;
}

function snapshot(name: string): DashboardCatalogSnapshot {
  return {
    sessions: [session(name)],
    terminals: [],
    failedSessionHostIds: [],
    failedTerminalHostIds: [],
  };
}

test("owner-mismatched renders stay empty and aborted renders do not publish context", async () => {
  const harness = loadCatalogHookHarness();
  const backendA = backendWithSnapshots([snapshot("A")]);
  const backendB = backendWithSnapshots([snapshot("B")]);
  const mountedA = harness.render(backendA);
  mountedA.commit();
  const activeA = harness.render(backendA);
  await activeA.catalog.refresh();
  const publishedA = harness.render(backendA);
  assert.deepEqual(publishedA.catalog.sessions.map(({ name }) => name), ["A"]);
  assert.equal(publishedA.catalog.catalogRefreshGeneration, 1);

  const speculativeB = harness.render(backendB);
  assert.deepEqual(speculativeB.catalog.sessions, []);
  assert.equal(speculativeB.catalog.catalogRefreshGeneration, 0);
  speculativeB.abort();
  assert.deepEqual(harness.render(backendA).catalog.sessions.map(({ name }) => name), ["A"]);

  const committedB = harness.render(backendB);
  committedB.commit();
  const activeB = harness.render(backendB);
  assert.deepEqual(activeB.catalog.sessions, []);
  assert.equal(activeB.catalog.getLatestStartedRefreshGeneration(), 1);
  assert.equal(activeB.catalog.getLatestSuccessfulRefreshGeneration(), 0);

  activeB.catalog.reportError("B unavailable");
  activeB.catalog.removeSession("missing");
  const erroredB = harness.render(backendB);
  assert.equal(erroredB.catalog.error, "B unavailable");
  assert.equal(erroredB.catalog.catalogRefreshGeneration, 0);
  await activeB.catalog.refresh();
  const publishedB = harness.render(backendB);
  assert.deepEqual(publishedB.catalog.sessions.map(({ name }) => name), ["B"]);
  assert.equal(publishedB.catalog.catalogRefreshGeneration, 2);
  assert.equal(publishedB.catalog.getLatestSuccessfulRefreshGeneration(), 2);
});

test("a current-owner refresh error cannot expose the previous owner's generation", async () => {
  const harness = loadCatalogHookHarness();
  const backendA = backendWithSnapshots([snapshot("A")]);
  const { backend: backendB } = createFakeDashboardBackend();
  backendB.catalog = { list: async () => { throw new Error("B failed"); } };
  const mountedA = harness.render(backendA);
  mountedA.commit();
  let active = harness.render(backendA);
  await active.catalog.refresh();
  assert.equal(harness.render(backendA).catalog.catalogRefreshGeneration, 1);

  const switched = harness.render(backendB);
  switched.commit();
  active = harness.render(backendB);
  await active.catalog.refresh();
  const failedB = harness.render(backendB);
  assert.equal(failedB.catalog.catalogRefreshGeneration, 0);
  assert.equal(failedB.catalog.error, "Error: B failed");
  assert.equal(failedB.catalog.getLatestStartedRefreshGeneration(), 2);
  assert.equal(failedB.catalog.getLatestSuccessfulRefreshGeneration(), 0);
});

test("B to A is a new empty cut until A publishes the next global generation", async () => {
  const harness = loadCatalogHookHarness();
  const backendA = backendWithSnapshots([snapshot("A-1"), snapshot("A-2")]);
  const backendB = backendWithSnapshots([snapshot("B")]);
  const mountedA = harness.render(backendA);
  mountedA.commit();
  let activeA = harness.render(backendA);
  await activeA.catalog.refresh();
  assert.equal(harness.render(backendA).catalog.catalogRefreshGeneration, 1);

  const switchedB = harness.render(backendB);
  switchedB.commit();
  const activeB = harness.render(backendB);
  await activeB.catalog.refresh();
  assert.equal(harness.render(backendB).catalog.catalogRefreshGeneration, 2);

  const returnedA = harness.render(backendA);
  returnedA.commit();
  activeA = harness.render(backendA);
  assert.deepEqual(activeA.catalog.sessions, []);
  assert.equal(activeA.catalog.catalogRefreshGeneration, 0);
  assert.equal(activeA.catalog.getLatestStartedRefreshGeneration(), 2);
  assert.equal(activeA.catalog.getLatestSuccessfulRefreshGeneration(), 0);
  await activeA.catalog.refresh();
  const republishedA = harness.render(backendA);
  assert.deepEqual(republishedA.catalog.sessions.map(({ name }) => name), ["A-2"]);
  assert.equal(republishedA.catalog.catalogRefreshGeneration, 3);
  assert.equal(republishedA.catalog.getLatestSuccessfulRefreshGeneration(), 3);
});

test("old backend wrappers fail closed after an owner commit and merge starts empty", async () => {
  const harness = loadCatalogHookHarness();
  let oldBackendCalls = 0;
  const backendA = backendWithSnapshots([snapshot("A")]);
  const originalList = backendA.catalog?.list;
  assert.ok(originalList);
  backendA.catalog!.list = async () => {
    oldBackendCalls += 1;
    return originalList();
  };
  const backendB = backendWithSnapshots([snapshot("B")]);
  const mountedA = harness.render(backendA);
  mountedA.commit();
  const activeA = harness.render(backendA);
  await activeA.catalog.refresh();
  assert.equal(oldBackendCalls, 1);

  const switched = harness.render(backendB);
  switched.commit();
  await activeA.catalog.refresh();
  activeA.catalog.removeSession("A");
  activeA.catalog.reportError("stale A error");
  assert.equal(activeA.catalog.getLatestStartedRefreshGeneration(), 0);
  assert.equal(activeA.catalog.getLatestSuccessfulRefreshGeneration(), 0);
  assert.equal(oldBackendCalls, 1);

  const activeB = harness.render(backendB);
  await activeB.catalog.refresh();
  const publishedB = harness.render(backendB);
  assert.deepEqual(publishedB.catalog.sessions.map(({ name }) => name), ["B"]);
  assert.equal(publishedB.catalog.error, null);
});

test("Strict replay invalidates pending results without clearing same-owner data", async () => {
  const harness = loadCatalogHookHarness();
  let resolvePending!: (snapshot: DashboardCatalogSnapshot) => void;
  const pending = new Promise<DashboardCatalogSnapshot>((resolve) => {
    resolvePending = resolve;
  });
  const backend = backendWithSnapshots([snapshot("stable")]);
  const mounted = harness.render(backend);
  mounted.commit();
  let active = harness.render(backend);
  await active.catalog.refresh();
  active = harness.render(backend);
  backend.catalog!.list = () => pending;
  const staleRefresh = active.catalog.refresh();
  harness.strictModeReplay();
  assert.deepEqual(harness.render(backend).catalog.sessions.map(({ name }) => name), ["stable"]);
  resolvePending(snapshot("late"));
  await staleRefresh;
  assert.deepEqual(harness.render(backend).catalog.sessions.map(({ name }) => name), ["stable"]);
});
