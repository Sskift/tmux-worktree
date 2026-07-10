import {
  Columns2,
  GitBranch,
  MoreHorizontal,
  PanelLeftOpen,
  Server,
  TerminalSquare,
} from "lucide-react";
import type { WorkspaceStatus } from "./workspaceStatus";
import { workspaceStatusLabel } from "./workspaceStatus";
import "./WorkspaceHeader.css";

export type WorkspaceHeaderProps = {
  title: string;
  project?: string | null;
  branch?: string | null;
  cwd?: string | null;
  hostLabel?: string | null;
  agentCommand?: string | null;
  status: WorkspaceStatus;
  windowTitlebar?: boolean;
  sidebarDrawer?: boolean;
  scratchOpen: boolean;
  gitActive?: boolean;
  gitAvailable?: boolean;
  canSplit?: boolean;
  onOpenSidebar?: () => void;
  onToggleScratch: () => void;
  onOpenGit?: () => void;
  onSplit?: () => void;
  onOpenMore?: () => void;
};

export function WorkspaceHeader({
  title,
  project,
  branch,
  cwd,
  hostLabel,
  agentCommand,
  status,
  windowTitlebar = false,
  sidebarDrawer = false,
  scratchOpen,
  gitActive = false,
  gitAvailable = true,
  canSplit = false,
  onOpenSidebar,
  onToggleScratch,
  onOpenGit,
  onSplit,
  onOpenMore,
}: WorkspaceHeaderProps) {
  const metadata = [project, cwd, branch ? `branch: ${branch}` : null]
    .filter((value): value is string => Boolean(value?.trim()));

  return (
    <div
      className="workspace-header"
      data-window-titlebar={windowTitlebar ? true : undefined}
      data-tauri-drag-region={windowTitlebar ? true : undefined}
    >
      <div className="workspace-header__layout" data-tauri-drag-region={windowTitlebar ? true : undefined}>
        <div className="workspace-header__identity">
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

          <div className="workspace-header__title-block">
            <div className="workspace-header__title-line">
              <h1 title={title}>{title}</h1>
              <span
                className="workspace-header__status"
                data-status={status}
                aria-label={`Workspace status: ${workspaceStatusLabel(status)}`}
              >
                <span aria-hidden="true" />
                {workspaceStatusLabel(status)}
              </span>
            </div>
            <div className="workspace-header__metadata">
              {metadata.length > 0 ? (
                metadata.map((value, index) => (
                  <span key={`${value}-${index}`} title={value}>
                    {value}
                  </span>
                ))
              ) : (
                <span>No workspace path</span>
              )}
            </div>
          </div>
        </div>

        <div className="workspace-header__context" aria-label="Workspace context">
          {hostLabel && (
            <span className="workspace-header__chip" title={`Host: ${hostLabel}`}>
              <Server aria-hidden="true" size={14} strokeWidth={1.8} />
              <span className="workspace-header__chip-copy">{hostLabel}</span>
            </span>
          )}
          {agentCommand && (
            <span className="workspace-header__chip" title={`Agent command: ${agentCommand}`}>
              <TerminalSquare aria-hidden="true" size={14} strokeWidth={1.8} />
              <span className="workspace-header__chip-copy">{agentCommand}</span>
            </span>
          )}
        </div>

        <div className="workspace-header__actions">
          {canSplit && onSplit && (
            <button
              className="workspace-header__action"
              type="button"
              onClick={onSplit}
              title="Split terminal"
            >
              <Columns2 aria-hidden="true" size={16} strokeWidth={1.7} />
              <span>Split</span>
            </button>
          )}
          {onOpenGit && (
            <button
              className="workspace-header__action"
              type="button"
              onClick={onOpenGit}
              aria-pressed={gitActive}
              disabled={!gitAvailable}
              title={gitAvailable ? "Open Git inspector" : "Select a worktree or terminal to inspect Git"}
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
          {onOpenMore && (
            <button
              className="workspace-header__icon-button"
              type="button"
              onClick={onOpenMore}
              aria-label="More workspace actions"
              title="More workspace actions"
            >
              <MoreHorizontal aria-hidden="true" size={18} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
