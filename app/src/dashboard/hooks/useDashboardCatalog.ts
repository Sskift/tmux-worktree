import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type HostConfig,
  type HostStatus,
  type ProjectPreset,
  useDashboardBackend,
} from "../../platform";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";

const HOST_STATUS_REFRESH_MS = 15_000;
const HOST_STATUS_HIDDEN_REFRESH_MS = 60_000;

export function useDashboardCatalog() {
  const dashboardBackend = useDashboardBackend();
  const [projectPresets, setProjectPresets] = useState<ProjectPreset[]>([]);
  const [hosts, setHosts] = useState<HostConfig[]>([]);
  const [sshHostCandidates, setSshHostCandidates] = useState<HostConfig[]>([]);
  const [hostStatuses, setHostStatuses] = useState<Record<string, HostStatus>>({});
  const [installingHostId, setInstallingHostId] = useState<string | null>(null);

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
    try {
      const [list, candidates] = await Promise.all([
        dashboardBackend.hosts.list(),
        dashboardBackend.hosts.candidates(),
      ]);
      setHosts(list);
      setSshHostCandidates(candidates);
    } catch {
      setHosts([]);
      setSshHostCandidates([]);
    }
  }, [dashboardBackend]);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

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
    } finally {
      setInstallingHostId(null);
    }
  }, [dashboardBackend]);

  const hostIdsKey = useMemo(() => hosts.map((host) => host.id).join("\0"), [hosts]);
  const refreshHostStatuses = useCallback(async () => {
    try {
      const statuses = await dashboardBackend.hosts.statuses();
      setHostStatuses(Object.fromEntries(statuses.map((status) => [status.id, status])));
    } catch {
      setHostStatuses({});
    }
  }, [dashboardBackend]);

  useEffect(() => {
    if (!hostIdsKey) setHostStatuses({});
  }, [hostIdsKey]);
  useVisibilityAwarePolling(refreshHostStatuses, {
    enabled: !!hostIdsKey,
    visibleIntervalMs: HOST_STATUS_REFRESH_MS,
    hiddenIntervalMs: HOST_STATUS_HIDDEN_REFRESH_MS,
    refreshKey: hostIdsKey,
  });

  return {
    projectPresets,
    loadProjectPresets,
    hosts,
    setHosts,
    sshHostCandidates,
    hostStatuses,
    installingHostId,
    installRemoteTw,
  };
}
