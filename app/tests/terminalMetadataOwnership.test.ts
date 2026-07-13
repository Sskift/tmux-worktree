import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";
import {
  allocateTerminalId,
  createTerminalSaveCoordinator,
  mergeRestoredTerminalMetadata,
  restorePersistedTerminalMetadata,
} from "../src/terminalPersistence.ts";
import { terminalSessionKey } from "../src/dashboard/model/terminalIdentity.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type { DashboardBackend, PlainTerminal } from "../src/platform/index.ts";

type Effect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

type Controller = {
  terminals: PlainTerminal[];
  setTerminals(next: PlainTerminal[] | ((current: PlainTerminal[]) => PlainTerminal[])): void;
  upsertCreatedTerminal(
    draft: Readonly<{ label: string; cwd: string; aiCmd: string; hostId?: string | null }>,
    created: Readonly<{
      tmuxName: string;
      hostId?: string | null;
      rawName: string;
      cwd: string;
      managed: boolean;
    }>,
    allTerminals: readonly PlainTerminal[],
  ): string;
  reconcilePersistedTerminal(target: Readonly<{
    id: string;
    tmuxName: string;
    hostId: string | null;
  }>): void;
  terminalPersistenceError: string | null;
  terminalPersistenceHydrationGeneration: number;
  terminalsRestoreReady: boolean;
  terminalPersistenceWritable: boolean;
  ownerPhase: unknown;
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
}

function loadHarness(options: Readonly<{ doubleInvokeStateUpdaters?: boolean }> = {}) {
  const states: unknown[] = [];
  const callbacks: Array<{ dependencies: unknown[]; value: unknown } | undefined> = [];
  const committedLayout = new Map<number, Effect>();
  const committedPassive = new Map<number, Effect>();
  let cursor = 0;
  let pendingLayout = new Map<number, Effect>();
  let pendingPassive = new Map<number, Effect>();
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useTerminalMetadata.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useTerminalMetadata.ts",
  });
  const memo = (value: unknown, dependencies: unknown[]) => {
    const index = cursor++;
    const previous = callbacks[index];
    if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
      callbacks[index] = { dependencies, value };
    }
    return callbacks[index]?.value;
  };
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) {
        states[index] = typeof initial === "function"
          ? (initial as () => unknown)()
          : initial;
      }
      return [states[index], (next: unknown) => {
        if (typeof next !== "function") {
          states[index] = next;
          return;
        }
        const updater = next as (current: unknown) => unknown;
        const current = states[index];
        if (options.doubleInvokeStateUpdaters) updater(current);
        states[index] = updater(current);
      }];
    },
    useCallback: memo,
    useLayoutEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pendingLayout.set(cursor++, { callback, dependencies });
    },
    useEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pendingPassive.set(cursor++, { callback, dependencies });
    },
  };
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "exports", "module", output.outputText)(
    (specifier: string) => {
      if (specifier === "react") return react;
      if (specifier === "../../terminalPersistence") {
        return {
          allocateTerminalId,
          createTerminalSaveCoordinator,
          mergeRestoredTerminalMetadata,
          restorePersistedTerminalMetadata,
        };
      }
      if (specifier === "../ownerEpochLease") {
        return { createOwnerEpochLeaseController };
      }
      if (specifier === "../model/terminalIdentity") return { terminalSessionKey };
      assert.fail(`unexpected module ${specifier}`);
    },
    module.exports,
    module,
  );
  const useTerminalMetadata = module.exports.useTerminalMetadata as (
    backend: DashboardBackend,
  ) => Controller;
  const useTerminalMetadataOwnerPhase = module.exports.useTerminalMetadataOwnerPhase as (
    ownerPhase: unknown,
    backend: DashboardBackend,
  ) => void;
  const useTerminalMetadataHydrationPhase =
    module.exports.useTerminalMetadataHydrationPhase as (
      controller: Controller,
      backend: DashboardBackend,
    ) => void;

  const commitEffects = (
    rendered: Map<number, Effect>,
    committed: Map<number, Effect>,
  ) => {
    for (const [index, next] of rendered) {
      const previous = committed.get(index);
      if (previous && sameDependencies(previous.dependencies, next.dependencies)) continue;
      previous?.cleanup?.();
      const cleanup = next.callback();
      committed.set(index, {
        ...next,
        ...(typeof cleanup === "function" ? { cleanup } : {}),
      });
    }
  };

  return {
    render(backend: DashboardBackend) {
      cursor = 0;
      pendingLayout = new Map();
      pendingPassive = new Map();
      const controller = useTerminalMetadata(backend);
      useTerminalMetadataOwnerPhase(controller.ownerPhase, backend);
      useTerminalMetadataHydrationPhase(controller, backend);
      const renderedLayout = pendingLayout;
      const renderedPassive = pendingPassive;
      return {
        controller,
        abort() {
          if (pendingLayout === renderedLayout) pendingLayout = new Map();
          if (pendingPassive === renderedPassive) pendingPassive = new Map();
        },
        commitLayout() {
          commitEffects(renderedLayout, committedLayout);
        },
        commitPassive() {
          commitEffects(renderedPassive, committedPassive);
        },
      };
    },
    strictReplay() {
      const layouts = [...committedLayout.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of layouts) effect.cleanup?.();
      const passives = [...committedPassive.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of passives) effect.cleanup?.();
      for (const [index, effect] of layouts) {
        const cleanup = effect.callback();
        committedLayout.set(index, {
          ...effect,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
      for (const [index, effect] of passives) {
        const cleanup = effect.callback();
        committedPassive.set(index, {
          ...effect,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function terminal(id: string): PlainTerminal {
  return {
    id,
    label: id,
    cwd: `/repo/${id}`,
    tmuxName: `tw-${id}`,
    rawName: `tw-${id}`,
    managed: true,
  };
}

function backendWithLoad(load: () => Promise<PlainTerminal[]>): DashboardBackend {
  const { backend } = createFakeDashboardBackend();
  backend.terminals.load = load;
  backend.sessions.exists = async () => true;
  return backend;
}

test("a speculative backend render cannot invalidate committed terminal metadata", async () => {
  const pendingA = deferred<PlainTerminal[]>();
  const backendA = backendWithLoad(() => pendingA.promise);
  const backendB = backendWithLoad(async () => [terminal("b")]);
  const harness = loadHarness();
  const mountedA = harness.render(backendA);
  mountedA.commitLayout();
  mountedA.commitPassive();

  const speculativeB = harness.render(backendB);
  assert.deepEqual(speculativeB.controller.terminals, []);
  speculativeB.abort();
  pendingA.resolve([terminal("a")]);
  await settle();

  const visibleA = harness.render(backendA).controller;
  assert.deepEqual(visibleA.terminals.map(({ id }) => id), ["a"]);
  assert.equal(visibleA.terminalPersistenceHydrationGeneration, 1);
});

test("committing B rejects late A hydration and publishes only B", async () => {
  const pendingA = deferred<PlainTerminal[]>();
  const pendingB = deferred<PlainTerminal[]>();
  const backendA = backendWithLoad(() => pendingA.promise);
  const backendB = backendWithLoad(() => pendingB.promise);
  const harness = loadHarness();
  const mountedA = harness.render(backendA);
  mountedA.commitLayout();
  mountedA.commitPassive();

  const mountedB = harness.render(backendB);
  assert.deepEqual(mountedB.controller.terminals, []);
  mountedB.commitLayout();
  mountedB.commitPassive();
  pendingA.resolve([terminal("a-late")]);
  await settle();
  assert.deepEqual(harness.render(backendB).controller.terminals, []);

  pendingB.resolve([terminal("b")]);
  await settle();
  const visibleB = harness.render(backendB).controller;
  assert.deepEqual(visibleB.terminals.map(({ id }) => id), ["b"]);
  assert.equal(visibleB.terminalPersistenceHydrationGeneration, 1);
});

test("A1 setters stay stale after A to B to A2", () => {
  const backendA = backendWithLoad(async () => []);
  const backendB = backendWithLoad(async () => []);
  const harness = loadHarness();
  let rendered = harness.render(backendA);
  rendered.commitLayout();
  const staleA1Setter = rendered.controller.setTerminals;

  rendered = harness.render(backendB);
  rendered.commitLayout();
  rendered = harness.render(backendA);
  rendered.commitLayout();
  const currentA2Setter = harness.render(backendA).controller.setTerminals;
  currentA2Setter([terminal("a2")]);
  staleA1Setter([terminal("a1-stale")]);

  assert.deepEqual(
    harness.render(backendA).controller.terminals.map(({ id }) => id),
    ["a2"],
  );
});

test("persisted-terminal reconciliation is exact-owner and exact-runtime identity", () => {
  const backendA = backendWithLoad(async () => []);
  const backendB = backendWithLoad(async () => []);
  const harness = loadHarness();
  let rendered = harness.render(backendA);
  rendered.commitLayout();
  const staleA1Reconcile = rendered.controller.reconcilePersistedTerminal;

  rendered = harness.render(backendB);
  rendered.commitLayout();
  rendered = harness.render(backendA);
  rendered.commitLayout();
  const currentA2 = harness.render(backendA).controller;
  currentA2.setTerminals([terminal("target"), terminal("keep")]);
  staleA1Reconcile({ id: "target", tmuxName: "tw-target", hostId: null });
  assert.deepEqual(
    harness.render(backendA).controller.terminals.map(({ id }) => id),
    ["target", "keep"],
  );

  const committedA2 = harness.render(backendA).controller;
  const upsertCreated = (label: string) => committedA2.upsertCreatedTerminal(
    { label, cwd: "/repo/target", aiCmd: "codex", hostId: null },
    {
      tmuxName: "tw-target",
      hostId: null,
      rawName: "tw-target",
      cwd: "/repo/target",
      managed: true,
    },
    harness.render(backendA).controller.terminals,
  );
  assert.equal(upsertCreated("authoritative label"), "target");
  assert.equal(upsertCreated("latest label"), "target");
  assert.deepEqual(
    harness.render(backendA).controller.terminals.map(({ id, label }) => ({ id, label })),
    [
      { id: "target", label: "latest label" },
      { id: "keep", label: "keep" },
    ],
  );

  committedA2.reconcilePersistedTerminal({
    id: "target",
    tmuxName: "tw-target",
    hostId: null,
  });
  assert.deepEqual(
    harness.render(backendA).controller.terminals.map(({ id }) => id),
    ["keep"],
  );
});

test("Strict replay replaces pending hydration without clearing same-owner data", async () => {
  const oldLoad = deferred<PlainTerminal[]>();
  const replayLoad = deferred<PlainTerminal[]>();
  let loads = 0;
  const backend = backendWithLoad(() => {
    loads += 1;
    return loads === 1 ? oldLoad.promise : replayLoad.promise;
  });
  const harness = loadHarness();
  const mounted = harness.render(backend);
  mounted.commitLayout();
  mounted.commitPassive();
  harness.strictReplay();
  assert.equal(loads, 2);

  oldLoad.resolve([terminal("old")]);
  replayLoad.resolve([terminal("current")]);
  await settle();
  const current = harness.render(backend).controller;
  assert.deepEqual(current.terminals.map(({ id }) => id), ["current"]);
  assert.equal(current.terminalPersistenceHydrationGeneration, 1);
});

test("Strict state-updater replay advances successful hydration exactly once", async () => {
  const backend = backendWithLoad(async () => [terminal("strict-updater")]);
  const harness = loadHarness({ doubleInvokeStateUpdaters: true });
  const mounted = harness.render(backend);
  mounted.commitLayout();
  mounted.commitPassive();
  await settle();

  const current = harness.render(backend).controller;
  assert.equal(current.terminalPersistenceHydrationGeneration, 1);
  assert.deepEqual(current.terminals.map(({ id }) => id), ["strict-updater"]);
});

test("a failed load remains unauthorized until the exact owner retry succeeds", async () => {
  const retryCallbacks: Array<() => void> = [];
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void) {
        retryCallbacks.push(callback);
        return retryCallbacks.length;
      },
      clearTimeout() {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { hidden: false },
  });
  try {
    let loads = 0;
    const backend = backendWithLoad(async () => {
      loads += 1;
      if (loads === 1) throw new Error("unavailable");
      return [terminal("restored")];
    });
    const harness = loadHarness();
    const mounted = harness.render(backend);
    mounted.commitLayout();
    mounted.commitPassive();
    await settle();

    let visible = harness.render(backend).controller;
    assert.equal(visible.terminalPersistenceWritable, false);
    assert.equal(visible.terminalsRestoreReady, false);
    assert.equal(visible.terminalPersistenceHydrationGeneration, 0);
    assert.match(visible.terminalPersistenceError ?? "", /unavailable/);
    assert.equal(retryCallbacks.length, 1);

    retryCallbacks.shift()?.();
    await settle();
    visible = harness.render(backend).controller;
    assert.equal(visible.terminalPersistenceWritable, true);
    assert.equal(visible.terminalsRestoreReady, true);
    assert.equal(visible.terminalPersistenceHydrationGeneration, 1);
    assert.deepEqual(visible.terminals.map(({ id }) => id), ["restored"]);
    assert.equal(visible.terminalPersistenceError, null);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});
