import type { Automation } from "../../automationTypes";
import type {
  HostConfig,
  HostStatus,
  PlainTerminal,
  ProjectPreset,
  Session,
} from "../../platform";
import type { DiffFile, EditingFile } from "../layout/types";
import type { SessionActivityInfo } from "./sessionActivity";
import type { Selection } from "./selection";
import { basenameFromPath, sessionDisplayName } from "./terminalIdentity";
import type { WorkspaceStatus } from "./workspaceSelectors";

export type WorkspaceBranchSource =
  | Readonly<{
    kind: "inactive";
    key: string;
  }>
  | Readonly<{
    kind: "workspace";
    key: string;
    cwd: string;
    hostId: string | null;
    sessionName?: string;
  }>;

export type WorkspaceBranchValue = Readonly<{
  sourceKey: string;
  value: string | null;
}>;

export type WorkspacePrimaryContext =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "terminal" }>
  | Readonly<{ kind: "editor"; file: EditingFile }>
  | Readonly<{ kind: "diff"; file: DiffFile }>
  | Readonly<{ kind: "automation" }>
  | Readonly<{ kind: "empty" }>;

export type WorkspaceFilesContext =
  | Readonly<{ kind: "pending" }>
  | Readonly<{
    kind: "tree";
    root: string;
    hostId: string | null;
    selectedFile: string | null;
  }>
  | Readonly<{ kind: "empty" }>;

export type WorkspaceGitContext =
  | Readonly<{ kind: "pending" }>
  | Readonly<{
    kind: "workspace";
    cwd: string | null;
    hostId: string | null;
    sessionName?: string;
    available: boolean;
  }>;

export type WorkspaceDiffContext =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "viewer"; file: DiffFile }>
  | Readonly<{ kind: "empty" }>;

export type WorkspacePresentation = Readonly<{
  metadataPending: boolean;
  selectedAutomation: Automation | null;
  selectedAutomationProjectPath: string | null;
  selectedSessionIsRemote: boolean;
  selectedCwd: string | null;
  selectedGitHostId: string | null;
  selectedHostId: string | null;
  selectedHost: HostConfig | null;
  desktopRoot: string | null;
  fileBrowserRoot: string | null;
  terminalVisible: boolean;
  branchSource: WorkspaceBranchSource;
  header: Readonly<{
    title: string;
    project: string | null;
    branch: string | null;
    cwd: string | null;
    hostLabel: string | null;
    status: WorkspaceStatus;
    filesAvailable: boolean;
    gitAvailable: boolean;
  }>;
  primary: WorkspacePrimaryContext;
  files: WorkspaceFilesContext;
  git: WorkspaceGitContext;
  diff: WorkspaceDiffContext;
}>;

export type WorkspacePresentationInput = Readonly<{
  ownerReady: boolean;
  selection: Selection;
  selectionMetadataPending: boolean;
  selectedSession: Session | null;
  selectedTerminal: PlainTerminal | null;
  automations: Automation[];
  projectPresets: ProjectPreset[];
  hosts: HostConfig[];
  hostStatuses: Record<string, HostStatus>;
  sessionActivity: Record<string, SessionActivityInfo>;
  cwdsBySession: Record<string, string>;
  homeDirectory: string | null;
  workspaceBranch: WorkspaceBranchValue | null;
  editingFile: EditingFile | null;
  diffFile: DiffFile | null;
}>;

function selectionIdentity(selection: Selection): string {
  if (!selection) return "none";
  if (selection.kind === "session") return `session:${selection.name}`;
  if (selection.kind === "terminal") return `terminal:${selection.id}`;
  return `automation:${selection.id}`;
}

export function deriveWorkspacePresentation({
  ownerReady,
  selection,
  selectionMetadataPending,
  selectedSession,
  selectedTerminal,
  automations,
  projectPresets,
  hosts,
  hostStatuses,
  sessionActivity,
  cwdsBySession,
  homeDirectory,
  workspaceBranch,
  editingFile,
  diffFile,
}: WorkspacePresentationInput): WorkspacePresentation {
  const metadataPending = !ownerReady || selectionMetadataPending;
  const selectedAutomation = !metadataPending && selection?.kind === "automation"
    ? automations.find((automation) => automation.id === selection.id) ?? null
    : null;
  const selectedAutomationProjectPath = selectedAutomation?.project.trim()
    ? projectPresets.find(
      (project) => project.name === selectedAutomation.project,
    )?.path.trim() || null
    : null;
  const selectedGitHostId = metadataPending
    ? null
    : selection?.kind === "session"
      ? selectedSession?.hostId ?? null
      : selection?.kind === "terminal"
        ? selectedTerminal?.hostId ?? null
        : null;
  const selectedCwd = metadataPending
    ? null
    : selection?.kind === "session"
      ? cwdsBySession[selection.name] ?? null
      : selection?.kind === "terminal"
        ? selectedTerminal?.cwd ?? null
        : selection?.kind === "automation"
          ? selectedAutomation?.path || selectedAutomationProjectPath
          : null;
  const selectedHostId = metadataPending
    ? null
    : selectedSession?.hostId ?? selectedTerminal?.hostId ?? null;
  const selectedHost = selectedHostId
    ? hosts.find((host) => host.id === selectedHostId) ?? null
    : null;
  const selectedHostStatus = selectedHostId ? hostStatuses[selectedHostId] : null;
  const selectedActivity = !metadataPending && selection?.kind === "session"
    ? sessionActivity[selection.name]
    : null;
  const desktopRoot = ownerReady && homeDirectory
    ? `${homeDirectory.replace(/\/+$/, "")}/Desktop`
    : null;
  const fileBrowserRoot = metadataPending || !selection
    ? null
    : selection.kind === "automation"
      ? selectedCwd ?? desktopRoot
      : selectedGitHostId
        ? selectedCwd
        : selectedCwd ?? homeDirectory ?? "/";
  const gitAvailable = !metadataPending && (
    selection?.kind === "session" || selection?.kind === "terminal"
  );
  const branchSource: WorkspaceBranchSource = gitAvailable && selectedCwd
    ? {
      kind: "workspace",
      key: JSON.stringify([
        selectionIdentity(selection),
        selectedCwd,
        selectedGitHostId,
      ]),
      cwd: selectedCwd,
      hostId: selectedGitHostId,
      ...(selection?.kind === "session" ? { sessionName: selection.name } : {}),
    }
    : {
      kind: "inactive",
      key: JSON.stringify([
        metadataPending ? "pending" : selectionIdentity(selection),
        selectedCwd,
        selectedGitHostId,
      ]),
    };

  let status: WorkspaceStatus;
  if (metadataPending) status = "reconnecting";
  else if (selectedHostId && selectedHostStatus && !selectedHostStatus.reachable) {
    status = "offline";
  } else if (selectedHostId && !selectedHostStatus) status = "reconnecting";
  else if (selection?.kind === "automation") {
    if (selectedAutomation?.status === "running") status = "running";
    else if (selectedAutomation?.status === "queued") status = "waiting";
    else if (selectedAutomation?.status === "failed" || !selectedAutomation?.active) {
      status = "stopped";
    } else status = selectedAutomation ? "waiting" : "unknown";
  } else if (selection?.kind === "terminal") {
    status = selectedTerminal ? "running" : "unknown";
  } else if (selectedActivity?.state === "running") status = "running";
  else if (selectedActivity?.state === "stopped") status = "stopped";
  else if (selectedSession && !selectedCwd) status = "waiting";
  else status = selectedSession ? "unknown" : "stopped";

  const title = metadataPending
    ? selection?.kind === "session"
      ? selection.name
      : selection?.kind === "terminal"
        ? "Loading terminal…"
        : selection?.kind === "automation"
          ? "Loading workspace…"
          : "No workspace selected"
    : editingFile
        ? basenameFromPath(editingFile.path) || editingFile.path
        : diffFile
          ? basenameFromPath(diffFile.path) || diffFile.path
          : selectedSession
            ? sessionDisplayName(selectedSession)
            : selectedTerminal?.label
              ? selectedTerminal.label
              : selectedAutomation?.name || "No workspace selected";
  const project = metadataPending
    ? null
    : selectedSession?.project?.trim() ||
      selectedAutomation?.project?.trim() ||
      null;
  const branch = ownerReady && workspaceBranch?.sourceKey === branchSource.key
    ? workspaceBranch.value
    : null;
  const terminalVisible = metadataPending || (
    !editingFile &&
    !diffFile &&
    (selection?.kind === "session" || selection?.kind === "terminal")
  );
  const primary: WorkspacePrimaryContext = metadataPending
    ? { kind: "pending" }
    : editingFile
      ? { kind: "editor", file: editingFile }
      : diffFile
        ? { kind: "diff", file: diffFile }
        : selection?.kind === "automation"
          ? { kind: "automation" }
          : !selection
            ? { kind: "empty" }
            : { kind: "terminal" };
  const files: WorkspaceFilesContext = metadataPending
    ? { kind: "pending" }
    : fileBrowserRoot
      ? {
        kind: "tree",
        root: fileBrowserRoot,
        hostId: selectedGitHostId,
        selectedFile: (editingFile?.hostId ?? null) === selectedGitHostId
          ? editingFile?.path ?? null
          : null,
      }
      : { kind: "empty" };
  const git: WorkspaceGitContext = metadataPending
    ? { kind: "pending" }
    : {
      kind: "workspace",
      cwd: selectedCwd,
      hostId: selectedGitHostId,
      ...(selection?.kind === "session" ? { sessionName: selection.name } : {}),
      available: gitAvailable,
    };
  const diff: WorkspaceDiffContext = metadataPending
    ? { kind: "pending" }
    : diffFile
      ? { kind: "viewer", file: diffFile }
      : { kind: "empty" };

  return {
    metadataPending,
    selectedAutomation,
    selectedAutomationProjectPath,
    selectedSessionIsRemote: !metadataPending && !!selectedSession?.hostId,
    selectedCwd,
    selectedGitHostId,
    selectedHostId,
    selectedHost,
    desktopRoot,
    fileBrowserRoot,
    terminalVisible,
    branchSource,
    header: {
      title,
      project,
      branch,
      cwd: selectedCwd,
      hostLabel: selectedHost?.label ?? selectedHostId,
      status,
      filesAvailable: Boolean(fileBrowserRoot),
      gitAvailable,
    },
    primary,
    files,
    git,
    diff,
  };
}
