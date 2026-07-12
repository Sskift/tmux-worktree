import { useCallback, useRef, useState } from "react";
import { type PlainTerminal, type Session, useDashboardBackend } from "../../platform";
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
  workspaceCatalogRefresh,
  type WorkspaceCatalogGenerationFence,
  type WorkspaceCatalogPublication,
  type WorkspaceCatalogFullPublication,
} from "./workspaceCatalogRefresh";

type UseWorkspaceCatalogOptions = {
  sessionOrder: string[];
  onFullCatalogPublished(publication: FullCatalogPublished): void;
};

export type FullCatalogPublished = {
  generation: number;
  sessionNames: string[];
};

export function useWorkspaceCatalog({
  sessionOrder,
  onFullCatalogPublished,
}: UseWorkspaceCatalogOptions) {
  const dashboardBackend = useDashboardBackend();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [discoveredTerminals, setDiscoveredTerminals] = useState<PlainTerminal[]>([]);
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivityInfo>>({});
  const [catalogRefreshGeneration, setCatalogRefreshGeneration] = useState(0);
  const [failedSessionHostIds, setFailedSessionHostIds] = useState<string[]>([]);
  const [failedTerminalHostIds, setFailedTerminalHostIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sessionsRef = useRef(sessions);
  const discoveredTerminalsRef = useRef(discoveredTerminals);
  const sessionOrderRef = useRef(sessionOrder);
  const sessionActivityRef = useRef<Map<string, PreviousSessionActivity>>(new Map());
  const generationRef = useRef<WorkspaceCatalogGenerationFence>({ started: 0, successful: 0 });
  const onFullCatalogPublishedRef = useRef(onFullCatalogPublished);

  sessionsRef.current = sessions;
  discoveredTerminalsRef.current = discoveredTerminals;
  sessionOrderRef.current = sessionOrder;
  onFullCatalogPublishedRef.current = onFullCatalogPublished;

  const publishCatalog = useCallback((publication: WorkspaceCatalogPublication) => {
    setFailedSessionHostIds(publication.failedSessionHostIds);
    setFailedTerminalHostIds(publication.failedTerminalHostIds);
    setSessions((previous) =>
      sameSessions(previous, publication.sessions) ? previous : publication.sessions,
    );
    setDiscoveredTerminals((previous) =>
      samePlainTerminals(previous, publication.discoveredTerminals)
        ? previous
        : publication.discoveredTerminals,
    );
    setCatalogRefreshGeneration(publication.generation);
  }, []);

  const refresh = useCallback(() => workspaceCatalogRefresh({
    backend: dashboardBackend,
    generation: generationRef.current,
    getCurrentSessions: () => sessionsRef.current,
    getCurrentDiscoveredTerminals: () => discoveredTerminalsRef.current,
    getSessionOrder: () => sessionOrderRef.current,
    getPreviousActivity: () => sessionActivityRef.current,
    nowSeconds: () => Date.now() / 1_000,
    publishLocal: (publication) => {
      publishCatalog(publication);
      setError(null);
    },
    publishFull: (publication: WorkspaceCatalogFullPublication) => {
      sessionActivityRef.current = publication.nextActivity;
      setFailedSessionHostIds(publication.failedSessionHostIds);
      setFailedTerminalHostIds(publication.failedTerminalHostIds);
      setSessionActivity((previous) =>
        sameSessionActivity(previous, publication.sessionActivity)
          ? previous
          : publication.sessionActivity,
      );
      setSessions((previous) =>
        sameSessions(previous, publication.sessions) ? previous : publication.sessions,
      );
      setDiscoveredTerminals((previous) =>
        samePlainTerminals(previous, publication.discoveredTerminals)
          ? previous
          : publication.discoveredTerminals,
      );
      setCatalogRefreshGeneration(publication.generation);
      setError(publication.partialError);
      onFullCatalogPublishedRef.current({
        generation: publication.generation,
        sessionNames: publication.authoritativeSessionNames,
      });
    },
    publishError: setError,
  }), [dashboardBackend, publishCatalog]);

  const removeSession = useCallback((name: string) => {
    setSessions((current) => current.filter((session) => session.name !== name));
  }, []);
  const removeDiscoveredTerminal = useCallback((id: string) => {
    setDiscoveredTerminals((current) => current.filter((terminal) => terminal.id !== id));
  }, []);
  const reportError = useCallback((nextError: unknown) => {
    setError(String(nextError));
  }, []);
  const getLatestStartedRefreshGeneration = useCallback(
    () => generationRef.current.started,
    [],
  );
  const getLatestSuccessfulRefreshGeneration = useCallback(
    () => generationRef.current.successful,
    [],
  );

  return {
    sessions,
    discoveredTerminals,
    sessionActivity,
    catalogRefreshGeneration,
    failedSessionHostIds,
    failedTerminalHostIds,
    error,
    refresh,
    removeSession,
    removeDiscoveredTerminal,
    reportError,
    getLatestStartedRefreshGeneration,
    getLatestSuccessfulRefreshGeneration,
  };
}
