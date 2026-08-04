import type {
  CreateWorktreeInput,
  CreatedTerminal,
  DashboardBackend,
  OrphanedWorktree,
  PlainTerminal,
  RestoreWorktreeInput,
  Session,
} from "../../platform";
import {
  sessionDisplayName,
  terminalSessionKey,
} from "../model/terminalIdentity";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochActivation,
  type OwnerEpochLease,
} from "../ownerEpochLease";

export type WorkspaceTerminalDraft = Readonly<{
  label: string;
  cwd: string;
  hostId?: string | null;
}>;

export type WorkspaceCreateWorktreeRequest = Readonly<{
  args: CreateWorktreeInput;
  preset?: Readonly<{ name: string; path: string }>;
}>;

export type WorkspaceActionContext = Readonly<{
  backend: DashboardBackend;
  sessions: readonly Session[];
  terminals: readonly PlainTerminal[];
  closeNewWorktree(): void;
  closeNewTerminal(): void;
  selectSession(name: string): Promise<boolean>;
  selectTerminal(id: string): Promise<boolean>;
  publishPendingSession(name: string): void;
  publishCreatedTerminal(
    draft: WorkspaceTerminalDraft,
    created: CreatedTerminal,
  ): string | null;
  publishClosedSession(name: string): void;
  publishClosedTerminal(id: string): void;
  reconcilePersistedTerminal(target: Readonly<{
    id: string;
    tmuxName: string;
    hostId: string | null;
  }>): void;
  refreshWorkspace(): Promise<void>;
  refreshProjects(): Promise<void>;
  reportError(error: unknown): void;
}>;

type WorkspaceActionOwner = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

export type WorkspaceActionState = Readonly<{
  owner: WorkspaceActionOwner | null;
  ownerEpochKey: string;
  recentPath: string | null;
  recentProject: string | null;
  orphanRevision: number;
}>;

export const EMPTY_WORKSPACE_ACTION_STATE: WorkspaceActionState = Object.freeze({
  owner: null,
  ownerEpochKey: "workspace-action-owner-pending",
  recentPath: null,
  recentProject: null,
  orphanRevision: 0,
});

type WorkspaceActionToken = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  slot: string;
  token: symbol;
  validate?: (context: WorkspaceActionContext) => boolean;
}>;

type RuntimePresence = Readonly<{
  identity: string;
  generation: number;
}>;

export type WorkspaceActionCoordinator = Readonly<{
  commitContext(context: WorkspaceActionContext): void;
  activate(): OwnerEpochActivation;
  deactivate(activation: OwnerEpochActivation): void;
  capture(owner: DashboardBackend): OwnerEpochLease<DashboardBackend> | null;
  view(owner: DashboardBackend, published: WorkspaceActionState): WorkspaceActionState;
  rememberAutomationContext(
    lease: OwnerEpochLease<DashboardBackend> | null,
    path: string,
    project: string | null,
  ): boolean;
  resolveAutomationRoot(
    lease: OwnerEpochLease<DashboardBackend> | null,
    session: Session,
    project: string | null,
  ): Promise<boolean>;
  createWorktree(
    lease: OwnerEpochLease<DashboardBackend> | null,
    request: WorkspaceCreateWorktreeRequest,
  ): Promise<boolean>;
  restoreWorktree(
    lease: OwnerEpochLease<DashboardBackend> | null,
    args: RestoreWorktreeInput,
  ): Promise<boolean>;
  deleteWorktree(
    lease: OwnerEpochLease<DashboardBackend> | null,
    orphan: OrphanedWorktree,
  ): Promise<boolean>;
  createTerminal(
    lease: OwnerEpochLease<DashboardBackend> | null,
    draft: WorkspaceTerminalDraft,
  ): Promise<boolean>;
  closeSession(
    lease: OwnerEpochLease<DashboardBackend> | null,
    name: string,
  ): Promise<boolean>;
  closeTerminal(
    lease: OwnerEpochLease<DashboardBackend> | null,
    id: string,
  ): Promise<boolean>;
}>;

function ownerState(
  lease: OwnerEpochLease<DashboardBackend>,
): WorkspaceActionOwner {
  return { owner: lease.owner, epoch: lease.epoch };
}

function stateMatchesLease(
  state: WorkspaceActionState,
  lease: OwnerEpochLease<DashboardBackend> | null,
): boolean {
  return !!lease && state.owner?.owner === lease.owner && state.owner.epoch === lease.epoch;
}

export function createWorkspaceActionCoordinator(
  publish: (state: WorkspaceActionState) => void,
): WorkspaceActionCoordinator {
  const fence = createOwnerEpochLeaseController<DashboardBackend>();
  let context: WorkspaceActionContext | null = null;
  let recentPath: string | null = null;
  let recentProject: string | null = null;
  let sessionPresence = new Map<string, RuntimePresence>();
  let terminalPresence = new Map<string, RuntimePresence>();
  let nextPresenceGeneration = 1;
  let orphanRevision = 0;
  const activeActions = new Map<string, WorkspaceActionToken>();

  const currentContext = (
    lease: OwnerEpochLease<DashboardBackend>,
  ): WorkspaceActionContext | null => {
    if (!fence.isCurrent(lease) || context?.backend !== lease.owner) return null;
    return context;
  };

  const publishSnapshot = (lease: OwnerEpochLease<DashboardBackend>): boolean => {
    if (!fence.isCurrent(lease)) return false;
    publish({
      owner: ownerState(lease),
      ownerEpochKey: `workspace-action-owner-${lease.epoch}`,
      recentPath,
      recentProject,
      orphanRevision,
    });
    return fence.isCurrent(lease);
  };

  const sessionIdentity = (session: Session): string => JSON.stringify([
    session.name,
    session.created,
    session.hostId ?? null,
    session.rawName ?? session.name,
    session.managed ?? false,
  ]);

  const terminalIdentity = (terminal: PlainTerminal): string => JSON.stringify([
    terminal.id,
    terminal.tmuxName,
    terminal.hostId ?? null,
    terminal.rawName ?? terminal.tmuxName,
    terminal.managed ?? false,
    terminal.discovered ?? false,
  ]);

  const reconcileCatalogPresence = (nextContext: WorkspaceActionContext): void => {
    const nextSessions = new Map<string, RuntimePresence>();
    for (const session of nextContext.sessions) {
      const identity = sessionIdentity(session);
      const previous = sessionPresence.get(session.name);
      nextSessions.set(session.name, previous?.identity === identity
        ? previous
        : { identity, generation: nextPresenceGeneration++ });
    }
    sessionPresence = nextSessions;

    const nextTerminals = new Map<string, RuntimePresence>();
    for (const terminal of nextContext.terminals) {
      const identity = terminalIdentity(terminal);
      const previous = terminalPresence.get(terminal.id);
      nextTerminals.set(terminal.id, previous?.identity === identity
        ? previous
        : { identity, generation: nextPresenceGeneration++ });
    }
    terminalPresence = nextTerminals;
  };

  const sessionFingerprint = (session: Session): string => JSON.stringify([
    sessionIdentity(session),
    sessionPresence.get(session.name)?.generation ?? null,
  ]);

  const terminalFingerprint = (terminal: PlainTerminal): string => JSON.stringify([
    terminalIdentity(terminal),
    terminalPresence.get(terminal.id)?.generation ?? null,
  ]);

  const beginAction = (
    lease: OwnerEpochLease<DashboardBackend> | null,
    slot: string,
    validate?: (nextContext: WorkspaceActionContext) => boolean,
    replaceExisting = false,
  ): WorkspaceActionToken | null => {
    if (!lease || !fence.isCurrent(lease) || !currentContext(lease)) return null;
    // Mutation slots are single-flight. Replacing an in-flight token only
    // fences its UI publication; it does not cancel the backend mutation and
    // can therefore create/delete the same resource more than once. Read-only
    // latest-wins requests opt in to replacement explicitly below.
    if (!replaceExisting && activeActions.has(slot)) return null;
    const action: WorkspaceActionToken = {
      lease,
      slot,
      token: Symbol(slot),
      ...(validate ? { validate } : {}),
    };
    activeActions.set(slot, action);
    return action;
  };

  const actionContext = (
    action: WorkspaceActionToken,
  ): WorkspaceActionContext | null => {
    if (activeActions.get(action.slot) !== action) return null;
    const nextContext = currentContext(action.lease);
    if (!nextContext || (action.validate && !action.validate(nextContext))) return null;
    return nextContext;
  };

  const finishAction = (action: WorkspaceActionToken): void => {
    if (activeActions.get(action.slot) === action) activeActions.delete(action.slot);
  };

  const reconcileStaleMutation = (
    owner: DashboardBackend,
    options: Readonly<{
      persistedTerminal?: Readonly<{
        id: string;
        tmuxName: string;
        hostId: string | null;
      }>;
      createdTerminal?: Readonly<{
        draft: WorkspaceTerminalDraft;
        created: CreatedTerminal;
      }>;
      reloadOrphans?: boolean;
    }> = {},
  ): void => {
    const nextContext = context;
    if (nextContext?.backend !== owner) return;
    const lease = fence.capture(owner);
    if (!lease || !currentContext(lease)) return;
    if (options.reloadOrphans) {
      orphanRevision += 1;
      publishSnapshot(lease);
    }
    if (options.persistedTerminal) {
      const target = options.persistedTerminal;
      void nextContext.backend.sessions.exists(target.tmuxName)
        .then((exists) => {
          const current = currentContext(lease);
          if (!current || exists) return;
          current.reconcilePersistedTerminal(target);
        })
        .catch(() => {});
    }
    if (options.createdTerminal) {
      const { draft, created } = options.createdTerminal;
      const sessionKey = terminalSessionKey({
        id: "reconcile-created-terminal",
        label: draft.label,
        cwd: created.cwd,
        tmuxName: created.tmuxName,
        hostId: created.hostId ?? draft.hostId ?? null,
        rawName: created.rawName,
        managed: created.managed,
      });
      void nextContext.backend.sessions.exists(sessionKey)
        .then((exists) => {
          const current = currentContext(lease);
          if (!current || !exists) return;
          current.publishCreatedTerminal(draft, created);
        })
        .catch(() => {});
    }
    void Promise.allSettled([
      nextContext.refreshWorkspace(),
      nextContext.refreshProjects(),
    ]);
  };

  const completeCreatedWorktree = async (
    action: WorkspaceActionToken,
    sessionName: string,
  ): Promise<boolean> => {
    let nextContext = actionContext(action);
    if (!nextContext) return false;
    nextContext.closeNewWorktree();
    const navigated = await nextContext.selectSession(sessionName);
    nextContext = actionContext(action);
    if (!nextContext) {
      reconcileStaleMutation(action.lease.owner);
      return false;
    }
    if (navigated) {
      nextContext.publishPendingSession(sessionName);
      void nextContext.refreshProjects();
      void nextContext.refreshWorkspace();
    }
    return true;
  };

  const reportCurrentError = (
    action: WorkspaceActionToken,
    error: unknown,
  ): void => {
    actionContext(action)?.reportError(error);
  };

  return {
    commitContext(nextContext) {
      context = nextContext;
      const ownerCommit = fence.commit(nextContext.backend);
      if (ownerCommit.changed) {
        activeActions.clear();
        recentPath = null;
        recentProject = null;
        sessionPresence = new Map();
        terminalPresence = new Map();
        nextPresenceGeneration = 1;
        orphanRevision = 0;
      }
      reconcileCatalogPresence(nextContext);
      if (ownerCommit.changed && ownerCommit.lease) publishSnapshot(ownerCommit.lease);
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
      if (fence.deactivate(activation)) activeActions.clear();
    },

    capture(owner) {
      return fence.capture(owner);
    },

    view(owner, published) {
      const lease = fence.capture(owner);
      return stateMatchesLease(published, lease)
        ? published
        : EMPTY_WORKSPACE_ACTION_STATE;
    },

    rememberAutomationContext(lease, path, project) {
      if (!lease || !fence.isCurrent(lease) || !currentContext(lease)) return false;
      recentPath = path;
      recentProject = project;
      return publishSnapshot(lease);
    },

    async resolveAutomationRoot(lease, session, project) {
      const fingerprint = sessionFingerprint(session);
      const action = beginAction(lease, "automation-root", (nextContext) => {
        const current = nextContext.sessions.find(({ name }) => name === session.name);
        return !!current && sessionFingerprint(current) === fingerprint;
      }, true);
      if (!action) return false;
      try {
        const startContext = actionContext(action);
        if (!startContext) return false;
        const cwd = await startContext.backend.sessions.root(session.name);
        if (!actionContext(action) || !cwd) return false;
        recentPath = cwd;
        recentProject = project;
        return publishSnapshot(action.lease);
      } catch {
        return false;
      } finally {
        finishAction(action);
      }
    },

    async createWorktree(lease, request) {
      const action = beginAction(lease, "worktree-modal");
      if (!action) return false;
      let dispatched = false;
      try {
        let nextContext = actionContext(action);
        if (!nextContext) return false;
        if (request.preset) {
          if (!actionContext(action)) return false;
          dispatched = true;
          await nextContext.backend.projects.add(request.preset);
          nextContext = actionContext(action);
          if (!nextContext) {
            reconcileStaleMutation(action.lease.owner);
            return false;
          }
        }
        if (!actionContext(action)) return false;
        dispatched = true;
        const sessionName = await nextContext.backend.worktrees.create(request.args);
        if (!actionContext(action)) {
          reconcileStaleMutation(action.lease.owner);
          return false;
        }
        return await completeCreatedWorktree(action, sessionName);
      } catch (error) {
        if (actionContext(action)) throw error;
        if (dispatched) reconcileStaleMutation(action.lease.owner);
        return false;
      } finally {
        finishAction(action);
      }
    },

    async restoreWorktree(lease, args) {
      const action = beginAction(lease, "worktree-modal");
      if (!action) return false;
      let dispatched = false;
      try {
        const nextContext = actionContext(action);
        if (!nextContext) return false;
        dispatched = true;
        const sessionName = await nextContext.backend.worktrees.restore(args);
        if (!actionContext(action)) {
          reconcileStaleMutation(action.lease.owner);
          return false;
        }
        return await completeCreatedWorktree(action, sessionName);
      } catch (error) {
        if (actionContext(action)) throw error;
        if (dispatched) reconcileStaleMutation(action.lease.owner);
        return false;
      } finally {
        finishAction(action);
      }
    },

    async deleteWorktree(lease, orphan) {
      const action = beginAction(lease, "worktree-modal");
      if (!action) return false;
      let dispatched = false;
      try {
        let nextContext = actionContext(action);
        if (!nextContext) return false;
        const confirmed = await nextContext.backend.dialog.confirm({
          title: "Delete worktree",
          message: orphan.hostId
            ? `Delete remote worktree "${orphan.name}"? This will discard uncommitted changes. On Linux hosts, processes whose working directory is inside it are also stopped.`
            : `Delete worktree "${orphan.name}"? This will discard any uncommitted changes.`,
        });
        nextContext = actionContext(action);
        if (!nextContext || !confirmed) return false;
        if (!actionContext(action)) return false;
        dispatched = true;
        await nextContext.backend.worktrees.delete({
          path: orphan.path,
          force: true,
          ...(orphan.hostId ? { hostId: orphan.hostId } : {}),
        });
        if (!actionContext(action)) {
          reconcileStaleMutation(action.lease.owner, { reloadOrphans: true });
          return false;
        }
        void nextContext.refreshWorkspace();
        return true;
      } catch (error) {
        if (actionContext(action)) throw error;
        if (dispatched) {
          reconcileStaleMutation(action.lease.owner, { reloadOrphans: true });
        }
        return false;
      } finally {
        finishAction(action);
      }
    },

    async createTerminal(lease, draft) {
      const action = beginAction(lease, "terminal-modal");
      if (!action) return false;
      let dispatched = false;
      let created: CreatedTerminal | null = null;
      try {
        let nextContext = actionContext(action);
        if (!nextContext) return false;
        if (!actionContext(action)) return false;
        dispatched = true;
        created = await nextContext.backend.terminals.create({
          cwd: draft.cwd,
          aiCmd: "",
          hostId: draft.hostId ?? null,
        });
        nextContext = actionContext(action);
        if (!nextContext) {
          reconcileStaleMutation(action.lease.owner, {
            createdTerminal: { draft, created },
          });
          return false;
        }
        const id = nextContext.publishCreatedTerminal(draft, created);
        if (!id || !actionContext(action)) return false;
        nextContext.closeNewTerminal();
        await nextContext.selectTerminal(id);
        if (!actionContext(action)) {
          reconcileStaleMutation(action.lease.owner, {
            createdTerminal: { draft, created },
          });
          return false;
        }
        return true;
      } catch (error) {
        if (actionContext(action)) throw error;
        if (dispatched) {
          reconcileStaleMutation(action.lease.owner, {
            ...(created ? { createdTerminal: { draft, created } } : {}),
          });
        }
        return false;
      } finally {
        finishAction(action);
      }
    },

    async closeSession(lease, name) {
      const owner = lease?.owner;
      const initialContext = context;
      const session = owner && initialContext?.backend === owner
        ? initialContext.sessions.find((candidate) => candidate.name === name)
        : null;
      if (!session) return false;
      const fingerprint = sessionFingerprint(session);
      const action = beginAction(lease, `close-session:${name}`, (nextContext) => {
        const current = nextContext.sessions.find((candidate) => candidate.name === name);
        return !!current && sessionFingerprint(current) === fingerprint;
      });
      if (!action) return false;
      let dispatched = false;
      try {
        let nextContext = actionContext(action);
        if (!nextContext) return false;
        const confirmed = await nextContext.backend.dialog.confirm({
          title: "Close worktree session?",
          message:
            `This will stop the tmux session for ${sessionDisplayName(session)}. ` +
            "The worktree and its files will not be deleted.",
        });
        nextContext = actionContext(action);
        if (!nextContext || !confirmed) return false;
        if (!actionContext(action)) return false;
        dispatched = true;
        await nextContext.backend.sessions.kill(name, session.managed ?? false);
        nextContext = actionContext(action);
        if (!nextContext) {
          reconcileStaleMutation(action.lease.owner);
          return false;
        }
        nextContext.publishClosedSession(name);
        return true;
      } catch (error) {
        if (actionContext(action)) reportCurrentError(action, error);
        else if (dispatched) reconcileStaleMutation(action.lease.owner);
        return false;
      } finally {
        finishAction(action);
      }
    },

    async closeTerminal(lease, id) {
      const owner = lease?.owner;
      const initialContext = context;
      const terminal = owner && initialContext?.backend === owner
        ? initialContext.terminals.find((candidate) => candidate.id === id)
        : null;
      if (!terminal) return false;
      const fingerprint = terminalFingerprint(terminal);
      const action = beginAction(lease, `close-terminal:${id}`, (nextContext) => {
        const current = nextContext.terminals.find((candidate) => candidate.id === id);
        return !!current && terminalFingerprint(current) === fingerprint;
      });
      if (!action) return false;
      let dispatched = false;
      try {
        let nextContext = actionContext(action);
        if (!nextContext) return false;
        const confirmed = await nextContext.backend.dialog.confirm({
          title: "Close terminal?",
          message: `This will stop the tmux session for ${terminal.label}.`,
        });
        nextContext = actionContext(action);
        if (!nextContext || !confirmed) return false;
        if (!actionContext(action)) return false;
        dispatched = true;
        const sessionName = terminalSessionKey(terminal);
        if (terminal.discovered) {
          await nextContext.backend.sessions.kill(sessionName, terminal.managed ?? false);
        } else {
          await nextContext.backend.terminals.kill(sessionName, terminal.managed ?? false);
        }
        nextContext = actionContext(action);
        if (!nextContext) {
          reconcileStaleMutation(action.lease.owner, {
            ...(terminal.discovered
              ? {}
              : {
                  persistedTerminal: {
                    id: terminal.id,
                    tmuxName: terminal.tmuxName,
                    hostId: terminal.hostId ?? null,
                  },
                }),
          });
          return false;
        }
        nextContext.publishClosedTerminal(id);
        return true;
      } catch (error) {
        if (actionContext(action)) reportCurrentError(action, error);
        else if (dispatched) {
          reconcileStaleMutation(action.lease.owner, {
            ...(terminal.discovered
              ? {}
              : {
                  persistedTerminal: {
                    id: terminal.id,
                    tmuxName: terminal.tmuxName,
                    hostId: terminal.hostId ?? null,
                  },
                }),
          });
        }
        return false;
      } finally {
        finishAction(action);
      }
    },
  };
}
