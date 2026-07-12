import type {
  DashboardCatalogSnapshot,
  PlainTerminal,
  Session,
} from "../../platform";

export type MergedDashboardCatalog = {
  sessions: Session[];
  terminals: PlainTerminal[];
  partialError: string | null;
};

function mergeByKey<T>(
  current: T[],
  preserved: T[],
  keyOf: (value: T) => string,
): T[] {
  const seen = new Set(current.map(keyOf));
  return [
    ...current,
    ...preserved.filter((value) => !seen.has(keyOf(value))),
  ];
}

/**
 * A remote host can disappear from one polling response because SSH failed,
 * not because every session on it was deleted. Preserve only that host's last
 * known entries; a later authoritative response can still remove them.
 */
export function mergeDashboardCatalogSnapshot(
  previousSessions: Session[],
  previousTerminals: PlainTerminal[],
  snapshot: DashboardCatalogSnapshot,
): MergedDashboardCatalog {
  const failedSessionHosts = new Set(snapshot.failedSessionHostIds);
  const failedTerminalHosts = new Set(snapshot.failedTerminalHostIds);
  const failedHosts = new Set([
    ...snapshot.failedSessionHostIds,
    ...snapshot.failedTerminalHostIds,
  ]);

  return {
    sessions: mergeByKey(
      snapshot.sessions,
      previousSessions.filter((session) =>
        !!session.hostId && failedSessionHosts.has(session.hostId),
      ),
      (session) => session.name,
    ),
    terminals: mergeByKey(
      snapshot.terminals,
      previousTerminals.filter((terminal) =>
        !!terminal.hostId && failedTerminalHosts.has(terminal.hostId),
      ),
      (terminal) => terminal.tmuxName,
    ),
    partialError: failedHosts.size > 0
      ? `Remote catalog unavailable for: ${Array.from(failedHosts).join(", ")}`
      : null,
  };
}
