import { Files, GitBranch, PanelLeftOpen, TerminalSquare } from "lucide-react";
import productIcon from "../../src-tauri/icons/128x128.png";
import type { WorkspaceStatus } from "./model/workspaceSelectors";
import { workspaceStatusLabel } from "./model/workspaceSelectors";
import "./WorkspaceHeader.css";

export type WorkspaceHeaderProps = {
  title: string;
  project?: string | null;
  branch?: string | null;
  cwd?: string | null;
  hostLabel?: string | null;
  status: WorkspaceStatus;
  windowTitlebar?: boolean;
  sidebarDrawer?: boolean;
  scratchOpen: boolean;
  filesActive?: boolean;
  filesAvailable?: boolean;
  gitActive?: boolean;
  gitAvailable?: boolean;
  onOpenSidebar?: () => void;
  onOpenFiles?: () => void;
  onToggleScratch: () => void;
  onOpenGit?: () => void;
};

export function WorkspaceHeader({
  title,
  project,
  branch,
  cwd,
  hostLabel,
  status,
  windowTitlebar = false,
  sidebarDrawer = false,
  scratchOpen,
  filesActive = false,
  filesAvailable = true,
  gitActive = false,
  gitAvailable = true,
  onOpenSidebar,
  onOpenFiles,
  onToggleScratch,
  onOpenGit,
}: WorkspaceHeaderProps) {
  const contextTitle = [
    title,
    project,
    cwd,
    branch ? `Branch: ${branch}` : null,
    hostLabel ? `Host: ${hostLabel}` : null,
  ].filter((value): value is string => Boolean(value?.trim()));

  return (
    <div
      className="workspace-header"
      data-window-titlebar={windowTitlebar ? true : undefined}
      data-tauri-drag-region={windowTitlebar ? true : undefined}
    >
      <div
        className="workspace-header__layout"
        data-tauri-drag-region={windowTitlebar ? true : undefined}
      >
        <div
          className="workspace-header__brand-area"
          data-tauri-drag-region={windowTitlebar ? true : undefined}
        >
          {sidebarDrawer && (
            <button
              className="workspace-header__icon-button workspace-header__sidebar-button"
              type="button"
              onClick={onOpenSidebar}
              aria-label="Open sidebar"
              aria-controls="dashboard-sidebar"
              aria-haspopup="dialog"
              title="Open sidebar"
            >
              <PanelLeftOpen aria-hidden="true" size={17} strokeWidth={1.7} />
            </button>
          )}
          <div className="workspace-header__brand" aria-label="tmux-worktree">
            <img src={productIcon} alt="" draggable={false} />
            <span>tmux-worktree</span>
          </div>
        </div>

        <div
          className="workspace-header__context"
          aria-label="Current workspace"
          title={contextTitle.join(" · ")}
          data-tauri-drag-region={windowTitlebar ? true : undefined}
        >
          <span
            className="workspace-header__status-dot"
            data-status={status}
            aria-hidden="true"
          />
          <h1>{title}</h1>
          <span className="workspace-header__status-label">
            {workspaceStatusLabel(status)}
          </span>
          {branch && <span className="workspace-header__detail">{branch}</span>}
          {hostLabel && (
            <span className="workspace-header__detail workspace-header__host">
              {hostLabel}
            </span>
          )}
        </div>

        <div className="workspace-header__actions">
          {onOpenFiles && (
            <button
              className="workspace-header__action"
              type="button"
              onClick={onOpenFiles}
              aria-pressed={filesActive}
              disabled={!filesAvailable}
              title={filesAvailable ? "Open file explorer" : "Select a workspace to browse files"}
            >
              <Files aria-hidden="true" size={16} strokeWidth={1.7} />
              <span>Files</span>
            </button>
          )}
          {onOpenGit && (
            <button
              className="workspace-header__action"
              type="button"
              onClick={onOpenGit}
              aria-pressed={gitActive}
              disabled={!gitAvailable}
              title={gitAvailable ? "Open Git panel" : "Select a worktree or terminal to inspect Git"}
            >
              <GitBranch aria-hidden="true" size={16} strokeWidth={1.7} />
              <span>Git</span>
            </button>
          )}
          <button
            className="workspace-header__action"
            type="button"
            onClick={onToggleScratch}
            aria-pressed={scratchOpen}
            title={scratchOpen ? "Close scratch terminal" : "Open scratch terminal"}
          >
            <TerminalSquare aria-hidden="true" size={16} strokeWidth={1.7} />
            <span>Scratch</span>
          </button>
        </div>
      </div>
    </div>
  );
}
