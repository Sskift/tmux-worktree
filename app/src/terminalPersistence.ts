import type { PlainTerminal } from "./platform";

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
