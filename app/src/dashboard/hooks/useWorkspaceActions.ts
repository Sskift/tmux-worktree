import { useCallback, useLayoutEffect, useState } from "react";
import type {
  DashboardBackend,
  OrphanedWorktree,
  RestoreWorktreeInput,
  Session,
} from "../../platform";
import {
  createWorkspaceActionCoordinator,
  EMPTY_WORKSPACE_ACTION_STATE,
  type WorkspaceActionContext,
  type WorkspaceActionCoordinator,
  type WorkspaceActionState,
  type WorkspaceCreateWorktreeRequest,
  type WorkspaceTerminalDraft,
} from "../actions/workspaceActionCoordinator";

type WorkspaceActionOwnerPhaseHandle = Readonly<{
  coordinator: WorkspaceActionCoordinator;
}>;

export function useWorkspaceActions(dashboardBackend: DashboardBackend) {
  const [published, setPublished] = useState<WorkspaceActionState>(
    EMPTY_WORKSPACE_ACTION_STATE,
  );
  const [coordinator] = useState(() => createWorkspaceActionCoordinator(setPublished));
  const [ownerPhase] = useState<WorkspaceActionOwnerPhaseHandle>(() => ({ coordinator }));
  const visible = coordinator.view(dashboardBackend, published);
  const renderLease = coordinator.capture(dashboardBackend);

  const rememberAutomationContext = useCallback(
    (path: string, project: string | null) =>
      coordinator.rememberAutomationContext(renderLease, path, project),
    [coordinator, renderLease],
  );
  const resolveAutomationRoot = useCallback(
    (session: Session, project: string | null) =>
      coordinator.resolveAutomationRoot(renderLease, session, project),
    [coordinator, renderLease],
  );
  const createWorktree = useCallback(
    (request: WorkspaceCreateWorktreeRequest) =>
      coordinator.createWorktree(renderLease, request),
    [coordinator, renderLease],
  );
  const restoreWorktree = useCallback(
    (args: RestoreWorktreeInput) => coordinator.restoreWorktree(renderLease, args),
    [coordinator, renderLease],
  );
  const deleteWorktree = useCallback(
    (orphan: OrphanedWorktree) => coordinator.deleteWorktree(renderLease, orphan),
    [coordinator, renderLease],
  );
  const createTerminal = useCallback(
    (draft: WorkspaceTerminalDraft) => coordinator.createTerminal(renderLease, draft),
    [coordinator, renderLease],
  );
  const closeSession = useCallback(async (name: string): Promise<void> => {
    await coordinator.closeSession(renderLease, name);
  }, [coordinator, renderLease]);
  const closeTerminal = useCallback(async (id: string): Promise<void> => {
    await coordinator.closeTerminal(renderLease, id);
  }, [coordinator, renderLease]);

  return {
    ownerEpochKey: visible.ownerEpochKey,
    recentPath: visible.recentPath,
    recentProject: visible.recentProject,
    orphanRevision: visible.orphanRevision,
    rememberAutomationContext,
    resolveAutomationRoot,
    createWorktree,
    restoreWorktree,
    deleteWorktree,
    createTerminal,
    closeSession,
    closeTerminal,
    ownerPhase,
  };
}

export function useWorkspaceActionsOwnerPhase(
  ownerPhase: WorkspaceActionOwnerPhaseHandle,
  context: WorkspaceActionContext,
): void {
  const { coordinator } = ownerPhase;
  useLayoutEffect(() => {
    coordinator.commitContext(context);
  }, [
    context.backend,
    context.closeNewTerminal,
    context.closeNewWorktree,
    context.publishClosedSession,
    context.publishClosedTerminal,
    context.publishCreatedTerminal,
    context.publishPendingSession,
    context.reconcilePersistedTerminal,
    context.refreshProjects,
    context.refreshWorkspace,
    context.reportError,
    context.selectSession,
    context.selectTerminal,
    context.sessions,
    context.terminals,
    coordinator,
  ]);

  useLayoutEffect(() => {
    const activation = coordinator.activate();
    return () => {
      coordinator.deactivate(activation);
    };
  }, [coordinator]);
}
