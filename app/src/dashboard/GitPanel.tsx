import { GitBranch, X } from "lucide-react";
import type { ReactNode } from "react";
import "./GitPanel.css";

export type GitPanelProps = {
  content: ReactNode;
  onClose: () => void;
};

export function GitPanel({ content, onClose }: GitPanelProps) {
  return (
    <section className="workspace-git-panel" aria-label="Git">
      <header className="workspace-git-panel__header">
        <div className="workspace-git-panel__title">
          <GitBranch aria-hidden="true" size={16} strokeWidth={1.8} />
          <span>Git</span>
        </div>
        <button
          className="workspace-git-panel__close"
          type="button"
          onClick={onClose}
          aria-label="Close Git panel"
          title="Close Git panel"
        >
          <X aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
      </header>

      <div className="workspace-git-panel__panel">{content}</div>
    </section>
  );
}
