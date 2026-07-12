import assert from "node:assert/strict";
import test from "node:test";
import type {
  DashboardCatalogSnapshot,
  PlainTerminal,
  Session,
} from "../src/platform/domainTypes.ts";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import {
  workspaceCatalogRefresh,
  type WorkspaceCatalogFullPublication,
  type WorkspaceCatalogGenerationFence,
  type WorkspaceCatalogPublication,
} from "../src/dashboard/hooks/workspaceCatalogRefresh.ts";
import type { PreviousSessionActivity } from "../src/dashboard/model/sessionActivity.ts";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("condition did not become true after draining microtasks");
}

function session(name: string, hostId: string | null = null): Session {
  return {
    name,
    attached: false,
    window_count: 1,
    created: 1,
    activity: 1,
    output_signature: `${name}-output`,
    agent_running: false,
    hostId,
    rawName: name,
  };
}

function terminal(id: string, hostId: string | null = null): PlainTerminal {
  return {
    id,
    label: id,
    cwd: `/tmp/${id}`,
    tmuxName: `${hostId ? `${hostId}:` : ""}${id}`,
    hostId,
    rawName: id,
  };
}

function snapshot(
  sessions: Session[],
  terminals: PlainTerminal[] = [],
  failedSessionHostIds: string[] = [],
  failedTerminalHostIds: string[] = [],
): DashboardCatalogSnapshot {
  return { sessions, terminals, failedSessionHostIds, failedTerminalHostIds };
}

function backendWithCatalog(
  catalog: NonNullable<DashboardBackend["catalog"]> | undefined,
): DashboardBackend {
  const { backend } = createFakeDashboardBackend();
  backend.catalog = catalog;
  return backend;
}

function createHarness({
  backend,
  generation = { started: 0, successful: 0 },
  initialSessions = [],
  initialTerminals = [],
  sessionOrder = [],
  firstGeneration = 1,
}: {
  backend: DashboardBackend;
  generation?: WorkspaceCatalogGenerationFence;
  initialSessions?: Session[];
  initialTerminals?: PlainTerminal[];
  sessionOrder?: string[];
  firstGeneration?: number;
}) {
  let currentSessions = initialSessions;
  let currentTerminals = initialTerminals;
  let previousActivity = new Map<string, PreviousSessionActivity>();
  const events: string[] = [];
  const localPublications: WorkspaceCatalogPublication[] = [];
  const fullPublications: WorkspaceCatalogFullPublication[] = [];
  const errors: string[] = [];
  const fullCatalogCuts: Array<{ generation: number; sessionNames: string[] }> = [];
  const owner = createOwnerEpochLeaseController<DashboardBackend>();
  owner.commit(backend);
  owner.activate();
  const lease = owner.capture(backend);
  assert.ok(lease);

  const refresh = () => workspaceCatalogRefresh({
    backend,
    generation,
    firstGeneration,
    lease,
    isCurrent: owner.isCurrent,
    getCurrentSessions: () => currentSessions,
    getCurrentDiscoveredTerminals: () => currentTerminals,
    getSessionOrder: () => sessionOrder,
    getPreviousActivity: () => previousActivity,
    nowSeconds: () => 100,
    publishLocal: (publication) => {
      events.push(`local:${publication.generation}`);
      localPublications.push(publication);
      currentSessions = publication.sessions;
      currentTerminals = publication.discoveredTerminals;
    },
    publishFull: (publication) => {
      events.push(`full:${publication.generation}`);
      fullPublications.push(publication);
      currentSessions = publication.sessions;
      currentTerminals = publication.discoveredTerminals;
      previousActivity = publication.nextActivity;
      fullCatalogCuts.push({
        generation: publication.generation,
        sessionNames: publication.authoritativeSessionNames,
      });
    },
    publishError: (error) => {
      events.push(`error:${error}`);
      errors.push(error);
    },
  });

  return {
    errors,
    events,
    fullCatalogCuts,
    fullPublications,
    generation,
    getCurrentSessions: () => currentSessions,
    getCurrentTerminals: () => currentTerminals,
    localPublications,
    owner,
    refresh,
  };
}

test("a stale result lease cannot start work or advance the global generation", async () => {
  let calls = 0;
  const backend = backendWithCatalog({
    list: async () => {
      calls += 1;
      return snapshot([]);
    },
  });
  const harness = createHarness({ backend });
  const replacement = backendWithCatalog({ list: async () => snapshot([]) });
  harness.owner.commit(replacement);

  await harness.refresh();

  assert.equal(calls, 0);
  assert.deepEqual(harness.generation, { started: 0, successful: 0 });
  assert.deepEqual(harness.events, []);
});

test("A local pending through B and back to A cannot publish or start full", async () => {
  const local = deferred<DashboardCatalogSnapshot>();
  let fullCalls = 0;
  const backendA = backendWithCatalog({
    listLocal: () => local.promise,
    list: async () => {
      fullCalls += 1;
      return snapshot([session("late")]);
    },
  });
  const backendB = backendWithCatalog({ list: async () => snapshot([]) });
  const harness = createHarness({ backend: backendA });
  const pending = harness.refresh();
  harness.owner.commit(backendB);
  harness.owner.commit(backendA);

  local.resolve(snapshot([session("stale-local")]));
  await pending;

  assert.equal(fullCalls, 0);
  assert.deepEqual(harness.generation, { started: 1, successful: 0 });
  assert.deepEqual(harness.events, []);
});

test("late full and error results from an old owner are inert", async () => {
  const full = deferred<DashboardCatalogSnapshot>();
  const backendA = backendWithCatalog({ list: () => full.promise });
  const backendB = backendWithCatalog({ list: async () => snapshot([]) });
  const fullHarness = createHarness({ backend: backendA });
  const pendingFull = fullHarness.refresh();
  fullHarness.owner.commit(backendB);
  full.resolve(snapshot([session("stale-full")]));
  await pendingFull;
  assert.deepEqual(fullHarness.generation, { started: 1, successful: 0 });
  assert.deepEqual(fullHarness.events, []);

  const failure = deferred<DashboardCatalogSnapshot>();
  const failingA = backendWithCatalog({ list: () => failure.promise });
  const errorHarness = createHarness({ backend: failingA });
  const pendingError = errorHarness.refresh();
  errorHarness.owner.commit(backendB);
  failure.reject(new Error("stale owner failed"));
  await pendingError;
  assert.deepEqual(errorHarness.generation, { started: 1, successful: 0 });
  assert.deepEqual(errorHarness.errors, []);
});

test("an older current-owner error cannot overwrite a newer successful generation", async () => {
  const older = deferred<DashboardCatalogSnapshot>();
  const newer = deferred<DashboardCatalogSnapshot>();
  let request = 0;
  const backend = backendWithCatalog({
    list: () => (++request === 1 ? older.promise : newer.promise),
  });
  const harness = createHarness({ backend });
  const olderRefresh = harness.refresh();
  const newerRefresh = harness.refresh();
  newer.resolve(snapshot([session("newer")]));
  await newerRefresh;
  older.reject(new Error("older failed"));
  await olderRefresh;

  assert.deepEqual(harness.events, ["full:2"]);
  assert.deepEqual(harness.generation, { started: 2, successful: 2 });
});

test("a new owner cut may use local data until its first global success", async () => {
  let localCalls = 0;
  let fullCalls = 0;
  const backend = backendWithCatalog({
    listLocal: async () => {
      localCalls += 1;
      return snapshot([session(`local-${localCalls}`)]);
    },
    list: async () => {
      fullCalls += 1;
      return snapshot([session(`full-${fullCalls}`)]);
    },
  });
  const harness = createHarness({
    backend,
    generation: { started: 5, successful: 4 },
    firstGeneration: 6,
  });

  await harness.refresh();
  await harness.refresh();

  assert.equal(localCalls, 1);
  assert.equal(fullCalls, 2);
  assert.deepEqual(harness.generation, { started: 7, successful: 7 });
  assert.deepEqual(harness.events, ["local:6", "full:6", "full:7"]);
});

test("workspace refresh publishes local before full and cuts the deck only after full", async () => {
  const local = deferred<DashboardCatalogSnapshot>();
  const full = deferred<DashboardCatalogSnapshot>();
  let localCalls = 0;
  let fullCalls = 0;
  const backend = backendWithCatalog({
    listLocal: () => {
      localCalls += 1;
      return local.promise;
    },
    list: () => {
      fullCalls += 1;
      return full.promise;
    },
  });
  const harness = createHarness({ backend, sessionOrder: ["local", "remote"] });

  const pending = harness.refresh();
  assert.deepEqual(harness.generation, { started: 1, successful: 0 });
  assert.equal(localCalls, 1);
  assert.equal(fullCalls, 0);
  assert.equal(harness.fullCatalogCuts.length, 0);

  local.resolve(snapshot([session("local")]));
  await waitFor(() => fullCalls === 1);
  assert.deepEqual(harness.events, ["local:1"]);
  assert.deepEqual(harness.generation, { started: 1, successful: 1 });
  assert.equal(harness.fullCatalogCuts.length, 0, "local publication must not prune the deck");

  full.resolve(snapshot([session("remote", "build")]));
  await pending;
  assert.deepEqual(harness.events, ["local:1", "full:1"]);
  assert.deepEqual(harness.generation, { started: 1, successful: 1 });
  assert.deepEqual(harness.fullCatalogCuts, [{ generation: 1, sessionNames: ["remote"] }]);
});

test("a newer full publication fences a stale full response and callback", async () => {
  const first = deferred<DashboardCatalogSnapshot>();
  const second = deferred<DashboardCatalogSnapshot>();
  let request = 0;
  const backend = backendWithCatalog({
    list: () => {
      request += 1;
      return request === 1 ? first.promise : second.promise;
    },
  });
  const harness = createHarness({ backend });

  const olderRefresh = harness.refresh();
  const newerRefresh = harness.refresh();
  assert.deepEqual(harness.generation, { started: 2, successful: 0 });

  second.resolve(snapshot([session("newer")]));
  await newerRefresh;
  assert.deepEqual(harness.generation, { started: 2, successful: 2 });
  assert.deepEqual(harness.fullCatalogCuts, [{ generation: 2, sessionNames: ["newer"] }]);

  first.resolve(snapshot([session("stale")]));
  await olderRefresh;
  assert.deepEqual(harness.events, ["full:2"]);
  assert.deepEqual(harness.getCurrentSessions().map(({ name }) => name), ["newer"]);
  assert.equal(harness.fullCatalogCuts.length, 1, "stale full response must not invoke the callback");
});

test("an accepted older full publication survives when the newer refresh later fails", async () => {
  const older = deferred<DashboardCatalogSnapshot>();
  const newer = deferred<DashboardCatalogSnapshot>();
  let request = 0;
  const backend = backendWithCatalog({
    list: () => {
      request += 1;
      return request === 1 ? older.promise : newer.promise;
    },
  });
  const harness = createHarness({ backend });

  const olderRefresh = harness.refresh();
  const newerRefresh = harness.refresh();
  assert.deepEqual(harness.generation, { started: 2, successful: 0 });

  older.resolve(snapshot([session("older")]));
  await olderRefresh;
  assert.deepEqual(harness.generation, { started: 2, successful: 1 });
  assert.deepEqual(harness.events, ["full:1"]);
  assert.deepEqual(harness.fullCatalogCuts, [{ generation: 1, sessionNames: ["older"] }]);
  assert.deepEqual(harness.getCurrentSessions().map(({ name }) => name), ["older"]);

  newer.reject(new Error("newer refresh failed"));
  await newerRefresh;
  assert.deepEqual(harness.generation, { started: 2, successful: 1 });
  assert.deepEqual(harness.events, ["full:1", "error:Error: newer refresh failed"]);
  assert.equal(harness.fullPublications.length, 1);
  assert.deepEqual(harness.fullCatalogCuts, [{ generation: 1, sessionNames: ["older"] }]);
  assert.deepEqual(harness.errors, ["Error: newer refresh failed"]);
  assert.deepEqual(harness.getCurrentSessions().map(({ name }) => name), ["older"]);
});

test("full errors retain the last catalog, do not advance successful, and do not cut", async () => {
  const existingSessions = [session("existing")];
  const existingTerminals = [terminal("existing-terminal")];
  const backend = backendWithCatalog({
    list: () => Promise.reject(new Error("remote catalog unavailable")),
  });
  const harness = createHarness({
    backend,
    generation: { started: 4, successful: 4 },
    initialSessions: existingSessions,
    initialTerminals: existingTerminals,
  });

  await harness.refresh();

  assert.deepEqual(harness.generation, { started: 5, successful: 4 });
  assert.equal(harness.getCurrentSessions(), existingSessions);
  assert.equal(harness.getCurrentTerminals(), existingTerminals);
  assert.deepEqual(harness.errors, ["Error: remote catalog unavailable"]);
  assert.equal(harness.localPublications.length, 0);
  assert.equal(harness.fullPublications.length, 0);
  assert.equal(harness.fullCatalogCuts.length, 0);
});

test("local success may advance hydration when the later full request fails without cutting", async () => {
  const backend = backendWithCatalog({
    listLocal: () => Promise.resolve(snapshot([session("local")])),
    list: () => Promise.reject(new Error("remote failed")),
  });
  const harness = createHarness({ backend });

  await harness.refresh();

  assert.deepEqual(harness.events, ["local:1", "error:Error: remote failed"]);
  assert.deepEqual(harness.generation, { started: 1, successful: 1 });
  assert.equal(harness.fullCatalogCuts.length, 0);
});

test("failed session and terminal hosts retain only their own prior catalog entries", async () => {
  const initialSessions = [
    session("local-session"),
    session("build-session", "build"),
    session("relay-session", "relay"),
  ];
  const initialTerminals = [
    terminal("local-terminal"),
    terminal("build-terminal", "build"),
    terminal("relay-terminal", "relay"),
  ];
  const backend = backendWithCatalog({
    list: () => Promise.resolve(snapshot(
      [session("fresh-local-session")],
      [terminal("fresh-local-terminal")],
      ["build"],
      ["relay"],
    )),
  });
  const harness = createHarness({
    backend,
    generation: { started: 1, successful: 1 },
    initialSessions,
    initialTerminals,
  });

  await harness.refresh();

  const [publication] = harness.fullPublications;
  assert.ok(publication);
  assert.deepEqual(publication.failedSessionHostIds, ["build"]);
  assert.deepEqual(publication.failedTerminalHostIds, ["relay"]);
  assert.deepEqual(
    publication.sessions.map(({ name }) => name),
    ["fresh-local-session", "build-session"],
  );
  assert.deepEqual(
    publication.discoveredTerminals.map(({ id, discovered }) => [id, discovered]),
    [["fresh-local-terminal", true], ["relay-terminal", true]],
  );
  assert.equal(publication.partialError, "Remote catalog unavailable for: build, relay");
});

test("each successful full refresh publishes exactly one authoritative cut", async () => {
  let request = 0;
  const backend = backendWithCatalog({
    list: async () => {
      request += 1;
      return snapshot([session(`session-${request}`)]);
    },
  });
  const harness = createHarness({ backend });

  await harness.refresh();
  await harness.refresh();
  await harness.refresh();

  assert.deepEqual(harness.generation, { started: 3, successful: 3 });
  assert.deepEqual(harness.fullCatalogCuts, [
    { generation: 1, sessionNames: ["session-1"] },
    { generation: 2, sessionNames: ["session-2"] },
    { generation: 3, sessionNames: ["session-3"] },
  ]);
  assert.equal(harness.fullPublications.length, 3);
  assert.equal(harness.errors.length, 0);
});

test("legacy sessions and terminals fallback remains atomic on failure", async () => {
  const { backend } = createFakeDashboardBackend({
    list_sessions: () => [session("fallback-session")],
    list_tmux_terminals: () => Promise.reject(new Error("terminal fallback failed")),
  });
  backend.catalog = undefined;
  const existingSessions = [session("existing")];
  const harness = createHarness({
    backend,
    generation: { started: 2, successful: 2 },
    initialSessions: existingSessions,
  });

  await harness.refresh();

  assert.deepEqual(harness.generation, { started: 3, successful: 2 });
  assert.equal(harness.getCurrentSessions(), existingSessions);
  assert.equal(harness.fullPublications.length, 0);
  assert.equal(harness.fullCatalogCuts.length, 0);
  assert.deepEqual(harness.errors, ["Error: terminal fallback failed"]);
});
