import {
  Columns2,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
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
  sidebarDrawer?: boolean;
  inspectorOpen: boolean;
  scratchOpen: boolean;
  canSplit?: boolean;
  onOpenSidebar?: () => void;
  onToggleInspector: () => void;
  onToggleScratch: () => void;
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
  sidebarDrawer = false,
  inspectorOpen,
  scratchOpen,
  canSplit = false,
  onOpenSidebar,
  onToggleInspector,
  onToggleScratch,
  onSplit,
  onOpenMore,
}: WorkspaceHeaderProps) {
  const metadata = [project, cwd, branch ? `branch: ${branch}` : null]
    .filter((value): value is string => Boolean(value?.trim()));

  return (
    <div className="workspace-header">
      <div className="workspace-header__identity">
        {sidebarDrawer && (
          <button
            className="workspace-header__icon-button workspace-header__sidebar-button"
            type="button"
            onClick={onOpenSidebar}
            aria-label="Open sidebar"
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
            <span>{hostLabel}</span>
          </span>
        )}
        {agentCommand && (
          <span className="workspace-header__chip" title={`Agent command: ${agentCommand}`}>
            <TerminalSquare aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{agentCommand}</span>
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
        <button
          className="workspace-header__action"
          type="button"
          onClick={onToggleInspector}
          aria-pressed={inspectorOpen}
          title={inspectorOpen ? "Close inspector" : "Open inspector"}
        >
          {inspectorOpen ? (
            <PanelRightClose aria-hidden="true" size={16} strokeWidth={1.7} />
          ) : (
            <PanelRightOpen aria-hidden="true" size={16} strokeWidth={1.7} />
          )}
          <span>Inspector</span>
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
  );
}
