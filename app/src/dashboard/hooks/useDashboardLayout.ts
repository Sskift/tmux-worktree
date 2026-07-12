import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { DashboardBackend, DashboardWindow } from "../../platform";
import {
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  normalizeDashboardPanelWidths,
  viewportTierForWidth,
} from "../layout/panelGeometry";
import { DEFAULT_COLUMN_ORDER } from "../layout/schema";
import type {
  DashboardLayoutExtensions,
  DashboardLayoutInvalidReason,
} from "../layout/schema";
import {
  DEFAULT_SCRATCH_PANEL_WIDTH,
  clampScratchPanelWidth,
} from "../layout/scratchGeometry";
import type {
  DiffFile,
  EditingFile,
  SidebarView,
  ViewportTier,
  WindowLayout,
} from "../layout/types";
import {
  pendingRestoredCatalogSelection,
  type PendingCatalogSelection,
  type PinnedItem,
  type Selection,
} from "../model/selection";
import { useLayoutPreferences } from "./useLayoutPreferences";

const WINDOW_DEFAULTS = { width: 1440, height: 900 };

type DashboardLayoutPersistenceState =
  | { phase: "hydrating" }
  | { phase: "writable"; source: "legacy" | "current" }
  | { phase: "blocked"; reason: "read_failed" }
  | { phase: "blocked"; reason: "future_schema"; version: number }
  | {
      phase: "blocked";
      reason: "invalid_layout";
      invalidReason: DashboardLayoutInvalidReason;
    };

type DashboardLayoutPersistenceGate = {
  attempt: number;
  writable: boolean;
  extensions: DashboardLayoutExtensions;
};

const EMPTY_DASHBOARD_LAYOUT_EXTENSIONS: DashboardLayoutExtensions = Object.freeze({});

async function getWindowExpandedState(win: DashboardWindow) {
  const [fullscreen, maximized] = await Promise.all([
    win.isFullscreen().catch(() => false),
    win.isMaximized().catch(() => false),
  ]);
  return { fullscreen, maximized };
}

export function useDashboardLayoutState() {
  const { loadLayoutPreferences, saveLayoutPreferences } = useLayoutPreferences();
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([]);
  const [automationSectionCollapsed, setAutomationSectionCollapsed] = useState(true);
  const [scratchCollapsed, setScratchCollapsed] = useState(true);
  const [scratchWidth, setScratchWidth] = useState(DEFAULT_SCRATCH_PANEL_WIDTH);
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
  const [layoutPersistenceState, setLayoutPersistenceState] =
    useState<DashboardLayoutPersistenceState>({ phase: "hydrating" });
  const dashboardWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const layoutPersistenceGateRef = useRef<DashboardLayoutPersistenceGate>(
    {
      attempt: 0,
      writable: false,
      extensions: EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,
    },
  );

  panelWidthsRef.current = { sidebarWidth, inspectorWidth };

  return {
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
    setViewportTier,
    windowLayout,
    setWindowLayout,
    windowRestoreReady,
    setWindowRestoreReady,
    layoutPersistenceState,
    setLayoutPersistenceState,
    panelWidthsRef,
    sidebarOpenPreferenceRef,
    inspectorOpenPreferenceRef,
    dashboardWorkspaceRef,
    layoutPersistenceGateRef,
    loadLayoutPreferences,
    saveLayoutPreferences,
  };
}

type DashboardLayoutState = ReturnType<typeof useDashboardLayoutState>;

export function useDashboardViewportResizePhase(layout: DashboardLayoutState) {
  const {
    dashboardWorkspaceRef,
    inspectorOpenPreferenceRef,
    panelWidthsRef,
    setInspectorOpen,
    setInspectorWidth,
    setScratchWidth,
    setSidebarOpen,
    setSidebarWidth,
    setViewportTier,
  } = layout;

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
}

export function useDashboardWindowCapturePhase(
  layout: DashboardLayoutState,
  dashboardBackend: DashboardBackend,
) {
  const { setWindowLayout, windowRestoreReady } = layout;

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
}

type DashboardLayoutHydrationOptions = {
  dashboardBackend: DashboardBackend;
  getLatestSuccessfulRefreshGeneration: () => number;
  setSelection: Dispatch<SetStateAction<Selection>>;
  setPendingCatalogSelection: Dispatch<SetStateAction<PendingCatalogSelection | null>>;
  setEditingFile: Dispatch<SetStateAction<EditingFile | null>>;
  setDiffFile: Dispatch<SetStateAction<DiffFile | null>>;
};

export function useDashboardLayoutHydrationPhase(
  layout: DashboardLayoutState,
  {
    dashboardBackend,
    getLatestSuccessfulRefreshGeneration,
    setSelection,
    setPendingCatalogSelection,
    setEditingFile,
    setDiffFile,
  }: DashboardLayoutHydrationOptions,
) {
  const {
    inspectorOpenPreferenceRef,
    layoutPersistenceGateRef,
    loadLayoutPreferences,
    panelWidthsRef,
    setAutomationSectionCollapsed,
    setCollapsedProjects,
    setInspectorOpen,
    setInspectorWidth,
    setPinnedItems,
    setScratchCollapsed,
    setScratchWidth,
    setSessionOrder,
    setSidebarOpen,
    setSidebarView,
    setSidebarWidth,
    setWindowLayout,
    setWindowRestoreReady,
    setLayoutPersistenceState,
    sidebarOpenPreferenceRef,
  } = layout;

  useEffect(() => {
    const attempt = layoutPersistenceGateRef.current.attempt + 1;
    layoutPersistenceGateRef.current = {
      attempt,
      writable: false,
      extensions: EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,
    };
    setLayoutPersistenceState({ phase: "hydrating" });
    let disposed = false;

    void loadLayoutPreferences()
      .then((outcome) => {
        if (disposed || layoutPersistenceGateRef.current.attempt !== attempt) return;
        if (outcome.kind === "future") {
          setWindowRestoreReady(true);
          setLayoutPersistenceState({
            phase: "blocked",
            reason: "future_schema",
            version: outcome.version,
          });
          return;
        }
        if (outcome.kind === "invalid") {
          setWindowRestoreReady(true);
          setLayoutPersistenceState({
            phase: "blocked",
            reason: "invalid_layout",
            invalidReason: outcome.reason,
          });
          return;
        }

        const lay = outcome.layout;
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
              getLatestSuccessfulRefreshGeneration(),
            ),
          );
          setSelection(lay.selection);
        }
        if (lay.window) setWindowLayout(lay.window);
        setWindowRestoreReady(true);
        layoutPersistenceGateRef.current = {
          attempt,
          writable: true,
          extensions: outcome.extensions,
        };
        setLayoutPersistenceState({
          phase: "writable",
          source: outcome.source,
        });
      })
      .catch(() => {
        if (disposed || layoutPersistenceGateRef.current.attempt !== attempt) return;
        setWindowRestoreReady(true);
        setLayoutPersistenceState({
          phase: "blocked",
          reason: "read_failed",
        });
      });

    return () => {
      disposed = true;
      if (layoutPersistenceGateRef.current.attempt === attempt) {
        layoutPersistenceGateRef.current = {
          attempt: attempt + 1,
          writable: false,
          extensions: EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,
        };
      }
    };
  }, [dashboardBackend, getLatestSuccessfulRefreshGeneration, loadLayoutPreferences]);
}

type DashboardLayoutPersistenceOptions = {
  selection: Selection;
  editingFile: EditingFile | null;
  diffFile: DiffFile | null;
};

export function useDashboardLayoutPersistencePhase(
  layout: DashboardLayoutState,
  { selection, editingFile, diffFile }: DashboardLayoutPersistenceOptions,
) {
  const {
    automationSectionCollapsed,
    collapsedProjects,
    inspectorOpen,
    inspectorOpenPreferenceRef,
    inspectorWidth,
    layoutPersistenceGateRef,
    layoutPersistenceState,
    pinnedItems,
    saveLayoutPreferences,
    scratchCollapsed,
    scratchWidth,
    sessionOrder,
    sidebarOpen,
    sidebarOpenPreferenceRef,
    sidebarView,
    sidebarWidth,
    windowLayout,
  } = layout;

  useEffect(() => {
    if (layoutPersistenceState.phase !== "writable") return;
    const gate = layoutPersistenceGateRef.current;
    if (!gate.writable) return;
    const authorizedAttempt = gate.attempt;
    const t = setTimeout(() => {
      const currentGate = layoutPersistenceGateRef.current;
      if (!currentGate.writable || currentGate.attempt !== authorizedAttempt) return;
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
      }, currentGate.extensions).catch(() => {});
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
    layoutPersistenceState.phase,
  ]);
}
