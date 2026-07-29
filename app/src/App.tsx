import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Plus, X } from "lucide-react";
import { type CreatedTerminal, useDashboardBackend } from "./platform";
import { useConnectionCatalog, useConnectionCatalogOwnerPhase, useConnectionCatalogSyncPhase } from "./dashboard/hooks/useConnectionCatalog";
import {
  useWorkspaceCatalog,
  useWorkspaceCatalogOwnerPhase,
} from "./dashboard/hooks/useWorkspaceCatalog";
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
  useTerminalDeckOwnerPhase,
  useTerminalDeckPreviewPhase,
  useTerminalDeckState,
} from "./dashboard/hooks/useTerminalDeckState";
import {
  useTerminalMetadata,
  useTerminalMetadataHydrationPhase,
  useTerminalMetadataOwnerPhase,
  useTerminalMetadataPersistencePhase,
} from "./dashboard/hooks/useTerminalMetadata";
import {
  useWorkspaceActions,
  useWorkspaceActionsOwnerPhase,
} from "./dashboard/hooks/useWorkspaceActions";
import {
  useWorkspaceBranchPhase,
  useWorkspaceHomePhase,
  useWorkspacePresentation,
  useWorkspacePresentationOwnerPhase,
} from "./dashboard/hooks/useWorkspacePresentation";
import { useVisibilityAwarePolling } from "./dashboard/hooks/useVisibilityAwarePolling";
import {
  useEditorNavigationGuard,
  useEditorNavigationGuardLifecyclePhase,
} from "./dashboard/hooks/useEditorNavigationGuard";
import {
  useAutomationWorkspace,
  useAutomationWorkspaceHydrationPhase,
  useAutomationWorkspaceOwnerPhase,
  useAutomationWorkspaceSchedulerPhase,
} from "./dashboard/hooks/useAutomationWorkspace";
import {
  CommandPalette,
  type CommandPaletteItem,
} from "./dashboard/CommandPalette";
import {
  AgentsSettings,
  FeishuIntegrationSettings,
  SettingsDialog,
  type SettingsSectionId,
} from "./dashboard/Settings";
import {
  ConnectionsSettings,
  relaySettingsBindingsFromController,
} from "./dashboard/Settings/ConnectionsSettings";
import {
  DashboardShell,
  type DashboardDrawer,
} from "./dashboard/DashboardShell";
import { DashboardSidebar } from "./dashboard/DashboardSidebar";
import { WorkspacePrimaryView } from "./dashboard/WorkspacePrimaryView";
import {
  WorkspaceFilesView,
  WorkspaceGitView,
} from "./dashboard/WorkspaceContextViews";
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
import { AutomationPanel } from "./AutomationPanel";
import { editingFileSourceKey } from "./editorNavigationGuard";
import {
  renamePersistedTerminal,
} from "./terminalPersistence";
import { applyTheme, loadTheme, type ThemeId } from "./themes";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";
import {
  automationSelectionIsCurrent,
} from "./automationDraftSync";
import {
  triggerLabel,
} from "./automationTypes";
import {
  sessionDisplayName,
  terminalSessionKey,
} from "./dashboard/model/terminalIdentity";
import { deriveWorkspacePresentation } from "./dashboard/model/workspacePresentation";
import { projectKey } from "./dashboard/model/workspaceSelectors";
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
    worktreeGroupOrder,
    setWorktreeGroupOrder,
    terminalOrder,
    setTerminalOrder,
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
  const terminalMetadata = useTerminalMetadata(dashboardBackend);
  const {
    terminals,
    setTerminals,
    terminalPersistenceError,
    terminalPersistenceHydrationGeneration,
    ownerPhase: terminalMetadataOwnerPhase,
  } = terminalMetadata;
  useTerminalMetadataOwnerPhase(terminalMetadataOwnerPhase, dashboardBackend);
  const workspaceActions = useWorkspaceActions(dashboardBackend);
  const {
    ownerEpochKey: workspaceActionOwnerEpochKey,
    recentPath: lastAutomationContextPath,
    recentProject: lastAutomationContextProject,
    rememberAutomationContext,
    resolveAutomationRoot,
    createWorktree,
    restoreWorktree,
    deleteWorktree,
    createTerminal,
    closeSession,
    closeTerminal,
    ownerPhase: workspaceActionOwnerPhase,
  } = workspaceActions;
  const automationWorkspace = useAutomationWorkspace(dashboardBackend);
  const {
    automations,
    runs: automationRuns,
    error: automationError,
    ownerEpochKey: automationOwnerEpochKey,
    load: loadAutomations,
    create: handleAutomationCreate,
    save: handleAutomationSave,
    toggle: handleAutomationToggle,
    remove: handleAutomationDelete,
    run: handleAutomationRun,
    tick: tickScheduledAutomations,
    ownerPhase: automationWorkspaceOwnerPhase,
  } = automationWorkspace;
  const connectionCatalog = useConnectionCatalog(dashboardBackend);
  useConnectionCatalogOwnerPhase(connectionCatalog.ownerPhase, dashboardBackend);
  useConnectionCatalogSyncPhase(connectionCatalog, dashboardBackend);
  const {
    projectPresets,
    loadProjectPresets,
    hosts,
    hostsHydrationGeneration,
    hostsLoadError,
    onHostsMutationSettled,
    sshHostCandidates,
    hostStatuses,
    installingHostId,
    installRemoteTw,
    ownerEpochKey: connectionCatalogOwnerEpochKey,
  } = connectionCatalog;
  const mobileRelay = useMobileRelayController({ hosts });
  const [selection, setSelection] = useState<Selection>(null);
  const terminalDeck = useTerminalDeckState(dashboardBackend);
  const {
    ownerEpochKey: terminalDeckOwnerEpochKey,
    ownerPhase: terminalDeckOwnerPhase,
    openedSessions,
    setOpenedSessions,
    openedTerminals,
    setOpenedTerminals,
    tmuxPreviews,
    cwdsBySession,
    handleFullCatalogPublished,
  } = terminalDeck;
  useTerminalDeckOwnerPhase(terminalDeckOwnerPhase, dashboardBackend);
  const workspacePresentationController = useWorkspacePresentation(dashboardBackend);
  useWorkspacePresentationOwnerPhase(
    workspacePresentationController.ownerPhase,
    dashboardBackend,
  );
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
  const committedEditingFileRef = useRef<EditingFile | null>(editingFile);
  const [editorNavigationRevision, setEditorNavigationRevision] = useState(0);
  const [diffFile, setDiffFile] = useState<DiffFile | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);
  const automationReturnSelectionRef = useRef<Selection>(null);
  const [pendingCatalogSelection, setPendingCatalogSelection] =
    useState<PendingCatalogSelection | null>(null);
  const automationDraftKey = selection?.kind === "automation"
    ? `${automationOwnerEpochKey}:automation:${selection.id || "new"}`
    : null;
  const editorNavigationGuard = useEditorNavigationGuard({
    dashboardBackend,
    editingFile,
    automationDraftKey,
  });
  const {
    requestEditorNavigation,
    handleEditorDirtyChange,
    handleAutomationDirtyChange,
    getAutomationSubmitOwner,
  } = editorNavigationGuard;
  useWorkspaceHomePhase(workspacePresentationController, dashboardBackend);

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
    ownerPhase: workspaceCatalogOwnerPhase,
  } = useWorkspaceCatalog(dashboardBackend);

  useWorkspaceCatalogOwnerPhase(workspaceCatalogOwnerPhase, {
    dashboardBackend,
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

  const navigateToSavedAutomation = useCallback((id: string) =>
    requestEditorNavigation(() => {
      setEditingFile(null);
      setDiffFile(null);
      setSelection({ kind: "automation", id });
    }, { ignoreAutomationDirty: true }), [requestEditorNavigation]);

  const reconcileAutomationSelection = useCallback((items: typeof automations) => {
    const automationsById = new Set(items.map(({ id }) => id));
    setSelection((current) => {
      if (current?.kind !== "automation" || !current.id || automationsById.has(current.id)) {
        return current;
      }
      return items[0] ? { kind: "automation", id: items[0].id } : null;
    });
  }, []);

  const clearDeletedAutomationSelection = useCallback((id: string) => {
    setSelection((current) =>
      current?.kind === "automation" && current.id === id
        ? { kind: "automation", id: "" }
        : current,
    );
  }, []);

  useAutomationWorkspaceOwnerPhase(automationWorkspaceOwnerPhase, {
    backend: dashboardBackend,
    getAutomationSubmitOwner,
    navigateToSavedAutomation,
    reconcileAutomationSelection,
    clearDeletedAutomationSelection,
    refreshWorkspace: refresh,
  });

  useAutomationWorkspaceHydrationPhase(loadAutomations);

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
    terminalOrder,
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

  useAutomationWorkspaceSchedulerPhase(tickScheduledAutomations);

  useTerminalDeckAttachPhase(terminalDeck, dashboardBackend, {
    selection,
    selectedSession,
    selectedTerminal,
    selectionMetadataPending,
    allTerminals,
  });

  const workspacePresentation = deriveWorkspacePresentation({
    ownerReady: workspacePresentationController.ownerReady,
    selection,
    selectionMetadataPending,
    selectedSession,
    selectedTerminal,
    automations,
    projectPresets,
    hosts,
    hostStatuses,
    sessionActivity,
    cwdsBySession,
    homeDirectory: workspacePresentationController.homeDirectory,
    workspaceBranch: workspacePresentationController.workspaceBranch,
    editingFile,
    diffFile,
  });
  const publishWorkspaceBranch = useWorkspaceBranchPhase(
    workspacePresentationController,
    dashboardBackend,
    workspacePresentation.branchSource,
  );
  const {
    selectedSessionIsRemote,
    selectedCwd,
    selectedGitHostId,
    fileBrowserRoot,
  } = workspacePresentation;

  const projectPresetForSession = useCallback(
    (sessionName: string): string | null => {
      const key = projectKey(sessionName);
      return projectPresets.some((project) => project.name === key) ? key : null;
    },
    [projectPresets],
  );

  useEffect(() => {
    if ((selection?.kind === "session" || selection?.kind === "terminal") && selectedCwd && !selectedGitHostId) {
      rememberAutomationContext(
        selectedCwd,
        selection.kind === "session" ? projectPresetForSession(selection.name) : null,
      );
    }
  }, [
    projectPresetForSession,
    rememberAutomationContext,
    selection,
    selectedCwd,
    selectedGitHostId,
  ]);

  const handleNewAutomation = useCallback(() => requestEditorNavigation(() => {
    if (selection?.kind === "session" || selection?.kind === "terminal") {
      automationReturnSelectionRef.current = selection;
    }
    if ((selection?.kind === "session" || selection?.kind === "terminal") && selectedCwd && !selectedGitHostId) {
      rememberAutomationContext(
        selectedCwd,
        selection.kind === "session" ? projectPresetForSession(selection.name) : null,
      );
    } else if (
      selection?.kind === "session" &&
      !selectionMetadataPending &&
      !selectedSessionIsRemote &&
      selectedSession
    ) {
      void resolveAutomationRoot(
        selectedSession,
        projectPresetForSession(selection.name),
      );
    }
    setEditingFile(null);
    setDiffFile(null);
    setInspectorOpen(false);
    setSelection({ kind: "automation", id: "" });
  }), [
    projectPresetForSession,
    rememberAutomationContext,
    requestEditorNavigation,
    resolveAutomationRoot,
    selection,
    selectedCwd,
    selectedGitHostId,
    selectedSession,
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
        editingFileSourceKey(committedEditingFileRef.current) ===
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
          committedEditingFileRef.current !== null,
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
  const closeNewWorktree = useCallback(() => setShowNewWorktree(false), []);
  const closeNewTerminal = useCallback(() => setShowNewTerminal(false), []);
  const publishPendingSession = useCallback((name: string) => {
    setPendingCatalogSelection(pendingCreatedCatalogSelection(
      { kind: "session", name },
      getLatestStartedRefreshGeneration(),
    ));
  }, [getLatestStartedRefreshGeneration]);
  const publishCreatedTerminal = useCallback((
    draft: TerminalDraft,
    created: CreatedTerminal,
  ): string => {
    return terminalMetadata.upsertCreatedTerminal(draft, created, allTerminals);
  }, [allTerminals, terminalMetadata.upsertCreatedTerminal]);
  const publishClosedSession = useCallback((name: string) => {
    removeSession(name);
    setOpenedSessions((current) => current.filter((sessionName) => sessionName !== name));
    setSessionOrder((current) => current.filter((sessionName) => sessionName !== name));
    setPinnedItems((current) => current.filter(
      (item) => item.kind !== "session" || item.name !== name,
    ));
    setSelection((current) => {
      if (current?.kind !== "session" || current.name !== name) return current;
      const remainingSession = sessions.find((session) => session.name !== name);
      if (remainingSession) return { kind: "session", name: remainingSession.name };
      const remainingTerminal = allTerminals[0];
      return remainingTerminal ? { kind: "terminal", id: remainingTerminal.id } : null;
    });
  }, [allTerminals, removeSession, sessions, setOpenedSessions]);
  const publishClosedTerminal = useCallback((id: string) => {
    const terminal = allTerminals.find((candidate) => candidate.id === id);
    if (!terminal) return;
    if (terminal.discovered) {
      removeDiscoveredTerminal(id);
    } else {
      setTerminals((current) => current.filter((candidate) => candidate.id !== id));
    }
    setOpenedTerminals((current) => current.filter((terminalId) => terminalId !== id));
    setPinnedItems((current) => current.filter(
      (item) => item.kind !== "terminal" || item.id !== id,
    ));
    setTerminalOrder((current) => current.filter(
      (key) => key !== terminalSessionKey(terminal),
    ));
    setSelection((current) => {
      if (current?.kind !== "terminal" || current.id !== id) return current;
      const remainingTerminal = allTerminals.find((candidate) => candidate.id !== id);
      if (remainingTerminal) return { kind: "terminal", id: remainingTerminal.id };
      const remainingSession = sessions[0];
      return remainingSession ? { kind: "session", name: remainingSession.name } : null;
    });
  }, [
    allTerminals,
    removeDiscoveredTerminal,
    sessions,
    setOpenedTerminals,
    setTerminals,
  ]);
  useWorkspaceActionsOwnerPhase(workspaceActionOwnerPhase, {
    backend: dashboardBackend,
    sessions,
    terminals: allTerminals,
    closeNewWorktree,
    closeNewTerminal,
    selectSession,
    selectTerminal,
    publishPendingSession,
    publishCreatedTerminal,
    publishClosedSession,
    publishClosedTerminal,
    reconcilePersistedTerminal: terminalMetadata.reconcilePersistedTerminal,
    refreshWorkspace: refresh,
    refreshProjects: loadProjectPresets,
    reportError,
  });
  const renameTerminal = useCallback((id: string, label: string) => {
    setTerminals((current) => (
      renamePersistedTerminal(current, allTerminals, id, label)
    ));
  }, [allTerminals]);
  const reorderSessions = useCallback((reordered: typeof sessions) => {
    setSessionOrder(reordered.map((session) => session.name));
  }, [setSessionOrder]);
  const reorderWorktreeGroups = useCallback((groupKeys: string[]) => {
    setWorktreeGroupOrder(groupKeys);
  }, [setWorktreeGroupOrder]);
  const reorderTerminals = useCallback((reordered: typeof allTerminals) => {
    setTerminalOrder(reordered.map(terminalSessionKey));
  }, [setTerminalOrder]);

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

  useEditorNavigationGuardLifecyclePhase(editorNavigationGuard, {
    dashboardBackend,
    editingFile,
    automationDraftKey,
  });

  useLayoutEffect(() => {
    committedEditingFileRef.current = editingFile;
  }, [editingFile]);

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
      execute: async () => {
        await handleAutomationRun(automation.id);
      },
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
  const handleWorkspaceFileSelect = useCallback((path: string, hostId: string | null) => {
    void handleOpenFile(path, undefined, undefined, hostId).then((opened) => {
      if (opened && viewportTier === "compact") setSidebarOpen(false);
    });
  }, [handleOpenFile, viewportTier]);

  const automationPanel = (
    <AutomationPanel
      key={automationOwnerEpochKey}
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

  const centralWorkspace = (
    <div
      ref={dashboardWorkspaceRef}
      className="dashboard-workspace"
      data-scratch-open={!workspacePresentation.metadataPending && !scratchCollapsed && Boolean(selectionKey)}
      style={{ "--dashboard-scratch-width": `${scratchWidth}px` } as React.CSSProperties}
    >
      <WorkspacePrimaryView
        context={workspacePresentation.primary}
        diffContext={workspacePresentation.diff}
        terminalDeckKey={terminalDeckOwnerEpochKey}
        terminalDeckProps={{
          selection,
          sessions,
          terminals: allTerminals,
          hosts,
          openedSessions,
          openedTerminals,
          cwdsBySession,
          tmuxPreviews,
          metadataPending: workspacePresentation.metadataPending,
          visible: workspacePresentation.terminalVisible,
          blocked: workspaceInteractionBlocked,
          onOpenFile: handleOpenFile,
        }}
        editorNavigationRevision={editorNavigationRevision}
        automationContent={automationPanel}
        onCloseEditor={() => void closeEditingFile()}
        onOpenFile={handleOpenFile}
        onEditorDirtyChange={handleEditorDirtyChange}
        onCloseDiff={() => setDiffFile(null)}
        onReturnFromAutomation={() => void returnFromAutomationManager()}
      />

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
        hidden={workspacePresentation.metadataPending || scratchCollapsed || !selectionKey}
        onPointerDown={startScratchResize}
        onKeyDown={resizeScratchFromKeyboard}
      />

      <aside
        id="dashboard-scratch-panel"
        className="dashboard-scratch"
        aria-label="Scratch terminals"
        hidden={workspacePresentation.metadataPending || scratchCollapsed || !selectionKey}
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
                key={`${terminalDeckOwnerEpochKey}:${key}`}
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
              key={`agents:${connectionCatalogOwnerEpochKey}`}
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
              key={`connections:${connectionCatalogOwnerEpochKey}`}
              hosts={hosts}
              hostStatuses={hostStatuses}
              hostCatalogError={hostsLoadError}
              sshHostCandidates={sshHostCandidates}
              sessions={sessions}
              terminals={allTerminals}
              onHostsMutationSettled={onHostsMutationSettled}
              installingHostId={installingHostId}
              onInstallTw={installRemoteTw}
              {...relaySettingsBindings}
            />
          ),
          integrations: <FeishuIntegrationSettings />,
          appearance: (
            <div className="settings-info-list">
              <div className="settings-info-row">
                <div>
                  <strong>Dashboard theme</strong>
                  <span>Controls the app chrome, editor, terminal, and synchronized tmux palette.</span>
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
          key={`worktree:${workspaceActionOwnerEpochKey}:${workspaceActions.orphanRevision}`}
          hosts={hosts}
          onClose={closeNewWorktree}
          onCreateWorktree={createWorktree}
          onRestoreWorktree={restoreWorktree}
          onDeleteWorktree={deleteWorktree}
        />
      )}

      {showNewTerminal && (
        <NewTerminalModal
          key={`terminal:${workspaceActionOwnerEpochKey}`}
          hosts={hosts}
          existingLabels={allTerminals.map((terminal) => terminal.label)}
          onClose={closeNewTerminal}
          onCreated={createTerminal}
        />
      )}
    </>
  );

  return (
    <DashboardShell
      titlebar={
        <WorkspaceHeader
          title={workspacePresentation.header.title}
          project={workspacePresentation.header.project}
          branch={workspacePresentation.header.branch}
          cwd={workspacePresentation.header.cwd}
          hostLabel={workspacePresentation.header.hostLabel}
          status={workspacePresentation.header.status}
          windowTitlebar
          sidebarDrawer={viewportTier === "compact"}
          scratchOpen={!scratchCollapsed}
          gitActive={inspectorOpen}
          gitAvailable={workspacePresentation.header.gitAvailable}
          onOpenSidebar={() => {
            sidebarOpenPreferenceRef.current = true;
            setSidebarView("workspaces");
            setInspectorOpen(false);
            setSidebarOpen(true);
          }}
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
          sessionOrder={sessionOrder}
          worktreeGroupOrder={worktreeGroupOrder}
          collapsedProjects={collapsedProjects}
          pinnedItems={pinnedItems}
          automationSectionCollapsed={automationSectionCollapsed}
          installingHostId={installingHostId}
          sessionsError={error}
          terminalsError={terminalPersistenceError}
          automationsError={automationError}
          settingsButtonRef={settingsTriggerRef}
          activeView={sidebarView}
          filesContent={(
            <WorkspaceFilesView
              context={workspacePresentation.files}
              onFileSelect={handleWorkspaceFileSelect}
            />
          )}
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
          onReorderSessions={reorderSessions}
          onReorderWorktreeGroups={reorderWorktreeGroups}
          onCloseSession={closeSession}
          onSelectTerminal={selectTerminal}
          onReorderTerminals={reorderTerminals}
          onRenameTerminal={renameTerminal}
          onCloseTerminal={closeTerminal}
          onSelectAutomation={selectAutomation}
          onInstallTw={installRemoteTw}
        />
      }
      workspace={centralWorkspace}
      inspector={
        <GitPanel
          content={(
            <WorkspaceGitView
              context={workspacePresentation.git}
              active={inspectorOpen}
              onFileClick={openGitDiff}
              onBranchChange={publishWorkspaceBranch}
            />
          )}
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
