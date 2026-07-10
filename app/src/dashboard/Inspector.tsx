import { GitBranch, X } from "lucide-react";
import type { ReactNode } from "react";
import "./Inspector.css";

export type InspectorProps = {
  content: ReactNode;
  onClose: () => void;
};

export function Inspector({ content, onClose }: InspectorProps) {
  return (
    <section className="workspace-inspector" aria-label="Git">
      <header className="workspace-inspector__header">
        <div className="workspace-inspector__title">
          <GitBranch aria-hidden="true" size={16} strokeWidth={1.8} />
          <span>Git</span>
        </div>
        <button
          className="workspace-inspector__close"
          type="button"
          onClick={onClose}
          aria-label="Close Git panel"
          title="Close Git panel"
        >
          <X aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
      </header>

      <div className="workspace-inspector__panel">{content}</div>
    </section>
  );
}
