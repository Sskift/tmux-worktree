import {
  ArrowRight,
  FolderGit2,
  Search,
  Server,
  SquareTerminal,
  Workflow,
  X,
} from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { FileEditor } from "../FileEditor";
import { TerminalDeck } from "./TerminalDeck";
import { WorkspaceDiffView } from "./WorkspaceContextViews";
import type {
  WorkspaceDiffContext,
  WorkspacePrimaryContext,
} from "./model/workspacePresentation";

export type WorkspaceHomeSummary = Readonly<{
  attentionAgents: number;
  activeAgents: number;
  onlineHosts: number;
  totalHosts: number;
  activeAutomations: number;
  sessions: ReadonlyArray<Readonly<{
    id: string;
    title: string;
    detail: string;
    state: "running" | "stopped" | "unknown";
    needsReview: boolean;
    status: string;
  }>>;
}>;

type WorkspaceHomeFilter = "attention" | "running" | "all";

function WorkspaceHome({
  summary,
  onCreateWorktree,
  onCreateTerminal,
  onOpenCommandPalette,
  onOpenConnections,
  onOpenAutomations,
  onSelectSession,
}: {
  summary: WorkspaceHomeSummary;
  onCreateWorktree(): void;
  onCreateTerminal(): void;
  onOpenCommandPalette(): void;
  onOpenConnections(): void;
  onOpenAutomations(): void;
  onSelectSession(sessionId: string): void;
}) {
  const [filter, setFilter] = useState<WorkspaceHomeFilter>("attention");
  const hostSummary = summary.totalHosts === 0
    ? "Local ready"
    : `${summary.onlineHosts}/${summary.totalHosts} remote ready`;
  const visibleSessions = summary.sessions.filter((session) => (
    filter === "attention"
      ? session.needsReview
      : filter === "running"
        ? session.state === "running"
        : true
  )).slice(0, 6);
  const emptyMessage = summary.sessions.length === 0
    ? "No agent worktrees yet. Create one to start a focused task."
    : filter === "attention"
      ? "No new output needs review."
      : filter === "running"
        ? "No agents are running right now."
        : "No recent agent activity.";

  return (
    <div className="workspace-home">
      <div className="workspace-home__intro">
        <span className="workspace-home__eyebrow">Dashboard</span>
        <h2>Start something new or pick up active work.</h2>
        <p>
          Keep agent worktrees, terminals, remote hosts, and automations in one place.
        </p>
        <div className="workspace-home__actions">
          <button
            className="workspace-home__primary-action"
            type="button"
            onClick={onCreateWorktree}
          >
            <FolderGit2 aria-hidden="true" size={16} strokeWidth={1.9} />
            <span>New worktree</span>
            <kbd aria-label="Command N">⌘N</kbd>
          </button>
          <button type="button" onClick={onCreateTerminal}>
            <SquareTerminal aria-hidden="true" size={16} strokeWidth={1.9} />
            <span>New terminal</span>
          </button>
          <button type="button" onClick={onOpenCommandPalette}>
            <Search aria-hidden="true" size={16} strokeWidth={1.9} />
            <span>Search</span>
            <kbd aria-label="Command K">⌘K</kbd>
          </button>
        </div>
      </div>

      <div className="workspace-home__metrics" aria-label="Dashboard overview">
        <div>
          <strong>{summary.attentionAgents}</strong>
          <span>need review</span>
        </div>
        <div>
          <strong>{summary.activeAgents}</strong>
          <span>agents running</span>
        </div>
        <div>
          <strong>{hostSummary}</strong>
          <span>connections</span>
        </div>
      </div>

      <div className="workspace-home__content">
        <section className="workspace-home__panel" aria-labelledby="workspace-home-inbox">
          <div className="workspace-home__panel-heading">
            <div>
              <span>Attention</span>
              <h3 id="workspace-home-inbox">Agent inbox</h3>
            </div>
            <span>
              {summary.attentionAgents > 0
                ? `${summary.attentionAgents} to review`
                : "All caught up"}
            </span>
          </div>
          <div className="workspace-home__filters" aria-label="Filter agent inbox">
            {([
              ["attention", "Review", summary.attentionAgents],
              ["running", "Running", summary.activeAgents],
              ["all", "All", summary.sessions.length],
            ] as const).map(([value, label, count]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                <span>{label}</span>
                <small>{count}</small>
              </button>
            ))}
          </div>
          {visibleSessions.length === 0 ? (
            <div className="workspace-home__empty-activity">
              <FolderGit2 aria-hidden="true" size={20} strokeWidth={1.6} />
              <p>{emptyMessage}</p>
            </div>
          ) : (
            <div className="workspace-home__session-list">
              {visibleSessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  data-attention={session.needsReview || undefined}
                  onClick={() => onSelectSession(session.id)}
                >
                  <span
                    className="workspace-home__activity-dot"
                    data-state={session.needsReview ? "attention" : session.state}
                    aria-hidden="true"
                  />
                  <span className="workspace-home__session-copy">
                    <strong>{session.title}</strong>
                    <span>{session.detail}</span>
                  </span>
                  <span className="workspace-home__session-status">{session.status}</span>
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="workspace-home__panel" aria-labelledby="workspace-home-tools">
          <div className="workspace-home__panel-heading">
            <div>
              <span>Manage</span>
              <h3 id="workspace-home-tools">Workspace tools</h3>
            </div>
          </div>
          <div className="workspace-home__tool-list">
            <button type="button" onClick={onOpenConnections}>
              <Server aria-hidden="true" size={16} strokeWidth={1.8} />
              <span>
                <strong>Connections</strong>
                <small>{hostSummary}</small>
              </span>
              <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
            <button type="button" onClick={onOpenAutomations}>
              <Workflow aria-hidden="true" size={16} strokeWidth={1.8} />
              <span>
                <strong>Automations</strong>
                <small>{summary.activeAutomations} enabled</small>
              </span>
              <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function WorkspacePrimaryView({
  context,
  diffContext,
  terminalDeckKey,
  terminalDeckProps,
  editorNavigationRevision,
  automationContent,
  homeSummary,
  onCloseEditor,
  onOpenFile,
  onEditorDirtyChange,
  onCloseDiff,
  onReturnFromAutomation,
  onCreateWorktree,
  onCreateTerminal,
  onOpenCommandPalette,
  onOpenConnections,
  onOpenAutomations,
  onSelectSession,
}: {
  context: WorkspacePrimaryContext;
  diffContext: WorkspaceDiffContext;
  terminalDeckKey: string;
  terminalDeckProps: ComponentProps<typeof TerminalDeck>;
  editorNavigationRevision: number;
  automationContent: ReactNode;
  homeSummary: WorkspaceHomeSummary;
  onCloseEditor(): void;
  onOpenFile(path: string, line?: number, col?: number, hostId?: string | null): void;
  onEditorDirtyChange(dirty: boolean): void;
  onCloseDiff(): void;
  onReturnFromAutomation(): void;
  onCreateWorktree(): void;
  onCreateTerminal(): void;
  onOpenCommandPalette(): void;
  onOpenConnections(): void;
  onOpenAutomations(): void;
  onSelectSession(sessionId: string): void;
}) {
  return (
    <section className="dashboard-workspace__primary" aria-label="Active workspace">
      <TerminalDeck key={terminalDeckKey} {...terminalDeckProps} />

      {context.kind === "editor" ? (
        <div className="dashboard-workspace__editor">
          <FileEditor
            filePath={context.file.path}
            hostId={context.file.hostId ?? null}
            initialLine={context.file.line}
            initialColumn={context.file.column}
            navigationRevision={editorNavigationRevision}
            onClose={onCloseEditor}
            onOpenFile={onOpenFile}
            onDirtyChange={onEditorDirtyChange}
          />
        </div>
      ) : context.kind === "diff" ? (
        <div className="dashboard-workspace__editor">
          <WorkspaceDiffView context={diffContext} onClose={onCloseDiff} />
        </div>
      ) : context.kind === "automation" ? (
        <div className="dashboard-workspace__expanded">
          <div className="dashboard-expanded-toolbar">
            <strong>Automations</strong>
            <button
              type="button"
              onClick={onReturnFromAutomation}
              aria-label="Back to workspace"
            >
              <X aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Back to workspace</span>
            </button>
          </div>
          <div className="dashboard-expanded-content dashboard-workspace__automation">
            {automationContent}
          </div>
        </div>
      ) : context.kind === "empty" ? (
        <div className="pane pane--empty">
          <WorkspaceHome
            summary={homeSummary}
            onCreateWorktree={onCreateWorktree}
            onCreateTerminal={onCreateTerminal}
            onOpenCommandPalette={onOpenCommandPalette}
            onOpenConnections={onOpenConnections}
            onOpenAutomations={onOpenAutomations}
            onSelectSession={onSelectSession}
          />
        </div>
      ) : null}
    </section>
  );
}
