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
