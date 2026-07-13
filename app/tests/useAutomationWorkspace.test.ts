import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  createAutomationWorkspaceCoordinator,
  EMPTY_AUTOMATION_WORKSPACE_STATE,
} from "../src/dashboard/automation/automationWorkspaceCoordinator.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type { AutomationRecord } from "../src/automationTypes.ts";

type Effect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function record(id: string): AutomationRecord {
  return {
    id,
    name: id,
    enabled: true,
    triggerType: "manual",
    schedule: null,
    timezone: null,
    project: null,
    path: "/repo",
    aiCmd: "claude",
    instruction: "work",
    overlap: "skip",
    lastRunAt: null,
    lastStatus: "idle",
    lastSession: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function backendWithRecord(id: string): DashboardBackend {
  const { backend } = createFakeDashboardBackend();
  backend.automations.list = async () => [record(id)];
  backend.automations.listRuns = async () => [];
  return backend;
}

function loadHookHarness() {
  const states: unknown[] = [];
  const callbacks: Array<{ dependencies: unknown[]; value: unknown } | undefined> = [];
  const committed = new Map<number, Effect>();
  let pending = new Map<number, Effect>();
  let cursor = 0;
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useAutomationWorkspace.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: "useAutomationWorkspace.ts",
  });
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
    useCallback(value: unknown, dependencies: unknown[]) {
      const index = cursor++;
      const previous = callbacks[index];
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        callbacks[index] = { dependencies, value };
      }
      return callbacks[index]?.value;
    },
    useLayoutEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pending.set(cursor++, { callback, dependencies });
    },
    useEffect() {
      cursor += 1;
    },
  };
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "exports", "module", output.outputText)(
    (specifier: string) => {
      if (specifier === "react") return react;
      if (specifier === "../automation/automationWorkspaceCoordinator") {
        return { createAutomationWorkspaceCoordinator, EMPTY_AUTOMATION_WORKSPACE_STATE };
      }
      assert.fail(`unexpected module ${specifier}`);
    },
    module.exports,
    module,
  );
  const useAutomationWorkspace = module.exports.useAutomationWorkspace as (
    backend: DashboardBackend,
  ) => {
    automations: Array<{ id: string }>;
    error: string | null;
    ownerEpochKey: string;
    load(): Promise<boolean>;
    create: unknown;
    ownerPhase: unknown;
  };
  const useAutomationWorkspaceOwnerPhase = module.exports.useAutomationWorkspaceOwnerPhase as (
    ownerPhase: unknown,
    context: {
      backend: DashboardBackend;
      getAutomationSubmitOwner(): { contextKey: string | null; revision: number };
      navigateToSavedAutomation(id: string): Promise<boolean>;
      reconcileAutomationSelection(items: unknown[]): void;
      clearDeletedAutomationSelection(id: string): void;
      refreshWorkspace(): Promise<void>;
    },
  ) => void;

  const context = (backend: DashboardBackend) => ({
    backend,
    getAutomationSubmitOwner: () => ({ contextKey: "automation:a", revision: 0 }),
    navigateToSavedAutomation: async () => true,
    reconcileAutomationSelection: () => {},
    clearDeletedAutomationSelection: () => {},
    refreshWorkspace: async () => {},
  });

  return {
    render(backend: DashboardBackend) {
      cursor = 0;
      pending = new Map();
      const workspace = useAutomationWorkspace(backend);
      useAutomationWorkspaceOwnerPhase(workspace.ownerPhase, context(backend));
      const rendered = pending;
      return {
        workspace,
        abort() {
          if (pending === rendered) pending = new Map();
        },
        commit() {
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
          if (pending === rendered) pending = new Map();
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

test("aborted backend renders stay empty without replacing the committed owner", async () => {
  const harness = loadHookHarness();
  const backendA = backendWithRecord("A");
  const backendB = backendWithRecord("B");
  const initial = harness.render(backendA);
  assert.equal(initial.workspace.ownerEpochKey, "automation-owner-pending");
  assert.equal(await initial.workspace.load(), false);
  initial.commit();
  let activeA = harness.render(backendA);
  const firstAKey = activeA.workspace.ownerEpochKey;
  assert.notEqual(firstAKey, "automation-owner-pending");
  assert.equal(await activeA.workspace.load(), true);
  activeA = harness.render(backendA);
  assert.deepEqual(activeA.workspace.automations.map(({ id }) => id), ["A"]);

  const speculativeB = harness.render(backendB);
  assert.deepEqual(speculativeB.workspace.automations, []);
  assert.equal(speculativeB.workspace.ownerEpochKey, "automation-owner-pending");
  speculativeB.abort();
  assert.deepEqual(harness.render(backendA).workspace.automations.map(({ id }) => id), ["A"]);
  assert.equal(harness.render(backendA).workspace.ownerEpochKey, firstAKey);
});

test("backend commit publishes a prepaint empty key and Strict replay preserves it", async () => {
  const harness = loadHookHarness();
  const backendA = backendWithRecord("A");
  const backendB = backendWithRecord("B");
  const mountedA = harness.render(backendA);
  mountedA.commit();
  let activeA = harness.render(backendA);
  await activeA.workspace.load();
  activeA = harness.render(backendA);
  const firstKey = activeA.workspace.ownerEpochKey;
  const createIdentity = activeA.workspace.create;

  const switched = harness.render(backendB);
  switched.commit();
  let activeB = harness.render(backendB);
  assert.deepEqual(activeB.workspace.automations, []);
  assert.notEqual(activeB.workspace.ownerEpochKey, firstKey);
  assert.notEqual(activeB.workspace.ownerEpochKey, "automation-owner-pending");
  assert.notEqual(activeB.workspace.create, createIdentity);
  const bKey = activeB.workspace.ownerEpochKey;
  const bCreate = activeB.workspace.create;

  harness.strictModeReplay();
  activeB = harness.render(backendB);
  assert.equal(activeB.workspace.ownerEpochKey, bKey);
  assert.equal(activeB.workspace.create, bCreate);
  assert.deepEqual(activeB.workspace.automations, []);
  assert.equal(await activeB.workspace.load(), true);
  assert.deepEqual(harness.render(backendB).workspace.automations.map(({ id }) => id), ["B"]);
});
