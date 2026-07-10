import {
  useCallback,
  useEffect,
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

export type MobileRelayViewState = {
  busy: boolean;
  indicatorStatus: MobileRelayIndicatorStatus;
  statusText: string;
  tokenState: "Configured" | "Missing";
  buttonActive: boolean;
};

export type MobileRelayController = MobileRelayViewState & {
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
    "adb shell am start -n com.tmuxworktree.mobile/.MainActivity",
    `  --es relayUrl '${relayUrl}'`,
    `  --es hostId '${hostId}'`,
    secret ? `  --es relaySecret '${secret}'` : "  --es relaySecret '<TW_RELAY_SECRET>'",
    "  --ez autoConnect true",
  ].join(" \\\n");
}

function fallbackMobileRelayStatus(): MobileRelayStatus {
  return {
    active: false,
    connected: false,
    connectionState: "stopped",
    relayUrl: DEFAULT_RELAY_URL,
    hostId: DEFAULT_HOST_ID,
    secret: "",
    token: "",
    error: null,
  };
}

export function useMobileRelayController({
  hosts,
}: UseMobileRelayControllerOptions): MobileRelayController {
  const dashboardBackend = useDashboardBackend();
  const [brokerHostId, setBrokerHostId] = useState("");
  const [active, setActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("stopped");
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [hostId, setHostId] = useState(DEFAULT_HOST_ID);
  const [secret, setSecret] = useState("");
  const [draftUrl, setDraftUrl] = useState(DEFAULT_RELAY_URL);
  const [draftHostId, setDraftHostId] = useState(DEFAULT_HOST_ID);
  const [draftSecret, setDraftSecret] = useState("");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brokerStarting, setBrokerStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((status: MobileRelayStatus, syncDraft = true) => {
    setActive(status.active);
    setConnected(status.connected);
    setConnectionState(status.connectionState);
    setRelayUrl(status.relayUrl);
    setHostId(status.hostId);
    setSecret(status.secret);
    if (syncDraft) {
      setDraftUrl(status.relayUrl);
      setDraftHostId(status.hostId);
      setDraftSecret(status.secret);
    }
    setError(status.error ?? null);
  }, []);

  const checkStatus = useCallback(async (): Promise<MobileRelayStatus> => {
    try {
      const status = await dashboardBackend.relay.status();
      applyStatus(status);
      return status;
    } catch {
      return fallbackMobileRelayStatus();
    }
  }, [applyStatus, dashboardBackend]);

  const toggle = useCallback(async () => {
    if (active) {
      setPopoverOpen(true);
      return;
    }

    const status = await checkStatus();
    if (!status.secret.trim()) {
      setPopoverOpen(true);
      setError(null);
      return;
    }

    setLoading(true);
    setPopoverOpen(true);
    setError(null);
    try {
      await dashboardBackend.relay.start();
      applyStatus(await dashboardBackend.relay.status());
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setLoading(false);
    }
  }, [active, applyStatus, checkStatus, dashboardBackend]);

  const saveConfig = useCallback(async (): Promise<MobileRelayStatus> => {
    const args = {
      relayUrl: draftUrl.trim(),
      hostId: draftHostId.trim(),
      secret: draftSecret.trim(),
    };
    if (!args.relayUrl || !args.hostId) {
      throw new Error("Relay URL and host are required");
    }
    const status = await dashboardBackend.relay.saveConfig(args);
    applyStatus(status);
    return status;
  }, [applyStatus, dashboardBackend, draftHostId, draftSecret, draftUrl]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await saveConfig();
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    } finally {
      setSaving(false);
    }
  }, [saveConfig]);

  const start = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const saved = await saveConfig();
      if (!saved.secret.trim()) {
        throw new Error("Relay token is required before Android can connect");
      }
      await dashboardBackend.relay.start();
      applyStatus(await dashboardBackend.relay.status());
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    } finally {
      setLoading(false);
    }
  }, [applyStatus, dashboardBackend, saveConfig]);

  const startBroker = useCallback(async () => {
    if (!brokerHostId) return false;
    setBrokerStarting(true);
    setError(null);
    try {
      const status = await dashboardBackend.relay.startBroker({
        hostId: brokerHostId,
        port: 8787,
      });
      applyStatus(status);
      await dashboardBackend.relay.start();
      applyStatus(await dashboardBackend.relay.status());
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    } finally {
      setBrokerStarting(false);
    }
  }, [applyStatus, brokerHostId, dashboardBackend]);

  const stop = useCallback(async () => {
    setStopping(true);
    setError(null);
    try {
      await dashboardBackend.relay.stop();
      applyStatus(await dashboardBackend.relay.status());
      setPopoverOpen(false);
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    } finally {
      setStopping(false);
    }
  }, [applyStatus, dashboardBackend]);

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
    applyStatus(await dashboardBackend.relay.status(), false);
  }, [applyStatus, dashboardBackend]);
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

  return {
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
