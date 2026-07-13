import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  type DashboardBackend,
  type HostConfig,
  type MobileRelayStatus,
  useDashboardBackend,
} from "../../platform";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochActivation,
  type OwnerEpochCommit,
  type OwnerEpochLease,
} from "../ownerEpochLease";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";

export const MOBILE_RELAY_VISIBLE_REFRESH_MS = 2_000;
export const MOBILE_RELAY_HIDDEN_REFRESH_MS = 15_000;

// QR Code byte-mode capacity at error-correction level M is 2,331 bytes for
// version 40. Keep a safety margin so every payload accepted here can be
// rendered by the Dashboard's QR encoder instead of failing only in the UI.
export const MOBILE_RELAY_V1_QR_MAX_BYTES = 2_200;

const DEFAULT_HOST_ID = "mac-admin";

type MobileRelayIndicatorStatus = "running" | "starting" | "stopped";

export type MobileRelayDraftField = "relayUrl" | "brokerHostId" | "hostId" | "secret";
export type MobileRelayDraftSyncPolicy = "untouched" | "submitted" | "brokerStarted";

export type MobileRelayOwnerLease = OwnerEpochLease<object>;

export type MobileRelayStatusRequest = Readonly<{
  lease: MobileRelayOwnerLease;
  generation: number;
  draftSyncPolicy: MobileRelayDraftSyncPolicy;
  draftRevisions: Readonly<Record<MobileRelayDraftField, number>>;
}>;

export type MobileRelayOperation = Readonly<{
  lease: MobileRelayOwnerLease;
  generation: number;
}>;

export type MobileRelayAsyncCoordinator = {
  commit(owner: object): OwnerEpochCommit<object>;
  activate(): OwnerEpochActivation;
  deactivate(activation: OwnerEpochActivation): boolean;
  capture(owner: object): MobileRelayOwnerLease | null;
  isCurrent(lease: MobileRelayOwnerLease | null): boolean;
  markDraftEdited(
    lease: MobileRelayOwnerLease | null,
    field: MobileRelayDraftField,
  ): boolean;
  issueStatusRequest(
    lease: MobileRelayOwnerLease | null,
    policy?: MobileRelayDraftSyncPolicy,
  ): MobileRelayStatusRequest | null;
  isCurrentStatusRequest(request: MobileRelayStatusRequest): boolean;
  acceptDraftSync(request: MobileRelayStatusRequest, field: MobileRelayDraftField): boolean;
  beginOperation(lease: MobileRelayOwnerLease | null): MobileRelayOperation | null;
  isCurrentOperation(operation: MobileRelayOperation): boolean;
  finishOperation(operation: MobileRelayOperation): boolean;
  hasActiveOperation(lease: MobileRelayOwnerLease | null): boolean;
};

/**
 * Coordinates the two independent publications in a Relay response: live
 * process status and editable connection drafts. A newer request owns live
 * status, while a draft field is only synchronized when the user has not
 * changed it. A submitted save may normalize the exact values it sent.
 */
export function createMobileRelayAsyncCoordinator(): MobileRelayAsyncCoordinator {
  const fence = createOwnerEpochLeaseController<object>();
  let statusGeneration = 0;
  let operationGeneration = 0;
  let activeOperationGeneration = 0;
  const draftRevisions: Record<MobileRelayDraftField, number> = {
    relayUrl: 0,
    brokerHostId: 0,
    hostId: 0,
    secret: 0,
  };
  const dirtyDrafts: Record<MobileRelayDraftField, boolean> = {
    relayUrl: false,
    brokerHostId: false,
    hostId: false,
    secret: false,
  };

  const resetDraftOwnership = () => {
    for (const field of ["relayUrl", "brokerHostId", "hostId", "secret"] as const) {
      draftRevisions[field] = 0;
      dirtyDrafts[field] = false;
    }
  };

  return {
    commit(owner) {
      const ownerCommit = fence.commit(owner);
      if (ownerCommit.changed) {
        statusGeneration += 1;
        operationGeneration += 1;
        activeOperationGeneration = 0;
        resetDraftOwnership();
      }
      return ownerCommit;
    },

    activate() {
      const activation = fence.activate();
      statusGeneration += 1;
      operationGeneration += 1;
      activeOperationGeneration = 0;
      return activation;
    },

    deactivate(activation) {
      if (!fence.deactivate(activation)) return false;
      statusGeneration += 1;
      operationGeneration += 1;
      activeOperationGeneration = 0;
      return true;
    },

    capture(owner) {
      return fence.capture(owner);
    },

    isCurrent(lease) {
      return lease !== null && fence.isCurrent(lease);
    },

    markDraftEdited(lease, field) {
      if (!lease || !fence.isCurrent(lease)) return false;
      draftRevisions[field] += 1;
      dirtyDrafts[field] = true;
      return true;
    },

    issueStatusRequest(lease, draftSyncPolicy = "untouched") {
      if (!lease || !fence.isCurrent(lease)) return null;
      statusGeneration += 1;
      return {
        lease,
        generation: statusGeneration,
        draftSyncPolicy,
        draftRevisions: { ...draftRevisions },
      };
    },

    isCurrentStatusRequest(request) {
      return fence.isCurrent(request.lease) && request.generation === statusGeneration;
    },

    acceptDraftSync(request, field) {
      if (!fence.isCurrent(request.lease)) return false;
      if (request.generation !== statusGeneration) return false;
      if (request.draftRevisions[field] !== draftRevisions[field]) return false;
      const brokerGeneratedField = request.draftSyncPolicy === "brokerStarted"
        && (field === "relayUrl" || field === "brokerHostId" || field === "secret");
      if (
        request.draftSyncPolicy !== "submitted"
        && !brokerGeneratedField
        && dirtyDrafts[field]
      ) return false;
      dirtyDrafts[field] = false;
      return true;
    },

    beginOperation(lease) {
      if (!lease || !fence.isCurrent(lease)) return null;
      operationGeneration += 1;
      activeOperationGeneration = operationGeneration;
      // A mutation supersedes any status read that began before it.
      statusGeneration += 1;
      return { lease, generation: operationGeneration };
    },

    isCurrentOperation(operation) {
      return fence.isCurrent(operation.lease)
        && operation.generation === activeOperationGeneration;
    },

    finishOperation(operation) {
      if (
        fence.isCurrent(operation.lease)
        && operation.generation === activeOperationGeneration
      ) {
        activeOperationGeneration = 0;
        return true;
      }
      return false;
    },

    hasActiveOperation(lease) {
      return !!lease && fence.isCurrent(lease) && activeOperationGeneration !== 0;
    },
  };
}

export type MobileRelayViewState = {
  busy: boolean;
  indicatorStatus: MobileRelayIndicatorStatus;
  statusText: string;
  tokenState: "Configured" | "Missing";
  buttonActive: boolean;
};

export type MobileRelayController = MobileRelayViewState & {
  statusKnown: boolean;
  active: boolean;
  connected: boolean;
  connectionState: string;
  relayUrl: string;
  hostId: string;
  secret: string;
  draftUrl: string;
  setDraftUrl: Dispatch<SetStateAction<string>>;
  draftHostId: string;
  setDraftHostId: Dispatch<SetStateAction<string>>;
  draftSecret: string;
  setDraftSecret: Dispatch<SetStateAction<string>>;
  brokerHostId: string;
  setBrokerHostId: Dispatch<SetStateAction<string>>;
  popoverOpen: boolean;
  setPopoverOpen: Dispatch<SetStateAction<boolean>>;
  loading: boolean;
  saving: boolean;
  brokerStarting: boolean;
  stopping: boolean;
  v1PairingPayload: string | null;
  error: string | null;
  toggle: () => Promise<void>;
  save: () => Promise<boolean>;
  start: () => Promise<boolean>;
  startBroker: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  copyValue: (value: string) => void;
};

export type UseMobileRelayControllerOptions = {
  hosts: HostConfig[];
};

type MobileRelayViewStateInput = {
  active: boolean;
  connected: boolean;
  connectionState: string;
  secret: string;
  popoverOpen: boolean;
  loading: boolean;
  saving: boolean;
  brokerStarting: boolean;
  stopping: boolean;
};

type MobileRelayOwnedState = MobileRelayViewStateInput & {
  ownerLease: MobileRelayOwnerLease | null;
  statusKnown: boolean;
  relayUrl: string;
  hostId: string;
  draftUrl: string;
  draftHostId: string;
  draftSecret: string;
  brokerHostId: string;
  error: string | null;
};

function initialMobileRelayOwnedState(
  ownerLease: MobileRelayOwnerLease | null,
): MobileRelayOwnedState {
  return {
    ownerLease,
    statusKnown: false,
    active: false,
    connected: false,
    connectionState: "stopped",
    relayUrl: "",
    hostId: DEFAULT_HOST_ID,
    secret: "",
    draftUrl: "",
    draftHostId: DEFAULT_HOST_ID,
    draftSecret: "",
    brokerHostId: "",
    popoverOpen: false,
    loading: false,
    saving: false,
    brokerStarting: false,
    stopping: false,
    error: null,
  };
}

function resolveStateAction<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === "function"
    ? (value as (previous: T) => T)(current)
    : value;
}

export function deriveMobileRelayViewState({
  active,
  connected,
  connectionState,
  secret,
  popoverOpen,
  loading,
  saving,
  brokerStarting,
  stopping,
}: MobileRelayViewStateInput): MobileRelayViewState {
  const busy = loading || saving || brokerStarting || stopping;
  const indicatorStatus = busy
    ? "starting"
    : connected
      ? "running"
      : active
        ? "starting"
        : "stopped";
  const statusText = brokerStarting
    ? "Deploying broker"
    : loading
      ? "Starting"
      : saving
        ? "Saving"
        : stopping
          ? "Stopping"
          : connected
            ? "Connector connected"
            : active
              ? connectionState === "retrying" ? "Connector retrying" : "Connector connecting"
              : "Connector stopped";

  return {
    busy,
    indicatorStatus,
    statusText,
    tokenState: secret ? "Configured" : "Missing",
    buttonActive: active || popoverOpen || busy,
  };
}

export function buildMobileRelayV1PairingPayload({
  relayUrl,
  hostId,
  secret,
}: Pick<MobileRelayStatus, "relayUrl" | "hostId" | "secret">): string | null {
  const normalizedRelayUrl = relayUrl.trim();
  const normalizedHostId = hostId.trim();
  const normalizedSecret = secret.trim();
  if (!normalizedRelayUrl || !normalizedHostId || !normalizedSecret) return null;
  if (
    normalizedRelayUrl.length > 2_048 ||
    normalizedSecret.length > 4_096 ||
    /[\0\r\n]/.test(normalizedSecret) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(normalizedHostId)
  ) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedRelayUrl);
  } catch {
    return null;
  }
  if (
    parsedUrl.protocol !== "wss:" ||
    !parsedUrl.hostname ||
    parsedUrl.port === "0" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) return null;
  if (/[?#]/.test(normalizedRelayUrl) || normalizedRelayUrl.slice(6).includes("@")) return null;
  const canonicalRelayUrl = parsedUrl.toString().replace(/\/$/, "");

  const payload = [
    "tmuxworktree://pair?relayUrl=",
    encodeURIComponent(canonicalRelayUrl),
    "&token=",
    encodeURIComponent(normalizedSecret),
    "&hostId=",
    encodeURIComponent(normalizedHostId),
  ].join("");
  return new TextEncoder().encode(payload).byteLength <= MOBILE_RELAY_V1_QR_MAX_BYTES
    ? payload
    : null;
}

export function useMobileRelayController({
  hosts,
}: UseMobileRelayControllerOptions): MobileRelayController {
  const dashboardBackend = useDashboardBackend();
  const [asyncCoordinator] = useState(createMobileRelayAsyncCoordinator);
  const committedBackendRef = useRef<DashboardBackend | null>(null);
  const ownerLease = asyncCoordinator.capture(dashboardBackend);
  const [ownedState, setOwnedState] = useState<MobileRelayOwnedState>(
    () => initialMobileRelayOwnedState(null),
  );

  useLayoutEffect(() => {
    committedBackendRef.current = dashboardBackend;
    const ownerCommit = asyncCoordinator.commit(dashboardBackend);
    if (!ownerCommit.changed) return;
    setOwnedState(initialMobileRelayOwnedState(ownerCommit.lease));
  }, [asyncCoordinator, dashboardBackend]);

  useLayoutEffect(() => {
    const activation = asyncCoordinator.activate();
    const lease = committedBackendRef.current
      ? asyncCoordinator.capture(committedBackendRef.current)
      : null;
    setOwnedState((current) => {
      if (!lease) return initialMobileRelayOwnedState(null);
      const sameCommittedOwner = current.ownerLease?.owner === lease.owner
        && current.ownerLease.epoch === lease.epoch;
      const ownerState = sameCommittedOwner
        ? current
        : initialMobileRelayOwnedState(lease);
      return {
        ...ownerState,
        ownerLease: lease,
        loading: false,
        saving: false,
        brokerStarting: false,
        stopping: false,
      };
    });
    return () => {
      asyncCoordinator.deactivate(activation);
    };
  }, [asyncCoordinator]);

  const visibleState = ownerLease !== null && ownedState.ownerLease === ownerLease
    ? ownedState
    : initialMobileRelayOwnedState(null);
  const {
    active,
    brokerHostId,
    brokerStarting,
    connected,
    connectionState,
    draftHostId,
    draftSecret,
    draftUrl,
    error,
    hostId,
    loading,
    popoverOpen,
    relayUrl,
    saving,
    secret,
    statusKnown,
    stopping,
  } = visibleState;

  const updateOwnedState = useCallback((
    lease: MobileRelayOwnerLease | null,
    update: (current: MobileRelayOwnedState) => MobileRelayOwnedState,
  ): boolean => {
    if (!asyncCoordinator.isCurrent(lease)) return false;
    setOwnedState((current) => {
      if (!asyncCoordinator.isCurrent(lease)) return current;
      const ownerState = current.ownerLease === lease
        ? current
        : initialMobileRelayOwnedState(lease);
      return update(ownerState);
    });
    return true;
  }, [asyncCoordinator]);

  const setDraftUrl = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (!asyncCoordinator.markDraftEdited(ownerLease, "relayUrl")) return;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      draftUrl: resolveStateAction(value, current.draftUrl),
    }));
  }, [asyncCoordinator, ownerLease, updateOwnedState]);
  const setDraftHostId = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (!asyncCoordinator.markDraftEdited(ownerLease, "hostId")) return;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      draftHostId: resolveStateAction(value, current.draftHostId),
    }));
  }, [asyncCoordinator, ownerLease, updateOwnedState]);
  const setDraftSecret = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (!asyncCoordinator.markDraftEdited(ownerLease, "secret")) return;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      draftSecret: resolveStateAction(value, current.draftSecret),
    }));
  }, [asyncCoordinator, ownerLease, updateOwnedState]);
  const setBrokerHostId = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (!asyncCoordinator.markDraftEdited(ownerLease, "brokerHostId")) return;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      brokerHostId: resolveStateAction(value, current.brokerHostId),
    }));
  }, [asyncCoordinator, ownerLease, updateOwnedState]);
  const setPopoverOpen = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      popoverOpen: resolveStateAction(value, current.popoverOpen),
    }));
  }, [ownerLease, updateOwnedState]);

  const requireKnownStatus = useCallback((): boolean => {
    if (!asyncCoordinator.isCurrent(ownerLease)) return false;
    if (statusKnown) return true;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      popoverOpen: true,
      error: current.error ?? "Wait for Relay status before changing its configuration.",
    }));
    return false;
  }, [asyncCoordinator, ownerLease, statusKnown, updateOwnedState]);

  const applyStatus = useCallback((
    status: MobileRelayStatus,
    request: MobileRelayStatusRequest,
    lease: MobileRelayOwnerLease,
  ): boolean => {
    if (!asyncCoordinator.isCurrent(lease)) return false;
    if (!asyncCoordinator.isCurrentStatusRequest(request)) return false;
    const syncRelayUrl = asyncCoordinator.acceptDraftSync(request, "relayUrl");
    const syncBrokerHostId = asyncCoordinator.acceptDraftSync(request, "brokerHostId");
    const syncHostId = asyncCoordinator.acceptDraftSync(request, "hostId");
    const syncSecret = asyncCoordinator.acceptDraftSync(request, "secret");
    return updateOwnedState(lease, (current) => ({
      ...current,
      statusKnown: true,
      active: status.active,
      connected: status.connected,
      connectionState: status.connectionState,
      relayUrl: status.relayUrl,
      hostId: status.hostId,
      secret: status.secret,
      draftUrl: syncRelayUrl ? status.relayUrl : current.draftUrl,
      brokerHostId: syncBrokerHostId ? status.brokerHostId : current.brokerHostId,
      draftHostId: syncHostId ? status.hostId : current.draftHostId,
      draftSecret: syncSecret ? status.secret : current.draftSecret,
      error: status.error ?? null,
    }));
  }, [asyncCoordinator, updateOwnedState]);

  const checkStatus = useCallback(async (
    operation?: MobileRelayOperation,
  ): Promise<MobileRelayStatus | null> => {
    if (!asyncCoordinator.isCurrent(ownerLease)) return null;
    if (operation && !asyncCoordinator.isCurrentOperation(operation)) return null;
    const request = asyncCoordinator.issueStatusRequest(ownerLease, "untouched");
    if (!request) return null;
    try {
      const status = await dashboardBackend.relay.status();
      if (!asyncCoordinator.isCurrent(ownerLease)) return null;
      if (operation && !asyncCoordinator.isCurrentOperation(operation)) return null;
      return applyStatus(status, request, request.lease) ? status : null;
    } catch (nextError) {
      if (
        asyncCoordinator.isCurrent(ownerLease) &&
        (!operation || asyncCoordinator.isCurrentOperation(operation)) &&
        asyncCoordinator.isCurrentStatusRequest(request)
      ) {
        updateOwnedState(ownerLease, (current) => ({
          ...current,
          statusKnown: false,
          error: `Unable to read Relay status: ${String(nextError)}`,
        }));
      }
      return null;
    }
  }, [
    applyStatus,
    asyncCoordinator,
    dashboardBackend,
    ownerLease,
    updateOwnedState,
  ]);

  const beginOwnedOperation = useCallback((
    kind: "loading" | "saving" | "brokerStarting" | "stopping",
  ): MobileRelayOperation | null => {
    const operation = asyncCoordinator.beginOperation(ownerLease);
    if (!operation) return null;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      loading: kind === "loading",
      saving: kind === "saving",
      brokerStarting: kind === "brokerStarting",
      stopping: kind === "stopping",
      error: null,
    }));
    return operation;
  }, [asyncCoordinator, ownerLease, updateOwnedState]);

  const finishOwnedOperation = useCallback((operation: MobileRelayOperation): void => {
    if (!asyncCoordinator.finishOperation(operation)) return;
    updateOwnedState(ownerLease, (current) => ({
      ...current,
      loading: false,
      saving: false,
      brokerStarting: false,
      stopping: false,
    }));
  }, [asyncCoordinator, ownerLease, updateOwnedState]);

  const toggle = useCallback(async () => {
    if (!asyncCoordinator.isCurrent(ownerLease)) return;
    if (active) {
      setPopoverOpen(true);
      return;
    }

    const status = await checkStatus();
    if (!status) {
      setPopoverOpen(true);
      return;
    }
    if (!status.secret.trim()) {
      setPopoverOpen(true);
      updateOwnedState(ownerLease, (current) => ({ ...current, error: null }));
      return;
    }

    const operation = beginOwnedOperation("loading");
    if (!operation) return;
    setPopoverOpen(true);
    try {
      await dashboardBackend.relay.start();
      if (!asyncCoordinator.isCurrentOperation(operation)) return;
      await checkStatus(operation);
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        updateOwnedState(ownerLease, (current) => ({
          ...current,
          error: String(nextError),
        }));
      }
    } finally {
      finishOwnedOperation(operation);
    }
  }, [
    active,
    asyncCoordinator,
    beginOwnedOperation,
    checkStatus,
    dashboardBackend,
    finishOwnedOperation,
    ownerLease,
    setPopoverOpen,
    updateOwnedState,
  ]);

  const saveConfig = useCallback(async (
    operation: MobileRelayOperation,
  ): Promise<MobileRelayStatus | null> => {
    const args = {
      relayUrl: draftUrl.trim(),
      brokerHostId: brokerHostId.trim(),
      hostId: draftHostId.trim(),
      secret: draftSecret.trim(),
    };
    if (!args.relayUrl || !args.hostId) {
      throw new Error("Relay URL and host are required");
    }
    if (!asyncCoordinator.isCurrent(ownerLease)) return null;
    if (!asyncCoordinator.isCurrentOperation(operation)) return null;
    const request = asyncCoordinator.issueStatusRequest(ownerLease, "submitted");
    if (!request) return null;
    const status = await dashboardBackend.relay.saveConfig(args);
    if (!asyncCoordinator.isCurrent(ownerLease)) return null;
    if (!asyncCoordinator.isCurrentOperation(operation)) return null;
    return applyStatus(status, request, request.lease) ? status : null;
  }, [
    applyStatus,
    asyncCoordinator,
    dashboardBackend,
    brokerHostId,
    draftHostId,
    draftSecret,
    draftUrl,
    ownerLease,
  ]);

  const save = useCallback(async () => {
    if (!requireKnownStatus()) return false;
    const operation = beginOwnedOperation("saving");
    if (!operation) return false;
    try {
      return (await saveConfig(operation)) !== null;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        updateOwnedState(ownerLease, (current) => ({
          ...current,
          error: String(nextError),
        }));
      }
      return false;
    } finally {
      finishOwnedOperation(operation);
    }
  }, [
    asyncCoordinator,
    beginOwnedOperation,
    finishOwnedOperation,
    ownerLease,
    requireKnownStatus,
    saveConfig,
    updateOwnedState,
  ]);

  const start = useCallback(async () => {
    if (!requireKnownStatus()) return false;
    const operation = beginOwnedOperation("loading");
    if (!operation) return false;
    try {
      const saved = await saveConfig(operation);
      if (!saved) return false;
      if (!saved.secret.trim()) {
        throw new Error("Relay token is required before starting the connector");
      }
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      await dashboardBackend.relay.start();
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      return (await checkStatus(operation)) !== null;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        updateOwnedState(ownerLease, (current) => ({
          ...current,
          error: String(nextError),
        }));
      }
      return false;
    } finally {
      finishOwnedOperation(operation);
    }
  }, [
    asyncCoordinator,
    beginOwnedOperation,
    checkStatus,
    dashboardBackend,
    finishOwnedOperation,
    ownerLease,
    requireKnownStatus,
    saveConfig,
    updateOwnedState,
  ]);

  const startBroker = useCallback(async () => {
    if (!brokerHostId) return false;
    if (!requireKnownStatus()) return false;
    const operation = beginOwnedOperation("brokerStarting");
    if (!operation) return false;
    try {
      const request = asyncCoordinator.issueStatusRequest(ownerLease, "brokerStarted");
      if (!request) return false;
      const status = await dashboardBackend.relay.startBroker({
        hostId: brokerHostId,
        port: 8787,
        quickTunnel: true,
      });
      if (!asyncCoordinator.isCurrent(ownerLease)) return false;
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      if (!applyStatus(status, request, request.lease)) return false;
      await dashboardBackend.relay.start();
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      return (await checkStatus(operation)) !== null;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        updateOwnedState(ownerLease, (current) => ({
          ...current,
          error: String(nextError),
        }));
      }
      return false;
    } finally {
      finishOwnedOperation(operation);
    }
  }, [
    applyStatus,
    asyncCoordinator,
    beginOwnedOperation,
    brokerHostId,
    checkStatus,
    dashboardBackend,
    finishOwnedOperation,
    ownerLease,
    requireKnownStatus,
    updateOwnedState,
  ]);

  const stop = useCallback(async () => {
    const operation = beginOwnedOperation("stopping");
    if (!operation) return false;
    try {
      await dashboardBackend.relay.stop();
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      if (!(await checkStatus(operation))) return false;
      setPopoverOpen(false);
      return true;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        updateOwnedState(ownerLease, (current) => ({
          ...current,
          error: String(nextError),
        }));
      }
      return false;
    } finally {
      finishOwnedOperation(operation);
    }
  }, [
    asyncCoordinator,
    beginOwnedOperation,
    checkStatus,
    dashboardBackend,
    finishOwnedOperation,
    ownerLease,
    setPopoverOpen,
    updateOwnedState,
  ]);

  const copyValue = useCallback((value: string) => {
    if (!asyncCoordinator.isCurrent(ownerLease)) return;
    if (value) void navigator.clipboard.writeText(value);
  }, [asyncCoordinator, ownerLease]);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const refreshStatus = useCallback(async () => {
    if (asyncCoordinator.hasActiveOperation(ownerLease)) return;
    await checkStatus();
  }, [asyncCoordinator, checkStatus, ownerLease]);
  useVisibilityAwarePolling(refreshStatus, {
    enabled: active || popoverOpen,
    visibleIntervalMs: MOBILE_RELAY_VISIBLE_REFRESH_MS,
    hiddenIntervalMs: MOBILE_RELAY_HIDDEN_REFRESH_MS,
    refreshKey: `${active}\0${popoverOpen}`,
  });

  useEffect(() => {
    if (!statusKnown || brokerHostId || hosts.length === 0) return;
    const preferred = hosts.find((host) => host.id === "devbox") ?? hosts[0];
    setBrokerHostId(preferred.id);
  }, [brokerHostId, hosts, setBrokerHostId, statusKnown]);

  const viewState = deriveMobileRelayViewState({
    active,
    connected,
    connectionState,
    secret,
    popoverOpen,
    loading,
    saving,
    brokerStarting,
    stopping,
  });
  const v1PairingPayload = statusKnown && connected
    ? buildMobileRelayV1PairingPayload({ relayUrl, hostId, secret })
    : null;

  return {
    statusKnown,
    active,
    connected,
    connectionState,
    relayUrl,
    hostId,
    secret,
    draftUrl,
    setDraftUrl,
    draftHostId,
    setDraftHostId,
    draftSecret,
    setDraftSecret,
    brokerHostId,
    setBrokerHostId,
    popoverOpen,
    setPopoverOpen,
    loading,
    saving,
    brokerStarting,
    stopping,
    v1PairingPayload,
    error,
    toggle,
    save,
    start,
    startBroker,
    stop,
    copyValue,
    ...viewState,
  };
}
