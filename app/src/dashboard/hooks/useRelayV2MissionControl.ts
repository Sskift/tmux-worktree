import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardBackend } from "../../platform";
import type { MobileRelayV2DashboardState } from "../../platform/domainTypes";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";

const VISIBLE_REFRESH_MS = 5_000;
const HIDDEN_REFRESH_MS = 30_000;

export type RelayV2MissionControlDevice = Readonly<{
  id: string;
  clientInstanceId: string;
  shortId: string;
  connectionCount: number;
}>;

export type RelayV2MissionControlSummary = Readonly<{
  phase: "loading" | "online" | "connecting" | "offline" | "issue" | "unavailable";
  statusLabel: string;
  headline: string;
  detail: string;
  devices: readonly RelayV2MissionControlDevice[];
}>;

const LOADING_SUMMARY: RelayV2MissionControlSummary = {
  phase: "loading",
  statusLabel: "Checking",
  headline: "Checking mobile link",
  detail: "Reading the authoritative Relay v2 state…",
  devices: [],
};

function compactIdentifier(value: string): string {
  if (value.length <= 13) return value;
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

export function projectRelayV2MissionControl(
  state: MobileRelayV2DashboardState,
): RelayV2MissionControlSummary {
  const devices = state.connectedMobileDevices.map((device) => ({
    id: device.grantId,
    clientInstanceId: device.clientInstanceId,
    shortId: compactIdentifier(device.clientInstanceId),
    connectionCount: device.connectionCount,
  }));

  if (state.authority.kind === "unavailable") {
    return {
      phase: "unavailable",
      statusLabel: "Unavailable",
      headline: "Relay management unavailable",
      detail: "Open Relay settings to restore the v2 management service.",
      devices: [],
    };
  }

  if (state.connector.status === "registered") {
    const connectionCount = devices.reduce(
      (total, device) => total + device.connectionCount,
      0,
    );
    return {
      phase: "online",
      statusLabel: "Live",
      headline: devices.length === 0
        ? "Ready for a phone"
        : `${devices.length} mobile ${devices.length === 1 ? "device" : "devices"} online`,
      detail: devices.length === 0
        ? "Relay v2 is registered and ready to create a one-time pairing code."
        : `${connectionCount} live ${connectionCount === 1 ? "connection" : "connections"} through Relay v2.`,
      devices,
    };
  }

  if (state.connector.status === "starting") {
    return {
      phase: "connecting",
      statusLabel: "Connecting",
      headline: "Connecting the mobile link",
      detail: "The Relay v2 host carrier is starting.",
      devices: [],
    };
  }

  if (state.connector.status === "stopped") {
    return {
      phase: "offline",
      statusLabel: "Offline",
      headline: "Mobile link is stopped",
      detail: "Open Relay settings to reconnect or pair a phone.",
      devices: [],
    };
  }

  return {
    phase: "issue",
    statusLabel: "Needs attention",
    headline: state.connector.status === "registered_incomplete"
      ? "Relay capabilities are incomplete"
      : "Mobile link needs attention",
    detail: "Open Relay settings to repair the v2 connection.",
    devices: [],
  };
}

/**
 * Keeps the home screen's mobile summary live without retaining credential or
 * enrollment fields from the authoritative Relay v2 response.
 */
export function useRelayV2MissionControl(): RelayV2MissionControlSummary {
  const backend = useDashboardBackend();
  const [summary, setSummary] = useState<RelayV2MissionControlSummary>(LOADING_SUMMARY);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSummary(LOADING_SUMMARY);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [backend]);

  const refresh = useCallback(async () => {
    const request = new AbortController();
    requestRef.current = request;
    try {
      const state = await backend.relay.v2.status(request.signal);
      if (!request.signal.aborted && requestRef.current === request) {
        setSummary(projectRelayV2MissionControl(state));
      }
    } catch {
      if (!request.signal.aborted && requestRef.current === request) {
        setSummary({
          phase: "issue",
          statusLabel: "Unknown",
          headline: "Relay status unavailable",
          detail: "Open Relay settings to inspect the v2 connection.",
          devices: [],
        });
      }
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }, [backend]);

  useVisibilityAwarePolling(refresh, {
    visibleIntervalMs: VISIBLE_REFRESH_MS,
    hiddenIntervalMs: HIDDEN_REFRESH_MS,
    restartKey: backend,
  });

  return summary;
}
