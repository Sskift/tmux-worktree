import {
  automationSubmitStillOwnsDraft,
  type AutomationSubmitOwner,
} from "../../automationDraftSync";
import {
  automationFromRecord,
  automationRunFromRecord,
  automationSaveInputFromDraft,
  createAutomationDraft,
  shouldRunAutomationSchedule,
  type Automation,
  type AutomationDraft,
  type AutomationRun,
} from "../../automationTypes";
import type { DashboardBackend } from "../../platform";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochActivation,
  type OwnerEpochLease,
} from "../ownerEpochLease";

export type AutomationWorkspaceContext = Readonly<{
  backend: DashboardBackend;
  getAutomationSubmitOwner(): AutomationSubmitOwner;
  navigateToSavedAutomation(id: string): Promise<boolean>;
  reconcileAutomationSelection(automations: Automation[]): void;
  clearDeletedAutomationSelection(id: string): void;
  refreshWorkspace(): Promise<void>;
}>;

type AutomationWorkspaceOwner = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

export type AutomationWorkspaceState = Readonly<{
  owner: AutomationWorkspaceOwner | null;
  ownerEpochKey: string;
  automations: Automation[];
  runs: AutomationRun[];
  error: string | null;
}>;

export type AutomationWorkspaceCoordinator = Readonly<{
  commitContext(context: AutomationWorkspaceContext): void;
  activate(): OwnerEpochActivation;
  deactivate(activation: OwnerEpochActivation): void;
  view(owner: DashboardBackend, published: AutomationWorkspaceState): AutomationWorkspaceState;
  load(owner: DashboardBackend): Promise<boolean>;
  create(owner: DashboardBackend, draft: AutomationDraft): Promise<boolean>;
  save(owner: DashboardBackend, id: string, draft: AutomationDraft): Promise<boolean>;
  toggle(owner: DashboardBackend, id: string, active: boolean): Promise<boolean>;
  remove(owner: DashboardBackend, id: string): Promise<boolean>;
  run(owner: DashboardBackend, id: string): Promise<boolean>;
  tick(owner: DashboardBackend, now: Date): Promise<void>;
}>;

export const EMPTY_AUTOMATION_WORKSPACE_STATE: AutomationWorkspaceState = Object.freeze({
  owner: null,
  ownerEpochKey: "automation-owner-pending",
  automations: [],
  runs: [],
  error: null,
});

type ScheduledTickBatch = {
  lease: OwnerEpochLease<DashboardBackend>;
  now: Date;
  promise: Promise<void>;
  resolve(): void;
};

function createScheduledTickBatch(
  lease: OwnerEpochLease<DashboardBackend>,
  now: Date,
): ScheduledTickBatch {
  let resolvePromise!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    lease,
    now: new Date(now.getTime()),
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function ownerState(lease: OwnerEpochLease<DashboardBackend>): AutomationWorkspaceOwner {
  return { owner: lease.owner, epoch: lease.epoch };
}

function stateMatchesLease(
  state: AutomationWorkspaceState,
  lease: OwnerEpochLease<DashboardBackend> | null,
): boolean {
  return !!lease && state.owner?.owner === lease.owner && state.owner.epoch === lease.epoch;
}

export function createAutomationWorkspaceCoordinator(
  publish: (state: AutomationWorkspaceState) => void,
): AutomationWorkspaceCoordinator {
  const fence = createOwnerEpochLeaseController<DashboardBackend>();
  let context: AutomationWorkspaceContext | null = null;
  let automations: Automation[] = [];
  let runs: AutomationRun[] = [];
  let error: string | null = null;
  let loadSequence = 0;
  const scheduledMinuteByAutomation = new Map<string, string>();
  let schedulerRunning = false;
  let pendingScheduledBatch: ScheduledTickBatch | null = null;

  const currentContext = (
    lease: OwnerEpochLease<DashboardBackend>,
  ): AutomationWorkspaceContext | null => {
    if (!fence.isCurrent(lease) || context?.backend !== lease.owner) return null;
    return context;
  };

  const publishSnapshot = (lease: OwnerEpochLease<DashboardBackend>): boolean => {
    if (!fence.isCurrent(lease)) return false;
    publish({
      owner: ownerState(lease),
      ownerEpochKey: `automation-owner-${lease.epoch}`,
      automations,
      runs,
      error,
    });
    return fence.isCurrent(lease);
  };

  const publishError = (
    lease: OwnerEpochLease<DashboardBackend>,
    nextError: unknown,
  ): void => {
    if (!fence.isCurrent(lease)) return;
    error = String(nextError);
    publishSnapshot(lease);
  };

  const pruneScheduledMinutes = (): void => {
    const liveIds = new Set(automations.map((automation) => automation.id));
    for (const id of scheduledMinuteByAutomation.keys()) {
      if (!liveIds.has(id)) scheduledMinuteByAutomation.delete(id);
    }
  };

  const loadForLease = async (lease: OwnerEpochLease<DashboardBackend>): Promise<boolean> => {
    const loadContext = currentContext(lease);
    if (!loadContext) return false;
    const request = ++loadSequence;
    try {
      const [records, runRecords] = await Promise.all([
        loadContext.backend.automations.list(),
        loadContext.backend.automations.listRuns(null),
      ]);
      if (!currentContext(lease) || request !== loadSequence) return false;
      const nextAutomations = records.map(automationFromRecord);
      const automationsById = new Map(
        nextAutomations.map((automation) => [automation.id, automation]),
      );
      const nextRuns = runRecords.map((run) =>
        automationRunFromRecord(run, automationsById.get(run.automationId)),
      );
      if (!currentContext(lease) || request !== loadSequence) return false;
      automations = nextAutomations;
      runs = nextRuns;
      error = null;
      pruneScheduledMinutes();
      if (!publishSnapshot(lease) || request !== loadSequence) return false;
      const latestContext = currentContext(lease);
      if (!latestContext || request !== loadSequence) return false;
      latestContext.reconcileAutomationSelection(nextAutomations);
      return fence.isCurrent(lease) && request === loadSequence;
    } catch (nextError) {
      if (!currentContext(lease) || request !== loadSequence) return false;
      publishError(lease, nextError);
      return false;
    }
  };

  const beginMutation = (
    owner: DashboardBackend,
  ): { lease: OwnerEpochLease<DashboardBackend>; context: AutomationWorkspaceContext } | null => {
    const lease = fence.capture(owner);
    if (!lease) return null;
    const mutationContext = currentContext(lease);
    if (!mutationContext) return null;
    loadSequence += 1;
    return { lease, context: mutationContext };
  };

  const draftStillCurrent = (
    lease: OwnerEpochLease<DashboardBackend>,
    originatingDraft: AutomationSubmitOwner,
  ): boolean => {
    const latestContext = currentContext(lease);
    return !!latestContext && automationSubmitStillOwnsDraft(
      originatingDraft,
      latestContext.getAutomationSubmitOwner(),
    );
  };

  const finishSavedAutomation = async (
    lease: OwnerEpochLease<DashboardBackend>,
    originatingDraft: AutomationSubmitOwner,
    automation: Automation,
  ): Promise<boolean> => {
    if (!draftStillCurrent(lease, originatingDraft)) {
      if (currentContext(lease)) await loadForLease(lease);
      return false;
    }
    const navigationContext = currentContext(lease);
    if (!navigationContext) return false;
    const navigated = await navigationContext.navigateToSavedAutomation(automation.id);
    if (!currentContext(lease)) return false;
    const draftUnchangedAfterCancelledNavigation = navigated
      ? false
      : draftStillCurrent(lease, originatingDraft);
    await loadForLease(lease);
    if (!currentContext(lease)) return false;
    if (navigated) return true;
    return draftUnchangedAfterCancelledNavigation &&
      draftStillCurrent(lease, originatingDraft);
  };

  const runForLease = async (
    lease: OwnerEpochLease<DashboardBackend>,
    id: string,
  ): Promise<boolean> => {
    const runContext = currentContext(lease);
    if (!runContext) return false;
    loadSequence += 1;
    const automation = automations.find((item) => item.id === id);
    const runRecord = await runContext.backend.automations.trigger(id);
    if (!currentContext(lease)) return false;
    const run = automationRunFromRecord(runRecord, automation);
    runs = [run, ...runs.filter((item) => item.id !== run.id)];
    if (!publishSnapshot(lease)) return false;
    const refreshContext = currentContext(lease);
    if (!refreshContext) return false;
    await Promise.all([
      loadForLease(lease),
      refreshContext.refreshWorkspace(),
    ]);
    return fence.isCurrent(lease);
  };

  const runScheduledTick = async (
    lease: OwnerEpochLease<DashboardBackend>,
    now: Date,
  ): Promise<void> => {
    if (!fence.isCurrent(lease)) return;
    const minute = now.toISOString().slice(0, 16);
    const automationSnapshot = automations;
    for (const automation of automationSnapshot) {
      if (!fence.isCurrent(lease)) return;
      if (!shouldRunAutomationSchedule(automation, now)) continue;
      if (scheduledMinuteByAutomation.get(automation.id) === minute) continue;
      scheduledMinuteByAutomation.set(automation.id, minute);
      await runForLease(lease, automation.id).catch((nextError) => {
        publishError(lease, nextError);
        return false;
      });
    }
  };

  const executeScheduledBatch = async (batch: ScheduledTickBatch): Promise<void> => {
    try {
      await runScheduledTick(batch.lease, batch.now);
    } catch (nextError) {
      publishError(batch.lease, nextError);
    } finally {
      batch.resolve();
      const nextBatch = pendingScheduledBatch;
      pendingScheduledBatch = null;
      if (nextBatch) {
        void executeScheduledBatch(nextBatch);
      } else {
        schedulerRunning = false;
      }
    }
  };

  const discardPendingScheduledBatch = (): void => {
    const discarded = pendingScheduledBatch;
    pendingScheduledBatch = null;
    discarded?.resolve();
  };

  return {
    commitContext(nextContext) {
      context = nextContext;
      const ownerCommit = fence.commit(nextContext.backend);
      if (!ownerCommit.changed) return;
      loadSequence += 1;
      automations = [];
      runs = [];
      error = null;
      scheduledMinuteByAutomation.clear();
      discardPendingScheduledBatch();
      if (ownerCommit.lease) publishSnapshot(ownerCommit.lease);
    },

    activate() {
      const activation = fence.activate();
      const activeContext = context;
      if (activeContext) {
        const lease = fence.capture(activeContext.backend);
        if (lease) publishSnapshot(lease);
      }
      return activation;
    },

    deactivate(activation) {
      if (fence.deactivate(activation)) {
        loadSequence += 1;
        discardPendingScheduledBatch();
      }
    },

    view(owner, published) {
      const lease = fence.capture(owner);
      return stateMatchesLease(published, lease)
        ? published
        : EMPTY_AUTOMATION_WORKSPACE_STATE;
    },

    load(owner) {
      const lease = fence.capture(owner);
      return lease ? loadForLease(lease) : Promise.resolve(false);
    },

    async create(owner, draft) {
      const mutation = beginMutation(owner);
      if (!mutation) return false;
      const originatingDraft = mutation.context.getAutomationSubmitOwner();
      if (!currentContext(mutation.lease)) return false;
      const record = await mutation.context.backend.automations.save(
        automationSaveInputFromDraft(draft),
      );
      if (!currentContext(mutation.lease)) return false;
      return finishSavedAutomation(
        mutation.lease,
        originatingDraft,
        automationFromRecord(record),
      );
    },

    async save(owner, id, draft) {
      const mutation = beginMutation(owner);
      if (!mutation) return false;
      const originatingDraft = mutation.context.getAutomationSubmitOwner();
      if (!currentContext(mutation.lease)) return false;
      const record = await mutation.context.backend.automations.save(
        automationSaveInputFromDraft(draft, id),
      );
      if (!currentContext(mutation.lease)) return false;
      return finishSavedAutomation(
        mutation.lease,
        originatingDraft,
        automationFromRecord(record),
      );
    },

    async toggle(owner, id, active) {
      const mutation = beginMutation(owner);
      if (!mutation) return false;
      const automation = automations.find((item) => item.id === id);
      if (!automation || !currentContext(mutation.lease)) return false;
      await mutation.context.backend.automations.save(
        automationSaveInputFromDraft(
          { ...createAutomationDraft(automation), active },
          id,
        ),
      );
      if (!currentContext(mutation.lease)) return false;
      await loadForLease(mutation.lease);
      return fence.isCurrent(mutation.lease);
    },

    async remove(owner, id) {
      const mutation = beginMutation(owner);
      if (!mutation) return false;
      const automation = automations.find((item) => item.id === id);
      const confirmed = await mutation.context.backend.dialog.confirm({
        title: "Delete automation?",
        message: `This will remove ${automation?.name || "this automation"} and stop its future scheduled runs.`,
      });
      if (!currentContext(mutation.lease) || !confirmed) return false;
      await mutation.context.backend.automations.delete(id);
      if (!currentContext(mutation.lease)) return false;
      runs = runs.filter((run) => run.automationId !== id);
      if (!publishSnapshot(mutation.lease)) return false;
      const deleteContext = currentContext(mutation.lease);
      if (!deleteContext) return false;
      deleteContext.clearDeletedAutomationSelection(id);
      if (!currentContext(mutation.lease)) return false;
      await loadForLease(mutation.lease);
      return fence.isCurrent(mutation.lease);
    },

    run(owner, id) {
      const mutation = beginMutation(owner);
      return mutation ? runForLease(mutation.lease, id) : Promise.resolve(false);
    },

    tick(owner, now) {
      const lease = fence.capture(owner);
      if (!lease) return Promise.resolve();
      if (!schedulerRunning) {
        schedulerRunning = true;
        const batch = createScheduledTickBatch(lease, now);
        void executeScheduledBatch(batch);
        return batch.promise;
      }
      if (!pendingScheduledBatch) {
        pendingScheduledBatch = createScheduledTickBatch(lease, now);
      } else {
        pendingScheduledBatch.lease = lease;
        pendingScheduledBatch.now = new Date(now.getTime());
      }
      return pendingScheduledBatch.promise;
    },
  };
}
