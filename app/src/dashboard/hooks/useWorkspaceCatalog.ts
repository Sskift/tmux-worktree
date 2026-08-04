import { useCallback, useLayoutEffect, useState } from "react";
import type { DashboardBackend, PlainTerminal, Session } from "../../platform";
import {
  samePlainTerminals,
  sameSessionActivity,
  sameSessions,
} from "../model/catalogEquality";
import type {
  PreviousSessionActivity,
  SessionActivityInfo,
} from "../model/sessionActivity";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochLease,
  type OwnerEpochLeaseController,
} from "../ownerEpochLease";
import {
  workspaceCatalogRefresh,
  type WorkspaceCatalogGenerationFence,
  type WorkspaceCatalogPublication,
  type WorkspaceCatalogFullPublication,
} from "./workspaceCatalogRefresh";

export type FullCatalogPublished = {
  generation: number;
  sessionNames: string[];
};

type CatalogOwnerTag = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

type WorkspaceCatalogState = Readonly<{
  owner: CatalogOwnerTag | null;
  sessions: Session[];
  discoveredTerminals: PlainTerminal[];
  sessionActivity: Record<string, SessionActivityInfo>;
  catalogRefreshGeneration: number;
  failedSessionHostIds: string[];
  failedTerminalHostIds: string[];
  error: string | null;
}>;

type WorkspaceCatalogRegistration = {
  fence: OwnerEpochLeaseController<DashboardBackend>;
  backend: DashboardBackend | null;
  sessionOrder: string[];
  onFullCatalogPublished: (publication: FullCatalogPublished) => void;
  generation: WorkspaceCatalogGenerationFence;
  firstGeneration: number;
  ownerPublishedGeneration: number;
  sessions: Session[];
  discoveredTerminals: PlainTerminal[];
  previousActivity: Map<string, PreviousSessionActivity>;
  sessionActivity: Record<string, SessionActivityInfo>;
  failedSessionHostIds: string[];
  failedTerminalHostIds: string[];
  error: string | null;
};

type WorkspaceCatalogOwnerPhaseHandle = Readonly<{
  registration: WorkspaceCatalogRegistration;
}>;

const EMPTY_SESSIONS: Session[] = [];
const EMPTY_TERMINALS: PlainTerminal[] = [];
const EMPTY_ACTIVITY: Record<string, SessionActivityInfo> = {};
const EMPTY_HOST_IDS: string[] = [];

const EMPTY_STATE: WorkspaceCatalogState = {
  owner: null,
  sessions: EMPTY_SESSIONS,
  discoveredTerminals: EMPTY_TERMINALS,
  sessionActivity: EMPTY_ACTIVITY,
  catalogRefreshGeneration: 0,
  failedSessionHostIds: EMPTY_HOST_IDS,
  failedTerminalHostIds: EMPTY_HOST_IDS,
  error: null,
};

function ownerTag(lease: OwnerEpochLease<DashboardBackend>): CatalogOwnerTag {
  return { owner: lease.owner, epoch: lease.epoch };
}

function stateMatchesLease(
  state: WorkspaceCatalogState,
  lease: OwnerEpochLease<DashboardBackend> | null,
): boolean {
  return !!lease && state.owner?.owner === lease.owner && state.owner.epoch === lease.epoch;
}

function stateFromRegistration(
  registration: WorkspaceCatalogRegistration,
  lease: OwnerEpochLease<DashboardBackend>,
): WorkspaceCatalogState {
  return {
    owner: ownerTag(lease),
    sessions: registration.sessions,
    discoveredTerminals: registration.discoveredTerminals,
    sessionActivity: registration.sessionActivity,
    catalogRefreshGeneration: registration.ownerPublishedGeneration,
    failedSessionHostIds: registration.failedSessionHostIds,
    failedTerminalHostIds: registration.failedTerminalHostIds,
    error: registration.error,
  };
}

function createWorkspaceCatalogRegistration(): WorkspaceCatalogRegistration {
  return {
    fence: createOwnerEpochLeaseController<DashboardBackend>(),
    backend: null,
    sessionOrder: [],
    onFullCatalogPublished: () => {},
    generation: { started: 0, successful: 0 },
    firstGeneration: 1,
    ownerPublishedGeneration: 0,
    sessions: [],
    discoveredTerminals: [],
    previousActivity: new Map(),
    sessionActivity: {},
    failedSessionHostIds: [],
    failedTerminalHostIds: [],
    error: null,
  };
}

export function useWorkspaceCatalog(dashboardBackend: DashboardBackend) {
  const [registration] = useState(createWorkspaceCatalogRegistration);
  const [ownerPhase] = useState<WorkspaceCatalogOwnerPhaseHandle>(() => ({ registration }));
  const [catalogState, setCatalogState] = useState<WorkspaceCatalogState>(EMPTY_STATE);
  const renderLease = registration.fence.capture(dashboardBackend);
  const visibleState = stateMatchesLease(catalogState, renderLease) ? catalogState : EMPTY_STATE;

  const publishState = useCallback((
    lease: OwnerEpochLease<DashboardBackend>,
  ) => {
    if (!registration.fence.isCurrent(lease)) return;
    setCatalogState(stateFromRegistration(registration, lease));
  }, [registration]);

  const refresh = useCallback(() => {
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease || registration.backend !== dashboardBackend) return Promise.resolve();
    const firstGeneration = registration.firstGeneration;
    return workspaceCatalogRefresh({
      backend: dashboardBackend,
      generation: registration.generation,
      firstGeneration: firstGeneration,
      lease: lease,
      isCurrent: (candidate) => registration.fence.isCurrent(candidate),
      getCurrentSessions: () =>
        registration.fence.isCurrent(lease) ? registration.sessions : EMPTY_SESSIONS,
      getCurrentDiscoveredTerminals: () =>
        registration.fence.isCurrent(lease)
          ? registration.discoveredTerminals
          : EMPTY_TERMINALS,
      getSessionOrder: () =>
        registration.fence.isCurrent(lease) ? registration.sessionOrder : [],
      getPreviousActivity: () =>
        registration.fence.isCurrent(lease)
          ? registration.previousActivity
          : new Map<string, PreviousSessionActivity>(),
      nowSeconds: () => Date.now() / 1_000,
      publishLocal: (publication: WorkspaceCatalogPublication) => {
        if (!registration.fence.isCurrent(lease)) return;
        registration.failedSessionHostIds = publication.failedSessionHostIds;
        registration.failedTerminalHostIds = publication.failedTerminalHostIds;
        registration.sessions = sameSessions(registration.sessions, publication.sessions)
          ? registration.sessions
          : publication.sessions;
        registration.discoveredTerminals = samePlainTerminals(
          registration.discoveredTerminals,
          publication.discoveredTerminals,
        )
          ? registration.discoveredTerminals
          : publication.discoveredTerminals;
        registration.error = null;
        registration.ownerPublishedGeneration = publication.generation;
        publishState(lease);
      },
      publishFull: (publication: WorkspaceCatalogFullPublication) => {
        if (!registration.fence.isCurrent(lease)) return;
        registration.previousActivity = publication.nextActivity;
        registration.failedSessionHostIds = publication.failedSessionHostIds;
        registration.failedTerminalHostIds = publication.failedTerminalHostIds;
        registration.sessionActivity = sameSessionActivity(
          registration.sessionActivity,
          publication.sessionActivity,
        )
          ? registration.sessionActivity
          : publication.sessionActivity;
        registration.sessions = sameSessions(registration.sessions, publication.sessions)
          ? registration.sessions
          : publication.sessions;
        registration.discoveredTerminals = samePlainTerminals(
          registration.discoveredTerminals,
          publication.discoveredTerminals,
        )
          ? registration.discoveredTerminals
          : publication.discoveredTerminals;
        registration.error = publication.partialError;
        registration.ownerPublishedGeneration = publication.generation;
        publishState(lease);
        if (!registration.fence.isCurrent(lease)) return;
        registration.onFullCatalogPublished({
          generation: publication.generation,
          sessionNames: publication.authoritativeSessionNames,
        });
      },
      publishError: (nextError) => {
        if (!registration.fence.isCurrent(lease)) return;
        registration.error = nextError;
        publishState(lease);
      },
    });
  }, [dashboardBackend, publishState, registration]);

  const removeSession = useCallback((name: string) => {
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    registration.sessions = registration.sessions.filter((session) => session.name !== name);
    publishState(lease);
  }, [dashboardBackend, publishState, registration]);

  const removeDiscoveredTerminal = useCallback((id: string) => {
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    registration.discoveredTerminals = registration.discoveredTerminals.filter(
      (terminal) => terminal.id !== id,
    );
    publishState(lease);
  }, [dashboardBackend, publishState, registration]);

  const reportError = useCallback((nextError: unknown) => {
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    registration.error = String(nextError);
    publishState(lease);
  }, [dashboardBackend, publishState, registration]);

  const getLatestStartedRefreshGeneration = useCallback(() => {
    const lease = registration.fence.capture(dashboardBackend);
    return lease ? registration.generation.started : 0;
  }, [dashboardBackend, registration]);

  const getLatestSuccessfulRefreshGeneration = useCallback(() => {
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease || registration.generation.successful < registration.firstGeneration) return 0;
    return registration.generation.successful;
  }, [dashboardBackend, registration]);

  return {
    sessions: visibleState.sessions,
    discoveredTerminals: visibleState.discoveredTerminals,
    sessionActivity: visibleState.sessionActivity,
    catalogRefreshGeneration: visibleState.catalogRefreshGeneration,
    failedSessionHostIds: visibleState.failedSessionHostIds,
    failedTerminalHostIds: visibleState.failedTerminalHostIds,
    error: visibleState.error,
    refresh,
    removeSession,
    removeDiscoveredTerminal,
    reportError,
    getLatestStartedRefreshGeneration,
    getLatestSuccessfulRefreshGeneration,
    ownerPhase,
  };
}

export function useWorkspaceCatalogOwnerPhase(
  ownerPhase: WorkspaceCatalogOwnerPhaseHandle,
  {
    dashboardBackend,
    sessionOrder,
    onFullCatalogPublished,
  }: {
    dashboardBackend: DashboardBackend;
    sessionOrder: string[];
    onFullCatalogPublished(publication: FullCatalogPublished): void;
  },
): void {
  const { registration } = ownerPhase;
  useLayoutEffect(() => {
    registration.backend = dashboardBackend;
    registration.sessionOrder = sessionOrder;
    registration.onFullCatalogPublished = onFullCatalogPublished;
    const ownerCommit = registration.fence.commit(dashboardBackend);
    if (!ownerCommit.changed) return;
    registration.firstGeneration = registration.generation.started + 1;
    registration.ownerPublishedGeneration = 0;
    registration.sessions = [];
    registration.discoveredTerminals = [];
    registration.previousActivity = new Map();
    registration.sessionActivity = {};
    registration.failedSessionHostIds = [];
    registration.failedTerminalHostIds = [];
    registration.error = null;
  }, [dashboardBackend, onFullCatalogPublished, ownerPhase, registration, sessionOrder]);

  useLayoutEffect(() => {
    const activation = registration.fence.activate();
    return () => {
      registration.fence.deactivate(activation);
    };
  }, [ownerPhase, registration]);
}
