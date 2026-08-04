import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationWorkspaceCoordinator,
  EMPTY_AUTOMATION_WORKSPACE_STATE,
  type AutomationWorkspaceContext,
  type AutomationWorkspaceState,
} from "../src/dashboard/automation/automationWorkspaceCoordinator.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type {
  AutomationDraft,
  AutomationRecord,
  AutomationRunRecord,
} from "../src/automationTypes.ts";
import type { AutomationSubmitOwner } from "../src/automationDraftSync.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
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

function record(id: string, overrides: Partial<AutomationRecord> = {}): AutomationRecord {
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
    ...overrides,
  };
}

function runRecord(id: string, automationId = "a"): AutomationRunRecord {
  return {
    id,
    automationId,
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    sessionName: null,
    error: null,
  };
}

const draft: AutomationDraft = {
  name: "a",
  instruction: "work",
  aiCmd: "claude",
  project: "",
  path: "/repo",
  schedule: "",
  allowOverlap: false,
  active: true,
};

type Harness = ReturnType<typeof createHarness>;

function createHarness(backend?: DashboardBackend) {
  const activeBackend = backend ?? createFakeDashboardBackend().backend;
  let published: AutomationWorkspaceState = EMPTY_AUTOMATION_WORKSPACE_STATE;
  let draftOwner: AutomationSubmitOwner = { contextKey: "automation:a", revision: 1 };
  const navigations: string[] = [];
  const reconciliations: string[][] = [];
  const deletedSelections: string[] = [];
  let workspaceRefreshes = 0;
  let navigate: (id: string) => Promise<boolean> = async (id) => {
    navigations.push(id);
    return true;
  };
  const coordinator = createAutomationWorkspaceCoordinator((state) => {
    published = state;
  });
  const context = (nextBackend = activeBackend): AutomationWorkspaceContext => ({
    backend: nextBackend,
    getAutomationSubmitOwner: () => draftOwner,
    navigateToSavedAutomation: (id) => navigate(id),
    reconcileAutomationSelection: (items) => {
      reconciliations.push(items.map(({ id }) => id));
    },
    clearDeletedAutomationSelection: (id) => {
      deletedSelections.push(id);
    },
    refreshWorkspace: async () => {
      workspaceRefreshes += 1;
    },
  });
  coordinator.commitContext(context());
  const activation = coordinator.activate();
  return {
    activation,
    backend: activeBackend,
    context,
    coordinator,
    deletedSelections,
    navigations,
    reconciliations,
    get published() {
      return published;
    },
    get workspaceRefreshes() {
      return workspaceRefreshes;
    },
    setDraftOwner(next: { contextKey: string | null; revision: number }) {
      draftOwner = next;
    },
    setNavigate(next: (id: string) => Promise<boolean>) {
      navigate = next;
    },
  };
}

function installImmediateAutomationBackend(
  backend: DashboardBackend,
  records: AutomationRecord[] = [record("a")],
  runRecords: AutomationRunRecord[] = [],
): void {
  backend.automations.list = async () => records;
  backend.automations.listRuns = async () => runRecords;
  backend.automations.save = async (input) => record(input.id ?? "created", {
    name: input.name,
    instruction: input.instruction,
  });
  backend.automations.delete = async () => {};
  backend.automations.trigger = async (id) => runRecord(`run-${id}`, id);
}

async function loadInitial(harness: Harness): Promise<void> {
  assert.equal(await harness.coordinator.load(harness.backend), true);
}

test("only the latest owner load may publish, reconcile, or report an error", async () => {
  const backend = createFakeDashboardBackend().backend;
  const firstList = deferred<AutomationRecord[]>();
  const firstRuns = deferred<AutomationRunRecord[]>();
  const secondList = deferred<AutomationRecord[]>();
  const secondRuns = deferred<AutomationRunRecord[]>();
  let listRequest = 0;
  let runRequest = 0;
  backend.automations.list = () => (++listRequest === 1 ? firstList.promise : secondList.promise);
  backend.automations.listRuns = () => (++runRequest === 1 ? firstRuns.promise : secondRuns.promise);
  const harness = createHarness(backend);

  const older = harness.coordinator.load(backend);
  const newer = harness.coordinator.load(backend);
  secondList.resolve([record("new")]);
  secondRuns.resolve([runRecord("new-run", "new")]);
  assert.equal(await newer, true);
  assert.deepEqual(harness.published.automations.map(({ id }) => id), ["new"]);
  assert.deepEqual(harness.reconciliations, [["new"]]);

  firstList.reject(new Error("old load failed"));
  firstRuns.resolve([]);
  assert.equal(await older, false);
  assert.equal(harness.published.error, null);
  assert.deepEqual(harness.reconciliations, [["new"]]);
});

test("owner cuts and exact lifecycle fencing never revive A across A to B to A", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  installImmediateAutomationBackend(backendA, [record("A")]);
  installImmediateAutomationBackend(backendB, [record("B")]);
  const harness = createHarness(backendA);
  await loadInitial(harness);
  const firstAKey = harness.published.ownerEpochKey;

  harness.coordinator.commitContext(harness.context(backendB));
  assert.deepEqual(harness.published.automations, []);
  assert.notEqual(harness.published.ownerEpochKey, firstAKey);
  assert.equal(await harness.coordinator.load(backendA), false);
  assert.equal(await harness.coordinator.load(backendB), true);
  const bKey = harness.published.ownerEpochKey;

  harness.coordinator.commitContext(harness.context(backendA));
  assert.deepEqual(harness.published.automations, []);
  assert.notEqual(harness.published.ownerEpochKey, firstAKey);
  assert.notEqual(harness.published.ownerEpochKey, bKey);
  assert.equal(await harness.coordinator.load(backendA), true);
  assert.deepEqual(harness.published.automations.map(({ id }) => id), ["A"]);

  harness.coordinator.deactivate(harness.activation);
  assert.equal(await harness.coordinator.load(backendA), false);
  const replay = harness.coordinator.activate();
  assert.equal(await harness.coordinator.load(backendA), true);
  harness.coordinator.deactivate(harness.activation);
  assert.equal(await harness.coordinator.load(backendA), true, "stale cleanup must not stop replay");
  harness.coordinator.deactivate(replay);
});

test("a mutation invalidates an older load before the mutation settles", async () => {
  const backend = createFakeDashboardBackend().backend;
  const oldList = deferred<AutomationRecord[]>();
  const oldRuns = deferred<AutomationRunRecord[]>();
  const saved = deferred<AutomationRecord>();
  let listCalls = 0;
  backend.automations.list = () => {
    listCalls += 1;
    return listCalls === 1 ? oldList.promise : Promise.resolve([record("created")]);
  };
  backend.automations.listRuns = () =>
    listCalls === 1 ? oldRuns.promise : Promise.resolve([]);
  backend.automations.save = () => saved.promise;
  const harness = createHarness(backend);
  const oldLoad = harness.coordinator.load(backend);
  const creating = harness.coordinator.create(backend, draft);
  oldList.resolve([record("stale")]);
  oldRuns.resolve([]);
  assert.equal(await oldLoad, false);
  assert.deepEqual(harness.published.automations, []);
  saved.resolve(record("created"));
  assert.equal(await creating, true);
  assert.deepEqual(harness.published.automations.map(({ id }) => id), ["created"]);
});

test("saved navigation accepts expected key rollover and editor cancellation but rejects edits", async () => {
  const successBackend = createFakeDashboardBackend().backend;
  installImmediateAutomationBackend(successBackend);
  const successful = createHarness(successBackend);
  successful.setNavigate(async (id) => {
    successful.navigations.push(id);
    successful.setDraftOwner({ contextKey: "automation:created", revision: 2 });
    return true;
  });
  assert.equal(await successful.coordinator.create(successBackend, draft), true);
  assert.deepEqual(successful.navigations, ["created"]);

  const cancelledBackend = createFakeDashboardBackend().backend;
  installImmediateAutomationBackend(cancelledBackend);
  const cancelled = createHarness(cancelledBackend);
  cancelled.setNavigate(async () => false);
  assert.equal(await cancelled.coordinator.save(cancelledBackend, "a", draft), true);

  const editedBackend = createFakeDashboardBackend().backend;
  installImmediateAutomationBackend(editedBackend);
  const edited = createHarness(editedBackend);
  const navigation = deferred<boolean>();
  edited.setNavigate(() => navigation.promise);
  const pendingSave = edited.coordinator.save(editedBackend, "a", draft);
  await Promise.resolve();
  edited.setDraftOwner({ contextKey: "automation:a", revision: 2 });
  navigation.resolve(false);
  assert.equal(await pendingSave, false);
});

test("backend changes during save or navigation return false without cross-owner tails", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const save = deferred<AutomationRecord>();
  installImmediateAutomationBackend(backendA);
  installImmediateAutomationBackend(backendB, [record("B")]);
  backendA.automations.save = () => save.promise;
  const duringSave = createHarness(backendA);
  const creating = duringSave.coordinator.create(backendA, draft);
  duringSave.coordinator.commitContext(duringSave.context(backendB));
  save.resolve(record("created"));
  assert.equal(await creating, false);
  assert.deepEqual(duringSave.navigations, []);

  const navigation = deferred<boolean>();
  const duringNavigation = createHarness(backendA);
  installImmediateAutomationBackend(backendA);
  duringNavigation.setNavigate(() => navigation.promise);
  const saving = duringNavigation.coordinator.save(backendA, "a", draft);
  await Promise.resolve();
  duringNavigation.coordinator.commitContext(duringNavigation.context(backendB));
  navigation.resolve(true);
  assert.equal(await saving, false);
  assert.deepEqual(duringNavigation.published.automations, []);
});

test("delete confirmation and post-send tails remain owned by the exact lease", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  installImmediateAutomationBackend(backendA, [record("a")], [runRecord("run-a")]);
  installImmediateAutomationBackend(backendB, [record("b")]);
  const confirm = deferred<boolean>();
  let deletes = 0;
  backendA.dialog.confirm = () => confirm.promise;
  backendA.automations.delete = async () => { deletes += 1; };
  const beforeSend = createHarness(backendA);
  await loadInitial(beforeSend);
  const removing = beforeSend.coordinator.remove(backendA, "a");
  beforeSend.coordinator.commitContext(beforeSend.context(backendB));
  confirm.resolve(true);
  assert.equal(await removing, false);
  assert.equal(deletes, 0);

  const sentDelete = deferred<void>();
  const afterSend = createHarness(backendA);
  backendA.dialog.confirm = async () => true;
  backendA.automations.delete = () => {
    deletes += 1;
    return sentDelete.promise;
  };
  await loadInitial(afterSend);
  const sent = afterSend.coordinator.remove(backendA, "a");
  await Promise.resolve();
  afterSend.coordinator.commitContext(afterSend.context(backendB));
  sentDelete.resolve();
  assert.equal(await sent, false);
  assert.deepEqual(afterSend.deletedSelections, []);
  assert.deepEqual(afterSend.published.runs, []);
});

test("run tails are fenced and scheduled minutes remain bounded and deduplicated", async () => {
  const backend = createFakeDashboardBackend().backend;
  const scheduled = record("scheduled", {
    triggerType: "schedule",
    schedule: "* * * * *",
  });
  const scheduledSecond = record("scheduled-second", {
    triggerType: "schedule",
    schedule: "* * * * *",
  });
  let records = [scheduled, scheduledSecond];
  let triggers = 0;
  let activeTriggers = 0;
  let maxActiveTriggers = 0;
  installImmediateAutomationBackend(backend, records);
  backend.automations.list = async () => records;
  backend.automations.trigger = async (id) => {
    triggers += 1;
    activeTriggers += 1;
    maxActiveTriggers = Math.max(maxActiveTriggers, activeTriggers);
    await Promise.resolve();
    activeTriggers -= 1;
    return runRecord(`run-${triggers}`, id);
  };
  const harness = createHarness(backend);
  await loadInitial(harness);
  const minute = new Date("2026-01-01T12:00:00.000Z");
  await harness.coordinator.tick(backend, minute);
  await harness.coordinator.tick(backend, minute);
  assert.equal(triggers, 2);
  assert.equal(maxActiveTriggers, 1, "scheduled runs must stay at fixed serial concurrency");
  assert.equal(harness.workspaceRefreshes, 2);

  records = [];
  await harness.coordinator.load(backend);
  records = [scheduled, scheduledSecond];
  await harness.coordinator.load(backend);
  await harness.coordinator.tick(backend, minute);
  assert.equal(triggers, 4, "load pruning must release removed IDs without growing the map");

  const backendB = createFakeDashboardBackend().backend;
  installImmediateAutomationBackend(backendB, []);
  harness.coordinator.commitContext(harness.context(backendB));
  harness.coordinator.commitContext(harness.context(backend));
  await harness.coordinator.load(backend);
  await harness.coordinator.tick(backend, minute);
  assert.equal(triggers, 6, "owner changes must clear same-minute scheduler ownership");
  assert.equal(maxActiveTriggers, 1);
});

test("overlapping ticks share one pending batch, settle each batch, and drop old-owner pending work", async () => {
  const backendA = createFakeDashboardBackend().backend;
  const backendB = createFakeDashboardBackend().backend;
  const scheduled = record("scheduled", {
    triggerType: "schedule",
    schedule: "* * * * *",
  });
  installImmediateAutomationBackend(backendA, [scheduled]);
  installImmediateAutomationBackend(backendB, [scheduled]);
  const firstTrigger = deferred<AutomationRunRecord>();
  const secondTrigger = deferred<AutomationRunRecord>();
  const thirdTrigger = deferred<AutomationRunRecord>();
  let triggerCalls = 0;
  let activeTriggers = 0;
  let maxActiveTriggers = 0;
  backendA.automations.trigger = async (id) => {
    triggerCalls += 1;
    activeTriggers += 1;
    maxActiveTriggers = Math.max(maxActiveTriggers, activeTriggers);
    try {
      if (triggerCalls === 1) return await firstTrigger.promise;
      if (triggerCalls === 2) return await secondTrigger.promise;
      if (triggerCalls === 3) return await thirdTrigger.promise;
      return runRecord(`run-${triggerCalls}`, id);
    } finally {
      activeTriggers -= 1;
    }
  };
  const harness = createHarness(backendA);
  await loadInitial(harness);

  const first = harness.coordinator.tick(backendA, new Date("2026-01-01T12:00:00.000Z"));
  await waitFor(() => triggerCalls === 1);
  const skippedMiddle = harness.coordinator.tick(
    backendA,
    new Date("2026-01-01T12:01:00.000Z"),
  );
  const latestDate = new Date("2026-01-01T12:02:00.000Z");
  const latest = harness.coordinator.tick(backendA, latestDate);
  latestDate.setTime(Number.NaN);
  assert.equal(skippedMiddle, latest, "overlap must share one bounded drain promise");
  firstTrigger.resolve(runRecord("run-1", "scheduled"));
  await first;
  assert.equal(triggerCalls, 2, "only the latest pending tick may survive coalescing");
  let latestSettled = false;
  void latest.then(() => {
    latestSettled = true;
  });
  const nextPending = harness.coordinator.tick(
    backendA,
    new Date("2026-01-01T12:03:00.000Z"),
  );
  harness.coordinator.tick(backendA, new Date("2026-01-01T12:04:00.000Z"));
  secondTrigger.resolve(runRecord("run-2", "scheduled"));
  await latest;
  assert.equal(latestSettled, true, "a running batch must settle before later pending work");
  assert.equal(triggerCalls, 3, "the next pending batch must start after the prior batch settles");
  assert.equal(maxActiveTriggers, 1);

  const oldPending = harness.coordinator.tick(
    backendA,
    new Date("2026-01-01T12:05:00.000Z"),
  );
  assert.notEqual(nextPending, oldPending, "running and pending batches need distinct completion promises");
  harness.coordinator.commitContext(harness.context(backendB));
  await oldPending;
  await harness.coordinator.load(backendB);
  let backendBTriggers = 0;
  backendB.automations.trigger = async (id) => {
    backendBTriggers += 1;
    return runRecord(`run-b-${backendBTriggers}`, id);
  };
  const newOwnerPending = harness.coordinator.tick(
    backendB,
    new Date("2026-01-01T12:06:00.000Z"),
  );
  await harness.coordinator.tick(backendA, new Date("2026-01-01T12:07:00.000Z"));
  thirdTrigger.resolve(runRecord("run-3", "scheduled"));
  await nextPending;
  await newOwnerPending;
  assert.equal(triggerCalls, 3, "owner cut must discard the old pending tick");
  assert.equal(backendBTriggers, 1, "a stale owner must not replace the new owner's pending batch");
  assert.equal(maxActiveTriggers, 1);
});
