import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { DashboardBackend, PlainTerminal } from "../../platform";
import {
  createTerminalSaveCoordinator,
  mergeRestoredTerminalMetadata,
  restorePersistedTerminalMetadata,
  type TerminalSaveCoordinator,
} from "../../terminalPersistence";

type TerminalMetadataBackend = Pick<DashboardBackend, "sessions" | "terminals">;

type TerminalMetadataController = {
  terminals: PlainTerminal[];
  setTerminals: Dispatch<SetStateAction<PlainTerminal[]>>;
  terminalPersistenceError: string | null;
  terminalPersistenceHydrationGeneration: number;
  terminalsRestoreReady: boolean;
  setTerminalsRestoreReady: Dispatch<SetStateAction<boolean>>;
  terminalPersistenceWritable: boolean;
  setTerminalPersistenceWritable: Dispatch<SetStateAction<boolean>>;
  setTerminalPersistenceError: Dispatch<SetStateAction<string | null>>;
  setTerminalPersistenceHydrationGeneration: Dispatch<SetStateAction<number>>;
  terminalSaveCoordinatorRef: MutableRefObject<TerminalSaveCoordinator | null>;
};

/** Owns terminal metadata state and refs without registering effects. */
export function useTerminalMetadata(): TerminalMetadataController {
  const [terminals, setTerminals] = useState<PlainTerminal[]>([]);
  const [terminalsRestoreReady, setTerminalsRestoreReady] = useState(false);
  const [terminalPersistenceWritable, setTerminalPersistenceWritable] = useState(false);
  const [terminalPersistenceError, setTerminalPersistenceError] = useState<string | null>(null);
  const [terminalPersistenceHydrationGeneration, setTerminalPersistenceHydrationGeneration] =
    useState(0);
  const terminalSaveCoordinatorRef = useRef<TerminalSaveCoordinator | null>(null);

  return {
    terminals,
    setTerminals,
    terminalPersistenceError,
    terminalPersistenceHydrationGeneration,
    terminalsRestoreReady,
    setTerminalsRestoreReady,
    terminalPersistenceWritable,
    setTerminalPersistenceWritable,
    setTerminalPersistenceError,
    setTerminalPersistenceHydrationGeneration,
    terminalSaveCoordinatorRef,
  };
}

/** Registers the single persisted-terminal hydration effect at App's load phase. */
export function useTerminalMetadataHydrationPhase(
  metadata: TerminalMetadataController,
  backend: TerminalMetadataBackend,
): void {
  const {
    setTerminalPersistenceError,
    setTerminalPersistenceHydrationGeneration,
    setTerminalPersistenceWritable,
    setTerminals,
    setTerminalsRestoreReady,
  } = metadata;

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    let hydrationSettled = false;

    const settleHydration = () => {
      if (hydrationSettled || disposed) return;
      hydrationSettled = true;
      setTerminalsRestoreReady(true);
      setTerminalPersistenceHydrationGeneration((generation) => generation + 1);
    };

    const loadPersistedTerminals = async () => {
      try {
        const saved = await backend.terminals.load();
        const restored = await restorePersistedTerminalMetadata(saved, backend);
        if (disposed) return;

        setTerminals((current) => mergeRestoredTerminalMetadata(current, restored));
        setTerminalPersistenceWritable(true);
        setTerminalPersistenceError(null);
        settleHydration();
      } catch (nextError) {
        if (disposed) return;
        setTerminalPersistenceError(`Terminal metadata could not be loaded: ${String(nextError)}`);
        retryTimer = window.setTimeout(
          () => void loadPersistedTerminals(),
          document.hidden ? 15_000 : 3_000,
        );
      }
    };

    void loadPersistedTerminals();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [backend]);
}

/** Registers coordinator creation followed by the deferred enqueue effect. */
export function useTerminalMetadataPersistencePhase(
  metadata: TerminalMetadataController,
  backend: TerminalMetadataBackend,
): void {
  const {
    terminals,
    terminalsRestoreReady,
    terminalPersistenceWritable,
    setTerminalPersistenceError,
    terminalSaveCoordinatorRef,
  } = metadata;

  useEffect(() => {
    if (!terminalsRestoreReady || !terminalPersistenceWritable) {
      terminalSaveCoordinatorRef.current?.stop();
      terminalSaveCoordinatorRef.current = null;
      return;
    }

    const coordinator = createTerminalSaveCoordinator({
      save: (snapshot) => backend.terminals.save(snapshot),
      schedule: (callback, delayMs) => {
        const timer = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timer);
      },
      retryDelayMs: () => document.hidden ? 15_000 : 3_000,
      onError: (nextError) => {
        setTerminalPersistenceError(
          `Terminal metadata could not be saved: ${String(nextError)}`,
        );
      },
      onSaved: () => setTerminalPersistenceError(null),
    });
    terminalSaveCoordinatorRef.current = coordinator;

    return () => {
      coordinator.stop();
      if (terminalSaveCoordinatorRef.current === coordinator) {
        terminalSaveCoordinatorRef.current = null;
      }
    };
  }, [backend, terminalPersistenceWritable, terminalsRestoreReady]);

  useEffect(() => {
    if (!terminalsRestoreReady || !terminalPersistenceWritable) return;
    const coordinator = terminalSaveCoordinatorRef.current;
    if (!coordinator) return;
    const timer = window.setTimeout(() => coordinator.enqueue(terminals), 0);
    return () => window.clearTimeout(timer);
  }, [terminalPersistenceWritable, terminals, terminalsRestoreReady]);
}
