import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  type HostConfig,
  type MobileRelayStatus,
  useDashboardBackend,
} from "../../platform";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";

export const MOBILE_RELAY_VISIBLE_REFRESH_MS = 2_000;
export const MOBILE_RELAY_HIDDEN_REFRESH_MS = 15_000;

const DEFAULT_RELAY_URL = "wss://relay.example.com";
const DEFAULT_HOST_ID = "mac-admin";

type MobileRelayIndicatorStatus = "running" | "starting" | "stopped";

export type MobileRelayDraftField = "relayUrl" | "hostId" | "secret";
export type MobileRelayDraftSyncPolicy = "untouched" | "submitted";

export type MobileRelayStatusRequest = Readonly<{
  generation: number;
  draftSyncPolicy: MobileRelayDraftSyncPolicy;
  draftRevisions: Readonly<Record<MobileRelayDraftField, number>>;
}>;

export type MobileRelayOperation = Readonly<{
  generation: number;
}>;

export type MobileRelayAsyncCoordinator = {
  markDraftEdited(field: MobileRelayDraftField): void;
  issueStatusRequest(policy?: MobileRelayDraftSyncPolicy): MobileRelayStatusRequest;
  isCurrentStatusRequest(request: MobileRelayStatusRequest): boolean;
  acceptDraftSync(request: MobileRelayStatusRequest, field: MobileRelayDraftField): boolean;
  beginOperation(): MobileRelayOperation;
  isCurrentOperation(operation: MobileRelayOperation): boolean;
  finishOperation(operation: MobileRelayOperation): void;
  hasActiveOperation(): boolean;
};

/**
 * Coordinates the two independent publications in a Relay response: live
 * process status and editable connection drafts. A newer request owns live
 * status, while a draft field is only synchronized when the user has not
 * changed it. A submitted save may normalize the exact values it sent.
 */
export function createMobileRelayAsyncCoordinator(): MobileRelayAsyncCoordinator {
  let statusGeneration = 0;
  let operationGeneration = 0;
  let activeOperationGeneration = 0;
  const draftRevisions: Record<MobileRelayDraftField, number> = {
    relayUrl: 0,
    hostId: 0,
    secret: 0,
  };
  const dirtyDrafts: Record<MobileRelayDraftField, boolean> = {
    relayUrl: false,
    hostId: false,
    secret: false,
  };

  return {
    markDraftEdited(field) {
      draftRevisions[field] += 1;
      dirtyDrafts[field] = true;
    },

    issueStatusRequest(draftSyncPolicy = "untouched") {
      statusGeneration += 1;
      return {
        generation: statusGeneration,
        draftSyncPolicy,
        draftRevisions: { ...draftRevisions },
      };
    },

    isCurrentStatusRequest(request) {
      return request.generation === statusGeneration;
    },

    acceptDraftSync(request, field) {
      if (request.generation !== statusGeneration) return false;
      if (request.draftRevisions[field] !== draftRevisions[field]) return false;
      if (request.draftSyncPolicy === "untouched" && dirtyDrafts[field]) return false;
      dirtyDrafts[field] = false;
      return true;
    },

    beginOperation() {
      operationGeneration += 1;
      activeOperationGeneration = operationGeneration;
      // A mutation supersedes any status read that began before it.
      statusGeneration += 1;
      return { generation: operationGeneration };
    },

    isCurrentOperation(operation) {
      return operation.generation === activeOperationGeneration;
    },

    finishOperation(operation) {
      if (operation.generation === activeOperationGeneration) {
        activeOperationGeneration = 0;
      }
    },

    hasActiveOperation() {
      return activeOperationGeneration !== 0;
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
  copied: boolean;
  v1PairingPayload: string | null;
  error: string | null;
  toggle: () => Promise<void>;
  save: () => Promise<boolean>;
  start: () => Promise<boolean>;
  startBroker: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  copyLaunch: () => void;
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
    ? "Starting broker"
    : loading
      ? "Starting"
      : saving
        ? "Saving"
        : stopping
          ? "Stopping"
          : connected
            ? "Connected"
            : active
              ? connectionState === "retrying" ? "Reconnecting" : "Connecting"
              : "Stopped";

  return {
    busy,
    indicatorStatus,
    statusText,
    tokenState: secret ? "Configured" : "Missing",
    buttonActive: active || popoverOpen || busy,
  };
}

export function buildMobileRelayLaunchCommand({
  relayUrl,
  hostId,
  secret,
}: Pick<MobileRelayStatus, "relayUrl" | "hostId" | "secret">): string {
  return [
    "adb shell am start -n com.tmuxworktree.mobile/.V2Activity",
    `  --es relayUrl ${quoteAdbShellArgument(relayUrl)}`,
    `  --es hostId ${quoteAdbShellArgument(hostId)}`,
    `  --es relaySecret ${quoteAdbShellArgument(secret || "<TW_RELAY_SECRET>")}`,
  ].join(" \\\n");
}

export function shellSingleQuote(value: string): string {
  const escapedQuote = `'"'"'`;
  return `'${value.replace(/'/g, escapedQuote)}'`;
}

/**
 * `adb shell COMMAND...` is parsed twice: first by the desktop shell and then
 * again by Android's shell. Preserve the inner single-quoted word through the
 * first parse so credentials can never become remote shell syntax.
 */
export function quoteAdbShellArgument(value: string): string {
  const remoteQuotedWord = shellSingleQuote(value);
  const desktopEscapedWord = remoteQuotedWord.replace(
    /["\\$`]/g,
    (character) => `\\${character}`,
  );
  return `"${desktopEscapedWord}"`;
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
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) return null;

  return [
    "tmuxworktree://pair?relayUrl=",
    encodeURIComponent(normalizedRelayUrl),
    "&token=",
    encodeURIComponent(normalizedSecret),
    "&hostId=",
    encodeURIComponent(normalizedHostId),
  ].join("");
}

export function useMobileRelayController({
  hosts,
}: UseMobileRelayControllerOptions): MobileRelayController {
  const dashboardBackend = useDashboardBackend();
  const asyncCoordinatorRef = useRef<MobileRelayAsyncCoordinator | null>(null);
  if (asyncCoordinatorRef.current === null) {
    asyncCoordinatorRef.current = createMobileRelayAsyncCoordinator();
  }
  const asyncCoordinator = asyncCoordinatorRef.current;
  const [brokerHostId, setBrokerHostId] = useState("");
  const [active, setActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("stopped");
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [hostId, setHostId] = useState(DEFAULT_HOST_ID);
  const [secret, setSecret] = useState("");
  const [draftUrl, setDraftUrlState] = useState(DEFAULT_RELAY_URL);
  const [draftHostId, setDraftHostIdState] = useState(DEFAULT_HOST_ID);
  const [draftSecret, setDraftSecretState] = useState("");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brokerStarting, setBrokerStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusKnown, setStatusKnown] = useState(false);

  const setDraftUrl = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    asyncCoordinator.markDraftEdited("relayUrl");
    setDraftUrlState(value);
  }, [asyncCoordinator]);
  const setDraftHostId = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    asyncCoordinator.markDraftEdited("hostId");
    setDraftHostIdState(value);
  }, [asyncCoordinator]);
  const setDraftSecret = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    asyncCoordinator.markDraftEdited("secret");
    setDraftSecretState(value);
  }, [asyncCoordinator]);

  const requireKnownStatus = useCallback((): boolean => {
    if (statusKnown) return true;
    setPopoverOpen(true);
    setError((current) => current ?? "Wait for Relay status before changing its configuration.");
    return false;
  }, [statusKnown]);

  const applyStatus = useCallback((
    status: MobileRelayStatus,
    request: MobileRelayStatusRequest,
  ): boolean => {
    if (!asyncCoordinator.isCurrentStatusRequest(request)) return false;
    setStatusKnown(true);
    setActive(status.active);
    setConnected(status.connected);
    setConnectionState(status.connectionState);
    setRelayUrl(status.relayUrl);
    setHostId(status.hostId);
    setSecret(status.secret);
    if (asyncCoordinator.acceptDraftSync(request, "relayUrl")) {
      setDraftUrlState(status.relayUrl);
    }
    if (asyncCoordinator.acceptDraftSync(request, "hostId")) {
      setDraftHostIdState(status.hostId);
    }
    if (asyncCoordinator.acceptDraftSync(request, "secret")) {
      setDraftSecretState(status.secret);
    }
    setError(status.error ?? null);
    return true;
  }, [asyncCoordinator]);

  const checkStatus = useCallback(async (
    operation?: MobileRelayOperation,
  ): Promise<MobileRelayStatus | null> => {
    if (operation && !asyncCoordinator.isCurrentOperation(operation)) return null;
    const request = asyncCoordinator.issueStatusRequest("untouched");
    try {
      const status = await dashboardBackend.relay.status();
      if (operation && !asyncCoordinator.isCurrentOperation(operation)) return null;
      return applyStatus(status, request) ? status : null;
    } catch (nextError) {
      if (
        (!operation || asyncCoordinator.isCurrentOperation(operation)) &&
        asyncCoordinator.isCurrentStatusRequest(request)
      ) {
        setStatusKnown(false);
        setError(`Unable to read Relay status: ${String(nextError)}`);
      }
      return null;
    }
  }, [applyStatus, asyncCoordinator, dashboardBackend]);

  const toggle = useCallback(async () => {
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
      setError(null);
      return;
    }

    const operation = asyncCoordinator.beginOperation();
    setLoading(true);
    setPopoverOpen(true);
    setError(null);
    try {
      await dashboardBackend.relay.start();
      if (!asyncCoordinator.isCurrentOperation(operation)) return;
      await checkStatus(operation);
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        setError(String(nextError));
      }
    } finally {
      asyncCoordinator.finishOperation(operation);
      setLoading(false);
    }
  }, [active, asyncCoordinator, checkStatus, dashboardBackend]);

  const saveConfig = useCallback(async (
    operation: MobileRelayOperation,
  ): Promise<MobileRelayStatus | null> => {
    const args = {
      relayUrl: draftUrl.trim(),
      hostId: draftHostId.trim(),
      secret: draftSecret.trim(),
    };
    if (!args.relayUrl || !args.hostId) {
      throw new Error("Relay URL and host are required");
    }
    if (!asyncCoordinator.isCurrentOperation(operation)) return null;
    const request = asyncCoordinator.issueStatusRequest("submitted");
    const status = await dashboardBackend.relay.saveConfig(args);
    if (!asyncCoordinator.isCurrentOperation(operation)) return null;
    return applyStatus(status, request) ? status : null;
  }, [applyStatus, asyncCoordinator, dashboardBackend, draftHostId, draftSecret, draftUrl]);

  const save = useCallback(async () => {
    if (!requireKnownStatus()) return false;
    const operation = asyncCoordinator.beginOperation();
    setSaving(true);
    setError(null);
    try {
      return (await saveConfig(operation)) !== null;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        setError(String(nextError));
      }
      return false;
    } finally {
      asyncCoordinator.finishOperation(operation);
      setSaving(false);
    }
  }, [asyncCoordinator, requireKnownStatus, saveConfig]);

  const start = useCallback(async () => {
    if (!requireKnownStatus()) return false;
    const operation = asyncCoordinator.beginOperation();
    setLoading(true);
    setError(null);
    try {
      const saved = await saveConfig(operation);
      if (!saved) return false;
      if (!saved.secret.trim()) {
        throw new Error("Relay token is required before Android can connect");
      }
      await dashboardBackend.relay.start();
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      return (await checkStatus(operation)) !== null;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        setError(String(nextError));
      }
      return false;
    } finally {
      asyncCoordinator.finishOperation(operation);
      setLoading(false);
    }
  }, [asyncCoordinator, checkStatus, dashboardBackend, requireKnownStatus, saveConfig]);

  const startBroker = useCallback(async () => {
    if (!brokerHostId) return false;
    if (!requireKnownStatus()) return false;
    const operation = asyncCoordinator.beginOperation();
    setBrokerStarting(true);
    setError(null);
    try {
      const request = asyncCoordinator.issueStatusRequest("untouched");
      const status = await dashboardBackend.relay.startBroker({
        hostId: brokerHostId,
        port: 8787,
      });
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      if (!applyStatus(status, request)) return false;
      await dashboardBackend.relay.start();
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      return (await checkStatus(operation)) !== null;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        setError(String(nextError));
      }
      return false;
    } finally {
      asyncCoordinator.finishOperation(operation);
      setBrokerStarting(false);
    }
  }, [
    applyStatus,
    asyncCoordinator,
    brokerHostId,
    checkStatus,
    dashboardBackend,
    requireKnownStatus,
  ]);

  const stop = useCallback(async () => {
    const operation = asyncCoordinator.beginOperation();
    setStopping(true);
    setError(null);
    try {
      await dashboardBackend.relay.stop();
      if (!asyncCoordinator.isCurrentOperation(operation)) return false;
      if (!(await checkStatus(operation))) return false;
      setPopoverOpen(false);
      return true;
    } catch (nextError) {
      if (asyncCoordinator.isCurrentOperation(operation)) {
        setError(String(nextError));
      }
      return false;
    } finally {
      asyncCoordinator.finishOperation(operation);
      setStopping(false);
    }
  }, [asyncCoordinator, checkStatus, dashboardBackend]);

  const copyLaunch = useCallback(() => {
    void navigator.clipboard.writeText(buildMobileRelayLaunchCommand({ relayUrl, hostId, secret }));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [hostId, relayUrl, secret]);

  const copyValue = useCallback((value: string) => {
    if (value) void navigator.clipboard.writeText(value);
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const refreshStatus = useCallback(async () => {
    if (asyncCoordinator.hasActiveOperation()) return;
    await checkStatus();
  }, [asyncCoordinator, checkStatus]);
  useVisibilityAwarePolling(refreshStatus, {
    enabled: active || popoverOpen,
    visibleIntervalMs: MOBILE_RELAY_VISIBLE_REFRESH_MS,
    hiddenIntervalMs: MOBILE_RELAY_HIDDEN_REFRESH_MS,
    refreshKey: `${active}\0${popoverOpen}`,
  });

  useEffect(() => {
    if (brokerHostId || hosts.length === 0) return;
    const preferred = hosts.find((host) => host.id === "devbox") ?? hosts[0];
    setBrokerHostId(preferred.id);
  }, [brokerHostId, hosts]);

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
  const v1PairingPayload = statusKnown && active
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
    copied,
    v1PairingPayload,
    error,
    toggle,
    save,
    start,
    startBroker,
    stop,
    copyLaunch,
    copyValue,
    ...viewState,
  };
}
