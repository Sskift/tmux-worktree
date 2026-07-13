import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CreatedTerminal, DashboardBackend, PlainTerminal } from "../../platform";
import {
  allocateTerminalId,
  createTerminalSaveCoordinator,
  mergeRestoredTerminalMetadata,
  restorePersistedTerminalMetadata,
  type TerminalSaveCoordinator,
} from "../../terminalPersistence";
import { terminalSessionKey } from "../model/terminalIdentity";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochLease,
  type OwnerEpochLeaseController,
} from "../ownerEpochLease";

type TerminalMetadataOwner = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

type TerminalMetadataState = Readonly<{
  owner: TerminalMetadataOwner | null;
  terminals: PlainTerminal[];
  terminalPersistenceError: string | null;
  terminalPersistenceHydrationGeneration: number;
  terminalsRestoreReady: boolean;
  terminalPersistenceWritable: boolean;
}>;

type TerminalMetadataRequest = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  token: symbol;
}>;

type TerminalMetadataRegistration = {
  fence: OwnerEpochLeaseController<DashboardBackend>;
  backend: DashboardBackend | null;
  hydrationRequest: TerminalMetadataRequest | null;
  saveCoordinator: TerminalSaveCoordinator | null;
};

type TerminalMetadataOwnerPhaseHandle = Readonly<{
  registration: TerminalMetadataRegistration;
  setState: Dispatch<SetStateAction<TerminalMetadataState>>;
}>;

type TerminalMetadataController = {
  terminals: PlainTerminal[];
  setTerminals: Dispatch<SetStateAction<PlainTerminal[]>>;
  upsertCreatedTerminal(
    draft: Readonly<{
      label: string;
      cwd: string;
      aiCmd: string;
      hostId?: string | null;
    }>,
    created: CreatedTerminal,
    allTerminals: readonly PlainTerminal[],
  ): string;
  reconcilePersistedTerminal(target: Readonly<{
    id: string;
    tmuxName: string;
    hostId: string | null;
  }>): void;
  terminalPersistenceError: string | null;
  terminalPersistenceHydrationGeneration: number;
  terminalsRestoreReady: boolean;
  terminalPersistenceWritable: boolean;
  ownerPhase: TerminalMetadataOwnerPhaseHandle;
};

const EMPTY_TERMINAL_METADATA_STATE: TerminalMetadataState = Object.freeze({
  owner: null,
  terminals: [],
  terminalPersistenceError: null,
  terminalPersistenceHydrationGeneration: 0,
  terminalsRestoreReady: false,
  terminalPersistenceWritable: false,
});

function ownerState(
  lease: OwnerEpochLease<DashboardBackend>,
): TerminalMetadataOwner {
  return { owner: lease.owner, epoch: lease.epoch };
}

function stateMatchesLease(
  state: TerminalMetadataState,
  lease: OwnerEpochLease<DashboardBackend> | null,
): boolean {
  return !!lease && state.owner?.owner === lease.owner && state.owner.epoch === lease.epoch;
}

function initialOwnerState(
  lease: OwnerEpochLease<DashboardBackend> | null,
): TerminalMetadataState {
  return lease
    ? { ...EMPTY_TERMINAL_METADATA_STATE, owner: ownerState(lease) }
    : EMPTY_TERMINAL_METADATA_STATE;
}

function requestIsCurrent(
  registration: TerminalMetadataRegistration,
  request: TerminalMetadataRequest,
): boolean {
  return registration.hydrationRequest === request &&
    registration.fence.isCurrent(request.lease) &&
    registration.backend === request.lease.owner;
}

function resolveStateAction<State>(
  action: SetStateAction<State>,
  previous: State,
): State {
  return typeof action === "function"
    ? (action as (value: State) => State)(previous)
    : action;
}

/** Owns terminal metadata state without registering effects. */
export function useTerminalMetadata(
  dashboardBackend: DashboardBackend,
): TerminalMetadataController {
  const [state, setState] = useState<TerminalMetadataState>(
    EMPTY_TERMINAL_METADATA_STATE,
  );
  const [registration] = useState<TerminalMetadataRegistration>(() => ({
    fence: createOwnerEpochLeaseController<DashboardBackend>(),
    backend: null,
    hydrationRequest: null,
    saveCoordinator: null,
  }));
  const [ownerPhase] = useState<TerminalMetadataOwnerPhaseHandle>(() => ({
    registration,
    setState,
  }));
  const renderLease = registration.fence.capture(dashboardBackend);
  const visible = stateMatchesLease(state, renderLease)
    ? state
    : EMPTY_TERMINAL_METADATA_STATE;

  const setTerminals = useCallback<Dispatch<SetStateAction<PlainTerminal[]>>>((action) => {
    if (!renderLease || !registration.fence.isCurrent(renderLease)) return;
    setState((current) => {
      if (
        !registration.fence.isCurrent(renderLease) ||
        !stateMatchesLease(current, renderLease)
      ) return current;
      return {
        ...current,
        terminals: resolveStateAction(action, current.terminals),
      };
    });
  }, [registration, renderLease]);

  const reconcilePersistedTerminal = useCallback((target: Readonly<{
    id: string;
    tmuxName: string;
    hostId: string | null;
  }>) => {
    setTerminals((current) => current.filter((terminal) =>
      terminal.id !== target.id ||
      terminal.tmuxName !== target.tmuxName ||
      (terminal.hostId ?? null) !== target.hostId
    ));
  }, [setTerminals]);

  const upsertPersistedTerminal = useCallback((terminal: PlainTerminal) => {
    const runtimeKey = terminalSessionKey(terminal);
    setTerminals((current) => {
      const existingIndex = current.findIndex(
        (candidate) => terminalSessionKey(candidate) === runtimeKey,
      );
      if (existingIndex < 0) return [...current, terminal];
      return current.map((candidate, index) => index === existingIndex
        ? { ...terminal, id: candidate.id }
        : candidate);
    });
  }, [setTerminals]);

  const upsertCreatedTerminal = useCallback((
    draft: Readonly<{
      label: string;
      cwd: string;
      aiCmd: string;
      hostId?: string | null;
    }>,
    created: CreatedTerminal,
    allTerminals: readonly PlainTerminal[],
  ): string => {
    const runtime = {
      id: "",
      label: draft.label,
      cwd: created.cwd,
      tmuxName: created.tmuxName,
      hostId: created.hostId ?? draft.hostId ?? null,
      rawName: created.rawName,
      aiCmd: draft.aiCmd,
      managed: created.managed,
    };
    const runtimeKey = terminalSessionKey(runtime);
    const id = visible.terminals.find(
      (terminal) => terminalSessionKey(terminal) === runtimeKey,
    )?.id ?? allocateTerminalId(allTerminals);
    upsertPersistedTerminal({ ...runtime, id });
    return id;
  }, [upsertPersistedTerminal, visible.terminals]);

  return {
    terminals: visible.terminals,
    setTerminals,
    upsertCreatedTerminal,
    reconcilePersistedTerminal,
    terminalPersistenceError: visible.terminalPersistenceError,
    terminalPersistenceHydrationGeneration:
      visible.terminalPersistenceHydrationGeneration,
    terminalsRestoreReady: visible.terminalsRestoreReady,
    terminalPersistenceWritable: visible.terminalPersistenceWritable,
    ownerPhase,
  };
}

export function useTerminalMetadataOwnerPhase(
  ownerPhase: TerminalMetadataOwnerPhaseHandle,
  dashboardBackend: DashboardBackend,
): void {
  const { registration, setState } = ownerPhase;

  useLayoutEffect(() => {
    registration.backend = dashboardBackend;
    const ownerCommit = registration.fence.commit(dashboardBackend);
    if (!ownerCommit.changed) return;
    registration.hydrationRequest = null;
    registration.saveCoordinator?.stop();
    registration.saveCoordinator = null;
    setState(initialOwnerState(ownerCommit.lease));
  }, [dashboardBackend, ownerPhase, registration, setState]);

  useLayoutEffect(() => {
    const activation = registration.fence.activate();
    const lease = registration.backend
      ? registration.fence.capture(registration.backend)
      : null;
    setState((current) => {
      if (!lease) return EMPTY_TERMINAL_METADATA_STATE;
      const sameOwner = current.owner?.owner === lease.owner &&
        current.owner.epoch === lease.epoch;
      return sameOwner
        ? { ...current, owner: ownerState(lease) }
        : initialOwnerState(lease);
    });
    return () => {
      if (!registration.fence.deactivate(activation)) return;
      registration.hydrationRequest = null;
      registration.saveCoordinator?.stop();
      registration.saveCoordinator = null;
    };
  }, [ownerPhase, registration, setState]);
}

/** Registers the single persisted-terminal hydration effect at App's load phase. */
export function useTerminalMetadataHydrationPhase(
  metadata: TerminalMetadataController,
  backend: DashboardBackend,
): void {
  const { registration, setState } = metadata.ownerPhase;

  useEffect(() => {
    const lease = registration.fence.capture(backend);
    if (!lease) return;
    const request: TerminalMetadataRequest = {
      lease,
      token: Symbol("terminal-metadata-hydration"),
    };
    registration.hydrationRequest = request;
    let retryTimer: number | null = null;
    const loadPersistedTerminals = async () => {
      if (!requestIsCurrent(registration, request)) return;
      try {
        const saved = await backend.terminals.load();
        if (!requestIsCurrent(registration, request)) return;
        const restored = await restorePersistedTerminalMetadata(saved, backend);
        if (!requestIsCurrent(registration, request)) return;
        setState((current) => {
          if (!requestIsCurrent(registration, request)) return current;
          const ownerCurrent = stateMatchesLease(current, lease)
            ? current
            : initialOwnerState(lease);
          return {
            ...ownerCurrent,
            terminals: mergeRestoredTerminalMetadata(
              ownerCurrent.terminals,
              restored,
            ),
            terminalPersistenceWritable: true,
            terminalsRestoreReady: true,
            terminalPersistenceError: null,
            terminalPersistenceHydrationGeneration:
              ownerCurrent.terminalPersistenceHydrationGeneration + 1,
          };
        });
      } catch (nextError) {
        if (!requestIsCurrent(registration, request)) return;
        setState((current) => stateMatchesLease(current, lease)
          ? {
              ...current,
              terminalPersistenceError:
                `Terminal metadata could not be loaded: ${String(nextError)}`,
            }
          : current);
        retryTimer = window.setTimeout(
          () => void loadPersistedTerminals(),
          document.hidden ? 15_000 : 3_000,
        );
      }
    };

    void loadPersistedTerminals();
    return () => {
      if (registration.hydrationRequest === request) {
        registration.hydrationRequest = null;
      }
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [backend, registration, setState]);
}

/** Registers coordinator creation followed by the deferred enqueue effect. */
export function useTerminalMetadataPersistencePhase(
  metadata: TerminalMetadataController,
  backend: DashboardBackend,
): void {
  const {
    terminals,
    terminalsRestoreReady,
    terminalPersistenceWritable,
    ownerPhase: { registration, setState },
  } = metadata;

  useEffect(() => {
    const lease = registration.fence.capture(backend);
    if (!lease || !terminalsRestoreReady || !terminalPersistenceWritable) {
      registration.saveCoordinator?.stop();
      registration.saveCoordinator = null;
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
        if (
          registration.saveCoordinator !== coordinator ||
          !registration.fence.isCurrent(lease)
        ) return;
        setState((current) => stateMatchesLease(current, lease)
          ? {
              ...current,
              terminalPersistenceError:
                `Terminal metadata could not be saved: ${String(nextError)}`,
            }
          : current);
      },
      onSaved: () => {
        if (
          registration.saveCoordinator !== coordinator ||
          !registration.fence.isCurrent(lease)
        ) return;
        setState((current) => stateMatchesLease(current, lease)
          ? { ...current, terminalPersistenceError: null }
          : current);
      },
    });
    registration.saveCoordinator = coordinator;

    return () => {
      coordinator.stop();
      if (registration.saveCoordinator === coordinator) {
        registration.saveCoordinator = null;
      }
    };
  }, [
    backend,
    registration,
    setState,
    terminalPersistenceWritable,
    terminalsRestoreReady,
  ]);

  useEffect(() => {
    const lease = registration.fence.capture(backend);
    if (!lease || !terminalsRestoreReady || !terminalPersistenceWritable) return;
    const coordinator = registration.saveCoordinator;
    if (!coordinator) return;
    const timer = window.setTimeout(() => {
      if (
        registration.saveCoordinator === coordinator &&
        registration.fence.isCurrent(lease)
      ) coordinator.enqueue(terminals);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    backend,
    registration,
    terminalPersistenceWritable,
    terminals,
    terminalsRestoreReady,
  ]);
}
