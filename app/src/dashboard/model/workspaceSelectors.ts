import type { HostConfig, HostStatus, Session } from "../../platform";
import type { SessionActivityInfo, SessionActivityState } from "./sessionActivity";

export type SidebarSessionGroup = {
  key: string;
  hostId: string | null;
  hostLabel: string;
  project: string;
  sessions: Session[];
};

export type SidebarConnectionTone = "neutral" | "success" | "warning" | "danger";

export type SidebarConnectionSummary = {
  label: string;
  detail: string;
  tone: SidebarConnectionTone;
  readyCount: number;
  checkingCount: number;
  offlineCount: number;
  twMissingHosts: HostConfig[];
};

export type SidebarActivityDescription = {
  state: SessionActivityState;
  label: string;
  title: string;
};

function sidebarSessionDisplayName(session: Session): string {
  return session.rawName?.trim() || session.name;
}

function sessionProjectName(session: Session): string {
  const explicitProject = session.project?.trim();
  if (explicitProject) return explicitProject;

  const displayName = sidebarSessionDisplayName(session);
  const separatorIndex = displayName.indexOf("-");
  return separatorIndex > 0 ? displayName.slice(0, separatorIndex) : displayName || "Unassigned";
}

export function sidebarSessionGroupKey(session: Session): string {
  const project = sessionProjectName(session);
  return session.hostId ? `ssh:${session.hostId}:${project}` : `local:${project}`;
}

export function orderSessionsByName(
  sessions: readonly Session[],
  order: readonly string[],
): Session[] {
  const orderMap = new Map<string, number>();
  for (const name of order) {
    if (!orderMap.has(name)) orderMap.set(name, orderMap.size);
  }
  return [...sessions].sort((left, right) =>
    (orderMap.get(left.name) ?? Number.POSITIVE_INFINITY) -
    (orderMap.get(right.name) ?? Number.POSITIVE_INFINITY),
  );
}

export function canReorderSessionsWithinGroup(
  sessions: readonly Session[],
  fromIndex: number,
  toIndex: number,
): boolean {
  const source = sessions[fromIndex];
  const target = sessions[toIndex];
  return !!source && !!target && sidebarSessionGroupKey(source) === sidebarSessionGroupKey(target);
}

/**
 * Keep the legacy group keys so persisted collapse state survives the shell
 * redesign while the visible label becomes an explicit Host / Project pair.
 */
export function groupSessionsByHostProject(
  sessions: readonly Session[],
  hosts: readonly HostConfig[],
): SidebarSessionGroup[] {
  const groups: SidebarSessionGroup[] = [];
  const groupsByKey = new Map<string, SidebarSessionGroup>();
  const hostLabels = new Map(hosts.map((host) => [host.id, host.label || host.id]));

  for (const session of sessions) {
    const project = sessionProjectName(session);
    const hostId = session.hostId || null;
    const key = sidebarSessionGroupKey(session);
    let group = groupsByKey.get(key);

    if (!group) {
      group = {
        key,
        hostId,
        hostLabel: hostId ? hostLabels.get(hostId) ?? hostId : "Local",
        project,
        sessions: [],
      };
      groupsByKey.set(key, group);
      groups.push(group);
    }

    group.sessions.push(session);
  }

  return groups;
}

export function orderSidebarSessionGroups(
  groups: readonly SidebarSessionGroup[],
  order: readonly string[],
): SidebarSessionGroup[] {
  const orderMap = new Map<string, number>();
  for (const key of order) {
    if (!orderMap.has(key)) orderMap.set(key, orderMap.size);
  }
  return [...groups].sort((left, right) =>
    (orderMap.get(left.key) ?? Number.POSITIVE_INFINITY) -
    (orderMap.get(right.key) ?? Number.POSITIVE_INFINITY),
  );
}

export function summarizeSidebarConnections(
  hosts: readonly HostConfig[],
  hostStatuses: Readonly<Record<string, HostStatus | undefined>>,
): SidebarConnectionSummary {
  if (hosts.length === 0) {
    return {
      label: "No hosts configured",
      detail: "Open Connections in Settings",
      tone: "neutral",
      readyCount: 0,
      checkingCount: 0,
      offlineCount: 0,
      twMissingHosts: [],
    };
  }

  let readyCount = 0;
  let checkingCount = 0;
  let offlineCount = 0;
  const twMissingHosts: HostConfig[] = [];

  for (const host of hosts) {
    const status = hostStatuses[host.id];
    if (!status) {
      checkingCount += 1;
    } else if (!status.reachable) {
      offlineCount += 1;
    } else if (status.tmuxAvailable === false || !status.twAvailable || status.twCompatible === false) {
      twMissingHosts.push(host);
    } else {
      readyCount += 1;
    }
  }

  const detailParts: string[] = [];
  if (checkingCount > 0) detailParts.push(`${checkingCount} checking`);
  if (offlineCount > 0) detailParts.push(`${offlineCount} offline`);
  if (twMissingHosts.length > 0) detailParts.push(`${twMissingHosts.length} needs tw`);

  const tone: SidebarConnectionTone =
    readyCount === hosts.length
      ? "success"
      : offlineCount > 0
        ? "danger"
        : checkingCount > 0 || twMissingHosts.length > 0
          ? "warning"
          : "neutral";

  return {
    label: `${readyCount}/${hosts.length} hosts ready`,
    detail: detailParts.length > 0 ? detailParts.join(" · ") : "All hosts connected",
    tone,
    readyCount,
    checkingCount,
    offlineCount,
    twMissingHosts,
  };
}

export function describeSidebarActivity(
  activity: SessionActivityInfo | undefined,
  attached: boolean,
): SidebarActivityDescription {
  if (activity?.state === "running") {
    return {
      state: "running",
      label: "Running",
      title: "Agent activity is running",
    };
  }

  if (activity?.state === "stopped") {
    const hasAge = activity.ageSeconds != null && activity.label !== "stopped";
    return {
      state: "stopped",
      label: hasAge ? `Stopped · ${activity.label}` : "Stopped",
      title: hasAge ? `Agent activity stopped ${activity.label} ago` : "Agent activity is stopped",
    };
  }

  return {
    state: "unknown",
    label: attached ? "Attached · status unknown" : "Status unknown",
    title: attached ? "Session is attached; agent activity is unknown" : "Agent activity is unknown",
  };
}

export type WorkspaceStatus =
  | "running"
  | "waiting"
  | "stopped"
  | "unknown"
  | "offline"
  | "reconnecting";

export const WORKSPACE_STATUS_LABELS: Record<WorkspaceStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  stopped: "Stopped",
  unknown: "Unknown",
  offline: "SSH offline",
  reconnecting: "Reconnecting",
};

export function workspaceStatusLabel(status: WorkspaceStatus): string {
  return WORKSPACE_STATUS_LABELS[status];
}

export function projectKey(name: string): string {
  const index = name.indexOf("-");
  return index > 0 ? name.slice(0, index) : name;
}
