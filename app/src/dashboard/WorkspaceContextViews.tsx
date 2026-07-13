import { DiffViewer } from "../DiffViewer";
import { FileTree } from "../FileTree";
import { GitStatusPanel } from "../GitStatusPanel";
import type {
  WorkspaceDiffContext,
  WorkspaceFilesContext,
  WorkspaceGitContext,
} from "./model/workspacePresentation";

export function WorkspaceFilesView({
  context,
  onFileSelect,
}: {
  context: WorkspaceFilesContext;
  onFileSelect(path: string, hostId: string | null): void;
}) {
  if (context.kind === "pending") {
    return (
      <div className="dashboard-context-empty" role="status">
        <strong>Loading workspace details…</strong>
        <span>Files will appear after the session and host are resolved.</span>
      </div>
    );
  }
  if (context.kind === "empty") {
    return (
      <div className="dashboard-context-empty">
        <strong>No files context</strong>
        <span>Select a worktree, terminal, or automation to browse its files.</span>
      </div>
    );
  }
  return (
    <div className="dashboard-inspector-view dashboard-inspector-view--files">
      <FileTree
        root={context.root}
        hostId={context.hostId}
        selectedFile={context.selectedFile}
        onFileSelect={onFileSelect}
      />
    </div>
  );
}

export function WorkspaceGitView({
  context,
  active,
  onFileClick,
  onBranchChange,
}: {
  context: WorkspaceGitContext;
  active: boolean;
  onFileClick(path: string, cwd: string, hostId?: string | null): void;
  onBranchChange(branch: string | null): void;
}) {
  if (context.kind === "pending") {
    return (
      <div className="dashboard-context-empty" role="status">
        <strong>Loading workspace details…</strong>
        <span>Git will connect after the session and host are resolved.</span>
      </div>
    );
  }
  return (
    <div className="dashboard-inspector-view dashboard-inspector-view--git">
      <GitStatusPanel
        cwd={context.cwd}
        sessionName={context.sessionName}
        hostId={context.hostId}
        active={active && context.available}
        onFileClick={onFileClick}
        onBranchChange={onBranchChange}
      />
    </div>
  );
}

export function WorkspaceDiffView({
  context,
  onClose,
}: {
  context: WorkspaceDiffContext;
  onClose(): void;
}) {
  if (context.kind === "pending") {
    return (
      <div className="dashboard-context-empty" role="status">
        <strong>Loading workspace details…</strong>
        <span>Diff will appear after the session and host are resolved.</span>
      </div>
    );
  }
  if (context.kind === "empty") {
    return (
      <div className="dashboard-context-empty">
        <strong>No diff selected</strong>
        <span>Select a changed file from the Git panel.</span>
      </div>
    );
  }
  return (
    <div className="dashboard-inspector-view dashboard-inspector-view--diff">
      <DiffViewer
        cwd={context.file.cwd}
        filePath={context.file.path}
        hostId={context.file.hostId ?? null}
        onClose={onClose}
      />
    </div>
  );
}
