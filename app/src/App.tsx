import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Plus, X } from "lucide-react";
import {
  type DashboardWindow,
  type HostConfig,
  type PlainTerminal,
  type Session,
  useDashboardBackend,
} from "./platform";
import { useDashboardCatalog } from "./dashboard/hooks/useDashboardCatalog";
import { useLayoutPreferences } from "./dashboard/hooks/useLayoutPreferences";
import { useMobileRelayController } from "./dashboard/hooks/useMobileRelayController";
import { useVisibilityAwarePolling } from "./dashboard/hooks/useVisibilityAwarePolling";
import {
  CommandPalette,
  type CommandPaletteItem,
} from "./dashboard/CommandPalette";
import {
  AgentsSettings,
  SettingsDialog,
  type SettingsSectionId,
} from "./dashboard/Settings";
import {
  ConnectionsSettings,
  relaySettingsBindingsFromController,
} from "./dashboard/Settings/ConnectionsSettings";
import {
  TerminalDeck,
  sessionDisplayName,
  shellQuoteArg,
  terminalRawName,
  terminalSessionKey,
} from "./dashboard/TerminalDeck";
import {
  DashboardShell,
  type DashboardDrawer,
} from "./dashboard/DashboardShell";
import {
  DashboardSidebar,
  type SidebarView,
} from "./dashboard/DashboardSidebar";
import { WorkspaceHeader } from "./dashboard/WorkspaceHeader";
import { Inspector } from "./dashboard/Inspector";
import type { WorkspaceStatus } from "./dashboard/workspaceStatus";
import {
  clampDashboardPanelWidthForViewport,
  normalizeDashboardPanelWidths,
} from "./dashboard/dashboardShellModel";
import {
  pendingCreatedCatalogSelection,
  pendingRestoredCatalogSelection,
  reconcileCatalogSelection,
  sameCatalogSelection,
  type PendingCatalogSelection,
} from "./dashboard/catalogSelectionHydration";
import { mergeDashboardCatalogSnapshot } from "./dashboard/dashboardCatalogSnapshot";
import {
  DEFAULT_COLUMN_ORDER,
  type DiffFile,
  type EditingFile,
  type PinnedItem,
  type Selection,
  type WindowLayout,
} from "./dashboard/layoutPreferences";
import {
  DEFAULT_SCRATCH_PANEL_WIDTH,
  SCRATCH_PANEL_LIMITS,
  clampScratchPanelWidth,
  scratchPanelMaximumWidth,
  scratchPanelWidthFromKey,
  scratchPanelWidthFromPointer,
} from "./dashboard/scratchPanelModel";
import { Terminal } from "./Terminal";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { NewTerminalModal, type TerminalDraft } from "./NewTerminalModal";
import { ThemePicker } from "./ThemePicker";
import { GitStatusPanel } from "./GitStatusPanel";
import { FileTree } from "./FileTree";
import { FileEditor } from "./FileEditor";
import { DiffViewer } from "./DiffViewer";
import { AutomationPanel } from "./AutomationPanel";
import {
  editingFileSourceKey,
  runGuardedWorkspaceNavigation,
  type EditorDirtySnapshot,
} from "./editorNavigationGuard";
import {
  allocateTerminalId,
  createTerminalSaveCoordinator,
  type TerminalSaveCoordinator,
} from "./terminalPersistence";
import { createLatestRequestGate } from "./latestRequestGate";
import { applyTheme, loadTheme, type ThemeId } from "./themes";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";
import {
  automationSelectionIsCurrent,
  automationSubmitStillOwnsDraft,
  recordAutomationDirtySignal,
} from "./automationDraftSync";
import {
  automationFromRecord,
  automationRunFromRecord,
  automationSaveInputFromDraft,
  createAutomationDraft,
  shouldRunAutomationSchedule,
  triggerLabel,
  type Automation,
  type AutomationDraft,
  type AutomationRun,
} from "./automationTypes";
import {
  describeSessionActivity,
  type PreviousSessionActivity,
  type SessionActivityInfo,
} from "./sessionActivity";
import "./App.css";

const REFRESH_MS = 2000;
const HIDDEN_REFRESH_MS = 10_000;
const PRELOAD_HISTORY_LINES = 300;
const WINDOW_DEFAULTS = { width: 1440, height: 900 };

function projectKey(name: string): string {
  const i = name.indexOf("-");
  return i > 0 ? name.slice(0, i) : name;
}

function buildSshShellArgs(host: HostConfig, cwd: string): string[] {
  const args: string[] = ["-tt", "-o", "StrictHostKeyChecking=accept-new"];
  if (host.port) {
    args.push("-p", String(host.port));
  }
  if (host.identityFile) {
    args.push("-i", host.identityFile);
  }
  const target = host.user ? `${host.user}@${host.host}` : host.host;
  args.push(
    target,
    "--",
    `cd ${shellQuoteArg(cwd)} && exec "\${SHELL:-/bin/sh}"`,
  );
  return args;
}

function isInternalTerminalName(value: string | null | undefined): boolean {
  return !!value && value.startsWith("tw-term-");
}

function basenameFromPath(value: string | null | undefined): string {
  const parts = (value ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function normalizePlainTerminal(terminal: PlainTerminal): PlainTerminal {
  const hostId = terminal.hostId === "local" ? null : terminal.hostId ?? null;
  const rawName = terminal.rawName || terminalRawName({ ...terminal, hostId });
  const fallbackLabel = basenameFromPath(terminal.cwd) || "terminal";
  const label = !terminal.label || isInternalTerminalName(terminal.label)
    ? fallbackLabel
    : terminal.label;
  return { ...terminal, hostId, rawName, label };
}

function isLocalDiscoveredInternalTerminal(terminal: PlainTerminal): boolean {
  if (terminal.hostId) return false;
  return isInternalTerminalName(terminal.rawName) || isInternalTerminalName(terminal.tmuxName);
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

function sameSessions(a: Session[], b: Session[]): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return (
      left.name === right.name &&
      left.attached === right.attached &&
      left.window_count === right.window_count &&
      left.created === right.created &&
      left.activity === right.activity &&
      (left.output_signature ?? null) === (right.output_signature ?? null) &&
      (left.agent_running ?? null) === (right.agent_running ?? null) &&
      (left.hostId ?? null) === (right.hostId ?? null) &&
      (left.rawName ?? "") === (right.rawName ?? "") &&
      (left.project ?? "") === (right.project ?? "")
    );
  });
}

function samePlainTerminals(a: PlainTerminal[], b: PlainTerminal[]): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return (
      left.id === right.id &&
      left.label === right.label &&
      left.cwd === right.cwd &&
      left.tmuxName === right.tmuxName &&
      (left.hostId ?? null) === (right.hostId ?? null) &&
      (left.rawName ?? "") === (right.rawName ?? "") &&
      (left.aiCmd ?? "") === (right.aiCmd ?? "") &&
      (left.discovered ?? false) === (right.discovered ?? false)
    );
  });
}

function sameSessionActivity(
  a: Record<string, SessionActivityInfo>,
  b: Record<string, SessionActivityInfo>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return !!right &&
      left.state === right.state &&
      left.label === right.label &&
      left.changed === right.changed &&
      left.ageSeconds === right.ageSeconds &&
      left.lastChangedAt === right.lastChangedAt &&
      (left.outputSignature ?? null) === (right.outputSignature ?? null);
  });
}
async function getWindowExpandedState(win: DashboardWindow) {
  const [fullscreen, maximized] = await Promise.all([
    win.isFullscreen().catch(() => false),
    win.isMaximized().catch(() => false),
  ]);
  return { fullscreen, maximized };
}

type ScratchTerm = { id: string; label: string };
type ScratchState = { list: ScratchTerm[]; nextNum: number };
const DEFAULT_SIDEBAR_WIDTH = 280;
const DEFAULT_INSPECTOR_WIDTH = 420;

type ViewportTier = "compact" | "drawer" | "wide";

function viewportTierForWidth(width: number): ViewportTier {
  if (width >= 1440) return "wide";
  if (width >= 960) return "drawer";
  return "compact";
}

let scratchIdCounter = 0;

function App() {
  const dashboardBackend = useDashboardBackend();
  const { loadLayoutPreferences, saveLayoutPreferences } = useLayoutPreferences();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [terminals, setTerminals] = useState<PlainTerminal[]>([]);
  const [discoveredTerminals, setDiscoveredTerminals] = useState<PlainTerminal[]>([]);
  const [terminalsRestoreReady, setTerminalsRestoreReady] = useState(false);
  const [terminalPersistenceWritable, setTerminalPersistenceWritable] = useState(false);
  const [terminalPersistenceError, setTerminalPersistenceError] = useState<string | null>(null);
  const [terminalPersistenceHydrationGeneration, setTerminalPersistenceHydrationGeneration] =
    useState(0);
  const terminalSaveCoordinatorRef = useRef<TerminalSaveCoordinator | null>(null);
  const [catalogRefreshGeneration, setCatalogRefreshGeneration] = useState(0);
  const [failedSessionHostIds, setFailedSessionHostIds] = useState<string[]>([]);
  const [failedTerminalHostIds, setFailedTerminalHostIds] = useState<string[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const {
    projectPresets,
    loadProjectPresets,
    hosts,
    hostsHydrationGeneration,
    hostsLoadError,
    setHosts,
    sshHostCandidates,
    hostStatuses,
    installingHostId,
    installRemoteTw,
  } = useDashboardCatalog();
  const mobileRelay = useMobileRelayController({ hosts });
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivityInfo>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [openedSessions, setOpenedSessions] = useState<string[]>([]);
  const [openedTerminals, setOpenedTerminals] = useState<string[]>([]);
  const [tmuxPreviews, setTmuxPreviews] = useState<Record<string, string>>({});
  const [cwdsBySession, setCwdsBySession] = useState<Record<string, string>>({});
  const [lastAutomationContextPath, setLastAutomationContextPath] = useState<string | null>(null);
  const [lastAutomationContextProject, setLastAutomationContextProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [layoutResetMessage, setLayoutResetMessage] = useState<string | null>(null);
  const [defaultAgentCommand, setDefaultAgentCommand] = useState(loadLastAiCmd);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => {
    const id = loadTheme();
    applyTheme(id);
    return id;
  });
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([]);
  const [automationSectionCollapsed, setAutomationSectionCollapsed] = useState(true);
  const [scratchTerminals, setScratchTerminals] = useState<Map<string, ScratchState>>(new Map());
  const [scratchCollapsed, setScratchCollapsed] = useState(true);
  const [scratchWidth, setScratchWidth] = useState(DEFAULT_SCRATCH_PANEL_WIDTH);
  const [editingFile, setEditingFile] = useState<EditingFile | null>(null);
  const [editorNavigationRevision, setEditorNavigationRevision] = useState(0);
  const [diffFile, setDiffFile] = useState<DiffFile | null>(null);
  const [workspaceBranch, setWorkspaceBranch] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const panelWidthsRef = useRef({
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 960);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1440);
  const sidebarOpenPreferenceRef = useRef(window.innerWidth >= 960);
  const inspectorOpenPreferenceRef = useRef(window.innerWidth >= 1440);
  const [sidebarView, setSidebarView] = useState<SidebarView>("workspaces");
  const [viewportTier, setViewportTier] = useState<ViewportTier>(() =>
    viewportTierForWidth(window.innerWidth),
  );
  const [windowLayout, setWindowLayout] = useState<WindowLayout | null>(null);
  const [windowRestoreReady, setWindowRestoreReady] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dashboardWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);
  const automationReturnSelectionRef = useRef<Selection>(null);
  const cwdRequested = useRef<Set<string>>(new Set());
  const tmuxPreviewRequested = useRef<Set<string>>(new Set());
  const tmuxPreviewLiveRef = useRef<Set<string>>(new Set());
  const layoutLoadedRef = useRef(false);
  const automationsRef = useRef<Automation[]>([]);
  const sessionActivityRef = useRef<Map<string, PreviousSessionActivity>>(new Map());
  const sessionsRef = useRef<Session[]>(sessions);
  const discoveredTerminalsRef = useRef<PlainTerminal[]>(discoveredTerminals);
  const scheduledAutomationMinuteRef = useRef<Set<string>>(new Set());
  const [pendingCatalogSelection, setPendingCatalogSelection] =
    useState<PendingCatalogSelection | null>(null);
  const catalogRefreshGenerationRef = useRef({ started: 0, successful: 0 });
  const editingFileRef = useRef<EditingFile | null>(editingFile);
  const editorNavigationGateRef = useRef(createLatestRequestGate());
  const editorDirtySnapshotRef = useRef<EditorDirtySnapshot>({
    fileKey: editingFileSourceKey(editingFile),
    dirty: false,
    revision: 0,
  });
  const automationDirtySnapshotRef = useRef<EditorDirtySnapshot>({
    fileKey: null,
    dirty: false,
    revision: 0,
  });
  const editingFileKey = editingFileSourceKey(editingFile);
  const automationDraftKey = selection?.kind === "automation"
    ? `automation:${selection.id || "new"}`
    : null;
  editingFileRef.current = editingFile;
  if (editorDirtySnapshotRef.current.fileKey !== editingFileKey) {
    editorDirtySnapshotRef.current = {
      fileKey: editingFileKey,
      dirty: false,
      revision: editorDirtySnapshotRef.current.revision + 1,
    };
  }
  if (automationDirtySnapshotRef.current.fileKey !== automationDraftKey) {
    automationDirtySnapshotRef.current = {
      fileKey: automationDraftKey,
      dirty: false,
      revision: automationDirtySnapshotRef.current.revision + 1,
    };
  }
  panelWidthsRef.current = { sidebarWidth, inspectorWidth };
  automationsRef.current = automations;
  sessionsRef.current = sessions;
  discoveredTerminalsRef.current = discoveredTerminals;

  const handleEditorDirtyChange = useCallback((dirty: boolean) => {
    const current = editorDirtySnapshotRef.current;
    if (current.dirty === dirty) return;
    editorDirtySnapshotRef.current = {
      ...current,
      dirty,
      revision: current.revision + 1,
    };
  }, []);

  const handleAutomationDirtyChange = useCallback((dirty: boolean) => {
    const current = automationDirtySnapshotRef.current;
    const next = recordAutomationDirtySignal(current, dirty);
    if (next === current) return;
    automationDirtySnapshotRef.current = {
      ...current,
      ...next,
    };
  }, []);

  const requestEditorNavigation = useCallback(
    (
      navigate: () => void,
      options: { ignoreAutomationDirty?: boolean } = {},
    ): Promise<boolean> => {
      const editorSnapshot = editorDirtySnapshotRef.current;
      const automationSnapshot = automationDirtySnapshotRef.current;
      const fileName =
        basenameFromPath(editingFileRef.current?.path) || "the open file";
      return runGuardedWorkspaceNavigation({
        gate: editorNavigationGateRef.current,
        surfaces: [
          {
            key: editorSnapshot.fileKey,
            dirty: editorSnapshot.dirty,
            revision: editorSnapshot.revision,
            getCurrent: () => ({
              key: editorDirtySnapshotRef.current.fileKey,
              dirty: editorDirtySnapshotRef.current.dirty,
              revision: editorDirtySnapshotRef.current.revision,
            }),
            confirmDiscard: () =>
              dashboardBackend.dialog.confirm({
                title: "Discard unsaved changes?",
                message: `Changes to ${fileName} have not been saved. Continue and discard them?`,
              }),
          },
          {
            key: automationSnapshot.fileKey,
            dirty: options.ignoreAutomationDirty ? false : automationSnapshot.dirty,
            revision: automationSnapshot.revision,
            getCurrent: () => ({
              key: automationDirtySnapshotRef.current.fileKey,
              dirty: automationDirtySnapshotRef.current.dirty,
              revision: automationDirtySnapshotRef.current.revision,
            }),
            confirmDiscard: () =>
              dashboardBackend.dialog.confirm({
                title: "Discard unsaved automation changes?",
                message: "This automation draft has not been saved. Continue and discard it?",
              }),
          },
        ],
        navigate: () => {
          const currentEditor = editorDirtySnapshotRef.current;
          editorDirtySnapshotRef.current = {
            ...currentEditor,
            dirty: false,
            revision: currentEditor.revision + 1,
          };
          const currentAutomation = automationDirtySnapshotRef.current;
          automationDirtySnapshotRef.current = {
            ...currentAutomation,
            dirty: false,
            revision: currentAutomation.revision + 1,
          };
          navigate();
        },
      });
    },
    [dashboardBackend],
  );

  useEffect(() => {
    dashboardBackend.persistence.homeDirectory().then(setHomeDir).catch(() => {});
  }, [dashboardBackend]);

  useEffect(() => {
    const handleResize = () => {
      setScratchWidth((current) => clampScratchPanelWidth(
        current,
        dashboardWorkspaceRef.current?.getBoundingClientRect().width ?? window.innerWidth,
      ));
      const normalizedWidths = normalizeDashboardPanelWidths(
        window.innerWidth,
        panelWidthsRef.current.sidebarWidth,
        panelWidthsRef.current.inspectorWidth,
      );
      panelWidthsRef.current = normalizedWidths;
      setSidebarWidth(normalizedWidths.sidebarWidth);
      setInspectorWidth(normalizedWidths.inspectorWidth);
      const nextTier = viewportTierForWidth(window.innerWidth);
      setViewportTier((currentTier) => {
        if (currentTier === nextTier) return currentTier;
        if (nextTier === "compact") {
          setSidebarOpen(false);
          setInspectorOpen(false);
        } else if (nextTier === "drawer") {
          setSidebarOpen(true);
          setInspectorOpen(false);
        } else {
          setSidebarOpen(true);
          setInspectorOpen(inspectorOpenPreferenceRef.current);
        }
        return nextTier;
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!windowRestoreReady) return;
    const win = dashboardBackend.window.current();
    let disposed = false;
    let timer: number | null = null;
    let unlistenResized: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;

    const capture = async () => {
      try {
        const { fullscreen, maximized } = await getWindowExpandedState(win);
        if (disposed) return;
        if (fullscreen) {
          setWindowLayout(
            (prev) =>
              prev ?? {
                width: WINDOW_DEFAULTS.width,
                height: WINDOW_DEFAULTS.height,
                x: 0,
                y: 0,
                maximized: false,
              },
          );
          return;
        }
        if (maximized) {
          setWindowLayout((prev) =>
            prev
              ? { ...prev, maximized: true }
              : {
                  width: WINDOW_DEFAULTS.width,
                  height: WINDOW_DEFAULTS.height,
                  x: 0,
                  y: 0,
                  maximized: true,
                },
          );
          return;
        }

        const [size, position, factor] = await Promise.all([
          win.innerSize(),
          win.outerPosition(),
          win.scaleFactor(),
        ]);
        if (disposed) return;
        setWindowLayout({
          width: Math.round(size.width / factor),
          height: Math.round(size.height / factor),
          x: Math.round(position.x / factor),
          y: Math.round(position.y / factor),
          maximized: false,
        });
      } catch {
        // Ignore platform/window-manager errors; persistence is best-effort.
      }
    };

    const scheduleCapture = () => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        void capture();
      }, 150);
    };

    void capture();
    void win.onResized(scheduleCapture).then((fn) => {
      if (disposed) fn();
      else unlistenResized = fn;
    });
    void win.onMoved(scheduleCapture).then((fn) => {
      if (disposed) fn();
      else unlistenMoved = fn;
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlistenResized?.();
      unlistenMoved?.();
    };
  }, [windowRestoreReady]);

  // Persisted terminal metadata is retried independently from the live tmux
  // catalog. A failed read must never authorize saving an empty replacement.
  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    let hydrationSettled = false;

    const settleHydration = () => {
      if (hydrationSettled || disposed) return;
      hydrationSettled = true;
      setTerminalsRestoreReady(true);
      setTerminalPersistenceHydrationGeneration((generation) => generation + 1);
    };

    const loadPersistedTerminals = async () => {
      try {
        const saved = await dashboardBackend.terminals.load();
        const restored = saved
          .filter((terminal) => terminal.tmuxName)
          .map(normalizePlainTerminal);

        await Promise.all(restored.map((terminal) =>
          dashboardBackend.terminals.ensure({
            name: terminal.tmuxName,
            cwd: terminal.cwd,
            aiCmd: terminal.aiCmd ?? "",
            hostId: terminal.hostId ?? null,
            rawName: terminal.rawName ?? null,
          }).catch(() => {}),
        ));
        if (disposed) return;

        setTerminals((current) => {
          const restoredKeys = new Set(restored.map(terminalSessionKey));
          return [
            ...restored,
            ...current.filter((terminal) => !restoredKeys.has(terminalSessionKey(terminal))),
          ];
        });
        setTerminalPersistenceWritable(true);
        setTerminalPersistenceError(null);
        settleHydration();
      } catch (nextError) {
        if (disposed) return;
        setTerminalPersistenceError(`Terminal metadata could not be loaded: ${String(nextError)}`);
        // Keep metadata hydration pending. Falling back while a retry can still
        // restore the selected terminal would persist the wrong selection.
        retryTimer = window.setTimeout(
          () => void loadPersistedTerminals(),
          document.hidden ? 15_000 : 3_000,
        );
      }
    };

    void loadPersistedTerminals();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [dashboardBackend]);

  // Load layout data on mount.
  useEffect(() => {
    loadLayoutPreferences()
      .then((lay) => {
        const restoredPanelWidths = normalizeDashboardPanelWidths(
          window.innerWidth,
          lay.sidebarWidth ?? lay.left ?? DEFAULT_SIDEBAR_WIDTH,
          lay.inspectorWidth ?? DEFAULT_INSPECTOR_WIDTH,
        );
        panelWidthsRef.current = restoredPanelWidths;
        setSidebarWidth(restoredPanelWidths.sidebarWidth);
        setInspectorWidth(restoredPanelWidths.inspectorWidth);
        if (lay.sessionOrder) {
          setSessionOrder(lay.sessionOrder.filter((name) => !name.startsWith("tw-term-")));
        }
        if (lay.collapsedProjects) {
          setCollapsedProjects(lay.collapsedProjects);
        }
        if (lay.pinnedItems) {
          setPinnedItems(lay.pinnedItems);
        }
        if (lay.automationSectionCollapsed !== undefined) {
          setAutomationSectionCollapsed(lay.automationSectionCollapsed);
        }
        const restoredScratchOpen = lay.scratchCollapsed === false;
        if (lay.scratchCollapsed !== undefined) setScratchCollapsed(lay.scratchCollapsed);
        if (lay.scratchWidth !== undefined) {
          setScratchWidth(clampScratchPanelWidth(lay.scratchWidth, window.innerWidth));
        }
        const restoredSidebarView: SidebarView = lay.sidebarView ?? (
          lay.fileBrowserOpen === true ||
          (lay.inspectorOpen === true && lay.inspectorTab === "files") ||
          lay.editingFile
            ? "files"
            : "workspaces"
        );
        setSidebarView(restoredSidebarView);
        const currentViewportTier = viewportTierForWidth(window.innerWidth);
        const restoredSidebarOpen = lay.sidebarOpen ?? true;
        const restoredInspectorOpen = !restoredScratchOpen && (
          lay.sidebarView !== undefined
            ? lay.inspectorOpen ?? false
            : (lay.inspectorTab === "git" || lay.inspectorTab === "diff") &&
              (lay.inspectorOpen ?? false)
        );
        sidebarOpenPreferenceRef.current = restoredSidebarOpen;
        inspectorOpenPreferenceRef.current = restoredInspectorOpen;
        if (currentViewportTier === "compact") {
          setSidebarOpen(false);
          setInspectorOpen(false);
        } else if (currentViewportTier === "drawer") {
          setSidebarOpen(true);
          setInspectorOpen(false);
        } else {
          setSidebarOpen(true);
          setInspectorOpen(restoredInspectorOpen);
        }
        if (lay.diffFile) {
          setDiffFile(lay.diffFile);
          setEditingFile(null);
        } else if (lay.editingFile) {
          setEditingFile(lay.editingFile);
          setDiffFile(null);
        }
        if (lay.selection !== undefined) {
          setPendingCatalogSelection(
            pendingRestoredCatalogSelection(
              lay.selection,
              catalogRefreshGenerationRef.current.successful,
            ),
          );
          setSelection(lay.selection);
        }
        if (lay.window) setWindowLayout(lay.window);
        setWindowRestoreReady(true);
      })
      .catch(() => {
        setWindowRestoreReady(true);
      })
      .finally(() => {
        layoutLoadedRef.current = true;
      });
  }, [dashboardBackend, loadLayoutPreferences]);

  // Persist terminal metadata serially. The coordinator keeps the newest
  // snapshot queued and retries failed writes without allowing an older save
  // to land after a newer one.
  useEffect(() => {
    if (!terminalsRestoreReady || !terminalPersistenceWritable) {
      terminalSaveCoordinatorRef.current?.stop();
      terminalSaveCoordinatorRef.current = null;
      return;
    }

    const coordinator = createTerminalSaveCoordinator({
      save: (snapshot) => dashboardBackend.terminals.save(snapshot),
      schedule: (callback, delayMs) => {
        const timer = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timer);
      },
      retryDelayMs: () => document.hidden ? 15_000 : 3_000,
      onError: (nextError) => {
        setTerminalPersistenceError(
          `Terminal metadata could not be saved: ${String(nextError)}`,
        );
      },
      onSaved: () => setTerminalPersistenceError(null),
    });
    terminalSaveCoordinatorRef.current = coordinator;

    return () => {
      coordinator.stop();
      if (terminalSaveCoordinatorRef.current === coordinator) {
        terminalSaveCoordinatorRef.current = null;
      }
    };
  }, [dashboardBackend, terminalPersistenceWritable, terminalsRestoreReady]);

  useEffect(() => {
    if (!terminalsRestoreReady || !terminalPersistenceWritable) return;
    const coordinator = terminalSaveCoordinatorRef.current;
    if (!coordinator) return;
    // Defer the enqueue one task so React StrictMode's synthetic mount cleanup
    // can cancel it before any backend write begins.
    const timer = window.setTimeout(() => coordinator.enqueue(terminals), 0);
    return () => window.clearTimeout(timer);
  }, [terminalPersistenceWritable, terminals, terminalsRestoreReady]);

  // Persist layout (debounced)
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const t = setTimeout(() => {
      saveLayoutPreferences({
        left: sidebarWidth,
        sidebarWidth,
        inspectorWidth,
        sidebarOpen: sidebarOpenPreferenceRef.current,
        inspectorOpen: inspectorOpenPreferenceRef.current,
        sidebarView,
        sessionOrder,
        collapsedProjects,
        pinnedItems,
        automationSectionCollapsed,
        columnOrder: DEFAULT_COLUMN_ORDER,
        scratchCollapsed,
        scratchWidth,
        fileBrowserOpen: sidebarView === "files",
        selection,
        editingFile,
        diffFile,
        ...(windowLayout ? { window: windowLayout } : {}),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [
    sidebarWidth,
    inspectorWidth,
    sidebarOpen,
    inspectorOpen,
    sidebarView,
    sessionOrder,
    collapsedProjects,
    pinnedItems,
    automationSectionCollapsed,
    scratchCollapsed,
    scratchWidth,
    selection,
    editingFile,
    diffFile,
    windowLayout,
    saveLayoutPreferences,
  ]);

  const loadAutomations = useCallback(async () => {
    try {
      const [records, runRecords] = await Promise.all([
        dashboardBackend.automations.list(),
        dashboardBackend.automations.listRuns(null),
      ]);
      const nextAutomations = records.map(automationFromRecord);
      const automationsById = new Map(
        nextAutomations.map((automation) => [automation.id, automation]),
      );
      const nextRuns = runRecords.map((run) =>
        automationRunFromRecord(run, automationsById.get(run.automationId)),
      );

      setAutomations(nextAutomations);
      setAutomationRuns(nextRuns);
      setAutomationError(null);
      setSelection((current) => {
        if (current?.kind !== "automation" || !current.id || automationsById.has(current.id)) {
          return current;
        }
        return nextAutomations[0] ? { kind: "automation", id: nextAutomations[0].id } : null;
      });
      return nextAutomations;
    } catch (err) {
      setAutomationError(String(err));
      return automationsRef.current;
    }
  }, []);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  const openSettings = useCallback((section: SettingsSectionId = "general") => {
    setCommandPaletteOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const resetDashboardLayout = useCallback(async () => {
    const confirmed = await dashboardBackend.dialog.confirm({
      title: "Reset dashboard layout?",
      message: "This restores panel widths, the Workspaces view, Git visibility, and the Scratch panel. Your sessions and connection settings stay unchanged.",
    });
    if (!confirmed) return;

    await requestEditorNavigation(() => {
      sidebarOpenPreferenceRef.current = true;
      inspectorOpenPreferenceRef.current = true;
      setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
      setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
      panelWidthsRef.current = {
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
      };
      setSidebarView("workspaces");
      setScratchCollapsed(true);
      setScratchWidth(DEFAULT_SCRATCH_PANEL_WIDTH);
      setAutomationSectionCollapsed(true);
      setEditingFile(null);
      setDiffFile(null);
      if (viewportTier === "compact") {
        setSidebarOpen(false);
        setInspectorOpen(false);
      } else if (viewportTier === "drawer") {
        setSidebarOpen(true);
        setInspectorOpen(false);
      } else {
        setSidebarOpen(true);
        setInspectorOpen(true);
      }
      setLayoutResetMessage("Layout restored to defaults.");
    });
  }, [dashboardBackend, requestEditorNavigation, viewportTier]);

  useEffect(() => {
    const handleSettingsShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        showNewWorktree ||
        showNewTerminal ||
        !event.metaKey ||
        event.key !== ","
      ) {
        return;
      }
      event.preventDefault();
      openSettings(settingsOpen ? settingsSection : "general");
    };
    window.addEventListener("keydown", handleSettingsShortcut);
    return () => window.removeEventListener("keydown", handleSettingsShortcut);
  }, [openSettings, settingsOpen, settingsSection, showNewTerminal, showNewWorktree]);

  useEffect(() => {
    mobileRelay.setPopoverOpen(settingsOpen && settingsSection === "connections");
  }, [mobileRelay.setPopoverOpen, settingsOpen, settingsSection]);

  const anyModalOpen =
    showNewWorktree ||
    showNewTerminal ||
    settingsOpen ||
    commandPaletteOpen;
  const activeDrawer: DashboardDrawer =
    viewportTier === "compact"
      ? sidebarOpen
        ? "sidebar"
        : inspectorOpen
          ? "inspector"
          : null
      : viewportTier === "drawer" && inspectorOpen
        ? "inspector"
        : null;
  const workspaceInteractionBlocked = anyModalOpen || activeDrawer !== null;

  const sessionOrderRef = useRef(sessionOrder);
  sessionOrderRef.current = sessionOrder;

  const allTerminals = useMemo(() => {
    const persistedKeys = new Set(terminals.map(terminalSessionKey));
    return [
      ...terminals,
      ...discoveredTerminals
        .filter((terminal) => !isLocalDiscoveredInternalTerminal(terminal))
        .filter((terminal) => !persistedKeys.has(terminalSessionKey(terminal)))
        .map(normalizePlainTerminal),
    ];
  }, [terminals, discoveredTerminals]);

  const catalogSelectionResolution = useMemo(
    () => reconcileCatalogSelection({
      selection,
      pendingSelection: pendingCatalogSelection,
      hydration: {
        refreshGeneration: catalogRefreshGeneration,
        terminalPersistenceGeneration: terminalPersistenceHydrationGeneration,
        hostGeneration: hostsHydrationGeneration,
      },
      sessions,
      terminals: allTerminals,
      hostIds: new Set(hosts.map((host) => host.id)),
      failedSessionHostIds: new Set(failedSessionHostIds),
      failedTerminalHostIds: new Set(failedTerminalHostIds),
    }),
    [
      allTerminals,
      catalogRefreshGeneration,
      hosts,
      hostsHydrationGeneration,
      failedSessionHostIds,
      failedTerminalHostIds,
      pendingCatalogSelection,
      selection,
      sessions,
      terminalPersistenceHydrationGeneration,
    ],
  );

  useEffect(() => {
    if (pendingCatalogSelection !== catalogSelectionResolution.pendingSelection) {
      setPendingCatalogSelection(catalogSelectionResolution.pendingSelection);
    }
    if (!sameCatalogSelection(selection, catalogSelectionResolution.selection)) {
      setSelection(catalogSelectionResolution.selection);
    }
  }, [catalogSelectionResolution, pendingCatalogSelection, selection]);

  const selectedSession =
    selection?.kind === "session"
      ? sessions.find((session) => session.name === selection.name) ?? null
      : null;
  const selectedTerminal =
    selection?.kind === "terminal"
      ? allTerminals.find((terminal) => terminal.id === selection.id) ?? null
      : null;
  const selectionMetadataPending = catalogSelectionResolution.metadataPending;

  useEffect(() => {
    const names = [
      ...sessions.map((session) => session.name),
      ...allTerminals.map(terminalSessionKey),
    ];
    const live = new Set(names);
    tmuxPreviewLiveRef.current = live;
    for (const name of Array.from(tmuxPreviewRequested.current)) {
      if (!live.has(name)) tmuxPreviewRequested.current.delete(name);
    }
    setTmuxPreviews((prev) => {
      const next: Record<string, string> = {};
      for (const [name, history] of Object.entries(prev)) {
        if (live.has(name)) next[name] = history;
      }
      return sameStringRecord(prev, next) ? prev : next;
    });

    (async () => {
      for (const name of names) {
        if (tmuxPreviewRequested.current.has(name)) continue;
        tmuxPreviewRequested.current.add(name);
        const history = await dashboardBackend.sessions
          .captureHistory(name, PRELOAD_HISTORY_LINES)
          .catch(() => "");
        if (!tmuxPreviewLiveRef.current.has(name)) {
          tmuxPreviewRequested.current.delete(name);
          continue;
        }
        setTmuxPreviews((prev) => (
          prev[name] === history ? prev : { ...prev, [name]: history }
        ));
      }
    })();
  }, [sessions, allTerminals]);

  const refresh = useCallback(async () => {
    const refreshGeneration = ++catalogRefreshGenerationRef.current.started;
    try {
      const snapshot = dashboardBackend.catalog
        ? await dashboardBackend.catalog.list()
        : await Promise.all([
          dashboardBackend.sessions.list(),
          dashboardBackend.terminals.listTmux(),
        ]).then(([nextSessions, nextTerminals]) => ({
          sessions: nextSessions,
          terminals: nextTerminals,
          failedSessionHostIds: [],
          failedTerminalHostIds: [],
        }));
      if (refreshGeneration < catalogRefreshGenerationRef.current.successful) return;
      const mergedCatalog = mergeDashboardCatalogSnapshot(
        sessionsRef.current,
        discoveredTerminalsRef.current,
        snapshot,
      );
      const list = mergedCatalog.sessions;
      const discovered = mergedCatalog.terminals;
      const order = sessionOrderRef.current;
      const orderMap = new Map(order.map((n, i) => [n, i]));
      list.sort((a, b) => {
        const ai = orderMap.get(a.name) ?? Infinity;
        const bi = orderMap.get(b.name) ?? Infinity;
        return ai - bi;
      });
      const nowSeconds = Date.now() / 1000;
      const previousActivity = sessionActivityRef.current;
      const nextActivity = new Map<string, PreviousSessionActivity>();
      const nextActivityInfo: Record<string, SessionActivityInfo> = {};
      for (const session of list) {
        const activity = describeSessionActivity(
          {
            name: session.name,
            outputSignature: session.output_signature ?? null,
            agentRunning: session.agent_running ?? null,
          },
          previousActivity.get(session.name),
          nowSeconds,
        );
        nextActivityInfo[session.name] = activity;
        nextActivity.set(session.name, {
          outputSignature: activity.outputSignature,
          lastChangedAt: activity.lastChangedAt,
        });
      }
      sessionActivityRef.current = nextActivity;
      const nextDiscoveredTerminals = discovered.map((terminal) => ({ ...terminal, discovered: true }));
      catalogRefreshGenerationRef.current.successful = refreshGeneration;
      setFailedSessionHostIds(snapshot.failedSessionHostIds);
      setFailedTerminalHostIds(snapshot.failedTerminalHostIds);
      setSessionActivity((prev) => sameSessionActivity(prev, nextActivityInfo) ? prev : nextActivityInfo);
      setSessions((prev) => sameSessions(prev, list) ? prev : list);
      setDiscoveredTerminals((prev) => samePlainTerminals(prev, nextDiscoveredTerminals) ? prev : nextDiscoveredTerminals);
      setCatalogRefreshGeneration(refreshGeneration);
      setError(mergedCatalog.partialError);
      const live = new Set(list.map((s) => s.name));
      setOpenedSessions((prev) => {
        const next = prev.filter((n) => live.has(n));
        return sameStringArray(prev, next) ? prev : next;
      });
      setCwdsBySession((prev) => {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (live.has(k)) next[k] = v;
        }
        return sameStringRecord(prev, next) ? prev : next;
      });
    } catch (e) {
      setError(String(e));
    }
  }, [dashboardBackend]);

  useVisibilityAwarePolling(refresh, {
    visibleIntervalMs: REFRESH_MS,
    hiddenIntervalMs: HIDDEN_REFRESH_MS,
  });

  const handleAutomationCreate = useCallback(
    async (draft: AutomationDraft) => {
      const originatingDraft = {
        contextKey: automationDirtySnapshotRef.current.fileKey,
        revision: automationDirtySnapshotRef.current.revision,
      };
      const record = await dashboardBackend.automations.save(
        automationSaveInputFromDraft(draft),
      );
      const automation = automationFromRecord(record);
      if (!automationSubmitStillOwnsDraft(originatingDraft, {
        contextKey: automationDirtySnapshotRef.current.fileKey,
        revision: automationDirtySnapshotRef.current.revision,
      })) {
        await loadAutomations();
        return;
      }
      await requestEditorNavigation(() => {
        setEditingFile(null);
        setDiffFile(null);
        setSelection({ kind: "automation", id: automation.id });
      }, { ignoreAutomationDirty: true });
      await loadAutomations();
    },
    [loadAutomations, requestEditorNavigation],
  );

  const handleAutomationSave = useCallback(
    async (id: string, draft: AutomationDraft) => {
      const originatingDraft = {
        contextKey: automationDirtySnapshotRef.current.fileKey,
        revision: automationDirtySnapshotRef.current.revision,
      };
      const record = await dashboardBackend.automations.save(
        automationSaveInputFromDraft(draft, id),
      );
      const automation = automationFromRecord(record);
      if (!automationSubmitStillOwnsDraft(originatingDraft, {
        contextKey: automationDirtySnapshotRef.current.fileKey,
        revision: automationDirtySnapshotRef.current.revision,
      })) {
        await loadAutomations();
        return;
      }
      await requestEditorNavigation(() => {
        setEditingFile(null);
        setDiffFile(null);
        setSelection({ kind: "automation", id: automation.id });
      }, { ignoreAutomationDirty: true });
      await loadAutomations();
    },
    [loadAutomations, requestEditorNavigation],
  );

  const handleAutomationToggle = useCallback(
    async (id: string, active: boolean) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      if (!automation) return;
      await dashboardBackend.automations.save(
        automationSaveInputFromDraft(
          { ...createAutomationDraft(automation), active },
          id,
        ),
      );
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationDelete = useCallback(
    async (id: string) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      const confirmed = await dashboardBackend.dialog.confirm({
        title: "Delete automation?",
        message: `This will remove ${automation?.name || "this automation"} and stop its future scheduled runs.`,
      });
      if (!confirmed) return;
      await dashboardBackend.automations.delete(id);
      setAutomationRuns((prev) => prev.filter((run) => run.automationId !== id));
      setSelection((current) =>
        current?.kind === "automation" && current.id === id ? { kind: "automation", id: "" } : current,
      );
      await loadAutomations();
    },
    [dashboardBackend, loadAutomations],
  );

  const handleAutomationRun = useCallback(
    async (id: string) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      const runRecord = await dashboardBackend.automations.trigger(id);
      const run = automationRunFromRecord(runRecord, automation);
      setAutomationRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)]);
      await Promise.all([loadAutomations(), refresh()]);
    },
    [loadAutomations, refresh],
  );

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const minute = now.toISOString().slice(0, 16);
      for (const automation of automationsRef.current) {
        if (!shouldRunAutomationSchedule(automation, now)) continue;
        const key = `${automation.id}:${minute}`;
        if (scheduledAutomationMinuteRef.current.has(key)) continue;
        scheduledAutomationMinuteRef.current.add(key);
        void handleAutomationRun(automation.id).catch((err) => {
          setAutomationError(String(err));
        });
      }
    };

    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [handleAutomationRun]);

  // Lazily attach live PTYs; startup preloads snapshots instead.
  useEffect(() => {
    if (selection?.kind !== "session") return;
    if (!selectedSession || selectionMetadataPending) return;
    const name = selection.name;
    setOpenedSessions((prev) =>
      prev.includes(name) ? prev : [...prev, name],
    );
    if (cwdsBySession[name] || cwdRequested.current.has(name)) return;
    cwdRequested.current.add(name);
    dashboardBackend.sessions.root(name)
      .then((cwd) => {
        if (cwd) setCwdsBySession((prev) => ({ ...prev, [name]: cwd }));
      })
      .catch(() => {})
      .finally(() => {
        cwdRequested.current.delete(name);
      });
  }, [dashboardBackend, selection, selectedSession, selectionMetadataPending, cwdsBySession]);

  // Lazily attach plain tmux terminals too.
  useEffect(() => {
    if (selection?.kind !== "terminal") return;
    if (!selectedTerminal || selectionMetadataPending) return;
    const id = selection.id;
    setOpenedTerminals((prev) =>
      prev.includes(id) ? prev : [...prev, id],
    );
  }, [selection, selectedTerminal, selectionMetadataPending]);

  useEffect(() => {
    const liveTerminalIds = new Set(allTerminals.map((terminal) => terminal.id));
    setOpenedTerminals((prev) => {
      const next = prev.filter((id) => liveTerminalIds.has(id));
      return sameStringArray(prev, next) ? prev : next;
    });
  }, [allTerminals]);

  // Resolve current cwd for selected item
  const selectedAutomation =
    selection?.kind === "automation"
      ? automations.find((automation) => automation.id === selection.id) ?? null
      : null;
  const selectedAutomationProjectPath =
    selectedAutomation?.project.trim()
      ? projectPresets.find((project) => project.name === selectedAutomation.project)?.path.trim() || null
      : null;
  const selectedSessionIsRemote = !!selectedSession?.hostId;
  const selectedGitHostId =
    selectionMetadataPending
      ? null
      : selection?.kind === "session"
      ? selectedSession?.hostId ?? null
      : selection?.kind === "terminal"
        ? selectedTerminal?.hostId ?? null
        : null;
  const selectedCwd: string | null =
    selectionMetadataPending
      ? null
      : selection?.kind === "session"
      ? cwdsBySession[selection.name] ?? null
      : selection?.kind === "terminal"
        ? selectedTerminal?.cwd ?? null
        : selection?.kind === "automation"
          ? selectedAutomation?.path || selectedAutomationProjectPath
          : null;

  const desktopRoot = homeDir ? `${homeDir.replace(/\/+$/, "")}/Desktop` : null;
  const fileBrowserRoot =
    !selection
      ? null
      : selection.kind === "automation"
      ? selectedCwd ?? desktopRoot
      : selectedGitHostId
        ? selectedCwd
        : selectedCwd ?? homeDir ?? "/";

  useEffect(() => {
    let current = true;
    setWorkspaceBranch(null);
    if (
      selectionMetadataPending ||
      !selectedCwd ||
      (selection?.kind !== "session" && selection?.kind !== "terminal")
    ) {
      return () => {
        current = false;
      };
    }
    void dashboardBackend.git.status(selectedCwd, selectedGitHostId)
      .then((status) => {
        if (current) setWorkspaceBranch(status?.branch || null);
      })
      .catch(() => {
        if (current) setWorkspaceBranch(null);
      });
    return () => {
      current = false;
    };
  }, [
    dashboardBackend.git,
    selectedCwd,
    selectedGitHostId,
    selection,
    selectionMetadataPending,
  ]);

  const projectPresetForSession = useCallback(
    (sessionName: string): string | null => {
      const key = projectKey(sessionName);
      return projectPresets.some((project) => project.name === key) ? key : null;
    },
    [projectPresets],
  );

  useEffect(() => {
    if ((selection?.kind === "session" || selection?.kind === "terminal") && selectedCwd && !selectedGitHostId) {
      setLastAutomationContextPath(selectedCwd);
      setLastAutomationContextProject(
        selection.kind === "session" ? projectPresetForSession(selection.name) : null,
      );
    }
  }, [projectPresetForSession, selection, selectedCwd, selectedGitHostId]);

  const handleNewAutomation = useCallback(() => requestEditorNavigation(() => {
    if (selection?.kind === "session" || selection?.kind === "terminal") {
      automationReturnSelectionRef.current = selection;
    }
    if ((selection?.kind === "session" || selection?.kind === "terminal") && selectedCwd && !selectedGitHostId) {
      setLastAutomationContextPath(selectedCwd);
      setLastAutomationContextProject(
        selection.kind === "session" ? projectPresetForSession(selection.name) : null,
      );
    } else if (
      selection?.kind === "session" &&
      !selectionMetadataPending &&
      !selectedSessionIsRemote
    ) {
      const name = selection.name;
      void dashboardBackend.sessions.root(name)
        .then((cwd) => {
          if (cwd) {
            setLastAutomationContextPath(cwd);
            setLastAutomationContextProject(projectPresetForSession(name));
          }
        })
        .catch(() => {});
    }
    setEditingFile(null);
    setDiffFile(null);
    setInspectorOpen(false);
    setSelection({ kind: "automation", id: "" });
  }), [
    dashboardBackend,
    projectPresetForSession,
    requestEditorNavigation,
    selection,
    selectedCwd,
    selectedGitHostId,
    selectedSessionIsRemote,
    selectionMetadataPending,
  ]);

  const handleOpenFile = useCallback(
    (path: string, line?: number, col?: number, hostId?: string | null) => {
      const nextFile: EditingFile = {
        path,
        hostId: hostId ?? null,
        ...(line && line > 0 ? { line } : {}),
        ...(col && col > 0 ? { column: col } : {}),
      };
      if (
        editingFileSourceKey(editingFileRef.current) ===
        editingFileSourceKey(nextFile)
      ) {
        if (nextFile.line !== undefined) {
          // Replace the location as one unit so a line-only jump cannot retain
          // the column from a previous result. The revision also lets an exact
          // repeated jump move the cursor back after the user has navigated.
          setEditingFile(nextFile);
          setEditorNavigationRevision((current) => current + 1);
        }
        return Promise.resolve(true);
      }
      return requestEditorNavigation(() => {
        setDiffFile(null);
        setEditingFile(nextFile);
      });
    },
    [requestEditorNavigation],
  );

  const closeEditingFile = useCallback(
    () => requestEditorNavigation(() => setEditingFile(null)),
    [requestEditorNavigation],
  );

  const selectionKey =
    selection?.kind === "session"
      ? `s:${selection.name}`
      : selection?.kind === "terminal"
        ? `t:${selection.id}`
        : null;

  const ensureScratch = useCallback((key: string) => {
    setScratchTerminals((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, {
        list: [{ id: `scratch-${++scratchIdCounter}`, label: "zsh 1" }],
        nextNum: 2,
      });
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectionKey) ensureScratch(selectionKey);
  }, [selectionKey, ensureScratch]);

  const addScratchTerminal = useCallback(() => {
    if (!selectionKey) return;
    setScratchTerminals((prev) => {
      const state = prev.get(selectionKey) ?? { list: [], nextNum: 1 };
      const num = state.nextNum;
      const next = new Map(prev);
      next.set(selectionKey, {
        list: [...state.list, { id: `scratch-${++scratchIdCounter}`, label: `zsh ${num}` }],
        nextNum: num + 1,
      });
      return next;
    });
    // Reset inline flex so all sections share space equally
    const container = scratchSectionsRef.current;
    if (container) {
      for (const child of Array.from(container.children) as HTMLElement[]) {
        child.style.flex = "";
      }
    }
  }, [selectionKey]);

  const removeScratchTerminal = useCallback((scratchId: string) => {
    if (!selectionKey) return;
    setScratchTerminals((prev) => {
      const state = prev.get(selectionKey);
      if (!state || state.list.length <= 1) return prev;
      const next = new Map(prev);
      next.set(selectionKey, {
        ...state,
        list: state.list.filter((s) => s.id !== scratchId),
      });
      return next;
    });
    // Reset inline flex so remaining sections share space equally
    const container = scratchSectionsRef.current;
    if (container) {
      for (const child of Array.from(container.children) as HTMLElement[]) {
        child.style.flex = "";
      }
    }
  }, [selectionKey]);

  const startScratchSplit = (index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const container = scratchSectionsRef.current;
    if (!container) return;
    const sections = Array.from(container.children) as HTMLElement[];
    if (index < 1 || index >= sections.length) return;
    const prevSection = sections[index - 1];
    const currSection = sections[index];
    const startY = e.clientY;
    const startPrevH = prevSection.getBoundingClientRect().height;
    const startCurrH = currSection.getBoundingClientRect().height;
    const totalH = startPrevH + startCurrH;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const newPrevH = Math.max(60, Math.min(totalH - 60, startPrevH + dy));
      const newCurrH = totalH - newPrevH;
      prevSection.style.flex = `0 0 ${newPrevH}px`;
      currSection.style.flex = `0 0 ${newCurrH}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const openScratch = useCallback(() => {
    setInspectorOpen(false);
    setScratchCollapsed(false);
  }, []);

  const startScratchResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startWidth = scratchWidth;
    const containerWidth = dashboardWorkspaceRef.current?.getBoundingClientRect().width;
    target.setPointerCapture?.(event.pointerId);
    document.body.dataset.dashboardResizing = "scratch";

    const handlePointerMove = (nextEvent: globalThis.PointerEvent) => {
      setScratchWidth(
        scratchPanelWidthFromPointer(
          startWidth,
          nextEvent.clientX - startX,
          containerWidth,
        ),
      );
    };
    const finish = () => {
      if (target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      delete document.body.dataset.dashboardResizing;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [scratchWidth]);

  const resizeScratchFromKeyboard = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const containerWidth = dashboardWorkspaceRef.current?.getBoundingClientRect().width;
    const next = scratchPanelWidthFromKey(
      scratchWidth,
      event.key,
      event.shiftKey,
      containerWidth,
    );
    if (next === null) return;
    event.preventDefault();
    setScratchWidth(next);
  }, [scratchWidth]);

  const togglePinned = useCallback((item: PinnedItem) => {
    const key = item.kind === "session" ? `session:${item.name}` : `terminal:${item.id}`;
    setPinnedItems((current) => {
      const exists = current.some((candidate) => (
        candidate.kind === "session"
          ? `session:${candidate.name}`
          : `terminal:${candidate.id}`
      ) === key);
      return exists
        ? current.filter((candidate) => (
            candidate.kind === "session"
              ? `session:${candidate.name}`
              : `terminal:${candidate.id}`
          ) !== key)
        : [...current, item];
    });
  }, []);

  const toggleProjectCollapsed = (projectKey: string) => {
    setCollapsedProjects((prev) =>
      prev.includes(projectKey)
        ? prev.filter((item) => item !== projectKey)
        : [...prev, projectKey],
    );
  };

  const selectSession = useCallback(
    (name: string) => requestEditorNavigation(() => {
      setPendingCatalogSelection(null);
      setSelection({ kind: "session", name });
      setEditingFile(null);
      setDiffFile(null);
      if (viewportTier === "compact") setSidebarOpen(false);
    }),
    [requestEditorNavigation, viewportTier],
  );

  const selectTerminal = useCallback(
    (id: string) => requestEditorNavigation(() => {
      setPendingCatalogSelection(null);
      setSelection({ kind: "terminal", id });
      setEditingFile(null);
      setDiffFile(null);
      if (viewportTier === "compact") setSidebarOpen(false);
    }),
    [requestEditorNavigation, viewportTier],
  );

  const selectAutomation = useCallback(
    (id: string) => {
      if (
        automationSelectionIsCurrent(
          selection?.kind === "automation" ? selection.id : null,
          id,
          editingFileRef.current !== null,
          diffFile !== null,
        )
      ) {
        if (viewportTier === "compact") setSidebarOpen(false);
        return Promise.resolve(false);
      }
      return requestEditorNavigation(() => {
        if (selection?.kind === "session" || selection?.kind === "terminal") {
          automationReturnSelectionRef.current = selection;
        }
        setPendingCatalogSelection(null);
        setSelection({ kind: "automation", id });
        setEditingFile(null);
        setDiffFile(null);
        setInspectorOpen(false);
        if (viewportTier === "compact") setSidebarOpen(false);
      });
    },
    [diffFile, requestEditorNavigation, selection, viewportTier],
  );

  const returnFromAutomationManager = useCallback(() => requestEditorNavigation(() => {
    const remembered = automationReturnSelectionRef.current;
    const validRemembered = remembered?.kind === "session"
      ? sessions.some((session) => session.name === remembered.name)
      : remembered?.kind === "terminal"
        ? allTerminals.some((terminal) => terminal.id === remembered.id)
        : false;
    const fallback: Selection = sessions[0]
      ? { kind: "session", name: sessions[0].name }
      : allTerminals[0]
        ? { kind: "terminal", id: allTerminals[0].id }
        : null;
    setSelection(validRemembered ? remembered : fallback);
    setEditingFile(null);
    setDiffFile(null);
  }), [allTerminals, requestEditorNavigation, sessions]);

  const closeSession = useCallback(async (name: string) => {
    try {
      const session = sessions.find((candidate) => candidate.name === name);
      const confirmed = await dashboardBackend.dialog.confirm({
        title: "Close worktree session?",
        message:
          `This will stop the tmux session for ${session ? sessionDisplayName(session) : name}. ` +
          "The worktree and its files will not be deleted.",
      });
      if (!confirmed) return;
      await dashboardBackend.sessions.kill(name);
      setSessions((current) => current.filter((session) => session.name !== name));
      setOpenedSessions((current) => current.filter((sessionName) => sessionName !== name));
      setSessionOrder((current) => current.filter((sessionName) => sessionName !== name));
      setPinnedItems((current) => current.filter((item) => item.kind !== "session" || item.name !== name));
      setSelection((current) => {
        if (current?.kind !== "session" || current.name !== name) return current;
        const remainingSession = sessions.find((session) => session.name !== name);
        if (remainingSession) return { kind: "session", name: remainingSession.name };
        const remainingTerminal = allTerminals[0];
        return remainingTerminal ? { kind: "terminal", id: remainingTerminal.id } : null;
      });
    } catch (nextError) {
      setError(String(nextError));
    }
  }, [allTerminals, dashboardBackend, sessions]);

  const closeTerminal = useCallback(async (id: string) => {
    const terminal = allTerminals.find((candidate) => candidate.id === id);
    if (!terminal) return;
    const sessionKey = terminalSessionKey(terminal);
    try {
      const confirmed = await dashboardBackend.dialog.confirm({
        title: "Close terminal?",
        message: `This will stop the tmux session for ${terminal.label}.`,
      });
      if (!confirmed) return;
      if (terminal.discovered) {
        await dashboardBackend.sessions.kill(sessionKey);
        setDiscoveredTerminals((current) => current.filter((candidate) => candidate.id !== id));
      } else {
        await dashboardBackend.terminals.kill(sessionKey);
        setTerminals((current) => current.filter((candidate) => candidate.id !== id));
      }
      setOpenedTerminals((current) => current.filter((terminalId) => terminalId !== id));
      setPinnedItems((current) => current.filter((item) => item.kind !== "terminal" || item.id !== id));
      setSelection((current) => {
        if (current?.kind !== "terminal" || current.id !== id) return current;
        const remainingTerminal = allTerminals.find((candidate) => candidate.id !== id);
        if (remainingTerminal) return { kind: "terminal", id: remainingTerminal.id };
        const remainingSession = sessions[0];
        return remainingSession ? { kind: "session", name: remainingSession.name } : null;
      });
    } catch (nextError) {
      setError(String(nextError));
    }
  }, [allTerminals, dashboardBackend, sessions]);

  useEffect(() => {
    const handleNewWorktreeShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const targetConsumesText =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        targetConsumesText ||
        anyModalOpen ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "n"
      ) {
        return;
      }
      event.preventDefault();
      setShowNewWorktree(true);
    };
    window.addEventListener("keydown", handleNewWorktreeShortcut);
    return () => window.removeEventListener("keydown", handleNewWorktreeShortcut);
  }, [anyModalOpen]);

  const openFiles = useCallback(() => {
    sidebarOpenPreferenceRef.current = true;
    setSidebarView("files");
    setSidebarOpen(true);
    if (viewportTier !== "wide") setInspectorOpen(false);
  }, [viewportTier]);

  const openGit = useCallback(() => {
    setScratchCollapsed(true);
    inspectorOpenPreferenceRef.current = true;
    setInspectorOpen(true);
    if (viewportTier === "compact") setSidebarOpen(false);
  }, [viewportTier]);

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const actions: CommandPaletteItem[] = [
      {
        id: "action-new-worktree",
        group: "actions",
        label: "New worktree",
        detail: "Create a managed worktree and tmux session",
        keywords: ["create", "session", "branch"],
        shortcut: ["⌘", "N"],
        execute: () => setShowNewWorktree(true),
      },
      {
        id: "action-new-terminal",
        group: "actions",
        label: "New terminal",
        detail: "Open a local or SSH terminal",
        keywords: ["shell", "tmux", "ssh"],
        execute: () => setShowNewTerminal(true),
      },
      {
        id: "action-new-automation",
        group: "actions",
        label: "New automation",
        detail: "Configure a dashboard automation",
        keywords: ["schedule", "run"],
        execute: handleNewAutomation,
      },
    ];

    const navigate: CommandPaletteItem[] = [
      {
        id: "navigate-files",
        group: "navigate" as const,
        label: "Open file explorer",
        detail: "Keep the workspace tree beside the editor",
        keywords: ["files", "tree", "explorer", "edit"],
        disabledReason: fileBrowserRoot
          ? undefined
          : "Select a workspace first",
        execute: openFiles,
      },
      {
        id: "navigate-git-inspector",
        group: "navigate" as const,
        label: "Open Git inspector",
        detail: "Status, history, and changed files for the active workspace",
        keywords: ["git", "changes", "diff", "history"],
        disabledReason:
          selection?.kind === "session" || selection?.kind === "terminal"
            ? undefined
            : "Select a worktree or terminal first",
        execute: openGit,
      },
      ...(selection?.kind === "session" || selection?.kind === "terminal"
        ? [{
            id: "navigate-toggle-current-pin",
            group: "navigate" as const,
            label: pinnedItems.some((item) => (
              selection.kind === "session"
                ? item.kind === "session" && item.name === selection.name
                : item.kind === "terminal" && item.id === selection.id
            )) ? "Unpin current workspace" : "Pin current workspace",
            detail: "Keep this workspace in the Pinned section",
            keywords: ["pin", "favorite", "workspace"],
            execute: () => togglePinned(selection),
          }]
        : []),
      ...sessions.map((session) => {
        const host = session.hostId
          ? hosts.find((candidate) => candidate.id === session.hostId)
          : null;
        return {
          id: `navigate-session-${session.name}`,
          group: "navigate" as const,
          label: sessionDisplayName(session),
          detail: [host?.label ?? session.hostId, session.project].filter(Boolean).join(" · ") || "Local worktree",
          keywords: ["worktree", "session", session.name, session.project ?? ""],
          execute: () => {
            void selectSession(session.name);
          },
        };
      }),
      ...allTerminals.map((terminal) => ({
        id: `navigate-terminal-${terminal.id}`,
        group: "navigate" as const,
        label: terminal.label,
        detail: terminal.hostId ? `SSH · ${terminal.cwd}` : terminal.cwd,
        keywords: ["terminal", "shell", terminal.tmuxName],
        execute: () => {
          void selectTerminal(terminal.id);
        },
      })),
    ];

    const automationCommands: CommandPaletteItem[] = automations.map((automation) => ({
      id: `automation-run-${automation.id}`,
      group: "automation",
      label: `Run ${automation.name || "unnamed automation"}`,
      detail: triggerLabel(automation),
      keywords: ["run", "schedule", automation.name],
      disabledReason: automation.active ? undefined : "Automation is paused",
      execute: () => handleAutomationRun(automation.id),
    }));

    const recentSessionNames = openedSessions.slice(-4).reverse();
    const recentTerminalIds = openedTerminals.slice(-4).reverse();
    const recent: CommandPaletteItem[] = [
      ...recentSessionNames.flatMap((name) => {
        const session = sessions.find((candidate) => candidate.name === name);
        return session
          ? [{
              id: `recent-session-${name}`,
              group: "recent" as const,
              label: sessionDisplayName(session),
              detail: "Recently opened worktree",
              execute: () => {
                void selectSession(name);
              },
            }]
          : [];
      }),
      ...recentTerminalIds.flatMap((id) => {
        const terminal = allTerminals.find((candidate) => candidate.id === id);
        return terminal
          ? [{
              id: `recent-terminal-${id}`,
              group: "recent" as const,
              label: terminal.label,
              detail: "Recently opened terminal",
              execute: () => {
                void selectTerminal(id);
              },
            }]
          : [];
      }),
    ];

    const settings: CommandPaletteItem[] = [
      {
        id: "settings-connections",
        group: "settings",
        label: "Manage connections…",
        detail: "SSH Hosts and Mobile Relay",
        keywords: ["settings", "host", "ssh", "relay"],
        execute: () => openSettings("connections"),
      },
      {
        id: "settings-appearance",
        group: "settings",
        label: "Appearance settings…",
        detail: "Dashboard and terminal presentation",
        keywords: ["theme", "font", "density"],
        execute: () => openSettings("appearance"),
      },
      {
        id: "settings-advanced",
        group: "settings",
        label: "Advanced settings…",
        detail: "Reset dashboard layout",
        keywords: ["layout", "reset", "panels"],
        execute: () => openSettings("advanced"),
      },
    ];

    return [...actions, ...navigate, ...automationCommands, ...recent, ...settings];
  }, [
    allTerminals,
    automations,
    handleAutomationRun,
    handleNewAutomation,
    hosts,
    fileBrowserRoot,
    openFiles,
    openGit,
    openSettings,
    openedSessions,
    openedTerminals,
    selectSession,
    selectTerminal,
    selection,
    sessions,
    pinnedItems,
    togglePinned,
  ]);
  const relaySettingsBindings = relaySettingsBindingsFromController(mobileRelay);

  const selectedHostId =
    selectedSession?.hostId ?? selectedTerminal?.hostId ?? null;
  const selectedHost = selectedHostId
    ? hosts.find((host) => host.id === selectedHostId) ?? null
    : null;
  const selectedActivity =
    selection?.kind === "session" ? sessionActivity[selection.name] : null;
  const selectedHostStatus = selectedHostId ? hostStatuses[selectedHostId] : null;

  const workspaceStatus: WorkspaceStatus = (() => {
    if (selectionMetadataPending) return "reconnecting";
    if (selectedHostId && selectedHostStatus && !selectedHostStatus.reachable) return "offline";
    if (selectedHostId && !selectedHostStatus) return "reconnecting";
    if (selection?.kind === "automation") {
      if (selectedAutomation?.status === "running") return "running";
      if (selectedAutomation?.status === "queued") return "waiting";
      if (selectedAutomation?.status === "failed" || !selectedAutomation?.active) return "stopped";
      return selectedAutomation ? "waiting" : "unknown";
    }
    if (selection?.kind === "terminal") return selectedTerminal ? "running" : "unknown";
    if (selectedActivity?.state === "running") return "running";
    if (selectedActivity?.state === "stopped") return "stopped";
    if (selectedSession && !selectedCwd) return "waiting";
    return selectedSession ? "unknown" : "stopped";
  })();

  const workspaceTitle =
    selectionMetadataPending && selection?.kind === "session"
      ? selection.name
      : selectionMetadataPending && selection?.kind === "terminal"
        ? "Loading terminal…"
        : editingFile
          ? basenameFromPath(editingFile.path) || editingFile.path
          : diffFile
            ? basenameFromPath(diffFile.path) || diffFile.path
            : selectedSession
              ? sessionDisplayName(selectedSession)
              : selectedTerminal?.label
                ? selectedTerminal.label
                : selectedAutomation?.name || "No workspace selected";
  const workspaceProject =
    selectedSession?.project?.trim() ||
    selectedAutomation?.project?.trim() ||
    null;

  const openGitDiff = useCallback(
    (path: string, cwd: string, hostId?: string | null) =>
      requestEditorNavigation(() => {
        setEditingFile(null);
        setDiffFile({ path, cwd, hostId: hostId ?? null });
        if (viewportTierForWidth(window.innerWidth) !== "wide") {
          setInspectorOpen(false);
        }
      }),
    [requestEditorNavigation],
  );

  const renderFiles = () =>
    selectionMetadataPending ? (
      <div className="dashboard-context-empty" role="status">
        <strong>Loading workspace details…</strong>
        <span>Files will appear after the session and host are resolved.</span>
      </div>
    ) : fileBrowserRoot ? (
      <div className="dashboard-inspector-view dashboard-inspector-view--files">
        <FileTree
          root={fileBrowserRoot}
          hostId={selectedGitHostId}
          selectedFile={
            (editingFile?.hostId ?? null) === selectedGitHostId
              ? editingFile?.path ?? null
              : null
          }
          onFileSelect={(path, hostId) => {
            void handleOpenFile(path, undefined, undefined, hostId).then((opened) => {
              if (opened && viewportTier === "compact") setSidebarOpen(false);
            });
          }}
        />
      </div>
    ) : (
      <div className="dashboard-context-empty">
        <strong>No files context</strong>
        <span>Select a worktree, terminal, or automation to browse its files.</span>
      </div>
    );

  const renderGit = () =>
    selectionMetadataPending ? (
      <div className="dashboard-context-empty" role="status">
        <strong>Loading workspace details…</strong>
        <span>Git will connect after the session and host are resolved.</span>
      </div>
    ) : (
      <div className="dashboard-inspector-view dashboard-inspector-view--git">
        <GitStatusPanel
          cwd={selectedCwd}
          sessionName={selection?.kind === "session" ? selection.name : undefined}
          hostId={selectedGitHostId}
          active={inspectorOpen && (
            selection?.kind === "session" || selection?.kind === "terminal"
          )}
          onFileClick={openGitDiff}
          onBranchChange={setWorkspaceBranch}
        />
      </div>
    );

  const renderDiff = () =>
    selectionMetadataPending ? (
      <div className="dashboard-context-empty" role="status">
        <strong>Loading workspace details…</strong>
        <span>Diff will appear after the session and host are resolved.</span>
      </div>
    ) : diffFile ? (
      <div className="dashboard-inspector-view dashboard-inspector-view--diff">
        <DiffViewer
          cwd={diffFile.cwd}
          filePath={diffFile.path}
          hostId={diffFile.hostId ?? null}
          onClose={() => {
            setDiffFile(null);
          }}
        />
      </div>
    ) : (
      <div className="dashboard-context-empty">
        <strong>No diff selected</strong>
        <span>Select a changed file from the Git inspector.</span>
      </div>
    );

  const automationPanel = (
    <AutomationPanel
      automations={automations}
      selectedId={selection?.kind === "automation" ? selection.id || null : null}
      runs={automationRuns}
      projectOptions={projectPresets}
      recentPath={lastAutomationContextPath}
      recentProject={lastAutomationContextProject}
      onSelect={selectAutomation}
      onNew={handleNewAutomation}
      onCreate={handleAutomationCreate}
      onToggle={handleAutomationToggle}
      onRun={handleAutomationRun}
      onDelete={handleAutomationDelete}
      onSave={handleAutomationSave}
      onDirtyChange={handleAutomationDirtyChange}
      showList
    />
  );

  const terminalViewVisible =
    selectionMetadataPending ||
    (!editingFile &&
      !diffFile &&
      (selection?.kind === "session" || selection?.kind === "terminal"));

  const centralWorkspace = (
    <div
      ref={dashboardWorkspaceRef}
      className="dashboard-workspace"
      data-scratch-open={!selectionMetadataPending && !scratchCollapsed && Boolean(selectionKey)}
      style={{ "--dashboard-scratch-width": `${scratchWidth}px` } as React.CSSProperties}
    >
      <section className="dashboard-workspace__primary" aria-label="Active workspace">
        <TerminalDeck
          selection={selection}
          sessions={sessions}
          terminals={allTerminals}
          hosts={hosts}
          openedSessions={openedSessions}
          openedTerminals={openedTerminals}
          cwdsBySession={cwdsBySession}
          tmuxPreviews={tmuxPreviews}
          metadataPending={selectionMetadataPending}
          visible={terminalViewVisible}
          blocked={workspaceInteractionBlocked}
          onOpenFile={handleOpenFile}
        />

        {selectionMetadataPending ? null : editingFile ? (
          <div className="dashboard-workspace__editor">
            <FileEditor
              filePath={editingFile.path}
              hostId={editingFile.hostId ?? null}
              initialLine={editingFile.line}
              initialColumn={editingFile.column}
              navigationRevision={editorNavigationRevision}
              onClose={() => void closeEditingFile()}
              onOpenFile={handleOpenFile}
              onDirtyChange={handleEditorDirtyChange}
            />
          </div>
        ) : diffFile ? (
          <div className="dashboard-workspace__editor">
            {renderDiff()}
          </div>
        ) : selection?.kind === "automation" ? (
          <div className="dashboard-workspace__expanded">
            <div className="dashboard-expanded-toolbar">
              <strong>Automations</strong>
              <button
                type="button"
                onClick={() => void returnFromAutomationManager()}
                aria-label="Back to workspace"
              >
                <X aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>Back to workspace</span>
              </button>
            </div>
            <div className="dashboard-expanded-content dashboard-workspace__automation">
              {automationPanel}
            </div>
          </div>
        ) : !selection ? (
          <div className="pane pane--empty">
            <div className="pane__hint">
              Select a worktree, terminal, or automation.
            </div>
          </div>
        ) : null}
      </section>

      <button
        className="dashboard-scratch__resize-handle"
        type="button"
        role="separator"
        aria-label="Resize Scratch panel"
        aria-controls="dashboard-scratch-panel"
        aria-orientation="vertical"
        aria-valuemin={Math.min(SCRATCH_PANEL_LIMITS.min, scratchPanelMaximumWidth(dashboardWorkspaceRef.current?.clientWidth))}
        aria-valuemax={scratchPanelMaximumWidth(dashboardWorkspaceRef.current?.clientWidth)}
        aria-valuenow={scratchWidth}
        hidden={selectionMetadataPending || scratchCollapsed || !selectionKey}
        onPointerDown={startScratchResize}
        onKeyDown={resizeScratchFromKeyboard}
      />

      <aside
        id="dashboard-scratch-panel"
        className="dashboard-scratch"
        aria-label="Scratch terminals"
        hidden={selectionMetadataPending || scratchCollapsed || !selectionKey}
      >
          <div className="dashboard-scratch__header">
            <strong>Scratch</strong>
            <div>
              <button
                type="button"
                onClick={addScratchTerminal}
                aria-label="Add scratch terminal"
                title="Add scratch terminal"
              >
                <Plus aria-hidden="true" size={15} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                onClick={() => setScratchCollapsed(true)}
                aria-label="Close scratch panel"
                title="Close scratch panel"
              >
                <X aria-hidden="true" size={15} strokeWidth={1.8} />
              </button>
            </div>
          </div>
          {Array.from(scratchTerminals.entries()).map(([key, state]) => {
            const isActive = key === selectionKey;
            const scratchContext = (() => {
              if (key.startsWith("s:")) {
                const sessionName = key.slice(2);
                const session = sessions.find((candidate) => candidate.name === sessionName);
                const cwd = cwdsBySession[sessionName] ?? null;
                if (!session || !cwd) return null;
                if (!session.hostId) return { cwd, host: null };
                const host = hosts.find((candidate) => candidate.id === session.hostId) ?? null;
                return host ? { cwd, host } : null;
              }
              if (key.startsWith("t:")) {
                const terminal = allTerminals.find((candidate) => candidate.id === key.slice(2));
                const cwd = terminal?.cwd ?? null;
                if (!cwd) return null;
                if (!terminal?.hostId) return { cwd, host: null };
                const host = hosts.find((candidate) => candidate.id === terminal.hostId) ?? null;
                return host ? { cwd, host } : null;
              }
              return null;
            })();
            if (!scratchContext) return null;
            return (
              <div
                key={key}
                className="scratch__sections"
                ref={isActive ? scratchSectionsRef : undefined}
                style={{ display: isActive ? "flex" : "none" }}
              >
                {state.list.map((scratch, index) => (
                  <div key={scratch.id} className="scratch__section">
                    {index > 0 && (
                      <button
                        className="dashboard-scratch__split-handle"
                        type="button"
                        role="separator"
                        aria-label={`Resize ${scratch.label}`}
                        aria-orientation="horizontal"
                        onMouseDown={startScratchSplit(index)}
                      />
                    )}
                    <div className="dashboard-scratch__terminal-header">
                      <span>{scratch.label}</span>
                      {state.list.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeScratchTerminal(scratch.id)}
                          aria-label={"Close " + scratch.label}
                          title={"Close " + scratch.label}
                        >
                          <X aria-hidden="true" size={13} strokeWidth={1.8} />
                        </button>
                      )}
                    </div>
                    <div className="scratch__term">
                      <Terminal
                        cmd={scratchContext.host ? "ssh" : "/bin/zsh"}
                        args={
                          scratchContext.host
                            ? buildSshShellArgs(scratchContext.host, scratchContext.cwd)
                            : ["-l"]
                        }
                        cwd={scratchContext.host ? undefined : scratchContext.cwd}
                        linkCwd={scratchContext.cwd}
                        active={isActive && !scratchCollapsed && !workspaceInteractionBlocked}
                        hostId={scratchContext.host?.id ?? null}
                        onOpenFile={handleOpenFile}
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
      </aside>
    </div>
  );

  const overlays = (
    <>
      <CommandPalette
        open={commandPaletteOpen}
        items={commandPaletteItems}
        onOpenChange={setCommandPaletteOpen}
        enableHotkey={!settingsOpen && !showNewWorktree && !showNewTerminal}
      />

      <SettingsDialog
        open={settingsOpen}
        initialSection={settingsSection}
        onSectionChange={setSettingsSection}
        onClose={() => setSettingsOpen(false)}
        content={{
          agents: (
            <AgentsSettings
              hosts={hosts}
              defaultAgentCommand={defaultAgentCommand}
              onDefaultAgentCommandChange={(command) => {
                saveLastAiCmd(command);
                setDefaultAgentCommand(command);
              }}
            />
          ),
          connections: (
            <ConnectionsSettings
              hosts={hosts}
              hostStatuses={hostStatuses}
              hostCatalogError={hostsLoadError}
              sshHostCandidates={sshHostCandidates}
              sessions={sessions}
              terminals={allTerminals}
              onHostsChange={setHosts}
              installingHostId={installingHostId}
              onInstallTw={installRemoteTw}
              {...relaySettingsBindings}
            />
          ),
          appearance: (
            <div className="settings-info-list">
              <div className="settings-info-row">
                <div>
                  <strong>Terminal theme</strong>
                  <span>Controls xterm colors and the synchronized tmux palette.</span>
                </div>
                <ThemePicker current={theme} onChange={setTheme} />
              </div>
            </div>
          ),
          advanced: (
            <div className="settings-info-list">
              <div className="settings-info-row">
                <div>
                  <strong>Reset dashboard layout</strong>
                  <span>Restore panel widths and visibility without changing sessions or connections.</span>
                  {layoutResetMessage && (
                    <span className="settings-action-status" role="status">{layoutResetMessage}</span>
                  )}
                </div>
                <button
                  className="settings-action-button"
                  type="button"
                  onClick={() => void resetDashboardLayout()}
                >
                  Reset layout
                </button>
              </div>
            </div>
          ),
        }}
      />

      {showNewWorktree && (
        <NewWorktreeModal
          hosts={hosts}
          onClose={() => setShowNewWorktree(false)}
          onCreated={(sessionName) => {
            setShowNewWorktree(false);
            void selectSession(sessionName).then((navigated) => {
              if (!navigated) return;
              setPendingCatalogSelection(
                pendingCreatedCatalogSelection(
                  { kind: "session", name: sessionName },
                  catalogRefreshGenerationRef.current.started,
                ),
              );
              void loadProjectPresets();
              void refresh();
            });
          }}
        />
      )}

      {showNewTerminal && (
        <NewTerminalModal
          hosts={hosts}
          existingLabels={allTerminals.map((terminal) => terminal.label)}
          onClose={() => setShowNewTerminal(false)}
          onCreated={async (draft: TerminalDraft) => {
            const created = await dashboardBackend.terminals.create({
              cwd: draft.cwd,
              aiCmd: draft.aiCmd,
              hostId: draft.hostId ?? null,
            });
            const id = allocateTerminalId(allTerminals);
            setTerminals((current) => [
              ...current,
              {
                id,
                label: draft.label,
                cwd: draft.cwd,
                tmuxName: created.tmuxName,
                hostId: created.hostId ?? draft.hostId ?? null,
                rawName: created.rawName,
                aiCmd: draft.aiCmd,
              },
            ]);
            setShowNewTerminal(false);
            await selectTerminal(id);
          }}
        />
      )}
    </>
  );

  return (
    <DashboardShell
      titlebar={
        <WorkspaceHeader
          title={workspaceTitle}
          project={workspaceProject}
          branch={workspaceBranch}
          cwd={selectedCwd}
          hostLabel={selectedHost?.label ?? selectedHostId}
          status={workspaceStatus}
          windowTitlebar
          sidebarDrawer={viewportTier === "compact"}
          scratchOpen={!scratchCollapsed}
          filesActive={sidebarOpen && sidebarView === "files"}
          filesAvailable={Boolean(fileBrowserRoot)}
          gitActive={inspectorOpen}
          gitAvailable={selection?.kind === "session" || selection?.kind === "terminal"}
          onOpenSidebar={() => {
            sidebarOpenPreferenceRef.current = true;
            setSidebarView("workspaces");
            setInspectorOpen(false);
            setSidebarOpen(true);
          }}
          onOpenFiles={openFiles}
          onOpenGit={openGit}
          onToggleScratch={() => {
            if (scratchCollapsed) openScratch();
            else setScratchCollapsed(true);
          }}
        />
      }
      sidebar={
        <DashboardSidebar
          sessions={sessions}
          terminals={allTerminals}
          automations={automations}
          hosts={hosts}
          hostStatuses={hostStatuses}
          hostsError={hostsLoadError}
          mobileRelay={{
            statusKnown: mobileRelay.statusKnown,
            connected: mobileRelay.connected,
            active: mobileRelay.active,
            statusText: mobileRelay.statusText,
            error: mobileRelay.error,
          }}
          localRuntimeState={error ? "error" : catalogRefreshGeneration > 0 ? "ready" : "checking"}
          selection={selection}
          sessionActivity={sessionActivity}
          collapsedProjects={collapsedProjects}
          pinnedItems={pinnedItems}
          automationSectionCollapsed={automationSectionCollapsed}
          installingHostId={installingHostId}
          sessionsError={error}
          terminalsError={terminalPersistenceError}
          automationsError={automationError}
          settingsButtonRef={settingsTriggerRef}
          activeView={sidebarView}
          filesContent={renderFiles()}
          onViewChange={(view) => {
            sidebarOpenPreferenceRef.current = true;
            setSidebarView(view);
            setSidebarOpen(true);
            if (viewportTier === "compact") setInspectorOpen(false);
          }}
          onCreateWorktree={() => setShowNewWorktree(true)}
          onCreateTerminal={() => setShowNewTerminal(true)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenSettings={() => openSettings("general")}
          onToggleProjectCollapsed={toggleProjectCollapsed}
          onTogglePinned={togglePinned}
          onToggleAutomationSection={() => setAutomationSectionCollapsed((current) => !current)}
          onManageAutomations={() => {
            void selectAutomation(
              selection?.kind === "automation"
                ? selection.id
                : automations[0]?.id ?? "",
            );
          }}
          onSelectSession={selectSession}
          onCloseSession={closeSession}
          onSelectTerminal={selectTerminal}
          onCloseTerminal={closeTerminal}
          onSelectAutomation={selectAutomation}
          onInstallTw={installRemoteTw}
        />
      }
      workspace={centralWorkspace}
      inspector={
        <Inspector
          content={renderGit()}
          onClose={() => {
            inspectorOpenPreferenceRef.current = false;
            setInspectorOpen(false);
          }}
        />
      }
      overlays={overlays}
      sidebarWidth={sidebarWidth}
      inspectorWidth={inspectorWidth}
      onSidebarWidthChange={(width) => {
        const nextWidth = clampDashboardPanelWidthForViewport(
          "sidebar",
          width,
          window.innerWidth,
          panelWidthsRef.current.inspectorWidth,
        );
        panelWidthsRef.current = {
          ...panelWidthsRef.current,
          sidebarWidth: nextWidth,
        };
        setSidebarWidth(nextWidth);
      }}
      onInspectorWidthChange={(width) => {
        const nextWidth = clampDashboardPanelWidthForViewport(
          "inspector",
          width,
          window.innerWidth,
          panelWidthsRef.current.sidebarWidth,
        );
        panelWidthsRef.current = {
          ...panelWidthsRef.current,
          inspectorWidth: nextWidth,
        };
        setInspectorWidth(nextWidth);
      }}
      sidebarOpen={sidebarOpen}
      inspectorOpen={inspectorOpen}
      activeDrawer={activeDrawer}
      blocked={anyModalOpen}
      onDismissDrawers={() => {
        if (viewportTier === "compact") setSidebarOpen(false);
        setInspectorOpen(false);
      }}
    />
  );
}

export default App;
