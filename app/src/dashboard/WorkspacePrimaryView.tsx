import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { FileEditor } from "../FileEditor";
import { TerminalDeck } from "./TerminalDeck";
import { WorkspaceDiffView } from "./WorkspaceContextViews";
import type {
  WorkspaceDiffContext,
  WorkspacePrimaryContext,
} from "./model/workspacePresentation";

export function WorkspacePrimaryView({
  context,
  diffContext,
  terminalDeckKey,
  terminalDeckProps,
  editorNavigationRevision,
  automationContent,
  onCloseEditor,
  onOpenFile,
  onEditorDirtyChange,
  onCloseDiff,
  onReturnFromAutomation,
}: {
  context: WorkspacePrimaryContext;
  diffContext: WorkspaceDiffContext;
  terminalDeckKey: string;
  terminalDeckProps: ComponentProps<typeof TerminalDeck>;
  editorNavigationRevision: number;
  automationContent: ReactNode;
  onCloseEditor(): void;
  onOpenFile(path: string, line?: number, col?: number, hostId?: string | null): void;
  onEditorDirtyChange(dirty: boolean): void;
  onCloseDiff(): void;
  onReturnFromAutomation(): void;
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
          <div className="pane__hint">
            Select a worktree, terminal, or automation.
          </div>
        </div>
      ) : null}
    </section>
  );
}
