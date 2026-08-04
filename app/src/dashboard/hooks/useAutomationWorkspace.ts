import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { AutomationDraft } from "../../automationTypes";
import type { DashboardBackend } from "../../platform";
import {
  createAutomationWorkspaceCoordinator,
  EMPTY_AUTOMATION_WORKSPACE_STATE,
  type AutomationWorkspaceContext,
  type AutomationWorkspaceCoordinator,
  type AutomationWorkspaceState,
} from "../automation/automationWorkspaceCoordinator";

type AutomationWorkspaceOwnerPhaseHandle = Readonly<{
  coordinator: AutomationWorkspaceCoordinator;
}>;

export function useAutomationWorkspace(dashboardBackend: DashboardBackend) {
  const [published, setPublished] = useState<AutomationWorkspaceState>(
    EMPTY_AUTOMATION_WORKSPACE_STATE,
  );
  const [coordinator] = useState(() => createAutomationWorkspaceCoordinator(setPublished));
  const [ownerPhase] = useState<AutomationWorkspaceOwnerPhaseHandle>(() => ({ coordinator }));
  const visible = coordinator.view(dashboardBackend, published);

  const load = useCallback(
    () => coordinator.load(dashboardBackend),
    [coordinator, dashboardBackend],
  );
  const create = useCallback(
    (draft: AutomationDraft) => coordinator.create(dashboardBackend, draft),
    [coordinator, dashboardBackend],
  );
  const save = useCallback(
    (id: string, draft: AutomationDraft) => coordinator.save(dashboardBackend, id, draft),
    [coordinator, dashboardBackend],
  );
  const toggle = useCallback(
    (id: string, active: boolean) => coordinator.toggle(dashboardBackend, id, active),
    [coordinator, dashboardBackend],
  );
  const remove = useCallback(
    (id: string) => coordinator.remove(dashboardBackend, id),
    [coordinator, dashboardBackend],
  );
  const run = useCallback(
    (id: string) => coordinator.run(dashboardBackend, id),
    [coordinator, dashboardBackend],
  );
  const tick = useCallback(
    (now: Date) => coordinator.tick(dashboardBackend, now),
    [coordinator, dashboardBackend],
  );

  return {
    automations: visible.automations,
    runs: visible.runs,
    error: visible.error,
    ownerEpochKey: visible.ownerEpochKey,
    load,
    create,
    save,
    toggle,
    remove,
    run,
    tick,
    ownerPhase,
  };
}

export function useAutomationWorkspaceOwnerPhase(
  ownerPhase: AutomationWorkspaceOwnerPhaseHandle,
  context: AutomationWorkspaceContext,
): void {
  const { coordinator } = ownerPhase;
  useLayoutEffect(() => {
    coordinator.commitContext(context);
  }, [context.backend, context.clearDeletedAutomationSelection, context.getAutomationSubmitOwner,
    context.navigateToSavedAutomation, context.reconcileAutomationSelection,
    context.refreshWorkspace, coordinator]);

  useLayoutEffect(() => {
    const activation = coordinator.activate();
    return () => {
      coordinator.deactivate(activation);
    };
  }, [coordinator]);
}

export function useAutomationWorkspaceHydrationPhase(
  load: () => Promise<boolean>,
): void {
  useEffect(() => {
    void load();
  }, [load]);
}

export function useAutomationWorkspaceSchedulerPhase(
  tick: (now: Date) => Promise<void>,
): void {
  useEffect(() => {
    const runScheduledAutomations = () => {
      void tick(new Date());
    };
    const id = setInterval(runScheduledAutomations, 30_000);
    return () => clearInterval(id);
  }, [tick]);
}
