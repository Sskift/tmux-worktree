export type Selection =
  | { kind: "session"; name: string }
  | { kind: "terminal"; id: string }
  | { kind: "automation"; id: string }
  | null;

export type PinnedItem =
  | { kind: "session"; name: string }
  | { kind: "terminal"; id: string };

import type { PlainTerminal, Session } from "../../platform";

export type CatalogSelection = Exclude<
  Selection,
  { kind: "automation" } | null
>;

export type PendingCatalogSelection = {
  selection: CatalogSelection;
  minimumRefreshGeneration: number;
  source: "restore" | "created";
};

export type CatalogHydration = {
  refreshGeneration: number;
  terminalPersistenceGeneration: number;
  hostGeneration: number;
};

export type CatalogSelectionResolution = {
  selection: Selection;
  pendingSelection: PendingCatalogSelection | null;
  metadataPending: boolean;
};

type ReconcileCatalogSelectionInput = {
  selection: Selection;
  pendingSelection: PendingCatalogSelection | null;
  hydration: CatalogHydration;
  sessions: Session[];
  terminals: PlainTerminal[];
  hostIds: ReadonlySet<string>;
  failedSessionHostIds?: ReadonlySet<string>;
  failedTerminalHostIds?: ReadonlySet<string>;
};

function isCatalogSelection(selection: Selection): selection is CatalogSelection {
  return selection?.kind === "session" || selection?.kind === "terminal";
}

export function sameCatalogSelection(left: Selection, right: Selection): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "session" && right.kind === "session") {
    return left.name === right.name;
  }
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.id === right.id;
  }
  return left.kind === "automation" &&
    right.kind === "automation" &&
    left.id === right.id;
}

function remoteHostIsAvailable(
  hostId: string | null | undefined,
  hydration: CatalogHydration,
  hostIds: ReadonlySet<string>,
): boolean {
  if (!hostId) return true;
  return hydration.hostGeneration > 0 && hostIds.has(hostId);
}

function firstAvailableSelection(
  sessions: Session[],
  terminals: PlainTerminal[],
  hydration: CatalogHydration,
  hostIds: ReadonlySet<string>,
): Selection {
  const session = sessions.find((candidate) =>
    remoteHostIsAvailable(candidate.hostId, hydration, hostIds),
  );
  if (session) return { kind: "session", name: session.name };

  const terminal = terminals.find((candidate) =>
    remoteHostIsAvailable(candidate.hostId, hydration, hostIds),
  );
  return terminal ? { kind: "terminal", id: terminal.id } : null;
}

function fallbackResolution(
  input: ReconcileCatalogSelectionInput,
  pendingSelection: PendingCatalogSelection | null,
): CatalogSelectionResolution {
  const hasLocalFallback = input.sessions.some((session) => !session.hostId) ||
    input.terminals.some((terminal) => !terminal.hostId);
  const hasRemoteFallback = input.sessions.some((session) => !!session.hostId) ||
    input.terminals.some((terminal) => !!terminal.hostId);
  if (
    input.hydration.terminalPersistenceGeneration === 0 ||
    (!hasLocalFallback && hasRemoteFallback && input.hydration.hostGeneration === 0)
  ) {
    return {
      selection: input.selection,
      pendingSelection,
      metadataPending: true,
    };
  }

  return {
    selection: firstAvailableSelection(
      input.sessions,
      input.terminals,
      input.hydration,
      input.hostIds,
    ),
    pendingSelection: null,
    // Keep platform commands blocked until React applies the fallback selection.
    metadataPending: true,
  };
}

export function pendingRestoredCatalogSelection(
  selection: Selection,
  successfulRefreshGeneration: number,
): PendingCatalogSelection | null {
  if (!isCatalogSelection(selection)) return null;
  return {
    selection,
    // A snapshot that already hydrated before layout restoration is valid. If
    // none exists, wait for the first successful snapshot rather than a timer.
    minimumRefreshGeneration: Math.max(1, successfulRefreshGeneration),
    source: "restore",
  };
}

export function pendingCreatedCatalogSelection(
  selection: CatalogSelection,
  latestStartedRefreshGeneration: number,
): PendingCatalogSelection {
  return {
    selection,
    // A refresh already in flight started before creation and cannot prove the
    // new catalog item is absent. Require a later successful generation.
    minimumRefreshGeneration: latestStartedRefreshGeneration + 1,
    source: "created",
  };
}

export function reconcileCatalogSelection(
  input: ReconcileCatalogSelectionInput,
): CatalogSelectionResolution {
  const { selection, hydration, sessions, terminals, hostIds } = input;
  const failedSessionHostIds = input.failedSessionHostIds ?? new Set<string>();
  const failedTerminalHostIds = input.failedTerminalHostIds ?? new Set<string>();
  if (!isCatalogSelection(selection)) {
    return {
      selection,
      pendingSelection: null,
      metadataPending: false,
    };
  }

  const matchingPending = input.pendingSelection &&
    sameCatalogSelection(input.pendingSelection.selection, selection)
    ? input.pendingSelection
    : null;
  const minimumRefreshGeneration =
    matchingPending?.minimumRefreshGeneration ?? 0;

  if (hydration.refreshGeneration < minimumRefreshGeneration) {
    return {
      selection,
      pendingSelection: matchingPending,
      metadataPending: true,
    };
  }

  if (selection.kind === "session") {
    const session = sessions.find((candidate) => candidate.name === selection.name);
    const separatorIndex = selection.name.indexOf(":");
    const compositeHostId = separatorIndex > 0
      ? selection.name.slice(0, separatorIndex)
      : null;
    const remoteHostId = session?.hostId ?? compositeHostId;

    if (remoteHostId && hydration.hostGeneration === 0) {
      return {
        selection,
        pendingSelection: matchingPending,
        metadataPending: true,
      };
    }
    if (
      !session &&
      remoteHostId &&
      hostIds.has(remoteHostId) &&
      failedSessionHostIds.has(remoteHostId)
    ) {
      return {
        selection,
        pendingSelection: matchingPending,
        metadataPending: true,
      };
    }
    if (!session) return fallbackResolution(input, matchingPending);
    if (remoteHostId && !hostIds.has(remoteHostId)) {
      return fallbackResolution(input, matchingPending);
    }
    if (compositeHostId && !session.hostId) {
      return {
        selection,
        pendingSelection: matchingPending,
        metadataPending: true,
      };
    }

    return {
      selection,
      pendingSelection: null,
      metadataPending: false,
    };
  }

  const terminal = terminals.find((candidate) => candidate.id === selection.id);
  const compositeTerminalHostId = selection.id.startsWith("ssh:")
    ? selection.id.split(":", 3)[1] || null
    : null;
  if (!terminal && hydration.terminalPersistenceGeneration === 0) {
    return {
      selection,
      pendingSelection: matchingPending,
      metadataPending: true,
    };
  }
  if (
    !terminal &&
    compositeTerminalHostId &&
    hostIds.has(compositeTerminalHostId) &&
    failedTerminalHostIds.has(compositeTerminalHostId)
  ) {
    return {
      selection,
      pendingSelection: matchingPending,
      metadataPending: true,
    };
  }
  if (!terminal) return fallbackResolution(input, matchingPending);
  if (terminal.hostId && hydration.hostGeneration === 0) {
    return {
      selection,
      pendingSelection: matchingPending,
      metadataPending: true,
    };
  }
  if (terminal.hostId && !hostIds.has(terminal.hostId)) {
    return fallbackResolution(input, matchingPending);
  }

  return {
    selection,
    pendingSelection: null,
    metadataPending: false,
  };
}
