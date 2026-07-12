import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Plus, X } from "lucide-react";
import { useDashboardBackend } from "./platform";
import { useConnectionCatalog } from "./dashboard/hooks/useConnectionCatalog";
import { useWorkspaceCatalog } from "./dashboard/hooks/useWorkspaceCatalog";
import {
  useDashboardLayoutHydrationPhase,
  useDashboardLayoutPersistencePhase,
  useDashboardLayoutState,
  useDashboardViewportResizePhase,
  useDashboardWindowCapturePhase,
} from "./dashboard/hooks/useDashboardLayout";
import { useMobileRelayController } from "./dashboard/hooks/useMobileRelayController";
import { useCatalogSelectionHydration } from "./dashboard/hooks/useCatalogSelectionHydration";
import {
  useTerminalDeckAttachPhase,
  useTerminalDeckPreviewPhase,
  useTerminalDeckState,
} from "./dashboard/hooks/useTerminalDeckState";
import {
  useTerminalMetadata,
  useTerminalMetadataHydrationPhase,
  useTerminalMetadataPersistencePhase,
} from "./dashboard/hooks/useTerminalMetadata";
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
import { TerminalDeck } from "./dashboard/TerminalDeck";
import {
  DashboardShell,
  type DashboardDrawer,
} from "./dashboard/DashboardShell";
import { DashboardSidebar } from "./dashboard/DashboardSidebar";
import { WorkspaceHeader } from "./dashboard/WorkspaceHeader";
import { GitPanel } from "./dashboard/GitPanel";
import {
  clampDashboardPanelWidthForViewport,
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  viewportTierForWidth,
} from "./dashboard/layout/panelGeometry";
import {
  pendingCreatedCatalogSelection,
  type PendingCatalogSelection,
} from "./dashboard/model/selection";
import type {
  DiffFile,
  EditingFile,
} from "./dashboard/layout/types";
import type { PinnedItem, Selection } from "./dashboard/model/selection";
import {
  DEFAULT_SCRATCH_PANEL_WIDTH,
  SCRATCH_PANEL_LIMITS,
  scratchPanelMaximumWidth,
  scratchPanelWidthFromKey,
  scratchPanelWidthFromPointer,
} from "./dashboard/layout/scratchGeometry";
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
  renamePersistedTerminal,
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
  basenameFromPath,
  sessionDisplayName,
  terminalSessionKey,
} from "./dashboard/model/terminalIdentity";
import { projectKey, type WorkspaceStatus } from "./dashboard/model/workspaceSelectors";
import { buildSshShellArgs } from "./terminal/attach";
import "./App.css";

const REFRESH_MS = 2_000;
const HIDDEN_REFRESH_MS = 10_000;

type ScratchTerm = { id: string; label: string };
type ScratchState = { list: ScratchTerm[]; nextNum: number };

let scratchIdCounter = 0;

function App() {
  const dashboardBackend = useDashboardBackend();
  const dashboardLayout = useDashboardLayoutState();
  const {
    sessionOrder,
    setSessionOrder,
    collapsedProjects,
    setCollapsedProjects,
    pinnedItems,
    setPinnedItems,
    automationSectionCollapsed,
    setAutomationSectionCollapsed,
    scratchCollapsed,
    setScratchCollapsed,
    scratchWidth,
    setScratchWidth,
    sidebarWidth,
    setSidebarWidth,
    inspectorWidth,
    setInspectorWidth,
    sidebarOpen,
    setSidebarOpen,
    inspectorOpen,
    setInspectorOpen,
    sidebarView,
    setSidebarView,
    viewportTier,
    layoutPersistenceState,
    layoutSaveError,
    panelWidthsRef,
    sidebarOpenPreferenceRef,
    inspectorOpenPreferenceRef,
    dashboardWorkspaceRef,
  } = dashboardLayout;
  const terminalMetadata = useTerminalMetadata();
  const {
    terminals,
    setTerminals,
    terminalPersistenceError,
    terminalPersistenceHydrationGeneration,
  } = terminalMetadata;
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
  } = useConnectionCatalog();
  const mobileRelay = useMobileRelayController({ hosts });
  const [selection, setSelection] = useState<Selection>(null);
  const terminalDeck = useTerminalDeckState();
  const {
    openedSessions,
    setOpenedSessions,
    openedTerminals,
    setOpenedTerminals,
    tmuxPreviews,
    cwdsBySession,
    handleFullCatalogPublished,
  } = terminalDeck;
  const [lastAutomationContextPath, setLastAutomationContextPath] = useState<string | null>(null);
  const [lastAutomationContextProject, setLastAutomationContextProject] = useState<string | null>(null);
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
  const [scratchTerminals, setScratchTerminals] = useState<Map<string, ScratchState>>(new Map());
  const [editingFile, setEditingFile] = useState<EditingFile | null>(null);
  const [editorNavigationRevision, setEditorNavigationRevision] = useState(0);
  const [diffFile, setDiffFile] = useState<DiffFile | null>(null);
  const [workspaceBranch, setWorkspaceBranch] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);
  const automationReturnSelectionRef = useRef<Selection>(null);
  const automationsRef = useRef<Automation[]>([]);
  const scheduledAutomationMinuteRef = useRef<Set<string>>(new Set());
  const [pendingCatalogSelection, setPendingCatalogSelection] =
    useState<PendingCatalogSelection | null>(null);
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
  automationsRef.current = automations;

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

  useDashboardViewportResizePhase(dashboardLayout);

  useDashboardWindowCapturePhase(dashboardLayout, dashboardBackend);

  // Persisted terminal metadata is retried independently from the live tmux
  // catalog. A failed read must never authorize saving an empty replacement.
  useTerminalMetadataHydrationPhase(terminalMetadata, dashboardBackend);

  const {
    sessions,
    discoveredTerminals,
    sessionActivity,
    catalogRefreshGeneration,
    failedSessionHostIds,
    failedTerminalHostIds,
    error,
    refresh,
    removeSession,
    removeDiscoveredTerminal,
    reportError,
    getLatestStartedRefreshGeneration,
    getLatestSuccessfulRefreshGeneration,
  } = useWorkspaceCatalog({
    sessionOrder,
    onFullCatalogPublished: handleFullCatalogPublished,
  });

  useDashboardLayoutHydrationPhase(dashboardLayout, {
    dashboardBackend,
    getLatestSuccessfulRefreshGeneration,
    setSelection,
    setPendingCatalogSelection,
    setEditingFile,
    setDiffFile,
  });

  // Persist terminal metadata serially. The coordinator keeps the newest
  // snapshot queued and retries failed writes without allowing an older save
  // to land after a newer one.
  useTerminalMetadataPersistencePhase(terminalMetadata, dashboardBackend);

  useDashboardLayoutPersistencePhase(dashboardLayout, {
    selection,
    editingFile,
    diffFile,
  });

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

  const {
    allTerminals,
    selectedSession,
    selectedTerminal,
    selectionMetadataPending,
  } = useCatalogSelectionHydration({
    terminals,
    discoveredTerminals,
    sessions,
    hosts,
    selection,
    pendingCatalogSelection,
    catalogRefreshGeneration,
    terminalPersistenceHydrationGeneration,
    hostsHydrationGeneration,
    failedSessionHostIds,
    failedTerminalHostIds,
    setSelection,
    setPendingCatalogSelection,
  });

  useTerminalDeckPreviewPhase(terminalDeck, dashboardBackend, {
    sessions,
    allTerminals,
  });

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

  useTerminalDeckAttachPhase(terminalDeck, dashboardBackend, {
    selection,
    selectedSession,
    selectedTerminal,
    selectionMetadataPending,
    allTerminals,
  });

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
      await dashboardBackend.sessions.kill(name, session?.managed ?? false);
      removeSession(name);
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
      reportError(nextError);
    }
  }, [allTerminals, dashboardBackend, removeSession, reportError, sessions]);

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
        await dashboardBackend.sessions.kill(sessionKey, terminal.managed ?? false);
        removeDiscoveredTerminal(id);
      } else {
        await dashboardBackend.terminals.kill(sessionKey, terminal.managed ?? false);
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
      reportError(nextError);
    }
  }, [allTerminals, dashboardBackend, removeDiscoveredTerminal, reportError, sessions]);

  const renameTerminal = useCallback((id: string, label: string) => {
    setTerminals((current) => (
      renamePersistedTerminal(current, allTerminals, id, label)
    ));
  }, [allTerminals]);

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
        id: "navigate-git-panel",
        group: "navigate" as const,
        label: "Open Git panel",
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
        <span>Select a changed file from the Git panel.</span>
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
                  {(layoutPersistenceState.phase === "blocked" || layoutSaveError) && (
                    <span className="settings-action-status" role="alert">
                      {layoutPersistenceState.phase === "blocked"
                        ? layoutPersistenceState.reason === "read_failed"
                          ? "Dashboard layout could not be read. The saved layout will not be overwritten, and layout changes will not be saved this time."
                          : layoutPersistenceState.reason === "future_schema"
                            ? `Dashboard layout schema ${layoutPersistenceState.version} was created by a newer version. It will be preserved unchanged, and layout changes will not be saved.`
                            : layoutPersistenceState.reason === "invalid_layout"
                              ? "The saved dashboard layout is invalid. It will be preserved unchanged, and layout changes will not be saved."
                              : layoutSaveError ?? "Dashboard layout changes could not be saved. Layout saving is blocked until the next hydration."
                        : layoutSaveError}
                    </span>
                  )}
                  {layoutResetMessage && (
                    <span className="settings-action-status" role="status">{layoutResetMessage}</span>
                  )}
                </div>
                <button
                  className="settings-action-button"
                  type="button"
                  disabled={layoutPersistenceState.phase !== "writable"}
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
                  getLatestStartedRefreshGeneration(),
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
                cwd: created.cwd,
                tmuxName: created.tmuxName,
                hostId: created.hostId ?? draft.hostId ?? null,
                rawName: created.rawName,
                aiCmd: draft.aiCmd,
                managed: created.managed,
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
          onRenameTerminal={renameTerminal}
          onCloseTerminal={closeTerminal}
          onSelectAutomation={selectAutomation}
          onInstallTw={installRemoteTw}
        />
      }
      workspace={centralWorkspace}
      inspector={
        <GitPanel
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
