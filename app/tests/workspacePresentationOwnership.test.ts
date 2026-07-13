import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type { WorkspaceBranchSource } from "../src/dashboard/model/workspacePresentation.ts";

type Effect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

type Controller = {
  ownerReady: boolean;
  homeDirectory: string | null;
  workspaceBranch: { sourceKey: string; value: string | null } | null;
  ownerPhase: unknown;
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function loadHarness() {
  const states: unknown[] = [];
  const memos: Array<{ dependencies: unknown[]; value: unknown } | undefined> = [];
  const committedLayout = new Map<number, Effect>();
  const committedPassive = new Map<number, Effect>();
  let pendingLayout = new Map<number, Effect>();
  let pendingPassive = new Map<number, Effect>();
  let cursor = 0;
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useWorkspacePresentation.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useWorkspacePresentation.ts",
  });
  const memo = (value: unknown, dependencies: unknown[]) => {
    const index = cursor++;
    const previous = memos[index];
    if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
      memos[index] = { dependencies, value };
    }
    return memos[index]?.value;
  };
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) {
        states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      return [states[index], (next: unknown) => {
        states[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(states[index])
          : next;
      }];
    },
    useCallback: memo,
    useMemo(factory: () => unknown, dependencies: unknown[]) {
      const index = cursor++;
      const previous = memos[index];
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        memos[index] = { dependencies, value: factory() };
      }
      return memos[index]?.value;
    },
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
      if (specifier === "../ownerEpochLease") return { createOwnerEpochLeaseController };
      assert.fail(`unexpected module ${specifier}`);
    },
    module.exports,
    module,
  );
  const useWorkspacePresentation = module.exports.useWorkspacePresentation as (
    backend: DashboardBackend,
  ) => Controller;
  const useWorkspacePresentationOwnerPhase =
    module.exports.useWorkspacePresentationOwnerPhase as (
      ownerPhase: unknown,
      backend: DashboardBackend,
    ) => void;
  const useWorkspaceHomePhase = module.exports.useWorkspaceHomePhase as (
    controller: Controller,
    backend: DashboardBackend,
  ) => void;
  const useWorkspaceBranchPhase = module.exports.useWorkspaceBranchPhase as (
    controller: Controller,
    backend: DashboardBackend,
    source: WorkspaceBranchSource,
  ) => (branch: string | null) => void;

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
    render(backend: DashboardBackend, source: WorkspaceBranchSource) {
      cursor = 0;
      pendingLayout = new Map();
      pendingPassive = new Map();
      const controller = useWorkspacePresentation(backend);
      useWorkspacePresentationOwnerPhase(controller.ownerPhase, backend);
      useWorkspaceHomePhase(controller, backend);
      const publishBranch = useWorkspaceBranchPhase(controller, backend, source);
      const renderedLayout = pendingLayout;
      const renderedPassive = pendingPassive;
      return {
        controller,
        publishBranch,
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
    strictReplayLayoutThenPassive() {
      const layouts = [...committedLayout.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of layouts) effect.cleanup?.();
      for (const [index, effect] of layouts) {
        const cleanup = effect.callback();
        committedLayout.set(index, {
          ...effect,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
      const passives = [...committedPassive.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of passives) effect.cleanup?.();
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

function source(name: string): WorkspaceBranchSource {
  return {
    kind: "workspace",
    key: JSON.stringify([`session:${name}`, `/repo/${name}`, null]),
    cwd: `/repo/${name}`,
    hostId: null,
    sessionName: name,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("owner switches fence delayed home and branch results across A to B to A", async () => {
  const harness = loadHarness();
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const homeA1 = deferred<string>();
  const homeA2 = deferred<string>();
  const homeB = deferred<string>();
  const branchA1 = deferred<{ branch: string }>();
  const branchA2 = deferred<{ branch: string }>();
  const branchB = deferred<{ branch: string }>();
  const homesA = [homeA1, homeA2];
  const branchesA = [branchA1, branchA2];
  backendA.persistence.homeDirectory = async () => homesA.shift()!.promise;
  backendA.git.status = async () => branchesA.shift()!.promise as never;
  backendB.persistence.homeDirectory = async () => homeB.promise;
  backendB.git.status = async () => branchB.promise as never;

  harness.render(backendA, source("X")).commitLayout();
  const activeA1 = harness.render(backendA, source("X"));
  activeA1.commitPassive();
  const speculativeB = harness.render(backendB, source("X"));
  assert.equal(speculativeB.controller.ownerReady, false);
  assert.equal(speculativeB.controller.homeDirectory, null);
  assert.equal(speculativeB.controller.workspaceBranch, null);
  speculativeB.abort();
  assert.equal(harness.render(backendA, source("X")).controller.ownerReady, true);

  const switchB = harness.render(backendB, source("X"));
  switchB.commitLayout();
  switchB.commitPassive();
  homeA1.resolve("/A1");
  branchA1.resolve({ branch: "A1" });
  await settle();
  let current = harness.render(backendB, source("X")).controller;
  assert.equal(current.homeDirectory, null);
  assert.deepEqual(current.workspaceBranch, {
    sourceKey: source("X").key,
    value: null,
  });
  homeB.resolve("/B");
  branchB.resolve({ branch: "B" });
  await settle();
  current = harness.render(backendB, source("X")).controller;
  assert.equal(current.homeDirectory, "/B");
  assert.deepEqual(current.workspaceBranch, { sourceKey: source("X").key, value: "B" });

  const switchA2 = harness.render(backendA, source("X"));
  switchA2.commitLayout();
  switchA2.commitPassive();
  assert.equal(harness.render(backendA, source("X")).controller.homeDirectory, null);
  homeA2.resolve("/A2");
  branchA2.resolve({ branch: "A2" });
  await settle();
  current = harness.render(backendA, source("X")).controller;
  assert.equal(current.homeDirectory, "/A2");
  assert.deepEqual(current.workspaceBranch, { sourceKey: source("X").key, value: "A2" });
});

test("source bindings fence deferred X1 and Y queries before X2 publishes", async () => {
  const harness = loadHarness();
  const backend = createFakeDashboardBackend().backend;
  const branchX1 = deferred<{ branch: string }>();
  const branchY = deferred<{ branch: string }>();
  const branchX2 = deferred<{ branch: string }>();
  const branches = [branchX1, branchY, branchX2];
  backend.persistence.homeDirectory = async () => "/home";
  backend.git.status = async () => branches.shift()!.promise as never;
  harness.render(backend, source("X")).commitLayout();
  const x1 = harness.render(backend, source("X"));
  x1.commitPassive();

  const y = harness.render(backend, source("Y"));
  y.commitPassive();
  const x2 = harness.render(backend, source("X"));
  x2.commitPassive();

  x1.publishBranch("stale-X1-after-X2");
  y.publishBranch("stale-Y-after-X2");
  branchX1.resolve({ branch: "late-X1" });
  branchY.resolve({ branch: "late-Y" });
  await settle();
  assert.deepEqual(
    harness.render(backend, source("X")).controller.workspaceBranch,
    { sourceKey: source("X").key, value: null },
  );

  branchX2.resolve({ branch: "X2" });
  await settle();
  assert.deepEqual(
    harness.render(backend, source("X")).controller.workspaceBranch,
    { sourceKey: source("X").key, value: "X2" },
  );
});

test("a speculative source abort cannot publish or cancel the committed query", async () => {
  const harness = loadHarness();
  const backend = createFakeDashboardBackend().backend;
  const branchX = deferred<{ branch: string }>();
  let branchCalls = 0;
  backend.persistence.homeDirectory = async () => "/home";
  backend.git.status = async () => {
    branchCalls += 1;
    return branchX.promise as never;
  };

  harness.render(backend, source("X")).commitLayout();
  const committedX = harness.render(backend, source("X"));
  committedX.commitPassive();
  assert.equal(branchCalls, 1);

  const speculativeY = harness.render(backend, source("Y"));
  assert.equal(speculativeY.controller.workspaceBranch?.sourceKey, source("X").key);
  speculativeY.publishBranch("speculative-Y");
  speculativeY.abort();
  assert.equal(branchCalls, 1);

  branchX.resolve({ branch: "committed-X" });
  await settle();
  assert.deepEqual(
    harness.render(backend, source("X")).controller.workspaceBranch,
    { sourceKey: source("X").key, value: "committed-X" },
  );
});

test("Strict layout replay lets the same passive closures refetch home and branch", async () => {
  const harness = loadHarness();
  const backend = createFakeDashboardBackend().backend;
  const oldHome = deferred<string>();
  const nextHome = deferred<string>();
  const oldBranch = deferred<{ branch: string }>();
  const nextBranch = deferred<{ branch: string }>();
  const homes = [oldHome, nextHome];
  const branches = [oldBranch, nextBranch];
  let homeCalls = 0;
  let branchCalls = 0;
  backend.persistence.homeDirectory = async () => {
    homeCalls += 1;
    return homes.shift()!.promise;
  };
  backend.git.status = async () => {
    branchCalls += 1;
    return branches.shift()!.promise as never;
  };

  harness.render(backend, source("X")).commitLayout();
  const active = harness.render(backend, source("X"));
  active.commitPassive();
  assert.deepEqual([homeCalls, branchCalls], [1, 1]);
  const stalePublisher = active.publishBranch;

  harness.strictReplayLayoutThenPassive();
  assert.deepEqual([homeCalls, branchCalls], [2, 2]);
  stalePublisher("stale");
  oldHome.resolve("/old");
  oldBranch.resolve({ branch: "old" });
  await settle();
  let current = harness.render(backend, source("X")).controller;
  assert.equal(current.homeDirectory, null);
  assert.deepEqual(current.workspaceBranch, {
    sourceKey: source("X").key,
    value: null,
  });

  nextHome.resolve("/next");
  nextBranch.resolve({ branch: "next" });
  await settle();
  current = harness.render(backend, source("X")).controller;
  assert.equal(current.homeDirectory, "/next");
  assert.deepEqual(current.workspaceBranch, { sourceKey: source("X").key, value: "next" });
});
