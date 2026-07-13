import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type {
  DashboardBackend,
  HostConfig,
  HostStatus,
  ProjectPreset,
} from "../src/platform/index.ts";

type Effect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

type Controller = {
  projectPresets: ProjectPreset[];
  loadProjectPresets(): Promise<void>;
  hosts: HostConfig[];
  hostsHydrationGeneration: number;
  catalogReloadRequired: boolean;
  hostsLoadError: string | null;
  onHostsMutationSettled(hosts: HostConfig[], acceptPayload: boolean): boolean;
  sshHostCandidates: HostConfig[];
  hostStatuses: Record<string, HostStatus>;
  installingHostId: string | null;
  installRemoteTw(hostId: string): Promise<void>;
  ownerEpochKey: string;
  ownerPhase: unknown;
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
}

function loadHarness() {
  const states: unknown[] = [];
  const memos: Array<{ dependencies: unknown[]; value: unknown } | undefined> = [];
  const committedLayout = new Map<number, Effect>();
  const committedPassive = new Map<number, Effect>();
  let pendingLayout = new Map<number, Effect>();
  let pendingPassive = new Map<number, Effect>();
  let renderedPollingTasks: Array<() => void | Promise<void>> = [];
  let cursor = 0;
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useConnectionCatalog.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useConnectionCatalog.ts",
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
        states[index] = typeof initial === "function"
          ? (initial as () => unknown)()
          : initial;
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
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index] as { current: unknown };
    },
    useLayoutEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pendingLayout.set(cursor++, { callback, dependencies });
    },
    useEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pendingPassive.set(cursor++, { callback, dependencies });
    },
  };
  const useVisibilityAwarePolling = (
    task: () => void | Promise<void>,
    options: {
      enabled?: boolean;
      visibleIntervalMs: number;
      hiddenIntervalMs: number;
      refreshKey?: string;
      restartKey?: unknown;
    },
  ) => {
    const taskRef = react.useRef(task) as {
      current: () => void | Promise<void>;
    };
    react.useLayoutEffect(() => {
      taskRef.current = task;
    }, [task]);
    renderedPollingTasks.push(() => taskRef.current());
    react.useEffect(() => {
      if (options.enabled === false) return;
      void taskRef.current();
    }, [
      options.enabled ?? true,
      options.hiddenIntervalMs,
      options.refreshKey ?? "",
      options.restartKey,
      options.visibleIntervalMs,
    ]);
  };
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "exports", "module", output.outputText)(
    (specifier: string) => {
      if (specifier === "react") return react;
      if (specifier === "../ownerEpochLease") {
        return { createOwnerEpochLeaseController };
      }
      if (specifier === "./useVisibilityAwarePolling") {
        return { useVisibilityAwarePolling };
      }
      assert.fail(`unexpected module ${specifier}`);
    },
    module.exports,
    module,
  );
  const useConnectionCatalog = module.exports.useConnectionCatalog as (
    backend: DashboardBackend,
  ) => Controller;
  const useConnectionCatalogOwnerPhase =
    module.exports.useConnectionCatalogOwnerPhase as (
      ownerPhase: unknown,
      backend: DashboardBackend,
    ) => void;
  const useConnectionCatalogSyncPhase =
    module.exports.useConnectionCatalogSyncPhase as (
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
      renderedPollingTasks = [];
      const controller = useConnectionCatalog(backend);
      useConnectionCatalogOwnerPhase(controller.ownerPhase, backend);
      useConnectionCatalogSyncPhase(controller, backend);
      const renderedLayout = pendingLayout;
      const renderedPassive = pendingPassive;
      const pollingTasks = renderedPollingTasks;
      return {
        controller,
        pollingTasks,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function host(id: string, endpoint = `${id}.example`): HostConfig {
  return {
    id,
    label: id.toUpperCase(),
    host: endpoint,
    user: "builder",
    port: 22,
    identityFile: `~/.ssh/${id}`,
    tmuxPath: "/opt/bin/tmux",
    twPath: "/opt/bin/tw",
  };
}

function status(id: string, twAvailable = true): HostStatus {
  return {
    id,
    label: id.toUpperCase(),
    reachable: true,
    latencyMs: 1,
    error: null,
    twAvailable,
    twVersion: twAvailable ? "1" : null,
    twError: null,
  };
}

function emptyBackend(): DashboardBackend {
  const backend = createFakeDashboardBackend().backend;
  backend.projects.list = async () => [];
  backend.hosts.list = async () => [];
  backend.hosts.candidates = async () => [];
  backend.hosts.statuses = async () => [];
  return backend;
}

test("A to B to A creates empty owner cuts and rejects every late A1 publication", async () => {
  const harness = loadHarness();
  const backendA = emptyBackend();
  const backendB = emptyBackend();
  const projectA1 = deferred<ProjectPreset[]>();
  const projectA2 = deferred<ProjectPreset[]>();
  const listA1 = deferred<HostConfig[]>();
  const listA2 = deferred<HostConfig[]>();
  const candidateA1 = deferred<HostConfig[]>();
  const statusA1 = deferred<HostStatus[]>();
  const installA1 = deferred<HostStatus>();
  const projectB = deferred<ProjectPreset[]>();
  const listB = deferred<HostConfig[]>();
  const projectsA = [projectA1, projectA2];
  const listsA = [listA1, listA2];
  backendA.projects.list = async () => projectsA.shift()!.promise;
  backendA.hosts.list = async () => listsA.shift()!.promise;
  backendA.hosts.candidates = async () => candidateA1.promise;
  backendA.hosts.statuses = async () => statusA1.promise;
  backendA.hosts.installTw = async () => installA1.promise;
  backendB.projects.list = async () => projectB.promise;
  backendB.hosts.list = async () => listB.promise;

  const initialA = harness.render(backendA);
  initialA.commitLayout();
  initialA.commitPassive();
  listA1.resolve([host("a")]);
  await settle();
  const activeA1 = harness.render(backendA);
  activeA1.commitLayout();
  activeA1.commitPassive();
  const pendingInstallA1 = activeA1.controller.installRemoteTw("a");
  assert.equal(harness.render(backendA).controller.installingHostId, "a");

  const switchB = harness.render(backendB);
  switchB.commitLayout();
  switchB.commitPassive();
  let current = harness.render(backendB).controller;
  assert.deepEqual(current.hosts, []);
  assert.equal(current.hostsHydrationGeneration, 0);
  assert.equal(current.ownerEpochKey, "connection:2");

  const switchA2 = harness.render(backendA);
  switchA2.commitLayout();
  switchA2.commitPassive();
  current = harness.render(backendA).controller;
  assert.deepEqual(current.hosts, []);
  assert.equal(current.hostsHydrationGeneration, 0);
  assert.equal(current.ownerEpochKey, "connection:3");

  projectA1.resolve([{ name: "stale-a1", path: "/stale" }]);
  candidateA1.resolve([host("stale-candidate")]);
  statusA1.resolve([status("a")]);
  installA1.resolve(status("a"));
  await pendingInstallA1;
  await settle();
  current = harness.render(backendA).controller;
  assert.deepEqual(current.projectPresets, []);
  assert.deepEqual(current.hosts, []);
  assert.deepEqual(current.sshHostCandidates, []);
  assert.deepEqual(current.hostStatuses, {});
  assert.equal(current.installingHostId, null);

  projectA2.resolve([{ name: "a2", path: "/a2" }]);
  listA2.resolve([host("a2")]);
  await settle();
  current = harness.render(backendA).controller;
  assert.deepEqual(current.projectPresets, [{ name: "a2", path: "/a2" }]);
  assert.deepEqual(current.hosts, [host("a2")]);
  assert.equal(current.hostsHydrationGeneration, 1);
});

test("a speculative B render leaves the committed A requests authoritative", async () => {
  const harness = loadHarness();
  const backendA = emptyBackend();
  const backendB = emptyBackend();
  const projectsA = deferred<ProjectPreset[]>();
  const hostsA = deferred<HostConfig[]>();
  backendA.projects.list = async () => projectsA.promise;
  backendA.hosts.list = async () => hostsA.promise;

  const activeA = harness.render(backendA);
  activeA.commitLayout();
  activeA.commitPassive();
  const speculativeB = harness.render(backendB);
  assert.equal(speculativeB.controller.ownerEpochKey, "connection:pending");
  assert.equal(speculativeB.controller.hostsHydrationGeneration, 0);
  speculativeB.abort();

  projectsA.resolve([{ name: "A", path: "/a" }]);
  hostsA.resolve([host("a")]);
  await settle();
  const current = harness.render(backendA).controller;
  assert.deepEqual(current.projectPresets, [{ name: "A", path: "/a" }]);
  assert.deepEqual(current.hosts, [host("a")]);
  assert.equal(current.hostsHydrationGeneration, 1);
});

test("Strict replay preserves authoritative hosts but replaces project and status requests", async () => {
  const harness = loadHarness();
  const backend = emptyBackend();
  const oldProject = deferred<ProjectPreset[]>();
  const nextProject = deferred<ProjectPreset[]>();
  const oldStatus = deferred<HostStatus[]>();
  const nextStatus = deferred<HostStatus[]>();
  let projectCalls = 0;
  let statusCalls = 0;
  backend.projects.list = async () => {
    projectCalls += 1;
    if (projectCalls === 1) return [{ name: "initial", path: "/initial" }];
    return projectCalls === 2 ? oldProject.promise : nextProject.promise;
  };
  backend.hosts.list = async () => [host("a")];
  backend.hosts.candidates = async () => [host("candidate")];
  backend.hosts.statuses = async () => {
    statusCalls += 1;
    return statusCalls === 1 ? oldStatus.promise : nextStatus.promise;
  };

  const initial = harness.render(backend);
  initial.commitLayout();
  initial.commitPassive();
  await settle();
  const hydrated = harness.render(backend);
  hydrated.commitLayout();
  hydrated.commitPassive();
  const pendingOldProject = hydrated.controller.loadProjectPresets();
  assert.equal(projectCalls, 2);

  harness.strictReplayLayoutThenPassive();
  assert.equal(projectCalls, 3);
  assert.equal(statusCalls, 2);
  let current = harness.render(backend).controller;
  assert.deepEqual(current.hosts, [host("a")]);
  assert.deepEqual(current.sshHostCandidates, [host("candidate")]);
  assert.deepEqual(current.hostStatuses, {});

  oldProject.resolve([{ name: "old", path: "/old" }]);
  oldStatus.resolve([status("old")]);
  await pendingOldProject;
  await settle();
  current = harness.render(backend).controller;
  assert.notDeepEqual(current.projectPresets, [{ name: "old", path: "/old" }]);
  assert.deepEqual(current.hostStatuses, {});

  nextProject.resolve([{ name: "next", path: "/next" }]);
  nextStatus.resolve([status("a")]);
  await settle();
  current = harness.render(backend).controller;
  assert.deepEqual(current.projectPresets, [{ name: "next", path: "/next" }]);
  assert.deepEqual(current.hostStatuses, { a: status("a") });
});

test("project loads are latest-wins and host hydration survives candidate failure and retry", async () => {
  const harness = loadHarness();
  const backend = emptyBackend();
  const initialProject = deferred<ProjectPreset[]>();
  const olderProject = deferred<ProjectPreset[]>();
  const latestProject = deferred<ProjectPreset[]>();
  const projects = [initialProject, olderProject, latestProject];
  let hostCalls = 0;
  backend.projects.list = async () => projects.shift()!.promise;
  backend.hosts.list = async () => {
    hostCalls += 1;
    if (hostCalls === 1) throw new Error("offline");
    return [host("a")];
  };
  backend.hosts.candidates = async () => {
    throw new Error("ssh config unavailable");
  };

  const initial = harness.render(backend);
  initial.commitLayout();
  initial.commitPassive();
  initialProject.resolve([]);
  await settle();
  let current = harness.render(backend);
  assert.equal(current.controller.hostsHydrationGeneration, 0);
  assert.match(current.controller.hostsLoadError ?? "", /offline/);

  await current.pollingTasks[0]();
  await settle();
  current = harness.render(backend);
  assert.equal(current.controller.hostsHydrationGeneration, 1);
  assert.deepEqual(current.controller.hosts, [host("a")]);
  assert.deepEqual(current.controller.sshHostCandidates, []);
  assert.equal(current.controller.hostsLoadError, null);

  const older = current.controller.loadProjectPresets();
  const latest = current.controller.loadProjectPresets();
  latestProject.resolve([{ name: "latest", path: "/latest" }]);
  await latest;
  olderProject.resolve([{ name: "older", path: "/older" }]);
  await older;
  assert.deepEqual(
    harness.render(backend).controller.projectPresets,
    [{ name: "latest", path: "/latest" }],
  );
});

test("trusted mutation settlement invalidates old list candidate and same-ID status work", async () => {
  const harness = loadHarness();
  const backend = emptyBackend();
  const candidate = deferred<HostConfig[]>();
  const oldStatus = deferred<HostStatus[]>();
  const laterList = deferred<HostConfig[]>();
  let listCalls = 0;
  backend.hosts.list = async () => {
    listCalls += 1;
    return listCalls === 1 ? [host("a", "old.example")] : laterList.promise;
  };
  backend.hosts.candidates = async () => candidate.promise;
  backend.hosts.statuses = async () => oldStatus.promise;

  const initial = harness.render(backend);
  initial.commitLayout();
  initial.commitPassive();
  await settle();
  const hydrated = harness.render(backend);
  hydrated.commitLayout();
  hydrated.commitPassive();
  void hydrated.pollingTasks[0]();
  assert.equal(hydrated.controller.onHostsMutationSettled([
    host("a", "new.example"),
  ], true), true);
  let current = harness.render(backend).controller;
  assert.deepEqual(current.hosts, [host("a", "new.example")]);
  assert.deepEqual(current.hostStatuses, {});
  assert.equal(current.hostsHydrationGeneration, 2);

  candidate.resolve([host("stale-candidate")]);
  oldStatus.resolve([status("a")]);
  laterList.resolve([host("a", "stale-list.example")]);
  await settle();
  current = harness.render(backend).controller;
  assert.deepEqual(current.hosts, [host("a", "new.example")]);
  assert.deepEqual(current.sshHostCandidates, []);
  assert.deepEqual(current.hostStatuses, {});
});

test("a stale A1 mutation payload causes an authoritative A2 reload instead of publication", async () => {
  const harness = loadHarness();
  const backendA = emptyBackend();
  const backendB = emptyBackend();
  let listCalls = 0;
  backendA.hosts.list = async () => {
    listCalls += 1;
    if (listCalls === 1) return [host("a", "before.example")];
    if (listCalls === 2) return [host("a", "still-before.example")];
    if (listCalls === 3) throw new Error("reload raced storage");
    return [host("a", "after.example")];
  };
  backendA.hosts.candidates = async () => [host("candidate")];

  const initialA = harness.render(backendA);
  initialA.commitLayout();
  initialA.commitPassive();
  await settle();
  const staleMutationSettled = harness.render(backendA).controller.onHostsMutationSettled;

  const switchB = harness.render(backendB);
  switchB.commitLayout();
  switchB.commitPassive();
  const switchA2 = harness.render(backendA);
  switchA2.commitLayout();
  switchA2.commitPassive();
  await settle();
  let current = harness.render(backendA).controller;
  assert.deepEqual(current.hosts, [host("a", "still-before.example")]);
  assert.equal(current.hostsHydrationGeneration, 1);

  assert.equal(staleMutationSettled([
    host("a", "untrusted-mutation-payload.example"),
  ], false), false);
  await settle();
  current = harness.render(backendA).controller;
  assert.deepEqual(current.hosts, [host("a", "still-before.example")]);
  assert.equal(current.hostsHydrationGeneration, 1);
  assert.equal(current.catalogReloadRequired, true);
  assert.match(current.hostsLoadError ?? "", /reload raced storage/);

  const retry = harness.render(backendA);
  await retry.pollingTasks[0]();
  await settle();
  current = harness.render(backendA).controller;
  assert.deepEqual(current.hosts, [host("a", "after.example")]);
  assert.equal(current.hostsHydrationGeneration, 2);
  assert.equal(current.catalogReloadRequired, false);
  assert.deepEqual(current.sshHostCandidates, [host("candidate")]);
  assert.equal(listCalls, 4);
});

test("Strict lease replay reloads a token-current Settings settlement instead of trusting its payload", async () => {
  const harness = loadHarness();
  const backend = emptyBackend();
  let listCalls = 0;
  backend.hosts.list = async () => {
    listCalls += 1;
    return listCalls === 1
      ? [host("a", "before-strict.example")]
      : [host("a", "after-strict.example")];
  };

  const initial = harness.render(backend);
  initial.commitLayout();
  initial.commitPassive();
  await settle();
  const hydrated = harness.render(backend);
  hydrated.commitLayout();
  hydrated.commitPassive();
  const oldSettingsSettlement = hydrated.controller.onHostsMutationSettled;

  harness.strictReplayLayoutThenPassive();
  assert.equal(oldSettingsSettlement([
    host("a", "untrusted-token-current.example"),
  ], true), false);
  await settle();
  const current = harness.render(backend).controller;
  assert.deepEqual(current.hosts, [host("a", "after-strict.example")]);
  assert.equal(current.catalogReloadRequired, false);
  assert.equal(listCalls, 2);
});

test("a B layout commit rejects A1 settlement before old Settings passive cleanup", async () => {
  const harness = loadHarness();
  const backendA = emptyBackend();
  const backendB = emptyBackend();
  let listCallsA = 0;
  backendA.hosts.list = async () => {
    listCallsA += 1;
    return listCallsA === 1
      ? [host("a", "a1.example")]
      : [host("a", "a2.example")];
  };

  const initialA = harness.render(backendA);
  initialA.commitLayout();
  initialA.commitPassive();
  await settle();
  const oldSettingsSettlement = harness.render(backendA).controller.onHostsMutationSettled;

  const switchB = harness.render(backendB);
  switchB.commitLayout();
  assert.equal(oldSettingsSettlement([
    host("a", "untrusted-a1.example"),
  ], true), false);
  assert.equal(listCallsA, 1, "current B must not reload originating A");
  assert.deepEqual(harness.render(backendB).controller.hosts, []);
  switchB.commitPassive();

  const switchA2 = harness.render(backendA);
  switchA2.commitLayout();
  switchA2.commitPassive();
  await settle();
  assert.deepEqual(
    harness.render(backendA).controller.hosts,
    [host("a", "a2.example")],
  );
  assert.equal(listCallsA, 2);
});

test("install claims are exclusive and stale A1 finally cannot clear A2", async () => {
  const harness = loadHarness();
  const backendA = emptyBackend();
  const backendB = emptyBackend();
  const installA1 = deferred<HostStatus>();
  const installA2 = deferred<HostStatus>();
  const installFailure = deferred<HostStatus>();
  let installCalls = 0;
  backendA.hosts.list = async () => [host("a")];
  backendA.hosts.installTw = async () => {
    installCalls += 1;
    if (installCalls === 1) return installA1.promise;
    if (installCalls === 2) return installA2.promise;
    return installFailure.promise;
  };

  const initialA = harness.render(backendA);
  initialA.commitLayout();
  initialA.commitPassive();
  await settle();
  let currentA = harness.render(backendA);
  const pendingA1 = currentA.controller.installRemoteTw("a");
  await assert.rejects(
    currentA.controller.installRemoteTw("a"),
    /already in progress/,
  );
  assert.equal(harness.render(backendA).controller.installingHostId, "a");

  const switchB = harness.render(backendB);
  switchB.commitLayout();
  switchB.commitPassive();
  const switchA2 = harness.render(backendA);
  switchA2.commitLayout();
  switchA2.commitPassive();
  await settle();
  currentA = harness.render(backendA);
  const pendingA2 = currentA.controller.installRemoteTw("a");
  assert.equal(harness.render(backendA).controller.installingHostId, "a");

  installA1.resolve(status("a"));
  await pendingA1;
  await settle();
  assert.equal(
    harness.render(backendA).controller.installingHostId,
    "a",
    "A1 finally cannot clear the current A2 spinner",
  );

  installA2.resolve(status("a"));
  await pendingA2;
  await settle();
  const completed = harness.render(backendA).controller;
  assert.equal(completed.installingHostId, null);
  assert.deepEqual(completed.hostStatuses, { a: status("a") });

  const failed = completed.installRemoteTw("a");
  installFailure.reject(new Error("copy failed"));
  await assert.rejects(failed, /copy failed/);
  await settle();
  assert.deepEqual(harness.render(backendA).controller.hostStatuses, {
    a: {
      ...status("a"),
      twAvailable: false,
      twError: "Error: copy failed",
    },
  });
});

test("stale install success and failure each issue at most one authoritative reprobe", async () => {
  const harness = loadHarness();
  const backend = emptyBackend();
  const staleSuccess = deferred<HostStatus>();
  const staleFailure = deferred<HostStatus>();
  let installCalls = 0;
  let statusCalls = 0;
  backend.hosts.list = async () => [host("a")];
  backend.hosts.statuses = async () => {
    statusCalls += 1;
    return [];
  };
  backend.hosts.installTw = async () => {
    installCalls += 1;
    return installCalls === 1 ? staleSuccess.promise : staleFailure.promise;
  };

  const initial = harness.render(backend);
  initial.commitLayout();
  initial.commitPassive();
  await settle();

  let current = harness.render(backend).controller;
  const success = current.installRemoteTw("a");
  assert.equal(current.onHostsMutationSettled([host("a")], true), true);
  staleSuccess.resolve(status("a"));
  await assert.rejects(success, /Host catalog changed while tw installation was running/);
  await settle();
  assert.equal(statusCalls, 1, "stale success must issue exactly one reprobe");

  current = harness.render(backend).controller;
  const failure = current.installRemoteTw("a");
  assert.equal(current.onHostsMutationSettled([host("a")], true), true);
  staleFailure.reject(new Error("remote install failed"));
  await assert.rejects(failure, /remote install failed/);
  await settle();
  assert.equal(statusCalls, 2, "stale backend failure must issue exactly one reprobe");
});
