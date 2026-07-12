import type { DashboardBackend, PlainTerminal, Session } from "../../platform";
import { mergeDashboardCatalogSnapshot } from "../model/catalogSnapshot";
import {
  describeSessionActivity,
  type PreviousSessionActivity,
  type SessionActivityInfo,
} from "../model/sessionActivity";

type WorkspaceCatalogBackend = Pick<DashboardBackend, "catalog" | "sessions" | "terminals">;

export type WorkspaceCatalogGenerationFence = {
  started: number;
  successful: number;
};

export type WorkspaceCatalogPublication = {
  generation: number;
  sessions: Session[];
  discoveredTerminals: PlainTerminal[];
  failedSessionHostIds: string[];
  failedTerminalHostIds: string[];
};

export type WorkspaceCatalogFullPublication = WorkspaceCatalogPublication & {
  sessionActivity: Record<string, SessionActivityInfo>;
  nextActivity: Map<string, PreviousSessionActivity>;
  partialError: string | null;
  authoritativeSessionNames: string[];
};

export type WorkspaceCatalogRefreshOptions = {
  backend: WorkspaceCatalogBackend;
  generation: WorkspaceCatalogGenerationFence;
  getCurrentSessions(): Session[];
  getCurrentDiscoveredTerminals(): PlainTerminal[];
  getSessionOrder(): string[];
  getPreviousActivity(): ReadonlyMap<string, PreviousSessionActivity>;
  nowSeconds(): number;
  publishLocal(publication: WorkspaceCatalogPublication): void;
  publishFull(publication: WorkspaceCatalogFullPublication): void;
  publishError(error: string): void;
};

function sortSessions(sessions: Session[], order: readonly string[]): Session[] {
  const orderMap = new Map(order.map((name, index) => [name, index]));
  sessions.sort((left, right) =>
    (orderMap.get(left.name) ?? Infinity) - (orderMap.get(right.name) ?? Infinity),
  );
  return sessions;
}

function discoveredTerminals(terminals: PlainTerminal[]): PlainTerminal[] {
  return terminals.map((terminal) => ({ ...terminal, discovered: true }));
}

export async function workspaceCatalogRefresh(
  options: WorkspaceCatalogRefreshOptions,
): Promise<void> {
  const refreshGeneration = ++options.generation.started;
  try {
    const catalog = options.backend.catalog;
    if (catalog?.listLocal && options.generation.successful === 0) {
      const localSnapshot = await catalog.listLocal().catch(() => null);
      if (
        localSnapshot &&
        refreshGeneration >= options.generation.successful
      ) {
        const mergedLocalCatalog = mergeDashboardCatalogSnapshot(
          options.getCurrentSessions(),
          options.getCurrentDiscoveredTerminals(),
          localSnapshot,
        );
        const localSessions = sortSessions(
          mergedLocalCatalog.sessions,
          options.getSessionOrder(),
        );
        options.generation.successful = refreshGeneration;
        options.publishLocal({
          generation: refreshGeneration,
          sessions: localSessions,
          discoveredTerminals: discoveredTerminals(mergedLocalCatalog.terminals),
          failedSessionHostIds: localSnapshot.failedSessionHostIds,
          failedTerminalHostIds: localSnapshot.failedTerminalHostIds,
        });
      }
    }

    const snapshot = catalog
      ? await catalog.list()
      : await Promise.all([
        options.backend.sessions.list(),
        options.backend.terminals.listTmux(),
      ]).then(([sessions, terminals]) => ({
        sessions,
        terminals,
        failedSessionHostIds: [],
        failedTerminalHostIds: [],
      }));
    if (refreshGeneration < options.generation.successful) return;

    const mergedCatalog = mergeDashboardCatalogSnapshot(
      options.getCurrentSessions(),
      options.getCurrentDiscoveredTerminals(),
      snapshot,
    );
    const sessions = sortSessions(mergedCatalog.sessions, options.getSessionOrder());
    const nowSeconds = options.nowSeconds();
    const previousActivity = options.getPreviousActivity();
    const nextActivity = new Map<string, PreviousSessionActivity>();
    const sessionActivity: Record<string, SessionActivityInfo> = {};
    for (const session of sessions) {
      const activity = describeSessionActivity(
        {
          name: session.name,
          outputSignature: session.output_signature ?? null,
          agentRunning: session.agent_running ?? null,
        },
        previousActivity.get(session.name),
        nowSeconds,
      );
      sessionActivity[session.name] = activity;
      nextActivity.set(session.name, {
        outputSignature: activity.outputSignature,
        lastChangedAt: activity.lastChangedAt,
      });
    }

    options.generation.successful = refreshGeneration;
    options.publishFull({
      generation: refreshGeneration,
      sessions,
      discoveredTerminals: discoveredTerminals(mergedCatalog.terminals),
      sessionActivity,
      nextActivity,
      failedSessionHostIds: snapshot.failedSessionHostIds,
      failedTerminalHostIds: snapshot.failedTerminalHostIds,
      partialError: mergedCatalog.partialError,
      authoritativeSessionNames: sessions.map((session) => session.name),
    });
  } catch (error) {
    options.publishError(String(error));
  }
}
