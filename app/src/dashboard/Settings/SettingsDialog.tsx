import {
  Blocks,
  Bot,
  Cable,
  History,
  Palette,
  SlidersHorizontal,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import "../design/tokens.css";
import "./SettingsDialog.css";
import { keepFocusInside } from "./focusTrap";
import {
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
} from "./settingsModel";

export type SettingsContent = Partial<Record<SettingsSectionId, ReactNode>>;

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSectionId;
  content?: SettingsContent;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onSectionChange?: (section: SettingsSectionId) => void;
}

export interface SettingsSectionProps {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: "general",
    label: "General",
    description: "App behavior and shortcuts",
    icon: SlidersHorizontal,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Interface and terminal presentation",
    icon: Palette,
  },
  {
    id: "connections",
    label: "Connections",
    description: "Remote hosts and Relay",
    icon: Cable,
  },
  {
    id: "integrations",
    label: "Integrations",
    description: "Connected services",
    icon: Blocks,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Agent defaults and commands",
    icon: Bot,
  },
  {
    id: "history",
    label: "History & Privacy",
    description: "Local storage, export, and privacy",
    icon: History,
  },
  {
    id: "automation",
    label: "Automation",
    description: "Schedules and run behavior",
    icon: Workflow,
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Diagnostics and expert controls",
    icon: Wrench,
  },
] as const;

const DEFAULT_CONTENT: Record<SettingsSectionId, ReactNode> = {
  general: (
    <div className="settings-info-list">
      <div className="settings-info-row">
        <div>
          <strong>Command palette</strong>
          <span>Search sessions and run dashboard actions.</span>
        </div>
        <kbd>⌘ K</kbd>
      </div>
      <div className="settings-info-row">
        <div>
          <strong>Open settings</strong>
          <span>Return here from anywhere in the dashboard.</span>
        </div>
        <kbd>⌘ ,</kbd>
      </div>
    </div>
  ),
  appearance: (
    <SettingsNotice>
      Appearance controls are not available in this build. Terminal themes remain managed by the
      terminal theme picker.
    </SettingsNotice>
  ),
  connections: (
    <SettingsNotice>
      Connect the dashboard backend to manage remote hosts and Relay from this section.
    </SettingsNotice>
  ),
  integrations: <SettingsNotice>No external integrations are configured.</SettingsNotice>,
  agents: (
    <SettingsNotice>
      Agent defaults are currently selected when a terminal or worktree is created.
    </SettingsNotice>
  ),
  history: (
    <SettingsNotice>
      History controls will appear here when durable session history is available.
    </SettingsNotice>
  ),
  automation: (
    <SettingsNotice>
      Automation schedules are managed from the dashboard. Global automation controls are not yet
      available.
    </SettingsNotice>
  ),
  advanced: (
    <SettingsNotice tone="warning">
      No advanced controls are exposed in this build. This avoids presenting settings that are not
      backed by the local configuration.
    </SettingsNotice>
  ),
};

function SettingsNotice({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning";
}) {
  return (
    <div className={`settings-notice settings-notice--${tone}`}>
      <p>{children}</p>
    </div>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: SettingsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby={`${id}-heading`}>
      <header className="settings-section__header">
        <p className="settings-section__eyebrow">Settings</p>
        <h2 id={`${id}-heading`}>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="settings-section__content">{children}</div>
    </section>
  );
}

export function SettingsDialog({
  open,
  onClose,
  initialSection = "general",
  content,
  returnFocusRef,
  onSectionChange,
}: SettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const sectionButtonRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement>());
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (open) setActiveSection(initialSection);
  }, [initialSection, open]);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const animationFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(animationFrame);
      const focusTarget = returnFocusRef?.current ?? previousFocusRef.current;
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  const activeDefinition = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS[0];
  const activeContent = content?.[activeSection] ?? DEFAULT_CONTENT[activeSection];

  const selectSection = (section: SettingsSectionId) => {
    setActiveSection(section);
    onSectionChange?.(section);
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (dialogRef.current) keepFocusInside(event.nativeEvent, dialogRef.current);
  };

  const handleSectionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentSection: SettingsSectionId,
  ) => {
    const currentIndex = SETTINGS_SECTION_IDS.indexOf(currentSection);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % SETTINGS_SECTION_IDS.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + SETTINGS_SECTION_IDS.length) % SETTINGS_SECTION_IDS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_SECTION_IDS.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextSection = SETTINGS_SECTION_IDS[nextIndex];
    selectSection(nextSection);
    sectionButtonRefs.current.get(nextSection)?.focus();
  };

  return (
    <div
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-dialog__header">
          <div>
            <h1 id={titleId}>Settings</h1>
            <p id={descriptionId}>Manage dashboard preferences, connections, and tools.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="settings-dialog__close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X aria-hidden="true" size={18} strokeWidth={1.8} />
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav className="settings-dialog__sidebar" aria-label="Settings sections">
            <div className="settings-dialog__nav" role="tablist" aria-orientation="vertical">
              {SETTINGS_SECTIONS.map((section) => {
                const Icon = section.icon;
                const selected = section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    ref={(node) => {
                      if (node) sectionButtonRefs.current.set(section.id, node);
                      else sectionButtonRefs.current.delete(section.id);
                    }}
                    type="button"
                    id={`settings-tab-${section.id}`}
                    role="tab"
                    aria-selected={selected}
                    aria-controls="settings-active-panel"
                    tabIndex={selected ? 0 : -1}
                    className="settings-dialog__nav-item"
                    onClick={() => selectSection(section.id)}
                    onKeyDown={(event) => handleSectionKeyDown(event, section.id)}
                  >
                    <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                    <span>{section.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          <main
            className="settings-dialog__panel"
            id="settings-active-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeSection}`}
            tabIndex={0}
          >
            <SettingsSection
              id={`settings-section-${activeSection}`}
              title={activeDefinition.label}
              description={activeDefinition.description}
            >
              {activeContent}
            </SettingsSection>
          </main>
        </div>
      </div>
    </div>
  );
}

export { SETTINGS_SECTION_IDS, isSettingsSectionId, type SettingsSectionId } from "./settingsModel";
