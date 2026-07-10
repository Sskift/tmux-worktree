import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PlainTerminal, Session } from "../src/platform";
import {
  pendingCreatedCatalogSelection,
  pendingRestoredCatalogSelection,
  reconcileCatalogSelection,
} from "../src/dashboard/catalogSelectionHydration";

const localSession: Session = {
  name: "local-worktree",
  attached: false,
  window_count: 1,
  created: 1,
  activity: 1,
};

const localTerminal: PlainTerminal = {
  id: "term-local",
  label: "local",
  cwd: "/repo",
  tmuxName: "tw-term-local",
};

function reconcile(
  overrides: Partial<Parameters<typeof reconcileCatalogSelection>[0]> = {},
) {
  return reconcileCatalogSelection({
    selection: { kind: "terminal", id: "deleted-terminal" },
    pendingSelection: null,
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
    sessions: [localSession],
    terminals: [],
    hostIds: new Set(),
    ...overrides,
  });
}

test("restored terminals expire only after both terminal catalogs hydrate successfully", () => {
  const selection = { kind: "terminal", id: "deleted-terminal" } as const;
  const pendingSelection = pendingRestoredCatalogSelection(selection, 0);

  const beforeRefresh = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 0,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
  });
  assert.deepEqual(beforeRefresh.selection, selection);
  assert.equal(beforeRefresh.metadataPending, true);

  const beforePersistence = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 0,
      hostGeneration: 1,
    },
  });
  assert.deepEqual(beforePersistence.selection, selection);
  assert.equal(beforePersistence.metadataPending, true);

  const hydrated = reconcile({ selection, pendingSelection });
  assert.deepEqual(hydrated.selection, { kind: "session", name: localSession.name });
  assert.equal(hydrated.pendingSelection, null);
  assert.equal(hydrated.metadataPending, true);
});

test("a restored terminal remains selected when either hydrated catalog contains it", () => {
  const selection = { kind: "terminal", id: localTerminal.id } as const;
  const result = reconcile({
    selection,
    pendingSelection: pendingRestoredCatalogSelection(selection, 0),
    terminals: [localTerminal],
  });

  assert.deepEqual(result.selection, selection);
  assert.equal(result.pendingSelection, null);
  assert.equal(result.metadataPending, false);
});

test("a missing restored session waits for persisted terminals before choosing fallback", () => {
  const selection = { kind: "session", name: "deleted-session" } as const;
  const pendingSelection = pendingRestoredCatalogSelection(selection, 0);

  const persistenceLoading = reconcile({
    selection,
    pendingSelection,
    sessions: [],
    terminals: [],
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 0,
      hostGeneration: 1,
    },
  });
  assert.deepEqual(persistenceLoading.selection, selection);
  assert.equal(persistenceLoading.metadataPending, true);

  const persistenceReady = reconcile({
    selection,
    pendingSelection,
    sessions: [],
    terminals: [localTerminal],
  });
  assert.deepEqual(persistenceReady.selection, {
    kind: "terminal",
    id: localTerminal.id,
  });
});

test("remote-only fallback waits until the Host catalog can validate it", () => {
  const selection = { kind: "session", name: "deleted-local" } as const;
  const remoteSession = {
    ...localSession,
    name: "build:remote-worktree",
    rawName: "remote-worktree",
    hostId: "build",
  };

  const hostLoading = reconcile({
    selection,
    sessions: [remoteSession],
    terminals: [],
    hostIds: new Set(),
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 1,
      hostGeneration: 0,
    },
  });
  assert.deepEqual(hostLoading.selection, selection);
  assert.equal(hostLoading.metadataPending, true);

  const hostReady = reconcile({
    selection,
    sessions: [remoteSession],
    terminals: [],
    hostIds: new Set(["build"]),
  });
  assert.deepEqual(hostReady.selection, {
    kind: "session",
    name: remoteSession.name,
  });
});

test("an explicit selection already present in state does not wait for an unrelated refresh", () => {
  const selection = { kind: "terminal", id: localTerminal.id } as const;
  const result = reconcile({
    selection,
    terminals: [localTerminal],
    hydration: {
      refreshGeneration: 0,
      terminalPersistenceGeneration: 0,
      hostGeneration: 0,
    },
  });

  assert.deepEqual(result.selection, selection);
  assert.equal(result.pendingSelection, null);
  assert.equal(result.metadataPending, false);
});

test("remote metadata waits for initial host hydration then falls back if the Host was deleted", () => {
  const remoteTerminal: PlainTerminal = {
    ...localTerminal,
    id: "term-remote",
    hostId: "deleted-host",
  };
  const selection = { kind: "terminal", id: remoteTerminal.id } as const;

  const initialEmptyHosts = reconcile({
    selection,
    terminals: [remoteTerminal],
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 1,
      hostGeneration: 0,
    },
  });
  assert.deepEqual(initialEmptyHosts.selection, selection);
  assert.equal(initialEmptyHosts.metadataPending, true);

  const hydratedEmptyHosts = reconcile({
    selection,
    terminals: [remoteTerminal],
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
  });
  assert.deepEqual(hydratedEmptyHosts.selection, {
    kind: "session",
    name: localSession.name,
  });
});

test("a deleted composite remote session cannot fall back during host metadata delay", () => {
  const selection = { kind: "session", name: "deleted-host:remote-worktree" } as const;
  const pendingSelection = pendingRestoredCatalogSelection(selection, 0);

  const hostsLoading = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 1,
      terminalPersistenceGeneration: 1,
      hostGeneration: 0,
    },
  });
  assert.deepEqual(hostsLoading.selection, selection);
  assert.equal(hostsLoading.metadataPending, true);

  const hostsHydrated = reconcile({ selection, pendingSelection });
  assert.deepEqual(hostsHydrated.selection, {
    kind: "session",
    name: localSession.name,
  });
});

test("new worktrees require a successful refresh started after creation", () => {
  const selection = { kind: "session", name: "new-worktree" } as const;
  const pendingSelection = pendingCreatedCatalogSelection(selection, 4);
  assert.equal(pendingSelection.minimumRefreshGeneration, 5);

  const preCreationRefresh = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 4,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
  });
  assert.deepEqual(preCreationRefresh.selection, selection);
  assert.equal(preCreationRefresh.metadataPending, true);

  const postCreationRefresh = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 5,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
  });
  assert.deepEqual(postCreationRefresh.selection, {
    kind: "session",
    name: localSession.name,
  });

  const found = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 5,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
    sessions: [localSession, { ...localSession, name: selection.name }],
  });
  assert.deepEqual(found.selection, selection);
  assert.equal(found.metadataPending, false);
});

test("a partial remote refresh cannot discard a restored session that it could not verify", () => {
  const selection = { kind: "session", name: "build:new-worktree" } as const;
  const pendingSelection = pendingRestoredCatalogSelection(selection, 0);
  const result = reconcile({
    selection,
    pendingSelection,
    hostIds: new Set(["build"]),
    failedSessionHostIds: new Set(["build"]),
  });

  assert.deepEqual(result.selection, selection);
  assert.deepEqual(result.pendingSelection, pendingSelection);
  assert.equal(result.metadataPending, true);
});

test("a post-create partial refresh cannot fall back from the new remote session", () => {
  const selection = { kind: "session", name: "build:new-worktree" } as const;
  const pendingSelection = pendingCreatedCatalogSelection(selection, 4);
  const result = reconcile({
    selection,
    pendingSelection,
    hydration: {
      refreshGeneration: 5,
      terminalPersistenceGeneration: 1,
      hostGeneration: 1,
    },
    sessions: [{ ...localSession, name: "build:old", rawName: "old", hostId: "build" }],
    hostIds: new Set(["build"]),
    failedSessionHostIds: new Set(["build"]),
  });

  assert.deepEqual(result.selection, selection);
  assert.deepEqual(result.pendingSelection, pendingSelection);
  assert.equal(result.metadataPending, true);
});

test("App advances refresh readiness only after both catalog requests succeed", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const refreshStart = appSource.indexOf("const refresh = useCallback");
  const refreshEnd = appSource.indexOf("useVisibilityAwarePolling(refresh", refreshStart);
  const refreshSource = appSource.slice(refreshStart, refreshEnd);

  assert.match(refreshSource, /const refreshGeneration = \+\+catalogRefreshGenerationRef\.current\.started/);
  assert.match(
    refreshSource,
    /await Promise\.all\(\[\s*dashboardBackend\.sessions\.list\(\),\s*dashboardBackend\.terminals\.listTmux\(\),\s*\]\)/s,
  );
  assert.doesNotMatch(refreshSource, /listTmux\(\)\.catch/);
  assert.ok(
    refreshSource.indexOf("setCatalogRefreshGeneration(refreshGeneration)") <
      refreshSource.indexOf("} catch (e)"),
  );
  assert.doesNotMatch(
    refreshSource.slice(refreshSource.indexOf("} catch (e)")),
    /setCatalogRefreshGeneration/,
  );
});

test("Host readiness distinguishes initial empty state from a successful empty catalog", () => {
  const hookSource = readFileSync(
    new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
    "utf8",
  );
  const loadStart = hookSource.indexOf("const loadHosts = useCallback");
  const loadEnd = hookSource.indexOf("useVisibilityAwarePolling(loadHosts", loadStart);
  const loadSource = hookSource.slice(loadStart, loadEnd);

  assert.match(hookSource, /useState\(0\).*hostsHydrationGeneration|hostsHydrationGeneration.*useState\(0\)/s);
  assert.match(loadSource, /setHostsHydrationGeneration\(\(generation\) => generation \+ 1\)/);
  assert.doesNotMatch(loadSource.slice(loadSource.indexOf("} catch")), /setHostsHydrationGeneration/);
  assert.doesNotMatch(loadSource, /Promise\.all/);
  assert.match(hookSource, /enabled: hostsHydrationGeneration === 0/);
  assert.match(hookSource, /visibleIntervalMs: HOST_CATALOG_RETRY_MS/);
  assert.ok(
    loadSource.indexOf("dashboardBackend.hosts.list()") <
      loadSource.indexOf("dashboardBackend.hosts.candidates()"),
    "SSH candidate failure must not block Host hydration",
  );
});

test("terminal metadata failure keeps fallback pending without authorizing an empty save", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const loadStart = appSource.indexOf("const loadPersistedTerminals = async");
  const loadEnd = appSource.indexOf("// Load layout data on mount", loadStart);
  const loadSource = appSource.slice(loadStart, loadEnd);
  const loadFailureStart = loadSource.indexOf("} catch (nextError)");
  const loadFailureSource = loadSource.slice(loadFailureStart);
  const saveStart = appSource.indexOf("// Persist terminal metadata");
  const saveEnd = appSource.indexOf("// Persist layout", saveStart);
  const saveSource = appSource.slice(saveStart, saveEnd);

  assert.match(loadSource, /setTerminalPersistenceWritable\(true\)/);
  assert.match(loadSource, /setTerminalPersistenceError\(`Terminal metadata could not be loaded:/);
  assert.match(loadSource.slice(0, loadFailureStart), /settleHydration\(\)/);
  assert.doesNotMatch(loadFailureSource, /settleHydration\(\)/);
  assert.match(loadFailureSource, /window\.setTimeout/);
  assert.match(saveSource, /!terminalsRestoreReady \|\| !terminalPersistenceWritable/);
  assert.ok(
    saveSource.indexOf("terminalPersistenceWritable") <
      saveSource.indexOf("dashboardBackend.terminals.save(snapshot)"),
  );
});
