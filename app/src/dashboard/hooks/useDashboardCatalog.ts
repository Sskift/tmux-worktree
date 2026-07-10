import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type HostConfig,
  type HostStatus,
  type ProjectPreset,
  useDashboardBackend,
} from "../../platform";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";

const HOST_STATUS_REFRESH_MS = 15_000;
const HOST_STATUS_HIDDEN_REFRESH_MS = 60_000;
const HOST_CATALOG_RETRY_MS = 3_000;
const HOST_CATALOG_HIDDEN_RETRY_MS = 15_000;

export function useDashboardCatalog() {
  const dashboardBackend = useDashboardBackend();
  const [projectPresets, setProjectPresets] = useState<ProjectPreset[]>([]);
  const [hosts, setHostsState] = useState<HostConfig[]>([]);
  const [hostsHydrationGeneration, setHostsHydrationGeneration] = useState(0);
  const [hostsLoadError, setHostsLoadError] = useState<string | null>(null);
  const [sshHostCandidates, setSshHostCandidates] = useState<HostConfig[]>([]);
  const [hostStatuses, setHostStatuses] = useState<Record<string, HostStatus>>({});
  const [installingHostId, setInstallingHostId] = useState<string | null>(null);
  const hostCatalogRequestRef = useRef(0);
  const hostStatusRequestRef = useRef(0);

  const loadProjectPresets = useCallback(async () => {
    try {
      const list = await dashboardBackend.projects.list();
      setProjectPresets(list);
    } catch {
      setProjectPresets([]);
    }
  }, [dashboardBackend]);

  useEffect(() => {
    void loadProjectPresets();
  }, [loadProjectPresets]);

  const loadHosts = useCallback(async () => {
    const request = ++hostCatalogRequestRef.current;
    try {
      const list = await dashboardBackend.hosts.list();
      if (request !== hostCatalogRequestRef.current) return;
      setHostsState(list);
      setHostsLoadError(null);
      setHostsHydrationGeneration((generation) => generation + 1);

      void dashboardBackend.hosts.candidates()
        .then((candidates) => {
          if (request === hostCatalogRequestRef.current) {
            setSshHostCandidates(candidates);
          }
        })
        .catch(() => {
          if (request === hostCatalogRequestRef.current) {
            setSshHostCandidates([]);
          }
        });
    } catch (nextError) {
      if (request !== hostCatalogRequestRef.current) return;
      setHostsLoadError(`Host catalog unavailable: ${String(nextError)}. Retrying automatically.`);
      // Keep the last authoritative catalog and retry. Advancing hydration on
      // failure could incorrectly discard a restored remote selection.
    }
  }, [dashboardBackend]);

  useVisibilityAwarePolling(loadHosts, {
    enabled: hostsHydrationGeneration === 0,
    visibleIntervalMs: HOST_CATALOG_RETRY_MS,
    hiddenIntervalMs: HOST_CATALOG_HIDDEN_RETRY_MS,
  });

  const setHosts = useCallback((nextHosts: HostConfig[]) => {
    hostCatalogRequestRef.current += 1;
    setHostsState(nextHosts);
    setHostsLoadError(null);
    setHostsHydrationGeneration((generation) => generation + 1);
  }, []);

  const installRemoteTw = useCallback(async (hostId: string) => {
    setInstallingHostId(hostId);
    try {
      const status = await dashboardBackend.hosts.installTw(hostId);
      setHostStatuses((prev) => ({ ...prev, [status.id]: status }));
    } catch (err) {
      setHostStatuses((prev) => {
        const current = prev[hostId];
        if (!current) return prev;
        return {
          ...prev,
          [hostId]: {
            ...current,
            twAvailable: false,
            twError: String(err),
          },
        };
      });
      throw err;
    } finally {
      setInstallingHostId(null);
    }
  }, [dashboardBackend]);

  const hostStatusRefreshKey = useMemo(() => JSON.stringify(hosts.map((host) => [
    host.id,
    host.host,
    host.user ?? null,
    host.port ?? null,
    host.identityFile ?? null,
    host.tmuxPath ?? null,
    host.twPath ?? null,
  ])), [hosts]);
  const refreshHostStatuses = useCallback(async () => {
    const request = ++hostStatusRequestRef.current;
    try {
      const statuses = await dashboardBackend.hosts.statuses();
      if (request !== hostStatusRequestRef.current) return;
      setHostStatuses(Object.fromEntries(statuses.map((status) => [status.id, status])));
    } catch {
      if (request !== hostStatusRequestRef.current) return;
      setHostStatuses({});
    }
  }, [dashboardBackend]);

  useEffect(() => {
    hostStatusRequestRef.current += 1;
    setHostStatuses({});
  }, [hostStatusRefreshKey]);
  useVisibilityAwarePolling(refreshHostStatuses, {
    enabled: hosts.length > 0,
    visibleIntervalMs: HOST_STATUS_REFRESH_MS,
    hiddenIntervalMs: HOST_STATUS_HIDDEN_REFRESH_MS,
    refreshKey: hostStatusRefreshKey,
  });

  return {
    projectPresets,
    loadProjectPresets,
    hosts,
    hostsHydrationGeneration,
    hostsLoadError,
    setHosts,
    sshHostCandidates,
    hostStatuses,
    installingHostId,
    installRemoteTw,
  };
}
