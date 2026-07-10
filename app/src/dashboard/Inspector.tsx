import {
  Bot,
  FileCode2,
  Files,
  GitBranch,
  Maximize2,
  MessageSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  INSPECTOR_TABS,
  moveInspectorTab,
  type InspectorTab,
} from "./inspectorModel";
import "./Inspector.css";

type InspectorTabDefinition = {
  id: InspectorTab;
  label: string;
  icon: LucideIcon;
};

const TAB_DEFINITIONS: readonly InspectorTabDefinition[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "diff", label: "Diff", icon: FileCode2 },
  { id: "automation", label: "Automation", icon: Bot },
  { id: "feishu", label: "Feishu", icon: MessageSquare },
];

export type InspectorProps = {
  activeTab: InspectorTab;
  content: Partial<Record<InspectorTab, ReactNode>>;
  badges?: Partial<Record<InspectorTab, string | number | null>>;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  onExpand?: (tab: InspectorTab) => void;
};

export function Inspector({
  activeTab,
  content,
  badges,
  onTabChange,
  onClose,
  onExpand,
}: InspectorProps) {
  const tabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const activeDefinition = TAB_DEFINITIONS.find((tab) => tab.id === activeTab) ?? TAB_DEFINITIONS[0];

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: InspectorTab,
  ) => {
    let next: InspectorTab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = moveInspectorTab(current, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = moveInspectorTab(current, -1);
    } else if (event.key === "Home") {
      next = INSPECTOR_TABS[0];
    } else if (event.key === "End") {
      next = INSPECTOR_TABS[INSPECTOR_TABS.length - 1];
    }
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <section className="workspace-inspector" aria-label="Workspace inspector">
      <header className="workspace-inspector__header">
        <div className="workspace-inspector__title">
          <activeDefinition.icon aria-hidden="true" size={16} strokeWidth={1.8} />
          <span>{activeDefinition.label}</span>
        </div>
        <div className="workspace-inspector__actions">
          {onExpand && activeTab !== "feishu" && (
            <button
              type="button"
              onClick={() => onExpand(activeTab)}
              aria-label={`Expand ${activeDefinition.label} to workspace`}
              title={`Expand ${activeDefinition.label} to workspace`}
            >
              <Maximize2 aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close inspector" title="Close inspector">
            <X aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="workspace-inspector__tabs" role="tablist" aria-label="Inspector views">
        {TAB_DEFINITIONS.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === activeTab;
          const badge = badges?.[tab.id];
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              id={`inspector-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="inspector-active-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              title={tab.label}
            >
              <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
              <span>{tab.label}</span>
              {badge !== null && badge !== undefined && badge !== "" && (
                <span className="workspace-inspector__badge">{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      <div
        className="workspace-inspector__panel"
        id="inspector-active-panel"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${activeTab}`}
        tabIndex={0}
      >
        {content[activeTab] ?? (
          <div className="workspace-inspector__empty">
            <Files aria-hidden="true" size={24} strokeWidth={1.5} />
            <strong>No {activeDefinition.label.toLocaleLowerCase()} context</strong>
            <span>Select a worktree or terminal to inspect it.</span>
          </div>
        )}
      </div>
    </section>
  );
}
