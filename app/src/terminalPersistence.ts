import type { DashboardBackend, PlainTerminal } from "./platform";
import {
  normalizePlainTerminal,
  terminalSessionKey,
} from "./dashboard/model/terminalIdentity";

export type TerminalSaveScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

export type TerminalSaveCoordinator = {
  enqueue(terminals: readonly PlainTerminal[]): void;
  stop(): void;
};

type TerminalSaveCoordinatorOptions = {
  save(terminals: PlainTerminal[]): Promise<void>;
  schedule: TerminalSaveScheduler;
  retryDelayMs(): number;
  onError(error: unknown): void;
  onSaved?(): void;
};

function copyTerminalSnapshot(terminals: readonly PlainTerminal[]): PlainTerminal[] {
  return terminals.map((terminal) => ({ ...terminal }));
}

type TerminalMetadataRestoreBackend = Pick<DashboardBackend, "sessions" | "terminals">;

/**
 * Resolves persisted terminal metadata against the currently running tmux
 * sessions. Managed records are owned by TW state and are never resurrected;
 * legacy records retain the direct-tmux ensure path for migration.
 */
export async function restorePersistedTerminalMetadata(
  saved: readonly PlainTerminal[],
  backend: TerminalMetadataRestoreBackend,
): Promise<PlainTerminal[]> {
  const candidates = saved
    .filter((terminal) => terminal.tmuxName)
    .map(normalizePlainTerminal);

  const restored = await Promise.all(candidates.map(async (terminal) => {
    if (terminal.managed) {
      try {
        return await backend.sessions.exists(terminal.tmuxName) ? terminal : null;
      } catch {
        return terminal;
      }
    }
    await backend.terminals.ensure({
      name: terminal.tmuxName,
      cwd: terminal.cwd,
      aiCmd: terminal.aiCmd ?? "",
      hostId: terminal.hostId ?? null,
      rawName: terminal.rawName ?? null,
    }).catch(() => {});
    return terminal;
  }));

  return restored.filter((terminal): terminal is PlainTerminal => terminal !== null);
}

/**
 * Publishes restored metadata first while retaining terminals created during
 * the asynchronous load. Runtime identity, rather than the metadata id, owns
 * de-duplication so a concurrent record cannot remount the same tmux session.
 */
export function mergeRestoredTerminalMetadata(
  current: readonly PlainTerminal[],
  restored: readonly PlainTerminal[],
): PlainTerminal[] {
  const restoredKeys = new Set(restored.map(terminalSessionKey));
  return [
    ...restored,
    ...current.filter((terminal) => !restoredKeys.has(terminalSessionKey(terminal))),
  ];
}

/**
 * Applies the user-facing label change to persisted terminal metadata only.
 * Discovered tmux sessions keep their runtime-derived names, and labels must
 * stay unique across both persisted and discovered terminals.
 */
export function renamePersistedTerminal(
  terminals: PlainTerminal[],
  allTerminals: readonly PlainTerminal[],
  terminalId: string,
  input: string,
): PlainTerminal[] {
  const nextLabel = input.trim();
  const terminal = terminals.find((candidate) => candidate.id === terminalId);
  if (
    !terminal
    || terminal.discovered
    || !nextLabel
    || nextLabel === terminal.label
  ) {
    return terminals;
  }

  const duplicate = [...terminals, ...allTerminals].some(
    (candidate) => candidate.id !== terminalId && candidate.label.trim() === nextLabel,
  );
  if (duplicate) return terminals;

  return terminals.map((candidate) => (
    candidate.id === terminalId ? { ...candidate, label: nextLabel } : candidate
  ));
}

function randomTerminalIdEntropy(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const words = new Uint32Array(4);
  crypto.getRandomValues(words);
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * Allocates new metadata IDs in a namespace disjoint from the legacy
 * monotonically increasing `term-N` IDs. That keeps a terminal created while
 * persisted metadata is still loading from colliding with an unseen legacy ID.
 */
export function allocateTerminalId(
  existingTerminals: readonly Pick<PlainTerminal, "id">[],
  randomUuid: () => string = randomTerminalIdEntropy,
): string {
  const existingIds = new Set(existingTerminals.map((terminal) => terminal.id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `term-v2-${randomUuid()}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error("Unable to allocate a unique terminal ID");
}

/**
 * Serializes terminal metadata writes and retains only the newest pending
 * snapshot. Failed writes retry automatically; a slower older write can never
 * finish after and overwrite a newer one.
 */
export function createTerminalSaveCoordinator(
  options: TerminalSaveCoordinatorOptions,
): TerminalSaveCoordinator {
  let latestSnapshot: PlainTerminal[] | null = null;
  let writeInFlight = false;
  let cancelRetry: (() => void) | null = null;
  let stopped = false;

  const clearRetry = () => {
    cancelRetry?.();
    cancelRetry = null;
  };

  const flush = async (): Promise<void> => {
    if (stopped || writeInFlight || latestSnapshot === null || cancelRetry) return;

    writeInFlight = true;
    const snapshot = latestSnapshot;
    try {
      await options.save(snapshot);
    } catch (error) {
      writeInFlight = false;
      if (stopped) return;
      options.onError(error);
      cancelRetry = options.schedule(() => {
        cancelRetry = null;
        void flush();
      }, options.retryDelayMs());
      return;
    }

    writeInFlight = false;
    if (stopped) return;
    if (latestSnapshot === snapshot) latestSnapshot = null;
    options.onSaved?.();
    if (latestSnapshot !== null) void flush();
  };

  return {
    enqueue(terminals) {
      if (stopped) return;
      latestSnapshot = copyTerminalSnapshot(terminals);
      if (!writeInFlight && !cancelRetry) void flush();
    },

    stop() {
      stopped = true;
      latestSnapshot = null;
      clearRetry();
    },
  };
}
