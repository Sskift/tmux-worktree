import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceActionCoordinator,
  EMPTY_WORKSPACE_ACTION_STATE,
  type WorkspaceActionContext,
  type WorkspaceActionState,
  type WorkspaceTerminalDraft,
} from "../src/dashboard/actions/workspaceActionCoordinator.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type {
  CreatedTerminal,
  DashboardBackend,
  PlainTerminal,
  ProjectPreset,
  Session,
} from "../src/platform/index.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function session(name: string, created = 1): Session {
  return {
    name,
    attached: false,
    window_count: 1,
    created,
    activity: created,
    rawName: name,
    managed: true,
  };
}

function terminal(id: string, tmuxName = `tw-${id}`): PlainTerminal {
  return {
    id,
    label: id,
    cwd: `/repo/${id}`,
    tmuxName,
    rawName: tmuxName,
    managed: true,
  };
}

function createdTerminal(tmuxName: string): CreatedTerminal {
  return {
    tmuxName,
    rawName: tmuxName,
    cwd: "/repo/new",
    hostId: null,
    managed: true,
  };
}

function createHarness(initialBackend = createFakeDashboardBackend().backend) {
  let published: WorkspaceActionState = EMPTY_WORKSPACE_ACTION_STATE;
  let activeBackend = initialBackend;
  let sessions: Session[] = [];
  let terminals: PlainTerminal[] = [];
  const selectedSessions: string[] = [];
  const selectedTerminals: string[] = [];
  const pendingSessions: string[] = [];
  const createdTerminals: string[] = [];
  const createdTerminalPublications: Array<{
    draft: WorkspaceTerminalDraft;
    created: CreatedTerminal;
  }> = [];
  const closedSessions: string[] = [];
  const closedTerminals: string[] = [];
  const reconciledPersistedTerminals: Array<Readonly<{
    id: string;
    tmuxName: string;
    hostId: string | null;
  }>> = [];
  const errors: string[] = [];
  let worktreeModalCloses = 0;
  let terminalModalCloses = 0;
  let workspaceRefreshes = 0;
  let projectRefreshes = 0;
  let nextTerminalId = 1;
  const coordinator = createWorkspaceActionCoordinator((state) => {
    published = state;
  });

  const context = (backend = activeBackend): WorkspaceActionContext => ({
    backend,
    sessions,
    terminals,
    closeNewWorktree() {
      worktreeModalCloses += 1;
    },
    closeNewTerminal() {
      terminalModalCloses += 1;
    },
    async selectSession(name) {
      selectedSessions.push(name);
      return true;
    },
    async selectTerminal(id) {
      selectedTerminals.push(id);
      return true;
    },
    publishPendingSession(name) {
      pendingSessions.push(name);
    },
    publishCreatedTerminal(draft, created) {
      const id = `created-${nextTerminalId++}`;
      createdTerminals.push(`${id}:${created.tmuxName}`);
      createdTerminalPublications.push({ draft, created });
      return id;
    },
    publishClosedSession(name) {
      closedSessions.push(name);
    },
    publishClosedTerminal(id) {
      closedTerminals.push(id);
    },
    reconcilePersistedTerminal(target) {
      reconciledPersistedTerminals.push(target);
    },
    async refreshWorkspace() {
      workspaceRefreshes += 1;
    },
    async refreshProjects() {
      projectRefreshes += 1;
    },
    reportError(error) {
      errors.push(String(error));
    },
  });

  coordinator.commitContext(context());
  let activation = coordinator.activate();

  return {
    coordinator,
    get published() { return published; },
    get selectedSessions() { return selectedSessions; },
    get selectedTerminals() { return selectedTerminals; },
    get pendingSessions() { return pendingSessions; },
    get createdTerminals() { return createdTerminals; },
    get createdTerminalPublications() { return createdTerminalPublications; },
    get closedSessions() { return closedSessions; },
    get closedTerminals() { return closedTerminals; },
    get reconciledPersistedTerminals() { return reconciledPersistedTerminals; },
    get errors() { return errors; },
    get worktreeModalCloses() { return worktreeModalCloses; },
    get terminalModalCloses() { return terminalModalCloses; },
    get workspaceRefreshes() { return workspaceRefreshes; },
    get projectRefreshes() { return projectRefreshes; },
    capture(backend = activeBackend) {
      return coordinator.capture(backend);
    },
    setCatalog(nextSessions: Session[], nextTerminals: PlainTerminal[]) {
      sessions = nextSessions;
      terminals = nextTerminals;
      coordinator.commitContext(context());
    },
    commitBackend(backend: DashboardBackend) {
      activeBackend = backend;
      coordinator.commitContext(context(backend));
    },
    replayActivation() {
      coordinator.deactivate(activation);
      activation = coordinator.activate();
    },
    deactivate() {
      coordinator.deactivate(activation);
    },
  };
}

const terminalDraft: WorkspaceTerminalDraft = {
  label: "agent",
  cwd: "/repo/new",
  hostId: null,
};

test("speculative backend B cannot invalidate committed owner A", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const created = deferred<string>();
  backendA.worktrees.create = async () => created.promise;
  let backendBCalls = 0;
  backendB.worktrees.create = async () => {
    backendBCalls += 1;
    return "b";
  };
  const harness = createHarness(backendA);
  const pendingA = harness.coordinator.createWorktree(harness.capture(backendA), {
    args: { aiCmd: "codex", name: null, path: "/repo/a" },
  });

  assert.strictEqual(
    harness.coordinator.view(backendB, harness.published),
    EMPTY_WORKSPACE_ACTION_STATE,
  );
  assert.equal(await harness.coordinator.createWorktree(harness.capture(backendB), {
    args: { aiCmd: "codex", name: null, path: "/repo/b" },
  }), false);
  assert.equal(backendBCalls, 0);

  created.resolve("session-a");
  assert.equal(await pendingA, true);
  assert.deepEqual(harness.selectedSessions, ["session-a"]);
});

test("worktree creation is single-flight while the modal mutation is pending", async () => {
  const backend = createFakeDashboardBackend().backend;
  const created = deferred<string>();
  let createCalls = 0;
  backend.worktrees.create = async () => {
    createCalls += 1;
    return created.promise;
  };
  const harness = createHarness(backend);
  const lease = harness.capture(backend);
  const request = {
    args: { aiCmd: "codex", name: null, path: "/repo/a" },
  };

  const first = harness.coordinator.createWorktree(lease, request);
  assert.equal(await harness.coordinator.createWorktree(lease, request), false);
  assert.equal(createCalls, 1);

  created.resolve("session-a");
  assert.equal(await first, true);
  assert.deepEqual(harness.selectedSessions, ["session-a"]);
});

test("committing B rejects late A worktree publication and A to B to A2 stays exact", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const created = deferred<string>();
  backendA.worktrees.create = async () => created.promise;
  const harness = createHarness(backendA);
  const staleA1Lease = harness.capture(backendA);
  const pendingA = harness.coordinator.createWorktree(staleA1Lease, {
    args: { aiCmd: "codex", name: null, path: "/repo/a" },
  });

  harness.commitBackend(backendB);
  harness.commitBackend(backendA);
  assert.equal(
    await harness.coordinator.createWorktree(staleA1Lease, {
      args: { aiCmd: "codex", name: null, path: "/repo/stale" },
    }),
    false,
  );
  created.resolve("session-a1");
  assert.equal(await pendingA, false);
  assert.deepEqual(harness.selectedSessions, []);
  assert.deepEqual(harness.pendingSessions, []);
  assert.equal(harness.worktreeModalCloses, 0);
  assert.ok(harness.workspaceRefreshes >= 1);
});

test("a persisted preset and navigation tail reconcile only the current same backend", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const preset = deferred<ProjectPreset[]>();
  backendA.projects.add = async () => preset.promise;
  let creates = 0;
  backendA.worktrees.create = async () => {
    creates += 1;
    return "created-after-preset";
  };
  const harness = createHarness(backendA);
  const pending = harness.coordinator.createWorktree(harness.capture(backendA), {
    args: { aiCmd: "codex", name: null, path: "/repo/a" },
    preset: { name: "a", path: "/repo/a" },
  });

  harness.commitBackend(backendB);
  harness.commitBackend(backendA);
  preset.resolve([]);
  assert.equal(await pending, false);
  assert.equal(creates, 0);
  assert.ok(harness.projectRefreshes >= 1);
  assert.ok(harness.workspaceRefreshes >= 1);
});

test("a worktree created before an owner switch cannot publish after navigation awaits", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  backendA.worktrees.create = async () => "created-a";
  const navigation = deferred<boolean>();
  const harness = createHarness(backendA);
  harness.coordinator.commitContext({
    backend: backendA,
    sessions: [],
    terminals: [],
    closeNewWorktree() {},
    closeNewTerminal() {},
    async selectSession() { return navigation.promise; },
    async selectTerminal() { return true; },
    publishPendingSession() { assert.fail("stale pending session publication"); },
    publishCreatedTerminal() { return null; },
    publishClosedSession() {},
    publishClosedTerminal() {},
    reconcilePersistedTerminal() {},
    async refreshWorkspace() {},
    async refreshProjects() {},
    reportError() {},
  });
  const pending = harness.coordinator.createWorktree(harness.capture(backendA), {
    args: { aiCmd: "codex", name: null, path: "/repo/a" },
  });
  await Promise.resolve();
  harness.commitBackend(backendB);
  navigation.resolve(true);
  assert.equal(await pending, false);
});

test("terminal create from A cannot publish metadata, selection, or modal state into B", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const created = deferred<CreatedTerminal>();
  backendA.terminals.create = async () => created.promise;
  const harness = createHarness(backendA);
  const pendingA = harness.coordinator.createTerminal(harness.capture(backendA), terminalDraft);

  harness.commitBackend(backendB);
  created.resolve(createdTerminal("tw-a"));
  assert.equal(await pendingA, false);
  assert.deepEqual(harness.createdTerminals, []);
  assert.deepEqual(harness.selectedTerminals, []);
  assert.equal(harness.terminalModalCloses, 0);
  assert.equal(harness.workspaceRefreshes, 0);
  assert.equal(harness.projectRefreshes, 0);
});

test("activation replay invalidates pending work while the replayed owner can proceed", async () => {
  const backend = createFakeDashboardBackend().backend;
  const first = deferred<CreatedTerminal>();
  let request = 0;
  const createInputs: unknown[] = [];
  backend.terminals.create = async (args) => {
    createInputs.push(args);
    request += 1;
    return request === 1 ? first.promise : createdTerminal("tw-replay");
  };
  const harness = createHarness(backend);
  const oldCreate = harness.coordinator.createTerminal(harness.capture(backend), terminalDraft);
  harness.replayActivation();
  const replayedCreate = harness.coordinator.createTerminal(harness.capture(backend), terminalDraft);

  first.resolve(createdTerminal("tw-old"));
  assert.equal(await oldCreate, false);
  assert.equal(await replayedCreate, true);
  assert.deepEqual(harness.createdTerminals, ["created-1:tw-replay"]);
  assert.deepEqual(harness.createdTerminalPublications, [{
    draft: terminalDraft,
    created: createdTerminal("tw-replay"),
  }]);
  assert.deepEqual(createInputs, [
    { cwd: "/repo/new", aiCmd: "", hostId: null },
    { cwd: "/repo/new", aiCmd: "", hostId: null },
  ]);
});

test("session telemetry refresh preserves confirmed business identity", async () => {
  const backend = createFakeDashboardBackend().backend;
  const confirmed = deferred<boolean>();
  backend.dialog.confirm = async () => confirmed.promise;
  let sessionKills = 0;
  backend.sessions.kill = async () => { sessionKills += 1; };
  const harness = createHarness(backend);
  harness.setCatalog([session("same")], []);
  const closeSession = harness.coordinator.closeSession(harness.capture(backend), "same");

  harness.setCatalog([{
    ...session("same"),
    attached: true,
    window_count: 4,
    activity: 99,
    output_signature: "telemetry-refresh",
  }], []);
  confirmed.resolve(true);
  assert.equal(await closeSession, true);
  assert.equal(sessionKills, 1);
  assert.deepEqual(harness.closedSessions, ["same"]);
});

test("discovered terminal telemetry refresh preserves confirmed runtime identity", async () => {
  const backend = createFakeDashboardBackend().backend;
  const confirmed = deferred<boolean>();
  backend.dialog.confirm = async () => confirmed.promise;
  let terminalKills = 0;
  backend.sessions.kill = async () => { terminalKills += 1; };
  const harness = createHarness(backend);
  const original = { ...terminal("same"), discovered: true };
  harness.setCatalog([], [original]);
  const closing = harness.coordinator.closeTerminal(harness.capture(backend), "same");

  harness.setCatalog([], [{
    ...original,
    label: "telemetry label",
    cwd: "/refreshed/cwd",
    aiCmd: "claude",
  }]);
  confirmed.resolve(true);
  assert.equal(await closing, true);
  assert.equal(terminalKills, 1);
  assert.deepEqual(harness.closedTerminals, ["same"]);
});

test("catalog absence mints new session and terminal presence generations", async () => {
  const backend = createFakeDashboardBackend().backend;
  const sessionConfirm = deferred<boolean>();
  const terminalConfirm = deferred<boolean>();
  let confirmRequest = 0;
  backend.dialog.confirm = async () => {
    confirmRequest += 1;
    return confirmRequest === 1 ? sessionConfirm.promise : terminalConfirm.promise;
  };
  let sessionKills = 0;
  let terminalKills = 0;
  backend.sessions.kill = async () => { sessionKills += 1; };
  backend.terminals.kill = async () => { terminalKills += 1; };
  const harness = createHarness(backend);
  harness.setCatalog([session("same")], [terminal("same")]);
  const closeSession = harness.coordinator.closeSession(harness.capture(backend), "same");
  const closeTerminal = harness.coordinator.closeTerminal(harness.capture(backend), "same");

  harness.setCatalog([], []);
  harness.setCatalog([session("same")], [terminal("same")]);
  sessionConfirm.resolve(true);
  terminalConfirm.resolve(true);
  assert.equal(await closeSession, false);
  assert.equal(await closeTerminal, false);
  assert.equal(sessionKills, 0);
  assert.equal(terminalKills, 0);
  assert.deepEqual(harness.closedSessions, []);
  assert.deepEqual(harness.closedTerminals, []);
});

test("continuous runtime identity changes mint new presence generations", async () => {
  const backend = createFakeDashboardBackend().backend;
  const sessionConfirm = deferred<boolean>();
  const terminalConfirm = deferred<boolean>();
  let confirmRequest = 0;
  backend.dialog.confirm = async () => {
    confirmRequest += 1;
    return confirmRequest === 1 ? sessionConfirm.promise : terminalConfirm.promise;
  };
  let sessionKills = 0;
  let terminalKills = 0;
  backend.sessions.kill = async () => { sessionKills += 1; };
  backend.terminals.kill = async () => { terminalKills += 1; };
  const harness = createHarness(backend);
  harness.setCatalog([session("same", 1)], [terminal("same", "tw-old")]);
  const closeSession = harness.coordinator.closeSession(harness.capture(backend), "same");
  const closeTerminal = harness.coordinator.closeTerminal(harness.capture(backend), "same");

  harness.setCatalog([session("same", 2)], [terminal("same", "tw-new")]);
  sessionConfirm.resolve(true);
  terminalConfirm.resolve(true);
  assert.equal(await closeSession, false);
  assert.equal(await closeTerminal, false);
  assert.equal(sessionKills, 0);
  assert.equal(terminalKills, 0);
});

test("stale created terminal is revalidated and idempotently published to A2", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const created = deferred<CreatedTerminal>();
  const existenceChecks: string[] = [];
  backendA.terminals.create = async () => created.promise;
  backendA.sessions.exists = async (name) => {
    existenceChecks.push(name);
    return true;
  };
  const harness = createHarness(backendA);
  const draft = { ...terminalDraft, hostId: "host-a" };
  const pending = harness.coordinator.createTerminal(harness.capture(backendA), draft);

  harness.commitBackend(backendB);
  harness.commitBackend(backendA);
  const result = createdTerminal("host-a:tw-created");
  result.hostId = "host-a";
  result.rawName = "tw-created";
  created.resolve(result);
  assert.equal(await pending, false);
  await settle();

  assert.deepEqual(existenceChecks, ["host-a:tw-created"]);
  assert.deepEqual(harness.createdTerminalPublications, [{ draft, created: result }]);
  assert.deepEqual(harness.selectedTerminals, []);
  assert.equal(harness.terminalModalCloses, 0);
});

test("stale persisted terminal kill reconciles authoritative A2 metadata", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const killed = deferred<void>();
  backendA.dialog.confirm = async () => true;
  backendA.terminals.kill = async () => killed.promise;
  let existenceChecks = 0;
  backendA.sessions.exists = async () => {
    existenceChecks += 1;
    return false;
  };
  const harness = createHarness(backendA);
  const target = terminal("persisted");
  harness.setCatalog([], [target]);
  const closing = harness.coordinator.closeTerminal(harness.capture(backendA), target.id);
  await Promise.resolve();

  harness.commitBackend(backendB);
  harness.commitBackend(backendA);
  harness.setCatalog([], [{ ...target }]);
  harness.replayActivation();
  killed.resolve();
  assert.equal(await closing, false);
  await settle();

  assert.equal(existenceChecks, 1);
  assert.deepEqual(harness.closedTerminals, []);
  assert.deepEqual(harness.reconciledPersistedTerminals, [{
    id: target.id,
    tmuxName: target.tmuxName,
    hostId: null,
  }]);
});

test("stale worktree delete advances the current owner orphan revision", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const deleted = deferred<void>();
  backendA.dialog.confirm = async () => true;
  backendA.worktrees.delete = async () => deleted.promise;
  const harness = createHarness(backendA);
  const deleting = harness.coordinator.deleteWorktree(harness.capture(backendA), {
    name: "orphan",
    path: "/repo/orphan",
    project: "workspace",
  });
  await Promise.resolve();

  harness.commitBackend(backendB);
  harness.commitBackend(backendA);
  harness.replayActivation();
  assert.equal(harness.published.orphanRevision, 0);
  deleted.resolve();
  assert.equal(await deleting, false);

  assert.equal(harness.published.orphanRevision, 1);
  assert.equal(
    harness.coordinator.view(backendA, harness.published).orphanRevision,
    1,
  );
});

test("remote orphan deletion preserves the selected host boundary", async () => {
  const backend = createFakeDashboardBackend().backend;
  backend.dialog.confirm = async () => true;
  const requests: unknown[] = [];
  backend.worktrees.delete = async (args) => { requests.push(args); };
  const harness = createHarness(backend);

  assert.equal(await harness.coordinator.deleteWorktree(harness.capture(backend), {
    name: "remote-orphan",
    path: "/srv/worktrees/demo/remote-orphan-a1b2c",
    project: "demo",
    hostId: "mew-dev",
  }), true);
  assert.deepEqual(requests, [{
    path: "/srv/worktrees/demo/remote-orphan-a1b2c",
    force: true,
    hostId: "mew-dev",
  }]);
});

test("automation root is latest by exact owner and session incarnation", async () => {
  const backend = createFakeDashboardBackend().backend;
  const rootX1 = deferred<string>();
  const rootY = deferred<string>();
  const rootX2 = deferred<string>();
  let request = 0;
  backend.sessions.root = async () => {
    request += 1;
    return request === 1 ? rootX1.promise : request === 2 ? rootY.promise : rootX2.promise;
  };
  const harness = createHarness(backend);
  const x1 = session("x", 1);
  const y = session("y", 2);
  const x2 = session("x", 3);
  harness.setCatalog([x1], []);
  const pendingX1 = harness.coordinator.resolveAutomationRoot(harness.capture(backend), x1, "px1");
  harness.setCatalog([y], []);
  const pendingY = harness.coordinator.resolveAutomationRoot(harness.capture(backend), y, "py");
  harness.setCatalog([x2], []);
  const pendingX2 = harness.coordinator.resolveAutomationRoot(harness.capture(backend), x2, "px2");

  rootX1.resolve("/x1");
  rootY.resolve("/y");
  rootX2.resolve("/x2");
  assert.equal(await pendingX1, false);
  assert.equal(await pendingY, false);
  assert.equal(await pendingX2, true);
  assert.equal(harness.published.recentPath, "/x2");
  assert.equal(harness.published.recentProject, "px2");
});

test("owner switch during destructive confirmation prevents backend dispatch", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const confirmed = deferred<boolean>();
  backendA.dialog.confirm = async () => confirmed.promise;
  let kills = 0;
  backendA.sessions.kill = async () => { kills += 1; };
  const harness = createHarness(backendA);
  harness.setCatalog([session("a")], []);
  const closing = harness.coordinator.closeSession(harness.capture(backendA), "a");

  harness.commitBackend(backendB);
  confirmed.resolve(true);
  assert.equal(await closing, false);
  assert.equal(kills, 0);
});
