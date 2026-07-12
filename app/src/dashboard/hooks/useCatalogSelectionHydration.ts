import {
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { HostConfig, PlainTerminal, Session } from "../../platform";
import {
  reconcileCatalogSelection,
  sameCatalogSelection,
  type PendingCatalogSelection,
  type Selection,
} from "../model/selection";
import {
  isLocalDiscoveredInternalTerminal,
  normalizePlainTerminal,
  terminalSessionKey,
} from "../model/terminalIdentity";

type UseCatalogSelectionHydrationOptions = {
  terminals: PlainTerminal[];
  discoveredTerminals: PlainTerminal[];
  sessions: Session[];
  hosts: HostConfig[];
  selection: Selection;
  pendingCatalogSelection: PendingCatalogSelection | null;
  catalogRefreshGeneration: number;
  terminalPersistenceHydrationGeneration: number;
  hostsHydrationGeneration: number;
  failedSessionHostIds: string[];
  failedTerminalHostIds: string[];
  setSelection: Dispatch<SetStateAction<Selection>>;
  setPendingCatalogSelection: Dispatch<
    SetStateAction<PendingCatalogSelection | null>
  >;
};

export function useCatalogSelectionHydration({
  terminals,
  discoveredTerminals,
  sessions,
  hosts,
  selection,
  pendingCatalogSelection,
  catalogRefreshGeneration,
  terminalPersistenceHydrationGeneration,
  hostsHydrationGeneration,
  failedSessionHostIds,
  failedTerminalHostIds,
  setSelection,
  setPendingCatalogSelection,
}: UseCatalogSelectionHydrationOptions) {
  const allTerminals = useMemo(() => {
    const persistedKeys = new Set(terminals.map(terminalSessionKey));
    return [
      ...terminals,
      ...discoveredTerminals
        .filter((terminal) => !isLocalDiscoveredInternalTerminal(terminal))
        .filter((terminal) => !persistedKeys.has(terminalSessionKey(terminal)))
        .map(normalizePlainTerminal),
    ];
  }, [terminals, discoveredTerminals]);

  const catalogSelectionResolution = useMemo(
    () =>
      reconcileCatalogSelection({
        selection,
        pendingSelection: pendingCatalogSelection,
        hydration: {
          refreshGeneration: catalogRefreshGeneration,
          terminalPersistenceGeneration: terminalPersistenceHydrationGeneration,
          hostGeneration: hostsHydrationGeneration,
        },
        sessions,
        terminals: allTerminals,
        hostIds: new Set(hosts.map((host) => host.id)),
        failedSessionHostIds: new Set(failedSessionHostIds),
        failedTerminalHostIds: new Set(failedTerminalHostIds),
      }),
    [
      allTerminals,
      catalogRefreshGeneration,
      hosts,
      hostsHydrationGeneration,
      failedSessionHostIds,
      failedTerminalHostIds,
      pendingCatalogSelection,
      selection,
      sessions,
      terminalPersistenceHydrationGeneration,
    ],
  );

  useEffect(() => {
    if (
      pendingCatalogSelection !== catalogSelectionResolution.pendingSelection
    ) {
      setPendingCatalogSelection(catalogSelectionResolution.pendingSelection);
    }
    if (!sameCatalogSelection(selection, catalogSelectionResolution.selection)) {
      setSelection(catalogSelectionResolution.selection);
    }
  }, [catalogSelectionResolution, pendingCatalogSelection, selection]);

  const selectedSession =
    selection?.kind === "session"
      ? sessions.find((session) => session.name === selection.name) ?? null
      : null;
  const selectedTerminal =
    selection?.kind === "terminal"
      ? allTerminals.find((terminal) => terminal.id === selection.id) ?? null
      : null;
  const selectionMetadataPending = catalogSelectionResolution.metadataPending;

  return {
    allTerminals,
    selectedSession,
    selectedTerminal,
    selectionMetadataPending,
  };
}
