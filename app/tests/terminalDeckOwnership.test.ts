import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { sameStringArray, sameStringRecord } from "../src/dashboard/model/catalogEquality.ts";
import { terminalSessionKey } from "../src/dashboard/model/terminalIdentity.ts";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type {
  DashboardBackend,
  PlainTerminal,
  Session,
} from "../src/platform/index.ts";

type Effect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

type DeckController = {
  ownerEpochKey: string;
  ownerPhase: unknown;
  openedSessions: string[];
  setOpenedSessions(next: string[] | ((previous: string[]) => string[])): void;
  openedTerminals: string[];
  setOpenedTerminals(next: string[] | ((previous: string[]) => string[])): void;
  tmuxPreviews: Record<string, string>;
  cwdsBySession: Record<string, string>;
  handleFullCatalogPublished(publication: {
    generation: number;
    sessionNames: string[];
  }): void;
};

type Inputs = {
  sessions: Session[];
  terminals: PlainTerminal[];
  selection: null | { kind: "session"; name: string } | { kind: "terminal"; id: string };
  selectedSession: Session | null;
  selectedTerminal: PlainTerminal | null;
};

const EMPTY_INPUTS: Inputs = {
  sessions: [],
  terminals: [],
  selection: null,
  selectedSession: null,
  selectedTerminal: null,
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function loadTerminalDeckHarness() {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown } | undefined> = [];
  const callbacks: Array<{ dependencies: unknown[]; value: unknown } | undefined> = [];
  const committedLayout = new Map<number, Effect>();
  const committedPassive = new Map<number, Effect>();
  let pendingLayout = new Map<number, Effect>();
  let pendingPassive = new Map<number, Effect>();
  let cursor = 0;
  let deferFunctionalStateUpdates = false;
  const pendingFunctionalStateUpdates: Array<() => void> = [];
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useTerminalDeckState.ts",
  });
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) {
        states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      return [states[index], (next: unknown) => {
        if (typeof next !== "function") {
          states[index] = next;
          return;
        }
        const apply = () => {
          states[index] = (next as (current: unknown) => unknown)(states[index]);
        };
        if (deferFunctionalStateUpdates) {
          pendingFunctionalStateUpdates.push(apply);
        } else {
          apply();
        }
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      refs[index] ??= { current: initial };
      return refs[index];
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
      pendingLayout.set(cursor++, { callback, dependencies });
    },
    useEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pendingPassive.set(cursor++, { callback, dependencies });
    },
  };
  const modules = new Map<string, unknown>([
    ["react", react],
    ["../model/catalogEquality", { sameStringArray, sameStringRecord }],
    ["../model/terminalIdentity", { terminalSessionKey }],
    ["../ownerEpochLease", { createOwnerEpochLeaseController }],
  ]);
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "exports", "module", output.outputText)(
    (specifier: string) => {
      assert.equal(modules.has(specifier), true, `unexpected module ${specifier}`);
      return modules.get(specifier);
    },
    module.exports,
    module,
  );
  const useTerminalDeckState = module.exports.useTerminalDeckState as (
    backend: DashboardBackend,
  ) => DeckController;
  const useTerminalDeckOwnerPhase = module.exports.useTerminalDeckOwnerPhase as (
    ownerPhase: unknown,
    backend: DashboardBackend,
  ) => void;
  const useTerminalDeckPreviewPhase = module.exports.useTerminalDeckPreviewPhase as (
    controller: DeckController,
    backend: DashboardBackend,
    inputs: { sessions: Session[]; allTerminals: PlainTerminal[] },
  ) => void;
  const useTerminalDeckAttachPhase = module.exports.useTerminalDeckAttachPhase as (
    controller: DeckController,
    backend: DashboardBackend,
    inputs: {
      selection: Inputs["selection"];
      selectedSession: Session | null;
      selectedTerminal: PlainTerminal | null;
      selectionMetadataPending: boolean;
      allTerminals: PlainTerminal[];
    },
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
    render(backend: DashboardBackend, inputs: Inputs = EMPTY_INPUTS) {
      cursor = 0;
      pendingLayout = new Map();
      pendingPassive = new Map();
      const controller = useTerminalDeckState(backend);
      useTerminalDeckOwnerPhase(controller.ownerPhase, backend);
      useTerminalDeckPreviewPhase(controller, backend, {
        sessions: inputs.sessions,
        allTerminals: inputs.terminals,
      });
      useTerminalDeckAttachPhase(controller, backend, {
        selection: inputs.selection,
        selectedSession: inputs.selectedSession,
        selectedTerminal: inputs.selectedTerminal,
        selectionMetadataPending: false,
        allTerminals: inputs.terminals,
      });
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
    strictModeReplayLayout() {
      const effects = [...committedLayout.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of effects) effect.cleanup?.();
      for (const [index, effect] of effects) {
        const cleanup = effect.callback();
        committedLayout.set(index, {
          ...effect,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
    },
    strictModeReplayPassive() {
      const effects = [...committedPassive.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of effects) effect.cleanup?.();
      for (const [index, effect] of effects) {
        const cleanup = effect.callback();
        committedPassive.set(index, {
          ...effect,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
    },
    deferFunctionalStateUpdates() {
      deferFunctionalStateUpdates = true;
    },
    flushFunctionalStateUpdates() {
      deferFunctionalStateUpdates = false;
      for (const apply of pendingFunctionalStateUpdates.splice(0)) apply();
    },
  };
}

function session(created: number, overrides: Partial<Session> = {}): Session {
  return {
    name: "same",
    attached: false,
    window_count: 1,
    created,
    activity: created,
    hostId: null,
    rawName: "same",
    ...overrides,
  };
}

function terminal(rawName: string, id = "terminal-id"): PlainTerminal {
  return {
    id,
    label: "Terminal",
    cwd: "/repo",
    tmuxName: "same-terminal",
    hostId: null,
    rawName,
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

test("session root survives React-delayed state publication after the promise settles", async () => {
  const harness = loadTerminalDeckHarness();
  const backend = createFakeDashboardBackend().backend;
  const root = deferred<string>();
  backend.sessions.root = async () => root.promise;
  const selectedSession = session(1);

  harness.render(backend).commitLayout();
  harness.render(backend, {
    sessions: [selectedSession],
    terminals: [],
    selection: { kind: "session", name: "same" },
    selectedSession,
    selectedTerminal: null,
  }).commitPassive();

  harness.deferFunctionalStateUpdates();
  root.resolve("/repo/same");
  await settle();
  assert.equal(harness.render(backend).controller.cwdsBySession.same, undefined);

  harness.flushFunctionalStateUpdates();
  assert.equal(harness.render(backend).controller.cwdsBySession.same, "/repo/same");
});

test("owner cuts hide speculative renders and fence stale setters, full cuts, and A to B to A", async () => {
  const harness = loadTerminalDeckHarness();
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const pendingA2Root = deferred<string>();
  backendA.sessions.root = async () => pendingA2Root.promise;

  const mountA = harness.render(backendA);
  mountA.commitLayout();
  let activeA = harness.render(backendA);
  activeA.controller.setOpenedSessions(["same", "gone"]);
  activeA.controller.setOpenedTerminals(["terminal-id"]);
  activeA = harness.render(backendA);
  assert.deepEqual(activeA.controller.openedSessions, ["same", "gone"]);
  assert.deepEqual(activeA.controller.openedTerminals, ["terminal-id"]);
  const epochA = activeA.controller.ownerEpochKey;
  const staleSetter = activeA.controller.setOpenedSessions;
  const staleFullCut = activeA.controller.handleFullCatalogPublished;

  const speculativeB = harness.render(backendB);
  assert.deepEqual(speculativeB.controller.openedSessions, []);
  assert.deepEqual(speculativeB.controller.openedTerminals, []);
  assert.equal(speculativeB.controller.ownerEpochKey, "terminal-deck-owner-pending");
  speculativeB.abort();
  assert.deepEqual(harness.render(backendA).controller.openedSessions, ["same", "gone"]);

  const switchB = harness.render(backendB);
  switchB.commitLayout();
  let activeB = harness.render(backendB);
  assert.deepEqual(activeB.controller.openedSessions, []);
  assert.notEqual(activeB.controller.ownerEpochKey, epochA);
  staleSetter(["stale"]);
  staleFullCut({ generation: 2, sessionNames: ["same"] });
  activeB = harness.render(backendB);
  assert.deepEqual(activeB.controller.openedSessions, []);

  activeB.controller.setOpenedSessions(["B"]);
  harness.strictModeReplayLayout();
  activeB = harness.render(backendB);
  assert.deepEqual(activeB.controller.openedSessions, ["B"]);

  const switchBackA = harness.render(backendA);
  switchBackA.commitLayout();
  let nextA = harness.render(backendA);
  assert.deepEqual(nextA.controller.openedSessions, []);
  assert.notEqual(nextA.controller.ownerEpochKey, epochA);
  nextA.controller.setOpenedSessions(["A2"]);
  const a2Session = session(3, { rawName: "A2-session" });
  harness.render(backendA, {
    sessions: [],
    terminals: [],
    selection: { kind: "session", name: "same" },
    selectedSession: a2Session,
    selectedTerminal: null,
  }).commitPassive();
  const a2OpenedBeforeStale = harness.render(backendA).controller.openedSessions;
  staleSetter(["stale-A1"]);
  staleFullCut({ generation: 3, sessionNames: [] });
  pendingA2Root.resolve("/A2");
  await settle();
  nextA = harness.render(backendA);
  assert.deepEqual(nextA.controller.openedSessions, a2OpenedBeforeStale);
  assert.equal(nextA.controller.cwdsBySession.same, "/A2");
});

test("same-name session reincarnation fences old preview and root completion", async () => {
  const harness = loadTerminalDeckHarness();
  const backend = createFakeDashboardBackend().backend;
  const oldHistory = deferred<string>();
  const newHistory = deferred<string>();
  const oldRoot = deferred<string>();
  const newRoot = deferred<string>();
  const histories = [oldHistory, newHistory];
  const roots = [oldRoot, newRoot];
  let historyCalls = 0;
  let rootCalls = 0;
  backend.sessions.captureHistory = async () => {
    historyCalls += 1;
    return histories.shift()!.promise;
  };
  backend.sessions.root = async () => {
    rootCalls += 1;
    return roots.shift()!.promise;
  };

  const mount = harness.render(backend);
  mount.commitLayout();
  const oldSession = session(1);
  const first = harness.render(backend, {
    sessions: [oldSession],
    terminals: [],
    selection: { kind: "session", name: "same" },
    selectedSession: oldSession,
    selectedTerminal: null,
  });
  first.commitPassive();
  assert.equal(historyCalls, 1);
  assert.equal(rootCalls, 1);

  const removed = harness.render(backend, EMPTY_INPUTS);
  removed.commitPassive();
  const newSession = session(2, { rawName: "same-new" });
  const readded = harness.render(backend, {
    sessions: [newSession],
    terminals: [],
    selection: { kind: "session", name: "same" },
    selectedSession: newSession,
    selectedTerminal: null,
  });
  readded.commitPassive();
  assert.equal(historyCalls, 2);
  assert.equal(rootCalls, 2);

  oldHistory.resolve("old-history");
  oldRoot.resolve("/old");
  await settle();
  let current = harness.render(backend).controller;
  assert.equal(current.tmuxPreviews.same, undefined);
  assert.equal(current.cwdsBySession.same, undefined);

  newHistory.resolve("new-history");
  newRoot.resolve("/new");
  await settle();
  current = harness.render(backend).controller;
  assert.equal(current.tmuxPreviews.same, "new-history");
  assert.equal(current.cwdsBySession.same, "/new");
});

test("same-name terminal reincarnation starts a fresh exact preview request", async () => {
  const harness = loadTerminalDeckHarness();
  const backend = createFakeDashboardBackend().backend;
  const oldHistory = deferred<string>();
  const newHistory = deferred<string>();
  const histories = [oldHistory, newHistory];
  let historyCalls = 0;
  backend.sessions.captureHistory = async () => {
    historyCalls += 1;
    return histories.shift()!.promise;
  };
  const mount = harness.render(backend);
  mount.commitLayout();

  harness.render(backend, {
    ...EMPTY_INPUTS,
    terminals: [terminal("same-terminal")],
  }).commitPassive();
  harness.render(backend, {
    ...EMPTY_INPUTS,
    terminals: [terminal("same-terminal")],
  }).commitPassive();
  assert.equal(historyCalls, 2);

  oldHistory.resolve("old-terminal");
  await settle();
  assert.equal(harness.render(backend).controller.tmuxPreviews["same-terminal"], undefined);
  newHistory.resolve("new-terminal");
  await settle();
  assert.equal(
    harness.render(backend).controller.tmuxPreviews["same-terminal"],
    "new-terminal",
  );
});

test("switching owners immediately refetches same-name pending preview and root", async () => {
  const harness = loadTerminalDeckHarness();
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const historyA = deferred<string>();
  const historyB = deferred<string>();
  const rootA = deferred<string>();
  const rootB = deferred<string>();
  let historyCallsA = 0;
  let historyCallsB = 0;
  let rootCallsA = 0;
  let rootCallsB = 0;
  backendA.sessions.captureHistory = async () => {
    historyCallsA += 1;
    return historyA.promise;
  };
  backendB.sessions.captureHistory = async () => {
    historyCallsB += 1;
    return historyB.promise;
  };
  backendA.sessions.root = async () => {
    rootCallsA += 1;
    return rootA.promise;
  };
  backendB.sessions.root = async () => {
    rootCallsB += 1;
    return rootB.promise;
  };
  const sameSession = session(1);
  const inputs: Inputs = {
    sessions: [sameSession],
    terminals: [],
    selection: { kind: "session", name: "same" },
    selectedSession: sameSession,
    selectedTerminal: null,
  };

  harness.render(backendA).commitLayout();
  harness.render(backendA, inputs).commitPassive();
  assert.deepEqual(
    [historyCallsA, rootCallsA, historyCallsB, rootCallsB],
    [1, 1, 0, 0],
  );

  const switchB = harness.render(backendB, inputs);
  switchB.commitLayout();
  switchB.commitPassive();
  assert.deepEqual(
    [historyCallsA, rootCallsA, historyCallsB, rootCallsB],
    [1, 1, 1, 1],
  );

  historyA.resolve("A-history");
  rootA.resolve("/A");
  await settle();
  let current = harness.render(backendB).controller;
  assert.equal(current.tmuxPreviews.same, undefined);
  assert.equal(current.cwdsBySession.same, undefined);

  historyB.resolve("B-history");
  rootB.resolve("/B");
  await settle();
  current = harness.render(backendB).controller;
  assert.equal(current.tmuxPreviews.same, "B-history");
  assert.equal(current.cwdsBySession.same, "/B");
});

test("Strict layout and passive replay refetch pending work and fence old completion", async () => {
  const harness = loadTerminalDeckHarness();
  const backend = createFakeDashboardBackend().backend;
  const oldHistory = deferred<string>();
  const nextHistory = deferred<string>();
  const oldRoot = deferred<string>();
  const nextRoot = deferred<string>();
  const histories = [oldHistory, nextHistory];
  const roots = [oldRoot, nextRoot];
  let historyCalls = 0;
  let rootCalls = 0;
  backend.sessions.captureHistory = async () => {
    historyCalls += 1;
    return histories.shift()!.promise;
  };
  backend.sessions.root = async () => {
    rootCalls += 1;
    return roots.shift()!.promise;
  };
  const sameSession = session(1);
  const inputs: Inputs = {
    sessions: [sameSession],
    terminals: [],
    selection: { kind: "session", name: "same" },
    selectedSession: sameSession,
    selectedTerminal: null,
  };

  harness.render(backend).commitLayout();
  harness.render(backend, inputs).commitPassive();
  assert.deepEqual([historyCalls, rootCalls], [1, 1]);

  harness.strictModeReplayLayout();
  harness.strictModeReplayPassive();
  assert.deepEqual([historyCalls, rootCalls], [2, 2]);

  oldHistory.resolve("old-history");
  oldRoot.resolve("/old");
  await settle();
  let current = harness.render(backend).controller;
  assert.equal(current.tmuxPreviews.same, undefined);
  assert.equal(current.cwdsBySession.same, undefined);

  nextHistory.resolve("next-history");
  nextRoot.resolve("/next");
  await settle();
  current = harness.render(backend).controller;
  assert.equal(current.tmuxPreviews.same, "next-history");
  assert.equal(current.cwdsBySession.same, "/next");
});
