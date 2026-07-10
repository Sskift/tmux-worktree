import {
  ChevronRight,
  Circle,
  Download,
  FolderGit2,
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
import { useMemo } from "react";
import { triggerLabel, type Automation } from "../automationTypes";
import type { HostConfig, HostStatus, PlainTerminal, Session } from "../platform";
import type { SessionActivityInfo } from "../sessionActivity";
import type { Selection } from "./layoutPreferences";
import {
  describeSidebarActivity,
  groupSessionsByHostProject,
  summarizeSidebarConnections,
} from "./DashboardSidebarModel";
import "./DashboardSidebar.css";

export {
  describeSidebarActivity,
  groupSessionsByHostProject,
  summarizeSidebarConnections,
} from "./DashboardSidebarModel";
export type {
  SidebarActivityDescription,
  SidebarConnectionSummary,
  SidebarConnectionTone,
  SidebarSessionGroup,
} from "./DashboardSidebarModel";

export type DashboardSidebarProps = {
  sessions: readonly Session[];
  terminals: readonly PlainTerminal[];
  automations: readonly Automation[];
  hosts: readonly HostConfig[];
  hostStatuses: Readonly<Record<string, HostStatus | undefined>>;
  selection: Selection;
  sessionActivity: Readonly<Record<string, SessionActivityInfo | undefined>>;
  collapsedProjects: readonly string[];
  installingHostId?: string | null;
  sessionsError?: string | null;
  terminalsError?: string | null;
  automationsError?: string | null;
  className?: string;
  onCreateWorktree: () => void;
  onCreateTerminal: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: (section?: "connections") => void;
  onToggleProjectCollapsed: (groupKey: string) => void;
  onSelectSession: (sessionName: string) => void;
  onCloseSession: (sessionName: string) => void | Promise<void>;
  onSelectTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void | Promise<void>;
  onCreateAutomation: () => void;
  onSelectAutomation: (automationId: string) => void;
  onInstallTw: (hostId: string) => void | Promise<void>;
};

function sessionDisplayName(session: Session): string {
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
  selection,
  sessionActivity,
  collapsedProjects,
  installingHostId = null,
  sessionsError,
  terminalsError,
  automationsError,
  className,
  onCreateWorktree,
  onCreateTerminal,
  onOpenCommandPalette,
  onOpenSettings,
  onToggleProjectCollapsed,
  onSelectSession,
  onCloseSession,
  onSelectTerminal,
  onCloseTerminal,
  onCreateAutomation,
  onSelectAutomation,
  onInstallTw,
}: DashboardSidebarProps) {
  const groups = useMemo(
    () => groupSessionsByHostProject(sessions, hosts),
    [hosts, sessions],
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
  const rootClassName = ["tw-dashboard-sidebar", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName} aria-label="Dashboard sidebar">
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
          aria-label="Search sessions, files, and commands"
        >
          <Search aria-hidden="true" size={15} strokeWidth={1.8} />
          <span>Search sessions, files…</span>
          <kbd aria-label="Command K">⌘K</kbd>
        </button>
      </div>

      <div className="tw-dashboard-sidebar__scroll-region">
        <section className="tw-sidebar-section" aria-labelledby="tw-sidebar-pinned-heading">
          <div className="tw-sidebar-section__heading">
            <Pin aria-hidden="true" size={13} strokeWidth={1.8} />
            <h2 id="tw-sidebar-pinned-heading">Pinned</h2>
          </div>
          <p className="tw-sidebar-section__empty">No pinned worktrees</p>
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

          <nav className="tw-sidebar-list" aria-label="Worktrees">
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.key);
              return (
                <div className="tw-sidebar-group" key={group.key}>
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

                  {!isCollapsed && (
                    <div className="tw-sidebar-group__items">
                      {group.sessions.map((session) => {
                        const activity = describeSidebarActivity(
                          sessionActivity[session.name],
                          session.attached,
                        );
                        const displayName = sessionDisplayName(session);
                        const selected = selection?.kind === "session" && selection.name === session.name;
                        return (
                          <div
                            className="tw-sidebar-row"
                            data-selected={selected}
                            data-status={activity.state}
                            key={session.name}
                          >
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
                            <button
                              className="tw-sidebar-row__close"
                              type="button"
                              onClick={() => void onCloseSession(session.name)}
                              aria-label={`Close worktree ${displayName}`}
                              title={`Close worktree ${displayName}`}
                            >
                              <X aria-hidden="true" size={14} strokeWidth={1.8} />
                            </button>
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
          <nav className="tw-sidebar-list" aria-label="Terminals">
            {terminals.map((terminal) => {
              const selected = selection?.kind === "terminal" && selection.id === terminal.id;
              const description = terminalDescription(terminal, hostsById);
              return (
                <div className="tw-sidebar-row" data-selected={selected} key={terminal.id}>
                  <button
                    className="tw-sidebar-row__target"
                    type="button"
                    onClick={() => onSelectTerminal(terminal.id)}
                    aria-current={selected ? "page" : undefined}
                    title={`${terminal.label} — ${description}`}
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
                  <button
                    className="tw-sidebar-row__close"
                    type="button"
                    onClick={() => void onCloseTerminal(terminal.id)}
                    aria-label={`Close terminal ${terminal.label}`}
                    title={`Close terminal ${terminal.label}`}
                  >
                    <X aria-hidden="true" size={14} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
          </nav>
        </section>

        <section className="tw-sidebar-section" aria-labelledby="tw-sidebar-automations-heading">
          <SidebarSectionHeading
            headingId="tw-sidebar-automations-heading"
            icon={Workflow}
            label="Automations"
            actionLabel="New automation"
            onAction={onCreateAutomation}
          />
          {automationsError && <p className="tw-sidebar-section__error" role="alert">{automationsError}</p>}
          {!automationsError && automations.length === 0 && (
            <p className="tw-sidebar-section__empty">No automations yet</p>
          )}
          <nav className="tw-sidebar-list" aria-label="Automations">
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
          </nav>
        </section>
      </div>

      <footer className="tw-dashboard-sidebar__footer">
        <div className="tw-dashboard-sidebar__connection-row">
          <button
            className="tw-dashboard-sidebar__connections"
            type="button"
            onClick={() => onOpenSettings("connections")}
            data-tone={connections.tone}
            title={`${connections.label}. ${connections.detail}`}
          >
            <Server aria-hidden="true" size={16} strokeWidth={1.8} />
            <span className="tw-dashboard-sidebar__connection-copy">
              <span className="tw-dashboard-sidebar__connection-title">Connections</span>
              <span className="tw-dashboard-sidebar__connection-detail">
                {connections.label} · {connections.detail}
              </span>
            </span>
          </button>
          <button
            className="tw-dashboard-sidebar__settings"
            type="button"
            onClick={() => onOpenSettings()}
            aria-label="Open Settings"
            title="Open Settings (⌘,)"
          >
            <Settings aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </div>

        {installHost && (
          <button
            className="tw-dashboard-sidebar__install"
            type="button"
            onClick={() => void onInstallTw(installHost.id)}
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
