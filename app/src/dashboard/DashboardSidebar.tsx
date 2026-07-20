import {
  ChevronRight,
  Circle,
  Download,
  Files,
  FolderGit2,
  GripVertical,
  LayoutDashboard,
  Laptop,
  LoaderCircle,
  Pin,
  Plus,
  Search,
  Server,
  Settings,
  SquareTerminal,
  Workflow,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { triggerLabel, type Automation } from "../automationTypes";
import type { HostConfig, HostStatus, PlainTerminal, Session } from "../platform";
import type { SessionActivityInfo } from "./model/sessionActivity";
import type { PinnedItem, Selection } from "./model/selection";
import { terminalSessionKey } from "./model/terminalIdentity";
import type { SidebarView } from "./layout/types";
import {
  describeSidebarActivity,
  canReorderSessionsWithinGroup,
  groupSessionsByHostProject,
  orderSidebarSessionGroups,
  orderSessionsByName,
  sidebarSessionGroupKey,
  summarizeSidebarConnections,
} from "./model/workspaceSelectors";
import { useSortable } from "./hooks/useSortable";
import "./DashboardSidebar.css";

export {
  describeSidebarActivity,
  groupSessionsByHostProject,
  summarizeSidebarConnections,
} from "./model/workspaceSelectors";
export type {
  SidebarActivityDescription,
  SidebarConnectionSummary,
  SidebarConnectionTone,
  SidebarSessionGroup,
} from "./model/workspaceSelectors";

export type { SidebarView } from "./layout/types";

export type DashboardSidebarProps = {
  sessions: readonly Session[];
  terminals: readonly PlainTerminal[];
  automations: readonly Automation[];
  hosts: readonly HostConfig[];
  hostStatuses: Readonly<Record<string, HostStatus | undefined>>;
  hostsError?: string | null;
  mobileRelay?: {
    statusKnown: boolean;
    active: boolean;
    connected: boolean;
    statusText: string;
    error?: string | null;
  };
  localRuntimeState?: "checking" | "ready" | "error";
  selection: Selection;
  sessionActivity: Readonly<Record<string, SessionActivityInfo | undefined>>;
  sessionOrder: readonly string[];
  worktreeGroupOrder: readonly string[];
  collapsedProjects: readonly string[];
  pinnedItems: readonly PinnedItem[];
  automationSectionCollapsed: boolean;
  installingHostId?: string | null;
  sessionsError?: string | null;
  terminalsError?: string | null;
  automationsError?: string | null;
  className?: string;
  settingsButtonRef?: Ref<HTMLButtonElement>;
  activeView: SidebarView;
  filesContent: ReactNode;
  onViewChange: (view: SidebarView) => void;
  onCreateWorktree: () => void;
  onCreateTerminal: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onToggleProjectCollapsed: (groupKey: string) => void;
  onTogglePinned: (item: PinnedItem) => void;
  onToggleAutomationSection: () => void;
  onManageAutomations: () => void;
  onSelectSession: (sessionName: string) => void;
  onReorderSessions: (sessions: Session[]) => void;
  onReorderWorktreeGroups: (groupKeys: string[]) => void;
  onCloseSession: (sessionName: string) => void | Promise<void>;
  onSelectTerminal: (terminalId: string) => void;
  onReorderTerminals: (terminals: PlainTerminal[]) => void;
  onRenameTerminal: (terminalId: string, label: string) => void | Promise<void>;
  onCloseTerminal: (terminalId: string) => void | Promise<void>;
  onSelectAutomation: (automationId: string) => void;
  onInstallTw: (hostId: string) => void | Promise<void>;
};

function sidebarSessionDisplayName(session: Session): string {
  return session.rawName?.trim() || session.name;
}

function automationStatus(automation: Automation): string {
  if (!automation.active) return "Paused";
  if (!automation.status || automation.status === "idle") return "Active";
  return automation.status.charAt(0).toUpperCase() + automation.status.slice(1);
}

function terminalDescription(terminal: PlainTerminal, hostsById: ReadonlyMap<string, HostConfig>): string {
  const host = terminal.hostId ? hostsById.get(terminal.hostId) : null;
  const location = host?.label || terminal.hostId || "Local";
  const command = terminal.aiCmd?.trim();
  if (command) return `${command} · ${location}`;
  if (terminal.cwd) return `${location} · ${terminal.cwd}`;
  return location;
}

function sortableDropPosition(
  dragIndex: number | null,
  overIndex: number | null,
  index: number,
): "before" | "after" | undefined {
  if (dragIndex === null || overIndex !== index || dragIndex === index) return undefined;
  return dragIndex > index ? "before" : "after";
}

type SidebarPinnedRow =
  | { kind: "session"; item: Extract<PinnedItem, { kind: "session" }>; session: Session }
  | { kind: "terminal"; item: Extract<PinnedItem, { kind: "terminal" }>; terminal: PlainTerminal };

function SidebarSectionHeading({
  headingId,
  icon: Icon,
  label,
  actionLabel,
  onAction,
}: {
  headingId: string;
  icon: typeof Pin;
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="tw-sidebar-section__heading">
      <Icon aria-hidden="true" size={13} strokeWidth={1.8} />
      <h2 id={headingId}>{label}</h2>
      {actionLabel && onAction && (
        <button
          className="tw-sidebar__icon-button"
          type="button"
          onClick={onAction}
          aria-label={actionLabel}
          title={actionLabel}
        >
          <Plus aria-hidden="true" size={15} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

export function DashboardSidebar({
  sessions,
  terminals,
  automations,
  hosts,
  hostStatuses,
  hostsError,
  mobileRelay,
  localRuntimeState = "checking",
  selection,
  sessionActivity,
  sessionOrder,
  worktreeGroupOrder,
  collapsedProjects,
  pinnedItems,
  automationSectionCollapsed,
  installingHostId = null,
  sessionsError,
  terminalsError,
  automationsError,
  className,
  settingsButtonRef,
  activeView,
  filesContent,
  onViewChange,
  onCreateWorktree,
  onCreateTerminal,
  onOpenCommandPalette,
  onOpenSettings,
  onToggleProjectCollapsed,
  onTogglePinned,
  onToggleAutomationSection,
  onManageAutomations,
  onSelectSession,
  onReorderSessions,
  onReorderWorktreeGroups,
  onCloseSession,
  onSelectTerminal,
  onReorderTerminals,
  onRenameTerminal,
  onCloseTerminal,
  onSelectAutomation,
  onInstallTw,
}: DashboardSidebarProps) {
  const sortInstructionsId = useId();
  const sortDragLeaseRef = useRef<object | null>(null);
  const [sortAnnouncement, setSortAnnouncement] = useState("");
  const orderedSessions = useMemo(
    () => orderSessionsByName(sessions, sessionOrder),
    [sessionOrder, sessions],
  );
  const unorderedGroups = useMemo(
    () => groupSessionsByHostProject(orderedSessions, hosts),
    [hosts, orderedSessions],
  );
  const groups = useMemo(
    () => orderSidebarSessionGroups(unorderedGroups, worktreeGroupOrder),
    [unorderedGroups, worktreeGroupOrder],
  );
  const sidebarSessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );
  const sessionIndexByName = useMemo(
    () => new Map(sidebarSessions.map((session, index) => [session.name, index])),
    [sidebarSessions],
  );
  const groupSortable = useSortable(
    groups,
    (reordered) => onReorderWorktreeGroups(reordered.map((group) => group.key)),
    {
      dragLease: sortDragLeaseRef,
      itemSelector: ".tw-sidebar-group[data-group-sort-item][data-sort-key]",
      keyOf: (group) => group.key,
      onMove: (move) => {
        setSortAnnouncement(
          `${move.item.hostLabel} / ${move.item.project} moved to group position ${move.toIndex + 1} of ${move.items.length}.`,
        );
      },
    },
  );
  const sessionSortable = useSortable(
    sidebarSessions,
    onReorderSessions,
    {
      dragLease: sortDragLeaseRef,
      itemSelector: ".tw-sidebar-row[data-session-sort-item][data-sort-key]",
      keyOf: (session) => session.name,
      canMove: (fromIndex, toIndex) =>
        canReorderSessionsWithinGroup(sidebarSessions, fromIndex, toIndex),
      onMove: (move) => {
        const groupKey = sidebarSessionGroupKey(move.item);
        const groupItems = move.items.filter(
          (session) => sidebarSessionGroupKey(session) === groupKey,
        );
        const position = groupItems.findIndex((session) => session.name === move.item.name) + 1;
        setSortAnnouncement(
          `${sidebarSessionDisplayName(move.item)} moved to position ${position} of ${groupItems.length} in its worktree group.`,
        );
      },
    },
  );
  const terminalSortable = useSortable(
    terminals,
    onReorderTerminals,
    {
      dragLease: sortDragLeaseRef,
      itemSelector: ".tw-sidebar-row[data-terminal-sort-item][data-sort-key]",
      keyOf: terminalSessionKey,
      onMove: (move) => {
        setSortAnnouncement(
          `${move.item.label} moved to terminal position ${move.toIndex + 1} of ${move.items.length}.`,
        );
      },
    },
  );
  const hostsById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );
  const collapsed = useMemo(() => new Set(collapsedProjects), [collapsedProjects]);
  const connections = useMemo(
    () => summarizeSidebarConnections(hosts, hostStatuses),
    [hostStatuses, hosts],
  );
  const installHost = connections.twMissingHosts[0] ?? null;
  const hostsLabel = hostsError ? "Hosts unavailable" : connections.label;
  const hostsDetail = hostsError ?? connections.detail;
  const localRuntimeLabel = localRuntimeState === "ready"
    ? "Local ready"
    : localRuntimeState === "error"
      ? "Local unavailable"
      : "Local checking";
  const relayState = !mobileRelay
    ? "unknown"
    : mobileRelay.error
      ? "error"
      : !mobileRelay.statusKnown
        ? "unknown"
        : mobileRelay.connected
          ? "connected"
          : mobileRelay.active
            ? "starting"
            : "stopped";
  const relayLabel = relayState === "unknown"
    ? "Checking"
    : relayState === "error"
      ? "Error"
      : mobileRelay?.statusText ?? "Unknown";
  const footerTone = localRuntimeState === "error" || relayState === "error" || hostsError
    ? "danger"
    : localRuntimeState === "checking" || relayState === "unknown"
      ? "warning"
      : connections.tone;
  const rootClassName = ["tw-dashboard-sidebar", className].filter(Boolean).join(" ");
  const pinnedRows: SidebarPinnedRow[] = pinnedItems.flatMap<SidebarPinnedRow>((item) => {
    if (item.kind === "session") {
      const session = sessions.find((candidate) => candidate.name === item.name);
      return session ? [{ kind: "session", item, session }] : [];
    }
    const terminal = terminals.find((candidate) => candidate.id === item.id);
    return terminal ? [{ kind: "terminal", item, terminal }] : [];
  });
  const viewTabRefs = useRef(new Map<SidebarView, HTMLButtonElement>());
  const renameCommitSuppressedRef = useRef(false);
  const [renamingTerminalId, setRenamingTerminalId] = useState<string | null>(null);
  const [terminalRenameDraft, setTerminalRenameDraft] = useState("");

  useEffect(() => {
    if (
      renamingTerminalId
      && !terminals.some((terminal) => (
        terminal.id === renamingTerminalId && !terminal.discovered
      ))
    ) {
      renameCommitSuppressedRef.current = false;
      setRenamingTerminalId(null);
      setTerminalRenameDraft("");
    }
  }, [renamingTerminalId, terminals]);

  const beginTerminalRename = (terminal: PlainTerminal) => {
    if (terminal.discovered) return;
    renameCommitSuppressedRef.current = false;
    setRenamingTerminalId(terminal.id);
    setTerminalRenameDraft(terminal.label);
  };

  const clearTerminalRename = () => {
    setRenamingTerminalId(null);
    setTerminalRenameDraft("");
  };

  const cancelTerminalRename = () => {
    renameCommitSuppressedRef.current = true;
    clearTerminalRename();
  };

  const commitTerminalRename = (terminal: PlainTerminal) => {
    const suppressed = renameCommitSuppressedRef.current;
    renameCommitSuppressedRef.current = false;
    const nextLabel = terminalRenameDraft.trim();
    clearTerminalRename();
    if (suppressed || !nextLabel || nextLabel === terminal.label) return;
    void Promise.resolve(onRenameTerminal(terminal.id, nextLabel)).catch(() => {});
  };

  const handleViewTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: SidebarView,
  ) => {
    const next = event.key === "Home"
      ? "workspaces"
      : event.key === "End"
        ? "files"
        : event.key === "ArrowLeft" || event.key === "ArrowRight"
          ? current === "workspaces" ? "files" : "workspaces"
          : null;
    if (!next) return;
    event.preventDefault();
    if (next !== current) onViewChange(next);
    viewTabRefs.current.get(next)?.focus();
  };

  return (
    <div className={rootClassName} aria-label="Dashboard sidebar">
      <div className="tw-dashboard-sidebar__view-tabs" role="tablist" aria-label="Sidebar view">
        <button
          id="tw-sidebar-workspaces-tab"
          ref={(node) => {
            if (node) viewTabRefs.current.set("workspaces", node);
            else viewTabRefs.current.delete("workspaces");
          }}
          className="tw-dashboard-sidebar__view-tab"
          type="button"
          role="tab"
          aria-controls="tw-sidebar-workspaces-panel"
          aria-selected={activeView === "workspaces"}
          tabIndex={activeView === "workspaces" ? 0 : -1}
          onClick={() => onViewChange("workspaces")}
          onKeyDown={(event) => handleViewTabKeyDown(event, "workspaces")}
        >
          <LayoutDashboard aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>Workspaces</span>
        </button>
        <button
          id="tw-sidebar-files-tab"
          ref={(node) => {
            if (node) viewTabRefs.current.set("files", node);
            else viewTabRefs.current.delete("files");
          }}
          className="tw-dashboard-sidebar__view-tab"
          type="button"
          role="tab"
          aria-controls="tw-sidebar-files-panel"
          aria-selected={activeView === "files"}
          tabIndex={activeView === "files" ? 0 : -1}
          onClick={() => onViewChange("files")}
          onKeyDown={(event) => handleViewTabKeyDown(event, "files")}
        >
          <Files aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>Files</span>
        </button>
      </div>

      <div className="tw-dashboard-sidebar__views">
        <section
          id="tw-sidebar-workspaces-panel"
          className="tw-dashboard-sidebar__view tw-dashboard-sidebar__view--workspaces"
          role="tabpanel"
          aria-labelledby="tw-sidebar-workspaces-tab"
          aria-hidden={activeView !== "workspaces"}
          hidden={activeView !== "workspaces"}
          inert={activeView !== "workspaces"}
        >
          <div className="tw-dashboard-sidebar__actions">
            <button
              className="tw-dashboard-sidebar__new-worktree"
              type="button"
              onClick={onCreateWorktree}
            >
              <Plus aria-hidden="true" size={17} strokeWidth={2.2} />
              <span>New worktree</span>
              <kbd aria-label="Command N">⌘N</kbd>
            </button>

            <button
              className="tw-dashboard-sidebar__search"
              type="button"
              onClick={onOpenCommandPalette}
              aria-label="Search sessions and commands"
              title="Search sessions and commands (⌘K)"
            >
              <Search aria-hidden="true" size={15} strokeWidth={1.8} />
              <span>Search sessions and commands…</span>
              <kbd aria-label="Command K">⌘K</kbd>
            </button>
          </div>

          <div className="tw-dashboard-sidebar__scroll-region">
        <p id={sortInstructionsId} className="tw-sidebar-sort-assistive">
          Drag a reorder handle, or focus it and press Up or Down. A worktree row stays in its
          current Host and Project group.
        </p>
        <p
          className="tw-sidebar-sort-assistive"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {sortAnnouncement}
        </p>
        <section className="tw-sidebar-section" aria-labelledby="tw-sidebar-pinned-heading">
          <div className="tw-sidebar-section__heading">
            <Pin aria-hidden="true" size={13} strokeWidth={1.8} />
            <h2 id="tw-sidebar-pinned-heading">Pinned</h2>
          </div>
          {pinnedRows.length === 0 ? (
            <p className="tw-sidebar-section__empty">Pin a worktree or terminal for quick access.</p>
          ) : (
            <nav className="tw-sidebar-list" aria-label="Pinned workspaces">
              {pinnedRows.map((row) => {
                if (row.kind === "session") {
                  const displayName = sidebarSessionDisplayName(row.session);
                  const selected = selection?.kind === "session" && selection.name === row.session.name;
                  return (
                    <div className="tw-sidebar-row" data-selected={selected} data-pinned="true" key={`pinned-session:${row.session.name}`}>
                      <button
                        className="tw-sidebar-row__target"
                        type="button"
                        onClick={() => onSelectSession(row.session.name)}
                        aria-current={selected ? "page" : undefined}
                        title={`Pinned worktree ${displayName}`}
                      >
                        <FolderGit2 className="tw-sidebar-row__leading-icon" aria-hidden="true" size={14} strokeWidth={1.8} />
                        <span className="tw-sidebar-row__copy">
                          <span className="tw-sidebar-row__title">{displayName}</span>
                          <span className="tw-sidebar-row__meta">{row.session.project || "Worktree"}</span>
                        </span>
                      </button>
                      <button
                        className="tw-sidebar-row__pin"
                        type="button"
                        onClick={() => onTogglePinned(row.item)}
                        aria-label={`Unpin worktree ${displayName}`}
                        title={`Unpin ${displayName}`}
                      >
                        <Pin aria-hidden="true" size={13} strokeWidth={1.8} fill="currentColor" />
                      </button>
                    </div>
                  );
                }
                const selected = selection?.kind === "terminal" && selection.id === row.terminal.id;
                return (
                  <div className="tw-sidebar-row" data-selected={selected} data-pinned="true" key={`pinned-terminal:${row.terminal.id}`}>
                    <button
                      className="tw-sidebar-row__target"
                      type="button"
                      onClick={() => onSelectTerminal(row.terminal.id)}
                      aria-current={selected ? "page" : undefined}
                      title={`Pinned terminal ${row.terminal.label}`}
                    >
                      <SquareTerminal className="tw-sidebar-row__leading-icon" aria-hidden="true" size={14} strokeWidth={1.8} />
                      <span className="tw-sidebar-row__copy">
                        <span className="tw-sidebar-row__title">{row.terminal.label}</span>
                        <span className="tw-sidebar-row__meta">{terminalDescription(row.terminal, hostsById)}</span>
                      </span>
                    </button>
                    <button
                      className="tw-sidebar-row__pin"
                      type="button"
                      onClick={() => onTogglePinned(row.item)}
                      aria-label={`Unpin terminal ${row.terminal.label}`}
                      title={`Unpin ${row.terminal.label}`}
                    >
                      <Pin aria-hidden="true" size={13} strokeWidth={1.8} fill="currentColor" />
                    </button>
                  </div>
                );
              })}
            </nav>
          )}
        </section>

        <section className="tw-sidebar-section" aria-labelledby="tw-sidebar-worktrees-heading">
          <div className="tw-sidebar-section__heading">
            <FolderGit2 aria-hidden="true" size={13} strokeWidth={1.8} />
            <h2 id="tw-sidebar-worktrees-heading">Worktrees</h2>
            <span className="tw-sidebar-section__count" aria-label={`${sessions.length} worktrees`}>
              {sessions.length}
            </span>
          </div>

          {sessionsError && <p className="tw-sidebar-section__error" role="alert">{sessionsError}</p>}
          {!sessionsError && groups.length === 0 && (
            <p className="tw-sidebar-section__empty">No worktrees yet</p>
          )}

          <nav
            className="tw-sidebar-list"
            aria-label="Worktrees"
            ref={(node) => {
              groupSortable.setListRef(node);
              sessionSortable.setListRef(node);
            }}
          >
            {groups.map((group, groupIndex) => {
              const isCollapsed = collapsed.has(group.key);
              const groupDropPosition = sortableDropPosition(
                groupSortable.dragIndex,
                groupSortable.overIndex,
                groupIndex,
              );
              return (
                <div
                  className="tw-sidebar-group"
                  data-group-sort-item="true"
                  data-sort-key={group.key}
                  data-sort-index={groupIndex}
                  data-dragging={groupSortable.dragIndex === groupIndex || undefined}
                  data-drag-over={groupDropPosition}
                  key={group.key}
                >
                  <div className="tw-sidebar-group__header">
                    <button
                      className="tw-sidebar-drag-handle"
                      type="button"
                      aria-label={`Reorder ${group.hostLabel} / ${group.project} worktrees, group ${groupIndex + 1} of ${groups.length}`}
                      aria-describedby={sortInstructionsId}
                      aria-keyshortcuts="ArrowUp ArrowDown"
                      title="Drag to reorder group; press Up or Down while focused"
                      onPointerDown={groupSortable.onPointerDown(group.key)}
                      onKeyDown={groupSortable.onHandleKeyDown(group.key)}
                    >
                      <GripVertical aria-hidden="true" size={14} strokeWidth={1.7} />
                    </button>
                    <button
                      className="tw-sidebar-group__toggle"
                      type="button"
                      onClick={() => onToggleProjectCollapsed(group.key)}
                      aria-expanded={!isCollapsed}
                      title={`${isCollapsed ? "Expand" : "Collapse"} ${group.hostLabel} / ${group.project}`}
                    >
                      <ChevronRight
                        className="tw-sidebar-group__chevron"
                        aria-hidden="true"
                        size={14}
                        strokeWidth={1.8}
                      />
                      {group.hostId ? (
                        <Server aria-hidden="true" size={13} strokeWidth={1.8} />
                      ) : (
                        <Laptop aria-hidden="true" size={13} strokeWidth={1.8} />
                      )}
                      <span className="tw-sidebar-group__host">{group.hostLabel}</span>
                      <span className="tw-sidebar-group__separator" aria-hidden="true">/</span>
                      <span className="tw-sidebar-group__project" title={group.project}>{group.project}</span>
                      <span className="tw-sidebar-group__count">{group.sessions.length}</span>
                    </button>
                  </div>

                  {!isCollapsed && (
                    <div className="tw-sidebar-group__items">
                      {group.sessions.map((session, groupSessionIndex) => {
                        const sessionIndex = sessionIndexByName.get(session.name) ?? -1;
                        const sessionDropPosition = sortableDropPosition(
                          sessionSortable.dragIndex,
                          sessionSortable.overIndex,
                          sessionIndex,
                        );
                        const activity = describeSidebarActivity(
                          sessionActivity[session.name],
                          session.attached,
                        );
                        const displayName = sidebarSessionDisplayName(session);
                        const selected = selection?.kind === "session" && selection.name === session.name;
                        const pinned = pinnedItems.some((item) => item.kind === "session" && item.name === session.name);
                        return (
                          <div
                            className="tw-sidebar-row"
                            data-selected={selected}
                            data-pinned={pinned}
                            data-status={activity.state}
                            data-session-sort-item="true"
                            data-sort-key={session.name}
                            data-sort-index={sessionIndex}
                            data-sortable="true"
                            data-dragging={sessionSortable.dragIndex === sessionIndex || undefined}
                            data-drag-over={sessionDropPosition}
                            key={session.name}
                          >
                            <button
                              className="tw-sidebar-drag-handle"
                              type="button"
                              aria-label={`Reorder worktree ${displayName}, position ${groupSessionIndex + 1} of ${group.sessions.length}`}
                              aria-describedby={sortInstructionsId}
                              aria-keyshortcuts="ArrowUp ArrowDown"
                              title="Drag to reorder within this group; press Up or Down while focused"
                              onPointerDown={sessionSortable.onPointerDown(session.name)}
                              onKeyDown={sessionSortable.onHandleKeyDown(session.name)}
                            >
                              <GripVertical aria-hidden="true" size={14} strokeWidth={1.7} />
                            </button>
                            <button
                              className="tw-sidebar-row__target"
                              type="button"
                              onClick={() => onSelectSession(session.name)}
                              aria-current={selected ? "page" : undefined}
                              title={`${displayName} — ${activity.title}`}
                            >
                              <Circle
                                className="tw-sidebar-row__status"
                                aria-hidden="true"
                                size={8}
                                strokeWidth={0}
                                fill="currentColor"
                              />
                              <span className="tw-sidebar-row__copy">
                                <span className="tw-sidebar-row__title">{displayName}</span>
                                <span className="tw-sidebar-row__meta">{activity.label}</span>
                              </span>
                            </button>
                            <span className="tw-sidebar-row__actions">
                              <button
                                className="tw-sidebar-row__pin"
                                type="button"
                                onClick={() => onTogglePinned({ kind: "session", name: session.name })}
                                aria-pressed={pinned}
                                aria-label={`${pinned ? "Unpin" : "Pin"} worktree ${displayName}`}
                                title={`${pinned ? "Unpin" : "Pin"} ${displayName}`}
                              >
                                <Pin aria-hidden="true" size={13} strokeWidth={1.8} fill={pinned ? "currentColor" : "none"} />
                              </button>
                              <button
                                className="tw-sidebar-row__close"
                                type="button"
                                onClick={() => void onCloseSession(session.name)}
                                aria-label={`Close worktree ${displayName}`}
                                title={`Close worktree ${displayName}`}
                              >
                                <X aria-hidden="true" size={14} strokeWidth={1.8} />
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </section>

        <section className="tw-sidebar-section" aria-labelledby="tw-sidebar-terminals-heading">
          <SidebarSectionHeading
            headingId="tw-sidebar-terminals-heading"
            icon={SquareTerminal}
            label="Terminals"
            actionLabel="New terminal"
            onAction={onCreateTerminal}
          />
          {terminalsError && <p className="tw-sidebar-section__error" role="alert">{terminalsError}</p>}
          {!terminalsError && terminals.length === 0 && (
            <p className="tw-sidebar-section__empty">No terminals yet</p>
          )}
          <nav
            className="tw-sidebar-list"
            aria-label="Terminals"
            ref={terminalSortable.setListRef}
          >
            {terminals.map((terminal, terminalIndex) => {
              const selected = selection?.kind === "terminal" && selection.id === terminal.id;
              const description = terminalDescription(terminal, hostsById);
              const pinned = pinnedItems.some((item) => item.kind === "terminal" && item.id === terminal.id);
              const renaming = renamingTerminalId === terminal.id && !terminal.discovered;
              const terminalSortKey = terminalSessionKey(terminal);
              const terminalDropPosition = sortableDropPosition(
                terminalSortable.dragIndex,
                terminalSortable.overIndex,
                terminalIndex,
              );
              return (
                <div
                  className="tw-sidebar-row"
                  data-selected={selected}
                  data-pinned={pinned}
                  data-terminal-sort-item="true"
                  data-sort-key={terminalSortKey}
                  data-sort-index={terminalIndex}
                  data-sortable="true"
                  data-dragging={terminalSortable.dragIndex === terminalIndex || undefined}
                  data-drag-over={terminalDropPosition}
                  key={terminal.id}
                >
                  <button
                    className="tw-sidebar-drag-handle"
                    type="button"
                    disabled={renaming}
                    aria-label={`Reorder terminal ${terminal.label}, position ${terminalIndex + 1} of ${terminals.length}`}
                    aria-describedby={sortInstructionsId}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    title="Drag to reorder; press Up or Down while focused"
                    onPointerDown={terminalSortable.onPointerDown(terminalSortKey)}
                    onKeyDown={terminalSortable.onHandleKeyDown(terminalSortKey)}
                  >
                    <GripVertical aria-hidden="true" size={14} strokeWidth={1.7} />
                  </button>
                  {renaming ? (
                    <div className="tw-sidebar-row__target tw-sidebar-row__target--renaming">
                      <SquareTerminal
                        className="tw-sidebar-row__leading-icon"
                        aria-hidden="true"
                        size={15}
                        strokeWidth={1.8}
                      />
                      <span className="tw-sidebar-row__copy">
                        <input
                          className="tw-sidebar-row__rename"
                          value={terminalRenameDraft}
                          aria-label={`Rename terminal ${terminal.label}`}
                          autoFocus
                          spellCheck={false}
                          onChange={(event) => setTerminalRenameDraft(event.currentTarget.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => commitTerminalRename(terminal)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelTerminalRename();
                            } else if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          }}
                        />
                        <span className="tw-sidebar-row__meta">{description}</span>
                      </span>
                    </div>
                  ) : (
                    <button
                      className="tw-sidebar-row__target"
                      type="button"
                      onClick={() => onSelectTerminal(terminal.id)}
                      onDoubleClick={!terminal.discovered ? () => beginTerminalRename(terminal) : undefined}
                      aria-current={selected ? "page" : undefined}
                      title={`${terminal.label} — ${description}${terminal.discovered ? "" : " · Double-click to rename"}`}
                    >
                      <SquareTerminal
                        className="tw-sidebar-row__leading-icon"
                        aria-hidden="true"
                        size={15}
                        strokeWidth={1.8}
                      />
                      <span className="tw-sidebar-row__copy">
                        <span className="tw-sidebar-row__title">{terminal.label}</span>
                        <span className="tw-sidebar-row__meta">{description}</span>
                      </span>
                    </button>
                  )}
                  <span className="tw-sidebar-row__actions">
                    <button
                      className="tw-sidebar-row__pin"
                      type="button"
                      onClick={() => onTogglePinned({ kind: "terminal", id: terminal.id })}
                      aria-pressed={pinned}
                      aria-label={`${pinned ? "Unpin" : "Pin"} terminal ${terminal.label}`}
                      title={`${pinned ? "Unpin" : "Pin"} ${terminal.label}`}
                    >
                      <Pin aria-hidden="true" size={13} strokeWidth={1.8} fill={pinned ? "currentColor" : "none"} />
                    </button>
                    <button
                      className="tw-sidebar-row__close"
                      type="button"
                      onClick={() => void onCloseTerminal(terminal.id)}
                      aria-label={`Close terminal ${terminal.label}`}
                      title={`Close terminal ${terminal.label}`}
                    >
                      <X aria-hidden="true" size={14} strokeWidth={1.8} />
                    </button>
                  </span>
                </div>
              );
            })}
          </nav>
        </section>

        <section className="tw-sidebar-section" aria-label="Automations">
          <div className="tw-sidebar-section__automation-heading">
            <button
              className="tw-sidebar-section__automation-toggle"
              type="button"
              onClick={onToggleAutomationSection}
              aria-expanded={!automationSectionCollapsed}
              title={automationSectionCollapsed ? "Show automation shortcuts" : "Hide automation shortcuts"}
            >
              <ChevronRight className="tw-sidebar-group__chevron" aria-hidden="true" size={14} strokeWidth={1.8} />
              <Workflow aria-hidden="true" size={13} strokeWidth={1.8} />
              <span>Automations</span>
              <span className="tw-sidebar-section__count">{automations.length}</span>
            </button>
            <button
              className="tw-sidebar-section__manage"
              type="button"
              onClick={onManageAutomations}
              title="Manage automations"
            >
              Manage
            </button>
          </div>
          {!automationSectionCollapsed && automationsError && <p className="tw-sidebar-section__error" role="alert">{automationsError}</p>}
          {!automationSectionCollapsed && !automationsError && automations.length === 0 && (
            <p className="tw-sidebar-section__empty">No automations yet</p>
          )}
          {!automationSectionCollapsed && <nav className="tw-sidebar-list" aria-label="Automation shortcuts">
            {automations.map((automation) => {
              const selected = selection?.kind === "automation" && selection.id === automation.id;
              const status = automationStatus(automation);
              return (
                <div
                  className="tw-sidebar-row"
                  data-selected={selected}
                  data-automation-status={automation.active ? automation.status ?? "idle" : "paused"}
                  key={automation.id}
                >
                  <button
                    className="tw-sidebar-row__target"
                    type="button"
                    onClick={() => onSelectAutomation(automation.id)}
                    aria-current={selected ? "page" : undefined}
                    title={`${automation.name || "Unnamed automation"} — ${status}`}
                  >
                    <Circle
                      className="tw-sidebar-row__status"
                      aria-hidden="true"
                      size={8}
                      strokeWidth={0}
                      fill="currentColor"
                    />
                    <span className="tw-sidebar-row__copy">
                      <span className="tw-sidebar-row__title">{automation.name || "Unnamed automation"}</span>
                      <span className="tw-sidebar-row__meta">
                        {triggerLabel(automation)} · {status}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </nav>}
        </section>
          </div>
        </section>

        <section
          id="tw-sidebar-files-panel"
          className="tw-dashboard-sidebar__view tw-dashboard-sidebar__view--files"
          role="tabpanel"
          aria-labelledby="tw-sidebar-files-tab"
          aria-hidden={activeView !== "files"}
          hidden={activeView !== "files"}
          inert={activeView !== "files"}
        >
          <div className="tw-dashboard-sidebar__files-content">
            {filesContent}
          </div>
        </section>
      </div>

      <footer className="tw-dashboard-sidebar__footer">
        <div className="tw-dashboard-sidebar__connection-row">
          <button
            ref={settingsButtonRef}
            className="tw-dashboard-sidebar__connections"
            type="button"
            onClick={() => onOpenSettings()}
            data-tone={footerTone}
            data-relay={relayState}
            title={`${localRuntimeLabel}. ${hostsLabel}. ${hostsDetail}. Mobile Relay: ${relayLabel}${mobileRelay?.error ? ` — ${mobileRelay.error}` : ""}`}
          >
            <Settings aria-hidden="true" size={16} strokeWidth={1.8} />
            <span className="tw-dashboard-sidebar__connection-copy">
              <span className="tw-dashboard-sidebar__connection-title">Settings</span>
              <span className="tw-dashboard-sidebar__connection-detail">
                {localRuntimeLabel} · {hostsLabel} · Relay {relayLabel}
              </span>
            </span>
          </button>
        </div>

        {installHost && (
          <button
            className="tw-dashboard-sidebar__install"
            type="button"
            onClick={() => {
              void Promise.resolve(onInstallTw(installHost.id)).catch(() => {});
            }}
            disabled={installingHostId === installHost.id}
            title={`Install tw on ${installHost.label || installHost.id}`}
          >
            {installingHostId === installHost.id ? (
              <LoaderCircle
                className="tw-dashboard-sidebar__spinner"
                aria-hidden="true"
                size={13}
                strokeWidth={1.8}
              />
            ) : (
              <Download aria-hidden="true" size={13} strokeWidth={1.8} />
            )}
            <span>
              {installingHostId === installHost.id ? "Installing tw" : "Install tw"} · {installHost.label || installHost.id}
            </span>
          </button>
        )}
      </footer>
    </div>
  );
}
